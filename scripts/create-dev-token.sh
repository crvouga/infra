#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
POLICY_FILE="${REPO_ROOT}/config/policies/dev-read.hcl"
POLICY_NAME="dev-read"
TOKEN_PERIOD="768h"
DISPLAY_NAME="local-dev"

# shellcheck source=../cli/lib/openbao-auth.sh
source "${REPO_ROOT}/cli/lib/openbao-auth.sh"

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Create a scoped read-only OpenBao token for local development (bao run).

Requires root token or a token with policy write + token create permissions.

Options:
  --period DURATION   Token TTL (default: 768h / 32 days)
  -h, --help          Show this help

After running:
  bao login <token>
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --period)
      TOKEN_PERIOD="$2"
      shift 2
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

if [ ! -f "$POLICY_FILE" ]; then
  echo "ERROR: Policy file not found: ${POLICY_FILE}" >&2
  exit 1
fi

require_cmd jq "Install jq: https://jqlang.github.io/jq/"

if ! export_bao_auth; then
  exit 1
fi

if ! resolve_bao_real_bin; then
  echo "ERROR: OpenBao CLI binary not found." >&2
  exit 1
fi

echo "==> Writing policy ${POLICY_NAME}..."
BAO_ADDR="$BAO_ADDR" BAO_TOKEN="$BAO_TOKEN" \
  "$BAO_REAL_BIN" policy write "$POLICY_NAME" "$POLICY_FILE"

echo "==> Creating token (period=${TOKEN_PERIOD}, policy=${POLICY_NAME})..."
TOKEN_JSON="$(
  BAO_ADDR="$BAO_ADDR" BAO_TOKEN="$BAO_TOKEN" \
    "$BAO_REAL_BIN" token create \
    -policy="$POLICY_NAME" \
    -period="$TOKEN_PERIOD" \
    -display-name="$DISPLAY_NAME" \
    -format=json
)"

DEV_TOKEN="$(echo "$TOKEN_JSON" | jq -r '.auth.client_token')"

echo ""
echo "================================================================================"
echo "Dev token created (read-only on doppler/*)"
echo "================================================================================"
echo ""
echo "Log in with:"
echo "  bao login ${DEV_TOKEN}"
echo ""
echo "Then in any project:"
echo "  bao setup --project myapp --config dev"
echo "  bao run -- bun myserver.tsx"
