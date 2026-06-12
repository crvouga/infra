#!/usr/bin/env bun
/**
 * Resolve secrets from env (Vault-injected in CI) and write per-service .env files
 * for docker compose. CI SCPs the env/ directory to the node.
 *
 * Infra services may also write auth files (dozzle/users.yml, traefik/dynamic/netdata-auth.yml).
 *
 * Usage:
 *   bun run scripts/sync-secrets.ts
 *   bun run scripts/sync-secrets.ts --id pickflix
 *   bun run scripts/sync-secrets.ts --output-dir ./env
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  findInfraService,
  findService,
  loadServicesConfig,
  type InfraServiceSpec,
  type SecretSpec,
  type ServiceSpec,
} from "../lib/services.js";

type Args = {
  readonly ids: readonly string[];
  readonly outputDir: string;
};

function parseArgs(argv: readonly string[]): Args {
  const ids: string[] = [];
  let outputDir = "env";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--id") ids.push(argv[++i] ?? "");
    else if (arg === "--output-dir") outputDir = argv[++i] ?? outputDir;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: bun run scripts/sync-secrets.ts [--id <id> ...] [--output-dir <dir>]");
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return { ids: ids.filter(Boolean), outputDir };
}

function resolveSecret(spec: SecretSpec): string | null {
  if (spec.source === "literal") return spec.value;
  const value = process.env[spec.name]?.trim();
  return value || null;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing vault secret in environment: ${name}`);
    process.exit(1);
  }
  return value;
}

function writeServiceEnv(service: ServiceSpec, outputDir: string): void {
  const secrets = service.secrets ?? [];
  if (secrets.length === 0) return;

  const lines: string[] = [];
  const missing: string[] = [];

  for (const spec of secrets) {
    const value = resolveSecret(spec);
    if (value == null) {
      missing.push(spec.name);
      continue;
    }
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
    lines.push(`${spec.name}="${escaped}"`);
  }

  if (missing.length > 0) {
    console.error(`  ${service.id}: missing secrets: ${missing.join(", ")}`);
    process.exit(1);
  }

  mkdirSync(outputDir, { recursive: true, mode: 0o755 });
  const path = join(outputDir, `${service.id}.env`);
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o644 });
  console.log(`  wrote ${path} (${lines.length} vars)`);
}

function writeDozzleUsers(service: InfraServiceSpec): void {
  const hasSecret = (service.secrets ?? []).some((s) => s.name === "DOZZLE_USERS_YML");
  if (!hasSecret) return;
  const content = requireEnv("DOZZLE_USERS_YML");
  mkdirSync("dozzle", { recursive: true, mode: 0o755 });
  writeFileSync("dozzle/users.yml", `${content}\n`, { mode: 0o644 });
  console.log("  wrote dozzle/users.yml");
}

function writeNetdataAuth(infra: readonly InfraServiceSpec[]): void {
  if (!infra.some((s) => s.id === "netdata")) return;
  const user = requireEnv("NETDATA_BASIC_AUTH_USERS");
  mkdirSync("traefik/dynamic", { recursive: true, mode: 0o755 });
  const content = `http:
  middlewares:
    netdata-auth:
      basicAuth:
        users:
          - "${user.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"
`;
  writeFileSync("traefik/dynamic/netdata-auth.yml", content, { mode: 0o644 });
  console.log("  wrote traefik/dynamic/netdata-auth.yml");
}

function collectRequiredVault(
  services: readonly ServiceSpec[],
  infra: readonly InfraServiceSpec[],
): Set<string> {
  const names = new Set<string>();
  for (const service of services) {
    for (const spec of service.secrets ?? []) {
      if (spec.source === "vault") names.add(spec.name);
    }
  }
  for (const service of infra) {
    for (const spec of service.secrets ?? []) {
      if (spec.source === "vault") names.add(spec.name);
    }
    if (service.id === "netdata") names.add("NETDATA_BASIC_AUTH_USERS");
  }
  return names;
}

function infraToWriteForVault(
  args: Args,
  config: ReturnType<typeof loadServicesConfig>,
  selectedInfra: readonly InfraServiceSpec[],
): readonly InfraServiceSpec[] {
  if (args.ids.length === 0) return config.infra_services ?? [];
  return selectedInfra;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadServicesConfig();
  mkdirSync("dozzle", { recursive: true, mode: 0o755 });
  mkdirSync("traefik/dynamic", { recursive: true, mode: 0o755 });

  let services: ServiceSpec[];
  let infra: readonly InfraServiceSpec[];

  if (args.ids.length === 0) {
    services = config.services.filter((s) => (s.secrets?.length ?? 0) > 0);
    infra = config.infra_services ?? [];
  } else {
    services = [];
    const selectedInfra: InfraServiceSpec[] = [];
    for (const id of args.ids) {
      const app = findService(config, id);
      if (app) {
        services.push(app);
        continue;
      }
      const inf = findInfraService(config, id);
      if (inf) {
        selectedInfra.push(inf);
        continue;
      }
      console.error(`No service with id "${id}"`);
      process.exit(1);
    }
    infra = selectedInfra;
  }

  const requiredVault = collectRequiredVault(services, infraToWriteForVault(args, config, infra));
  const missingVault = [...requiredVault].filter((n) => !process.env[n]?.trim());
  if (missingVault.length > 0) {
    console.error(`Missing vault secrets in environment: ${missingVault.join(", ")}`);
    process.exit(1);
  }

  console.log(
    `Sync secrets → ${args.outputDir} (${services.length} app, ${infra.length} infra)`,
  );
  for (const service of services) {
    writeServiceEnv(service, args.outputDir);
  }

  const syncAllInfra = args.ids.length === 0;
  const infraToWrite =
    syncAllInfra ? (config.infra_services ?? []) : infra;

  for (const service of infraToWrite) {
    writeDozzleUsers(service);
  }
  if (syncAllInfra || args.ids.includes("netdata")) {
    writeNetdataAuth(infraToWrite);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
