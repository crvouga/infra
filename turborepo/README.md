# turborepo-remote-cache

Self-hosted [Turborepo Remote Cache](https://turbo.build/docs/core-concepts/remote-caching) on the chrisvouga.dev origin stack with Backblaze B2 object storage.

**Domain:** `https://turborepo.chrisvouga.dev`

## Setup

1. Install the `vault` wrapper + OpenBao/Vault CLI from the `secret-store` repo, then authenticate:

```bash
./scripts/install-cli.sh
vault login hvs.your-root-token   # or: ./scripts/create-dev-token.sh
vault setup --project personal --config dev
```

2. Run bootstrap (writes `apps/api/.env` + ensures derived defaults in Vault `dev` and `prd`):

```bash
bun install
bun run setup
```

3. Set remaining **required** secrets in both Vault configs (`dev` and `prd`). See [`scripts/vault-secrets-registry.ts`](scripts/vault-secrets-registry.ts) for the full list and hints:
   - `TURBO_TOKEN` — bearer token for Turbo clients and the cache server
   - `VAULT_TOKEN` — long-lived Vault read token (runtime secret loading)
   - B2 keys: `B2_S3_ENDPOINT`, `B2_S3_REGION`, `B2_S3_ACCESS_KEY_ID`, `B2_S3_SECRET_ACCESS_KEY`, `B2_BUCKET`

   Derived defaults (`TURBO_API`, `TURBO_TEAM`, `TURBO_CACHE`) are applied by `setup` when missing.

4. Verify secrets:

```bash
bun run check:vault-secrets        # dev (CI uses this)
bun run check:vault-secrets:prd    # prd (deploy uses this)
```

5. Deploy:

```bash
bun run deploy
```

Production deploys run via **CI turborepo** (publish job) → **Deploy fleet** on push to `main`.

## Turbo client config

Vault should define (or `setup` defaults):

```bash
export TURBO_API=https://turborepo.chrisvouga.dev
export TURBO_TOKEN=<same as Vault TURBO_TOKEN>
export TURBO_TEAM=local
export TURBO_CACHE=remote:rw
```

## Development

```bash
bun run dev    # bun server on :8787
bun run check  # format + tc + lint + test + build
```

## CI/CD

- **deployment-pipeline.yml** — every push/PR: Vault `dev` secrets gate + `bun run check`
- **publish-image.yml** — push to `main`: build `ghcr.io/crvouga/chrisvouga-turborepo` → dispatch infra deploy

CI authenticates via GitHub OIDC (`hashicorp/vault-action`); no GitHub repo secrets required.

## Layout

- `apps/api` — Hono cache server (Turborepo `/v8/artifacts/*` API) + Dockerfile
- `pkgs/object-store` — swappable blob storage (`ObjectStoreImplS3` for B2)
- `pkgs/secret-store` — Vault secret loading at server boot
- `scripts/vault-secrets-registry.ts` — source of truth for expected Vault keys
