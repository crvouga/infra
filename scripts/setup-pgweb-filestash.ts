#!/usr/bin/env bun
/**
 * Idempotent Fly + Vault + DNS setup for pgweb and filestash admin apps.
 *
 * Usage:
 *   bun run setup-pgweb-filestash
 *   bun run setup-pgweb-filestash --app pgweb
 *   bun run setup-pgweb-filestash --app filestash --dry-run
 */
import { randomBytes } from "node:crypto";
import { $ } from "bun";
import {
  adminFlyApps,
  adminFlyOrg,
  adminFlyRegion,
  adminVaultAddr,
  findAdminFlyApp,
  type AdminFlyAppSpec,
} from "../lib/admin-fly-apps.js";
import { CloudflareApi, cloudflareCredentialsFromEnv } from "../lib/cloudflare-api.js";
import { reconcileFlyCertDns } from "../lib/fly-cert-dns.js";
import { requireFlyApiToken } from "../lib/fly-token.js";
import { loadServicesConfig } from "../lib/services.js";
import {
  vaultKvConfigReadable,
  vaultKvGet,
  vaultKvGetConfig,
  vaultKvPatch,
  type VaultKvConfig,
} from "../lib/vault-kv.js";

const VAULT_RUNTIME_TOKEN_KEY = "VAULT_TOKEN";
const FILESTASH_ADMIN_VAULT_KEY = "FILESTASH_ADMIN_PASSWORD";
const PGWEB_DATABASE_CONFIGS: readonly VaultKvConfig[] = ["dev", "prd"];

type Args = {
  readonly apps: readonly AdminFlyAppSpec[];
  readonly dryRun: boolean;
  readonly skipDns: boolean;
};

function parseArgs(argv: readonly string[]): Args {
  const config = loadServicesConfig();
  let dryRun = false;
  let skipDns = false;
  const ids: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--app") ids.push(argv[++i] ?? "");
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--skip-dns") skipDns = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun run setup-pgweb-filestash [--app pgweb|filestash] [--dry-run] [--skip-dns]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }

  const all = adminFlyApps(config);
  const apps =
    ids.length === 0
      ? all
      : ids.map((id) => {
          const app = findAdminFlyApp(id, config);
          if (!app) {
            console.error(`Unknown admin app "${id}" (expected pgweb or filestash)`);
            process.exit(1);
          }
          return app;
        });

  return { apps, dryRun, skipDns };
}

function randomSecret(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

async function fly(...args: string[]): Promise<{ ok: boolean; detail: string; stdout: string }> {
  const result = await $`flyctl ${args}`.env({ ...process.env }).nothrow();
  const stdout = result.stdout.toString();
  const detail = result.stderr.toString().trim() || stdout.trim();
  return { ok: result.exitCode === 0, detail, stdout };
}

async function ensureVaultBootstrapSecrets(dryRun: boolean): Promise<Record<string, string>> {
  const data = await vaultKvGet();
  const patch: Record<string, string> = {};
  const generated: Record<string, string> = {};

  if (!data.PGWEB_AUTH_USER?.trim()) {
    generated.PGWEB_AUTH_USER = "admin";
    patch.PGWEB_AUTH_USER = generated.PGWEB_AUTH_USER;
  }
  if (!data.PGWEB_AUTH_PASS?.trim()) {
    generated.PGWEB_AUTH_PASS = randomSecret();
    patch.PGWEB_AUTH_PASS = generated.PGWEB_AUTH_PASS;
  }
  if (!data[FILESTASH_ADMIN_VAULT_KEY]?.trim()) {
    generated[FILESTASH_ADMIN_VAULT_KEY] = randomSecret();
    patch[FILESTASH_ADMIN_VAULT_KEY] = generated[FILESTASH_ADMIN_VAULT_KEY];
  }

  if (Object.keys(patch).length > 0) {
    if (dryRun) {
      console.log(`[dry-run] Would patch Vault prd keys: ${Object.keys(patch).join(", ")}`);
    } else {
      try {
        await vaultKvPatch(patch);
        console.log(`Vault: patched prd keys ${Object.keys(patch).join(", ")}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`Vault patch skipped (${msg}) — will sync generated values to Fly secrets only`);
      }
    }
  } else {
    console.log("Vault: pgweb auth + filestash admin password already set");
  }

  const merged = { ...data, ...generated, ...patch };

  if (!merged[VAULT_RUNTIME_TOKEN_KEY]?.trim()) {
    throw new Error(
      `Vault prd is missing ${VAULT_RUNTIME_TOKEN_KEY} — containers need a long-lived read token`,
    );
  }

  return merged;
}

function isPostgresWireUrl(url: string): boolean {
  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

async function ensurePgwebDatabaseAccess(
  runtimeToken: string,
  dryRun: boolean,
): Promise<void> {
  for (const config of PGWEB_DATABASE_CONFIGS) {
    if (dryRun) {
      console.log(`[dry-run] Would verify DATABASE_URL in secret/personal/${config}`);
      continue;
    }

    const data = await vaultKvGetConfig(config);
    const databaseUrl = data.DATABASE_URL?.trim();
    if (!databaseUrl) {
      throw new Error(
        `Vault secret/personal/${config} is missing DATABASE_URL — pgweb bookmarks require dev and prd`,
      );
    }
    if (!isPostgresWireUrl(databaseUrl)) {
      throw new Error(
        `Vault secret/personal/${config} DATABASE_URL must be postgres:// or postgresql://`,
      );
    }
    console.log(`  pgweb: DATABASE_URL present in ${config}`);
  }

  if (dryRun) {
    console.log("[dry-run] Would verify runtime VAULT_TOKEN reads dev + prd");
    return;
  }

  for (const config of PGWEB_DATABASE_CONFIGS) {
    if (!(await vaultKvConfigReadable(config, runtimeToken))) {
      throw new Error(
        `Runtime VAULT_TOKEN cannot read secret/personal/${config}. ` +
          "Mint a personal-read token: vault/scripts/seed-vault-token.sh",
      );
    }

    const data = await vaultKvGetConfig(config, runtimeToken);
    if (!data.DATABASE_URL?.trim()) {
      throw new Error(
        `Runtime VAULT_TOKEN can read secret/personal/${config} but DATABASE_URL is missing`,
      );
    }
    console.log(`  pgweb: runtime token reads ${config} DATABASE_URL`);
  }
}

async function ensureFlyApp(app: AdminFlyAppSpec, org: string, dryRun: boolean): Promise<void> {
  const list = await fly("apps", "list", "--json");
  if (!list.ok) throw new Error(`flyctl apps list failed: ${list.detail}`);

  const apps = JSON.parse(list.stdout) as Array<{ Name?: string; name?: string }>;
  if (apps.some((entry) => (entry.Name ?? entry.name) === app.flyApp)) {
    console.log(`  ${app.id}: Fly app ${app.flyApp} exists`);
    return;
  }

  if (dryRun) {
    console.log(`[dry-run] Would create Fly app ${app.flyApp}`);
    return;
  }

  const created = await fly("apps", "create", app.flyApp, "--org", org, "--yes");
  if (!created.ok) throw new Error(`flyctl apps create (${app.flyApp}) failed: ${created.detail}`);
  console.log(`  ${app.id}: created Fly app ${app.flyApp}`);
}

async function ensureFlyIps(app: AdminFlyAppSpec, dryRun: boolean): Promise<void> {
  const list = await fly("ips", "list", "--app", app.flyApp, "--json");
  if (!list.ok) throw new Error(`flyctl ips list (${app.flyApp}) failed: ${list.detail}`);

  const ips = JSON.parse(list.stdout) as Array<{ Address?: string; address?: string }>;
  if (ips.length > 0) {
    console.log(`  ${app.id}: public IPs allocated`);
    return;
  }

  if (dryRun) {
    console.log(`[dry-run] Would allocate shared IPv4 on ${app.flyApp}`);
    return;
  }

  const v4 = await fly("ips", "allocate-v4", "--shared", "--app", app.flyApp, "--yes");
  if (!v4.ok) throw new Error(`flyctl ips allocate-v4 (${app.flyApp}) failed: ${v4.detail}`);
  console.log(`  ${app.id}: allocated shared IPv4`);
}

async function ensureFlyCert(app: AdminFlyAppSpec, dryRun: boolean): Promise<void> {
  const list = await fly("certs", "list", "--app", app.flyApp, "--json");
  if (!list.ok) {
    if (dryRun) {
      console.log(`[dry-run] Would add cert ${app.hostname} on ${app.flyApp}`);
      return;
    }
    const added = await fly("certs", "add", app.hostname, "--app", app.flyApp);
    if (!added.ok) throw new Error(`flyctl certs add (${app.hostname}) failed: ${added.detail}`);
    console.log(`  ${app.id}: added cert ${app.hostname}`);
    return;
  }

  const certs = JSON.parse(list.stdout) as Array<{ Hostname?: string; hostname?: string }>;
  if (certs.some((cert) => (cert.Hostname ?? cert.hostname) === app.hostname)) {
    console.log(`  ${app.id}: cert ${app.hostname} exists`);
    return;
  }

  if (dryRun) {
    console.log(`[dry-run] Would add cert ${app.hostname} on ${app.flyApp}`);
    return;
  }

  const added = await fly("certs", "add", app.hostname, "--app", app.flyApp);
  if (!added.ok) throw new Error(`flyctl certs add (${app.hostname}) failed: ${added.detail}`);
  console.log(`  ${app.id}: added cert ${app.hostname}`);
}

async function ensureVolume(
  app: AdminFlyAppSpec,
  region: string,
  dryRun: boolean,
): Promise<void> {
  if (!app.volume) return;

  const list = await fly("volumes", "list", "--app", app.flyApp, "--json");
  if (!list.ok) throw new Error(`flyctl volumes list (${app.flyApp}) failed: ${list.detail}`);

  const volumes = JSON.parse(list.stdout) as Array<{ name?: string; Name?: string }>;
  if (volumes.some((vol) => (vol.name ?? vol.Name) === app.volume!.name)) {
    console.log(`  ${app.id}: volume ${app.volume.name} exists`);
    return;
  }

  if (dryRun) {
    console.log(
      `[dry-run] Would create volume ${app.volume.name} (${app.volume.sizeGb}GB, ${region}) on ${app.flyApp}`,
    );
    return;
  }

  const created = await fly(
    "volumes",
    "create",
    app.volume.name,
    "--size",
    String(app.volume.sizeGb),
    "--region",
    region,
    "--app",
    app.flyApp,
    "--yes",
  );
  if (!created.ok) {
    throw new Error(`flyctl volumes create (${app.volume.name}) failed: ${created.detail}`);
  }
  console.log(`  ${app.id}: created volume ${app.volume.name}`);
}

async function ensureFlyRuntimeSecrets(
  app: AdminFlyAppSpec,
  vaultData: Record<string, string>,
  vaultAddrValue: string,
  dryRun: boolean,
): Promise<void> {
  const pairs: Record<string, string> = {
    VAULT_ADDR: vaultAddrValue,
    VAULT_TOKEN: vaultData[VAULT_RUNTIME_TOKEN_KEY]!,
  };

  if (app.id === "pgweb") {
    pairs.PGWEB_AUTH_USER = vaultData.PGWEB_AUTH_USER!;
    pairs.PGWEB_AUTH_PASS = vaultData.PGWEB_AUTH_PASS!;
  }

  if (app.id === "filestash") {
    pairs.ADMIN_PASSWORD = vaultData[FILESTASH_ADMIN_VAULT_KEY]!;
  }

  if (dryRun) {
    console.log(`[dry-run] Would set Fly secrets on ${app.flyApp}: ${Object.keys(pairs).join(", ")}`);
    return;
  }

  const args = [
    "secrets",
    "set",
    ...Object.entries(pairs).map(([key, value]) => `${key}=${value}`),
    "--app",
    app.flyApp,
    "--detach",
  ];
  const result = await fly(...args);
  if (!result.ok) throw new Error(`flyctl secrets set (${app.flyApp}) failed: ${result.detail}`);
  console.log(`  ${app.id}: synced runtime secrets on ${app.flyApp}`);
}

async function ensureDns(
  apps: readonly AdminFlyAppSpec[],
  dryRun: boolean,
): Promise<void> {
  const creds = cloudflareCredentialsFromEnv();
  if (!creds) {
    console.warn("Skipping DNS — CLOUDFLARE_API_TOKEN not set");
    return;
  }

  const config = loadServicesConfig();
  const cf = new CloudflareApi();
  const zone = await cf.findZoneByName(config.zone);
  if (!zone) throw new Error(`Cloudflare zone "${config.zone}" not found`);

  const managedComment = `managed by infra/scripts/setup-pgweb-filestash.ts (${config.zone})`;

  for (const app of apps) {
    console.log(`\n  ${app.id}: DNS ${app.hostname}`);
    await reconcileFlyCertDns({
      cf,
      zoneId: zone.id,
      hostname: app.hostname,
      flyApp: app.flyApp,
      dryRun,
      managedComment,
    });
  }
}

async function setupApp(
  app: AdminFlyAppSpec,
  vaultData: Record<string, string>,
  org: string,
  region: string,
  vaultAddrValue: string,
  dryRun: boolean,
): Promise<void> {
  console.log(`\n=== ${app.id} ===`);
  if (app.id === "pgweb") {
    await ensurePgwebDatabaseAccess(vaultData[VAULT_RUNTIME_TOKEN_KEY]!, dryRun);
  }
  await ensureFlyApp(app, org, dryRun);
  await ensureFlyIps(app, dryRun);
  await ensureFlyCert(app, dryRun);
  await ensureVolume(app, region, dryRun);
  await ensureFlyRuntimeSecrets(app, vaultData, vaultAddrValue, dryRun);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadServicesConfig();
  const org = adminFlyOrg(config);
  const region = adminFlyRegion(config);
  const vaultAddrValue = adminVaultAddr(config);

  requireFlyApiToken();

  console.log(`Setup pgweb/filestash (${args.dryRun ? "DRY-RUN" : "APPLY"}) apps=${args.apps.map((a) => a.id).join(",")}`);

  const vaultData = await ensureVaultBootstrapSecrets(args.dryRun);

  for (const app of args.apps) {
    await setupApp(app, vaultData, org, region, vaultAddrValue, args.dryRun);
  }

  if (!args.skipDns) {
    console.log("\n=== DNS ===");
    await ensureDns(args.apps, args.dryRun);
  }

  console.log("\nSetup complete.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
