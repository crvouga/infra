/** Public origin for the self-hosted Turborepo remote cache Worker. */
export const CACHE_PUBLIC_ORIGIN = 'https://turborepo.chrisvouga.dev';

export type DopplerSecretUsedBy = 'worker' | 'client' | 'deploy';

export type DopplerSecretDefinition = {
  readonly key: string;
  readonly required: boolean;
  readonly usedBy: readonly DopplerSecretUsedBy[];
  readonly hint: string;
  /** When set, `ensure-doppler-secrets` writes this value if the key is missing. */
  readonly defaultValue?: string;
};

/** Stable Doppler secret key literals — single source of truth. */
export const DopplerSecretKey = {
  turboToken: 'TURBO_TOKEN',
  turboApi: 'TURBO_API',
  turboTeam: 'TURBO_TEAM',
  turboCache: 'TURBO_CACHE',
  turboLogOrder: 'TURBO_LOG_ORDER',
  turboTelemetryDisabled: 'TURBO_TELEMETRY_DISABLED',
  b2S3Endpoint: 'B2_S3_ENDPOINT',
  b2S3Region: 'B2_S3_REGION',
  b2S3AccessKeyId: 'B2_S3_ACCESS_KEY_ID',
  b2S3SecretAccessKey: 'B2_S3_SECRET_ACCESS_KEY',
  b2Bucket: 'B2_BUCKET',
  cloudflareApiToken: 'CLOUDFLARE_API_TOKEN',
  cloudflareAccountId: 'CLOUDFLARE_ACCOUNT_ID',
} as const;

export const DOPPLER_SECRET_REGISTRY: readonly DopplerSecretDefinition[] = [
  {
    key: DopplerSecretKey.turboToken,
    required: true,
    usedBy: ['worker', 'client'],
    hint: 'Bearer token Turbo clients send and the cache Worker validates',
  },
  {
    key: DopplerSecretKey.turboApi,
    required: true,
    usedBy: ['client'],
    hint: 'Self-hosted cache URL (TURBO_API env for turbo CLI)',
    defaultValue: CACHE_PUBLIC_ORIGIN,
  },
  {
    key: DopplerSecretKey.turboTeam,
    required: true,
    usedBy: ['client'],
    hint: 'Any team slug (e.g. local) — required by turbo CLI for remote cache',
    defaultValue: 'local',
  },
  {
    key: DopplerSecretKey.b2S3Endpoint,
    required: true,
    usedBy: ['worker'],
    hint: 'Backblaze B2 S3 endpoint URL (e.g. https://s3.us-west-004.backblazeb2.com)',
  },
  {
    key: DopplerSecretKey.b2S3Region,
    required: true,
    usedBy: ['worker'],
    hint: 'B2 region slug (e.g. us-west-004)',
  },
  {
    key: DopplerSecretKey.b2S3AccessKeyId,
    required: true,
    usedBy: ['worker'],
    hint: 'B2 application key ID for the S3-compatible API (starts with 004)',
  },
  {
    key: DopplerSecretKey.b2S3SecretAccessKey,
    required: true,
    usedBy: ['worker'],
    hint: 'B2 application key secret (shown once at key creation; starts with K)',
  },
  {
    key: DopplerSecretKey.b2Bucket,
    required: true,
    usedBy: ['worker'],
    hint: 'B2 bucket name for cache artifacts',
  },
  {
    key: DopplerSecretKey.cloudflareApiToken,
    required: true,
    usedBy: ['deploy'],
    hint: 'Cloudflare API token with Workers deploy permissions',
  },
  {
    key: DopplerSecretKey.cloudflareAccountId,
    required: true,
    usedBy: ['deploy'],
    hint: 'Cloudflare account ID for wrangler deploy',
  },
  {
    key: DopplerSecretKey.turboCache,
    required: false,
    usedBy: ['client'],
    hint: 'Turbo --cache flag default (e.g. remote:rw)',
    defaultValue: 'remote:rw',
  },
  {
    key: DopplerSecretKey.turboLogOrder,
    required: false,
    usedBy: ['client'],
    hint: 'Turbo log order (e.g. stream)',
  },
  {
    key: DopplerSecretKey.turboTelemetryDisabled,
    required: false,
    usedBy: ['client'],
    hint: 'Set to 1 to disable Turbo telemetry',
  },
] as const;

export const DOPPLER_SETUP_CONFIGS = ['dev', 'prd'] as const;

/** Turbo env vars consumer monorepos need to use this self-hosted cache. */
export const TURBO_CLIENT_REQUIRED_KEYS = [
  DopplerSecretKey.turboToken,
  DopplerSecretKey.turboApi,
  DopplerSecretKey.turboTeam,
  DopplerSecretKey.turboCache,
] as const;

/** Optional Turbo client env vars copied when set in the source config. */
export const TURBO_CLIENT_OPTIONAL_KEYS = [
  DopplerSecretKey.turboLogOrder,
  DopplerSecretKey.turboTelemetryDisabled,
] as const;

export function turboClientRegistryDefaults(): Readonly<
  Record<string, string | undefined>
> {
  const defaults: Record<string, string | undefined> = {};
  for (const def of DOPPLER_SECRET_REGISTRY) {
    if (def.defaultValue !== undefined) {
      defaults[def.key] = def.defaultValue;
    }
  }
  return defaults;
}

const TURBO_CACHE_RE = /^(local|remote):(r|rw|w)?(,(local|remote):(r|rw|w)?)?$/;

export function validateOptionalSecretFormat(
  key: string,
  value: string
): string | null {
  if (key === DopplerSecretKey.turboApi) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') {
        return `TURBO_API must be an https URL, got ${value}`;
      }
    } catch {
      return `TURBO_API must be a valid URL, got ${value}`;
    }
  }
  if (key === DopplerSecretKey.turboCache && !TURBO_CACHE_RE.test(value)) {
    return `Invalid TURBO_CACHE "${value}" (expected e.g. remote:rw)`;
  }
  return null;
}
