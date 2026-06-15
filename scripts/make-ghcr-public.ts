#!/usr/bin/env bun
/**
 * Set all zone-prefixed container packages on ghcr.io to public visibility.
 * Requires GH_TOKEN or GITHUB_TOKEN with packages:write.
 *
 * Usage:
 *   bun run scripts/make-ghcr-public.ts
 *   bun run scripts/make-ghcr-public.ts --dry-run
 */
import { imagePackageName, loadServicesConfig } from "../lib/services.js";

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

async function setPublic(owner: string, packageName: string, dryRun: boolean): Promise<void> {
  const url = `https://api.github.com/user/packages/container/${packageName}/visibility`;
  if (dryRun) {
    console.log(`[plan] PATCH ${owner}/${packageName} → public`);
    return;
  }
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
    console.warn(`  skip ${packageName}: package not found yet`);
    return;
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to set ${packageName} public (HTTP ${res.status}): ${text}`);
  }
  console.log(`  public ${owner}/${packageName}`);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const config = loadServicesConfig();
  console.log(`Make ghcr packages public (${dryRun ? "DRY-RUN" : "APPLY"})`);

  for (const service of config.services) {
    const packageName = imagePackageName(config, service.id);
    await setPublic(config.image_owner, packageName, dryRun);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
