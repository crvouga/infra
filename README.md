# Origin stack (infra)

Single-node Docker deployment for all services on the zone defined in [`services.yaml`](services.yaml) (`zone: chrisvouga.dev`).

Each project repo builds and pushes its own public image to `ghcr.io/<image_owner>/<zone-slug>-<id>` (e.g. `ghcr.io/crvouga/chrisvouga-dev-pickflix`). This repo **only consumes those images** — GitHub Actions bootstraps the node, syncs DNS/secrets, deploys, and health-checks.

Cloudflare terminates TLS at the edge (proxied DNS). Traefik on the droplet serves HTTP only.

Platform paths, network names, and GHCR prefixes are derived from `services.yaml` — not hardcoded in scripts.

**On-demand runtime:** Most services default to `runtime: on_demand`. The `service-orchestrator` container wakes them on first HTTP request and stops them after an idle timeout (default 30 minutes). Only `traefik`, `vault`, and `service-orchestrator` stay running at idle.

## Architecture

```
Project repos ──▶ ghcr.io (public images)
                        │
                        ▼
              Infra CI (GitHub Actions)
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
          ┌─────────────┴─────────────┐
          ▼                           ▼
   always_on (vault)          service-orchestrator
                                      │
                              wake / stop on_demand apps
                        │
                        ▼
                 *.<zone from services.yaml>
```

## Configuration ([`services.yaml`](services.yaml))

| Field | Purpose |
|-------|---------|
| `zone` | Primary DNS zone (e.g. `chrisvouga.dev`) |
| `origin_hostname` | Origin CNAME target |
| `image_owner` | GHCR org/user |
| `infra_github_repo` | GitHub repo slug for this infra repo |
| `droplet_name` | DO droplet name (default `origin`) |
| `do_project_name` | DigitalOcean project (default `projects`) |
| `orchestrator.idle_timeout_minutes` | Stop on-demand services after N minutes idle (default `30`) |
| `runtime` | Per service: `always_on` or `on_demand` (default `on_demand`) |

Derived automatically: `image_prefix` (`chrisvouga-dev`), deploy dir (`/opt/chrisvouga-dev`), Docker network (`chrisvouga-dev-web`), Vault URL (`https://vault.<zone>`).

Default droplet size for new provisions: **s-2vcpu-4gb** (2 vCPU, 4 GB RAM).

Inspect derived values:

```bash
bun run scripts/print-platform-env.ts
```

## Automated first deploy (5 steps)

### 1. Add Vault secrets

In `secret/data/personal/prd` on Vault (`https://vault.<zone>`):

| Key | Purpose |
|-----|---------|
| `DIGITALOCEAN_TOKEN` | Create/manage the origin droplet |
| `GITHUB_TOKEN_SUPER` | PAT with `repo` + `admin:org` — triggers workflows, cross-repo dispatch |
| `NODE_SSH_HOST` | Origin droplet IP (auto-written by provision) |
| `NODE_SSH_USER` | SSH user, typically `root` (auto-written) |
| `NODE_SSH_KEY` | SSH private key (auto-written) |
| `CLOUDFLARE_API_TOKEN` | DNS sync (existing) |
| `NETDATA_USERNAME` | Netdata Traefik basic auth user — see [Infra monitoring](#infra-monitoring) |
| `NETDATA_PASSWORD` | Netdata password (plain; bcrypt-hashed at deploy) |
| `DOZZLE_USERNAME` | Dozzle login user |
| `DOZZLE_PASSWORD` | Dozzle password (plain; bcrypt-hashed at deploy) |
| `DOZZLE_EMAIL` | Optional Dozzle user email |
| App secrets | TMDB, Twilio, etc. (existing) |

Node SSH credentials live in shared Vault — provisioning writes them automatically. The `github-actions` Vault role needs `patch` on `secret/data/personal/prd`.

### 2. Run Setup workflow

In GitHub Actions → **Setup** → Run workflow:

- `provision_droplet: true` (default) — creates `origin` droplet in DO project `projects` (4 GB, Ubuntu 24.04), installs Docker, writes `NODE_SSH_*` to Vault
- `deploy: true` (default) — triggers **Deploy Pipeline**

Skips droplet creation if `NODE_SSH_HOST` is already in Vault. One-time migration from legacy GitHub `NODE_SSH_*` repo secrets runs automatically when present.

### 3. Roll out publish workflows to sibling repos

Once locally (requires `gh` CLI + `GITHUB_TOKEN_SUPER`):

```bash
export GITHUB_TOKEN_SUPER="ghp_..."
bun run rollout-publish -- --set-org-dispatch-secret
```

This pushes `.github/workflows/publish-image.yml` to all sibling repos (from [`services.yaml`](services.yaml)) and sets org-level `DEPLOY_DISPATCH_TOKEN`.

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
| [`services.yaml`](services.yaml) | Zone, hostnames, ports, images, repo URLs, build paths, secrets |
| [`docker-compose.yml`](docker-compose.yml) | Generated Traefik + app services + infra (orchestrator, Netdata, Dozzle) |
| [`traefik/traefik.yml`](traefik/traefik.yml) | Generated HTTP-only edge proxy config |
| [`apps/service-orchestrator/`](apps/service-orchestrator/) | On-demand wake/stop proxy (built on node) |
| [`scripts/start-stack.sh`](scripts/start-stack.sh) | Boot always-on services only |
| [`scripts/resize-droplet.ts`](scripts/resize-droplet.ts) | Power off → resize → power on existing droplet |
| [`scripts/provision-droplet.ts`](scripts/provision-droplet.ts) | DO droplet + Vault SSH credentials |
| [`scripts/print-platform-env.ts`](scripts/print-platform-env.ts) | Derived platform env for CI |
| [`scripts/rollout-publish-workflows.ts`](scripts/rollout-publish-workflows.ts) | Push CI to all project repos |
| [`.github/workflows/setup.yml`](.github/workflows/setup.yml) | One-click bootstrap |
| [`.github/workflows/deploy-pipeline.yml`](.github/workflows/deploy-pipeline.yml) | Deploy orchestrator |
| [`.github/workflows/provision-node.yml`](.github/workflows/provision-node.yml) | Droplet-only provision |
| [`.github/workflows/resize-node.yml`](.github/workflows/resize-node.yml) | Resize existing droplet |
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
| **Resize node** | `workflow_dispatch` | Resize existing droplet → deploy |
| **Recover stack** | `workflow_dispatch` | Start always-on services when Vault is down (no Vault OIDC) |
| Per-repo **publish-image** | push to `main` | Build ghcr image → dispatch deploy |

## Rollout: downsize + on-demand orchestrator

1. Merge and deploy orchestrator changes while the droplet is still at its current size.
2. Verify wake/stop: visit an on-demand app (e.g. `https://www.chrisvouga.dev`), then check `https://orchestrator.chrisvouga.dev/status`.
3. Run **Resize node** workflow with target `s-2vcpu-4gb` (~5–10 min downtime).
4. Confirm vault health; spot-check 2–3 on-demand apps.

### Vault down (504) — recovery

If `vault.chrisvouga.dev` returns 504, CI cannot OIDC-auth to Vault (chicken-and-egg when the vault container is stopped). **Recover stack** workflow (no Vault required):

1. Ensure GitHub repo secrets exist: `NODE_SSH_HOST`, `NODE_SSH_USER`, `NODE_SSH_KEY`, `GITHUB_TOKEN_SUPER`
2. Actions → **Recover stack** → Run workflow (starts traefik + vault + orchestrator, triggers unseal)
3. When Vault responds, re-run **Deploy Pipeline**

Deploy Pipeline also retries Vault OIDC once and falls back to matching GitHub repo secrets when Vault is down.

**Tradeoffs:** first request to an idle app may take 15–60s (cold start). Full deploy health-checks only `always_on` services; single-service deploys use a 90s cold-start timeout for on-demand apps.

## Service orchestrator ops

| URL | Purpose |
|-----|---------|
| `https://orchestrator.<zone>/health` | Liveness |
| `https://orchestrator.<zone>/status` | Per-service state (running / stopped / last request) |

Built on the node during deploy (`docker compose build service-orchestrator`). Routes all `on_demand` hostnames through Traefik to the orchestrator, which proxies to the real container after wake.

## Local scripts

```bash
bun run provision-droplet -- --dry-run
bun run resize-droplet -- --dry-run --size s-2vcpu-4gb
bun run rollout-publish -- --dry-run
bun run sync-dns -- --apply
bun run health-check
bun run make-ghcr-public
bun run migrate-vault-node-ssh-keys -- --delete-legacy  # one-time Vault key rename
```

## Cloudflare SSL

Set SSL/TLS mode to **Flexible** — origin serves HTTP on port 80; Cloudflare serves HTTPS to visitors. (`dns-sync --apply` sets this automatically.)

## Infra monitoring

Upstream Docker images defined in `services.yaml` → `infra_services` (Netdata, Dozzle use public images; orchestrator is built on-node):

| URL | Tool | Auth |
|-----|------|------|
| `orchestrator.<zone>` | On-demand wake/stop status | None |
| `netdata.<zone>` | Host + container metrics | Traefik basic auth (`NETDATA_USERNAME`, `NETDATA_PASSWORD`) |
| `dozzle.<zone>` | Live Docker logs | Dozzle login (`DOZZLE_USERNAME`, `DOZZLE_PASSWORD`) |

Netdata and Dozzle are **on-demand** — first visit wakes the container (may take up to ~60s).

Passwords are stored plain in Vault and bcrypt-hashed at deploy by `sync-secrets`. Add these keys before the first full deploy (or run `bun run generate-infra-auth` — no Docker required):

```bash
bun run generate-infra-auth
# optional: write directly to Vault (requires vault login first)
vault login
bun run generate-infra-auth -- --write-vault

# per-service credentials (defaults: admin + random passwords)
bun run generate-infra-auth -- \
  --netdata-username admin --netdata-password '<pass>' \
  --dozzle-username admin --dozzle-password '<pass>' \
  --dozzle-email you@example.com \
  --write-vault
```

Both services use `health_check: false` (auth blocks CI probes). After deploy, verify the URLs manually in a browser.

## Migration (from legacy naming)

If upgrading from `CHRISVOUGA_DEV_NODE_SSH_*`, `chrisvouga-origin`, `/opt/chrisvouga`, or `ghcr.io/crvouga/chrisvouga-*`:

1. **Vault:** `vault login && bun run migrate-vault-node-ssh-keys -- --delete-legacy`
2. **DO:** Rename droplet to `origin` (or reprovision) and move to DO project `projects`
3. **Node:** Rsync `/opt/chrisvouga` → `/opt/chrisvouga-dev` or reprovision
4. **GHCR:** `bun run rollout-publish` and push sibling repos to republish `chrisvouga-dev-*` images
5. **Deploy:** Run full **Deploy Pipeline**
