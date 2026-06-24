#!/usr/bin/env bun
/**
 * Set all zone-prefixed container packages on ghcr.io to public visibility.
 * Requires GH_TOKEN or GITHUB_TOKEN with packages:write.
 *
 * Usage:
 *   bun run scripts/make-ghcr-public.ts
 *   bun run scripts/make-ghcr-public.ts --dry-run
 */
import { setGhcrPackagePublic } from "../lib/ghcr.js";
import {
  imagePackageName,
  isAlwaysOn,
  loadServicesConfig,
} from "../lib/services.js";

/** Pre-migration package names still on GHCR. */
const LEGACY_PACKAGE_NAMES: Readonly<Record<string, readonly string[]>> = {};

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const config = loadServicesConfig();
  console.log(`Make ghcr packages public (${dryRun ? "DRY-RUN" : "APPLY"})`);

  for (const service of config.services) {
    const names = new Set<string>([
      imagePackageName(config, service.id),
      ...(LEGACY_PACKAGE_NAMES[service.id] ?? []),
    ]);

    let ok = false;
    for (const packageName of names) {
      if (await setGhcrPackagePublic(config.image_owner, packageName, dryRun)) {
        ok = true;
      }
    }

    if (!ok && isAlwaysOn(service)) {
      console.warn(
        `  WARN: always-on service "${service.id}" — no GHCR package visibility updated (publish image or set public manually)`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
