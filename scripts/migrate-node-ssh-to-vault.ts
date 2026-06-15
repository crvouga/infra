#!/usr/bin/env bun
/**
 * One-time copy of node SSH credentials into Vault.
 *
 * Reads from NODE_SSH_* or legacy MIGRATE_FROM_LEGACY_NODE_SSH_* env vars.
 *
 * Usage:
 *   export VAULT_TOKEN=$(vault print token)
 *   export MIGRATE_FROM_LEGACY_NODE_SSH_HOST=1.2.3.4
 *   export MIGRATE_FROM_LEGACY_NODE_SSH_USER=root
 *   export MIGRATE_FROM_LEGACY_NODE_SSH_KEY="$(cat ~/.ssh/id_ed25519)"
 *   bun run scripts/migrate-node-ssh-to-vault.ts
 */
import { nodeSshFromEnv, setNodeSshEnv } from "../lib/node-ssh.js";
import { writeNodeSshToVault } from "../lib/vault-kv.js";

function credsFromLegacyEnv() {
  const host = process.env.MIGRATE_FROM_LEGACY_NODE_SSH_HOST?.trim();
  const user = process.env.MIGRATE_FROM_LEGACY_NODE_SSH_USER?.trim() || "root";
  const privateKey = process.env.MIGRATE_FROM_LEGACY_NODE_SSH_KEY?.trim();
  if (!host || !privateKey) return null;
  return { host, user, privateKey };
}

async function main(): Promise<void> {
  const creds = nodeSshFromEnv() ?? credsFromLegacyEnv();
  if (!creds) {
    console.error(
      "Set NODE_SSH_* or MIGRATE_FROM_LEGACY_NODE_SSH_* (host, user, key) in the environment.",
    );
    process.exit(2);
  }

  await writeNodeSshToVault(creds);
  setNodeSshEnv(creds);
  console.log("Wrote NODE_SSH_* to Vault (secret/data/personal/prd)");
  console.log(`  host: ${creds.host}`);
  console.log(`  user: ${creds.user}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
