# chrisvouga.dev

Single-node Docker deployment for all `*.chrisvouga.dev` side projects.

Each project repo builds and pushes its own public image to `ghcr.io/crvouga/chrisvouga-<id>`. This repo **only consumes those images** — GitHub Actions bootstraps the node, syncs DNS/secrets, deploys, and health-checks.

Cloudflare terminates TLS at the edge (proxied DNS). Traefik on the droplet serves HTTP only.

## Architecture

```
Project repos ──▶ ghcr.io (public images)
                        │
                        ▼
              chrisvouga.dev CI (GitHub Actions)
                        │
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
     provision      dns-sync    secrets-sync
          │             │             │
          └─────────────┼─────────────┘
                        ▼
                  deploy (SSH)
                        │
                        ▼
              DO Droplet + Traefik :80
                        │
                        ▼
                 *.chrisvouga.dev
```

**Setup succeeded?** Continue with the step-by-step migration guide: [`docs/MIGRATION.md`](docs/MIGRATION.md).

## Automated first deploy (5 steps)

### 1. Add Vault secrets

In `secret/data/personal/prd` on [vault-chrisvouga.fly.dev](https://vault-chrisvouga.fly.dev):

| Key | Purpose |
|-----|---------|
| `DIGITALOCEAN_TOKEN` | Create/manage the origin droplet |
| `GITHUB_TOKEN_SUPER` | PAT with `repo` + `admin:org` — triggers workflows, cross-repo dispatch |
| `CHRISVOUGA_DEV_NODE_SSH_HOST` | Origin droplet IP (auto-written by provision) |
| `CHRISVOUGA_DEV_NODE_SSH_USER` | SSH user, typically `root` (auto-written) |
| `CHRISVOUGA_DEV_NODE_SSH_KEY` | SSH private key (auto-written) |
| `CLOUDFLARE_API_TOKEN` | DNS sync (existing) |
| `DOZZLE_USERS_YML` | Dozzle login file — see [Infra monitoring](#infra-monitoring) |
| `NETDATA_BASIC_AUTH_USERS` | Traefik basic auth for Netdata — `htpasswd -nb admin 'password'` |
| App secrets | TMDB, Twilio, etc. (existing) |

Node SSH credentials live in shared Vault — provisioning writes them automatically. The `github-actions` Vault role needs `patch` on `secret/data/personal/prd`. CI connects to [vault-chrisvouga.fly.dev](https://vault-chrisvouga.fly.dev) but JWT `aud` remains `https://vault.chrisvouga.dev` until the Vault role is updated.

### 2. Run Setup workflow

In GitHub Actions → **Setup** → Run workflow:

- `provision_droplet: true` (default) — creates `chrisvouga-origin` droplet (8 GB, Ubuntu 24.04), installs Docker, writes `CHRISVOUGA_DEV_NODE_SSH_*` to Vault
- `deploy: true` (default) — triggers **Deploy Pipeline**

Skips droplet creation if `CHRISVOUGA_DEV_NODE_SSH_HOST` is already in Vault. One-time migration from legacy GitHub `NODE_SSH_*` repo secrets runs automatically when present.

### 3. Roll out publish workflows to sibling repos

Once locally (requires `gh` CLI + `GITHUB_TOKEN_SUPER`):

```bash
export GITHUB_TOKEN_SUPER="ghp_..."
bun run rollout-publish -- --set-org-dispatch-secret
```

This pushes `.github/workflows/publish-image.yml` to all 13 sibling repos (from [`services.yaml`](services.yaml)) and sets org-level `DEPLOY_DISPATCH_TOKEN`.

Options:

```bash
bun run rollout-publish -- --dry-run          # preview generated workflows
bun run rollout-publish -- --repo crvouga/snake  # single repo
```

### 4. Wait for images + deploys

Sibling repo pushes trigger `repository_dispatch` → **Deploy Pipeline** per service. Monitor health-check in Actions.

## Layout

| Path | Purpose |
|------|---------|
| [`services.yaml`](services.yaml) | Hostnames, ports, images, repo URLs, build paths, secrets |
| [`docker-compose.yml`](docker-compose.yml) | Generated Traefik + app services + infra (Netdata, Dozzle) |
| [`traefik/traefik.yml`](traefik/traefik.yml) | HTTP-only edge proxy |
| [`scripts/provision-droplet.ts`](scripts/provision-droplet.ts) | DO droplet + GitHub secret wiring |
| [`scripts/rollout-publish-workflows.ts`](scripts/rollout-publish-workflows.ts) | Push CI to all project repos |
| [`.github/workflows/setup.yml`](.github/workflows/setup.yml) | One-click bootstrap |
| [`.github/workflows/deploy-pipeline.yml`](.github/workflows/deploy-pipeline.yml) | Deploy orchestrator |
| [`.github/workflows/provision-node.yml`](.github/workflows/provision-node.yml) | Droplet-only provision |
| [`.github/workflows/reusable-publish-image.yml`](.github/workflows/reusable-publish-image.yml) | Called by each project repo |

Regenerate compose after editing `services.yaml`:

```bash
bun run generate-compose
```

## CI triggers

| Workflow | Trigger | Behavior |
|----------|---------|----------|
| **Setup** | `workflow_dispatch` | Provision droplet → trigger deploy |
| **Deploy Pipeline** | push / dispatch / `workflow_dispatch` | Full deploy |
| **Provision node** | `workflow_dispatch` | Droplet only |
| Per-repo **publish-image** | push to `main` | Build ghcr image → dispatch deploy |

## Local scripts

```bash
bun run provision-droplet -- --dry-run
bun run rollout-publish -- --dry-run
bun run sync-dns -- --apply
bun run health-check
bun run make-ghcr-public
```

## Cloudflare SSL

Set SSL/TLS mode to **Flexible** — origin serves HTTP on port 80; Cloudflare serves HTTPS to visitors. (`dns-sync --apply` sets this automatically.)

## Infra monitoring

Upstream Docker images defined in `services.yaml` → `infra_services` (not built via GHCR):

| URL | Tool | Auth |
|-----|------|------|
| [netdata.chrisvouga.dev](https://netdata.chrisvouga.dev) | Host + container metrics | Traefik basic auth (`NETDATA_BASIC_AUTH_USERS`) |
| [dozzle.chrisvouga.dev](https://dozzle.chrisvouga.dev) | Live Docker logs | Dozzle login (`DOZZLE_USERS_YML`) |

Add these Vault keys before the first full deploy (or run `bun run generate-infra-auth` — no Docker required):

```bash
bun run generate-infra-auth
# optional: write directly to Vault (requires vault login first)
vault login
bun run generate-infra-auth -- --write-vault
```

Manual generation:

```bash
# Dozzle users file
docker run --rm amir20/dozzle generate admin --password 'your-password' --email you@example.com

# Netdata Traefik basic auth (single line, paste into Vault)
htpasswd -nb admin 'your-password'
```

Both services use `health_check: false` (auth blocks CI probes). After deploy, verify the URLs manually in a browser.
