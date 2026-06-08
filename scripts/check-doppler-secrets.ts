/**
 * Verifies required Doppler secrets for the Turborepo remote cache repo.
 *
 * CI: `DOPPLER_SERVICE_TOKEN` → `doppler run` (dev config) before `bun run check`.
 * Deploy: re-run against `prd` before `wrangler deploy`.
 */
import { createDopplerSecretStoreForScripts } from '@pkgs/secret-store/create-doppler-secret-store-for-scripts';

import {
  DOPPLER_SECRET_REGISTRY,
  DopplerSecretKey,
  validateOptionalSecretFormat,
} from './doppler-secrets-registry';
import { verifyB2S3Credentials } from './verify-b2-s3';

function isCi(): boolean {
  return (
    process.env['GITHUB_ACTIONS'] === 'true' ||
    process.env['CI'] === 'true' ||
    process.env['TURBO_FORCE_REMOTE_CACHE_CHECK'] === '1'
  );
}

function fail(message: string): never {
  console.error('');
  console.error('════════════════════════════════════════════════════════');
  console.error('  Doppler secrets check FAILED');
  console.error('════════════════════════════════════════════════════════');
  console.error(message);
  console.error('');
  console.error('Run `bun run setup` to apply derived defaults, then set');
  console.error('remaining secrets via `doppler secrets set KEY=value`.');
  console.error('Registry: scripts/doppler-secrets-registry.ts');
  console.error('');
  process.exit(1);
}

async function smokeCacheStatus(
  apiUrl: string,
  token: string
): Promise<string | null> {
  const url = `${apiUrl.replace(/\/$/, '')}/v8/artifacts/status`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return `GET ${url} returned HTTP ${String(res.status)}`;
    }
    const body = (await res.json()) as { status?: string };
    if (body.status !== 'enabled') {
      return `GET ${url} returned unexpected body: ${JSON.stringify(body)}`;
    }
    return null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `GET ${url} failed: ${msg}`;
  }
}

async function main(): Promise<void> {
  const config =
    process.env['DOPPLER_CONFIG']?.trim() ||
    process.env['DOPPLER_ENVIRONMENT']?.trim() ||
    'dev';
  const project =
    process.env['DOPPLER_PROJECT']?.trim() || '(from doppler.yaml)';

  console.log(`Doppler secrets check (project=${project}, config=${config})`);

  const store = createDopplerSecretStoreForScripts();
  const missingRequired: string[] = [];
  const optionalWarnings: string[] = [];

  for (const def of DOPPLER_SECRET_REGISTRY) {
    const value = await store.getOptional(def.key);
    const raw = value?.readSecretValue().trim() ?? '';

    if (def.required) {
      if (raw.length === 0) {
        missingRequired.push(`  • ${def.key} — ${def.hint}`);
      } else if (def.key === DopplerSecretKey.turboApi) {
        const err = validateOptionalSecretFormat(def.key, raw);
        if (err !== null) missingRequired.push(`  • ${err}`);
      }
      continue;
    }

    if (raw.length === 0) {
      optionalWarnings.push(`  • ${def.key} (optional, unset)`);
      continue;
    }

    const err = validateOptionalSecretFormat(def.key, raw);
    if (err !== null) {
      missingRequired.push(`  • ${err}`);
    }
  }

  if (missingRequired.length > 0) {
    fail(`Missing or invalid required secrets:\n${missingRequired.join('\n')}`);
  }

  for (const line of optionalWarnings) {
    console.log(`warn:${line}`);
  }

  const b2Err = await verifyB2S3Credentials();
  if (b2Err !== null) {
    fail(`B2 S3 credentials check failed:\n  • ${b2Err}`);
  }
  console.log('B2 S3 credentials OK');

  const turboApi =
    (await store.getOptional(DopplerSecretKey.turboApi))?.readSecretValue() ??
    '';
  const turboToken =
    (await store.getOptional(DopplerSecretKey.turboToken))?.readSecretValue() ??
    '';

  // Skip cache smoke test in CI - the Worker doesn't exist until after deployment.
  if (!isCi() && turboApi.length > 0 && turboToken.length > 0) {
    const smokeErr = await smokeCacheStatus(turboApi, turboToken);
    if (smokeErr !== null) {
      console.log(`warn: cache smoke test failed: ${smokeErr}`);
    } else {
      console.log('Cache smoke OK (/v8/artifacts/status)');
    }
  }

  console.log(`Doppler secrets OK (config=${config})`);
}

await main();
