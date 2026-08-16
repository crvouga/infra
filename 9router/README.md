# 9router (local Node/npm)

Runs [decolua/9router](https://github.com/decolua/9router) from a local clone on **http://127.0.0.1:20128**. Not part of the Railway fleet. Tooling is an interactive TypeScript CLI (`tsx` + `@inquirer/prompts`).

Cursor BYOK uses the stable public hostname **https://9router.chrisvouga.dev** (named Cloudflare tunnel → local `:20128`).

## Prerequisites

- Node.js 18+ and npm
- Vault access for secrets — a valid login session (`vault login`) with read on `secret/personal/prd`
- For Cursor: `cloudflared` (`brew install cloudflared`)

If Pull secrets returns 403, your `~/.vault-token` is expired. Re-auth first:

```bash
vault login -method=userpass username=crvouga
# or: vault login <root-or-dev-token>
```

## Interactive CLI

All operations go through one entry point. There are no per-task npm scripts or CLI flags — options are prompted in the menu.

```bash
cd 9router
npm install
npm start          # or: npm run cli / npx 9router
```

**Controls:** type to filter · ↑↓ navigate · Enter to run · Ctrl+C to quit.

Recent commands are remembered under `.pids/cli-history.json` and shown at the top of the menu.

### Menu commands

| Command | What it does |
| ------- | ------------ |
| Full setup | Pull secrets → sync app → install deps → build |
| Start daemons | Daemonize 9Router + Cloudflare tunnel |
| Stop daemons | Stop both; free the app port |
| Status | Pids, port, local/public URLs, log paths |
| Pull secrets | Write app secrets from Vault into `.env` |
| Sync app | Clone/update upstream into `app/` |
| Install app deps | `npm install` in `app/` |
| Build app | Build + OAuth redirect patch |
| Provision tunnel | Named tunnel + DNS for `9router.chrisvouga.dev` |
| Foreground tunnel | Debug: run named tunnel in the foreground |
| Sync providers | Connect providers from Vault/env (prompts for dry-run, force, OAuth, strict) |
| Setup provider credentials | Paste API keys → Vault → connect (prompts for scope and options) |
| Connect Kiro | Device-code OAuth for Kiro |
| Sync combos | Upsert combos from `combos.yaml` (prompts for dry-run / prune) |
| Check combos | Validate registry, drift, and credentials |
| Sync Cursor | Write BYOK base URL + combo models into Cursor (all options prompted) |
| Exit | Quit |

## One-time setup

```bash
cd 9router
npm install
brew install cloudflared
cloudflared tunnel login
npm start
```

In the menu, run in order:

1. **Full setup**
2. **Provision tunnel**
3. **Start daemons**

Health check: http://127.0.0.1:20128/api/health

## Day-to-day

```bash
npm start
```

Typical picks: **Start daemons**, **Status**, **Stop daemons**, **Build app** (after Sync app), **Foreground tunnel** (debug only).

Logs: `.pids/9router.log`, `.pids/tunnel.log`.

Recommended after Start daemons (or when adding Vault provider keys):

1. **Setup provider credentials** (or **Sync providers**)
2. **Sync combos**
3. **Check combos**
4. **Sync Cursor** (quit Cursor first)

## Providers (Vault-driven)

[`providers.yaml`](providers.yaml) plus registry auto-discovery. With 9Router running:

**Seed API-key credentials** — menu: **Setup provider credentials**. You will be prompted for:

- Scope (combo-only vs all)
- Dry run / open browser URLs / connect after Vault write / re-prompt when key exists
- Per provider: overwrite existing, paste secret (hidden), or skip/quit

OAuth providers are not in that walkthrough — use the dashboard or **Sync providers** with interactive OAuth enabled.

**Sync existing Vault keys** — menu: **Sync providers**. Prompts cover dry-run, force refresh, interactive OAuth (kiro/github), and strict mode.

**Idempotent:** already-connected providers are skipped. Missing Vault/env credentials skip that provider unless strict mode is on. Unsupported browser OAuth with interactive mode is skipped (not a hard fail).

**Credential sources (priority):**

1. Local auto-import — Cursor (`state.vscdb`) and Kiro (AWS SSO cache)
2. Vault KV `secret/personal/prd` (or process env / `vault run` / Setup provider credentials)
3. Interactive OAuth (Sync providers) / Connect Kiro for device-code

**Vault key naming** (field name = env var; not written to `.env` by default):

| Kind | Example |
| ---- | ------- |
| API key (default) | `glm` → `GLM_API_KEY`, `minimax` → `MINIMAX_API_KEY` |
| Shared overrides | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CLOUDFLARE_API_TOKEN`, … (see `vaultKeyOverrides` in providers.yaml) |
| Kiro | `KIRO_REFRESH_TOKEN` (optional `KIRO_CLIENT_ID` / `KIRO_CLIENT_SECRET` / `KIRO_API_KEY`) |
| Codex | `CODEX_ACCESS_TOKEN` (+ optional refresh/id/email) |
| Cursor | `CURSOR_ACCESS_TOKEN` + `CURSOR_MACHINE_ID` (or local auto-import) |

Browser-only OAuth (Claude Code, most subscription providers) is skipped unless you connect in the dashboard or use device-code where supported.

## Combos (declarative)

Edit [`combos.yaml`](combos.yaml) for named fallback chains (`9router-free`, `9router-max-sub-claude`, `9router-max-sub-cursor`, …). With 9Router running, use **Sync combos** / **Check combos** from the menu (dry-run and prune are prompted).

Auth prefers the local CLI token (`x-9r-cli-token` from `$DATA_DIR/machine-id` + `$DATA_DIR/auth/cli-secret`), then falls back to `INITIAL_PASSWORD` login (from Vault `9ROUTER_PASSWORD` via `.env` or `vault run`). `DATA_DIR` in `.env` always wins over ambient shell — defaults to `./data`.

Use the combo name as the model in Cursor / Claude Code / etc. (e.g. `9router-free` or `9router-max-sub-claude`). Providers must still be connected (**Sync providers** or the dashboard); missing tiers fall through at runtime.

If Cursor shows **Provider Error** with `providerStatusCode: 404`, 9Router usually has **no active credentials** for every tier in that combo — not a bad combo name. Run **Check combos** and **Sync providers**, then connect any remaining OAuth providers.

### Sync into Cursor

Cursor Agent/Chat calls your OpenAI base URL from **Cursor's cloud**, not from your Mac.
A localhost URL (`http://127.0.0.1:20128/v1`) always fails with:

`Access to private networks is forbidden`

**Sync Cursor** writes **`https://9router.chrisvouga.dev/v1`** by default (you can pick env or a custom URL when prompted). Keep daemons up (**Start daemons**) so that hostname reaches local 9Router.

```bash
npm start
# Start daemons → quit Cursor → Sync Cursor
```

Prompted options include dry-run, force while Cursor is open, prune removed combo names, base URL choice, and allow-private (Agent will still 403 on localhost).

Then reopen Cursor and select a combo (e.g. `9router-free`, `9router-max-sub-claude`) in the model picker.

If Cursor errors with the private-networks message, the synced base URL is still private — re-run **Sync Cursor** without allowing private URLs. If the hostname is correct but requests hang, run **Status** and ensure both daemons are up.

Progress is logged as `[sync-cursor] …` steps. Backup is row-level only (the keys Sync Cursor changes), not a copy of the full `state.vscdb` — important when that file is very large.

## Layout

| Path | Purpose |
| ---- | ------- |
| `package.json` | `npm start` / `npm run cli` / bin `9router` |
| `cli/` | Interactive CLI (menus, prompts, commands) |
| `combos.yaml` | Declarative LLM combo catalog |
| `providers.yaml` | Provider sync methods + Vault key overrides |
| `app/` | Gitignored clone of `decolua/9router` |
| `data/` | Persistent app data (`DATA_DIR`) |
| `.env` | Secrets (gitignored); copy from `.env.example` or Pull secrets |
| `.cloudflared/` | Generated named-tunnel config (gitignored) |
| `.pids/` | Daemon pid + log files + CLI history (gitignored) |
| `scripts/lib/` | Shared libraries used by the CLI |
| `scripts/oauth-redirect-patch.ts` | Claude OAuth redirect patch applied after Build app |

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

**Pull into `.env`:** `npm start` → **Pull secrets**

**Or inject at runtime** (no `.env` write; uses [`9router/.vault.yaml`](.vault.yaml)):

```bash
vault run -- npm start
```

The CLI auto-fetches from Vault when secrets are missing (`ensureAppSecrets`). Provider API keys / OAuth tokens stay in Vault KV (or local auto-import) — Sync providers reads them without writing into `.env`. Cloudflare tunnel cert/credentials stay machine-local (`cloudflared tunnel login` + Provision tunnel).

## Notes

- Upstream: `https://github.com/decolua/9router` (override with `NINEROUTER_REPO_URL` / `NINEROUTER_BRANCH`).
- Listens on `HOSTNAME`/`PORT` from `.env` (defaults `0.0.0.0:20128`).
- `9router.chrisvouga.dev` is a Cloudflare named tunnel only — not in fleet `services.yaml` / `sync-dns`.
