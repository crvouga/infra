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

# pgweb ships with libpq < 14 (no TLS SNI). Neon routes via SNI or options=endpoint=…
prepare_neon_database_url() {
  local uri="$1"
  local host endpoint_id endpoint_opt

  host="$(printf '%s' "$uri" | sed -nE 's|^[^@]*@([^:/]+).*|\1|p')"
  case "$host" in
    *.neon.tech) ;;
    *) printf '%s' "$uri"; return 0 ;;
  esac

  case "$uri" in
    *endpoint%3D* | *endpoint=*) printf '%s' "$uri"; return 0 ;;
  esac

  endpoint_id="${host%%.*}"
  endpoint_id="${endpoint_id%-pooler}"
  endpoint_opt="endpoint%3D${endpoint_id}"

  case "$uri" in
    *[\?\&]options=*)
      printf '%s' "$uri" | sed "s/\\(options=[^&]*\\)/\\1%20${endpoint_opt}/"
      ;;
    *\?*)
      printf '%s&options=%s' "$uri" "$endpoint_opt"
      ;;
    *)
      printf '%s?options=%s' "$uri" "$endpoint_opt"
      ;;
  esac
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

write_bookmark dev "$(prepare_neon_database_url "$DEV_DATABASE_URL")"
write_bookmark prd "$(prepare_neon_database_url "$PRD_DATABASE_URL")"

exec /usr/bin/pgweb \
  --bind=0.0.0.0 \
  --listen=8081 \
  --sessions \
  --bookmarks-dir="$BOOKMARKS_DIR"
