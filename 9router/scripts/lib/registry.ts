import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { APP_DIR } from "./paths.ts";
import type { CombosSpec } from "./combos.ts";
import type { NineRouterClient } from "./client.ts";

export type RegistryProvider = {
  id: string;
  alias?: string;
  aliases?: string[];
  models?: Array<{ id: string; name?: string; kind?: string }>;
};

export type ProviderIndex = {
  /** alias or id → canonical provider id */
  byPrefix: Map<string, string>;
  /** canonical provider id → set of model ids */
  modelsByProvider: Map<string, Set<string>>;
};

export type RegistryIssue =
  | { kind: "unknown_provider"; combo: string; model: string; prefix: string }
  | {
      kind: "unknown_model";
      combo: string;
      model: string;
      providerId: string;
      prefix: string;
    };

export type ProviderConnection = {
  id?: string;
  provider: string;
  name?: string;
  isActive?: boolean | number;
};

/**
 * Load upstream provider registry from the local 9Router app clone.
 */
export async function loadProviderIndex(
  registryPath = join(APP_DIR, "open-sse/providers/registry/index.js"),
): Promise<ProviderIndex> {
  const mod = await import(pathToFileURL(registryPath).href);
  const entries = (mod.default ?? mod) as RegistryProvider[];
  if (!Array.isArray(entries)) {
    throw new Error(`Provider registry at ${registryPath} did not export an array`);
  }

  const byPrefix = new Map<string, string>();
  const modelsByProvider = new Map<string, Set<string>>();

  for (const entry of entries) {
    if (!entry?.id) continue;
    byPrefix.set(entry.id, entry.id);
    if (entry.alias) byPrefix.set(entry.alias, entry.id);
    for (const a of entry.aliases ?? []) byPrefix.set(a, entry.id);

    const modelIds = new Set<string>();
    for (const m of entry.models ?? []) {
      if (m?.id) modelIds.add(m.id);
    }
    modelsByProvider.set(entry.id, modelIds);
  }

  return { byPrefix, modelsByProvider };
}

export function validateModelsAgainstRegistry(
  spec: CombosSpec,
  index: ProviderIndex,
): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  for (const combo of spec.combos) {
    for (const model of combo.models) {
      const slash = model.indexOf("/");
      if (slash <= 0) continue;
      const prefix = model.slice(0, slash);
      const modelId = model.slice(slash + 1);
      const providerId = index.byPrefix.get(prefix);
      if (!providerId) {
        issues.push({
          kind: "unknown_provider",
          combo: combo.name,
          model,
          prefix,
        });
        continue;
      }
      const known = index.modelsByProvider.get(providerId);
      if (!known || !known.has(modelId)) {
        issues.push({
          kind: "unknown_model",
          combo: combo.name,
          model,
          providerId,
          prefix,
        });
      }
    }
  }
  return issues;
}

export function formatRegistryIssues(issues: RegistryIssue[]): string {
  if (issues.length === 0) return "All combo models exist in the provider registry.";
  const lines: string[] = [];
  for (const i of issues) {
    if (i.kind === "unknown_provider") {
      lines.push(
        `  ! unknown provider prefix "${i.prefix}" in ${i.combo} (${i.model})`,
      );
    } else {
      lines.push(
        `  ! unknown model "${i.model}" in ${i.combo} (provider ${i.providerId})`,
      );
    }
  }
  return lines.join("\n");
}

/** Collect canonical provider ids referenced by the combo spec. */
export function providersReferencedBySpec(
  spec: CombosSpec,
  index: ProviderIndex,
): Set<string> {
  const ids = new Set<string>();
  for (const combo of spec.combos) {
    for (const model of combo.models) {
      const slash = model.indexOf("/");
      if (slash <= 0) continue;
      const prefix = model.slice(0, slash);
      const providerId = index.byPrefix.get(prefix);
      if (providerId) ids.add(providerId);
    }
  }
  return ids;
}

export async function fetchProviderConnections(
  client: NineRouterClient,
): Promise<ProviderConnection[]> {
  const data = await client.json<{ connections: ProviderConnection[] }>(
    "/api/providers",
  );
  return data.connections ?? [];
}

/** Providers that have at least one active connection (canonical id). */
export function activeProviderIds(
  connections: ProviderConnection[],
  index: ProviderIndex,
): Set<string> {
  const active = new Set<string>();
  for (const c of connections) {
    const isActive = c.isActive === undefined || c.isActive === true || c.isActive === 1;
    if (!isActive || !c.provider) continue;
    const canonical =
      index.byPrefix.get(c.provider) ??
      (index.modelsByProvider.has(c.provider) ? c.provider : null);
    if (canonical) active.add(canonical);
    else active.add(c.provider);
  }
  return active;
}

export function missingCredentialProviders(
  needed: Set<string>,
  active: Set<string>,
): string[] {
  return [...needed].filter((id) => !active.has(id)).sort();
}
