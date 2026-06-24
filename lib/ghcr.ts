import {
  imagePackageName,
  infraGithubRepo,
  loadServicesConfig,
  type ServicesConfig,
} from "./services.js";

/** Pre-migration package names still on GHCR. */
const LEGACY_PACKAGE_NAMES: Readonly<Record<string, readonly string[]>> = {};

export function ghcrAuthTokens(): readonly string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const value of [
    process.env.GH_TOKEN,
    process.env.GITHUB_TOKEN,
    process.env.GITHUB_TOKEN_SUPER,
    process.env.DEPLOY_DISPATCH_TOKEN,
  ]) {
    const token = value?.trim();
    if (token && !seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  }
  return tokens;
}

export function ghcrToken(): string | undefined {
  return ghcrAuthTokens()[0];
}

export function packageNamesForService(config: ServicesConfig, serviceId: string): readonly string[] {
  return [
    imagePackageName(config, serviceId),
    ...(LEGACY_PACKAGE_NAMES[serviceId] ?? []),
  ];
}

function ghcrVisibilityUrls(owner: string, packageName: string, repoSlug?: string): readonly string[] {
  const urls = [
    `https://api.github.com/user/packages/container/${packageName}/visibility`,
    `https://api.github.com/users/${owner}/packages/container/${packageName}/visibility`,
    `https://api.github.com/orgs/${owner}/packages/container/${packageName}/visibility`,
  ];
  if (repoSlug) {
    urls.push(`https://api.github.com/repos/${repoSlug}/packages/container/${packageName}/visibility`);
  }
  return urls;
}

export async function setGhcrPackagePublic(
  owner: string,
  packageName: string,
  dryRun = false,
  repoSlug?: string,
): Promise<boolean> {
  const urls = ghcrVisibilityUrls(owner, packageName, repoSlug);

  if (dryRun) {
    console.log(`  [plan] GHCR public ${owner}/${packageName}`);
    return true;
  }

  const tokens = ghcrAuthTokens();
  if (tokens.length === 0) {
    console.warn(`  skip GHCR public ${packageName}: GH_TOKEN or GITHUB_TOKEN required`);
    return false;
  }

  let lastError = "";
  for (const token of tokens) {
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
        console.log(`  GHCR public ${owner}/${packageName} (${url})`);
        return true;
      }
      const text = await res.text();
      lastError = `HTTP ${res.status} at ${url}: ${text.slice(0, 200)}`;
    }
  }

  console.warn(`  skip GHCR public ${packageName}: ${lastError}`);
  return false;
}

export async function ensureGhcrPackagePublic(
  config: ServicesConfig,
  serviceId: string,
  dryRun = false,
): Promise<void> {
  const repoSlug = infraGithubRepo(config);
  for (const packageName of packageNamesForService(config, serviceId)) {
    await setGhcrPackagePublic(config.image_owner, packageName, dryRun, repoSlug);
  }
}
