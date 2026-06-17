#!/usr/bin/env bun
/**
 * HTTP + Fly health-check for public services in services.yaml.
 *
 * Usage:
 *   bun run scripts/health-check-urls.ts
 *   bun run scripts/health-check-urls.ts --id snake-game
 *   bun run scripts/health-check-urls.ts --all-public
 */
import {
  flyChecksPassing,
  probeHttp,
  restartStartedMachines,
  serviceHealthUrl,
} from "../lib/fly-health.js";
import {
  flyAppName,
  isAlwaysOn,
  isPublicService,
  loadServicesConfig,
  type ServiceSpec,
  type ServicesConfig,
} from "../lib/services.js";

type Args = {
  readonly ids: readonly string[];
  readonly allPublic: boolean;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly retryDelayMs: number;
  readonly coldStartTimeoutMs: number;
  readonly verifyFlyChecks: boolean;
};

function parseArgs(argv: readonly string[]): Args {
  const ids: string[] = [];
  let allPublic = false;
  let timeoutMs = 15_000;
  let coldStartTimeoutMs = 45_000;
  let retries = 1;
  let retryDelayMs = 3_000;
  let verifyFlyChecks = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--id") ids.push(argv[++i] ?? "");
    else if (arg === "--all-public") allPublic = true;
    else if (arg === "--timeout-ms") timeoutMs = Number(argv[++i] ?? timeoutMs);
    else if (arg === "--cold-start-timeout-ms")
      coldStartTimeoutMs = Number(argv[++i] ?? coldStartTimeoutMs);
    else if (arg === "--retries") retries = Number(argv[++i] ?? retries);
    else if (arg === "--retry-delay-ms") retryDelayMs = Number(argv[++i] ?? retryDelayMs);
    else if (arg === "--no-fly-checks") verifyFlyChecks = false;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun run scripts/health-check-urls.ts [--id <id> ...] [--all-public] [--timeout-ms <ms>] [--cold-start-timeout-ms <ms>] [--retries <n>] [--no-fly-checks]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return {
    ids: ids.filter(Boolean),
    allPublic,
    timeoutMs,
    coldStartTimeoutMs,
    retries,
    retryDelayMs,
    verifyFlyChecks,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function healthCheckServices(config: ServicesConfig, args: Args): readonly ServiceSpec[] {
  return config.services.filter((service) => {
    if (!service.health_check || !isPublicService(service) || !service.hostname) return false;
    if (args.ids.length > 0) return args.ids.includes(service.id);
    if (args.allPublic) return true;
    return isAlwaysOn(service);
  });
}

async function checkWithRetries(
  config: ServicesConfig,
  service: ServiceSpec,
  args: Args,
): Promise<{ ok: boolean; error?: string }> {
  const url = serviceHealthUrl(service);
  if (!url) return { ok: true };

  const perAttemptTimeout = isAlwaysOn(service) ? args.timeoutMs : args.coldStartTimeoutMs;
  const max = args.retries + 1;
  let restarted = false;

  for (let attempt = 1; attempt <= max; attempt++) {
    const http = await probeHttp(url, perAttemptTimeout);
    if (http.ok) {
      if (args.verifyFlyChecks) {
        const app = flyAppName(config, service.id);
        if (!(await flyChecksPassing(app))) {
          if (!restarted) {
            console.log(`  ${service.id}: HTTP ${http.status} but Fly checks failing — restarting machines`);
            await restartStartedMachines(app);
            restarted = true;
            await sleep(15_000);
            continue;
          }
          const err = "Fly health checks not passing";
          console.log(`  ✗ ${service.id} attempt ${attempt}/${max}: ${err}`);
          if (attempt < max) {
            await sleep(args.retryDelayMs);
            continue;
          }
          return { ok: false, error: err };
        }
      }
      console.log(`  ✓ ${service.id} ${url} (HTTP ${http.status}) attempt ${attempt}/${max}`);
      return { ok: true };
    }

    const err = http.error ?? `HTTP ${http.status}`;
    console.log(`  ✗ ${service.id} attempt ${attempt}/${max}: ${err}`);
    if (http.fastFail && isAlwaysOn(service)) return { ok: false, error: err };
    if (attempt < max) await sleep(args.retryDelayMs);
    else return { ok: false, error: err };
  }

  return { ok: false, error: "exhausted retries" };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadServicesConfig();
  const services = healthCheckServices(config, args);

  if (services.length === 0) {
    console.log("No services to health-check");
    return;
  }

  console.log(`\nHealth check: ${services.length} service(s)\n`);
  const failed: string[] = [];

  for (const service of services) {
    const url = serviceHealthUrl(service);
    console.log(`Checking ${service.id} → ${url}`);
    const result = await checkWithRetries(config, service, args);
    if (!result.ok) failed.push(`${service.id}: ${result.error}`);
  }

  if (failed.length > 0) {
    console.error(`\n❌ ${failed.length} service(s) failed:\n${failed.map((f) => `  • ${f}`).join("\n")}`);
    process.exit(1);
  }

  console.log("\n✅ All services healthy");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
