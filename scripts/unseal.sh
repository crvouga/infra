#!/usr/bin/env bash
# Auto-unseal OpenBao after deploy using keys stored in crvouga.kv.
set -euo pipefail

VAULT_ADDR="${VAULT_ADDR:-https://secret-store.chrisvouga.dev}"
UNSEAL_THRESHOLD_OVERRIDE="${UNSEAL_THRESHOLD:-}"
UNSEAL_KEYS_ROW="${UNSEAL_KEYS_ROW:-secret-store/unseal-keys}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=../cli/lib/vault-auth.sh
source "${REPO_ROOT}/cli/lib/vault-auth.sh"
# shellcheck source=lib/db-connection.sh
source "${SCRIPT_DIR}/lib/db-connection.sh"

if [ -z "${DB_CONNECTION_URI:-}" ]; then
  echo "ERROR: DB_CONNECTION_URI is required" >&2
  exit 1
fi

require_cmd psql "Install PostgreSQL client"
require_cmd curl "Install curl"
require_cmd jq "Install jq: https://jqlang.github.io/jq/"

if ! resolve_vault_bin; then
  echo "ERROR: vault CLI is required (https://openbao.org/docs/install/)" >&2
  exit 1
fi

export VAULT_ADDR
DB_CONNECTION_URI="$(prepare_db_connection_uri "$DB_CONNECTION_URI")"
export DB_CONNECTION_URI

# OpenBao returns 503 on /sys/health when sealed; treat sealed/uninit as reachable.
HEALTH_URL="${VAULT_ADDR}/v1/sys/health?standbyok=true&sealedcode=200&uninitcode=200"

echo "==> Waiting for OpenBao at ${VAULT_ADDR}..."
for i in $(seq 1 60); do
  if curl -sf "${HEALTH_URL}" >/dev/null 2>&1; then
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "ERROR: OpenBao did not become reachable within 5 minutes" >&2
    exit 1
  fi
  sleep 5
done

SEALED="$(curl -sf "${VAULT_ADDR}/v1/sys/seal-status" | jq -r '.sealed // true')"
if [ "$SEALED" = "false" ]; then
  echo "==> OpenBao is already unsealed."
  exit 0
fi

echo "==> OpenBao is sealed. Fetching unseal keys from crvouga.kv..."
KEYS_JSON="$(psql_with_retry -t -A -q --no-psqlrc \
  -c "SELECT v::text FROM crvouga.kv WHERE k = '${UNSEAL_KEYS_ROW}'" \
  | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

if [ -z "$KEYS_JSON" ]; then
  echo "ERROR: No unseal keys found at crvouga.kv (k='${UNSEAL_KEYS_ROW}')" >&2
  echo "       Populate crvouga.kv with keys_base64, unseal_keys_b64, or key_1..key_N in v." >&2
  exit 1
fi

# crvouga.kv.v may be stored double-encoded (a JSON string containing JSON).
# Unwrap until we land on an object, so extraction below sees the real shape.
for _ in 1 2 3; do
  if echo "$KEYS_JSON" | jq -e 'type == "string"' >/dev/null 2>&1; then
    KEYS_JSON="$(echo "$KEYS_JSON" | jq -r '.')"
  else
    break
  fi
done

if ! echo "$KEYS_JSON" | jq -e . >/dev/null 2>&1; then
  echo "ERROR: Unseal keys at crvouga.kv (k='${UNSEAL_KEYS_ROW}') are not valid JSON" >&2
  exit 1
fi

# --- Debug: show the shape of the stored value without leaking key material ---
echo "==> [debug] unseal-keys JSON shape:"
echo "$KEYS_JSON" | jq -r '
  if type == "object" then
    "    top-level type: object",
    "    top-level keys: " + ([keys[]] | join(", ")),
    (to_entries[]
      | if (.value | type) == "array"
        then "    ." + .key + ": array(len=" + (.value | length | tostring) + ")"
        else "    ." + .key + ": " + (.value | type) end)
  else
    "    top-level type: " + type
  end
' >&2 || true

# Fingerprint a key without revealing it: length, first/last chars, sha256 prefix.
fingerprint_key() {
  local key="$1"
  local len="${#key}"
  local head="${key:0:4}"
  local tail="${key: -4}"
  local sum="n/a"
  if command -v sha256sum >/dev/null 2>&1; then
    sum="$(printf '%s' "$key" | sha256sum | cut -c1-12)"
  elif command -v shasum >/dev/null 2>&1; then
    sum="$(printf '%s' "$key" | shasum -a 256 | cut -c1-12)"
  fi
  printf 'len=%s head=%q tail=%q sha256=%s' "$len" "$head" "$tail" "$sum"
}

# Dump seal-status progress fields (no secrets) so we can see if a key landed.
dump_seal_status() {
  local label="$1"
  local status
  status="$(curl -sf "${VAULT_ADDR}/v1/sys/seal-status" 2>/dev/null || echo '{}')"
  echo "    [debug] seal-status ${label}: $(echo "$status" | jq -rc '{sealed, t, n, progress, version, type}')" >&2
}

SEAL_STATUS="$(curl -sf "${VAULT_ADDR}/v1/sys/seal-status")"
UNSEAL_THRESHOLD="$(echo "$SEAL_STATUS" | jq -r '.t // empty')"
if [ -z "$UNSEAL_THRESHOLD" ] || [ "$UNSEAL_THRESHOLD" = "null" ]; then
  UNSEAL_THRESHOLD="${UNSEAL_THRESHOLD_OVERRIDE:-3}"
fi

extract_unseal_key() {
  local keys_json="$1"
  local index="$2"
  local idx=$((index - 1))
  local key

  key="$(echo "$keys_json" | jq -r --arg n "$index" '.["key_" + $n] // empty')"
  if [ -n "$key" ]; then
    printf '%s' "$key"
    return 0
  fi

  key="$(echo "$keys_json" | jq -r --argjson idx "$idx" '.unseal_keys_b64[$idx] // empty')"
  if [ -n "$key" ]; then
    printf '%s' "$key"
    return 0
  fi

  key="$(echo "$keys_json" | jq -r --argjson idx "$idx" '.keys_base64[$idx] // empty')"
  if [ -n "$key" ]; then
    printf '%s' "$key"
    return 0
  fi

  key="$(echo "$keys_json" | jq -r --argjson idx "$idx" '.keys[$idx] // empty')"
  if [ -n "$key" ]; then
    printf '%s' "$key"
    return 0
  fi

  return 1
}

echo "==> Applying ${UNSEAL_THRESHOLD} unseal key(s) (threshold from seal-status)..."
for i in $(seq 1 "$UNSEAL_THRESHOLD"); do
  KEY="$(extract_unseal_key "$KEYS_JSON" "$i" | tr -d '\n\r' || true)"
  if [ -z "$KEY" ]; then
    echo "ERROR: unseal key ${i} missing from crvouga.kv (need ${UNSEAL_THRESHOLD} key(s))" >&2
    echo "       Expected keys_base64[], unseal_keys_b64[], or key_${i} in v." >&2
    exit 1
  fi
  echo "    Unseal key ${i}/${UNSEAL_THRESHOLD}..."
  UNSEAL_OUTPUT="$(vault_cmd operator unseal "$KEY" 2>&1)" || {
    echo "$UNSEAL_OUTPUT" >&2
    if echo "$UNSEAL_OUTPUT" | grep -qi "failed to setup auth table"; then
      echo "ERROR: OpenBao post-unseal setup failed (duplicate auth mount in storage)." >&2
      echo "       Run: ./scripts/repair-openbao-auth-mounts.sh" >&2
    fi
    exit 1
  }

  # CLI defaults to table output; query seal-status API for JSON.
  SEALED="$(curl -sf "${VAULT_ADDR}/v1/sys/seal-status" | jq -r '.sealed // true')"
  if [ "$SEALED" = "false" ]; then
    echo "==> OpenBao unsealed successfully."
    exit 0
  fi
done

SEALED="$(curl -sf "${VAULT_ADDR}/v1/sys/seal-status" | jq -r '.sealed // true')"
if [ "$SEALED" != "false" ]; then
  echo "ERROR: OpenBao is still sealed after applying ${UNSEAL_THRESHOLD} key(s)" >&2
  exit 1
fi

echo "==> OpenBao unsealed successfully."
