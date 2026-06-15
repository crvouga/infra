#!/usr/bin/env bun
/**
 * Generate credentials for Netdata (Traefik basic auth) and Dozzle login.
 * Prints human-readable login details and Vault-ready secret values.
 *
 * Usage:
 *   bun run generate-infra-auth
 *   bun run generate-infra-auth -- --netdata-username admin --dozzle-email you@example.com
 *   bun run generate-infra-auth -- --write-vault   # requires: vault login
 */
import { vaultKvPatchCli } from "../lib/vault-kv.js";
import { findInfraService, loadServicesConfig } from "../lib/services.js";

type Args = {
  readonly netdataUsername: string;
  readonly netdataPassword: string;
  readonly dozzleUsername: string;
  readonly dozzlePassword: string;
  readonly dozzleEmail: string;
  readonly writeVault: boolean;
};

function parseArgs(argv: readonly string[]): Args {
  let netdataUsername = "admin";
  let netdataPassword: string | undefined;
  let dozzleUsername = "admin";
  let dozzlePassword: string | undefined;
  let dozzleEmail = "";
  let writeVault = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--netdata-username") netdataUsername = argv[++i] ?? netdataUsername;
    else if (arg === "--netdata-password") netdataPassword = argv[++i] ?? netdataPassword;
    else if (arg === "--dozzle-username") dozzleUsername = argv[++i] ?? dozzleUsername;
    else if (arg === "--dozzle-password") dozzlePassword = argv[++i] ?? dozzlePassword;
    else if (arg === "--dozzle-email") dozzleEmail = argv[++i] ?? dozzleEmail;
    else if (arg === "--write-vault") writeVault = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: bun run generate-infra-auth [options] [--write-vault]

Options:
  --netdata-username <name>   Netdata login user (default: admin)
  --netdata-password <pass>   Netdata password (default: random)
  --dozzle-username <name>    Dozzle login user (default: admin)
  --dozzle-password <pass>    Dozzle password (default: random)
  --dozzle-email <addr>       Optional Dozzle user email

Writes NETDATA_USERNAME, NETDATA_PASSWORD, DOZZLE_USERNAME, DOZZLE_PASSWORD
(and DOZZLE_EMAIL when set) to Vault. No Docker required.`);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (!netdataUsername.trim()) {
    console.error("--netdata-username must not be empty");
    process.exit(2);
  }
  if (!dozzleUsername.trim()) {
    console.error("--dozzle-username must not be empty");
    process.exit(2);
  }
  return {
    netdataUsername: netdataUsername.trim(),
    netdataPassword: netdataPassword ?? randomPassword(),
    dozzleUsername: dozzleUsername.trim(),
    dozzlePassword: dozzlePassword ?? randomPassword(),
    dozzleEmail: dozzleEmail.trim(),
    writeVault,
  };
}

function randomPassword(length = 24): string {
  const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => charset[b % charset.length]!).join("");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadServicesConfig();
  const netdataUrl = findInfraService(config, "netdata")?.hostname ?? `netdata.${config.zone}`;
  const dozzleUrl = findInfraService(config, "dozzle")?.hostname ?? `dozzle.${config.zone}`;

  console.log(`
Infra monitoring credentials (save these — passwords are stored plain in Vault)

  Netdata  https://${netdataUrl}
           username: ${args.netdataUsername}
           password: ${args.netdataPassword}

  Dozzle   https://${dozzleUrl}
           username: ${args.dozzleUsername}
           password: ${args.dozzlePassword}${args.dozzleEmail ? `\n           email:    ${args.dozzleEmail}` : ""}
`);

  console.log("Vault keys for secret/data/personal/prd:\n");
  console.log(`NETDATA_USERNAME=${args.netdataUsername}`);
  console.log(`NETDATA_PASSWORD=${args.netdataPassword}`);
  console.log(`DOZZLE_USERNAME=${args.dozzleUsername}`);
  console.log(`DOZZLE_PASSWORD=${args.dozzlePassword}`);
  if (args.dozzleEmail) console.log(`DOZZLE_EMAIL=${args.dozzleEmail}`);

  if (args.writeVault) {
    const fields: Record<string, string> = {
      NETDATA_USERNAME: args.netdataUsername,
      NETDATA_PASSWORD: args.netdataPassword,
      DOZZLE_USERNAME: args.dozzleUsername,
      DOZZLE_PASSWORD: args.dozzlePassword,
    };
    if (args.dozzleEmail) fields.DOZZLE_EMAIL = args.dozzleEmail;
    await vaultKvPatchCli(fields);
    console.log("\nWrote infra monitoring secrets to Vault (personal/prd).");
  } else {
    console.log(
      "\nTo write keys to Vault: vault login && bun run generate-infra-auth -- --write-vault",
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
