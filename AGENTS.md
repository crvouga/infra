# Agent Notes

## Hard Rules

- **Never patch dependencies.** CI should reject bun/pnpm patch mechanisms.
- **Never disable structural size limits** in eslint config or source files. Refactor instead.

## Architecture

Self-hosted Turborepo Remote Cache on the chrisvouga.dev origin stack (Docker + Bun). Artifacts live in Backblaze B2 via `@pkgs/object-store` (`createS3ObjectStore` → `ObjectStoreImplS3`). Physical object keys are always `turbo-cache/prd/<artifact-hash>` in the shared bucket. Runtime secrets load from Vault at boot.

CI publishes a **public** image to **GHCR** (`ghcr.io/crvouga/chrisvouga-turborepo:<sha>`); infra deploy-pipeline pulls and runs it. If the package is new, set GHCR visibility to public once in GitHub package settings.

## Vault secrets (source of truth)

Canonical registry: [`scripts/vault-secrets-registry.ts`](scripts/vault-secrets-registry.ts)

| Config | Purpose                                       |
| ------ | --------------------------------------------- |
| `dev`  | Local dev + CI (`check:vault-secrets`)        |
| `prd`  | Production deploy (`check:vault-secrets:prd`) |

Both configs must carry the same required keys. `bun run setup` runs `ensure-vault-secrets.ts` to write derived defaults (`TURBO_API`, `TURBO_TEAM`, `TURBO_CACHE`) into **dev** and **prd** when missing.

Required keys (manual): `TURBO_TOKEN`, `VAULT_TOKEN`, B2 `B2_*`.

## Scripts

| Script                            | Purpose                                            |
| --------------------------------- | -------------------------------------------------- |
| `bun run setup`                   | `apps/api/.env` + ensure Vault defaults in dev/prd |
| `bun run check:vault-secrets`     | Verify dev config (CI gate)                        |
| `bun run check:vault-secrets:prd` | Verify prd config (deploy gate)                    |
| `bun run deploy`                  | Points to infra publish-image workflow             |

## CI/CD

- **deployment-pipeline.yml** — Vault dev secrets (OIDC) + `bun run check` on every push/PR
- **publish-image.yml** — build + push GHCR image → dispatch infra deploy on main push

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
