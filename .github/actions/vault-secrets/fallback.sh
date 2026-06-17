#!/usr/bin/env bash
# Export GitHub repository secrets to GITHUB_ENV when Vault OIDC is unavailable.
set -euo pipefail

FALLBACK_KEYS=(
  TURBO_TOKEN
  TURBO_API
  TURBO_TEAM
  TURBO_CACHE
  B2_S3_ENDPOINT
  B2_S3_REGION
  B2_S3_ACCESS_KEY_ID
  B2_S3_SECRET_ACCESS_KEY
  B2_BUCKET
  VAULT_TOKEN
)

loaded=0
for key in "${FALLBACK_KEYS[@]}"; do
  val="${!key:-}"
  if [[ -n "${val}" ]]; then
    {
      echo "${key}<<EOF"
      echo "${val}"
      echo "EOF"
    } >> "${GITHUB_ENV}"
    echo "  fallback ${key}"
    loaded=$((loaded + 1))
  fi
done

if [[ "${loaded}" -eq 0 ]]; then
  echo "::error::Vault is unavailable and no GitHub repository secrets were provided for fallback."
  echo "Restore vault.chrisvouga.dev DNS or add required secrets to this repository."
  exit 1
fi

echo "Loaded ${loaded} secret(s) from GitHub repository secrets (Vault bypass)."
