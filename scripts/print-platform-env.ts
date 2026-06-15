#!/usr/bin/env bun
/**
 * Print platform env vars derived from services.yaml (for CI GITHUB_ENV).
 *
 * Usage:
 *   bun run scripts/print-platform-env.ts
 *   eval "$(bun run scripts/print-platform-env.ts --format shell)"
 */
import {
  composeProjectName,
  deployDir,
  dockerNetworkName,
  imagePrefix,
  infraGithubRepo,
  loadServicesConfig,
  systemdUnitName,
  vaultAddr,
  zoneSlug,
} from "../lib/services.js";

function parseArgs(argv: readonly string[]): { format: "shell" | "github" } {
  let format: "shell" | "github" = "shell";
  for (const arg of argv) {
    if (arg === "--format") {
      const next = argv[argv.indexOf(arg) + 1];
      if (next === "github" || next === "shell") format = next;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: bun run scripts/print-platform-env.ts [--format shell|github]");
      process.exit(0);
    }
  }
  return { format };
}

function main(): void {
  const { format } = parseArgs(process.argv.slice(2));
  const config = loadServicesConfig();
  const slug = zoneSlug(config.zone);
  const vars: Record<string, string> = {
    ZONE: config.zone,
    ZONE_SLUG: slug,
    DEPLOY_DIR: deployDir(config),
    VAULT_ADDR: vaultAddr(config),
    SYSTEMD_UNIT: systemdUnitName(config),
    DOCKER_NETWORK: dockerNetworkName(config),
    COMPOSE_PROJECT: composeProjectName(config),
    IMAGE_PREFIX: imagePrefix(config),
    INFRA_GITHUB_REPO: infraGithubRepo(config),
    STACK_DESCRIPTION: `${config.zone} Docker stack`,
  };

  if (format === "github") {
    for (const [key, value] of Object.entries(vars)) {
      console.log(`${key}=${value}`);
    }
    return;
  }

  for (const [key, value] of Object.entries(vars)) {
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    console.log(`export ${key}="${escaped}"`);
  }
}

main();
