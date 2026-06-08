#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=../cli/lib/vault-auth.sh
source "${REPO_ROOT}/cli/lib/vault-auth.sh"

MOUNT_PATH="doppler"
DRY_RUN=false
declare -a PROJECT_FILTER=()

TMPFILE=""
CONFIGS_MIGRATED=0
CONFIGS_SKIPPED=0
TOTAL_KEYS=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Migrate secrets from Doppler to OpenBao (KV v2).

Each Doppler project/config becomes one OpenBao secret at:
  <mount>/<project>/<config>

Each Doppler key becomes a field on that secret. DOPPLER_* reserved keys are excluded.

Options:
  --mount PATH     KV v2 mount path (default: doppler)
  --project NAME   Limit to a specific Doppler project (repeatable)
  --dry-run        List paths and key counts without writing to OpenBao
  -h, --help       Show this help

Environment:
  VAULT_ADDR       Vault API address (default: https://secret-store.chrisvouga.dev)
  VAULT_TOKEN      Vault token with write access (optional if resolved automatically)
  DOPPLER_TOKEN    Optional Doppler token (otherwise uses doppler login session)

Vault auth is resolved automatically from, in order:
  VAULT_TOKEN, vault login session, ~/.vault-token, or init-output.json

Prerequisites:
  doppler CLI authenticated (doppler login) with workplace-wide read access
  vault CLI, jq, curl
  OpenBao initialized and unsealed

Examples:
  ./scripts/vault-run.sh -- ./scripts/migrate-doppler-to-openbao.sh --dry-run
  ./scripts/vault-run.sh -- ./scripts/migrate-doppler-to-openbao.sh
  ./scripts/migrate-doppler-to-openbao.sh --project myapp --project other-app
EOF
}

cleanup() {
  if [ -n "$TMPFILE" ] && [ -f "$TMPFILE" ]; then
    rm -f "$TMPFILE"
  fi
}

list_projects() {
  local projects_json
  projects_json="$(doppler projects --json)"

  if [ "${#PROJECT_FILTER[@]}" -gt 0 ]; then
    local filter_json
    filter_json="$(printf '%s\n' "${PROJECT_FILTER[@]}" | jq -R . | jq -s .)"
    echo "$projects_json" | jq -r --argjson filter "$filter_json" '
      (if type == "array" then . elif .projects then .projects else [] end)
      | map(.name // .slug)
      | .[]
      | select(. as $p | $filter | index($p))
    '
  else
    echo "$projects_json" | jq -r '
      if type == "array" then . elif .projects then .projects else [] end
      | .[]
      | .name // .slug
    '
  fi
}

list_configs() {
  local project="$1"
  local configs_json
  configs_json="$(doppler configs --project "$project" --json)"

  echo "$configs_json" | jq -r '
    if type == "array" then . elif .configs then .configs else [] end
    | .[]
    | .name
  '
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mount)
      if [ $# -lt 2 ]; then
        echo "ERROR: --mount requires a path argument" >&2
        exit 1
      fi
      MOUNT_PATH="${2#/}"
      MOUNT_PATH="${MOUNT_PATH%/}"
      shift 2
      ;;
    --project)
      if [ $# -lt 2 ]; then
        echo "ERROR: --project requires a name argument" >&2
        exit 1
      fi
      PROJECT_FILTER+=("$2")
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

require_cmd doppler "Install: https://docs.doppler.com/docs/install-cli"
require_cmd jq "Install jq: https://jqlang.github.io/jq/"
require_cmd curl "Install curl"

if ! export_vault_auth; then
  echo "" >&2
  echo "Authenticate with one of:" >&2
  echo "  vault login -address=\"${VAULT_ADDR}\"" >&2
  echo "  export VAULT_TOKEN='...'" >&2
  echo "  ./scripts/init.sh   # then re-run this script" >&2
  exit 1
fi

if ! resolve_vault_bin; then
  echo "ERROR: vault CLI is required (https://openbao.org/docs/install/)" >&2
  exit 1
fi

trap cleanup EXIT

TMPFILE="$(mktemp)"
chmod 600 "$TMPFILE"

echo "==> Checking OpenBao health at ${VAULT_ADDR}/v1/sys/health..."
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' "${VAULT_ADDR}/v1/sys/health")"
if [ "$HTTP_CODE" != "200" ]; then
  echo "ERROR: Expected HTTP 200 from health check, got ${HTTP_CODE}" >&2
  echo "OpenBao may be sealed or uninitialized. Unseal before migrating." >&2
  exit 1
fi
echo "Health check passed (HTTP 200)."

echo "==> Verifying Vault authentication..."
if ! vault_cmd token lookup >/dev/null 2>&1; then
  echo "ERROR: VAULT_TOKEN is invalid or expired" >&2
  exit 1
fi

echo "==> Verifying Doppler authentication..."
if ! doppler me >/dev/null 2>&1; then
  echo "ERROR: Doppler CLI is not authenticated. Run: doppler login" >&2
  echo "       Or set DOPPLER_TOKEN with workplace-wide read access." >&2
  exit 1
fi

if [ "$DRY_RUN" = true ]; then
  echo "==> Dry run mode — no secrets will be written to OpenBao"
else
  echo "==> Ensuring KV v2 engine at ${MOUNT_PATH}/..."
  if ! vault_cmd secrets list -format=json | jq -e --arg path "${MOUNT_PATH}/" 'has($path)' >/dev/null; then
    vault_cmd secrets enable -path="${MOUNT_PATH}" kv-v2
  else
    echo "KV v2 already enabled at ${MOUNT_PATH}/"
  fi
fi

echo "==> Enumerating Doppler projects..."
mapfile -t PROJECTS < <(list_projects)

if [ "${#PROJECTS[@]}" -eq 0 ]; then
  if [ "${#PROJECT_FILTER[@]}" -gt 0 ]; then
    echo "ERROR: No matching Doppler projects found for: ${PROJECT_FILTER[*]}" >&2
  else
    echo "ERROR: No Doppler projects found in this workplace" >&2
  fi
  exit 1
fi

echo "Found ${#PROJECTS[@]} project(s): ${PROJECTS[*]}"
echo ""

for project in "${PROJECTS[@]}"; do
  echo "==> Project: ${project}"

  mapfile -t CONFIGS < <(list_configs "$project")
  if [ "${#CONFIGS[@]}" -eq 0 ]; then
    echo "    No configs found — skipping"
    continue
  fi

  for config in "${CONFIGS[@]}"; do
    secret_path="${MOUNT_PATH}/${project}/${config}"

    doppler secrets download --no-file --format json \
      --project "$project" --config "$config" \
      | jq 'with_entries(select(.key | startswith("DOPPLER_") | not))' > "$TMPFILE"

    key_count="$(jq 'length' "$TMPFILE")"

    if [ "$key_count" -eq 0 ]; then
      echo "    ${project}/${config}: skipped (no secrets after excluding DOPPLER_* keys)"
      CONFIGS_SKIPPED=$((CONFIGS_SKIPPED + 1))
      continue
    fi

    if [ "$DRY_RUN" = true ]; then
      echo "    ${secret_path}: would write ${key_count} key(s)"
    else
      echo "    ${secret_path}: writing ${key_count} key(s)..."
      vault_cmd kv put "${secret_path}" @"$TMPFILE"
    fi

    CONFIGS_MIGRATED=$((CONFIGS_MIGRATED + 1))
    TOTAL_KEYS=$((TOTAL_KEYS + key_count))
  done

  echo ""
done

echo "================================================================================"
if [ "$DRY_RUN" = true ]; then
  echo "Dry run complete — no secrets were written"
else
  echo "Migration complete"
fi
echo "================================================================================"
echo ""
echo "Configs migrated: ${CONFIGS_MIGRATED}"
echo "Configs skipped:  ${CONFIGS_SKIPPED}"
echo "Total keys:       ${TOTAL_KEYS}"
echo "OpenBao mount:    ${MOUNT_PATH}/"
echo ""

if [ "$DRY_RUN" = true ]; then
  echo "Re-run without --dry-run to write secrets to OpenBao."
else
  echo "Verify a secret:"
  echo "  vault kv get -format=json ${MOUNT_PATH}/<project>/<config>"
fi
