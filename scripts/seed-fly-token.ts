#!/usr/bin/env bun
/**
 * Mint or store FLY_TOKEN locally (`.fly-token`, gitignored) and optionally patch Vault.
 *
 * Bootstrap when Vault is down (post-DO, pre-Fly vault deploy):
 *   bun run seed-fly-token --mint
 *
 * After vault is healthy, sync cache → Vault:
 *   bun run seed-fly-token --vault
 *
 * Usage:
 *   bun run seed-fly-token --mint [--vault] [--expiry 999999h]
 *   bun run seed-fly-token --vault          # patch Vault from cache / env
 *   bun run seed-fly-token --token <token>
 */
import { $ } from "bun";
import { flyTokenCachePath, readFlyTokenCache, writeFlyTokenCache } from "../lib/fly-token.js";
import { requireVaultCliAuth, resolveVaultAddr } from "../lib/vault-kv.js";
import { flyOrg, loadServicesConfig, vaultAddr } from "../lib/services.js";

const CONFIGS = ["dev", "prd"] as const;
const MOUNT = "secret/personal";
const DEFAULT_EXPIRY = "999999h";

type Args = {
  readonly token: string;
  readonly dryRun: boolean;
  readonly mint: boolean;
  readonly vault: boolean;
  readonly expiry: string;
};

function parseArgs(argv: readonly string[]): Args {
  let token = process.env.FLY_API_TOKEN?.trim() ?? process.env.FLY_TOKEN?.trim() ?? "";
  let dryRun = false;
  let mint = false;
  let vault = false;
  let expiry = DEFAULT_EXPIRY;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--token") token = argv[++i] ?? token;
    else if (arg === "--expiry") expiry = argv[++i] ?? expiry;
    else if (arg === "--mint") mint = true;
    else if (arg === "--vault") vault = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage:
  bun run seed-fly-token --mint              # mint + write .fly-token (no Vault)
  bun run seed-fly-token --mint --vault      # mint + cache + patch Vault
  bun run seed-fly-token --vault             # patch Vault from cache / env
  bun run seed-fly-token --token <token>     # write cache (+ --vault to sync)

Cache file: .fly-token (gitignored)`);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }

  if (!mint && !token) {
    const cached = readFlyTokenCache();
    if (vault && cached) {
      token = cached;
    }
  }

  if (!mint && !token && !vault) {
    console.error(
      "Provide --mint, --token <token>, --vault (from cache), or FLY_API_TOKEN.\n" +
        "Bootstrap: bun run seed-fly-token --mint",
    );
    process.exit(1);
  }

  if (vault && !mint && !token) {
    console.error("No token in env or .fly-token — run: bun run seed-fly-token --mint");
    process.exit(1);
  }

  return { token, dryRun, mint, vault, expiry };
}

async function mintOrgToken(org: string, expiry: string, dryRun: boolean): Promise<string> {
  if (dryRun) {
    console.log(`[dry-run] Would mint org token for ${org} (expiry=${expiry})`);
    return "dry-run-token";
  }

  const result = await $`flyctl tokens create org -o ${org} -x ${expiry} -n infra-ci -j`
    .quiet()
    .nothrow();
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim() || result.stdout.toString().trim();
    if (/could not find/i.test(detail)) {
      throw new Error(
        `Fly org "${org}" does not exist.\n` +
          `Create it first: fly orgs create ${org}\n` +
          `Then re-run: bun run seed-fly-token --mint`,
      );
    }
    throw new Error(`flyctl tokens create org failed: ${detail}`);
  }

  const body = JSON.parse(result.stdout.toString()) as Record<string, unknown>;
  const token =
    (typeof body.token === "string" && body.token) ||
    (typeof body.Token === "string" && body.Token) ||
    "";
  if (!token) {
    throw new Error(`flyctl did not return a token in JSON: ${result.stdout.toString()}`);
  }
  return token;
}

async function patchVault(token: string, addr: string): Promise<void> {
  await requireVaultCliAuth(addr);
  for (const cfg of CONFIGS) {
    const path = `${MOUNT}/${cfg}`;
    console.log(`Patching ${path}...`);
    const result = await $`vault kv patch ${path} FLY_TOKEN=${token}`
      .env({ ...process.env, VAULT_ADDR: addr })
      .nothrow();
    if (result.exitCode !== 0) {
      const detail = result.stderr.toString().trim() || result.stdout.toString().trim();
      throw new Error(`vault kv patch ${path} failed: ${detail}`);
    }
  }
  console.log("FLY_TOKEN patched in Vault (dev + prd)");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadServicesConfig();
  const org = flyOrg(config);
  const addr = resolveVaultAddr(vaultAddr(config));

  let token = args.token;
  if (args.mint) {
    console.log(`Minting org deploy token for ${org}...`);
    token = await mintOrgToken(org, args.expiry, args.dryRun);
    console.log("Org token minted");
  }

  if (args.dryRun) {
    console.log(`[dry-run] Would write ${flyTokenCachePath()}`);
    if (args.vault) {
      for (const cfg of CONFIGS) {
        console.log(`[dry-run] Would patch ${MOUNT}/${cfg}`);
      }
    }
    return;
  }

  if (token) {
    writeFlyTokenCache(token);
    console.log(`Wrote ${flyTokenCachePath()} (mode 600, gitignored)`);
    console.log("Local deploy: bun run deploy-fly (reads .fly-token automatically)");
    console.log("Store in Vault for CI: bun run seed-fly-token --vault");
  }

  if (args.vault) {
    console.log(`Vault: ${addr}`);
    try {
      await patchVault(token, addr);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Vault patch skipped: ${msg}`);
      console.warn("Token is in .fly-token — re-run with --vault when vault is healthy.");
      process.exit(1);
    }
  } else if (args.mint) {
    console.log("\nVault not updated (use --vault when vault.chrisvouga.dev is healthy).");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
