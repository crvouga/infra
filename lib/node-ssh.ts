/** Vault KV field names for the chrisvouga.dev origin node SSH credentials. */
export const NODE_SSH_VAULT_KEYS = {
  host: "CHRISVOUGA_DEV_NODE_SSH_HOST",
  user: "CHRISVOUGA_DEV_NODE_SSH_USER",
  key: "CHRISVOUGA_DEV_NODE_SSH_KEY",
} as const;

export type NodeSshCredentials = {
  readonly host: string;
  readonly user: string;
  readonly privateKey: string;
};

export function nodeSshHostFromEnv(): string | null {
  const host = process.env[NODE_SSH_VAULT_KEYS.host]?.trim();
  return host || null;
}

export function nodeSshFromEnv(): NodeSshCredentials | null {
  const host = process.env[NODE_SSH_VAULT_KEYS.host]?.trim();
  const user = process.env[NODE_SSH_VAULT_KEYS.user]?.trim();
  const privateKey = process.env[NODE_SSH_VAULT_KEYS.key]?.trim();
  if (!host || !user || !privateKey) return null;
  return { host, user, privateKey };
}

export function setNodeSshEnv(creds: NodeSshCredentials): void {
  process.env[NODE_SSH_VAULT_KEYS.host] = creds.host;
  process.env[NODE_SSH_VAULT_KEYS.user] = creds.user;
  process.env[NODE_SSH_VAULT_KEYS.key] = creds.privateKey;
}
