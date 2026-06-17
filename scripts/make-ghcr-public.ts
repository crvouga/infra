#!/usr/bin/env bun
/**
 * Set all zone-prefixed container packages on ghcr.io to public visibility.
 * Requires GH_TOKEN or GITHUB_TOKEN with packages:write.
 *
 * Usage:
 *   bun run scripts/make-ghcr-public.ts
 *   bun run scripts/make-ghcr-public.ts --dry-run
 */
import {
  imagePackageName,
  isAlwaysOn,
  loadServicesConfig,
} from "../lib/services.js";

/** Pre-migration package names still on GHCR. */
const LEGACY_PACKAGE_NAMES: Readonly<Record<string, readonly string[]>> = {};

function token(): string {
  const t =
    process.env["GH_TOKEN"]?.trim() ||
    process.env["GITHUB_TOKEN_SUPER"]?.trim() ||
    process.env["GITHUB_TOKEN"]?.trim();
  if (!t) {
    throw new Error("GH_TOKEN, GITHUB_TOKEN_SUPER, or GITHUB_TOKEN is required");
  }
  return t;
}

async function setPublic(
  owner: string,
  packageName: string,
  dryRun: boolean,
): Promise<boolean> {
  const urls = [
    `https://api.github.com/user/packages/container/${packageName}/visibility`,
    `https://api.github.com/orgs/${owner}/packages/container/${packageName}/visibility`,
  ];

  if (dryRun) {
    console.log(`[plan] PATCH ${owner}/${packageName} → public`);
    return true;
  }

  let lastError = "";
  for (const url of urls) {
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ visibility: "public" }),
    });
    if (res.status === 404) {
      lastError = `not found at ${url}`;
      continue;
    }
    if (res.ok) {
      console.log(`  public ${owner}/${packageName}`);
      return true;
    }
    const text = await res.text();
    lastError = `HTTP ${res.status} at ${url}: ${text}`;
  }

  console.warn(`  skip ${packageName}: ${lastError}`);
  return false;
}

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
      if (await setPublic(config.image_owner, packageName, dryRun)) {
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
