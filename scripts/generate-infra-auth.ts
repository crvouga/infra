#!/usr/bin/env bun
/**
 * Generate random credentials for Netdata (Traefik basic auth) and Dozzle login.
 * Prints human-readable login details and Vault-ready secret values.
 *
 * Usage:
 *   bun run generate-infra-auth
 *   bun run generate-infra-auth -- --username admin --email you@example.com
 *   bun run generate-infra-auth -- --write-vault   # requires: vault login
 */
import { vaultKvPatchCli } from "../lib/vault-kv.js";

const BCRYPT_COST = 11;

type Args = {
  readonly username: string;
  readonly email: string;
  readonly password?: string;
  readonly writeVault: boolean;
};

function parseArgs(argv: readonly string[]): Args {
  let username = "admin";
  let email = "";
  let password: string | undefined;
  let writeVault = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--username") username = argv[++i] ?? username;
    else if (arg === "--email") email = argv[++i] ?? email;
    else if (arg === "--password") password = argv[++i] ?? password;
    else if (arg === "--write-vault") writeVault = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: bun run generate-infra-auth [--username admin] [--email addr] [--password pass] [--write-vault]

Generates DOZZLE_USERS_YML and NETDATA_BASIC_AUTH_USERS with a random password
(unless --password is set). No Docker required.`);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (!username.trim()) {
    console.error("--username must not be empty");
    process.exit(2);
  }
  return { username: username.trim(), email: email.trim(), password, writeVault };
}

function randomPassword(length = 24): string {
  const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => charset[b % charset.length]!).join("");
}

async function bcryptHash(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "bcrypt", cost: BCRYPT_COST });
}

async function generateDozzleUsersYml(
  username: string,
  password: string,
  email: string,
): Promise<string> {
  const hash = await bcryptHash(password);
  const lines = ["users:", `  ${username}:`];
  if (email) lines.push(`    email: ${email}`);
  lines.push(`    password: ${hash}`);
  lines.push("    filter:");
  lines.push("    roles:");
  return lines.join("\n");
}

/** Traefik basicAuth accepts bcrypt hashes (same format as htpasswd -nbB). */
async function generateNetdataBasicAuthUsers(
  username: string,
  password: string,
): Promise<string> {
  const hash = await bcryptHash(password);
  return `${username}:${hash}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const password = args.password ?? randomPassword();

  const [dozzleUsersYml, netdataBasicAuthUsers] = await Promise.all([
    generateDozzleUsersYml(args.username, password, args.email),
    generateNetdataBasicAuthUsers(args.username, password),
  ]);

  console.log(`
Infra monitoring credentials (save these — the password is not stored elsewhere)

  Netdata  https://netdata.chrisvouga.dev
           username: ${args.username}
           password: ${password}

  Dozzle   https://dozzle.chrisvouga.dev
           username: ${args.username}
           password: ${password}
`);

  console.log("Vault keys for secret/data/personal/prd:\n");
  console.log("DOZZLE_USERS_YML:");
  console.log(dozzleUsersYml);
  console.log("\nNETDATA_BASIC_AUTH_USERS:");
  console.log(netdataBasicAuthUsers);

  if (args.writeVault) {
    await vaultKvPatchCli({
      DOZZLE_USERS_YML: dozzleUsersYml,
      NETDATA_BASIC_AUTH_USERS: netdataBasicAuthUsers,
    });
    console.log("\nWrote DOZZLE_USERS_YML and NETDATA_BASIC_AUTH_USERS to Vault (personal/prd).");
  } else {
    console.log(
      "\nTo write both keys to Vault: vault login && bun run generate-infra-auth -- --write-vault",
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
