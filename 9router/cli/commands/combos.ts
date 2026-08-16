import { createAuthedClient } from "../../scripts/lib/client.ts";
import {
  buildStrategyPatch,
  createCombo,
  deleteCombo,
  diffCombos,
  fetchComboStrategies,
  fetchCombos,
  formatDiffs,
  loadCombosSpec,
  patchComboStrategies,
  updateCombo,
  desiredStrategy,
  type ComboDiff,
} from "../../scripts/lib/combos.ts";
import {
  activeProviderIds,
  fetchProviderConnections,
  formatRegistryIssues,
  loadProviderIndex,
  missingCredentialProviders,
  providersReferencedBySpec,
  validateModelsAgainstRegistry,
} from "../../scripts/lib/registry.ts";
import { LOCAL_BASE_URL } from "../../scripts/lib/paths.ts";
import { askConfirm } from "../prompt.ts";
import { CommandError, type Command } from "../types.ts";

async function applyDiffs(
  client: Awaited<ReturnType<typeof createAuthedClient>>,
  diffs: ComboDiff[],
  prune: boolean,
): Promise<void> {
  for (const d of diffs) {
    if (d.kind === "missing") {
      await createCombo(client, d.desired);
      console.log(`  created  ${d.name}`);
    } else if (d.kind === "drifted") {
      await updateCombo(client, d.remote.id, d.desired);
      console.log(`  updated  ${d.name}`);
    } else if (d.kind === "extra") {
      if (!prune) continue;
      await deleteCombo(client, d.remote.id);
      console.log(`  pruned   ${d.name}`);
    }
  }
}

export async function syncCombos(): Promise<void> {
  const dryRun = await askConfirm(
    "Dry run only?",
    "Show the combo diff without writing changes to 9Router.",
    false,
  );
  const prune = await askConfirm(
    "Prune remote combos?",
    "Delete remote LLM combos that are not listed in combos.yaml.",
    false,
  );

  const spec = loadCombosSpec();
  const client = await createAuthedClient();

  const remote = await fetchCombos(client);
  const diffs = diffCombos(spec, remote);
  const actionable = diffs.filter((d) => d.kind !== "extra" || prune);

  console.log(`==> Combos vs ${client.baseUrl}`);
  console.log(formatDiffs(diffs));

  if (dryRun) {
    if (actionable.length > 0) {
      console.log(
        `\nDry run — ${actionable.length} actionable change(s); nothing written.`,
      );
    } else {
      console.log("\nDry run — no actionable changes.");
    }
    return;
  }

  if (actionable.length > 0) {
    console.log("\n==> Applying combo upserts");
    await applyDiffs(client, diffs, prune);
  }

  const existing = await fetchComboStrategies(client);
  const next = buildStrategyPatch(spec, existing, prune);
  const before = JSON.stringify(existing);
  const after = JSON.stringify(next);
  if (before !== after) {
    console.log("==> Patching comboStrategies");
    await patchComboStrategies(client, next);
  } else {
    console.log("==> comboStrategies already match");
  }

  const verify = diffCombos(spec, await fetchCombos(client)).filter(
    (d) => d.kind !== "extra" || prune,
  );
  if (verify.length > 0) {
    throw new CommandError(
      `Combos still drifted after sync:\n${formatDiffs(verify)}`,
    );
  }

  console.log(`OK — ${spec.combos.length} combos in sync`);
}

export async function checkCombos(): Promise<void> {
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

  const extras = diffs.filter((d) => d.kind === "extra");
  if (failed) {
    if (extras.length > 0) {
      console.log(
        `\nNote: ${extras.length} extra remote combo(s) (ignored; use Sync combos with prune to remove)`,
      );
    }
    throw new CommandError(
      "Combo check failed — see registry, drift, or credential issues above.",
    );
  }

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

export const combosCommands: Command[] = [
  {
    id: "sync-combos",
    name: "Sync combos",
    description: "Upsert combos and strategies from combos.yaml",
    group: "combos",
    run: syncCombos,
  },
  {
    id: "check-combos",
    name: "Check combos",
    description: "Validate registry models, combo drift, and credentials",
    group: "combos",
    run: checkCombos,
  },
];
