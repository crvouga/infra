# Secret Store (OpenBao on Fly.io)

Production-ready [OpenBao](https://openbao.org/) deployment on Fly.io with Neon Postgres storage, Cloudflare DNS, and manual GitHub Actions workflows.

**URL:** https://secret-store.chrisvouga.dev

## Architecture

```
GitHub Actions (manual: Actions → Deploy → Run workflow)
  ├── provision-dns   → Cloudflare CNAME
  ├── migrate-db      → Neon Postgres (secret_store schema)
  ├── deploy          → Fly.io (OpenBao container)
  └── issue-tls       → Fly.io certificate

GitHub Actions (manual: Actions → Smoke Test → Run workflow, after unsealing)
  └── smoke-test      → KV round-trip verification

OpenBao (Fly.io) ──storage──► Neon Postgres (secret_store schema)
Cloudflare DNS ──CNAME──► secret-store-chrisvouga.fly.dev
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
- [flyctl](https://fly.io/docs/hands-on/install-flyctl/) — `fly auth login`
- [Neon CLI (`neonctl`)](https://neon.com/docs/reference/cli-install) — `neonctl auth`
- **Cloudflare API token** — [create manually](https://dash.cloudflare.com/profile/api-tokens) with **Zone:DNS:Edit** for `chrisvouga.dev` (Wrangler OAuth cannot be used for DNS API)
- [Vault CLI (`vault`)](https://openbao.org/docs/install/) — OpenBao-compatible; used for init, smoke tests, and local dev
- [PostgreSQL client (`psql`)](https://www.postgresql.org/download/) — for migrations
- [`jq`](https://jqlang.github.io/jq/) — for init and seed scripts

## First-Time Setup

### 1. Create the Fly app (one-time, local)

```bash
fly apps create secret-store-chrisvouga
```

### 2. Seed secrets

Log in to each provider, then run the seed script. It auto-fetches secrets from your CLI sessions and pushes them to GitHub Actions (and Fly):

```bash
gh auth login
fly auth login
neonctl auth          # npm i -g neonctl  (or: npx neonctl auth)

# Cloudflare: create Zone:DNS:Edit token at https://dash.cloudflare.com/profile/api-tokens
# Add to .env (see .env.secrets.example) or export:
export CLOUDFLARE_API_TOKEN='your-token'

chmod +x scripts/seed-github-secrets.sh
./scripts/seed-github-secrets.sh
```

| Secret | Required | Source |
|--------|----------|--------|
| `FLY_API_TOKEN` | Yes | `fly tokens create deploy` (or session token) |
| `CF_API_TOKEN` | Yes | `CLOUDFLARE_API_TOKEN` — dashboard API token (not Wrangler) |
| `DB_CONNECTION_URI` | Yes | `neon connection-string` |
| `VAULT_TOKEN` | After init | `init-output.json` (after `./scripts/init.sh`) |

Flags:

- `--skip-fly` — only seed GitHub (if the Fly app is not created yet)
- `--skip-vault` — do not fetch or set `VAULT_TOKEN`

Optional overrides via [`.env`](.env) or [`.env.secrets`](.env.secrets.example) (`.env.secrets` takes precedence). Set `NEON_PROJECT_ID` if you have multiple Neon projects (or run `neon set-context` first).

Re-run after `init.sh` to pick up `VAULT_TOKEN` from `init-output.json` for CI smoke tests.

The workflow derives everything else automatically:

- **Cloudflare zone** — looked up from `CUSTOM_DOMAIN` (`secret-store.chrisvouga.dev` → zone `chrisvouga.dev`)
- **Fly hostname** — derived from `FLY_APP` (`secret-store-chrisvouga.fly.dev`)

### 3. Deploy via GitHub Actions

In GitHub: **Actions → Deploy → Run workflow**. The workflow will:

1. Create the Cloudflare CNAME (`secret-store.chrisvouga.dev` → `secret-store-chrisvouga.fly.dev`, not proxied)
2. Run database migrations against Neon (`secret_store` schema)
3. Deploy OpenBao to Fly.io
4. Issue a TLS certificate for the custom domain

Deploy is **not** triggered on push to `main` — run it manually when you want to release. Every deploy restarts OpenBao in a **sealed** state; unseal manually after deploy (see below).

### 4. Initialize OpenBao (one-time, local)

After the first deploy succeeds, run init locally:

```bash
export DB_CONNECTION_URI="postgres://..."
export VAULT_ADDR="https://secret-store.chrisvouga.dev"

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

Then re-run the seed script to push `VAULT_TOKEN` to GitHub:

```bash
./scripts/seed-github-secrets.sh
```

Re-run the **Smoke Test** workflow (Actions → Smoke Test → Run workflow) after unsealing to verify the deployment.

## **WARNING: Back Up Unseal Keys and Root Token**

**Losing your unseal keys or root token means losing access to ALL secrets permanently.** There is no recovery without the unseal keys. Store them offline in a password manager or secure physical backup. Never commit them to git.

## Database migrations

Migrations live in [`migrations/`](migrations/) and are applied by [`scripts/migrate.sh`](scripts/migrate.sh):

```bash
export DB_CONNECTION_URI="postgres://..."
./scripts/migrate.sh
```

The script is idempotent — already-applied migrations are tracked in `secret_store.schema_migrations` and skipped. The Deploy workflow runs migrations before each deploy.

To add a new migration, create `migrations/003_description.sql` using fully qualified `secret_store.*` table names.

## Manual Unseal

After a machine restart or redeploy, OpenBao starts **sealed**. Unseal manually after each deploy:

```bash
export VAULT_ADDR="https://secret-store.chrisvouga.dev"

vault operator unseal   # enter unseal key 1
vault operator unseal   # enter unseal key 2
vault operator unseal   # enter unseal key 3

vault status            # should show Sealed: false
```

You need 3 of the 5 unseal keys each time.

[`scripts/unseal.sh`](scripts/unseal.sh) can auto-unseal from keys stored in `crvouga.kv` if you configure that separately; it is not run by the Deploy workflow.

## Smoke Tests

### Locally

```bash
chmod +x scripts/smoke-test.sh
./scripts/smoke-test.sh
```

Auth is resolved automatically from `VAULT_TOKEN`, `vault login`, `~/.vault-token`, or `init-output.json`. Or use:

```bash
./scripts/vault-run.sh -- ./scripts/smoke-test.sh
```

### In CI

Run **Actions → Smoke Test → Run workflow** after deploying and unsealing OpenBao. Requires `VAULT_TOKEN` in GitHub secrets (set via `./scripts/seed-github-secrets.sh` after init). If the secret is not set yet, the job skips with a message.

## Migrating from Doppler

Use [`scripts/migrate-doppler-to-openbao.sh`](scripts/migrate-doppler-to-openbao.sh) to copy secrets from Doppler into OpenBao. The script is read-only against Doppler and writes to OpenBao only.

**Mapping:** each Doppler project/config (e.g. `myapp` / `prd`) becomes one KV v2 secret at `doppler/<project>/<config>`. Each Doppler key becomes a field on that secret. Reserved `DOPPLER_*` keys are excluded.

**Prerequisites:**

- [Doppler CLI](https://docs.doppler.com/docs/install-cli) authenticated (`doppler login`) with workplace-wide read access
- OpenBao initialized and unsealed
- Vault auth via `vault login`, `VAULT_TOKEN`, or `init-output.json` (see [`scripts/vault-run.sh`](scripts/vault-run.sh))

```bash
export VAULT_ADDR="https://secret-store.chrisvouga.dev"

chmod +x scripts/vault-run.sh scripts/migrate-doppler-to-openbao.sh

# Preview what would be migrated
./scripts/vault-run.sh -- ./scripts/migrate-doppler-to-openbao.sh --dry-run

# Migrate all projects and configs
./scripts/vault-run.sh -- ./scripts/migrate-doppler-to-openbao.sh

# Limit to specific projects or use a custom mount
./scripts/vault-run.sh -- ./scripts/migrate-doppler-to-openbao.sh --project myapp --mount doppler
```

| Flag | Purpose |
|------|---------|
| `--dry-run` | List paths and key counts without writing |
| `--mount PATH` | KV v2 mount (default: `doppler`) |
| `--project NAME` | Limit to specific Doppler projects (repeatable) |

Re-running the script is safe — KV v2 creates a new version for each write. Verify a migrated secret:

```bash
vault kv get -format=json doppler/myapp/prd
```

## Using secrets locally (Doppler-style)

Install the global `vault` wrapper once, then use `vault run` in any project to inject secrets as environment variables.

| Doppler | This setup |
|---------|------------|
| `doppler login` | `vault login hvs.xxx` |
| `doppler setup` | `vault setup --project X --config Y` |
| `doppler run -- npm start` | `vault run -- npm start` |
| `doppler.yaml` | `.vault.yaml` |

### 1. Install the CLI wrapper

Requires [Vault or OpenBao CLI](https://openbao.org/docs/install/) and [`jq`](https://jqlang.github.io/jq/) installed separately.

```bash
chmod +x scripts/install-cli.sh
./scripts/install-cli.sh
```

This installs a wrapper to `~/.local/bin/vault` that adds `run` and `setup` subcommands. All other commands pass through to the real Vault/OpenBao binary.

If you already had `vault` on PATH, the installer renames it to `vault-real`.

### 2. Authenticate

```bash
# Root token (full access)
vault login hvs.your-root-token

# Or create a scoped read-only dev token (recommended for daily use)
./scripts/create-dev-token.sh
vault login hvs.dev-token...
```

### 3. Configure a project

In any app repo:

```bash
cd ~/my-app
vault setup --project myapp --config dev
```

This writes [`.vault.yaml`](.vault.yaml.example) (like Doppler's `doppler.yaml`):

```yaml
addr: https://secret-store.chrisvouga.dev
mount: doppler
project: myapp
config: dev
```

### 4. Run commands with secrets injected

```bash
vault run -- bun myserver.tsx
vault run --dry-run -- npm test    # preview env var names only
vault run --project myapp --config prd -- npm start   # override .vault.yaml
```

Secrets are read from `doppler/<project>/<config>` (KV v2). Each field becomes an environment variable.

## Fly Secrets

| Secret | Purpose |
|--------|---------|
| `DB_CONNECTION_URI` | Neon Postgres connection string for OpenBao storage backend |

```bash
fly secrets set DB_CONNECTION_URI="postgres://..." --app secret-store-chrisvouga
```

Fly also sets `FLY_APP_NAME` automatically, which the entrypoint uses to configure `BAO_API_ADDR`. The entrypoint appends `search_path=secret_store` to the connection URL at runtime.

## Health Checks

Fly.io health checks hit:

```
GET /v1/sys/health?standbyok=true&sealedcode=200&uninitcode=200
```

This returns HTTP 200 even when OpenBao is sealed or uninitialized, so the process is considered healthy while waiting for manual init/unseal.

## Repository Structure

```
secret-store/
├── .github/workflows/
│   ├── deploy.yml                 # Manual deploy pipeline
│   └── smoke-test.yml             # Manual smoke test (run after unseal)
├── cli/                           # Global vault wrapper (vault run / vault setup)
│   ├── bin/vault
│   └── lib/
├── config/
│   ├── openbao.hcl                # OpenBao server config
│   └── policies/dev-read.hcl      # Scoped read policy for local dev
├── migrations/                    # SQL migrations (secret_store schema)
├── scripts/
│   ├── init.sh                         # First-time initialization
│   ├── migrate.sh                      # Apply database migrations
│   ├── install-cli.sh                  # Install global vault wrapper
│   ├── create-dev-token.sh             # Create scoped local-dev token
│   ├── unseal.sh                       # Optional auto-unseal from crvouga.kv
│   ├── vault-run.sh                    # Run a command with Vault API credentials
│   ├── migrate-doppler-to-openbao.sh   # Copy secrets from Doppler to OpenBao
│   ├── seed-github-secrets.sh          # Auto-fetch + seed GitHub/Fly secrets
│   └── smoke-test.sh                   # End-to-end verification
├── .vault.yaml.example            # Per-project config template
├── docker-entrypoint.sh           # Maps env vars + search_path for OpenBao
├── Dockerfile
├── fly.toml
└── README.md
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Health check fails | Check Fly logs: `fly logs --app secret-store-chrisvouga` |
| Smoke test returns 503 | OpenBao is sealed — run manual unseal |
| DNS not resolving | Verify Cloudflare CNAME points to `secret-store-chrisvouga.fly.dev` (proxied: off) |
| TLS certificate pending | Wait for DNS propagation; check with `fly certs check secret-store.chrisvouga.dev` |
| DB connection errors | Verify `DB_CONNECTION_URI` Fly secret matches Neon connection string |
| Migration job fails | Check `DB_CONNECTION_URI` GitHub secret; ensure Neon allows connections from GitHub Actions IPs |
| Empty OpenBao after schema change | If data existed in `public.vault_kv_store`, migrate manually: `INSERT INTO secret_store.vault_kv_store SELECT * FROM public.vault_kv_store;` |
