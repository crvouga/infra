#!/usr/bin/env bash
set -euo pipefail

: "${VAULT_ADDR:?VAULT_ADDR is required}"
: "${VAULT_TOKEN:?VAULT_TOKEN is required}"

CONFIG_DIR="/app/data/state/config"
CONFIG_FILE="${CONFIG_DIR}/config.json"

vault_fetch_config() {
  local config="$1"
  local url="${VAULT_ADDR%/}/v1/secret/data/personal/${config}"
  local body http_code resp

  body="$(curl -sS -w "\n%{http_code}" -H "X-Vault-Token: ${VAULT_TOKEN}" "$url")"
  http_code="$(echo "$body" | tail -n1)"
  resp="$(echo "$body" | sed '$d')"

  if [[ "$http_code" != "200" ]]; then
    echo "Vault fetch failed (HTTP ${http_code}): ${url}" >&2
    exit 1
  fi

  echo "$resp" | jq -e '.data.data' > /dev/null
  echo "$resp" | jq '.data.data'
}

require_field() {
  local data="$1" field="$2" config="$3"
  local val
  val="$(echo "$data" | jq -r --arg f "$field" '.[$f] // empty')"
  if [[ -z "$val" || "$val" == "null" ]]; then
    echo "Missing field ${field} at secret/personal/${config}" >&2
    exit 1
  fi
  echo "$val"
}

fetch_s3_connection() {
  local label="$1" config="$2"
  local data access_key_id secret_access_key region endpoint bucket

  data="$(vault_fetch_config "$config")"
  access_key_id="$(require_field "$data" S3_ACCESS_KEY_ID "$config")"
  secret_access_key="$(echo "$data" | jq -r '.S3_SECRET_ACCESS_KEY // .S3_ACCESS_KEY // empty')"
  if [[ -z "$secret_access_key" || "$secret_access_key" == "null" ]]; then
    echo "Missing S3_SECRET_ACCESS_KEY (or S3_ACCESS_KEY) at secret/personal/${config}" >&2
    exit 1
  fi
  region="$(require_field "$data" S3_REGION "$config")"
  endpoint="$(require_field "$data" S3_ENDPOINT "$config")"
  bucket="$(require_field "$data" S3_BUCKET "$config")"

  jq -n \
    --arg type "s3" \
    --arg label "$label" \
    --arg access_key_id "$access_key_id" \
    --arg secret_access_key "$secret_access_key" \
    --arg region "$region" \
    --arg endpoint "$endpoint" \
    --arg bucket "$bucket" \
    '{
      type: $type,
      label: $label,
      params: {
        access_key_id: $access_key_id,
        secret_access_key: $secret_access_key,
        region: $region,
        endpoint: $endpoint,
        bucket: $bucket
      }
    }'
}

ensure_auth_credentials() {
  if [[ -z "${FILESTASH_AUTH_USER:-}" ]]; then
    FILESTASH_AUTH_USER="admin"
  fi
  if [[ -n "${FILESTASH_AUTH_PASS:-}" ]]; then
    return 0
  fi
  if [[ -n "${ADMIN_PASSWORD:-}" ]]; then
    FILESTASH_AUTH_PASS="$ADMIN_PASSWORD"
    return 0
  fi

  local data
  data="$(vault_fetch_config prd)"
  if [[ "$FILESTASH_AUTH_USER" == "admin" ]]; then
    local vault_user
    vault_user="$(echo "$data" | jq -r '.FILESTASH_AUTH_USER // empty')"
    if [[ -n "$vault_user" ]]; then
      FILESTASH_AUTH_USER="$vault_user"
    fi
  fi
  FILESTASH_AUTH_PASS="$(echo "$data" | jq -r '.FILESTASH_AUTH_PASS // empty')"

  if [[ -z "$FILESTASH_AUTH_PASS" ]]; then
    echo "FILESTASH_AUTH_PASS (or ADMIN_PASSWORD) is required" >&2
    exit 1
  fi
}

mkdir -p "$CONFIG_DIR"

DEV_CONN="$(fetch_s3_connection "S3 Dev" dev)"
PRD_CONN="$(fetch_s3_connection "S3 Prod" prd)"
CONNECTIONS="$(jq -n \
  --argjson dev "$DEV_CONN" \
  --argjson prd "$PRD_CONN" \
  '[{type: $dev.type, label: $dev.label}, {type: $prd.type, label: $prd.label}]')"

ensure_auth_credentials
HTPASSWD_HASH="$(openssl passwd -6 "$FILESTASH_AUTH_PASS")"
IDP_PARAMS="$(jq -cn --arg user "$FILESTASH_AUTH_USER" --arg hash "$HTPASSWD_HASH" '{users: ($user + ":" + $hash)}')"

MAPPING_PARAMS="$(jq -cn \
  --argjson dev "$DEV_CONN" \
  --argjson prd "$PRD_CONN" \
  '{
    ($dev.label): ({
      type: "s3",
      access_key_id: $dev.params.access_key_id,
      secret_access_key: $dev.params.secret_access_key,
      region: $dev.params.region,
      endpoint: $dev.params.endpoint,
      bucket: $dev.params.bucket
    }),
    ($prd.label): ({
      type: "s3",
      access_key_id: $prd.params.access_key_id,
      secret_access_key: $prd.params.secret_access_key,
      region: $prd.params.region,
      endpoint: $prd.params.endpoint,
      bucket: $prd.params.bucket
    })
  }')"

MIDDLEWARE="$(jq -cn \
  --arg idp_params "$IDP_PARAMS" \
  --arg mapping_params "$MAPPING_PARAMS" \
  '{
    identity_provider: {
      type: "htpasswd",
      params: $idp_params
    },
    attribute_mapping: {
      related_backend: "S3 Dev,S3 Prod",
      params: $mapping_params
    }
  }')"

if [[ -f "$CONFIG_FILE" ]]; then
  jq \
    --argjson connections "$CONNECTIONS" \
    --argjson middleware "$MIDDLEWARE" \
    '.connections = $connections | .middleware = $middleware' \
    "$CONFIG_FILE" > "${CONFIG_FILE}.tmp"
else
  jq -n \
    --argjson connections "$CONNECTIONS" \
    --argjson middleware "$MIDDLEWARE" \
    '{connections: $connections, middleware: $middleware}' \
    > "${CONFIG_FILE}.tmp"
fi

mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

exec /app/filestash
