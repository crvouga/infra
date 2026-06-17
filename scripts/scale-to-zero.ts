#!/usr/bin/env bun
/**
 * Stop running machines on scale-to-zero services to save cost.
 * Always-on services (`fly.min_machines >= 1`) are left running.
 *
 * Usage:
 *   bun run scripts/scale-to-zero.ts
 *   bun run scripts/scale-to-zero.ts --id portfolio
 *   bun run scripts/scale-to-zero.ts --dry-run
 */
import { $ } from "bun";
import {
  deployableServices,
  findService,
  flyAppName,
  isAlwaysOn,
  loadServicesConfig,
  type ServiceSpec,
  type ServicesConfig,
} from "../lib/services.js";
import { requireFlyApiToken } from "../lib/fly-token.js";

type Args = {
  readonly ids: readonly string[];
  readonly dryRun: boolean;
};

type Machine = {
  readonly id?: string;
  readonly state?: string;
};

function parseArgs(argv: readonly string[]): Args {
  const ids: string[] = [];
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--id") ids.push(argv[++i] ?? "");
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun run scripts/scale-to-zero.ts [--id <id> ...] [--dry-run]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return { ids: ids.filter(Boolean), dryRun };
}

async function fly(...args: string[]): Promise<{ ok: boolean; detail: string }> {
  const result = await $`flyctl ${args}`.env({ ...process.env }).nothrow();
  const detail = result.stderr.toString().trim() || result.stdout.toString().trim();
  return { ok: result.exitCode === 0, detail };
}

async function listMachines(app: string): Promise<readonly Machine[]> {
  const result = await $`flyctl machine list --app ${app} --json`
    .env({ ...process.env })
    .quiet()
    .nothrow();
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || `machine list failed for ${app}`);
  }
  return JSON.parse(result.stdout.toString()) as Machine[];
}

async function scaleToZeroService(
  config: ServicesConfig,
  service: ServiceSpec,
  dryRun: boolean,
): Promise<void> {
  if (isAlwaysOn(service)) {
    console.log(`Skip ${service.id} (always on)`);
    return;
  }

  const app = flyAppName(config, service.id);
  console.log(`\n${service.id} → ${app}`);

  const machines = await listMachines(app);
  if (machines.length === 0) {
    console.log("  No machines");
    return;
  }

  const startedCount = machines.filter((m) => m.state === "started").length;
  const stoppedCount = machines.length - startedCount;
  console.log(`  ${machines.length} machine(s): ${startedCount} started, ${stoppedCount} stopped`);

  if (machines.length > 1) {
    console.log(`  Scaling machine count 1 (was ${machines.length})`);
    if (!dryRun) {
      const scaled = await fly("scale", "count", "1", "--app", app, "--yes");
      if (!scaled.ok) throw new Error(scaled.detail);
    }
  }

  const currentMachines = dryRun ? machines : await listMachines(app);
  const running = currentMachines.filter((m) => m.state === "started" && m.id);
  for (const machine of running) {
    console.log(`  Stopping ${machine.id}`);
    if (!dryRun) {
      const stoppedMachine = await fly("machine", "stop", machine.id!, "--app", app);
      if (!stoppedMachine.ok) throw new Error(stoppedMachine.detail);
    }
  }
}

async function main(): Promise<void> {
  requireFlyApiToken();
  const args = parseArgs(process.argv.slice(2));
  const config = loadServicesConfig();

  const services =
    args.ids.length === 0
      ? deployableServices(config).filter((service) => !isAlwaysOn(service))
      : args.ids.map((id) => {
          const service = findService(config, id);
          if (!service) {
            console.error(`No service with id "${id}"`);
            process.exit(1);
          }
          if (isAlwaysOn(service)) {
            console.error(`Service "${id}" is always on — refusing to scale to zero`);
            process.exit(1);
          }
          return service;
        });

  console.log(
    `Scale to zero: ${services.length} service(s)${args.dryRun ? " (dry run)" : ""}`,
  );

  const failed: string[] = [];
  for (const service of services) {
    try {
      await scaleToZeroService(config, service, args.dryRun);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  FAILED: ${msg}`);
      failed.push(service.id);
    }
  }

  if (failed.length > 0) {
    console.error(`\n${failed.length} service(s) failed: ${failed.join(", ")}`);
    process.exit(1);
  }

  console.log("\nScale to zero complete");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
