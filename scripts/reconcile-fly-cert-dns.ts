#!/usr/bin/env bun
/**
 * Reconcile Cloudflare DNS for a Fly custom hostname (A/AAAA/CNAME + ownership TXT).
 *
 * Usage:
 *   bun run scripts/reconcile-fly-cert-dns.ts --hostname pgweb.chrisvouga.dev --app crvouga-pgweb
 *   bun run scripts/reconcile-fly-cert-dns.ts --hostname pgweb.chrisvouga.dev --app crvouga-pgweb --apply
 */
import { CloudflareApi, cloudflareCredentialsFromEnv } from "../lib/cloudflare-api.js";
import { reconcileFlyCertDns } from "../lib/fly-cert-dns.js";
import { requireFlyApiToken } from "../lib/fly-token.js";
import { loadServicesConfig } from "../lib/services.js";

type Args = {
  readonly hostname: string;
  readonly flyApp: string;
  readonly apply: boolean;
};

function parseArgs(argv: readonly string[]): Args {
  let hostname = "";
  let flyApp = "";
  let apply = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--hostname") hostname = argv[++i] ?? "";
    else if (arg === "--app") flyApp = argv[++i] ?? "";
    else if (arg === "--apply") apply = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun run scripts/reconcile-fly-cert-dns.ts --hostname <host> --app <fly-app> [--apply]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }

  if (!hostname || !flyApp) {
    console.error("--hostname and --app are required");
    process.exit(1);
  }

  return { hostname, flyApp, apply };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const creds = cloudflareCredentialsFromEnv();
  if (!creds) {
    console.error("CLOUDFLARE_API_TOKEN (or CF_API_TOKEN) is required");
    process.exit(1);
  }

  requireFlyApiToken();
  const config = loadServicesConfig();
  const cf = new CloudflareApi();
  const zone = await cf.findZoneByName(config.zone);
  if (!zone) {
    console.error(`Cloudflare zone "${config.zone}" not found`);
    process.exit(1);
  }

  console.log(
    `Reconcile Fly cert DNS (${args.apply ? "APPLY" : "DRY-RUN"}) ${args.hostname} → ${args.flyApp}`,
  );

  await reconcileFlyCertDns({
    cf,
    zoneId: zone.id,
    hostname: args.hostname,
    flyApp: args.flyApp,
    dryRun: !args.apply,
    managedComment: `managed by infra/scripts/reconcile-fly-cert-dns.ts (${config.zone})`,
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
