import { NODE_SSH_VAULT_KEYS, type NodeSshCredentials } from "./node-ssh.js";

export const DEFAULT_VAULT_ADDR = "https://vault.chrisvouga.dev";
/** Fly API host used until custom-domain DNS is live on the droplet. */
export const FALLBACK_VAULT_ADDR = "https://vault-chrisvouga.fly.dev";
const VAULT_KV_PATH = "secret/data/personal/prd";

export function resolveVaultAddr(explicit?: string): string {
  return (explicit?.trim() || process.env.VAULT_ADDR?.trim() || DEFAULT_VAULT_ADDR).replace(
    /\/$/,
    "",
  );
}

async function vaultAddr(): Promise<string> {
  const preferred = resolveVaultAddr();
  try {
    const res = await fetch(
      `${preferred}/v1/sys/health?standbyok=true&sealedcode=200&uninitcode=200`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (res.ok) return preferred;
  } catch {
    /* custom domain unavailable */
  }
  return FALLBACK_VAULT_ADDR;
}

function vaultToken(): string {
  const token = process.env.VAULT_TOKEN?.trim();
  if (!token) throw new Error("VAULT_TOKEN is required to write Vault secrets");
  return token;
}

export async function vaultKvPatch(fields: Record<string, string>): Promise<void> {
  const addr = await vaultAddr();
  const res = await fetch(`${addr}/v1/${VAULT_KV_PATH}`, {
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
