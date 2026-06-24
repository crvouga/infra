# Agent Notes

## Global resource naming (`crvouga-*`)

Railway services, S3 buckets, and any other **globally unique** platform resource must use the `crvouga-` prefix.

| Resource | Pattern | Example |
| -------- | ------- | ------- |
| Railway service | `crvouga-<id>` | `crvouga-portfolio`, `crvouga-vault` |
| GHCR image | `chrisvouga-<id>` | `ghcr.io/crvouga/chrisvouga-portfolio` |
| S3 bucket (when owned by this stack) | `crvouga-<purpose>` or existing shared bucket keys in Vault | — |

Derived from [`services.yaml`](services.yaml) → `railway.service_prefix` (currently `crvouga`) via `railwayServiceName()` in [`lib/services.ts`](lib/services.ts).

Public DNS hostnames stay on the zone (`portfolio.chrisvouga.dev`, etc.); Railway custom domains are provisioned via the GraphQL API and synced to Cloudflare.

## Standalone vault (`vault/`)

Vault is **`standalone: true`** in [`services.yaml`](services.yaml) — excluded from the fleet **Deploy Pipeline**, fleet DNS sync, and `destroy-fly`. It bootstraps from **GitHub repo secrets** (or exported env), not Vault KV / OIDC.

| Resource | Value |
| -------- | ----- |
| Railway service | `crvouga-vault` |
| Public hostname | `vault.chrisvouga.dev` |
| GHCR image | `ghcr.io/crvouga/chrisvouga-vault` |
| CI | **Vault deploy** (`.github/workflows/vault-deploy.yml`) on `vault/**` changes |

**Bootstrap order (first deploy or rebuild):**

1. Seed GitHub secrets: `RAILWAY_TOKEN`, `CF_API_TOKEN`, `DB_CONNECTION_URI` — `cd vault && ./scripts/seed-github-secrets.sh`
2. Deploy vault: push `vault/**` to `main`, or `cd vault && make gh` → run workflow
3. Init/unseal OpenBao locally (`vault/scripts/init.sh`); store keys in `crvouga.kv`
4. Seed KV at `secret/data/personal/prd` (Railway token, Cloudflare, per-app keys)
5. Fleet: `bun run provision-railway --apply` then **Deploy Pipeline**

**Local vault ops (Vault may be down — no `vault run`):**

```bash
export RAILWAY_TOKEN=... CLOUDFLARE_API_TOKEN=... DB_CONNECTION_URI=...
cd vault && make deploy    # provision + deploy; make provision | destroy | sync-dns
```

**Fleet ops (Vault must be up + KV seeded):**

```bash
vault login                    # admin session
vault run -- bun run sync-dns --apply
```

If `vault run` fails with `No value found at secret/personal/prd`, KV is empty — use direct env exports or `vault login` + CLI until prd is re-seeded. For day-to-day local work, `.vault.yaml` may use `config: dev` when prd is empty during a rebuild.

## Turborepo remote cache (`turborepo/`)

- Nested Bun monorepo; `cd turborepo && bun install` for local dev.
- CI: **Turborepo check** on `turborepo/**`; **Publish turborepo image** on API changes.
- Deploy: publish dispatches infra **Deploy Pipeline** for `crvouga-turborepo`.
- See [`turborepo/AGENTS.md`](turborepo/AGENTS.md) for secrets and client usage.

## Hard rules

- Never commit `VAULT_TOKEN`, `RAILWAY_TOKEN`, or deploy tokens.
- Vault KV paths for runtime: `secret/data/personal/{dev|prd}`.
- All Railway provisioning goes through GraphQL scripts (`provision-railway`, `deploy-railway`, `sync-railway-secrets`) — not manual dashboard edits.
