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

export type ServiceSpec = {
  readonly id: string;
  /** Public hostname; required unless `internal: true`. */
  readonly hostname?: string;
  /** No Traefik routing, DNS, or public URL — queue consumers, etc. */
  readonly internal?: boolean;
  readonly github_repo: string;
  readonly source_code_url: string;
  readonly dockerfile: string;
  readonly build_context: string;
  /** Traefik backend port; required for public services. */
  readonly port?: number;
  readonly health_check: boolean;
  /** Health-check path (default `/`). */
  readonly health_path?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly secrets?: readonly SecretSpec[];
  /** Compose service ids this service should start after. */
  readonly depends_on?: readonly string[];
};

/** Upstream Docker image — no GHCR build; defined in chrisvouga.dev only. */
export type InfraServiceSpec = {
  readonly id: string;
  readonly hostname: string;
  readonly image: string;
  readonly port: number;
  readonly health_check: boolean;
  readonly health_path?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly volumes?: readonly string[];
  readonly cap_add?: readonly string[];
  readonly security_opt?: readonly string[];
  readonly pid?: string;
  readonly secrets?: readonly SecretSpec[];
  /** Extra Traefik middleware refs appended after cfproto@docker (e.g. netdata-auth@file). */
  readonly traefik_middlewares?: readonly string[];
};

export type ServicesConfig = {
  readonly zone: string;
  readonly origin_hostname: string;
  readonly image_owner: string;
  readonly default_image_tag: string;
  readonly skip_rollout_repos?: readonly string[];
  readonly aliases?: readonly AliasSpec[];
  readonly services: readonly ServiceSpec[];
  readonly infra_services?: readonly InfraServiceSpec[];
};

export function isPublicService(service: ServiceSpec): boolean {
  return service.internal !== true;
}

export function imageRepo(config: ServicesConfig, id: string): string {
  return `ghcr.io/${config.image_owner}/chrisvouga-${id}`;
}

export function composeServiceName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function loadServicesConfig(path = "services.yaml"): ServicesConfig {
  const raw = parseYaml(readFileSync(path, "utf8")) as ServicesConfig;
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
    } else {
      if (!service.hostname) {
        throw new Error(`Service "${service.id}" missing hostname`);
      }
      if (service.port == null) {
        throw new Error(`Service "${service.id}" missing port`);
      }
    }
  }
  for (const service of raw.infra_services ?? []) {
    if (!service.hostname || service.port == null || !service.image) {
      throw new Error(`Infra service "${service.id}" missing hostname, port, or image`);
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

export function findInfraService(
  config: ServicesConfig,
  id: string,
): InfraServiceSpec | undefined {
  return config.infra_services?.find((s) => s.id === id);
}

export function isInfraService(config: ServicesConfig, id: string): boolean {
  return findInfraService(config, id) != null;
}

export type DnsTarget = { readonly id: string; readonly hostname: string };

/** Public app + infra hostnames for Cloudflare DNS sync. */
export function allDnsTargets(config: ServicesConfig): readonly DnsTarget[] {
  const app: DnsTarget[] = [];
  for (const service of config.services) {
    if (isPublicService(service) && service.hostname) {
      app.push({ id: service.id, hostname: service.hostname });
    }
  }
  const infra = (config.infra_services ?? []).map((s) => ({
    id: s.id,
    hostname: s.hostname,
  }));
  return [...app, ...infra];
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
  for (const service of config.infra_services ?? []) {
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
