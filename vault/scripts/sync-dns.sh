#!/usr/bin/env bash
# Reconcile Cloudflare DNS for vault.chrisvouga.dev (proxied CNAME → Fly).
# Cloudflare terminates TLS at the edge; Fly serves the origin cert.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FLY_TOML="${REPO_ROOT}/fly.toml"

ZONE_NAME="${ZONE_NAME:-chrisvouga.dev}"
RECORD_NAME="${RECORD_NAME:-vault.chrisvouga.dev}"
FLY_APP="${FLY_APP:-}"
CF_TOKEN="${CLOUDFLARE_API_TOKEN:-${CF_API_TOKEN:-}}"
DESIRED_SSL_MODE="${DESIRED_SSL_MODE:-strict}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: $1 is required" >&2
    exit 1
  fi
}

require_cmd curl
require_cmd jq
require_cmd flyctl
require_cmd dig

if [ -z "${CF_TOKEN}" ]; then
  echo "ERROR: CLOUDFLARE_API_TOKEN (or CF_API_TOKEN) is required" >&2
  exit 1
fi

if [ -z "${FLY_APP}" ] && [ -f "${FLY_TOML}" ]; then
  FLY_APP="$(grep -E '^app[[:space:]]*=' "${FLY_TOML}" | head -1 | sed -E 's/^app[[:space:]]*=[[:space:]]*"?([^"]+)"?[[:space:]]*$/\1/')"
fi
FLY_APP="${FLY_APP:-crvouga-vault}"

API_BASE="https://api.cloudflare.com/client/v4"

cf_request() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "${API_BASE}${path}" \
      -H "Authorization: Bearer ${CF_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$body"
  else
    curl -sS -X "$method" "${API_BASE}${path}" \
      -H "Authorization: Bearer ${CF_TOKEN}"
  fi
}

fetch_existing() {
  local name="$1"
  cf_request GET "/zones/${ZONE_ID}/dns_records?name=${name}"
}

echo "==> Looking up Cloudflare zone ${ZONE_NAME}..."
ZONE_ID="$(cf_request GET "/zones?name=${ZONE_NAME}" | jq -r '.result[0].id // empty')"
if [ -z "$ZONE_ID" ]; then
  echo "ERROR: Cloudflare zone ${ZONE_NAME} not found" >&2
  exit 1
fi

echo "==> Fetching Fly DNS requirements for ${RECORD_NAME}..."
CERT_JSON="$(flyctl certs show "${RECORD_NAME}" --app "${FLY_APP}" --json)"
CNAME_TARGET="$(echo "$CERT_JSON" | jq -r '.dns_requirements.cname // empty')"
OWNERSHIP_NAME="$(echo "$CERT_JSON" | jq -r '.dns_requirements.ownership.name // empty')"
OWNERSHIP_VALUE="$(echo "$CERT_JSON" | jq -r '.dns_requirements.ownership.app_value // empty')"

if [ -z "$CNAME_TARGET" ]; then
  echo "ERROR: Fly did not return a CNAME target for ${RECORD_NAME}" >&2
  exit 1
fi
echo "==> Fly CNAME target: ${CNAME_TARGET}"
if [ -n "$OWNERSHIP_NAME" ] && [ -n "$OWNERSHIP_VALUE" ]; then
  echo "==> Fly ownership TXT: ${OWNERSHIP_NAME} -> ${OWNERSHIP_VALUE}"
fi

delete_records() {
  local type="$1"
  local existing="$2"
  local ids
  ids="$(echo "$existing" | jq -r --arg type "$type" '.result[] | select(.type==$type) | .id')"
  while IFS= read -r record_id; do
    [ -z "$record_id" ] && continue
    echo "==> Deleting stale ${type} record (${record_id})"
    cf_request DELETE "/zones/${ZONE_ID}/dns_records/${record_id}" | jq -e '.success' >/dev/null
  done <<< "$ids"
}

reconcile_record() {
  local name="$1" type="$2" content="$3" proxied="$4" existing="$5"
  local record_id current body
  record_id="$(echo "$existing" | jq -r --arg type "$type" '.result[] | select(.type==$type) | .id' | head -n1)"
  body="$(jq -n --arg name "$name" --arg type "$type" --arg content "$content" --argjson proxied "$proxied" \
    '{name: $name, type: $type, content: $content, proxied: $proxied, ttl: 1}')"

  if [ -n "$record_id" ]; then
    current="$(echo "$existing" | jq -r --arg type "$type" '.result[] | select(.type==$type) | .content' | head -n1)"
    current_proxied="$(echo "$existing" | jq -r --arg type "$type" '.result[] | select(.type==$type) | .proxied' | head -n1)"
    if [ "$current" = "$content" ] && [ "$current_proxied" = "$proxied" ]; then
      echo "==> OK ${type} ${name} -> ${content} (proxied=${proxied})"
      return 0
    fi
    echo "==> Updating ${type} ${name} -> ${content} (proxied=${proxied})"
    cf_request PUT "/zones/${ZONE_ID}/dns_records/${record_id}" "$body" | jq -e '.success' >/dev/null
  else
    echo "==> Creating ${type} ${name} -> ${content} (proxied=${proxied})"
    cf_request POST "/zones/${ZONE_ID}/dns_records" "$body" | jq -e '.success' >/dev/null
  fi
}

reconcile_ssl_mode() {
  local current
  current="$(cf_request GET "/zones/${ZONE_ID}/settings/ssl" | jq -r '.result.value // empty')"
  if [ "$current" = "$DESIRED_SSL_MODE" ]; then
    echo "==> OK Cloudflare SSL/TLS mode=${current}"
    return 0
  fi
  echo "==> Setting Cloudflare SSL/TLS mode: ${current:-unknown} -> ${DESIRED_SSL_MODE}"
  cf_request PATCH "/zones/${ZONE_ID}/settings/ssl" "{\"value\":\"${DESIRED_SSL_MODE}\"}" | jq -e '.success' >/dev/null
}

HOST_EXISTING="$(fetch_existing "${RECORD_NAME}")"
echo "==> Reconciling proxied CNAME ${RECORD_NAME} -> ${CNAME_TARGET}"
delete_records A "$HOST_EXISTING"
delete_records AAAA "$HOST_EXISTING"
reconcile_record "${RECORD_NAME}" CNAME "${CNAME_TARGET}" true "$HOST_EXISTING"

if [ -n "$OWNERSHIP_NAME" ] && [ -n "$OWNERSHIP_VALUE" ]; then
  OWNERSHIP_EXISTING="$(fetch_existing "${OWNERSHIP_NAME}")"
  reconcile_record "${OWNERSHIP_NAME}" TXT "${OWNERSHIP_VALUE}" false "$OWNERSHIP_EXISTING"
fi

reconcile_ssl_mode

echo "==> Verifying Cloudflare records..."
HOST_EXISTING="$(fetch_existing "${RECORD_NAME}")"
CF_CNAME="$(echo "$HOST_EXISTING" | jq -r '.result[] | select(.type=="CNAME") | .content' | head -n1)"
CF_PROXIED="$(echo "$HOST_EXISTING" | jq -r '.result[] | select(.type=="CNAME") | .proxied' | head -n1)"
if [ "$CF_CNAME" != "$CNAME_TARGET" ] || [ "$CF_PROXIED" != "true" ]; then
  echo "ERROR: Cloudflare CNAME is ${CF_CNAME:-missing} (proxied=${CF_PROXIED:-unknown}), expected ${CNAME_TARGET} proxied=true" >&2
  exit 1
fi
echo "==> Cloudflare CNAME verified"

if [ -n "$OWNERSHIP_NAME" ] && [ -n "$OWNERSHIP_VALUE" ]; then
  echo "==> Waiting for ownership TXT propagation (1.1.1.1)..."
  OWNERSHIP_VISIBLE=""
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
    RESOLVED_TXT="$(dig +short TXT "${OWNERSHIP_NAME}" @1.1.1.1 2>/dev/null | tr -d '"' | head -n1 || true)"
    if [ "$RESOLVED_TXT" = "$OWNERSHIP_VALUE" ]; then
      OWNERSHIP_VISIBLE=1
      echo "==> Ownership TXT visible: ${OWNERSHIP_NAME}=${OWNERSHIP_VALUE}"
      break
    fi
    echo "  attempt ${attempt}/12 — TXT not visible yet, waiting 10s..."
    sleep 10
  done
  if [ -z "$OWNERSHIP_VISIBLE" ]; then
    echo "ERROR: ${OWNERSHIP_NAME} TXT not visible on 1.1.1.1" >&2
    exit 1
  fi
fi

echo "==> Waiting for public DNS propagation (1.1.1.1)..."
RESOLVED=""
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
  RESOLVED="$(dig +short "${RECORD_NAME}" A @1.1.1.1 2>/dev/null | head -n1 || true)"
  if [ -n "$RESOLVED" ]; then
    echo "==> Public DNS resolves ${RECORD_NAME} -> ${RESOLVED}"
    break
  fi
  echo "  attempt ${attempt}/12 — not visible on 1.1.1.1 yet, waiting 10s..."
  sleep 10
done

if [ -z "${RESOLVED}" ]; then
  echo "ERROR: ${RECORD_NAME} still does not resolve via public DNS (1.1.1.1)" >&2
  exit 1
fi

echo "==> DNS reconciled for ${RECORD_NAME}"
