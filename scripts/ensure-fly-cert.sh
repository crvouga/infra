#!/usr/bin/env bash
# Wait for Fly TLS cert on a Cloudflare-proxied custom hostname.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FLY_TOML="${REPO_ROOT}/fly.toml"

HOSTNAME="${VAULT_HOSTNAME:-vault.chrisvouga.dev}"
FLY_APP="${FLY_APP:-}"
DNS_RESOLVER="${DNS_RESOLVER:-1.1.1.1}"
MAX_ATTEMPTS="${CERT_MAX_ATTEMPTS:-24}"
RETRY_DELAY_SEC="${CERT_RETRY_DELAY_SEC:-15}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: $1 is required" >&2
    exit 1
  fi
}

require_cmd flyctl
require_cmd jq
require_cmd dig

if [ -z "${FLY_APP}" ] && [ -f "${FLY_TOML}" ]; then
  FLY_APP="$(grep -E '^app[[:space:]]*=' "${FLY_TOML}" | head -1 | sed -E 's/^app[[:space:]]*=[[:space:]]*"?([^"]+)"?[[:space:]]*$/\1/')"
fi
FLY_APP="${FLY_APP:-crvouga-vault}"

cert_json() {
  flyctl certs show "${HOSTNAME}" --app "${FLY_APP}" --json
}

ownership_ready() {
  local name value resolved
  name="$(cert_json | jq -r '.dns_requirements.ownership.name // empty')"
  value="$(cert_json | jq -r '.dns_requirements.ownership.app_value // empty')"
  if [ -z "$name" ] || [ -z "$value" ]; then
    return 0
  fi
  resolved="$(dig +short TXT "${name}" @"${DNS_RESOLVER}" 2>/dev/null | tr -d '"' | head -n1 || true)"
  if [ "$resolved" = "$value" ]; then
    echo "==> Ownership TXT visible on ${DNS_RESOLVER}: ${name}=${value}"
    return 0
  fi
  echo "  waiting for ownership TXT ${name}=${value} (got: ${resolved:-none})"
  return 1
}

cert_ready() {
  local configured status active
  configured="$(cert_json | jq -r '.configured // false')"
  status="$(cert_json | jq -r '.status // empty')"
  active="$(cert_json | jq -r '.certificates[0].status // empty')"
  if [ "$configured" = "true" ] && { [ "$status" = "Ready" ] || [ "$active" = "active" ]; }; then
    return 0
  fi
  echo "  cert not ready (configured=${configured}, status=${status}, active=${active:-none})"
  return 1
}

echo "==> Ensuring Fly TLS certificate for ${HOSTNAME}"
flyctl certs add "${HOSTNAME}" --app "${FLY_APP}" 2>/dev/null || true

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  echo "==> Certificate check ${attempt}/${MAX_ATTEMPTS}"
  ownership_ready || { sleep "$RETRY_DELAY_SEC"; continue; }
  flyctl certs check "${HOSTNAME}" --app "${FLY_APP}" || true
  if cert_ready; then
    flyctl certs check "${HOSTNAME}" --app "${FLY_APP}"
    echo "==> Fly TLS certificate ready for ${HOSTNAME}"
    exit 0
  fi
  sleep "$RETRY_DELAY_SEC"
done

echo "ERROR: Fly TLS certificate for ${HOSTNAME} is not ready after ${MAX_ATTEMPTS} attempts" >&2
cert_json | jq '{configured, status, validation, dns_requirements}' || true
flyctl certs list --app "${FLY_APP}" || true
exit 1
