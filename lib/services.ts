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

export type ServiceRuntime = "always_on" | "on_demand";

export type InfraBuildSpec = {
  readonly dockerfile: string;
  readonly context: string;
};

export type OrchestratorConfig = {
  readonly idle_timeout_minutes?: number;
};

export type ServiceSpec = {
  readonly id: string;
  /** Public hostname; required unless `internal: true`. */
  readonly hostname?: string;
  /** No Traefik routing, DNS, or public URL — queue consumers, etc. */
  readonly internal?: boolean;
  /** Default `on_demand` — orchestrator wakes on first request. */
  readonly runtime?: ServiceRuntime;
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

/** Upstream Docker image — no GHCR build; defined on the origin node only. */
export type InfraServiceSpec = {
  readonly id: string;
  readonly hostname: string;
  readonly image?: string;
  readonly build?: InfraBuildSpec;
  readonly port: number;
  readonly health_check: boolean;
  /** Default `on_demand`. */
  readonly runtime?: ServiceRuntime;
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
  readonly do_project_name?: string;
  readonly droplet_name?: string;
  readonly infra_github_repo?: string;
  readonly image_prefix?: string;
  readonly skip_rollout_repos?: readonly string[];
  readonly orchestrator?: OrchestratorConfig;
  readonly aliases?: readonly AliasSpec[];
  readonly services: readonly ServiceSpec[];
  readonly infra_services?: readonly InfraServiceSpec[];
};

export function zoneSlug(zone: string): string {
  return zone.replace(/\./g, "-");
}

export function imagePrefix(config: ServicesConfig): string {
  return config.image_prefix?.trim() || zoneSlug(config.zone);
}

export function deployDir(config: ServicesConfig): string {
  return `/opt/${zoneSlug(config.zone)}`;
}

export function dockerNetworkName(config: ServicesConfig): string {
  return `${zoneSlug(config.zone)}-web`;
}

export function composeProjectName(config: ServicesConfig): string {
  return zoneSlug(config.zone);
}

export function vaultAddr(config: ServicesConfig): string {
  return `https://vault.${config.zone}`;
}

export function systemdUnitName(config: ServicesConfig): string {
  return `${zoneSlug(config.zone)}.service`;
}

export function doProjectName(config: ServicesConfig): string {
  return config.do_project_name?.trim() || "projects";
}

export function dropletName(config: ServicesConfig): string {
  return config.droplet_name?.trim() || "origin";
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

export function composeServiceName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function serviceRuntime(
  service: ServiceSpec | InfraServiceSpec,
): ServiceRuntime {
  return service.runtime ?? "on_demand";
}

export function isAlwaysOn(service: ServiceSpec | InfraServiceSpec): boolean {
  return serviceRuntime(service) === "always_on";
}

export function isOnDemand(service: ServiceSpec | InfraServiceSpec): boolean {
  return serviceRuntime(service) === "on_demand";
}

export function idleTimeoutMinutes(config: ServicesConfig): number {
  return config.orchestrator?.idle_timeout_minutes ?? 30;
}

/** Compose service ids that start on boot (traefik is implicit). */
export function alwaysOnComposeNames(config: ServicesConfig): readonly string[] {
  const names = new Set<string>(["traefik"]);
  for (const service of config.services) {
    if (isAlwaysOn(service)) names.add(composeServiceName(service.id));
  }
  for (const service of config.infra_services ?? []) {
    if (isAlwaysOn(service)) names.add(composeServiceName(service.id));
  }
  return [...names].sort();
}

/** Public app + infra services routed through the orchestrator when on_demand. */
export function onDemandPublicTargets(
  config: ServicesConfig,
): readonly { readonly id: string; readonly hostname: string; readonly port: number; readonly traefik_middlewares?: readonly string[] }[] {
  const targets: Array<{
    id: string;
    hostname: string;
    port: number;
    traefik_middlewares?: readonly string[];
  }> = [];
  for (const service of config.services) {
    if (!isOnDemand(service) || !isPublicService(service) || !service.hostname || service.port == null) {
      continue;
    }
    targets.push({ id: service.id, hostname: service.hostname, port: service.port });
  }
  for (const service of config.infra_services ?? []) {
    if (!isOnDemand(service)) continue;
    targets.push({
      id: service.id,
      hostname: service.hostname,
      port: service.port,
      traefik_middlewares: service.traefik_middlewares,
    });
  }
  return targets;
}

/** Services that depend on `id` (reverse depends_on edges). */
export function dependentsOf(config: ServicesConfig, id: string): readonly string[] {
  return config.services
    .filter((s) => s.depends_on?.includes(id))
    .map((s) => s.id);
}

/** Topological stop order: dependents before dependencies. */
export function stopOrder(config: ServicesConfig, ids: readonly string[]): readonly string[] {
  const idSet = new Set(ids);
  const ordered: string[] = [];
  const visited = new Set<string>();

  function visit(id: string): void {
    if (visited.has(id) || !idSet.has(id)) return;
    visited.add(id);
    for (const dep of dependentsOf(config, id)) {
      visit(dep);
    }
    ordered.push(id);
  }

  for (const id of ids) visit(id);
  return ordered;
}

/** Start order: dependencies before dependents. */
export function startOrder(config: ServicesConfig, ids: readonly string[]): readonly string[] {
  return [...stopOrder(config, ids)].reverse();
}

export function loadServicesConfig(path = "services.yaml"): ServicesConfig {
  const raw = parseYaml(readFileSync(path, "utf8")) as ServicesConfig;
  if (!raw?.zone?.trim()) {
    throw new Error(`Invalid services config at ${path}: zone is required`);
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
    if (!service.hostname || service.port == null) {
      throw new Error(`Infra service "${service.id}" missing hostname or port`);
    }
    if (!service.image && !service.build) {
      throw new Error(`Infra service "${service.id}" requires image or build`);
    }
    if (service.image && service.build) {
      throw new Error(`Infra service "${service.id}" cannot have both image and build`);
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
