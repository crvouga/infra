#!/usr/bin/env bash
# Reconcile Cloudflare DNS for vault.chrisvouga.dev -> Fly app ingress IPs
# (DNS-only A/AAAA records; Fly terminates TLS itself).
set -euo pipefail

ZONE_NAME="${ZONE_NAME:-chrisvouga.dev}"
RECORD_NAME="${RECORD_NAME:-vault.chrisvouga.dev}"
FLY_APP="${FLY_APP:-crvouga-vault}"
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

if [ -z "${CF_TOKEN}" ]; then
  echo "ERROR: CLOUDFLARE_API_TOKEN (or CF_API_TOKEN) is required" >&2
  exit 1
fi

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

echo "==> Fetching Fly ingress IPs for ${FLY_APP}..."
IPS_JSON="$(flyctl ips list -a "$FLY_APP" --json)"
V4="$(echo "$IPS_JSON" | jq -r '.[] | select(.Type=="shared_v4" or .Type=="v4") | .Address' | head -n1)"
V6="$(echo "$IPS_JSON" | jq -r '.[] | select(.Type=="v6") | .Address' | head -n1)"

if [ -z "$V4" ] && [ -z "$V6" ]; then
  echo "ERROR: No Fly ingress IPs found for ${FLY_APP} — deploy the app first" >&2
  exit 1
fi

echo "==> Existing DNS records for ${RECORD_NAME}..."
EXISTING="$(cf_request GET "/zones/${ZONE_ID}/dns_records?name=${RECORD_NAME}")"

reconcile() {
  local type="$1" content="$2"
  [ -z "$content" ] && return 0

  local record_id
  record_id="$(echo "$EXISTING" | jq -r --arg type "$type" '.result[] | select(.type==$type) | .id' | head -n1)"
  local body
  body="$(jq -n --arg name "$RECORD_NAME" --arg type "$type" --arg content "$content" \
    '{name: $name, type: $type, content: $content, proxied: false, ttl: 1}')"

  if [ -n "$record_id" ]; then
    echo "==> Updating ${type} record ${RECORD_NAME} -> ${content}"
    cf_request PUT "/zones/${ZONE_ID}/dns_records/${record_id}" "$body" | jq -e '.success' >/dev/null
  else
    echo "==> Creating ${type} record ${RECORD_NAME} -> ${content}"
    cf_request POST "/zones/${ZONE_ID}/dns_records" "$body" | jq -e '.success' >/dev/null
  fi
}

reconcile A "$V4"
reconcile AAAA "$V6"

echo "==> DNS reconciled for ${RECORD_NAME}"
