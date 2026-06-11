import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export type SecretSource =
  | { readonly source: "vault" }
  | { readonly source: "literal"; readonly value: string };

export type SecretSpec = {
  readonly name: string;
} & SecretSource;

export type ServiceSpec = {
  readonly id: string;
  readonly hostname: string;
  readonly github_repo: string;
  readonly source_code_url: string;
  readonly dockerfile: string;
  readonly build_context: string;
  readonly port: number;
  readonly health_check: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly secrets?: readonly SecretSpec[];
};

export type ServicesConfig = {
  readonly zone: string;
  readonly origin_hostname: string;
  readonly image_owner: string;
  readonly default_image_tag: string;
  readonly skip_rollout_repos?: readonly string[];
  readonly services: readonly ServiceSpec[];
};

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
  }
  return raw;
}

export function findService(
  config: ServicesConfig,
  id: string,
): ServiceSpec | undefined {
  return config.services.find((s) => s.id === id);
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
