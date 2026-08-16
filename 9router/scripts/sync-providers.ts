import { createAuthedClient } from "./lib/client.ts";
import { loadCombosSpec } from "./lib/combos.ts";
import {
  activeConnectionsByProvider,
  formatSyncSummary,
  loadCredentialMap,
  loadProvidersSpec,
  resolveProviderCatalog,
  syncOneProvider,
  type SyncResult,
} from "./lib/providers.ts";
import {
  fetchProviderConnections,
  loadProviderIndex,
  missingCredentialProviders,
  providersReferencedBySpec,
  activeProviderIds,
} from "./lib/registry.ts";

function parseArgs(argv: string[]): {
  dryRun: boolean;
  force: boolean;
  interactive: boolean;
  strict: boolean;
} {
  let dryRun = false;
  let force = false;
  let interactive = false;
  let strict = false;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--force") force = true;
    else if (arg === "--interactive") interactive = true;
    else if (arg === "--strict") strict = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: npm run sync-providers [-- --dry-run] [-- --force]
                   [-- --interactive] [-- --strict]

Create 9Router provider connections from Vault / env / local auto-import.

  --dry-run       Show planned actions; do not create/update
  --force         Refresh API keys when a connection already exists
  --interactive   Run device-code OAuth for kiro/github (opens browser)
  --strict        Exit 1 if any combo-referenced provider still lacks credentials

Missing credentials skip that provider (exit 0 unless --strict / failures).
`);
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${arg}`);
      process.exit(1);
    }
  }
  return { dryRun, force, interactive, strict };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const spec = loadProvidersSpec();
  const catalog = await resolveProviderCatalog(spec);
  const { creds, vaultPath, vaultOk, vaultError } = await loadCredentialMap();

  console.log(`==> Sync providers (${catalog.length} in catalog)`);
  console.log(
    vaultOk
      ? `    Vault: ${vaultPath} (ok)`
      : `    Vault: ${vaultPath} (unavailable${vaultError ? `: ${vaultError.slice(0, 80)}` : ""}) — using process env only`,
  );
  if (opts.dryRun) console.log("    Mode: dry-run");
  if (opts.force) console.log("    Mode: force");
  if (opts.interactive) console.log("    Mode: interactive");

  const client = await createAuthedClient();
  const connections = await fetchProviderConnections(client);
  const existing = activeConnectionsByProvider(connections);

  const results: SyncResult[] = [];
  for (const provider of catalog) {
    const result = await syncOneProvider(client, provider, creds, existing, {
      dryRun: opts.dryRun,
      force: opts.force,
      interactive: opts.interactive,
      connectionName: spec.defaults.connectionName,
    });
    results.push(result);

    const tag =
      result.kind === "created"
        ? "+"
        : result.kind === "updated"
          ? "~"
          : result.kind === "failed"
            ? "!"
            : "·";
    const detail = result.detail ? `  (${result.detail})` : "";
    console.log(`  ${tag} ${result.kind.padEnd(22)} ${result.id}${detail}`);

    // Keep existing map fresh for later providers / force paths
    if (
      !opts.dryRun &&
      (result.kind === "created" || result.kind === "updated")
    ) {
      const list = existing.get(provider.id) ?? [];
      if (list.length === 0) {
        existing.set(provider.id, [
          { provider: provider.id, name: spec.defaults.connectionName, isActive: true },
        ]);
      }
    }
  }

  console.log(`\n==> Summary`);
  console.log(`    ${formatSyncSummary(results)}`);

  const failed = results.filter((r) => r.kind === "failed");
  if (failed.length > 0) {
    console.error(`\n${failed.length} provider(s) failed to connect.`);
    process.exit(1);
  }

  if (opts.strict) {
    const index = await loadProviderIndex();
    const comboSpec = loadCombosSpec();
    const needed = providersReferencedBySpec(comboSpec, index);
    const fresh = opts.dryRun
      ? connections
      : await fetchProviderConnections(client);
    const active = activeProviderIds(fresh, index);
    const missing = missingCredentialProviders(needed, active);
    if (missing.length > 0) {
      console.error(
        `\n--strict: combo providers still missing credentials: ${missing.join(", ")}`,
      );
      console.error(
        `Add Vault keys or run with --interactive, then: open ${client.baseUrl}`,
      );
      process.exit(1);
    }
    console.log(
      `\n--strict: all ${needed.size} combo-referenced provider(s) have credentials.`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
