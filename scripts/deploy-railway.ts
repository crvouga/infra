#!/usr/bin/env bun
/**
 * Deploy services to Railway from GHCR images.
 *
 * Usage:
 *   bun run scripts/deploy-railway.ts
 *   bun run scripts/deploy-railway.ts --id portfolio
 *   bun run scripts/deploy-railway.ts --continue-on-error
 */
import {
  connectServiceImage,
  ensureProject,
  findServiceByName,
  resolveEnvironment,
  updateServiceInstance,
} from "../lib/railway-api.js";
import { ensureRailwayToken } from "../lib/railway-token.js";
import { waitForServiceHealthy } from "../lib/service-health.js";
import {
  deployableServices,
  findService,
  imageRef,
  loadServicesConfig,
  railwayEnvironmentName,
  railwayHealthcheckSetting,
  railwayProjectName,
  railwayRegion,
  railwayServiceName,
  railwaySleep,
  type ServiceSpec,
  type ServicesConfig,
} from "../lib/services.js";

type Args = {
  readonly ids: readonly string[];
  readonly imageTag: string;
  readonly continueOnError: boolean;
  readonly skipHealth: boolean;
};

function parseArgs(argv: readonly string[]): Args {
  const config = loadServicesConfig();
  const ids: string[] = [];
  let imageTag = config.default_image_tag;
  let continueOnError = false;
  let skipHealth = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--id") ids.push(argv[++i] ?? "");
    else if (arg === "--image-tag") imageTag = argv[++i] ?? imageTag;
    else if (arg === "--continue-on-error") continueOnError = true;
    else if (arg === "--skip-health") skipHealth = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun run scripts/deploy-railway.ts [--id <id> ...] [--image-tag <tag>] [--continue-on-error] [--skip-health]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }

  return { ids: ids.filter(Boolean), imageTag, continueOnError, skipHealth };
}

async function deployOne(
  config: ServicesConfig,
  service: ServiceSpec,
  imageTag: string,
  skipHealth: boolean,
): Promise<void> {
  const projectName = railwayProjectName(config);
  const environmentName = railwayEnvironmentName(config);
  const serviceName = railwayServiceName(config, service.id);
  const image = imageRef(config, service.id, imageTag);

  console.log(`\nDeploy ${service.id} → ${image}`);

  const project = await ensureProject(projectName);
  const environment = resolveEnvironment(project, environmentName);
  const railwayService = findServiceByName(project, serviceName);
  if (!railwayService) {
    throw new Error(
      `Railway service "${serviceName}" not found — run provision-railway --apply first`,
    );
  }

  const healthcheckPath = railwayHealthcheckSetting(service);
  if (healthcheckPath !== undefined) {
    await updateServiceInstance({
      serviceId: railwayService.id,
      environmentId: environment.id,
      healthcheckPath,
      sleepApplication: railwaySleep(service),
      region: railwayRegion(config),
    });
  }

  await connectServiceImage(railwayService.id, image);

  if (!skipHealth && service.health_check) {
    await waitForServiceHealthy(config, service);
  }

  console.log(`  ✓ deployed ${serviceName}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadServicesConfig();
  await ensureRailwayToken();

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

  let failures = 0;
  for (const service of services) {
    try {
      await deployOne(config, service, args.imageTag, args.skipHealth);
    } catch (err) {
      failures += 1;
      console.error(`  ✗ ${service.id}: ${err instanceof Error ? err.message : err}`);
      if (!args.continueOnError) process.exit(1);
    }
  }

  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
