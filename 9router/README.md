# 9router (local Node/npm)

Runs [decolua/9router](https://github.com/decolua/9router) from a local clone on **http://127.0.0.1:20128**. Not part of the Railway fleet. Tooling is TypeScript + npm (`tsx`).

Cursor BYOK uses the stable public hostname **https://9router.chrisvouga.dev** (named Cloudflare tunnel → local `:20128`).

## Prerequisites

- Node.js 18+ and npm
- Vault access for secrets — a valid login session (`vault login`) with read on `secret/personal/prd`
- For Cursor: `cloudflared` (`brew install cloudflared`)

If `npm run pull-secrets` returns 403, your `~/.vault-token` is expired. Re-auth first:

```bash
vault login -method=userpass username=crvouga
# or: vault login <root-or-dev-token>
```

## One-time setup

```bash
cd 9router
npm install
npm run setup    # pull-secrets → sync-app → install-app → build
brew install cloudflared
cloudflared tunnel login
npm run provision-tunnel   # tunnel "9router" + DNS 9router.chrisvouga.dev
npm run up                 # daemon: app + tunnel
```

Or step by step:

```bash
npm run pull-secrets
npm run sync-app
npm run install-app
npm run build
npm run provision-tunnel
npm run up
```

Health check: http://127.0.0.1:20128/api/health

## Day-to-day

```bash
npm run up       # daemonize app + named tunnel (returns immediately)
npm run status   # app + tunnel pids, port, public URL, log paths
npm run down     # stop both daemons (and free :20128)
npm run build    # rebuild after sync-app / upstream updates
npm run tunnel   # optional: foreground tunnel for debugging only
```

Logs: `.pids/9router.log`, `.pids/tunnel.log`.

Recommended after `up` (or when adding Vault provider keys):

```bash
npm run sync-providers   # connect providers from Vault / local auto-import
npm run sync-combos
npm run check-combos     # registry + combo drift + credential coverage
npm run sync-cursor      # Cursor BYOK model list (quit Cursor first)
```

## Providers (Vault-driven)

[`providers.yaml`](providers.yaml) plus registry auto-discovery. With 9Router running:

```bash
npm run sync-providers
npm run sync-providers -- --dry-run
npm run sync-providers -- --force          # refresh API keys on existing connections
npm run sync-providers -- --interactive   # device-code for kiro/github (opens browser)
npm run sync-providers -- --strict        # exit 1 if combo-referenced providers still missing
```

**Idempotent:** already-connected providers are skipped. Missing Vault/env credentials skip that provider (exit 0 unless `--strict` or a hard failure). Re-run after adding keys — only new providers are created.

**Credential sources (priority):**

1. Local auto-import — Cursor (`state.vscdb`) and Kiro (AWS SSO cache)
2. Vault KV `secret/personal/prd` (or process env / `vault run`)
3. `--interactive` device-code for kiro/github only

**Vault key naming** (field name = env var; not written to `.env` by default):

| Kind | Example |
| ---- | ------- |
| API key (default) | `glm` → `GLM_API_KEY`, `minimax` → `MINIMAX_API_KEY` |
| Shared overrides | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CLOUDFLARE_API_TOKEN`, … (see `vaultKeyOverrides` in providers.yaml) |
| Kiro | `KIRO_REFRESH_TOKEN` (optional `KIRO_CLIENT_ID` / `KIRO_CLIENT_SECRET` / `KIRO_API_KEY`) |
| Codex | `CODEX_ACCESS_TOKEN` (+ optional refresh/id/email) |
| Cursor | `CURSOR_ACCESS_TOKEN` + `CURSOR_MACHINE_ID` (or local auto-import) |

Browser-only OAuth (Claude Code, most subscription providers) is skipped unless you connect in the dashboard or use `--interactive` where supported.

## Combos (declarative)

Edit [`combos.yaml`](combos.yaml) for named fallback chains (`9router-free`, `9router-max-sub-claude`, `9router-max-sub-cursor`, …). With 9Router running:

```bash
npm run sync-combos            # upsert combos + strategies from combos.yaml
npm run sync-combos -- --prune # also delete remote LLM combos not in the spec
npm run check-combos           # exit 1 if missing/drifted vs spec / registry / credentials
npm run sync-combos -- --dry-run
```

Auth prefers the local CLI token (`x-9r-cli-token` from `$DATA_DIR/machine-id` + `$DATA_DIR/auth/cli-secret`), then falls back to `INITIAL_PASSWORD` login (from Vault `9ROUTER_PASSWORD` via `.env` or `vault run`). `DATA_DIR` in `.env` always wins over ambient shell — defaults to `./data`.

Use the combo name as the model in Cursor / Claude Code / etc. (e.g. `9router-free` or `9router-max-sub-claude`). Providers must still be connected (`npm run sync-providers` or the dashboard); missing tiers fall through at runtime.

If Cursor shows **Provider Error** with `providerStatusCode: 404`, 9Router usually has **no active credentials** for every tier in that combo — not a bad combo name. Run `npm run check-combos` and `npm run sync-providers`, then connect any remaining OAuth providers.

### Sync into Cursor

Cursor Agent/Chat calls your OpenAI base URL from **Cursor's cloud**, not from your Mac.
A localhost URL (`http://127.0.0.1:20128/v1`) always fails with:

`Access to private networks is forbidden`

`sync-cursor` always writes **`https://9router.chrisvouga.dev/v1`** by default. Keep daemons up (`npm run up`) so that hostname reaches local 9Router.

```bash
npm run up
# Quit Cursor first, then:
npm run sync-cursor

npm run sync-cursor -- --dry-run
npm run sync-cursor -- --force          # write while Cursor is open (may be overwritten)
npm run sync-cursor -- --prune-combos   # drop previously synced combo names removed from combos.yaml
npm run sync-cursor -- --allow-private  # write localhost anyway (Agent will still 403)
```

Then reopen Cursor and select a combo (e.g. `9router-free`, `9router-max-sub-claude`) in the model picker.

If Cursor errors with the private-networks message, the synced base URL is still private — re-run `npm run sync-cursor` (without `--allow-private`). If the hostname is correct but requests hang, run `npm run status` and ensure both daemons are up.

Progress is logged as `[sync-cursor] …` steps. Backup is row-level only (the keys sync-cursor changes), not a copy of the full `state.vscdb` — important when that file is very large.

## Layout

| Path | Purpose |
| ---- | ------- |
| `package.json` | npm scripts (`tsx`) for all ops |
| `combos.yaml` | Declarative LLM combo catalog |
| `providers.yaml` | Provider sync methods + Vault key overrides |
| `app/` | Gitignored clone of `decolua/9router` |
| `data/` | Persistent app data (`DATA_DIR`) |
| `.env` | Secrets (gitignored); copy from `.env.example` or `npm run pull-secrets` |
| `.cloudflared/` | Generated named-tunnel config (gitignored) |
| `.pids/` | Daemon pid + log files (gitignored) |
| `scripts/*.ts` | TypeScript tooling |
| `scripts/start.ts` | `npm run up` — daemonize app + tunnel |
| `scripts/stop.ts` | `npm run down` — stop both |
| `scripts/provision-tunnel.ts` | Create named tunnel + DNS for `9router.chrisvouga.dev` |
| `scripts/tunnel.ts` | Foreground tunnel (debug only) |
| `scripts/oauth-redirect-patch.ts` | Claude OAuth redirect patch applied after `npm run build` |

## Secrets

Stored in Vault at `secret/personal/prd` (override with `VAULT_KV_CONFIG=dev`). Prefixed KV fields map to `.env` / upstream env vars:

| Vault field | App env var |
| ----------- | ----------- |
| `9ROUTER_PASSWORD` | `INITIAL_PASSWORD` |
| `9ROUTER_JWT_SECRET` | `JWT_SECRET` |
| `9ROUTER_API_KEY_SECRET` | `API_KEY_SECRET` |
| `9ROUTER_MACHINE_ID_SALT` | `MACHINE_ID_SALT` |

Legacy unprefixed keys (`INITIAL_PASSWORD`, etc.) are still accepted if prefixed keys are absent.

**Seed once** (generate random values for the three non-password secrets):

```bash
vault kv patch secret/personal/prd \
  9ROUTER_PASSWORD='…' \
  9ROUTER_JWT_SECRET="$(openssl rand -hex 32)" \
  9ROUTER_API_KEY_SECRET="$(openssl rand -hex 32)" \
  9ROUTER_MACHINE_ID_SALT="$(openssl rand -hex 32)"
```

**Pull into `.env`:**

```bash
npm run pull-secrets
```

**Or inject at runtime** (no `.env` write; uses [`9router/.vault.yaml`](.vault.yaml)):

```bash
vault run -- npm run sync-cursor
vault run -- npm run sync-combos
vault run -- npm run sync-providers
```

Scripts auto-fetch from Vault when secrets are missing (`ensureAppSecrets`). Provider API keys / OAuth tokens stay in Vault KV (or local auto-import) — `sync-providers` reads them without writing into `.env`. Cloudflare tunnel cert/credentials stay machine-local (`cloudflared tunnel login` + `npm run provision-tunnel`).

## Notes

- Upstream: `https://github.com/decolua/9router` (override with `NINEROUTER_REPO_URL` / `NINEROUTER_BRANCH`).
- Listens on `HOSTNAME`/`PORT` from `.env` (defaults `0.0.0.0:20128`).
- `9router.chrisvouga.dev` is a Cloudflare named tunnel only — not in fleet `services.yaml` / `sync-dns`.
