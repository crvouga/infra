# Prompt: Migrate a project from Doppler to self-hosted OpenBao/Vault

Copy everything below the line into your coding agent, running it **inside the
project repo you want to migrate**.

---

You are migrating this project off **Doppler** and onto a **self-hosted
OpenBao/Vault** instance. Doppler is being decommissioned; this repo must read
its secrets from the self-hosted store instead.

## Fixed coordinates for this setup

- Doppler project: always **`personal`**
- Doppler configs / environments: **`dev`** and **`prd`** (only these two)
- Store paths: `secret/personal/dev` and `secret/personal/prd`
- Default config for this repo: `dev` (use `prd` for production commands)

Use these values directly — do not ask me for the project or config names.

## Facts about the target store (do not change these)

- Vault/OpenBao API address: `https://secret-store.chrisvouga.dev`
- Secrets engine: **KV v2**, mounted at `secret/`
- Path convention: `secret/<project>/<config>` → here `secret/personal/dev`
  and `secret/personal/prd`
  - Each Doppler key is a **field** on that secret; reserved `DOPPLER_*` keys
    are not migrated
- The store ships a Doppler-style CLI wrapper (from the `secret-store` repo)
  that adds two subcommands on top of the real `vault`/`bao` binary:
  - `vault setup --project <p> --config <c>` → writes `.vault.yaml`
  - `vault run -- <command>` → injects the secret's fields as env vars, then
    runs `<command>`
  - All other `vault` subcommands pass through to the real binary
- **GitHub Actions OIDC is already configured** on the store, so CI needs no
  stored token. Use these exact coordinates:
  - Auth mount / method: `jwt` (JWT, trusts GitHub's OIDC issuer)
  - Role: `github-actions`
  - Policy: `ci-read` (read-only on `secret/personal/*`)
  - Bound audience: `https://secret-store.chrisvouga.dev`
  - Allowed repos: `crvouga/*` (any branch); tokens are short-lived (15m / 30m max)
- **Apps that read secrets at runtime** authenticate differently. A
  long-running server, Cloudflare Worker / edge function, or anything that
  can't wrap its start command in `vault run` and can't use OIDC reads the
  store with a **long-lived, read-only `VAULT_TOKEN`** provisioned as a
  platform secret (e.g. a Wrangler secret or a hosting-provider env var). Such
  an app calls the KV v2 HTTP API directly:
  - `GET {addr}/v1/{mount}/data/{project}/{config}` with header
    `X-Vault-Token: <token>` → response `{ "data": { "data": { KEY: VALUE, … } } }`
    (fields live under `.data.data`)
  - here: `GET https://secret-store.chrisvouga.dev/v1/secret/data/personal/<config>`
  - The token must be **read-only** (policy `ci-read`: read on
    `secret/data/personal/*`). See step 7.

## Doppler → this setup mapping

| Doppler                       | This setup                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `doppler login`               | `vault login hvs.xxx` (or a scoped dev token)                                     |
| `doppler setup`               | `vault setup --project personal --config dev`                                     |
| `doppler run -- <cmd>`        | `vault run -- <cmd>`                                                              |
| `doppler.yaml`                | `.vault.yaml`                                                                     |
| `DOPPLER_TOKEN` (CI)          | GitHub Actions OIDC (no stored token) — see step 6                                |
| `DOPPLER_TOKEN` (app runtime) | long-lived read-only `VAULT_TOKEN` platform secret + KV v2 HTTP read — see step 7 |

## Goal

**Completely remove Doppler and fully replace it with the self-hosted Vault.**
After migration the project must fetch all secrets from `secret/personal/<config>`
via `vault run` (or, for apps that read secrets at runtime, the KV v2 HTTP read
in step 7), and there must be **zero** remaining references to Doppler
anywhere in the repo — no `doppler` CLI usage, config files, dependencies, CI
steps, install steps, env vars, or documentation. Behavior (the set of env vars
the app sees) must be unchanged. A repo-wide search for `doppler` / `DOPPLER`
(case-insensitive) must return nothing once you are done.

## Steps

1. **Audit Doppler usage.** Find every reference in the repo and list them
   before editing. Search for: `doppler.yaml` / `doppler.yml`, `doppler run`,
   `doppler secrets`, `DOPPLER_TOKEN`, `DOPPLER_` env vars, and any mention in
   `package.json` scripts, `Makefile`, `Justfile`, Dockerfiles, shell scripts,
   CI workflows (`.github/`, `.gitlab-ci.yml`, etc.), and docs/READMEs.

2. **Confirm prerequisites (instruct me if missing).** The `vault` wrapper must
   be installed and on `PATH`, and the Vault CLI/OpenBao binary must be present.
   Installed once from the `secret-store` repo:

   ```bash
   ./scripts/install-cli.sh          # installs wrapper to ~/.local/bin/vault
   vault login hvs.your-root-token   # or: ./scripts/create-dev-token.sh
   ```

   Do not attempt to install global tooling yourself — tell me the exact
   commands to run if they are missing.

3. **Ensure secrets exist in the store.** If `secret/personal/dev` or
   `secret/personal/prd` is missing, do NOT invent values. Tell me to run the
   migration helper from the `secret-store` repo, then continue once it reports
   success:

   ```bash
   ./scripts/vault-run.sh -- ./scripts/migrate-doppler-to-openbao.sh \
     --project personal --dry-run        # preview
   ./scripts/vault-run.sh -- ./scripts/migrate-doppler-to-openbao.sh \
     --project personal                  # write (upsert)
   ```

4. **Create `.vault.yaml`** at the repo root (replacing `doppler.yaml`). It
   contains no secrets, only the path coordinates, and is safe to commit:

   ```yaml
   addr: https://secret-store.chrisvouga.dev
   mount: secret
   project: personal
   config: dev # default; use prd for production commands
   ```

5. **Replace runtime commands.** Swap every `doppler run -- <cmd>` for
   `vault run -- <cmd>` in scripts, `package.json`, `Makefile`, Dockerfiles,
   etc. The default config is `dev`; for production use
   `vault run --config prd -- <cmd>`.

6. **Update CI (GitHub Actions OIDC — no stored token).** Do NOT add a
   `VAULT_TOKEN` secret. The store has a JWT auth method that trusts GitHub's
   OIDC issuer, so CI authenticates with a short-lived token minted per run.

   Remove `DOPPLER_TOKEN` and pull secrets via OIDC instead. Grant the job the
   OIDC permission and use `hashicorp/vault-action` (works against OpenBao):

   ```yaml
   permissions:
     id-token: write # required to request a GitHub OIDC token
     contents: read

   steps:
     - uses: hashicorp/vault-action@v3
       with:
         url: https://secret-store.chrisvouga.dev
         method: jwt
         path: jwt
         role: github-actions
         secrets: |
           secret/data/personal/prd OPENAI_API_KEY | OPENAI_API_KEY ;
           secret/data/personal/prd DATABASE_URL   | DATABASE_URL
   ```

   Any repo under `crvouga/*` is already allowed by the role's bound claims, so
   no extra setup should be needed. If `vault-action` fails with an audience
   error, add `jwtGithubAudience: https://secret-store.chrisvouga.dev` to the
   step. If it fails with a role/permission error (e.g. a repo outside
   `crvouga/*`), tell me to authorize it from the `secret-store` repo:

   ```bash
   ./scripts/setup-oidc-auth.sh --repo crvouga/<this-repo>
   ```

   Never hardcode tokens or add a `VAULT_TOKEN`/`DOPPLER_TOKEN` CI secret.

7. **Handle apps that read secrets at runtime (long-lived token).** Some
   processes can't be wrapped in `vault run` and can't use OIDC — e.g. a
   Cloudflare Worker / edge function, or a long-running server that fetches its
   own secrets at boot (anything that today reads `DOPPLER_TOKEN` and downloads
   from Doppler over HTTP). For these, provision a **long-lived, read-only
   `VAULT_TOKEN`** as a platform secret (a direct replacement for the old
   `DOPPLER_TOKEN`) and have the app read the KV v2 HTTP API directly:
   - Read the whole path once at boot and serve every field from it:

     ```
     GET https://secret-store.chrisvouga.dev/v1/secret/data/personal/<config>
     X-Vault-Token: <VAULT_TOKEN>
     ```

     Response shape: `{ "data": { "data": { "KEY": "VALUE", … } } }` — the
     fields live under `.data.data`. Map each field to the same env-var name the
     app reads today; behavior (the set of vars the app sees) must be unchanged.

   - Replace the old Doppler HTTP download / `DOPPLER_TOKEN` plumbing with this
     read. Where the app referenced `DOPPLER_TOKEN`/`DOPPLER_PROJECT`/
     `DOPPLER_CONFIG`, use `VAULT_TOKEN`, `VAULT_CONFIG`, and optionally
     `VAULT_ADDR`/`VAULT_PROJECT` (default project `personal`, mount `secret`,
     addr `https://secret-store.chrisvouga.dev`).
   - Store the token (and `VAULT_CONFIG`) as platform secrets, never in git —
     e.g. `wrangler secret put VAULT_TOKEN` for a Worker, or your host's secret
     / env-var mechanism otherwise.
   - The token must be **read-only**. Tell me to mint it from the `secret-store`
     repo and install it (do not generate or hardcode one yourself):

     ```bash
     ./scripts/create-dev-token.sh   # periodic, read-only token for runtime use
     ```

   - This long-lived token is the **only** acceptable static token, and only for
     app runtime. Local dev still uses `vault login`; CI still uses OIDC (step 6).

8. **Update docs.** Fix README/setup instructions to describe `vault login`,
   `vault setup`, and `vault run` instead of the Doppler equivalents. If the app
   reads secrets at runtime (step 7), document how the `VAULT_TOKEN` platform
   secret is provisioned.

9. **Verify (no secret values printed).** Confirm the env var names the app
   expects are present:

   ```bash
   vault run --dry-run -- <app-start-command>   # prints env var NAMES only
   ```

   Compare the name list against what the app reads (e.g. references to
   `process.env.*`, `os.environ[...]`, etc.). Investigate any missing keys —
   they may be `DOPPLER_*` reserved keys (intentionally excluded) or may need to
   be added to the secret. For runtime apps (step 7), also confirm the HTTP read
   resolves the same field names (without printing values).

10. **Completely remove Doppler.** Once verified, eradicate every trace of
    Doppler from the repo:
    - Delete `doppler.yaml` / `doppler.yml` (and any `.doppler` files).
    - Remove the `doppler` CLI from dependencies and lockfiles (`package.json`,
      `Brewfile`, `requirements`, etc.) and from any `mise`/`asdf`/tool configs.
    - Remove every Doppler install/setup step from Dockerfiles, CI workflows,
      scripts, and Makefiles.
    - Drop `DOPPLER_TOKEN` and any other `DOPPLER_*` vars from CI secrets,
      `.env*` files, and `.env.example` files.
    - Strip all Doppler mentions from READMEs and docs, replacing them with the
      `vault login` / `vault setup` / `vault run` equivalents.
    - Finally, run a repo-wide case-insensitive search for `doppler` and confirm
      there are **no** matches left (call out anything intentionally kept).

## Constraints

- Read-only against Doppler; never write secrets back to Doppler.
- Never print secret values, commit tokens, or hardcode credentials.
- `.vault.yaml` is safe to commit (no secrets). `VAULT_TOKEN` and any
  `init-output.json` / `.vault-token` are NOT — keep them out of git.
- CI must use GitHub Actions OIDC (step 6), not a stored `VAULT_TOKEN`. A
  static / long-lived token is only acceptable for (a) local/manual use
  (`vault login`) and (b) app runtime that can't use the CLI or OIDC (step 7) —
  and there it must be read-only and stored as a platform secret, never committed.
- Make the smallest changes needed; do not refactor unrelated code.

## Deliverable

When done, output:

1. A list of every file changed and why.
2. The final `.vault.yaml`.
3. If the app reads secrets at runtime (step 7): the exact KV v2 read path it
   uses and how the read-only `VAULT_TOKEN` is supplied (which platform secret).
4. The verification result from step 9 (env var names matched / any gaps).
5. Proof that Doppler is fully removed: the output of a repo-wide
   case-insensitive search for `doppler` showing no remaining matches (or an
   explicit justification for anything intentionally kept).
6. A checklist of anything left for me to do manually (auth, authorizing this
   repo for OIDC via `setup-oidc-auth.sh`, running the migration helper,
   provisioning the runtime read-only `VAULT_TOKEN` via `create-dev-token.sh` +
   `wrangler secret put VAULT_TOKEN`).
