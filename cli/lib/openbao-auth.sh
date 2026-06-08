# Shared OpenBao authentication helpers for secret-store CLI.
# shellcheck shell=bash

BAO_DEFAULT_ADDR="${BAO_DEFAULT_ADDR:-https://secret-store.chrisvouga.dev}"

resolve_bao_real_bin() {
  if [ -n "${BAO_REAL_BIN:-}" ] && [ -x "$BAO_REAL_BIN" ]; then
    return 0
  fi

  local candidate current_bao
  current_bao="$(command -v bao 2>/dev/null || true)"

  for candidate in openbao bao-real; do
    if BAO_REAL_BIN="$(command -v "$candidate" 2>/dev/null)" && [ -n "$BAO_REAL_BIN" ]; then
      return 0
    fi
  done

  for candidate in /opt/homebrew/bin/openbao /usr/local/bin/openbao; do
    if [ -x "$candidate" ]; then
      BAO_REAL_BIN="$candidate"
      return 0
    fi
  done

  if [ -n "$current_bao" ] && [ -f "$current_bao" ] \
    && ! grep -q "secret-store-bao-wrapper" "$current_bao" 2>/dev/null; then
    BAO_REAL_BIN="$current_bao"
    return 0
  fi

  return 1
}

resolve_init_output_file() {
  if [ -n "${SECRET_STORE_INIT_OUTPUT:-}" ] && [ -f "${SECRET_STORE_INIT_OUTPUT}" ]; then
    INIT_OUTPUT_FILE="${SECRET_STORE_INIT_OUTPUT}"
    return 0
  fi

  local dir="$PWD"
  while [ "$dir" != "/" ]; do
    if [ -f "${dir}/init-output.json" ]; then
      INIT_OUTPUT_FILE="${dir}/init-output.json"
      return 0
    fi
    if [ -d "${dir}/.git" ]; then
      break
    fi
    dir="$(dirname "$dir")"
  done

  if [ -f "${HOME}/.local/share/secret-store/init-output.json" ]; then
    INIT_OUTPUT_FILE="${HOME}/.local/share/secret-store/init-output.json"
    return 0
  fi

  return 1
}

resolve_bao_token() {
  if [ -n "${BAO_TOKEN:-}" ]; then
    return 0
  fi

  if [ -n "${VAULT_TOKEN:-}" ]; then
    BAO_TOKEN="$VAULT_TOKEN"
    return 0
  fi

  if resolve_bao_real_bin; then
    local token
    token="$(
      BAO_ADDR="${BAO_ADDR:-$BAO_DEFAULT_ADDR}" \
        "$BAO_REAL_BIN" print token 2>/dev/null || true
    )"
    if [ -n "$token" ]; then
      BAO_TOKEN="$token"
      return 0
    fi
  fi

  if [ -f "${HOME}/.vault-token" ]; then
    BAO_TOKEN="$(tr -d '\n\r' < "${HOME}/.vault-token")"
    if [ -n "$BAO_TOKEN" ]; then
      return 0
    fi
  fi

  if resolve_init_output_file && command -v jq >/dev/null 2>&1; then
    BAO_TOKEN="$(jq -r '.root_token // empty' "$INIT_OUTPUT_FILE")"
    if [ -n "$BAO_TOKEN" ] && [ "$BAO_TOKEN" != "null" ]; then
      return 0
    fi
    BAO_TOKEN=""
  fi

  return 1
}

export_bao_auth() {
  BAO_ADDR="${BAO_ADDR:-$BAO_DEFAULT_ADDR}"
  export BAO_ADDR

  if ! resolve_bao_token; then
    echo "ERROR: Could not resolve OpenBao token." >&2
    echo "" >&2
    echo "Authenticate with one of:" >&2
    echo "  bao login -address=\"${BAO_ADDR}\"" >&2
    echo "  export BAO_TOKEN='...'" >&2
    echo "  ./scripts/create-dev-token.sh   # scoped read token" >&2
    return 1
  fi

  export BAO_TOKEN
  return 0
}

require_cmd() {
  local cmd="$1"
  local install_hint="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: ${cmd} is required. ${install_hint}" >&2
    exit 1
  fi
}
