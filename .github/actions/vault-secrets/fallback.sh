#!/usr/bin/env bash
# Export GitHub repository secrets to GITHUB_ENV when Vault OIDC is unavailable.
set -euo pipefail

# Names must match vault-secrets action exports and GitHub repo secret names.
FALLBACK_KEYS=(
  CLOUDFLARE_API_TOKEN
  CLOUDFLARE_ACCOUNT_ID
  TMDB_API_READ_ACCESS_TOKEN
  TWILIO_ACCOUNT_SID
  TWILIO_AUTH_TOKEN
  TWILIO_SERVICE_SID
  DIGITALOCEAN_TOKEN
  GITHUB_TOKEN_SUPER
  VAULT_TOKEN
  DATABASE_URL
  S3_ENDPOINT
  S3_ACCESS_KEY
  S3_SECRET_KEY
  S3_BUCKET
  S3_REGION
  OPENAI_API_KEY
  NORMALIZER_APP_GOOGLE_CLIENT_ID
  NORMALIZER_APP_GOOGLE_CLIENT_SECRET
  NETDATA_USERNAME
  NETDATA_PASSWORD
  DOZZLE_USERNAME
  DOZZLE_PASSWORD
  DOZZLE_EMAIL
  NODE_SSH_HOST
  NODE_SSH_USER
  NODE_SSH_KEY
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
  echo "Add NODE_SSH_* and GITHUB_TOKEN_SUPER to repo secrets, or restore vault.chrisvouga.dev."
  exit 1
fi

echo "Loaded ${loaded} secret(s) from GitHub repository secrets (Vault bypass)."
