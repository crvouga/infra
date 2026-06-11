import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CACHE_PUBLIC_HOSTNAME,
  FLY_APP_NAME,
} from '@scripts/vault-secrets-registry';
import {
  readCloudflareDeployConfig,
  syncCloudflareDnsFromFlySetup,
} from '@scripts/cloudflare-dns';

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export type FlyDeployOptions = {
  readonly app?: string;
  readonly image: string;
  readonly vaultToken: string;
};

type CommandResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

function runCommand(
  cmd: string,
  args: string[],
  options?: { inherit?: boolean; input?: string }
): CommandResult {
  const inherit = options?.inherit ?? false;
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: process.env,
    input: options?.input,
    stdio:
      options?.input !== undefined
        ? ['pipe', inherit ? 'inherit' : 'pipe', inherit ? 'inherit' : 'pipe']
        : inherit
          ? 'inherit'
          : ['inherit', 'pipe', 'pipe'],
  });
  return {
    status: result.status ?? 1,
    stdout: inherit ? '' : (result.stdout?.trim() ?? ''),
    stderr: inherit ? '' : (result.stderr?.trim() ?? ''),
  };
}

function runOrExit(
  cmd: string,
  args: string[],
  label: string,
  options?: { inherit?: boolean; input?: string }
): void {
  const result = runCommand(cmd, args, options);
  if (result.status === 0) return;
  process.stderr.write(
    `[deploy] ${label} failed (exit ${String(result.status)})\n`
  );
  if (result.stdout.length > 0) process.stderr.write(`${result.stdout}\n`);
  if (result.stderr.length > 0) process.stderr.write(`${result.stderr}\n`);
  process.exit(result.status);
}

function runFly(args: string[]): CommandResult {
  return runCommand('flyctl', args);
}

function flyAppExists(app: string): boolean {
  return runFly(['status', '--app', app]).status === 0;
}

export function ensureFlyApp(app: string): void {
  if (flyAppExists(app)) {
    process.stdout.write(`[deploy] Fly app ${app} already exists.\n`);
    return;
  }

  process.stdout.write(
    `[deploy] creating Fly app ${app} (org from FLY_API_TOKEN).\n`
  );
  runOrExit(
    'flyctl',
    ['apps', 'create', app, '--yes'],
    `fly apps create ${app}`
  );
}

export function syncFlySecrets(app: string, vaultToken: string): void {
  process.stdout.write(
    `[deploy] syncing VAULT_TOKEN to Fly secrets for ${app}.\n`
  );
  runOrExit(
    'flyctl',
    ['secrets', 'set', 'VAULT_TOKEN=-', '--app', app],
    'fly secrets set VAULT_TOKEN',
    { input: vaultToken }
  );
}

function certificateConfigured(app: string, hostname: string): boolean {
  const result = runFly(['certs', 'list', '--app', app, '--json']);
  if (result.status !== 0) return false;
  try {
    const certs = JSON.parse(result.stdout) as Array<Record<string, string>>;
    return certs.some((cert) => {
      const name = cert['Hostname'] ?? cert['hostname'] ?? '';
      return name === hostname;
    });
  } catch {
    return false;
  }
}

export function ensureFlyCertificate(app: string, hostname: string): void {
  if (certificateConfigured(app, hostname)) {
    process.stdout.write(
      `[deploy] Fly certificate for ${hostname} already configured.\n`
    );
    return;
  }

  process.stdout.write(`[deploy] adding Fly certificate for ${hostname}.\n`);
  runOrExit(
    'flyctl',
    ['certs', 'add', hostname, '--app', app],
    `fly certs add ${hostname}`
  );
}

export function deployFlyImage(app: string, image: string): void {
  process.stdout.write(
    `[deploy] deploying public GHCR image ${image} to ${app}.\n`
  );
  runOrExit(
    'flyctl',
    [
      'deploy',
      '--app',
      app,
      '--config',
      join(apiRoot, 'fly.toml'),
      '--image',
      image,
      '--ha=false',
      '--yes',
      '--wait-timeout',
      '300',
    ],
    'fly deploy'
  );
}

export function fetchFlyCertSetup(app: string, hostname: string): string {
  const setup = runFly(['certs', 'setup', hostname, '--app', app]);
  const show = runFly(['certs', 'show', hostname, '--app', app]);
  const combined = [setup.stdout, setup.stderr, show.stdout, show.stderr]
    .filter((part) => part.length > 0)
    .join('\n');
  if (combined.length === 0) {
    process.stderr.write(
      `[deploy] fly certs setup/show returned no output for ${hostname}.\n`
    );
    process.exit(setup.status !== 0 ? setup.status : show.status);
  }
  return combined;
}

export async function syncCloudflareDns(app: string): Promise<void> {
  const { cloudflareApiToken } = readCloudflareDeployConfig();
  await syncCloudflareDnsFromFlySetup({
    flyApp: app,
    hostname: CACHE_PUBLIC_HOSTNAME,
    cloudflareApiToken,
    fetchFlySetup: fetchFlyCertSetup,
  });
}

export function resolveFlyDeployOptions(): FlyDeployOptions {
  const vaultToken = process.env['VAULT_TOKEN']?.trim() ?? '';
  if (vaultToken.length === 0) {
    process.stderr.write(
      '[deploy] VAULT_TOKEN is required (long-lived Vault token from Vault prd config).\n'
    );
    process.exit(1);
  }

  const image = process.env['DEPLOY_IMAGE']?.trim();
  if (image === undefined || image.length === 0) {
    process.stderr.write('[deploy] DEPLOY_IMAGE is required in CI deploys.\n');
    process.exit(1);
  }

  if (!image.startsWith('ghcr.io/')) {
    process.stderr.write(
      `[deploy] DEPLOY_IMAGE must be a GHCR image (expected prefix ghcr.io/), got ${image}.\n`
    );
    process.exit(1);
  }

  return {
    app: process.env['FLY_APP']?.trim() || FLY_APP_NAME,
    image,
    vaultToken,
  };
}

export async function runPipelineDeploy(
  options: FlyDeployOptions
): Promise<void> {
  const app = options.app ?? FLY_APP_NAME;

  ensureFlyApp(app);
  syncFlySecrets(app, options.vaultToken);
  ensureFlyCertificate(app, CACHE_PUBLIC_HOSTNAME);
  await syncCloudflareDns(app);
  deployFlyImage(app, options.image);
}
