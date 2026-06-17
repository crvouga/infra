#!/usr/bin/env bash
# Reconcile Cloudflare DNS for vault.chrisvouga.dev -> Fly ingress (A/AAAA).
# Matches infra/scripts/sync-dns.ts (DNS-only; Fly terminates TLS).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FLY_TOML="${REPO_ROOT}/fly.toml"

ZONE_NAME="${ZONE_NAME:-chrisvouga.dev}"
RECORD_NAME="${RECORD_NAME:-vault.chrisvouga.dev}"
FLY_APP="${FLY_APP:-}"
CF_TOKEN="${CLOUDFLARE_API_TOKEN:-${CF_API_TOKEN:-}}"

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
  cf_request GET "/zones/${ZONE_ID}/dns_records?name=${RECORD_NAME}"
}

echo "==> Looking up Cloudflare zone ${ZONE_NAME}..."
ZONE_ID="$(cf_request GET "/zones?name=${ZONE_NAME}" | jq -r '.result[0].id // empty')"
if [ -z "$ZONE_ID" ]; then
  echo "ERROR: Cloudflare zone ${ZONE_NAME} not found" >&2
  exit 1
fi

echo "==> Fetching Fly ingress IPs for ${FLY_APP}..."
IPS_JSON="$(flyctl ips list --app "${FLY_APP}" --json)"
V4="$(echo "$IPS_JSON" | jq -r '.[] | select(.Type=="shared_v4" or .Type=="v4") | .Address' | head -n1)"
V6="$(echo "$IPS_JSON" | jq -r '.[] | select(.Type=="v6") | .Address' | head -n1)"
if [ -z "$V4" ] && [ -z "$V6" ]; then
  echo "ERROR: No Fly ingress IPs found for ${FLY_APP}" >&2
  exit 1
fi
echo "==> Fly ingress: v4=${V4:-none} v6=${V6:-none}"

delete_records() {
  local type="$1"
  local existing="$2"
  local ids
  ids="$(echo "$existing" | jq -r --arg type "$type" '.result[] | select(.type==$type) | .id')"
  while IFS= read -r record_id; do
    [ -z "$record_id" ] && continue
    echo "==> Deleting stale ${type} record ${RECORD_NAME} (${record_id})"
    cf_request DELETE "/zones/${ZONE_ID}/dns_records/${record_id}" | jq -e '.success' >/dev/null
  done <<< "$ids"
}

reconcile_record() {
  local type="$1" content="$2" existing="$3"
  local record_id current body
  record_id="$(echo "$existing" | jq -r --arg type "$type" '.result[] | select(.type==$type) | .id' | head -n1)"
  body="$(jq -n --arg name "$RECORD_NAME" --arg type "$type" --arg content "$content" \
    '{name: $name, type: $type, content: $content, proxied: false, ttl: 1}')"

  if [ -n "$record_id" ]; then
    current="$(echo "$existing" | jq -r --arg type "$type" '.result[] | select(.type==$type) | .content' | head -n1)"
    if [ "$current" = "$content" ]; then
      echo "==> OK ${type} ${RECORD_NAME} -> ${content}"
      return 0
    fi
    echo "==> Updating ${type} ${RECORD_NAME} -> ${content}"
    cf_request PUT "/zones/${ZONE_ID}/dns_records/${record_id}" "$body" | jq -e '.success' >/dev/null
  else
    echo "==> Creating ${type} ${RECORD_NAME} -> ${content}"
    cf_request POST "/zones/${ZONE_ID}/dns_records" "$body" | jq -e '.success' >/dev/null
  fi
}

EXISTING="$(fetch_existing)"
echo "==> Reconciling ${RECORD_NAME} -> Fly ingress"
delete_records CNAME "$EXISTING"
if [ -n "$V4" ]; then
  reconcile_record A "$V4" "$EXISTING"
fi
if [ -n "$V6" ]; then
  reconcile_record AAAA "$V6" "$EXISTING"
fi

echo "==> Verifying Cloudflare records..."
EXISTING="$(fetch_existing)"
if [ -n "$V4" ]; then
  CF_V4="$(echo "$EXISTING" | jq -r '.result[] | select(.type=="A") | .content' | head -n1)"
  if [ "$CF_V4" != "$V4" ]; then
    echo "ERROR: Cloudflare A record is ${CF_V4:-missing}, expected ${V4}" >&2
    exit 1
  fi
fi
if [ -n "$V6" ]; then
  CF_V6="$(echo "$EXISTING" | jq -r '.result[] | select(.type=="AAAA") | .content' | head -n1)"
  if [ "$CF_V6" != "$V6" ]; then
    echo "ERROR: Cloudflare AAAA record is ${CF_V6:-missing}, expected ${V6}" >&2
    exit 1
  fi
fi
echo "==> Cloudflare records verified"

echo "==> Waiting for public DNS propagation..."
RESOLVED=""
for attempt in 1 2 3 4 5 6; do
  if [ -n "$V4" ]; then
    RESOLVED="$(dig +short "${RECORD_NAME}" A @1.1.1.1 2>/dev/null | head -n1 || true)"
  elif [ -n "$V6" ]; then
    RESOLVED="$(dig +short "${RECORD_NAME}" AAAA @1.1.1.1 2>/dev/null | head -n1 || true)"
  fi
  if [ -n "$RESOLVED" ]; then
    echo "==> Public DNS resolves ${RECORD_NAME} -> ${RESOLVED}"
    break
  fi
  echo "  attempt ${attempt}/6 — not visible on 1.1.1.1 yet, waiting 10s..."
  sleep 10
done

if [ -z "${RESOLVED}" ]; then
  echo "ERROR: ${RECORD_NAME} still does not resolve via public DNS (1.1.1.1)" >&2
  exit 1
fi

echo "==> DNS reconciled for ${RECORD_NAME}"
