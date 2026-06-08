#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CLI_SRC="${REPO_ROOT}/cli"
INSTALL_ROOT="${SECRET_STORE_INSTALL_ROOT:-${HOME}/.local/share/secret-store}"
INSTALL_CLI="${INSTALL_ROOT}/cli"
INSTALL_BIN="${HOME}/.local/bin"
WRAPPER_MARKER="secret-store-bao-wrapper"

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Install the secret-store bao CLI wrapper globally.

The wrapper adds Doppler-style commands:
  bao run -- <command>     Inject secrets from OpenBao as env vars
  bao setup                Write .bao.yaml in your project

All other bao subcommands pass through to the real OpenBao binary.

Options:
  --prefix PATH   Install root (default: ~/.local/share/secret-store)
  -h, --help      Show this help

Requires:
  OpenBao CLI (openbao) installed separately: https://openbao.org/docs/install/
  ~/.local/bin on your PATH
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)
      INSTALL_ROOT="$2"
      INSTALL_CLI="${INSTALL_ROOT}/cli"
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

if [ ! -d "${CLI_SRC}/bin" ] || [ ! -d "${CLI_SRC}/lib" ]; then
  echo "ERROR: cli/ directory not found at ${CLI_SRC}" >&2
  exit 1
fi

mkdir -p "$INSTALL_CLI" "$INSTALL_BIN"

echo "==> Installing CLI library to ${INSTALL_CLI}..."
rm -rf "${INSTALL_CLI:?}/"*
cp -R "${CLI_SRC}/bin" "${CLI_SRC}/lib" "$INSTALL_CLI/"

echo "==> Installing wrapper to ${INSTALL_BIN}/bao..."
existing_bao="${INSTALL_BIN}/bao"
if [ -f "$existing_bao" ] && ! grep -q "$WRAPPER_MARKER" "$existing_bao" 2>/dev/null; then
  if [ ! -f "${INSTALL_BIN}/openbao" ]; then
    echo "==> Preserving existing bao as ${INSTALL_BIN}/openbao"
    mv "$existing_bao" "${INSTALL_BIN}/openbao"
  else
    echo "WARNING: ${INSTALL_BIN}/openbao already exists — leaving existing bao in place." >&2
    echo "         Set BAO_REAL_BIN if the wrapper cannot find OpenBao." >&2
  fi
fi

cp "${CLI_SRC}/bin/bao" "${INSTALL_BIN}/bao"
chmod +x "${INSTALL_BIN}/bao" "${INSTALL_CLI}/bin/bao"

if ! command -v openbao >/dev/null 2>&1 \
  && ! command -v bao-real >/dev/null 2>&1 \
  && [ ! -x "${INSTALL_BIN}/openbao" ]; then
  echo ""
  echo "WARNING: OpenBao binary not found on PATH." >&2
  echo "         Install OpenBao before using bao run:" >&2
  echo "         https://openbao.org/docs/install/" >&2
fi

case ":${PATH}:" in
  *":${INSTALL_BIN}:"*) ;;
  *)
    echo ""
    echo "NOTE: ${INSTALL_BIN} is not on your PATH."
    echo "      Add to ~/.zshrc or ~/.bashrc:"
    echo "        export PATH=\"\${HOME}/.local/bin:\${PATH}\""
    ;;
esac

echo ""
echo "================================================================================"
echo "Installed successfully"
echo "================================================================================"
echo ""
echo "Next steps:"
echo "  1. bao login hvs.your-root-token"
echo "     (or: ./scripts/create-dev-token.sh  for a scoped read token)"
echo ""
echo "  2. cd ~/your-app"
echo "     bao setup --project myapp --config dev"
echo ""
echo "  3. bao run -- bun myserver.tsx"
echo ""
echo "Verify:"
echo "  bao run --help"
echo "  bao kv list doppler/"
