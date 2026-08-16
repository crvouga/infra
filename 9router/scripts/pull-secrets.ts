import { ENV_FILE, SECRET_KEYS } from "./lib/paths.ts";
import { ensureEnvFile, upsertEnv } from "./lib/env.ts";
import {
  allSecretsFromEnv,
  ensureAppSecrets,
} from "./lib/secrets.ts";
import { defaultVaultKvConfig, vaultKvCliPath } from "./lib/vault.ts";

async function main(): Promise<void> {
  const kvPath = vaultKvCliPath(defaultVaultKvConfig());
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
  await ensureAppSecrets({ writeEnv: true });
  for (const key of SECRET_KEYS) {
    console.log(`  wrote ${key}`);
  }
  console.log(`Done. Secrets written to ${ENV_FILE}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
