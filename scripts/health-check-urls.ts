#!/usr/bin/env bun
/**
 * HTTP health-check every service with health_check: true in services.yaml.
 *
 * Usage:
 *   bun run scripts/health-check-urls.ts
 *   bun run scripts/health-check-urls.ts --id snake-game
 *   bun run scripts/health-check-urls.ts --retries 5 --timeout-ms 30000
 */
import { findService, loadServicesConfig } from "../lib/services.js";

type Args = {
  readonly ids: readonly string[];
  readonly timeoutMs: number;
  readonly retries: number;
  readonly retryDelayMs: number;
};

function parseArgs(argv: readonly string[]): Args {
  const ids: string[] = [];
  let timeoutMs = 30_000;
  let retries = 4;
  let retryDelayMs = 5_000;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--id") ids.push(argv[++i] ?? "");
    else if (arg === "--timeout-ms") timeoutMs = Number(argv[++i] ?? timeoutMs);
    else if (arg === "--retries") retries = Number(argv[++i] ?? retries);
    else if (arg === "--retry-delay-ms") retryDelayMs = Number(argv[++i] ?? retryDelayMs);
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun run scripts/health-check-urls.ts [--id <id> ...] [--timeout-ms <ms>] [--retries <n>]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return { ids: ids.filter(Boolean), timeoutMs, retries, retryDelayMs };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkOnce(url: string, timeoutMs: number): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

async function checkWithRetries(
  url: string,
  args: Args,
): Promise<{ ok: boolean; status: number; attempts: number; error?: string }> {
  const max = args.retries + 1;
  for (let attempt = 1; attempt <= max; attempt++) {
    const result = await checkOnce(url, args.timeoutMs);
    if (result.ok) {
      console.log(`  ✓ ${url} (${result.status}) attempt ${attempt}/${max}`);
      return { ok: true, status: result.status, attempts: attempt };
    }
    const err = result.error ?? `HTTP ${result.status}`;
    console.log(`  ✗ ${url} attempt ${attempt}/${max}: ${err}`);
    if (attempt < max) await sleep(args.retryDelayMs);
    else return { ok: false, status: result.status, attempts: attempt, error: err };
  }
  return { ok: false, status: 0, attempts: max, error: "exhausted retries" };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadServicesConfig();
  const services = config.services.filter((s) => {
    if (!s.health_check) return false;
    if (args.ids.length === 0) return true;
    return args.ids.includes(s.id);
  });

  if (services.length === 0) {
    console.log("No services to health-check");
    return;
  }

  console.log(`\nHealth check: ${services.length} service(s)\n`);
  const failed: string[] = [];

  for (const service of services) {
    const url = `https://${service.hostname}/`;
    console.log(`Checking ${service.id} → ${url}`);
    const result = await checkWithRetries(url, args);
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
