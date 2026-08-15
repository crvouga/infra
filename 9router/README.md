# 9router (local Node/npm)

Runs [decolua/9router](https://github.com/decolua/9router) from a local clone on **http://127.0.0.1:20128**. Not part of the Railway fleet. Tooling is TypeScript + npm (`tsx`).

## Prerequisites

- Node.js 18+ and npm
- Vault access for secrets — a valid login session (`vault login`) with read on `secret/personal/prd`

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
npm run up
```

Or step by step:

```bash
npm run pull-secrets
npm run sync-app
npm run install-app
npm run build
npm run up
```

Health check: http://127.0.0.1:20128/api/health

## Day-to-day

```bash
npm run up       # start app in the foreground (Ctrl-C to stop)
npm run down     # stop PID if left behind
npm run status   # show running pid
npm run build    # rebuild after sync-app / upstream updates
```

## Layout

| Path | Purpose |
| ---- | ------- |
| `package.json` | npm scripts (`tsx`) for all ops |
| `app/` | Gitignored clone of `decolua/9router` |
| `data/` | Persistent app data (`DATA_DIR`) |
| `.env` | Secrets (gitignored); copy from `.env.example` or `npm run pull-secrets` |
| `scripts/*.ts` | TypeScript tooling |
| `scripts/oauth-redirect-patch.ts` | Claude OAuth redirect patch applied after `npm run build` |

## Secrets

Stored in Vault at `secret/personal/prd` (override with `VAULT_KV_CONFIG=dev`):

- `JWT_SECRET`
- `INITIAL_PASSWORD`
- `API_KEY_SECRET`
- `MACHINE_ID_SALT`

## Notes

- Upstream: `https://github.com/decolua/9router` (override with `NINEROUTER_REPO_URL` / `NINEROUTER_BRANCH`).
- Listens on `HOSTNAME`/`PORT` from `.env` (defaults `0.0.0.0:20128`).
