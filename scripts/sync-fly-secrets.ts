#!/usr/bin/env bun
/**
 * Resolve secrets from env (Vault-injected in CI) and set Fly app secrets.
 *
 * Usage:
 *   bun run scripts/sync-fly-secrets.ts
 *   bun run scripts/sync-fly-secrets.ts --id pickflix
 */
import { $ } from "bun";
import {
  deployableServices,
  findService,
  flyAppName,
  loadServicesConfig,
  type SecretSpec,
  type ServiceSpec,
} from "../lib/services.js";
import { requireFlyApiToken } from "../lib/fly-token.js";

type Args = {
  readonly ids: readonly string[];
};

function parseArgs(argv: readonly string[]): Args {
  const ids: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--id") ids.push(argv[++i] ?? "");
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: bun run scripts/sync-fly-secrets.ts [--id <id> ...]");
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return { ids: ids.filter(Boolean) };
}

function resolveSecret(spec: SecretSpec): string | null {
  if (spec.source === "literal") return spec.value;
  const value = process.env[spec.name]?.trim();
  return value || null;
}

async function setFlySecrets(app: string, pairs: Record<string, string>): Promise<void> {
  const entries = Object.entries(pairs);
  if (entries.length === 0) return;

  const args = ["secrets", "set", ...entries.map(([k, v]) => `${k}=${v}`), "--app", app];
  const result = await $`flyctl ${args}`.env({ ...process.env }).nothrow();
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim() || result.stdout.toString().trim();
    throw new Error(`flyctl secrets set (${app}) failed: ${detail}`);
  }
}

function collectSecrets(service: ServiceSpec): Record<string, string> {
  const out: Record<string, string> = {};
  const missing: string[] = [];

  for (const spec of service.secrets ?? []) {
    const value = resolveSecret(spec);
    if (value == null) {
      missing.push(spec.name);
      continue;
    }
    out[spec.name] = value;
  }

  if (missing.length > 0) {
    throw new Error(`${service.id}: missing secrets: ${missing.join(", ")}`);
  }

  return out;
}

async function syncService(service: ServiceSpec): Promise<void> {
  const secrets = service.secrets ?? [];
  if (secrets.length === 0) {
    console.log(`  ${service.id}: no secrets`);
    return;
  }

  const app = flyAppName(loadServicesConfig(), service.id);
  const pairs = collectSecrets(service);
  await setFlySecrets(app, pairs);
  console.log(`  ${service.id}: set ${Object.keys(pairs).length} secret(s) on ${app}`);
}

async function main(): Promise<void> {
  requireFlyApiToken();

  const args = parseArgs(process.argv.slice(2));
  const config = loadServicesConfig();

  const services =
    args.ids.length === 0
      ? deployableServices(config).filter((s) => (s.secrets?.length ?? 0) > 0)
      : args.ids.map((id) => {
          const service = findService(config, id);
          if (!service) {
            console.error(`No service with id "${id}"`);
            process.exit(1);
          }
          return service;
        });

  console.log(`Sync Fly secrets: ${services.length} service(s)`);
  for (const service of services) {
    await syncService(service);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
