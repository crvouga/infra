#!/usr/bin/env bun
/**
 * On-demand service orchestrator — wakes idle containers on request and stops them after idle timeout.
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  composeServiceName,
  dependentsOf,
  idleTimeoutMinutes,
  isOnDemand,
  isPublicService,
  startOrder,
  stopOrder,
  type ServicesConfig,
} from "../../lib/services.js";

type ServiceState = "stopped" | "starting" | "running";

type ManagedService = {
  id: string;
  composeName: string;
  hostname?: string;
  port?: number;
  healthPath: string;
  dependsOn: readonly string[];
  internal: boolean;
};

const configPath = process.env.SERVICES_CONFIG_PATH ?? "/config/services.yaml";
const composeDir = process.env.COMPOSE_PROJECT_DIR ?? "/opt/chrisvouga-dev";
const listenPort = Number(process.env.PORT ?? "8080");
const idleTimeoutMs =
  Number(process.env.IDLE_TIMEOUT_MINUTES ?? "30") * 60 * 1000;

function loadConfig(): ServicesConfig {
  return parseYaml(readFileSync(configPath, "utf8")) as ServicesConfig;
}

function buildManagedServices(config: ServicesConfig): Map<string, ManagedService> {
  const map = new Map<string, ManagedService>();
  for (const service of config.services) {
    if (!isOnDemand(service)) continue;
    map.set(service.id, {
      id: service.id,
      composeName: composeServiceName(service.id),
      hostname: service.hostname,
      port: service.port,
      healthPath: service.health_path ?? "/",
      dependsOn: service.depends_on ?? [],
      internal: service.internal === true,
    });
  }
  for (const service of config.infra_services ?? []) {
    if (!isOnDemand(service)) continue;
    map.set(service.id, {
      id: service.id,
      composeName: composeServiceName(service.id),
      hostname: service.hostname,
      port: service.port,
      healthPath: service.health_path ?? "/",
      dependsOn: [],
      internal: false,
    });
  }
  return map;
}

const config = loadConfig();
const managed = buildManagedServices(config);
const hostnameToId = new Map<string, string>();
for (const svc of managed.values()) {
  if (svc.hostname) hostnameToId.set(svc.hostname.toLowerCase(), svc.id);
}

const lastRequestAt = new Map<string, number>();
const serviceState = new Map<string, ServiceState>();
const wakeLocks = new Map<string, Promise<void>>();

async function dockerCompose(args: readonly string[]): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(["docker", "compose", ...args], {
    cwd: composeDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { ok: code === 0, output: (stdout + stderr).trim() };
}

function servicesToStart(id: string): readonly string[] {
  const svc = managed.get(id);
  if (!svc) return [id];
  const ids = new Set<string>([id, ...svc.dependsOn]);
  for (const dep of svc.dependsOn) {
    for (const child of dependentsOf(config, dep)) {
      ids.add(child);
    }
  }
  for (const child of dependentsOf(config, id)) {
    ids.add(child);
  }
  return startOrder(config, [...ids]);
}

function servicesToStop(id: string): readonly string[] {
  const ids = new Set<string>([id]);
  for (const child of dependentsOf(config, id)) {
    ids.add(child);
  }
  return stopOrder(config, [...ids]);
}

async function isContainerRunning(composeName: string): Promise<boolean> {
  const { ok, output } = await dockerCompose(["ps", "--status", "running", "--format", "{{.Service}}"]);
  if (!ok) return false;
  return output.split("\n").some((line) => line.trim() === composeName);
}

async function waitForHealthy(svc: ManagedService, timeoutMs = 60_000): Promise<boolean> {
  if (svc.internal || svc.port == null) {
    return isContainerRunning(svc.composeName);
  }
  const url = `http://${svc.composeName}:${svc.port}${svc.healthPath}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) return true;
    } catch {
      // container still starting
    }
    await Bun.sleep(2_000);
  }
  return false;
}

async function wakeService(id: string): Promise<void> {
  const existing = wakeLocks.get(id);
  if (existing) return existing;

  const promise = (async () => {
    const svc = managed.get(id);
    if (!svc) throw new Error(`Unknown service: ${id}`);

    serviceState.set(id, "starting");
    const composeNames = servicesToStart(id).map((sid) => composeServiceName(sid));

    const anyStopped = await Promise.all(
      composeNames.map(async (name) => !(await isContainerRunning(name))),
    );
    if (!anyStopped.some(Boolean)) {
      serviceState.set(id, "running");
      lastRequestAt.set(id, Date.now());
      return;
    }

    const { ok, output } = await dockerCompose(["up", "-d", ...composeNames]);
    if (!ok) throw new Error(`docker compose up failed for ${id}: ${output}`);

    for (const startId of servicesToStart(id)) {
      const startSvc = managed.get(startId);
      if (!startSvc) continue;
      const healthy = await waitForHealthy(startSvc);
      if (!healthy) throw new Error(`Service ${startId} did not become healthy in time`);
      serviceState.set(startId, "running");
      lastRequestAt.set(startId, Date.now());
    }
  })().finally(() => {
    wakeLocks.delete(id);
  });

  wakeLocks.set(id, promise);
  return promise;
}

async function stopService(id: string): Promise<void> {
  const toStop = servicesToStop(id).map((sid) => composeServiceName(sid));
  const { ok, output } = await dockerCompose(["stop", ...toStop]);
  if (!ok) {
    console.error(`Failed to stop ${id}: ${output}`);
    return;
  }
  for (const sid of servicesToStop(id)) {
    serviceState.set(sid, "stopped");
    lastRequestAt.delete(sid);
  }
}

async function proxyRequest(req: Request, svc: ManagedService): Promise<Response> {
  if (svc.internal || svc.port == null) {
    return new Response("Internal service has no HTTP endpoint", { status: 502 });
  }
  const targetUrl = new URL(req.url);
  targetUrl.protocol = "http:";
  targetUrl.hostname = svc.composeName;
  targetUrl.port = String(svc.port);

  const headers = new Headers(req.headers);
  headers.delete("host");

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
  }

  return fetch(targetUrl, init);
}

function statusPayload(): Record<string, unknown> {
  const services: Record<string, unknown> = {};
  for (const svc of managed.values()) {
    services[svc.id] = {
      state: serviceState.get(svc.id) ?? "stopped",
      lastRequestAt: lastRequestAt.get(svc.id) ?? null,
      hostname: svc.hostname ?? null,
    };
  }
  return {
    idleTimeoutMinutes: idleTimeoutMs / 60_000,
    services,
  };
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/health") {
    return Response.json({ ok: true });
  }
  if (url.pathname === "/status") {
    return Response.json(statusPayload());
  }

  const host = req.headers.get("host")?.split(":")[0]?.toLowerCase();
  if (!host) {
    return new Response("Missing Host header", { status: 400 });
  }

  const serviceId = hostnameToId.get(host);
  if (!serviceId) {
    return new Response(`No on-demand service for host ${host}`, { status: 404 });
  }

  const svc = managed.get(serviceId);
  if (!svc) {
    return new Response("Service not found", { status: 404 });
  }

  try {
    await wakeService(serviceId);
    lastRequestAt.set(serviceId, Date.now());
    return proxyRequest(req, svc);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Wake failed for ${serviceId}:`, message);
    return new Response(`Service unavailable: ${message}`, { status: 503 });
  }
}

async function idleSweeper(): Promise<void> {
  const now = Date.now();
  for (const svc of managed.values()) {
    if (svc.internal) continue;
    const state = serviceState.get(svc.id);
    if (state !== "running") continue;
    const last = lastRequestAt.get(svc.id);
    if (last == null || now - last < idleTimeoutMs) continue;
    console.log(`Stopping idle service ${svc.id} (idle ${Math.round((now - last) / 60_000)}m)`);
    await stopService(svc.id);
  }
}

setInterval(() => {
  idleSweeper().catch((err) => console.error("Idle sweeper error:", err));
}, 60_000);

Bun.serve({
  port: listenPort,
  fetch: handleRequest,
});

console.log(
  `Service orchestrator listening on :${listenPort} (${managed.size} on-demand services, idle timeout ${idleTimeoutMs / 60_000}m)`,
);
