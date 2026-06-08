# bao run — fetch KV secrets and inject as environment variables.
# shellcheck shell=bash

bao_run_usage() {
  cat <<EOF
Usage: bao run [OPTIONS] -- <command> [args...]

Fetch secrets from OpenBao and run a command with them injected as env vars.

Options:
  --path PATH       Full KV path (e.g. doppler/myapp/dev)
  --mount PATH      KV mount (default: doppler, or from .bao.yaml)
  --project NAME    Doppler-style project name
  --config NAME     Doppler-style config/environment name
  --dry-run         Print secret path and env var names only (no values)
  -h, --help        Show this help

Config resolution (first match wins):
  1. CLI flags (--path, or --mount + --project + --config)
  2. Environment: BAO_MOUNT, BAO_PROJECT, BAO_CONFIG
  3. .bao.yaml in current directory or parent (up to git root)

Examples:
  bao setup --project myapp --config dev
  bao run -- bun myserver.tsx
  bao run --project myapp --config prd -- npm start
  bao run --dry-run -- bun test
EOF
}

bao_run() {
  local cli_mount="" cli_project="" cli_config="" cli_path="" dry_run=false
  local -a cmd=()

  while [ $# -gt 0 ]; do
    case "$1" in
      --mount)
        cli_mount="$2"
        shift 2
        ;;
      --project)
        cli_project="$2"
        shift 2
        ;;
      --config)
        cli_config="$2"
        shift 2
        ;;
      --path)
        cli_path="$2"
        shift 2
        ;;
      --dry-run)
        dry_run=true
        shift
        ;;
      -h|--help)
        bao_run_usage
        return 0
        ;;
      --)
        shift
        cmd=("$@")
        break
        ;;
      *)
        echo "ERROR: Unknown option: $1" >&2
        bao_run_usage >&2
        return 1
        ;;
    esac
  done

  if [ "${#cmd[@]}" -eq 0 ]; then
    echo "ERROR: No command specified. Use -- before the command." >&2
    bao_run_usage >&2
    return 1
  fi

  require_cmd jq "Install jq: https://jqlang.github.io/jq/"

  if ! export_bao_auth; then
    return 1
  fi

  if ! resolve_bao_real_bin; then
    echo "ERROR: OpenBao CLI binary not found." >&2
    echo "       Install OpenBao and ensure 'openbao' is on PATH," >&2
    echo "       or set BAO_REAL_BIN to the real binary path." >&2
    return 1
  fi

  if ! resolve_secret_path "$cli_mount" "$cli_project" "$cli_config" "$cli_path"; then
    return 1
  fi

  echo "==> Fetching secrets from ${SECRET_PATH}..."

  local secret_json http_code
  secret_json="$(
    BAO_ADDR="$BAO_ADDR" BAO_TOKEN="$BAO_TOKEN" \
      "$BAO_REAL_BIN" kv get -format=json "$SECRET_PATH" 2>&1
  )" || {
    if echo "$secret_json" | grep -qi "sealed"; then
      echo "ERROR: OpenBao is sealed. Unseal before running commands." >&2
    elif echo "$secret_json" | grep -qi "permission denied\|403"; then
      echo "ERROR: Token lacks read access to ${SECRET_PATH}." >&2
      echo "       Run: ./scripts/create-dev-token.sh" >&2
    else
      echo "ERROR: Failed to read secret at ${SECRET_PATH}." >&2
      echo "$secret_json" >&2
    fi
    return 1
  }

  local key_count
  key_count="$(echo "$secret_json" | jq '.data.data | length')"

  if [ "$key_count" -eq 0 ]; then
    echo "ERROR: Secret at ${SECRET_PATH} has no fields." >&2
    return 1
  fi

  if [ "$dry_run" = true ]; then
    echo "Secret path: ${SECRET_PATH}"
    echo "Would inject ${key_count} environment variable(s):"
    echo "$secret_json" | jq -r '.data.data | keys[]' | sed 's/^/  /'
    echo "Command: ${cmd[*]}"
    return 0
  fi

  eval "$(
    echo "$secret_json" \
      | jq -r '.data.data | to_entries[] | "export \(.key)=\(.value|@sh)"'
  )"

  echo "==> Injected ${key_count} secret(s). Running: ${cmd[*]}"
  exec "${cmd[@]}"
}

bao_setup_usage() {
  cat <<EOF
Usage: bao setup [OPTIONS]

Write a .bao.yaml config file in the current directory (Doppler-style setup).

Options:
  --project NAME   Project name (required)
  --config NAME    Config/environment name (required)
  --mount PATH     KV mount (default: doppler)
  --addr URL       OpenBao address (default: https://secret-store.chrisvouga.dev)
  -h, --help       Show this help

Example:
  bao setup --project myapp --config dev
EOF
}

bao_setup() {
  local project="" config="" mount="" addr=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --project)
        project="$2"
        shift 2
        ;;
      --config)
        config="$2"
        shift 2
        ;;
      --mount)
        mount="$2"
        shift 2
        ;;
      --addr)
        addr="$2"
        shift 2
        ;;
      -h|--help)
        bao_setup_usage
        return 0
        ;;
      *)
        echo "ERROR: Unknown option: $1" >&2
        bao_setup_usage >&2
        return 1
        ;;
    esac
  done

  write_bao_config \
    "${addr:-${BAO_ADDR:-$BAO_DEFAULT_ADDR}}" \
    "${mount:-$BAO_DEFAULT_MOUNT}" \
    "$project" \
    "$config"
}
