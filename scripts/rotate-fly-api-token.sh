#!/usr/bin/env bash
set -euo pipefail

# Generates a new scoped Fly.io deploy token for the app defined in fly.toml
# and writes it to the GitHub Actions secret FLY_API_TOKEN.
#
# Fixes: "invalid token: missing third-party discharge token" errors in CI
# caused by expired or personal-user tokens.
#
# Usage:
#   ./scripts/rotate-fly-api-token.sh
#   ./scripts/rotate-fly-api-token.sh --expiry 8760h   # 1 year

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FLY_TOML="${REPO_ROOT}/fly.toml"
SECRET_NAME="FLY_API_TOKEN"
DEFAULT_EXPIRY="999999h"

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Generate a new scoped Fly.io deploy token and push it to GitHub Actions
secret ${SECRET_NAME}. Fixes "missing third-party discharge token" CI errors.

Options:
  --expiry DURATION   Token expiry passed to flyctl (default: ${DEFAULT_EXPIRY})
  -h, --help          Show this help

Prerequisites:
  flyctl    https://fly.io/docs/hands-on/install-flyctl/  — must be logged in (flyctl auth login)
  gh        https://cli.github.com/                       — must be logged in (gh auth login)
EOF
}

EXPIRY="$DEFAULT_EXPIRY"

while [ $# -gt 0 ]; do
  case "$1" in
    --expiry)
      EXPIRY="$2"
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

require_cmd() {
  local cmd="$1"
  local hint="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: ${cmd} is required. ${hint}" >&2
    exit 1
  fi
}

require_cmd flyctl "Install: https://fly.io/docs/hands-on/install-flyctl/"
require_cmd gh     "Install: https://cli.github.com/"
require_cmd jq     "Install: https://jqlang.github.io/jq/"

# --- Verify flyctl auth ---
if ! flyctl auth whoami >/dev/null 2>&1; then
  echo "ERROR: flyctl is not authenticated. Run: flyctl auth login" >&2
  exit 1
fi

# --- Verify gh auth ---
if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

# --- Resolve app name from fly.toml ---
if [ ! -f "$FLY_TOML" ]; then
  echo "ERROR: fly.toml not found at ${FLY_TOML}" >&2
  exit 1
fi

APP_NAME="$(grep -E '^app[[:space:]]*=' "$FLY_TOML" | head -1 | sed -E 's/^app[[:space:]]*=[[:space:]]*"?([^"]+)"?[[:space:]]*$/\1/')"
if [ -z "$APP_NAME" ]; then
  echo "ERROR: Could not parse app name from ${FLY_TOML}" >&2
  exit 1
fi

# --- Resolve GitHub repo ---
GITHUB_REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
if [ -z "$GITHUB_REPO" ]; then
  echo "ERROR: Could not detect GitHub repo. Run from a linked git repository." >&2
  exit 1
fi

echo "==> Fly app:           ${APP_NAME}"
echo "==> GitHub repository: ${GITHUB_REPO}"
echo "==> Token expiry:      ${EXPIRY}"
echo ""

# --- Generate deploy token ---
echo "==> Generating new deploy token via flyctl..."
NEW_TOKEN="$(flyctl tokens create deploy \
  --app "$APP_NAME" \
  --expiry "$EXPIRY" \
  --config "$FLY_TOML" \
  --json 2>/dev/null \
  | jq -r '.token // empty')"

# flyctl may print the token directly (non-JSON) depending on version
if [ -z "$NEW_TOKEN" ]; then
  echo "==> Retrying without --json flag (older flyctl)..."
  NEW_TOKEN="$(flyctl tokens create deploy \
    --app "$APP_NAME" \
    --expiry "$EXPIRY" \
    --config "$FLY_TOML" 2>/dev/null)"
fi

# Trim leading/trailing whitespace only — FlyV1 tokens contain an internal space.
NEW_TOKEN="$(printf '%s' "$NEW_TOKEN" | sed -E 's/^[[:space:]]+//;s/[[:space:]]+$//')"

if [ -z "$NEW_TOKEN" ]; then
  echo "ERROR: flyctl returned an empty token." >&2
  exit 1
fi

# Sanity-check: Fly deploy tokens start with "FlyV1 "
if [[ "$NEW_TOKEN" != FlyV1* ]] && [[ "$NEW_TOKEN" != fm2_* ]]; then
  echo "WARNING: Token does not start with expected prefix (FlyV1 / fm2_)." >&2
  echo "         Proceeding, but double-check flyctl output above." >&2
fi

# --- Push to GitHub Actions secrets ---
echo "==> Setting GitHub Actions secret ${SECRET_NAME} on ${GITHUB_REPO}..."
gh secret set "$SECRET_NAME" --body "$NEW_TOKEN" --repo "$GITHUB_REPO"

echo ""
echo "================================================================================"
echo "FLY_API_TOKEN rotated successfully"
echo "================================================================================"
echo ""
echo "  Fly app:    ${APP_NAME}"
echo "  Expiry:     ${EXPIRY}"
echo "  GitHub:     ${GITHUB_REPO} → secret/${SECRET_NAME}"
echo ""
echo "Re-run your failed workflow:"
echo "  gh workflow run fly-deploy.yml --repo ${GITHUB_REPO}"
