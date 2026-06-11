import { NODE_SSH_VAULT_KEYS, type NodeSshCredentials } from "./node-ssh.js";

const DEFAULT_VAULT_ADDR = "https://vault-chrisvouga.fly.dev";
const VAULT_KV_PATH = "secret/data/personal/prd";

function vaultAddr(): string {
  return process.env.VAULT_ADDR?.trim() || DEFAULT_VAULT_ADDR;
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
      "Content-Type": "application/json",
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
