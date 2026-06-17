# Secret Store (OpenBao)

Production-ready [OpenBao](https://openbao.org/) deployment on the [chrisvouga.dev](https://github.com/crvouga/chrisvouga.dev) single-node stack — Neon Postgres storage, Traefik routing, and automated GitHub Actions.

**URL:** https://vault.chrisvouga.dev

## Architecture

```
vault repo (push to main)
  ├── publish-image.yml  → ghcr.io/crvouga/chrisvouga-vault
  └── migrate-db.yml     → Neon Postgres (secret_store schema)

infra deploy-pipeline
  ├── deploy vault container on origin droplet
  └── vault-unseal job → triggers unseal.yml in this repo

unseal.yml (this repo)
  ├── unseal OpenBao from crvouga.kv
  └── smoke-test KV round-trip

OpenBao (Docker) ──storage──► Neon Postgres (secret_store schema)
Traefik ──► vault.chrisvouga.dev
crvouga.kv ──unseal keys + root_token──► CI unseal + smoke-test
```

## Database schema

All database objects live in the **`secret_store`** schema — never `public`:

| Table | Purpose |
|-------|---------|
| `secret_store.vault_kv_store` | OpenBao storage backend |
| `secret_store.vault_ha_locks` | OpenBao HA locks (reserved for future use) |
| `secret_store.schema_migrations` | Applied migration tracking |

OpenBao is configured with `skip_create_table = true` so it never auto-creates tables in `public`. The entrypoint sets `search_path=secret_store` on the Postgres connection so all OpenBao queries resolve to the custom schema.

## Prerequisites

- [GitHub CLI (`gh`)](https://cli.github.com/) — `gh auth login`
- [Neon CLI (`neonctl`)](https://neon.com/docs/reference/cli-install) — `neonctl auth`
- **Cloudflare API token** — [create manually](https://dash.cloudflare.com/profile/api-tokens) with **Zone:DNS:Edit** for `chrisvouga.dev`
- [Vault CLI (`vault`)](https://openbao.org/docs/install/) — OpenBao-compatible; used for init, smoke tests, and local dev
- [PostgreSQL client (`psql`)](https://www.postgresql.org/download/) — for migrations
- [`jq`](https://jqlang.github.io/jq/) — for init and seed scripts

## First-Time Setup

### 1. Seed GitHub secrets

Log in to each provider, then run the seed script. It auto-fetches secrets from your CLI sessions and pushes them to GitHub Actions:

```bash
gh auth login
neonctl auth          # npm i -g neonctl  (or: npx neonctl auth)

# Cloudflare: create Zone:DNS:Edit token at https://dash.cloudflare.com/profile/api-tokens
export CLOUDFLARE_API_TOKEN='your-token'

chmod +x scripts/seed-github-secrets.sh
./scripts/seed-github-secrets.sh
```

| Secret | Required | Source |
|--------|----------|--------|
| `CF_API_TOKEN` | Yes | `CLOUDFLARE_API_TOKEN` — dashboard API token |
| `DB_CONNECTION_URI` | Yes | `neon connection-string` |
| `VAULT_TOKEN` | Optional | `init-output.json` — CI reads `root_token` from `crvouga.kv` instead |

Flags:

- `--skip-vault` — do not fetch or set `VAULT_TOKEN`

Optional overrides via [`.env`](.env) or [`.env.secrets`](.env.secrets.example). Set `NEON_PROJECT_ID` if you have multiple Neon projects.

Runtime secrets (`DB_CONNECTION_URI`, `BAO_API_ADDR`) are synced to the node via infra `services.yaml` and Vault.

### 2. Deploy via GitHub Actions

Push to `main` on this repo (or run **Publish image**). Infra deploy-pipeline pulls the image and starts the container. After deploy, infra triggers **Unseal** in this repo.

Every container restart leaves OpenBao **sealed**; CI unseals automatically.

### 3. Initialize OpenBao (one-time, local)

After the first deploy succeeds, run init locally:

```bash
export DB_CONNECTION_URI="postgres://..."
export VAULT_ADDR="https://vault.chrisvouga.dev"

chmod +x scripts/init.sh scripts/migrate.sh
./scripts/init.sh
```

This script will:

1. Run database migrations (`scripts/migrate.sh`)
2. Wait for OpenBao to become reachable
3. Initialize OpenBao (5 unseal keys, threshold 3)
4. Save credentials to `init-output.json` (gitignored)
5. Unseal OpenBao with 3 keys

**Save the unseal keys and root token from the output immediately.**

Store unseal keys and `root_token` in `crvouga.kv` so CI can auto-unseal and smoke-test.

## **WARNING: Back Up Unseal Keys and Root Token**

**Losing your unseal keys or root token means losing access to ALL secrets permanently.** Store them offline in a password manager or secure physical backup. Never commit them to git.

## Database migrations

Migrations live in [`migrations/`](migrations/) and are applied by [`scripts/migrate.sh`](scripts/migrate.sh):

```bash
export DB_CONNECTION_URI="postgres://..."
./scripts/migrate.sh
```

The **Migrate DB** workflow runs migrations on push when migration files change.

## Manual Unseal

After a restart or redeploy, OpenBao starts **sealed**. CI auto-unseals on every deploy from `crvouga.kv`. To unseal manually:

```bash
export VAULT_ADDR="https://vault.chrisvouga.dev"

vault operator unseal   # enter unseal key 1
vault operator unseal   # enter unseal key 2
vault operator unseal   # enter unseal key 3

vault status            # should show Sealed: false
```

## Smoke Tests

### Locally

```bash
chmod +x scripts/smoke-test.sh
./scripts/smoke-test.sh
```

### In CI

Smoke tests run in **Unseal** workflow after auto-unseal. The job reads `root_token` from `crvouga.kv` via [`scripts/fetch-vault-token.sh`](scripts/fetch-vault-token.sh).

## Syncing dev keys to prd

Use [`scripts/sync-dev-keys-to-prd.sh`](scripts/sync-dev-keys-to-prd.sh) to copy missing keys from `dev` to `prd` per project. Existing prd keys are never overwritten.

```bash
./scripts/vault-run.sh -- ./scripts/sync-dev-keys-to-prd.sh --dry-run
./scripts/vault-run.sh -- ./scripts/sync-dev-keys-to-prd.sh
```

## Using secrets locally

Install the global `vault` wrapper once, then use `vault run` in any project:

```bash
chmod +x scripts/install-cli.sh
./scripts/install-cli.sh
vault login hvs.your-root-token

cd ~/my-app
vault setup --project myapp --config dev
vault run -- bun myserver.tsx
```

## Health Checks

Container health checks hit:

```
GET /v1/sys/health?standbyok=true&sealedcode=200&uninitcode=200
```

Returns HTTP 200 even when sealed or uninitialized, so the process stays healthy while waiting for init/unseal.

## Repository Structure

```
vault/
├── .github/workflows/
│   ├── publish-image.yml          # Build + push image → infra deploy
│   ├── deploy.yml                 # Neon DB migrations
│   └── unseal.yml                 # Auto-unseal + smoke-test
├── cli/                           # Global vault wrapper (vault run / vault setup)
├── config/openbao.hcl             # OpenBao server config
├── migrations/                    # SQL migrations (secret_store schema)
├── scripts/
│   ├── init.sh                    # First-time initialization
│   ├── migrate.sh                 # Apply database migrations
│   ├── unseal.sh                  # Auto-unseal from crvouga.kv (CI)
│   ├── seed-github-secrets.sh     # Auto-fetch + seed GitHub secrets
│   └── smoke-test.sh              # End-to-end verification
├── docker-entrypoint.sh
└── Dockerfile
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Smoke test returns 503 | OpenBao is sealed — run manual unseal or re-run **Unseal** workflow |
| DNS not resolving | Run `make sync-dns` (needs `CF_API_TOKEN`) or re-run **Fly deploy** / **DNS sync** workflow; flush local cache: `sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder` |
| DB connection errors | Verify `DB_CONNECTION_URI` in Vault / infra env sync |
| Migration job fails | Check `DB_CONNECTION_URI` GitHub secret; ensure Neon allows GitHub Actions IPs |
