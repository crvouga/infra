import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { NODE_SSH_VAULT_KEYS, type NodeSshCredentials } from "./node-ssh.js";

export const DEFAULT_VAULT_ADDR = "https://vault.chrisvouga.dev";
const VAULT_KV_PATH = "secret/data/personal/prd";
/** KV v2 CLI path (no `/data/` segment). */
export const VAULT_KV_CLI_PATH = "secret/personal/prd";

export function resolveVaultAddr(explicit?: string): string {
  return (explicit?.trim() || process.env.VAULT_ADDR?.trim() || DEFAULT_VAULT_ADDR).replace(
    /\/$/,
    "",
  );
}

function vaultAddr(): string {
  return resolveVaultAddr();
}

function vaultToken(): string {
  const token = process.env.VAULT_TOKEN?.trim();
  if (!token) throw new Error("VAULT_TOKEN is required to write Vault secrets");
  return token;
}

export async function vaultKvPatch(fields: Record<string, string>): Promise<void> {
  const res = await fetch(`${vaultAddr()}/v1/${VAULT_KV_PATH}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${vaultToken()}`,
      "Content-Type": "application/merge-patch+json",
    },
    body: JSON.stringify({ data: fields }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vault PATCH ${VAULT_KV_PATH} failed (${res.status}): ${text}`);
  }
}

export async function writeNodeSshToVault(creds: NodeSshCredentials): Promise<void> {
  await vaultKvPatch({
    [NODE_SSH_VAULT_KEYS.host]: creds.host,
    [NODE_SSH_VAULT_KEYS.user]: creds.user,
    [NODE_SSH_VAULT_KEYS.key]: creds.privateKey,
  });
}

/** Requires an active `vault login` session (uses ~/.vault-token, not VAULT_TOKEN). */
export async function requireVaultCliAuth(vaultAddr?: string): Promise<void> {
  const addr = resolveVaultAddr(vaultAddr);
  const lookup = await $`vault token lookup -format=json`
    .env({ ...process.env, VAULT_ADDR: addr })
    .quiet()
    .nothrow();
  if (lookup.exitCode !== 0) {
    throw new Error(
      `Not authenticated to Vault at ${addr}. Run:\n  VAULT_ADDR=${addr} vault login -method=userpass username=crvouga`,
    );
  }
}

/** Patch KV secrets via the Vault CLI (`vault kv patch`). */
export async function vaultKvPatchCli(
  fields: Record<string, string>,
  vaultAddr?: string,
): Promise<void> {
  await requireVaultCliAuth(vaultAddr);
  const addr = resolveVaultAddr(vaultAddr);
  const dir = mkdtempSync(join(tmpdir(), "vault-kv-patch-"));
  const file = join(dir, "patch.json");
  try {
    writeFileSync(file, JSON.stringify(fields));
    const result = await $`vault kv patch ${VAULT_KV_CLI_PATH} @${file}`
      .env({ ...process.env, VAULT_ADDR: addr })
      .nothrow();
    if (result.exitCode !== 0) {
      const detail = result.stderr.toString().trim() || result.stdout.toString().trim();
      throw new Error(`vault kv patch ${VAULT_KV_CLI_PATH} failed: ${detail}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
