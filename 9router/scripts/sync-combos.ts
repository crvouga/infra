import { createAuthedClient } from "./lib/client.ts";
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
  type ComboDiff,
} from "./lib/combos.ts";

function parseArgs(argv: string[]): { prune: boolean; dryRun: boolean } {
  let prune = false;
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--prune") prune = true;
    else if (arg === "--dry-run" || arg === "--check") dryRun = true;
    else if (arg === "--apply") dryRun = false;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: npm run sync-combos [-- --prune] [-- --dry-run]

Upsert combos from combos.yaml into the local 9Router instance.

  --apply     Apply changes (default)
  --dry-run   Show diff only; do not write
  --prune     Delete remote LLM combos not listed in combos.yaml
`);
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${arg}`);
      process.exit(1);
    }
  }
  return { prune, dryRun };
}

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

async function main(): Promise<void> {
  const { prune, dryRun } = parseArgs(process.argv.slice(2));
  const spec = loadCombosSpec();
  const client = await createAuthedClient();

  const remote = await fetchCombos(client);
  const diffs = diffCombos(spec, remote);
  const actionable = diffs.filter(
    (d) => d.kind !== "extra" || prune,
  );

  console.log(`==> Combos vs ${client.baseUrl}`);
  console.log(formatDiffs(diffs));

  if (dryRun) {
    if (actionable.length > 0) process.exit(1);
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
    console.error("ERROR: combos still drifted after sync:");
    console.error(formatDiffs(verify));
    process.exit(1);
  }

  console.log(`OK — ${spec.combos.length} combos in sync`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
