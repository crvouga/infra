import { imagePackageName, loadServicesConfig, type ServicesConfig } from "./services.js";

/** Pre-migration package names still on GHCR. */
const LEGACY_PACKAGE_NAMES: Readonly<Record<string, readonly string[]>> = {};

export function ghcrToken(): string | undefined {
  return (
    process.env.GH_TOKEN?.trim() ||
    process.env.GITHUB_TOKEN_SUPER?.trim() ||
    process.env.GITHUB_TOKEN?.trim() ||
    undefined
  );
}

export function packageNamesForService(config: ServicesConfig, serviceId: string): readonly string[] {
  return [
    imagePackageName(config, serviceId),
    ...(LEGACY_PACKAGE_NAMES[serviceId] ?? []),
  ];
}

export async function setGhcrPackagePublic(
  owner: string,
  packageName: string,
  dryRun = false,
): Promise<boolean> {
  const urls = [
    `https://api.github.com/user/packages/container/${packageName}/visibility`,
    `https://api.github.com/users/${owner}/packages/container/${packageName}/visibility`,
    `https://api.github.com/orgs/${owner}/packages/container/${packageName}/visibility`,
  ];

  if (dryRun) {
    console.log(`  [plan] GHCR public ${owner}/${packageName}`);
    return true;
  }

  const token = ghcrToken();
  if (!token) {
    console.warn(`  skip GHCR public ${packageName}: GH_TOKEN or GITHUB_TOKEN_SUPER required`);
    return false;
  }

  let lastError = "";
  for (const url of urls) {
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ visibility: "public" }),
    });
    if (res.status === 404) {
      lastError = `not found at ${url}`;
      continue;
    }
    if (res.ok) {
      console.log(`  GHCR public ${owner}/${packageName}`);
      return true;
    }
    const text = await res.text();
    lastError = `HTTP ${res.status}: ${text}`;
  }

  console.warn(`  skip GHCR public ${packageName}: ${lastError}`);
  return false;
}

export async function ensureGhcrPackagePublic(
  config: ServicesConfig,
  serviceId: string,
  dryRun = false,
): Promise<void> {
  for (const packageName of packageNamesForService(config, serviceId)) {
    await setGhcrPackagePublic(config.image_owner, packageName, dryRun);
  }
}
