#!/usr/bin/env bash
# Authenticate docker to ghcr.io for private package pulls on the origin node.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/chrisvouga-dev}"
cd "${DEPLOY_DIR}"

OWNER="$(awk '/^image_owner:/ { print $2; exit }' services.yaml)"
TOKEN="${GITHUB_TOKEN_SUPER:-${GHCR_TOKEN:-}}"

if [[ -z "${TOKEN}" ]]; then
  echo "WARN: GITHUB_TOKEN_SUPER not set — GHCR pulls may fail for private packages" >&2
  exit 0
fi

echo "==> Logging in to ghcr.io as ${OWNER}"
echo "${TOKEN}" | docker login ghcr.io -u "${OWNER}" --password-stdin
