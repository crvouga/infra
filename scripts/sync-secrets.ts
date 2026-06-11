#!/usr/bin/env bun
/**
 * Resolve secrets from env (Vault-injected in CI) and write per-service .env files
 * for docker compose. CI SCPs the env/ directory to the node.
 *
 * Usage:
 *   bun run scripts/sync-secrets.ts
 *   bun run scripts/sync-secrets.ts --id pickflix
 *   bun run scripts/sync-secrets.ts --output-dir ./env
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  findService,
  loadServicesConfig,
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
  // 0o644 so appleboy/scp-action (docker, non-runner uid) can tar files on the Actions runner.
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o644 });
  console.log(`  wrote ${path} (${lines.length} vars)`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadServicesConfig();
  const services =
    args.ids.length === 0
      ? config.services.filter((s) => (s.secrets?.length ?? 0) > 0)
      : args.ids.map((id) => {
          const s = findService(config, id);
          if (!s) {
            console.error(`No service with id "${id}"`);
            process.exit(1);
          }
          return s;
        });

  const requiredVault = new Set<string>();
  for (const service of services) {
    for (const spec of service.secrets ?? []) {
      if (spec.source === "vault") requiredVault.add(spec.name);
    }
  }
  const missingVault = [...requiredVault].filter((n) => !process.env[n]?.trim());
  if (missingVault.length > 0) {
    console.error(`Missing vault secrets in environment: ${missingVault.join(", ")}`);
    process.exit(1);
  }

  console.log(`Sync secrets → ${args.outputDir} (${services.length} service(s))`);
  for (const service of services) {
    writeServiceEnv(service, args.outputDir);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
