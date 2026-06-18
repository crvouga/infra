#!/usr/bin/env bash
set -euo pipefail

: "${VAULT_ADDR:?VAULT_ADDR is required}"
: "${VAULT_TOKEN:?VAULT_TOKEN is required}"

BOOKMARKS_DIR="${BOOKMARKS_DIR:-/pgweb-bookmarks}"

vault_get() {
  local config="$1" field="$2"
  local url="${VAULT_ADDR%/}/v1/secret/data/personal/${config}"
  local body http_code resp val

  body="$(curl -sS -w "\n%{http_code}" -H "X-Vault-Token: ${VAULT_TOKEN}" "$url")"
  http_code="$(echo "$body" | tail -n1)"
  resp="$(echo "$body" | sed '$d')"

  if [[ "$http_code" != "200" ]]; then
    echo "Vault fetch failed (HTTP ${http_code}): ${url}" >&2
    exit 1
  fi

  val="$(echo "$resp" | jq -r --arg f "$field" '.data.data[$f] // empty')"
  if [[ -z "$val" || "$val" == "null" ]]; then
    echo "Missing field ${field} at secret/personal/${config}" >&2
    exit 1
  fi

  echo "$val"
}

write_bookmark() {
  local name="$1" url="$2"
  local escaped="${url//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  printf 'url = "%s"\n' "$escaped" > "${BOOKMARKS_DIR}/${name}.toml"
}

mkdir -p "$BOOKMARKS_DIR"

DEV_DATABASE_URL="$(vault_get dev DATABASE_URL)"
PRD_DATABASE_URL="$(vault_get prd DATABASE_URL)"

if [[ -z "${PGWEB_AUTH_USER:-}" || -z "${PGWEB_AUTH_PASS:-}" ]]; then
  export PGWEB_AUTH_USER="$(vault_get prd PGWEB_AUTH_USER)"
  export PGWEB_AUTH_PASS="$(vault_get prd PGWEB_AUTH_PASS)"
fi

export PGWEB_SESSIONS=1

write_bookmark dev "$DEV_DATABASE_URL"
write_bookmark prd "$PRD_DATABASE_URL"

exec /usr/bin/pgweb \
  --bind=0.0.0.0 \
  --listen=8081 \
  --sessions \
  --bookmarks-dir="$BOOKMARKS_DIR"
