import { createAuthedClient } from "./lib/client.ts";
import {
  diffCombos,
  fetchComboStrategies,
  fetchCombos,
  formatDiffs,
  loadCombosSpec,
  desiredStrategy,
} from "./lib/combos.ts";
import {
  activeProviderIds,
  fetchProviderConnections,
  formatRegistryIssues,
  loadProviderIndex,
  missingCredentialProviders,
  providersReferencedBySpec,
  validateModelsAgainstRegistry,
} from "./lib/registry.ts";
import { LOCAL_BASE_URL } from "./lib/paths.ts";

async function main(): Promise<void> {
  const spec = loadCombosSpec();
  const index = await loadProviderIndex();
  const registryIssues = validateModelsAgainstRegistry(spec, index);

  console.log(`==> Registry check (local app clone)`);
  console.log(formatRegistryIssues(registryIssues));

  const client = await createAuthedClient();
  const remote = await fetchCombos(client);
  const diffs = diffCombos(spec, remote);
  const strategies = await fetchComboStrategies(client);

  console.log(`\n==> Check combos @ ${client.baseUrl}`);
  console.log(formatDiffs(diffs));

  let strategyDrift = 0;
  for (const combo of spec.combos) {
    const want = desiredStrategy(combo, spec.defaults);
    const got = strategies[combo.name]?.fallbackStrategy ?? "fallback";
    if (want !== got) {
      strategyDrift += 1;
      console.log(`  ~ strategy ${combo.name}: ${got} → ${want}`);
    }
  }

  const connections = await fetchProviderConnections(client);
  const needed = providersReferencedBySpec(spec, index);
  const active = activeProviderIds(connections, index);
  const missingCreds = missingCredentialProviders(needed, active);

  console.log(`\n==> Provider credentials`);
  if (missingCreds.length === 0) {
    console.log(
      `All ${needed.size} provider(s) referenced by combos have an active connection.`,
    );
  } else {
    console.log(
      `Missing active credentials for: ${missingCreds.join(", ")}`,
    );
    console.log(
      `Open ${LOCAL_BASE_URL} → Providers and connect them (OAuth or API key).`,
    );
    console.log(
      `Cursor 404 / providerStatusCode 404 usually means no credentials for every tier in the combo.`,
    );
  }

  const blocking = diffs.filter(
    (d) => d.kind === "missing" || d.kind === "drifted",
  );
  const failed =
    blocking.length > 0 ||
    strategyDrift > 0 ||
    registryIssues.length > 0 ||
    missingCreds.length > 0;

  if (failed) {
    const extras = diffs.filter((d) => d.kind === "extra");
    if (extras.length > 0) {
      console.log(
        `\nNote: ${extras.length} extra remote combo(s) (ignored; use sync-combos --prune to remove)`,
      );
    }
    process.exit(1);
  }

  const extras = diffs.filter((d) => d.kind === "extra");
  if (extras.length > 0) {
    console.log(
      `\nOK (spec satisfied). ${extras.length} extra remote combo(s) not in combos.yaml.`,
    );
  } else {
    console.log(
      `\nOK — ${spec.combos.length} combos match the spec, registry, and credentials`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
