#!/usr/bin/env bun
/**
 * One-time migration: copy CHRISVOUGA_DEV_NODE_SSH_* → NODE_SSH_* in Vault.
 *
 * Usage:
 *   vault login
 *   bun run scripts/migrate-vault-node-ssh-keys.ts
 *   bun run scripts/migrate-vault-node-ssh-keys.ts -- --delete-legacy
 */
import { LEGACY_NODE_SSH_VAULT_KEYS, NODE_SSH_VAULT_KEYS } from "../lib/node-ssh.js";
import {
  resolveVaultAddr,
  vaultKvGetCli,
  vaultKvPatchCli,
  vaultKvDeleteKeysCli,
} from "../lib/vault-kv.js";
import { loadServicesConfig, vaultAddr } from "../lib/services.js";

function parseArgs(argv: readonly string[]): { deleteLegacy: boolean } {
  let deleteLegacy = false;
  for (const arg of argv) {
    if (arg === "--delete-legacy") deleteLegacy = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun run scripts/migrate-vault-node-ssh-keys.ts [--delete-legacy]",
      );
      process.exit(0);
    }
  }
  return { deleteLegacy };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadServicesConfig();
  const addr = resolveVaultAddr(vaultAddr(config));
  const data = await vaultKvGetCli(addr);

  const host = data[LEGACY_NODE_SSH_VAULT_KEYS.host]?.trim();
  const user = data[LEGACY_NODE_SSH_VAULT_KEYS.user]?.trim();
  const key = data[LEGACY_NODE_SSH_VAULT_KEYS.key]?.trim();

  const newHost = data[NODE_SSH_VAULT_KEYS.host]?.trim();
  if (newHost) {
    console.log("NODE_SSH_* keys already present in Vault — nothing to migrate");
    if (args.deleteLegacy) {
      await vaultKvDeleteKeysCli(Object.values(LEGACY_NODE_SSH_VAULT_KEYS), addr);
      console.log("Deleted legacy CHRISVOUGA_DEV_NODE_SSH_* keys");
    }
    return;
  }

  if (!host || !user || !key) {
    console.error(
      "Legacy CHRISVOUGA_DEV_NODE_SSH_* keys not found in Vault. Set NODE_SSH_* manually or provision the node.",
    );
    process.exit(2);
  }

  await vaultKvPatchCli(
    {
      [NODE_SSH_VAULT_KEYS.host]: host,
      [NODE_SSH_VAULT_KEYS.user]: user,
      [NODE_SSH_VAULT_KEYS.key]: key,
    },
    addr,
  );
  console.log("Wrote NODE_SSH_* to Vault (secret/data/personal/prd)");

  if (args.deleteLegacy) {
    await vaultKvDeleteKeysCli(Object.values(LEGACY_NODE_SSH_VAULT_KEYS), addr);
    console.log("Deleted legacy CHRISVOUGA_DEV_NODE_SSH_* keys");
  } else {
    console.log("Legacy keys kept. Re-run with --delete-legacy to remove them.");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
