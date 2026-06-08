#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=../cli/lib/openbao-auth.sh
source "${REPO_ROOT}/cli/lib/openbao-auth.sh"

usage() {
  cat <<EOF
Usage: $(basename "$0") -- <command> [args...]

Run a command with OpenBao credentials exported to the environment.

Resolves credentials in order:
  1. BAO_TOKEN (or VAULT_TOKEN) already in the environment
  2. Token from \`bao login\` session (\`bao print token\`)
  3. ~/.vault-token
  4. Root token from init-output.json (after ./scripts/init.sh)

Environment:
  BAO_ADDR   OpenBao API address (default: https://secret-store.chrisvouga.dev)

Examples:
  $(basename "$0") -- ./scripts/migrate-doppler-to-openbao.sh --dry-run
  $(basename "$0") -- ./scripts/smoke-test.sh
EOF
}

if [ "${1:-}" = "--" ]; then
  shift
fi

if [ $# -eq 0 ] || [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit "$([ $# -eq 0 ] && echo 1 || echo 0)"
fi

if ! export_bao_auth; then
  exit 1
fi

exec "$@"
