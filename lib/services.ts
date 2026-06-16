import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export type SecretSource =
  | { readonly source: "vault" }
  | { readonly source: "github" }
  | { readonly source: "literal"; readonly value: string };

export type SecretSpec = {
  readonly name: string;
} & SecretSource;

export type AliasSpec = {
  readonly zone: string;
  readonly hosts: readonly string[];
  readonly target: string;
};

export type FlyServiceConfig = {
  /** Minimum running machines (default 0 — scale to zero). */
  readonly min_machines?: number;
  /** Expose HTTP on Fly (default true for public services). */
  readonly public?: boolean;
};

export type FlyPlatformConfig = {
  readonly org: string;
  readonly app_prefix: string;
  readonly region: string;
};

export type ServiceSpec = {
  readonly id: string;
  /** Public hostname; required unless `internal: true`. */
  readonly hostname?: string;
  /** No DNS or public URL — queue consumers, etc. */
  readonly internal?: boolean;
  readonly fly?: FlyServiceConfig;
  readonly github_repo: string;
  readonly source_code_url: string;
  readonly dockerfile: string;
  readonly build_context: string;
  /** Container listen port; required for public HTTP services. */
  readonly port?: number;
  readonly health_check: boolean;
  /** Health-check path (default `/`). */
  readonly health_path?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly secrets?: readonly SecretSpec[];
  readonly depends_on?: readonly string[];
};

export type ServicesConfig = {
  readonly zone: string;
  readonly image_owner: string;
  readonly default_image_tag: string;
  readonly infra_github_repo?: string;
  readonly image_prefix?: string;
  readonly skip_rollout_repos?: readonly string[];
  readonly fly: FlyPlatformConfig;
  readonly aliases?: readonly AliasSpec[];
  readonly services: readonly ServiceSpec[];
};

export function zoneSlug(zone: string): string {
  return zone.replace(/\./g, "-");
}

export function imagePrefix(config: ServicesConfig): string {
  return config.image_prefix?.trim() || zoneSlug(config.zone);
}

export function vaultAddr(config: ServicesConfig): string {
  return `https://vault.${config.zone}`;
}

export function flyOrg(config: ServicesConfig): string {
  const org = config.fly?.org?.trim();
  if (!org) throw new Error("services.yaml: fly.org is required");
  return org;
}

export function flyRegion(config: ServicesConfig): string {
  return config.fly?.region?.trim() || "iad";
}

export function flyAppPrefix(config: ServicesConfig): string {
  return config.fly?.app_prefix?.trim() || "crvouga";
}

export function flyAppName(config: ServicesConfig, id: string): string {
  return `${flyAppPrefix(config)}-${id}`;
}

export function flyAppHostname(config: ServicesConfig, id: string): string {
  return `${flyAppName(config, id)}.fly.dev`;
}

export function flyMinMachines(service: ServiceSpec): number {
  return service.fly?.min_machines ?? 0;
}

export function flyIsPublic(service: ServiceSpec): boolean {
  if (service.internal) return false;
  return service.fly?.public !== false;
}

export function infraGithubRepo(config: ServicesConfig): string {
  const repo = config.infra_github_repo?.trim();
  if (!repo) throw new Error("services.yaml: infra_github_repo is required");
  return repo;
}

export function imagePackageName(config: ServicesConfig, id: string): string {
  return `${imagePrefix(config)}-${id}`;
}

export function isPublicService(service: ServiceSpec): boolean {
  return service.internal !== true;
}

export function imageRepo(config: ServicesConfig, id: string): string {
  return `ghcr.io/${config.image_owner}/${imagePackageName(config, id)}`;
}

export function isAlwaysOn(service: ServiceSpec): boolean {
  return flyMinMachines(service) >= 1;
}

export function loadServicesConfig(path = "services.yaml"): ServicesConfig {
  const raw = parseYaml(readFileSync(path, "utf8")) as ServicesConfig;
  if (!raw?.zone?.trim()) {
    throw new Error(`Invalid services config at ${path}: zone is required`);
  }
  if (!raw?.fly?.org?.trim() || !raw?.fly?.region?.trim()) {
    throw new Error(`Invalid services config at ${path}: fly.org and fly.region are required`);
  }
  if (!raw?.services?.length) {
    throw new Error(`Invalid services config at ${path}`);
  }
  for (const service of raw.services) {
    if (!service.github_repo || !service.source_code_url) {
      throw new Error(`Service "${service.id}" missing github_repo or source_code_url`);
    }
    if (!service.dockerfile || service.build_context === undefined) {
      throw new Error(`Service "${service.id}" missing dockerfile or build_context`);
    }
    if (service.internal) {
      if (service.hostname) {
        throw new Error(`Service "${service.id}" is internal but has hostname`);
      }
    } else if (flyIsPublic(service)) {
      if (!service.hostname) {
        throw new Error(`Service "${service.id}" missing hostname`);
      }
      if (service.port == null) {
        throw new Error(`Service "${service.id}" missing port`);
      }
    }
  }
  return raw;
}

export function findService(
  config: ServicesConfig,
  id: string,
): ServiceSpec | undefined {
  return config.services.find((s) => s.id === id);
}

export type DnsTarget = { readonly id: string; readonly hostname: string };

/** Public hostnames for Cloudflare DNS sync (CNAME → *.fly.dev). */
export function allDnsTargets(config: ServicesConfig): readonly DnsTarget[] {
  const targets: DnsTarget[] = [];
  for (const service of config.services) {
    if (!isPublicService(service) || !flyIsPublic(service) || !service.hostname) {
      continue;
    }
    targets.push({ id: service.id, hostname: service.hostname });
  }
  return targets;
}

export function recordName(hostname: string, zone: string): string {
  return hostname === zone ? "@" : hostname.replace(`.${zone}`, "");
}

export function allVaultSecretNames(config: ServicesConfig): readonly string[] {
  const names = new Set<string>();
  for (const service of config.services) {
    for (const secret of service.secrets ?? []) {
      if (secret.source === "vault") names.add(secret.name);
    }
  }
  return [...names].sort();
}

/** Group deployable services by github_repo for rollout script. */
export function groupByGithubRepo(
  config: ServicesConfig,
): Map<string, ServiceSpec[]> {
  const skip = new Set(config.skip_rollout_repos ?? []);
  const map = new Map<string, ServiceSpec[]>();
  for (const service of config.services) {
    if (skip.has(service.github_repo)) continue;
    const list = map.get(service.github_repo) ?? [];
    list.push(service);
    map.set(service.github_repo, list);
  }
  return map;
}

export function deployableServices(config: ServicesConfig): readonly ServiceSpec[] {
  return config.services;
}
