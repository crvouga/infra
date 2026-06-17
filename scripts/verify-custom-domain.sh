#!/usr/bin/env bash
# Verify vault.chrisvouga.dev DNS, Fly TLS cert, and HTTPS reachability.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FLY_TOML="${REPO_ROOT}/fly.toml"

HOSTNAME="${VAULT_HOSTNAME:-vault.chrisvouga.dev}"
HEALTH_PATH="${VAULT_HEALTH_PATH:-/v1/sys/health?standbyok=true&sealedcode=200&uninitcode=200}"
HEALTH_URL="https://${HOSTNAME}${HEALTH_PATH}"
FLY_APP="${FLY_APP:-}"
DNS_RESOLVER="${DNS_RESOLVER:-1.1.1.1}"
REQUIRE_HEALTHY="${REQUIRE_HEALTHY:-false}"
REQUIRE_DNS="${REQUIRE_DNS:-true}"
REQUIRE_CERT="${REQUIRE_CERT:-true}"
RETRIES="${VERIFY_RETRIES:-12}"
RETRY_DELAY_SEC="${VERIFY_RETRY_DELAY_SEC:-10}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: $1 is required" >&2
    exit 1
  fi
}

require_cmd curl
require_cmd jq
require_cmd dig

if [ -z "${FLY_APP}" ] && [ -f "${FLY_TOML}" ]; then
  FLY_APP="$(grep -E '^app[[:space:]]*=' "${FLY_TOML}" | head -1 | sed -E 's/^app[[:space:]]*=[[:space:]]*"?([^"]+)"?[[:space:]]*$/\1/')"
fi
FLY_APP="${FLY_APP:-crvouga-vault}"

check_public_dns() {
  local v4
  v4="$(dig +short "${HOSTNAME}" A @"${DNS_RESOLVER}" 2>/dev/null | head -n1 || true)"
  if [ -z "$v4" ]; then
    echo "ERROR: ${HOSTNAME} does not resolve on ${DNS_RESOLVER}" >&2
    return 1
  fi
  echo "==> Public DNS OK on ${DNS_RESOLVER}: A=${v4}"
}

check_cloudflare_cname() {
  local cf_token existing cname proxied expected
  cf_token="${CLOUDFLARE_API_TOKEN:-${CF_API_TOKEN:-}}"
  if [ -z "$cf_token" ]; then
    echo "==> Skipping Cloudflare API check (no token)"
    return 0
  fi
  if ! command -v flyctl >/dev/null 2>&1; then
    return 0
  fi

  expected="$(flyctl certs show "${HOSTNAME}" --app "${FLY_APP}" --json | jq -r '.dns_requirements.cname // empty')"
  if [ -z "$expected" ]; then
    echo "ERROR: Could not read expected CNAME target from Fly" >&2
    return 1
  fi

  zone_name="${ZONE_NAME:-chrisvouga.dev}"
  zone_id="$(curl -sS "https://api.cloudflare.com/client/v4/zones?name=${zone_name}" \
    -H "Authorization: Bearer ${cf_token}" | jq -r '.result[0].id // empty')"
  if [ -z "$zone_id" ]; then
    echo "ERROR: Cloudflare zone ${zone_name} not found" >&2
    return 1
  fi

  existing="$(curl -sS "https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records?name=${HOSTNAME}" \
    -H "Authorization: Bearer ${cf_token}")"
  cname="$(echo "$existing" | jq -r '.result[] | select(.type=="CNAME") | .content' | head -n1)"
  proxied="$(echo "$existing" | jq -r '.result[] | select(.type=="CNAME") | .proxied' | head -n1)"
  if [ "$cname" != "$expected" ] || [ "$proxied" != "true" ]; then
    echo "ERROR: Cloudflare CNAME is ${cname:-missing} (proxied=${proxied:-unknown}), expected ${expected} proxied=true" >&2
    return 1
  fi
  echo "==> Cloudflare proxied CNAME OK: ${HOSTNAME} -> ${cname}"
}

check_cert() {
  if ! command -v flyctl >/dev/null 2>&1; then
    echo "WARNING: flyctl not available — skipping cert check" >&2
    return 0
  fi
  local configured status
  configured="$(flyctl certs list --app "${FLY_APP}" --json | jq -r --arg h "$HOSTNAME" '.[] | select(.hostname==$h) | .configured')"
  status="$(flyctl certs list --app "${FLY_APP}" --json | jq -r --arg h "$HOSTNAME" '.[] | select(.hostname==$h) | .status')"
  if [ "${configured}" != "true" ]; then
    echo "ERROR: Fly TLS cert for ${HOSTNAME} is not configured (status=${status:-missing})" >&2
    flyctl certs list --app "${FLY_APP}" || true
    return 1
  fi
  if [ "${status}" != "Ready" ]; then
    echo "ERROR: Fly TLS cert for ${HOSTNAME} is not Ready (status=${status})" >&2
    flyctl certs check "${HOSTNAME}" --app "${FLY_APP}" || true
    return 1
  fi
  echo "==> Fly TLS cert OK (${HOSTNAME}, status=${status})"
}

check_https() {
  local attempt code
  for attempt in $(seq 1 "$RETRIES"); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 15 "${HEALTH_URL}" 2>/dev/null || true)"
    code="${code//$'\n'/}"
    if [ -z "$code" ]; then
      code="000"
    fi
    if [ "${REQUIRE_HEALTHY}" = "true" ]; then
      if [ "${code}" = "200" ]; then
        echo "==> HTTPS healthy: ${HEALTH_URL} (HTTP ${code})"
        return 0
      fi
    elif [ "${code}" = "200" ] || [ "${code}" = "503" ]; then
      echo "==> HTTPS reachable: ${HEALTH_URL} (HTTP ${code})"
      return 0
    fi
    echo "  HTTPS attempt ${attempt}/${RETRIES} — HTTP ${code}"
    sleep "${RETRY_DELAY_SEC}"
  done
  if [ "${REQUIRE_HEALTHY}" = "true" ]; then
    echo "ERROR: ${HEALTH_URL} did not return HTTP 200" >&2
  else
    echo "ERROR: ${HEALTH_URL} is not reachable (expected HTTP 200 or 503)" >&2
  fi
  return 1
}

echo "==> Verifying custom domain ${HOSTNAME} (require_healthy=${REQUIRE_HEALTHY})"

if [ "${REQUIRE_DNS}" = "true" ]; then
  check_public_dns
  check_cloudflare_cname
fi

if [ "${REQUIRE_CERT}" = "true" ]; then
  check_cert
fi

check_https

echo "==> Custom domain verification passed"
