# Infra (Fly.io)

Fly.io deployment for all services on the zone defined in [`services.yaml`](services.yaml) (`zone: chrisvouga.dev`).

Each project repo builds and pushes its own public image to `ghcr.io/<image_owner>/<zone-slug>-<id>` (e.g. `ghcr.io/crvouga/chrisvouga-portfolio`). This repo **only consumes those images** — GitHub Actions syncs DNS/secrets, deploys to Fly, and health-checks.

Cloudflare terminates TLS at the edge (proxied DNS, Full strict). Fly apps run in region `iad`.

Platform paths, app names, and GHCR prefixes are derived from `services.yaml` — not hardcoded in scripts.

**Scale to zero (default):** most services stop when idle and wake on first HTTP request. Run `bun run scale-to-zero` to stop any machines that are still running.

**Always on (`fly.min_machines: 1`):** `vault` only (in the separate `vault` repo).

## Architecture

```
Project repos ──▶ ghcr.io (public images)
                        │
                        ▼
              Infra CI (GitHub Actions)
                        │
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
       dns-sync    fly-secrets    deploy-fly
          │             │             │
          └─────────────┼─────────────┘
                        ▼
              Fly.io (iad) crvouga-*
                        │
                        ▼
                 *.<zone> via Cloudflare CNAME
```

## Configuration ([`services.yaml`](services.yaml))

| Field | Purpose |
|-------|---------|
| `zone` | Primary DNS zone (e.g. `chrisvouga.dev`) |
| `image_owner` | GHCR org/user |
| `infra_github_repo` | GitHub repo slug for this infra repo |
| `fly.org` | Fly.io org slug |
| `fly.app_prefix` | App name prefix (e.g. `crvouga` → `crvouga-vault`) |
| `fly.region` | Fly region (default `iad`) |
| `fly.min_machines` | Per service: `0` (scale to zero) or `1` (always on) |

Derived automatically: `image_prefix` (`chrisvouga-dev`), Vault URL (`https://vault.<zone>`).

Inspect derived values:

```bash
bun run scripts/print-platform-env.ts
```

## First deploy

### 1. Create Fly org (first time only)

```bash
fly orgs create crvouga   # skip if fly orgs list already shows crvouga
```

### 2. Add Vault secrets

In `secret/data/personal/prd` on Vault (`https://vault.<zone>`):

| Key | Purpose |
|-----|---------|
| `FLY_TOKEN` | Fly.io deploy token (`fly tokens create deploy`) |
| `GITHUB_TOKEN_SUPER` | PAT with `repo` + `admin:org` — triggers workflows, cross-repo dispatch |
| `CLOUDFLARE_API_TOKEN` | DNS sync |
| `CLOUDFLARE_ACCOUNT_ID` | DNS sync |
| Per-app keys | See `secrets:` blocks in `services.yaml` |

### 3. Mint Fly token (no Vault required)

When Vault is down (e.g. post-DO cutover, pre-Fly vault deploy):

```bash
bun run seed-fly-token --mint
```

Writes `.fly-token` (gitignored). Local scripts (`deploy-fly`, `sync-fly-secrets`) read it automatically.

Push to CI without Vault:

```bash
gh secret set FLY_TOKEN --repo crvouga/infra --body "$(cat .fly-token)"
```

After vault is healthy, sync cache → Vault:

```bash
bun run seed-fly-token --vault
```

Uses `fly tokens create org` (org-wide). Per-app `fly tokens create deploy` needs `-a <app>`.

### 4. Run Deploy Pipeline

Actions → **Deploy Pipeline** → Run workflow (or push to `main`).

On first run, `deploy-fly.ts` creates Fly apps, adds certs, and deploys from GHCR.

### 5. Verify

```bash
fly apps list
fly status -a crvouga-vault
```

Health-check in CI verifies always-on public services (`vault`). Scale-to-zero apps cold-start on first request.

## Per-service deploy

Sibling repos dispatch `deploy-service` with `{ id, image_tag }` after publishing to GHCR. Infra deploys a single Fly app.

Manual single-service deploy:

```bash
gh workflow run deploy-pipeline.yml -f service_id=portfolio -f image_tag=abc123
```

## Local scripts

```bash
bun install
bun run typecheck
bun run generate-fly          # regenerate fly/*/fly.toml
bun run generate-fly --check  # CI drift check
```

## DNS

`sync-dns` creates CNAME records: `hostname` → `crvouga-{id}.fly.dev` (proxied).

SSL mode is set to **Full (strict)** (Fly terminates TLS).

## Cutover from DigitalOcean

After Fly is healthy:

1. Verify vault unseal + spot-check a scale-to-zero app
2. Run **Destroy DigitalOcean** workflow — type `destroy-origin` to confirm
3. Follow-up: delete `destroy-digitalocean.yml`, `destroy-digitalocean.ts`, and `DIGITALOCEAN_TOKEN` references

The destroy workflow deletes droplet `origin`, purges `NODE_SSH_*` from Vault, and prunes the legacy `origin.<zone>` A record.

## Adding a new service

1. Add entry to `services.yaml`
2. `bun run generate-fly`
3. Add publish workflow in the project repo (or `bun run rollout-publish`)
4. Push — CI deploys the new Fly app

## pgweb and Filestash (standalone Fly apps)

Two admin tools live in this repo with their own Dockerfiles and deploy workflow — separate from the GHCR / `services.yaml` pipeline. At container startup each app fetches credentials from Vault via the HTTP API (`curl` + `jq`). Fly only stores bootstrap secrets (`VAULT_ADDR`, `VAULT_TOKEN`; Filestash also gets `ADMIN_PASSWORD`).

| App | Fly app | Domain | Port |
|-----|---------|--------|------|
| pgweb | `pgweb-chrisvouga` | `pgweb.chrisvouga.dev` | 8081 |
| Filestash | `filestash-chrisvouga` | `filestash.chrisvouga.dev` | 8334 |

**Deploy is fully automated** via [`.github/workflows/deploy-pgweb-filestash.yml`](.github/workflows/deploy-pgweb-filestash.yml) on push to `main` (or manual dispatch). Each run:

1. Authenticates to Vault via OIDC (same as deploy-pipeline)
2. Runs idempotent setup (`bun run setup-pgweb-filestash`) — seeds missing Vault keys, creates Fly apps/certs/volume, syncs runtime secrets, mints deploy tokens, updates GitHub secrets, reconciles Cloudflare DNS
3. Deploys with `flyctl deploy --remote-only`

### What setup automates

| Step | Behavior |
|------|----------|
| Vault `PGWEB_AUTH_USER` / `PGWEB_AUTH_PASS` | Generated and patched to `secret/personal/prd` if missing |
| Vault `FILESTASH_ADMIN_PASSWORD` | Generated and patched if missing; synced to Fly as `ADMIN_PASSWORD` |
| Fly apps + TLS certs | Created if missing |
| Filestash volume `filestash_data` | Created in `iad` if missing |
| Runtime Fly secrets | `VAULT_ADDR` + long-lived `VAULT_TOKEN` from Vault prd |
| Deploy tokens | Minted once, stored in Vault (`FLY_API_TOKEN_PGWEB` / `FLY_API_TOKEN_FILESTASH`) and GitHub secrets |
| DNS | CNAME `*.chrisvouga.dev` → `<app>.fly.dev` via Cloudflare API |

### Prerequisites (org-wide, already required by deploy-pipeline)

- `FLY_TOKEN` in Vault prd (org deploy token)
- `VAULT_TOKEN` in Vault prd (long-lived read token for runtime containers)
- Vault OIDC `github-actions` role
- `CLOUDFLARE_API_TOKEN` for DNS

No manual `flyctl apps create`, cert, volume, or `gh secret set` steps needed after the first workflow run.

### Local commands

```bash
bun run setup-pgweb-filestash              # idempotent setup (both apps)
bun run setup-pgweb-filestash --app pgweb  # single app
bun run deploy-pgweb-filestash --app pgweb # deploy after setup
```

pgweb pre-seeds **dev** and **prd** Postgres bookmarks from Vault and enables sessions mode. Filestash seeds S3 connections from Vault on every boot and uses `ADMIN_PASSWORD` for the admin console (no manual `/admin` first-boot wizard).

## Repo layout

```
services.yaml          # single source of truth
fly/<id>/fly.toml      # generated Fly configs
pgweb/                 # Postgres explorer (standalone deploy)
filestash/             # S3 file browser (standalone deploy)
scripts/
  generate-fly.ts      # SSOT → fly.toml
  deploy-fly.ts        # flyctl deploy --image
  setup-pgweb-filestash.ts
  deploy-pgweb-filestash.ts
  sync-fly-secrets.ts  # Vault → fly secrets set
  sync-dns.ts          # Cloudflare CNAME → *.fly.dev
.github/workflows/
  deploy-pipeline.yml
  deploy-pgweb-filestash.yml
  reusable-publish-image.yml
  destroy-digitalocean.yml   # one-time post-cutover
```
