import { NODE_SSH_VAULT_KEYS, type NodeSshCredentials } from "./node-ssh.js";

export const DEFAULT_VAULT_ADDR = "https://vault-chrisvouga.fly.dev";
/** Custom domain — DNS broken; API calls should use {@link DEFAULT_VAULT_ADDR}. */
export const LEGACY_VAULT_ADDR = "https://vault.chrisvouga.dev";
const VAULT_KV_PATH = "secret/data/personal/prd";

/** Prefer Fly API host; remap legacy custom domain until DNS is fixed. */
export function resolveVaultAddr(explicit?: string): string {
  const raw = (explicit?.trim() || process.env.VAULT_ADDR?.trim() || DEFAULT_VAULT_ADDR).replace(
    /\/$/,
    "",
  );
  if (raw === LEGACY_VAULT_ADDR) return DEFAULT_VAULT_ADDR;
  return raw;
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
