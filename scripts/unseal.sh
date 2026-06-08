#!/usr/bin/env bash
# Auto-unseal OpenBao after deploy using keys stored in crvouga.kv.
set -euo pipefail

VAULT_ADDR="${VAULT_ADDR:-https://secret-store.chrisvouga.dev}"
UNSEAL_THRESHOLD="${UNSEAL_THRESHOLD:-3}"
UNSEAL_KEYS_ROW="${UNSEAL_KEYS_ROW:-secret-store/unseal-keys}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=../cli/lib/vault-auth.sh
source "${REPO_ROOT}/cli/lib/vault-auth.sh"

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
KEYS_JSON="$(psql "$DB_CONNECTION_URI" -tAc \
  "SELECT v FROM crvouga.kv WHERE k = '${UNSEAL_KEYS_ROW}'" | tr -d '\n' | xargs)"

if [ -z "$KEYS_JSON" ]; then
  echo "ERROR: No unseal keys found at crvouga.kv (k='${UNSEAL_KEYS_ROW}')" >&2
  echo "       Populate crvouga.kv with key_1, key_2, ... in the v JSON column." >&2
  exit 1
fi

echo "==> Applying ${UNSEAL_THRESHOLD} unseal key(s)..."
for i in $(seq 1 "$UNSEAL_THRESHOLD"); do
  KEY="$(echo "$KEYS_JSON" | jq -r --arg n "$i" '.["key_" + $n] // empty')"
  KEY="$(printf '%s' "$KEY" | tr -d '\n\r')"
  if [ -z "$KEY" ]; then
    echo "ERROR: key_${i} missing from crvouga.kv (UNSEAL_THRESHOLD=${UNSEAL_THRESHOLD})" >&2
    exit 1
  fi
  echo "    Unseal key ${i}/${UNSEAL_THRESHOLD}..."
  vault_cmd operator unseal "$KEY" >/dev/null || true
done

SEALED="$(curl -sf "${VAULT_ADDR}/v1/sys/seal-status" | jq -r '.sealed // true')"
if [ "$SEALED" != "false" ]; then
  echo "ERROR: OpenBao is still sealed after applying ${UNSEAL_THRESHOLD} key(s)" >&2
  exit 1
fi

echo "==> OpenBao unsealed successfully."
