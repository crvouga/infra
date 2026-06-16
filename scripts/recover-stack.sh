#!/usr/bin/env bash
# Start always-on services when Vault is down — uses only SSH + GHCR (no Vault API).
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/chrisvouga-dev}"
cd "${DEPLOY_DIR}"

bash scripts/ghcr-login.sh

echo "==> Pull vault image (always-on recovery)"
pull_vault() {
  if docker compose pull vault 2>/dev/null; then
    return 0
  fi
  local owner legacy image
  owner="$(awk '/^image_owner:/ { print $2; exit }' services.yaml)"
  image="$(docker compose config --images vault 2>/dev/null | head -1)"
  legacy="ghcr.io/${owner}/chrisvouga-vault:latest"
  if docker pull "${legacy}" 2>/dev/null; then
    docker tag "${legacy}" "${image}"
    echo "WARN: using legacy vault image ${legacy}" >&2
    return 0
  fi
  if [[ -n "${image}" ]] && docker image inspect "${image}" >/dev/null 2>&1; then
    echo "WARN: using cached vault image ${image}" >&2
    return 0
  fi
  return 1
}
pull_vault

bash scripts/start-stack.sh

echo "==> Recovery complete — run vault unseal workflow if vault was stopped"
