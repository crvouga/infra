#!/usr/bin/env bun
/**
 * Deploy pgweb or filestash to Fly.io (local Dockerfile build on Fly builders).
 *
 * Usage:
 *   bun run deploy-pgweb-filestash --app pgweb
 *   bun run deploy-pgweb-filestash --app filestash
 */
import { dirname, join } from "node:path";
import { $ } from "bun";
import { findAdminFlyApp } from "../lib/admin-fly-apps.js";
import { requireFlyApiToken } from "../lib/fly-token.js";
import { loadServicesConfig } from "../lib/services.js";

function parseArgs(argv: readonly string[]): string {
  let appId = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--app") appId = argv[++i] ?? "";
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: bun run deploy-pgweb-filestash --app pgweb|filestash");
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }

  if (!appId) {
    console.error("--app is required (pgweb or filestash)");
    process.exit(1);
  }
  return appId;
}

async function main(): Promise<void> {
  const appId = parseArgs(process.argv.slice(2));
  const app = findAdminFlyApp(appId, loadServicesConfig());
  if (!app) {
    console.error(`Unknown admin app "${appId}"`);
    process.exit(1);
  }

  const token = requireFlyApiToken();
  const appDir = join(process.cwd(), dirname(app.flyConfig));

  console.log(`Deploying ${app.id} (${app.flyApp}) from ${appDir}...`);
  const result = await $`flyctl deploy --config fly.toml --remote-only --detach --ha=false --yes`
    .cwd(appDir)
    .env({ ...process.env, FLY_API_TOKEN: token })
    .nothrow();

  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim() || result.stdout.toString().trim();
    throw new Error(`flyctl deploy failed: ${detail}`);
  }

  console.log(`Deployed ${app.id}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
