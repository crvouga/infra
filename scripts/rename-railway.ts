#!/usr/bin/env bun
/**
 * One-time migration: rename Railway project/services from crvouga-* to unprefixed names.
 *
 * Do not run alongside sync-dns or other Railway scripts — share the same API quota.
 *
 * Usage:
 *   bun run scripts/rename-railway.ts
 *   bun run scripts/rename-railway.ts --apply
 *   bun run scripts/rename-railway.ts --apply --wait-on-rate-limit
 *   bun run scripts/rename-railway.ts --old-project crvouga-infra --old-prefix crvouga --apply
 */
import {
  findServiceByName,
  getProject,
  isRailwayRateLimitError,
  listProjects,
  updateProjectName,
  updateServiceName,
  waitForRailwayRateLimit,
  type RailwayProject,
} from "../lib/railway-api.js";
import { ensureRailwayToken } from "../lib/railway-token.js";
import {
  loadServicesConfig,
  railwayProjectName,
  railwayServiceName,
  type ServiceSpec,
} from "../lib/services.js";

type Args = {
  readonly apply: boolean;
  readonly waitOnRateLimit: boolean;
  readonly oldProject: string;
  readonly oldPrefix: string;
};

function parseArgs(argv: readonly string[]): Args {
  let apply = false;
  let waitOnRateLimit =
    process.env["RAILWAY_WAIT_ON_RATE_LIMIT"]?.trim() === "1" ||
    process.env["RAILWAY_WAIT_ON_RATE_LIMIT"]?.trim()?.toLowerCase() === "true";
  let oldProject = "crvouga-infra";
  let oldPrefix = "crvouga";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--wait-on-rate-limit") waitOnRateLimit = true;
    else if (arg === "--old-project") oldProject = argv[++i] ?? oldProject;
    else if (arg === "--old-prefix") oldPrefix = argv[++i] ?? oldPrefix;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun run scripts/rename-railway.ts [--apply] [--wait-on-rate-limit] [--old-project <name>] [--old-prefix <prefix>]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }

  return { apply, waitOnRateLimit, oldProject, oldPrefix };
}

function oldServiceName(prefix: string, service: ServiceSpec): string {
  return prefix ? `${prefix}-${service.id}` : service.id;
}

async function withRateLimitRetry<T>(
  waitOnRateLimit: boolean,
  run: () => Promise<T>,
): Promise<T> {
  for (;;) {
    try {
      return await run();
    } catch (err) {
      if (waitOnRateLimit && isRailwayRateLimitError(err)) {
        await waitForRailwayRateLimit(err);
        continue;
      }
      throw err;
    }
  }
}

async function loadTargetProject(
  oldProjectName: string,
  newProjectName: string,
  waitOnRateLimit: boolean,
): Promise<RailwayProject> {
  console.log("  Loading Railway projects…");
  return withRateLimitRetry(waitOnRateLimit, async () => {
    const projects = await listProjects();
    const match = projects.find((p) => p.name === oldProjectName || p.name === newProjectName);
    if (!match) {
      throw new Error(
        `Railway project "${oldProjectName}" or "${newProjectName}" not found — nothing to rename`,
      );
    }
    return getProject(match.id);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadServicesConfig();
  const newProjectName = railwayProjectName(config);
  const services = config.services;

  console.log(
    `Rename Railway (${args.apply ? "APPLY" : "DRY-RUN"}) project ${args.oldProject} → ${newProjectName}, services=${services.length}`,
  );

  await ensureRailwayToken();

  let project = await loadTargetProject(args.oldProject, newProjectName, args.waitOnRateLimit);

  if (project.name === args.oldProject && args.oldProject !== newProjectName) {
    const line = `project ${args.oldProject} → ${newProjectName}`;
    if (!args.apply) {
      console.log(`  [plan] ${line}`);
    } else {
      console.log(`  Renaming project…`);
      await withRateLimitRetry(args.waitOnRateLimit, async () => {
        await updateProjectName(project.id, newProjectName);
        project = await getProject(project.id);
      });
      console.log(`  [done] ${line}`);
    }
  } else if (project.name === newProjectName) {
    console.log(`  OK     project ${newProjectName}`);
  }

  for (const service of services) {
    const newName = railwayServiceName(config, service.id);
    const oldName = oldServiceName(args.oldPrefix, service);
    if (oldName === newName) {
      console.log(`  OK     ${newName}`);
      continue;
    }

    const railwayService =
      findServiceByName(project, oldName) ?? findServiceByName(project, newName);
    if (!railwayService) {
      console.log(`  skip ${oldName} (not on Railway)`);
      continue;
    }

    if (railwayService.name === newName) {
      console.log(`  OK     ${newName}`);
      continue;
    }

    const line = `service ${railwayService.name} → ${newName}`;
    if (!args.apply) {
      console.log(`  [plan] ${line}`);
      continue;
    }

    await withRateLimitRetry(args.waitOnRateLimit, async () => {
      await updateServiceName(railwayService.id, newName);
    });
    console.log(`  [done] ${line}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
