import { $ } from "bun";
import { flyAppName, isAlwaysOn, type ServiceSpec, type ServicesConfig } from "./services.js";

export type HttpProbeResult = {
  readonly ok: boolean;
  readonly status: number;
  readonly error?: string;
  readonly fastFail: boolean;
};

/** LB / gateway errors — retrying won't help. */
export function isFastFailHttpStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

export function serviceHealthUrl(service: ServiceSpec): string | undefined {
  if (!service.hostname || !service.health_check) return undefined;
  const path = service.health_path ?? "/";
  return `https://${service.hostname}${path}`;
}

export async function probeHttp(url: string, timeoutMs: number): Promise<HttpProbeResult> {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: res.ok, status: res.status, fastFail: isFastFailHttpStatus(res.status) };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      fastFail: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

type FlyCheck = { readonly name?: string; readonly status?: string };

export async function flyChecksPassing(app: string): Promise<boolean> {
  const result = await $`flyctl checks list --app ${app} --json`
    .env({ ...process.env })
    .quiet()
    .nothrow();
  if (result.exitCode !== 0) return true;
  const parsed = JSON.parse(result.stdout.toString()) as Record<string, readonly FlyCheck[]>;
  const checks = Object.values(parsed).flat();
  if (checks.length === 0) return true;
  return checks.every((check) => check.status === "passing");
}

export async function restartStartedMachines(app: string): Promise<void> {
  const list = await $`flyctl machine list --app ${app} --json`
    .env({ ...process.env })
    .quiet()
    .nothrow();
  if (list.exitCode !== 0) return;
  const machines = JSON.parse(list.stdout.toString()) as Array<{ id?: string; state?: string }>;
  for (const machine of machines) {
    if (machine.state !== "started" || !machine.id) continue;
    console.log(`  Restarting machine ${machine.id} to refresh Fly health checks...`);
    await $`flyctl machine restart ${machine.id} --app ${app}`
      .env({ ...process.env })
      .quiet()
      .nothrow();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForServiceHealthy(
  config: ServicesConfig,
  service: ServiceSpec,
): Promise<void> {
  const url = serviceHealthUrl(service);
  if (!url) return;

  const app = flyAppName(config, service.id);
  const alwaysOn = isAlwaysOn(service);
  const maxWaitMs = alwaysOn ? 60_000 : 120_000;
  const perAttemptMs = alwaysOn ? 15_000 : 30_000;
  const retryDelayMs = 5_000;
  const deadline = Date.now() + maxWaitMs;

  console.log(`  Waiting for ${service.id} → ${url}`);
  let restarted = false;

  while (Date.now() < deadline) {
    const http = await probeHttp(url, perAttemptMs);
    if (http.ok) {
      if (await flyChecksPassing(app)) {
        console.log(`  ✓ ${service.id} healthy (HTTP ${http.status})`);
        return;
      }
      if (!restarted) {
        await restartStartedMachines(app);
        restarted = true;
        await sleep(15_000);
        continue;
      }
      console.log(`  HTTP ${http.status} but Fly checks not passing yet — retrying...`);
    } else {
      const detail = http.error ?? `HTTP ${http.status}`;
      console.log(`  ${service.id} not ready: ${detail}`);
      if (http.fastFail) {
        throw new Error(`${service.id} unhealthy: ${detail} (${url})`);
      }
    }
    await sleep(retryDelayMs);
  }

  throw new Error(`${service.id} did not become healthy within ${maxWaitMs / 1000}s (${url})`);
}
