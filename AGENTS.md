# Agent Notes

## Global resource naming (`crvouga-*`)

Fly.io apps, S3 buckets, and any other **globally unique** platform resource must use the `crvouga-` prefix.

| Resource | Pattern | Example |
| -------- | ------- | ------- |
| Fly.io app | `crvouga-<id>` | `crvouga-pgweb`, `crvouga-portfolio` |
| Fly.io default hostname | `crvouga-<id>.fly.dev` | `crvouga-filestash.fly.dev` |
| S3 bucket (when owned by this stack) | `crvouga-<purpose>` or existing shared bucket keys in Vault | — |

Derived from [`services.yaml`](services.yaml) → `fly.app_prefix` (currently `crvouga`) via `flyAppName()` in [`lib/services.ts`](lib/services.ts).

**Do not** use suffix-style names like `pgweb-chrisvouga` or zone-slug prefixes for Fly apps — they drift from the rest of the fleet and break DNS/setup scripts that expect `crvouga-<id>.fly.dev`.

Public DNS hostnames stay on the zone (`pgweb.chrisvouga.dev`, etc.); only the Fly app name and `*.fly.dev` target use `crvouga-*`.

## Admin Fly apps (pgweb, filestash)

- Dockerfiles and deploy live under `pgweb/` and `filestash/` (not GHCR).
- Setup: `bun run setup-pgweb-filestash` — idempotent Fly/Vault/DNS bootstrap.
- Deploy: `bun run deploy-pgweb-filestash --app <pgweb|filestash>` or **Deploy Pipeline** on `main`.
- App names: `crvouga-pgweb`, `crvouga-filestash` (see naming table above).

## Hard rules

- Never commit `VAULT_TOKEN`, `FLY_TOKEN`, or deploy tokens.
- Vault KV paths for runtime: `secret/data/personal/{dev|prd}`.
- Generated `fly/<id>/fly.toml` files — do not edit by hand; run `bun run generate-fly`.
