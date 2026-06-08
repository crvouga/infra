#!/usr/bin/env bun
/**
 * Read or push Turbo *client* secrets for monorepos that use this cache.
 *
 * Source of truth: this repo's Doppler (`personal` project). Values are read
 * via `doppler run` (env injection) or the Doppler CLI (`--mirror-prd`).
 *
 * Usage:
 *   bun run seed:turbo-client
 *     Print shell exports + `doppler secrets set` commands for another project.
 *
 *   bun run seed:turbo-client -- --target-project gamezilla --target-config dev
 *     Push TURBO_* client secrets into another Doppler project/config.
 *
 *   bun run seed:turbo-client -- --target-project gamezilla --all-configs
 *     Push into dev and prd on the consumer project.
 *
 *   bun run seed:turbo-client:mirror-prd
 *     Copy client TURBO_* secrets from dev → prd in this repo's Doppler project.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import {
  DOPPLER_SETUP_CONFIGS,
  TURBO_CLIENT_OPTIONAL_KEYS,
  TURBO_CLIENT_REQUIRED_KEYS,
  turboClientRegistryDefaults,
} from './doppler-secrets-registry';
import { readDopplerYamlDefaults } from './doppler-yaml-defaults';

const REPO_ROOT = join(import.meta.dirname, '..');

type CliOptions = {
  readonly mirrorPrd: boolean;
  readonly allConfigs: boolean;
  readonly targetProject: string | null;
  readonly targetConfig: string;
  readonly sourceConfig: string;
};

function fail(message: string): never {
  console.error(`seed-turbo-client-secrets: ${message}`);
  process.exit(1);
}

function runOrFail(
  command: string,
  args: readonly string[],
  label: string,
  options?: { input?: string }
): string {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input: options?.input,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  if (result.error !== undefined) {
    fail(`failed to spawn \`${command}\`: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const detail = (result.stderr ?? result.stdout ?? '').trim();
    fail(
      `${label} failed (exit ${String(result.status ?? 'unknown')})${detail.length > 0 ? `: ${detail}` : ''}`
    );
  }

  return (result.stdout ?? '').trim();
}

function parseCliOptions(): CliOptions {
  const args = process.argv.slice(2);
  let mirrorPrd = false;
  let allConfigs = false;
  let targetProject: string | null = null;
  let targetConfig = 'dev';
  let sourceConfig =
    process.env['DOPPLER_CONFIG']?.trim() ||
    process.env['DOPPLER_ENVIRONMENT']?.trim() ||
    'dev';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '--mirror-prd') {
      mirrorPrd = true;
      continue;
    }
    if (arg === '--all-configs') {
      allConfigs = true;
      continue;
    }
    if (arg === '--target-project') {
      const value = args[i + 1]?.trim();
      if (value === undefined || value.length === 0) {
        fail('--target-project requires a value');
      }
      targetProject = value;
      i++;
      continue;
    }
    if (arg === '--target-config') {
      const value = args[i + 1]?.trim();
      if (value === undefined || value.length === 0) {
        fail('--target-config requires a value');
      }
      targetConfig = value;
      i++;
      continue;
    }
    if (arg === '--source-config') {
      const value = args[i + 1]?.trim();
      if (value === undefined || value.length === 0) {
        fail('--source-config requires a value');
      }
      sourceConfig = value;
      i++;
      continue;
    }
    if (arg.startsWith('-')) {
      fail(`unknown flag ${arg}`);
    }
  }

  if (mirrorPrd && targetProject !== null) {
    fail('use either --mirror-prd or --target-project, not both');
  }

  return { mirrorPrd, allConfigs, targetProject, targetConfig, sourceConfig };
}

function readEnvSecret(key: string): string | null {
  const value = process.env[key]?.trim() ?? '';
  return value.length > 0 ? value : null;
}

function resolveClientSecretsFromEnv(): Record<string, string> {
  const defaults = turboClientRegistryDefaults();
  const secrets: Record<string, string> = {};

  for (const key of TURBO_CLIENT_REQUIRED_KEYS) {
    const fromEnv = readEnvSecret(key);
    const fallback = defaults[key];
    const value = fromEnv ?? fallback ?? null;
    if (value === null || value.length === 0) {
      fail(
        `${key} is missing in env. Run via \`bun run seed:turbo-client\` (doppler run) or set it in Doppler config ${process.env['DOPPLER_CONFIG'] ?? 'dev'}.`
      );
    }
    secrets[key] = value;
  }

  for (const key of TURBO_CLIENT_OPTIONAL_KEYS) {
    const fromEnv = readEnvSecret(key);
    if (fromEnv !== null) {
      secrets[key] = fromEnv;
    }
  }

  return secrets;
}

function getSecretPlain(
  project: string,
  config: string,
  key: string
): string | null {
  const result = spawnSync(
    'doppler',
    ['secrets', 'get', key, '--plain', '-p', project, '-c', config],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    }
  );
  if (result.status !== 0) {
    return null;
  }
  const out = (result.stdout ?? '').trim();
  return out.length > 0 ? out : null;
}

function setSecretPlain(
  project: string,
  config: string,
  key: string,
  value: string
): void {
  runOrFail(
    'doppler',
    ['secrets', 'set', key, '-p', project, '-c', config],
    `doppler secrets set ${key}`,
    { input: value }
  );
}

function resolveClientSecretsFromDoppler(
  project: string,
  config: string
): Record<string, string> {
  const defaults = turboClientRegistryDefaults();
  const secrets: Record<string, string> = {};

  for (const key of TURBO_CLIENT_REQUIRED_KEYS) {
    const fromDoppler = getSecretPlain(project, config, key);
    const fallback = defaults[key];
    const value = fromDoppler ?? fallback ?? null;
    if (value === null || value.length === 0) {
      fail(
        `${project}/${config} is missing ${key}. Set it in this cache repo's Doppler first.`
      );
    }
    secrets[key] = value;
  }

  for (const key of TURBO_CLIENT_OPTIONAL_KEYS) {
    const fromDoppler = getSecretPlain(project, config, key);
    if (fromDoppler !== null && fromDoppler.length > 0) {
      secrets[key] = fromDoppler;
    }
  }

  return secrets;
}

function shellEscape(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function printClientSecrets(
  secrets: Record<string, string>,
  sourceLabel: string,
  targetProject: string | null,
  targetConfig: string
): void {
  console.log(`# Turbo remote cache client secrets (${sourceLabel})`);
  console.log(
    '# Self-hosted cache — set these in consumer monorepo Doppler dev + prd.'
  );
  console.log('');

  console.log('# Shell (local turbo run):');
  for (const key of [
    ...TURBO_CLIENT_REQUIRED_KEYS,
    ...TURBO_CLIENT_OPTIONAL_KEYS,
  ]) {
    const value = secrets[key];
    if (value !== undefined) {
      console.log(`export ${key}=${shellEscape(value)}`);
    }
  }

  console.log('');
  console.log('# Doppler (consumer monorepo — run from any directory):');
  const dopplerProject = targetProject ?? '<consumer-doppler-project>';
  for (const config of DOPPLER_SETUP_CONFIGS) {
    console.log(`# config=${config}`);
    for (const key of [
      ...TURBO_CLIENT_REQUIRED_KEYS,
      ...TURBO_CLIENT_OPTIONAL_KEYS,
    ]) {
      const value = secrets[key];
      if (value !== undefined) {
        console.log(
          `doppler secrets set ${key}=${shellEscape(value)} -p ${dopplerProject} -c ${config}`
        );
      }
    }
    console.log('');
  }

  if (targetProject === null) {
    console.log(
      '# Push automatically:\n' +
        `bun run seed:turbo-client -- --target-project ${dopplerProject} --target-config ${targetConfig}`
    );
  }

  console.log('');
  console.log('# Turbo CLI:');
  console.log('turbo run build --cache=remote:rw');
}

function pushClientSecrets(
  secrets: Record<string, string>,
  targetProject: string,
  targetConfig: string
): void {
  runOrFail('doppler', ['--version'], 'doppler CLI check');

  for (const [key, value] of Object.entries(secrets)) {
    setSecretPlain(targetProject, targetConfig, key, value);
    console.log(`set ${targetProject}/${targetConfig} ${key}`);
  }

  console.log(
    `Turbo client secrets seeded on Doppler project=${targetProject} config=${targetConfig}`
  );
}

function mirrorDevToPrd(project: string): void {
  runOrFail('doppler', ['--version'], 'doppler CLI check');
  const secrets = resolveClientSecretsFromDoppler(project, 'dev');

  for (const key of [
    ...TURBO_CLIENT_REQUIRED_KEYS,
    ...TURBO_CLIENT_OPTIONAL_KEYS,
  ]) {
    const value = secrets[key];
    if (value === undefined) continue;
    setSecretPlain(project, 'prd', key, value);
    console.log(`mirrored dev → prd ${key}`);
  }

  console.log(
    `Turbo client secrets mirrored dev → prd (project=${project}). Worker secrets unchanged.`
  );
}

function main(): void {
  const options = parseCliOptions();
  let project: string;
  try {
    project = readDopplerYamlDefaults().project;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(msg);
  }

  if (options.mirrorPrd) {
    mirrorDevToPrd(project);
    return;
  }

  const sourceLabel = `${project}/${options.sourceConfig}`;
  const secrets = resolveClientSecretsFromEnv();

  if (options.targetProject !== null) {
    const configs = options.allConfigs
      ? [...DOPPLER_SETUP_CONFIGS]
      : [options.targetConfig];
    for (const config of configs) {
      pushClientSecrets(secrets, options.targetProject, config);
    }
    return;
  }

  printClientSecrets(secrets, sourceLabel, null, options.targetConfig);
}

main();
