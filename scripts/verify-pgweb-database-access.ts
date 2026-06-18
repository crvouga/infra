#!/usr/bin/env bun
/**
 * Verify pgweb can load DATABASE_URL from Vault dev and prd (same checks as setup).
 *
 * Usage:
 *   bun run scripts/verify-pgweb-database-access.ts
 */
import {
  vaultKvConfigReadable,
  vaultKvGet,
  vaultKvGetConfig,
  type VaultKvConfig,
} from "../lib/vault-kv.js";

const CONFIGS: readonly VaultKvConfig[] = ["dev", "prd"];
const RUNTIME_TOKEN_KEY = "VAULT_TOKEN";

function isPostgresWireUrl(url: string): boolean {
  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

async function main(): Promise<void> {
  const prd = await vaultKvGet();
  const runtimeToken = prd[RUNTIME_TOKEN_KEY]?.trim();
  if (!runtimeToken) {
    throw new Error(`Vault prd is missing ${RUNTIME_TOKEN_KEY}`);
  }

  for (const config of CONFIGS) {
    const data = await vaultKvGetConfig(config);
    const databaseUrl = data.DATABASE_URL?.trim();
    if (!databaseUrl) {
      throw new Error(`secret/personal/${config} is missing DATABASE_URL`);
    }
    if (!isPostgresWireUrl(databaseUrl)) {
      throw new Error(`secret/personal/${config} DATABASE_URL is not a Postgres wire URL`);
    }
    console.log(`  OK  DATABASE_URL in ${config}`);

    if (!(await vaultKvConfigReadable(config, runtimeToken))) {
      throw new Error(
        `Runtime ${RUNTIME_TOKEN_KEY} cannot read secret/personal/${config} — run vault/scripts/seed-vault-token.sh`,
      );
    }

    const runtimeData = await vaultKvGetConfig(config, runtimeToken);
    if (!runtimeData.DATABASE_URL?.trim()) {
      throw new Error(`Runtime token reads ${config} but DATABASE_URL is missing`);
    }
    console.log(`  OK  runtime token reads ${config} DATABASE_URL`);
  }

  console.log("pgweb Vault database access verified (dev + prd)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
