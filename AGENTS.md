# Agent Notes

## Hard Rules

- **Never patch dependencies.** CI should reject bun/pnpm patch mechanisms.
- **Never disable structural size limits** in eslint config or source files. Refactor instead.

## Architecture

Self-hosted Turborepo Remote Cache on Fly.io (Docker + Bun). Artifacts live in Backblaze B2 via `@pkgs/object-store` (`ObjectStoreImplS3`). Only `VAULT_TOKEN` is a Fly secret; B2 creds and `TURBO_TOKEN` load from Vault at boot.

## Vault secrets (source of truth)

Canonical registry: [`scripts/vault-secrets-registry.ts`](scripts/vault-secrets-registry.ts)

| Config | Purpose                                                         |
| ------ | --------------------------------------------------------------- |
| `dev`  | Local dev + CI (`check:vault-secrets`)                          |
| `prd`  | Production deploy (`check:vault-secrets:prd`, `bun run deploy`) |

Both configs must carry the same required keys. `bun run setup` runs `ensure-vault-secrets.ts` to write derived defaults (`TURBO_API`, `TURBO_TEAM`, `TURBO_CACHE`) into **dev** and **prd** when missing.

Required keys (manual): `TURBO_TOKEN`, `VAULT_TOKEN`, B2 `B2_*`, `FLY_API_TOKEN`, `CLOUDFLARE_API_TOKEN`.

## Scripts

| Script                            | Purpose                                            |
| --------------------------------- | -------------------------------------------------- |
| `bun run setup`                   | `apps/api/.env` + ensure Vault defaults in dev/prd |
| `bun run check:vault-secrets`     | Verify dev config (CI gate)                        |
| `bun run check:vault-secrets:prd` | Verify prd config (deploy gate)                    |
| `bun run deploy`                  | Local: Fly build+deploy; CI: full pipeline         |

## CI/CD

Single workflow: `.github/workflows/deployment-pipeline.yml`

1. **check** — Vault dev secrets (OIDC) + `bun run check` on every push/PR
2. **deploy** — Vault prd secrets (OIDC) + GHCR push + Fly deploy on main push only (parallel with check, not gated on it)

Deploy is fully automated from Vault (`apps/api/scripts/fly-deploy.ts` + `scripts/cloudflare-dns.ts`): app creation, `VAULT_TOKEN` sync, TLS cert, Cloudflare DNS upsert, image deploy.

## Client usage

```bash
export TURBO_API=https://turborepo.chrisvouga.dev
export TURBO_TOKEN=<same as Vault TURBO_TOKEN>
export TURBO_TEAM=local
turbo run build --cache=remote:rw
```

## Local dev

```bash
bun install
vault setup --project personal --config dev
bun run setup
bun run dev # bun server :8787
```
