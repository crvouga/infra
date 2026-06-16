#!/usr/bin/env bun
/**
 * Deploy services to Fly.io from GHCR images.
 *
 * Pulls from ghcr.io (private OK with GH_TOKEN), mirrors to registry.fly.io when
 * direct GHCR deploy fails, then deploys.
 *
 * Usage:
 *   bun run scripts/deploy-fly.ts
 *   bun run scripts/deploy-fly.ts --id vault
 *   bun run scripts/deploy-fly.ts --continue-on-error
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import {
  deployableServices,
  findService,
  flyAppName,
  flyIsPublic,
  flyMinMachines,
  flyOrg,
  imageRepo,
  loadServicesConfig,
  type ServiceSpec,
  type ServicesConfig,
} from "../lib/services.js";
import { requireFlyApiToken } from "../lib/fly-token.js";

type Args = {
  readonly ids: readonly string[];
  readonly imageTag: string;
  readonly continueOnError: boolean;
};

function parseArgs(argv: readonly string[]): Args {
  const config = loadServicesConfig();
  const ids: string[] = [];
  let imageTag = config.default_image_tag;
  let continueOnError = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--id") ids.push(argv[++i] ?? "");
    else if (arg === "--image-tag") imageTag = argv[++i] ?? imageTag;
    else if (arg === "--continue-on-error") continueOnError = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun run scripts/deploy-fly.ts [--id <id> ...] [--image-tag <tag>] [--continue-on-error]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return { ids: ids.filter(Boolean), imageTag, continueOnError };
}

function ghcrToken(): string {
  const t =
    process.env.GITHUB_TOKEN_SUPER?.trim() ||
    process.env.GH_TOKEN?.trim() ||
    process.env.GITHUB_TOKEN?.trim();
  if (!t) {
    throw new Error("GH_TOKEN or GITHUB_TOKEN_SUPER required to pull private GHCR images");
  }
  return t;
}

async function dockerAvailable(): Promise<boolean> {
  const r = await $`docker info`.quiet().nothrow();
  return r.exitCode === 0;
}

async function fly(...args: string[]): Promise<{ ok: boolean; detail: string }> {
  const result = await $`flyctl ${args}`.env({ ...process.env }).nothrow();
  const detail = result.stderr.toString().trim() || result.stdout.toString().trim();
  return { ok: result.exitCode === 0, detail };
}

async function ensureApp(config: ServicesConfig, service: ServiceSpec): Promise<void> {
  const app = flyAppName(config, service.id);
  const org = flyOrg(config);
  const list = await $`flyctl apps list --json`.env({ ...process.env }).quiet().nothrow();
  if (list.exitCode !== 0) {
    throw new Error(`flyctl apps list failed: ${list.stderr.toString()}`);
  }
  const apps = JSON.parse(list.stdout.toString()) as Array<{ Name?: string; name?: string }>;
  if (apps.some((a) => (a.Name ?? a.name) === app)) return;
  console.log(`  Creating app ${app}...`);
  const created = await fly("apps", "create", app, "--org", org, "--yes");
  if (!created.ok) throw new Error(created.detail);
}

async function ensureCert(config: ServicesConfig, service: ServiceSpec): Promise<void> {
  if (!flyIsPublic(service) || !service.hostname) return;
  const app = flyAppName(config, service.id);
  const result = await $`flyctl certs list --app ${app} --json`
    .env({ ...process.env })
    .quiet()
    .nothrow();
  if (result.exitCode !== 0) {
    console.log(`  Adding cert ${service.hostname}...`);
    const added = await fly("certs", "add", service.hostname, "--app", app);
    if (!added.ok) console.warn(`  cert add: ${added.detail}`);
    return;
  }
  const certs = JSON.parse(result.stdout.toString()) as Array<{ Hostname?: string; hostname?: string }>;
  if (!certs.some((c) => (c.Hostname ?? c.hostname) === service.hostname)) {
    console.log(`  Adding cert ${service.hostname}...`);
    const added = await fly("certs", "add", service.hostname, "--app", app);
    if (!added.ok) console.warn(`  cert add: ${added.detail}`);
  }
}

async function mirrorToFlyRegistry(
  config: ServicesConfig,
  service: ServiceSpec,
  ghcrImage: string,
  imageTag: string,
): Promise<string> {
  const app = flyAppName(config, service.id);
  const flyImage = `registry.fly.io/${app}:${imageTag}`;
  const token = ghcrToken();
  const owner = config.image_owner;

  console.log(`  Mirroring ${ghcrImage} → ${flyImage}`);
  const login = await $`docker login ghcr.io -u ${owner} -p ${token}`.quiet().nothrow();
  if (login.exitCode !== 0) {
    throw new Error(`docker login ghcr.io failed: ${login.stderr.toString()}`);
  }

  const pull = await $`docker pull ${ghcrImage}`.nothrow();
  if (pull.exitCode !== 0) {
    throw new Error(`docker pull failed: ${pull.stderr.toString()}`);
  }

  const auth = await fly("auth", "docker");
  if (!auth.ok) throw new Error(`fly auth docker failed: ${auth.detail}`);

  await $`docker tag ${ghcrImage} ${flyImage}`;
  const push = await $`docker push ${flyImage}`.nothrow();
  if (push.exitCode !== 0) {
    throw new Error(`docker push failed: ${push.stderr.toString()}`);
  }
  return flyImage;
}

async function resolveDeployImage(
  config: ServicesConfig,
  service: ServiceSpec,
  ghcrImage: string,
  imageTag: string,
): Promise<string> {
  if (!(await dockerAvailable())) {
    return ghcrImage;
  }
  try {
    return await mirrorToFlyRegistry(config, service, ghcrImage, imageTag);
  } catch (err) {
    console.warn(
      `  Mirror failed (${err instanceof Error ? err.message : err}); trying GHCR direct`,
    );
    return ghcrImage;
  }
}

async function deployService(
  config: ServicesConfig,
  service: ServiceSpec,
  imageTag: string,
): Promise<void> {
  const app = flyAppName(config, service.id);
  const configPath = join("fly", service.id, "fly.toml");
  if (!existsSync(configPath)) {
    throw new Error(`Missing ${configPath} — run: bun run generate-fly`);
  }
  const ghcrImage = `${imageRepo(config, service.id)}:${imageTag}`;

  console.log(`\nDeploy ${service.id} → ${app} (${ghcrImage})`);
  await ensureApp(config, service);
  await ensureCert(config, service);

  const deployImage = await resolveDeployImage(config, service, ghcrImage, imageTag);

  const deployed = await fly(
    "deploy",
    "--config",
    configPath,
    "--image",
    deployImage,
    "--app",
    app,
    "--yes",
    "--strategy",
    "rolling",
  );
  if (!deployed.ok) {
    if (deployImage === ghcrImage && (await dockerAvailable())) {
      console.log("  Direct GHCR deploy failed — mirroring to Fly registry...");
      const mirrored = await mirrorToFlyRegistry(config, service, ghcrImage, imageTag);
      const retry = await fly(
        "deploy",
        "--config",
        configPath,
        "--image",
        mirrored,
        "--app",
        app,
        "--yes",
        "--strategy",
        "rolling",
      );
      if (!retry.ok) throw new Error(retry.detail);
    } else {
      throw new Error(deployed.detail);
    }
  }

  if (!flyIsPublic(service)) {
    const count = flyMinMachines(service);
    console.log(`  Scaling process count → ${count}`);
    const scaled = await fly("scale", "count", String(count), "--app", app, "--yes");
    if (!scaled.ok) throw new Error(scaled.detail);
  }
}

async function main(): Promise<void> {
  requireFlyApiToken();
  const args = parseArgs(process.argv.slice(2));
  const config = loadServicesConfig();

  const services =
    args.ids.length === 0
      ? deployableServices(config)
      : args.ids.map((id) => {
          const service = findService(config, id);
          if (!service) {
            console.error(`No service with id "${id}"`);
            process.exit(1);
          }
          return service;
        });

  console.log(`Fly deploy: ${services.length} service(s), image_tag=${args.imageTag}`);

  const failed: string[] = [];
  for (const service of services) {
    try {
      await deployService(config, service, args.imageTag);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\nFAILED ${service.id}: ${msg}`);
      if (args.continueOnError) {
        failed.push(service.id);
        continue;
      }
      process.exit(1);
    }
  }

  if (failed.length > 0) {
    console.error(`\n${failed.length} service(s) failed: ${failed.join(", ")}`);
    process.exit(1);
  }
  console.log("\nDeploy complete");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
