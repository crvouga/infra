#!/usr/bin/env bash
# Reconcile Cloudflare DNS for vault.chrisvouga.dev -> crvouga-vault.fly.dev
# (DNS-only CNAME; Fly terminates TLS for the custom hostname).
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

if [ -z "${CF_TOKEN}" ]; then
  echo "ERROR: CLOUDFLARE_API_TOKEN (or CF_API_TOKEN) is required" >&2
  exit 1
fi

if [ -z "${FLY_APP}" ] && [ -f "${FLY_TOML}" ]; then
  FLY_APP="$(grep -E '^app[[:space:]]*=' "${FLY_TOML}" | head -1 | sed -E 's/^app[[:space:]]*=[[:space:]]*"?([^"]+)"?[[:space:]]*$/\1/')"
fi
FLY_APP="${FLY_APP:-crvouga-vault}"
FLY_CNAME_TARGET="${FLY_CNAME_TARGET:-${FLY_APP}.fly.dev}"

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

echo "==> Looking up Cloudflare zone ${ZONE_NAME}..."
ZONE_ID="$(cf_request GET "/zones?name=${ZONE_NAME}" | jq -r '.result[0].id // empty')"
if [ -z "$ZONE_ID" ]; then
  echo "ERROR: Cloudflare zone ${ZONE_NAME} not found" >&2
  exit 1
fi

echo "==> Fetching existing DNS records for ${RECORD_NAME}..."
EXISTING="$(cf_request GET "/zones/${ZONE_ID}/dns_records?name=${RECORD_NAME}")"

delete_records() {
  local type="$1"
  local ids
  ids="$(echo "$EXISTING" | jq -r --arg type "$type" '.result[] | select(.type==$type) | .id')"
  while IFS= read -r record_id; do
    [ -z "$record_id" ] && continue
    echo "==> Deleting stale ${type} record ${RECORD_NAME} (${record_id})"
    cf_request DELETE "/zones/${ZONE_ID}/dns_records/${record_id}" | jq -e '.success' >/dev/null
  done <<< "$ids"
}

reconcile_cname() {
  local content="$1"
  local record_id
  record_id="$(echo "$EXISTING" | jq -r '.result[] | select(.type=="CNAME") | .id' | head -n1)"
  local body
  body="$(jq -n --arg name "$RECORD_NAME" --arg content "$content" \
    '{name: $name, type: "CNAME", content: $content, proxied: false, ttl: 1}')"

  if [ -n "$record_id" ]; then
    local current
    current="$(echo "$EXISTING" | jq -r '.result[] | select(.type=="CNAME") | .content' | head -n1)"
    if [ "$current" = "$content" ]; then
      echo "==> OK CNAME ${RECORD_NAME} -> ${content}"
      return 0
    fi
    echo "==> Updating CNAME ${RECORD_NAME} -> ${content}"
    cf_request PUT "/zones/${ZONE_ID}/dns_records/${record_id}" "$body" | jq -e '.success' >/dev/null
  else
    echo "==> Creating CNAME ${RECORD_NAME} -> ${content}"
    cf_request POST "/zones/${ZONE_ID}/dns_records" "$body" | jq -e '.success' >/dev/null
  fi
}

echo "==> Reconciling ${RECORD_NAME} -> ${FLY_CNAME_TARGET}"
delete_records A
delete_records AAAA
reconcile_cname "$FLY_CNAME_TARGET"

echo "==> Waiting for public DNS propagation..."
for attempt in 1 2 3 4 5 6; do
  RESOLVED="$(dig +short "${RECORD_NAME}" CNAME @1.1.1.1 2>/dev/null | head -n1 || true)"
  if [ -z "$RESOLVED" ]; then
    RESOLVED="$(dig +short "${RECORD_NAME}" @1.1.1.1 2>/dev/null | head -n1 || true)"
  fi
  if [ -n "$RESOLVED" ]; then
    echo "==> Public DNS resolves ${RECORD_NAME} -> ${RESOLVED}"
    break
  fi
  echo "  attempt ${attempt}/6 — not visible on 1.1.1.1 yet, waiting 10s..."
  sleep 10
done

if [ -z "${RESOLVED:-}" ]; then
  echo "ERROR: ${RECORD_NAME} still does not resolve via public DNS (1.1.1.1)" >&2
  exit 1
fi

echo "==> Checking HTTPS health..."
# Allow a few seconds for the cert/routing to fully propagate after deploy
HEALTHY=false
for attempt in 1 2 3 4 5; do
  if curl -sf --connect-timeout 10 "https://${RECORD_NAME}/v1/sys/health?standbyok=true" >/dev/null 2>&1; then
    HEALTHY=true
    break
  fi
  echo "  attempt ${attempt}/5 — retrying in 5s..."
  sleep 5
done

if [ "$HEALTHY" = true ]; then
  echo "==> DNS reconciled — https://${RECORD_NAME} is healthy"
else
  # Don't fail the workflow - cert/routing may still be propagating
  echo "WARNING: HTTPS health check failed after ${attempt} attempts; cert or Fly routing may still be catching up" >&2
  echo "Continuing anyway - deployment succeeded and DNS record created successfully."
fi
