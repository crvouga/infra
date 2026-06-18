# Secret Store (OpenBao)

Production-ready [OpenBao](https://openbao.org/) deployment on Fly.io — Neon Postgres storage, Cloudflare DNS, and a single GitHub Actions deploy pipeline.

**URL:** https://vault.chrisvouga.dev

## Architecture

```
vault repo (push to main)
  └── deploy.yml
        ├── migrate Neon Postgres (secret_store schema)
        ├── build + push ghcr.io/crvouga/chrisvouga-vault
        ├── Fly deploy (crvouga-vault)
        ├── reconcile DNS (vault.chrisvouga.dev)
        └── unseal + smoke-test from crvouga.kv

OpenBao (Fly) ──storage──► Neon Postgres (secret_store schema)
Cloudflare DNS ──► vault.chrisvouga.dev ──► Fly TLS
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

Runtime secrets (`DB_CONNECTION_URI`) are synced to Fly via the deploy workflow.

### 2. Deploy via GitHub Actions

Push to `main` on this repo (or run **Deploy** manually). The workflow migrates the DB, builds the image, deploys to Fly, reconciles DNS, unseals OpenBao, and runs smoke tests.

Every container restart leaves OpenBao **sealed**; CI unseals automatically on each deploy.

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

The **Deploy** workflow runs migrations on every push to `main` (before build/deploy).

## Manual Unseal

After a restart or redeploy, OpenBao starts **sealed**. CI auto-unseals on every deploy from `crvouga.kv`. To re-unseal without redeploying:

```bash
gh workflow run deploy.yml -f unseal_only=true
```

To unseal manually from the CLI:

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

Smoke tests run at the end of the **Deploy** workflow after auto-unseal. The job reads `root_token` from `crvouga.kv` via [`scripts/fetch-vault-token.sh`](scripts/fetch-vault-token.sh).

## Syncing dev keys to prd

Use [`scripts/sync-dev-keys-to-prd.sh`](scripts/sync-dev-keys-to-prd.sh) to copy missing keys from `dev` to `prd` per project. Existing prd keys are never overwritten.

```bash
./scripts/vault-run.sh -- ./scripts/sync-dev-keys-to-prd.sh --dry-run
./scripts/vault-run.sh -- ./scripts/sync-dev-keys-to-prd.sh
```

## Resource migration

Operator scripts for moving B2 object storage and Postgres between Vault `dev` and `prd` configs. Default project is `personal`.

**Prerequisites:** [Vault CLI](https://openbao.org/docs/install/), `jq`, `curl`, [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) (B2 S3-compatible API), `psql`, `pg_dump`, `pg_restore`. For Neon/Postgres 18 hosts, install matching clients (`brew install postgresql@18`) — the clone script auto-selects `/opt/homebrew/opt/postgresql@18/bin` or falls back to Docker when local `pg_dump` is too old.

Suggested order:

1. Seed B2 secrets in Vault (manual or `--seed-vault-secrets` on the clone script)
2. Alias B2 → S3 keys in the same KV path
3. Verify object-storage credentials
4. Copy legacy bucket objects into dev/prd buckets
5. Verify Postgres `DATABASE_URL` health
6. Refresh dev database from prod (one-way)

| Script | Purpose |
|--------|---------|
| [`create-s3-secrets-from-b2.sh`](scripts/create-s3-secrets-from-b2.sh) | Copy `B2_*` fields to `S3_*` aliases (including `S3_ACCESS_KEY` / `S3_SECRET_KEY`) |
| [`check-object-storage-creds.sh`](scripts/check-object-storage-creds.sh) | Probe B2 and S3 bucket credentials for dev/prd |
| [`clone-b2-bucket-from-legacy.sh`](scripts/clone-b2-bucket-from-legacy.sh) | Full sync from `legacy-b2.json` source bucket into Vault dev/prd buckets |
| [`check-database-url-health.sh`](scripts/check-database-url-health.sh) | `SELECT 1` health check for `DATABASE_URL` in dev/prd |
| [`clone-prod-database-to-dev.sh`](scripts/clone-prod-database-to-dev.sh) | One-way `pg_dump` / `pg_restore` from prd → dev |

```bash
# Alias B2 secrets to S3 names (dry-run first)
make alias-s3-from-b2
./scripts/vault-run.sh -- ./scripts/create-s3-secrets-from-b2.sh

# Verify credentials and Postgres
make check-object-storage
make check-database-url

# Copy legacy B2 bucket objects (dry-run by default; --confirm to write)
make clone-b2-from-legacy
./scripts/vault-run.sh -- ./scripts/clone-b2-bucket-from-legacy.sh --confirm

# Clone prod database into dev (dry-run by default; --confirm to write)
make clone-prod-db-to-dev
./scripts/vault-run.sh -- ./scripts/clone-prod-database-to-dev.sh --schema gamezilla --confirm
```

Source credentials for the B2 bucket clone live in repo-root `legacy-b2.json` (gitignored). Target credentials are read from `secret/personal/dev` and `secret/personal/prd` using the same `B2_*` field names.

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
│   └── deploy.yml                 # migrate → build → Fly deploy → DNS → unseal → smoke
├── cli/                           # Global vault wrapper (vault run / vault setup)
├── config/openbao.hcl             # OpenBao server config
├── migrations/                    # SQL migrations (secret_store schema)
├── scripts/
│   ├── init.sh                    # First-time initialization
│   ├── migrate.sh                 # Apply database migrations
│   ├── unseal.sh                  # Auto-unseal from crvouga.kv (CI)
│   ├── seed-github-secrets.sh     # Auto-fetch + seed GitHub secrets
│   ├── smoke-test.sh              # End-to-end verification
│   ├── lib/vault-kv.sh            # Shared KV read/write helpers
│   ├── create-s3-secrets-from-b2.sh
│   ├── clone-b2-bucket-from-legacy.sh
│   ├── check-object-storage-creds.sh
│   ├── check-database-url-health.sh
│   └── clone-prod-database-to-dev.sh
├── docker-entrypoint.sh
└── Dockerfile
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Smoke test returns 503 | OpenBao is sealed — run manual unseal or `gh workflow run deploy.yml -f unseal_only=true` |
| DNS not resolving | Run `make sync-dns` (needs `CF_API_TOKEN`) or re-run **Deploy** workflow; flush local cache: `sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder` |
| DB connection errors | Verify `DB_CONNECTION_URI` in Vault / infra env sync |
| Migration job fails | Check `DB_CONNECTION_URI` GitHub secret; ensure Neon allows GitHub Actions IPs |
