# Migration guide: Fly.io → single-node Docker

This document picks up **after the Setup workflow succeeds**. It walks through the remaining steps to get all 15 `*.chrisvouga.dev` apps running on the DigitalOcean origin droplet and retire Fly.

## Goal

| Before | After |
|--------|-------|
| 15 separate Fly.io apps | One DO droplet (`chrisvouga-origin`) + Traefik |
| Per-app Fly deploys | Per-repo `publish-image` → ghcr → `chrisvouga.dev` deploy |
| `*.fly.dev` hostnames | `*.chrisvouga.dev` via Cloudflare → origin |

## What Setup already did

When **Setup** completes successfully:

1. Created (or reused) droplet `chrisvouga-origin` in DigitalOcean
2. Wrote node SSH credentials to shared Vault (`secret/data/personal/prd`):
   - `CHRISVOUGA_DEV_NODE_SSH_HOST` — droplet IP
   - `CHRISVOUGA_DEV_NODE_SSH_USER` — `root`
   - `CHRISVOUGA_DEV_NODE_SSH_KEY` — ed25519 private key
3. Triggered **Deploy Pipeline**, which:
   - Bootstraps Docker on the node
   - Syncs Cloudflare DNS (`origin.chrisvouga.dev` A record + per-app CNAMEs)
   - Syncs apex → `www` redirect rule
   - Writes app secrets to `/opt/chrisvouga/.env` on the node
   - Runs `docker compose up` for all services in [`services.yaml`](../services.yaml)
   - Health-checks every service with `health_check: true`

---

## Step 1 — Confirm Deploy Pipeline succeeded

Open GitHub Actions on [`crvouga/chrisvouga.dev`](https://github.com/crvouga/chrisvouga.dev/actions).

Find the **Deploy Pipeline** run that Setup triggered. Every job should be green:

| Job | What it proves |
|-----|----------------|
| `prepare` | Compose + types valid |
| `bootstrap-node` | SSH works; node has Docker + systemd unit |
| `dns-sync` | Cloudflare DNS + apex redirect applied |
| `secrets-sync` | Vault secrets written to node `.env` |
| `deploy` | Stack pulled and started on droplet |
| `health-check` | Public URLs respond (may fail until images exist — see Step 3) |

If `health-check` failed on first run, that is expected until container images exist on ghcr.io. Continue to Steps 2–3, then re-run deploy.

**Re-run deploy manually** (Actions → Deploy Pipeline → Run workflow):

- `service_id`: leave empty (all services)
- `image_tag`: `latest`
- `apply_dns`: `true`

---

## Step 2 — Cloudflare SSL mode

In the Cloudflare dashboard for `chrisvouga.dev`:

1. **SSL/TLS** → Overview
2. Set encryption mode to **Full** (not Full Strict)

The origin serves HTTP on port 80 only. Cloudflare terminates HTTPS for visitors.

---

## Step 3 — Roll out publish workflows to sibling repos

Portfolio already has [`publish-image.yml`](https://github.com/crvouga/portfolio/blob/main/.github/workflows/publish-image.yml). The other **13 repos** still need it.

Run once from your machine (requires `gh` CLI + admin PAT):

```bash
cd /path/to/chrisvouga.dev
export GITHUB_TOKEN_SUPER="ghp_..."   # repo + admin:org scopes

# Preview first (optional)
bun run rollout-publish -- --dry-run

# Push workflows + set org dispatch secret
bun run rollout-publish -- --set-org-dispatch-secret
```

### What this does

1. Sets org secret `DEPLOY_DISPATCH_TOKEN` on `crvouga` (so sibling repos can trigger deploys in `chrisvouga.dev`)
2. Commits `.github/workflows/publish-image.yml` to each repo's `main` branch
3. Each push triggers a build → push to `ghcr.io/crvouga/chrisvouga-<id>` → `repository_dispatch` deploy

### Repos updated (13)

| Repo | Service id(s) |
|------|---------------|
| `crvouga/pickflix-v1` | `pickflix` |
| `crvouga/moviefinder.app-rust` | `moviefinder-app-rust` |
| `crvouga/moviefinder.app-go` | `moviefinder-app-go` |
| `crvouga/moviefinder.app-react` | `moviefinder-app-react` |
| `crvouga/moviefinder.app-clojurescript` | `moviefinder-app-clojurescript` |
| `crvouga/headless-combobox` | `headless-combobox-svelte-example`, `headless-combobox-docs` |
| `crvouga/todo-v1` | `todo-app` |
| `crvouga/image-service` | `image-service` |
| `crvouga/connect-four` | `connect-four` |
| `crvouga/anime` | `anime-blog` |
| `crvouga/snake` | `snake-game` |
| `crvouga/match-three` | `match-three` |
| `crvouga/simon-says` | `simon-says` |

Portfolio (`crvouga/portfolio`) is skipped by rollout — it already has its own workflow.

Roll out a single repo if needed:

```bash
bun run rollout-publish -- --repo crvouga/snake
```

---

## Step 4 — Build all container images

After rollout, each repo's **Publish image** workflow runs automatically on the commit that added the workflow.

### Portfolio image

If portfolio has not built since migration, trigger manually:

1. Actions → **Publish image** on `crvouga/portfolio` → Run workflow, or
2. Push any commit to `main`

### Monitor builds

For each repo, confirm **Publish image** succeeded. Images land at:

```
ghcr.io/crvouga/chrisvouga-<service-id>:latest
ghcr.io/crvouga/chrisvouga-<service-id>:<git-sha>
```

Each successful publish dispatches **Deploy Pipeline** in `chrisvouga.dev` with that service id and sha tag.

### If a build fails

Common fixes:

| Problem | Fix |
|---------|-----|
| No `Dockerfile` at path in `services.yaml` | Add Dockerfile or fix `dockerfile` / `build_context` in `services.yaml` |
| Build error in app code | Fix in project repo, push to `main` |
| Dispatch failed | Confirm org secret `DEPLOY_DISPATCH_TOKEN` was set (Step 3) |
| Image pull failed on node | Confirm package is public (publish workflow sets visibility; deploy also runs `make-ghcr-public`) |

Re-deploy one service after fixing:

Actions → **Deploy Pipeline** → `service_id: pickflix` (example) → Run workflow

---

## Step 5 — Verify the cutover

### CI health-check

Re-run **Deploy Pipeline** with empty `service_id`. The `health-check` job hits every `health_check: true` service over HTTPS.

Locally (optional):

```bash
cd chrisvouga.dev
bun run health-check
bun run health-check -- --id portfolio
```

### Manual spot-check

Open each hostname in a browser:

| Service | URL |
|---------|-----|
| Portfolio | https://www.chrisvouga.dev |
| Pickflix | https://pickflix.chrisvouga.dev |
| MovieFinder (Rust) | https://moviefinder-app-rust.chrisvouga.dev |
| MovieFinder (Go) | https://moviefinder-app-go.chrisvouga.dev |
| MovieFinder (React) | https://moviefinder-app-react.chrisvouga.dev |
| MovieFinder (CLJS) | https://moviefinder-app-clojurescript.chrisvouga.dev |
| Headless Combobox docs | https://headlesscombobox.chrisvouga.dev |
| Headless Combobox Svelte | https://svelte.headlesscombobox.chrisvouga.dev |
| Todo | https://todo.chrisvouga.dev |
| Image service | https://imageservice.chrisvouga.dev |
| Connect Four | https://connectfour.chrisvouga.dev |
| Anime blog | https://anime.chrisvouga.dev |
| Snake | https://snake.chrisvouga.dev |
| Match Three | https://matchthree.chrisvouga.dev |
| Simon Says | https://simonsays.chrisvouga.dev |

Apex redirect: https://chrisvouga.dev → should 301 to `www`.

### Optional: inspect the node

```bash
# IP is CHRISVOUGA_DEV_NODE_SSH_HOST in Vault (or DO console)
ssh root@<droplet-ip>
docker compose -f /opt/chrisvouga/docker-compose.yml ps
docker compose -f /opt/chrisvouga/docker-compose.yml logs -f traefik
```

---

## Step 6 — Decommission Fly.io

**Only after** all services pass health-check and you have verified URLs in the browser.

### Option A — Setup workflow

Actions → **Setup** → Run workflow:

- `provision_droplet`: `false`
- `deploy`: `true`
- `decommission_fly`: `true`

### Option B — Deploy Pipeline directly

Actions → **Deploy Pipeline** → Run workflow:

- `run_fly_teardown`: `true`

Both trigger [`fly-teardown.yml`](https://github.com/crvouga/portfolio/blob/main/.github/workflows/fly-teardown.yml) in the portfolio repo, which destroys Fly apps registered in `projects.ts` (up to 15 per run).

Monitor the portfolio **Fly teardown** workflow. Confirm apps are gone in the [Fly dashboard](https://fly.io/dashboard).

---

## Ongoing operations

### Normal deploy flow (per app)

```
push to main (project repo)
  → Publish image (build + push ghcr + dispatch)
    → Deploy Pipeline (chrisvouga.dev)
      → SSH deploy on origin droplet
        → health-check
```

No deploy happens from project repos directly — only image publish + dispatch.

### Change infra (DNS, secrets, compose)

Edit [`services.yaml`](../services.yaml), then push to `chrisvouga.dev` `main`:

```bash
bun run generate-compose    # if services changed
git add services.yaml docker-compose.yml
git commit -m "..."
git push
```

Push triggers **Deploy Pipeline** automatically.

### Add a new service

1. Add entry to `services.yaml` (hostname, port, `github_repo`, docker paths, secrets)
2. `bun run generate-compose` and commit
3. `bun run rollout-publish -- --repo crvouga/new-repo` (or add workflow manually)
4. Push project repo → image builds → auto-deploy

### Useful local commands

```bash
bun run sync-dns -- --apply          # reconcile Cloudflare DNS
bun run sync-redirects -- --apply    # apex → www rule
bun run health-check                 # probe all public URLs
bun run rollout-publish -- --dry-run # preview CI rollout
```

### Vault secrets reference

Path: `secret/data/personal/prd` on [vault.chrisvouga.dev](https://vault.chrisvouga.dev)

| Key | Used for |
|-----|----------|
| `DIGITALOCEAN_TOKEN` | Droplet provisioning |
| `GITHUB_TOKEN_SUPER` | Setup, cross-repo dispatch |
| `CHRISVOUGA_DEV_NODE_SSH_HOST` | Deploy SSH target IP (auto-written by provision) |
| `CHRISVOUGA_DEV_NODE_SSH_USER` | Deploy SSH user (auto-written) |
| `CHRISVOUGA_DEV_NODE_SSH_KEY` | Deploy SSH private key (auto-written) |
| `CLOUDFLARE_API_TOKEN` | DNS + redirect sync |
| `CLOUDFLARE_ACCOUNT_ID` | DNS + redirect sync |
| `TMDB_API_READ_ACCESS_TOKEN` | Pickflix, MovieFinder apps |
| `TWILIO_*` | MovieFinder apps |

The **Setup** / **Provision node** workflows populate `CHRISVOUGA_DEV_NODE_SSH_*` automatically. If you previously used GitHub repo secrets (`NODE_SSH_*`), the provision script migrates them to Vault on the next run.

---

## Quick checklist

Copy and track progress:

- [ ] Setup workflow succeeded
- [ ] Deploy Pipeline bootstrap jobs green (`bootstrap-node`, `dns-sync`, `secrets-sync`, `deploy`)
- [ ] Cloudflare SSL/TLS set to **Full**
- [ ] `bun run rollout-publish -- --set-org-dispatch-secret` completed
- [ ] All 14 repos have green **Publish image** runs (13 siblings + portfolio)
- [ ] All 15 ghcr images exist and are public
- [ ] Deploy Pipeline `health-check` green for all services
- [ ] Manual browser check on key hostnames
- [ ] Fly teardown run and Fly apps removed

---

## Troubleshooting

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| `health-check` 502/503 | Image not built or container crashed | Check `docker compose ps` on node; re-run Publish image |
| DNS points to old Fly host | CNAME not updated | Re-run Deploy Pipeline with `apply_dns: true` |
| `repository_dispatch` 404 | Missing `DEPLOY_DISPATCH_TOKEN` | Re-run rollout with `--set-org-dispatch-secret` |
| SSL error in browser | Cloudflare mode wrong | Set SSL to **Full** |
| SSH deploy fails | `CHRISVOUGA_DEV_NODE_SSH_*` stale or missing in Vault | Re-run **Provision node**; confirm `github-actions` Vault role can `patch` `secret/data/personal/prd` |
| One service only broken | Bad image or env | Deploy Pipeline with that `service_id`; check `/opt/chrisvouga/.env` on node |

For architecture overview and file layout, see the [README](../README.md).
