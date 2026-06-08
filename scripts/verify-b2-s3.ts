import { ObjectStoreImplS3 } from '@pkgs/object-store/impl-s3';
import type { ObjectStoreS3Config } from '@pkgs/object-store/impl-s3';

import { DopplerSecretKey } from './doppler-secrets-registry';

function readRequiredEnv(key: string): string | null {
  const value = process.env[key]?.trim() ?? '';
  return value.length > 0 ? value : null;
}

export function readB2S3ConfigFromEnv(): ObjectStoreS3Config | null {
  const endpoint = readRequiredEnv(DopplerSecretKey.b2S3Endpoint);
  const region = readRequiredEnv(DopplerSecretKey.b2S3Region);
  const accessKeyId = readRequiredEnv(DopplerSecretKey.b2S3AccessKeyId);
  const secretAccessKey = readRequiredEnv(DopplerSecretKey.b2S3SecretAccessKey);
  const bucket = readRequiredEnv(DopplerSecretKey.b2Bucket);

  if (
    endpoint === null ||
    region === null ||
    accessKeyId === null ||
    secretAccessKey === null ||
    bucket === null
  ) {
    return null;
  }

  return { endpoint, region, accessKeyId, secretAccessKey, bucket };
}

const B2_CREDENTIAL_HINT =
  'Create a new Backblaze B2 application key with read/write access to the cache bucket, then set B2_S3_ACCESS_KEY_ID (key ID) and B2_S3_SECRET_ACCESS_KEY (application key) in Doppler dev and prd.';

function formatB2ProbeError(message: string, bucket: string): string {
  if (
    message.includes('403') ||
    message.includes('401') ||
    message.includes('Signature')
  ) {
    return (
      `B2 S3 credentials rejected for bucket "${bucket}" (${message}).\n` +
      B2_CREDENTIAL_HINT
    );
  }
  return `B2 S3 probe failed for bucket "${bucket}": ${message}`;
}

/**
 * Writes and reads a tiny probe object via the S3-compatible API.
 * Returns an error message when credentials or bucket access are invalid.
 */
export async function verifyB2S3Credentials(): Promise<string | null> {
  const config = readB2S3ConfigFromEnv();
  if (config === null) {
    return 'B2 S3 env vars are missing (B2_S3_ENDPOINT, B2_S3_REGION, B2_S3_ACCESS_KEY_ID, B2_S3_SECRET_ACCESS_KEY, B2_BUCKET).';
  }

  const store = new ObjectStoreImplS3(config);
  const probeKey = `credential-probe-${String(Date.now())}`;
  const probeBytes = new Uint8Array([0x53, 0x4d, 0x4b]); // "SMK"

  try {
    await store.put(probeKey, probeBytes, 'application/octet-stream');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return formatB2ProbeError(message, config.bucket);
  }

  try {
    const exists = await store.head(probeKey);
    if (!exists) {
      return `B2 S3 put succeeded but HEAD ${probeKey} returned false (bucket "${config.bucket}").`;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return formatB2ProbeError(message, config.bucket);
  }

  try {
    const stored = await store.get(probeKey);
    if (stored === null) {
      return `B2 S3 HEAD succeeded but GET ${probeKey} returned null (bucket "${config.bucket}").`;
    }
    const reader = stored.body.getReader();
    const chunk = await reader.read();
    await reader.cancel();
    if (chunk.done || chunk.value === undefined) {
      return `B2 S3 GET ${probeKey} returned empty body (bucket "${config.bucket}").`;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return formatB2ProbeError(message, config.bucket);
  }

  return null;
}
