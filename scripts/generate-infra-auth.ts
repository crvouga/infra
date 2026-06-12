#!/usr/bin/env bun
/**
 * Generate random credentials for Netdata (Traefik basic auth) and Dozzle login.
 * Prints human-readable login details and Vault-ready secret values.
 *
 * Requires Docker for Dozzle users.yml generation.
 *
 * Usage:
 *   bun run generate-infra-auth
 *   bun run generate-infra-auth -- --username admin --email you@example.com
 *   bun run generate-infra-auth -- --write-vault
 */
import { vaultKvPatch } from "../lib/vault-kv.js";

const DOZZLE_IMAGE = "amir20/dozzle:v8";

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
(unless --password is set). Docker is required for the Dozzle users file.`);
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

async function requireDocker(): Promise<void> {
  const probe = Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" });
  if ((await probe.exited) !== 0) {
    throw new Error("Docker is required to generate Dozzle users.yml (docker info failed)");
  }
}

async function generateDozzleUsersYml(
  username: string,
  password: string,
  email: string,
): Promise<string> {
  const cmd = [
    "docker",
    "run",
    "--rm",
    DOZZLE_IMAGE,
    "generate",
    username,
    "--password",
    password,
  ];
  if (email) cmd.push("--email", email);
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`dozzle generate failed: ${stderr.trim() || stdout.trim()}`);
  }
  return stdout.trimEnd();
}

async function generateNetdataBasicAuthUsers(
  username: string,
  password: string,
): Promise<string> {
  const htpasswd = Bun.spawn(["htpasswd", "-nb", username, password], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [htOut, htErr, htCode] = await Promise.all([
    new Response(htpasswd.stdout).text(),
    new Response(htpasswd.stderr).text(),
    htpasswd.exited,
  ]);
  if (htCode === 0) return htOut.trimEnd();

  const hashProc = Bun.spawn(["openssl", "passwd", "-apr1", password], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [hashOut, hashErr, hashCode] = await Promise.all([
    new Response(hashProc.stdout).text(),
    new Response(hashProc.stderr).text(),
    hashProc.exited,
  ]);
  if (hashCode !== 0) {
    throw new Error(
      `Need htpasswd or openssl to generate NETDATA_BASIC_AUTH_USERS (${htErr.trim() || hashErr.trim()})`,
    );
  }
  return `${username}:${hashOut.trimEnd()}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const password = args.password ?? randomPassword();

  await requireDocker();

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
    await vaultKvPatch({
      DOZZLE_USERS_YML: dozzleUsersYml,
      NETDATA_BASIC_AUTH_USERS: netdataBasicAuthUsers,
    });
    console.log("\nWrote DOZZLE_USERS_YML and NETDATA_BASIC_AUTH_USERS to Vault (personal/prd).");
  } else {
    console.log("\nTo write both keys to Vault: bun run generate-infra-auth -- --write-vault");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
