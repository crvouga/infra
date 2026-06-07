import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDopplerScope } from '@scripts/doppler-yaml-defaults';

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd: string, args: string[], input?: string): void {
  const result = spawnSync(cmd, args, {
    cwd: apiRoot,
    stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
    env: process.env,
    input,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const token = process.env['DOPPLER_TOKEN']?.trim() ?? '';
if (token.length === 0) {
  process.stderr.write(
    '[deploy] DOPPLER_TOKEN is required in env (use `doppler run -- bun run deploy`).\n'
  );
  process.exit(1);
}

const { config: dopplerConfig } = resolveDopplerScope({
  envProject: process.env['DOPPLER_PROJECT'],
  envConfig: process.env['DOPPLER_CONFIG'],
});
const wranglerEnv = dopplerConfig === 'dev' ? 'dev' : 'prd';

run(
  'wrangler',
  ['secret', 'put', 'DOPPLER_TOKEN', '--env', wranglerEnv],
  token
);
run('wrangler', ['deploy', '--env', wranglerEnv]);
