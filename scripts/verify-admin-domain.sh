#!/usr/bin/env bash
# Verify DNS + Fly TLS + HTTPS for admin Fly apps (pgweb, filestash).
set -euo pipefail

HOSTNAME="${HOSTNAME:?HOSTNAME is required}"
FLY_APP="${FLY_APP:?FLY_APP is required}"
# Comma-separated acceptable HTTP status codes (pgweb returns 401 due to basic auth).
ACCEPT_CODES="${ACCEPT_CODES:-200}"
HEALTH_PATH="${HEALTH_PATH:-/}"
HEALTH_URL="https://${HOSTNAME}${HEALTH_PATH}"
DNS_RESOLVER="${DNS_RESOLVER:-1.1.1.1}"
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

code_accepted() {
  local code="$1"
  local allowed
  IFS=',' read -ra allowed <<< "${ACCEPT_CODES}"
  for c in "${allowed[@]}"; do
    if [ "$code" = "$c" ]; then
      return 0
    fi
  done
  return 1
}

check_public_dns() {
  local resolved
  resolved="$(dig +short "${HOSTNAME}" @"${DNS_RESOLVER}" 2>/dev/null | head -n1 || true)"
  if [ -z "$resolved" ]; then
    echo "ERROR: ${HOSTNAME} does not resolve on ${DNS_RESOLVER}" >&2
    return 1
  fi
  echo "==> Public DNS OK on ${DNS_RESOLVER}: ${resolved}"
}

check_cert() {
  if ! command -v flyctl >/dev/null 2>&1; then
    echo "WARNING: flyctl not available — skipping cert check" >&2
    return 0
  fi
  local cert configured status active
  cert="$(flyctl certs show "${HOSTNAME}" --app "${FLY_APP}" --json)"
  configured="$(echo "$cert" | jq -r '.configured // false')"
  status="$(echo "$cert" | jq -r '.status // empty')"
  active="$(echo "$cert" | jq -r '.certificates[0].status // empty')"
  if [ "${configured}" = "true" ] && { [ "${status}" = "Ready" ] || [ "${active}" = "active" ]; }; then
    echo "==> Fly TLS cert OK (${HOSTNAME}, status=${status}, active=${active:-none})"
    return 0
  fi
  echo "ERROR: Fly TLS cert for ${HOSTNAME} is not ready (configured=${configured}, status=${status}, active=${active:-none})" >&2
  flyctl certs check "${HOSTNAME}" --app "${FLY_APP}" || true
  return 1
}

check_https() {
  local attempt code
  for attempt in $(seq 1 "$RETRIES"); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 15 "${HEALTH_URL}" 2>/dev/null || true)"
    code="${code//$'\n'/}"
    if [ -z "$code" ]; then
      code="000"
    fi
    if code_accepted "$code"; then
      echo "==> HTTPS OK: ${HEALTH_URL} (HTTP ${code})"
      return 0
    fi
    echo "  HTTPS attempt ${attempt}/${RETRIES} — HTTP ${code} (want ${ACCEPT_CODES})"
    sleep "${RETRY_DELAY_SEC}"
  done
  echo "ERROR: ${HEALTH_URL} did not return an acceptable status (want ${ACCEPT_CODES})" >&2
  return 1
}

echo "==> Verifying admin domain ${HOSTNAME} (${FLY_APP})"
check_public_dns
check_cert
check_https
echo "==> Admin domain verification passed"
