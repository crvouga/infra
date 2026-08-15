import {
  ENV_FILE,
  REPO_ROOT,
  SECRET_KEYS,
  type SecretKey,
} from "./lib/paths.ts";
import { ensureEnvFile, upsertEnv } from "./lib/env.ts";
import { requireCmd, run } from "./lib/spawn.ts";

type VaultKvConfig = "dev" | "prd";

function authHelp(kvPath: string): void {
  console.error(`
Vault auth failed (token missing, expired, or lacks read on ${kvPath}).

Fix one of:
  1. Re-login, then retry:
       vault login -method=userpass username=crvouga
       # or: vault login <root-or-dev-token>
       npm run pull-secrets

  2. Inject via vault run (same login required):
       vault run -- npm run pull-secrets

  3. Create a scoped read token (needs an admin/root session first):
       cd ${REPO_ROOT}/vault && ./scripts/create-dev-token.sh
       vault login <printed-token>

  4. Or paste the four keys into ${ENV_FILE} manually (see .env.example).
`);
}

function allSecretsFromEnv(): Record<SecretKey, string> | null {
  const out = {} as Record<SecretKey, string>;
  for (const key of SECRET_KEYS) {
    const value = process.env[key]?.trim();
    if (!value) return null;
    out[key] = value;
  }
  return out;
}

async function vaultGetViaApi(config: VaultKvConfig): Promise<Record<string, string>> {
  const token = process.env.VAULT_TOKEN?.trim();
  if (!token) throw new Error("VAULT_TOKEN not set");
  const addr = (
    process.env.VAULT_ADDR?.trim() ||
    "https://vault.chrisvouga.dev"
  ).replace(/\/$/, "");
  const path = `secret/data/personal/${config}`;
  const res = await fetch(`${addr}/v1/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vault GET ${path} failed (${res.status}): ${text}`);
  }
  const body = (await res.json()) as { data?: { data?: Record<string, string> } };
  return body.data?.data ?? {};
}

function vaultGetViaCli(config: VaultKvConfig): Record<string, string> {
  requireCmd("vault");
  const kvPath = `secret/personal/${config}`;
  const result = run("vault", ["kv", "get", "-format=json", kvPath], { allowFail: true });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    const err = new Error(detail || `vault kv get ${kvPath} failed`);
    (err as Error & { vaultDetail?: string }).vaultDetail = detail;
    throw err;
  }
  const body = JSON.parse(result.stdout) as { data?: { data?: Record<string, string> } };
  return body.data?.data ?? {};
}

async function main(): Promise<void> {
  const config = (process.env.VAULT_KV_CONFIG?.trim() || "prd") as VaultKvConfig;
  const kvPath = `secret/personal/${config}`;

  ensureEnvFile();

  const fromEnv = allSecretsFromEnv();
  if (fromEnv) {
    console.log("==> Using secrets from environment");
    for (const key of SECRET_KEYS) {
      upsertEnv(key, fromEnv[key]);
      console.log(`  wrote ${key}`);
    }
    console.log(`Done. Secrets written to ${ENV_FILE}`);
    return;
  }

  console.log(`==> Reading secrets from ${kvPath}...`);

  let data: Record<string, string> = {};
  let lastError = "";
  try {
    data = await vaultGetViaApi(config);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    try {
      data = vaultGetViaCli(config);
      lastError = "";
    } catch (cliErr) {
      lastError =
        (cliErr as Error & { vaultDetail?: string }).vaultDetail ||
        (cliErr instanceof Error ? cliErr.message : String(cliErr));
      console.error(`ERROR: could not read ${kvPath}`);
      if (lastError) {
        for (const line of lastError.split(/\r?\n/)) console.error(`  ${line}`);
      }
      authHelp(kvPath);
      process.exit(1);
    }
  }

  if (Object.keys(data).length === 0) {
    console.error(`ERROR: no data at ${kvPath}`);
    if (/permission denied|403/i.test(lastError)) authHelp(kvPath);
    else console.error("  Seed the four keys in Vault or set them in .env manually.");
    process.exit(1);
  }

  let missing = 0;
  for (const key of SECRET_KEYS) {
    const value = data[key]?.trim();
    if (!value) {
      console.error(`  missing ${key} in ${kvPath}`);
      missing = 1;
      continue;
    }
    upsertEnv(key, value);
    console.log(`  wrote ${key}`);
  }

  if (missing) {
    console.error(
      "ERROR: one or more secrets missing from Vault. Seed KV or set them in .env manually.",
    );
    process.exit(1);
  }

  console.log(`Done. Secrets written to ${ENV_FILE}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
