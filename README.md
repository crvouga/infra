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
| App secrets | TMDB, Twilio, etc. (existing) |

Node SSH credentials live in shared Vault — provisioning writes them automatically. The `github-actions` Vault role needs `patch` on `secret/data/personal/prd`.

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

### 5. Decommission Fly (when ready)

Run **Setup** again with `decommission_fly: true`, or **Deploy Pipeline** with `run_fly_teardown: true`.

This triggers [`fly-teardown.yml`](https://github.com/crvouga/portfolio/blob/main/.github/workflows/fly-teardown.yml) in the portfolio repo.

## Layout

| Path | Purpose |
|------|---------|
| [`services.yaml`](services.yaml) | Hostnames, ports, images, repo URLs, build paths, secrets |
| [`docker-compose.yml`](docker-compose.yml) | Generated Traefik + 15 image-only services |
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
| **Deploy Pipeline** | push / dispatch / `workflow_dispatch` | Full deploy + optional fly-teardown |
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

Set SSL/TLS mode to **Full** (not Full Strict) — origin serves HTTP on port 80, Cloudflare serves HTTPS to visitors.
