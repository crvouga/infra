import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAuthedClient } from "./lib/client.ts";
import { loadCombosSpec } from "./lib/combos.ts";
import {
  assertCursorQuitOrForce,
  backupCursorSyncState,
  cursorStateDbSize,
  decryptOsCryptV10,
  defaultCursorStateDb,
  encryptOsCryptV10,
  formatDbSize,
  getCursorSafeStoragePassword,
  isCursorHoldingDb,
  isPrivateOpenAIBaseUrl,
  openAIBaseUrlFromRouter,
  patchApplicationUserForCombos,
  readApplicationUser,
  writeApplicationUser,
  writeOpenAIKeySecret,
} from "./lib/cursor.ts";
import { CURSOR_PUBLIC_BASE_URL, ROOT } from "./lib/paths.ts";

type ApiKeyRow = {
  id: string;
  key: string;
  name: string;
  isActive?: boolean;
};

const SYNCED_COMBOS_FILE = join(ROOT, ".cursor-synced-combos.json");

function logStep(msg: string): void {
  console.log(`[sync-cursor] ${msg}`);
}

function parseArgs(argv: string[]): {
  dryRun: boolean;
  force: boolean;
  pruneCombos: boolean;
  allowPrivate: boolean;
  baseUrl?: string;
} {
  let dryRun = false;
  let force = false;
  let pruneCombos = false;
  let allowPrivate = false;
  let baseUrl: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--force") force = true;
    else if (arg === "--prune-combos") pruneCombos = true;
    else if (arg === "--allow-private") allowPrivate = true;
    else if (arg === "--base-url") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        console.error("--base-url requires a URL argument");
        process.exit(1);
      }
      baseUrl = next;
    } else if (arg.startsWith("--base-url=")) {
      baseUrl = arg.slice("--base-url=".length);
      if (!baseUrl) {
        console.error("--base-url requires a URL argument");
        process.exit(1);
      }
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: npm run sync-cursor [-- --dry-run] [-- --force] [-- --prune-combos]
                   [-- --base-url <https://…>] [-- --allow-private]

Write 9Router OpenAI base URL, API key, and combos.yaml model names into Cursor state.vscdb.

Default OpenAI base URL: ${CURSOR_PUBLIC_BASE_URL}

  --dry-run         Show planned changes; do not write
  --force           Write even if Cursor has the DB open (may be overwritten)
  --prune-combos    Remove previously synced combo names no longer in combos.yaml
  --base-url URL    Override public HTTPS OpenAI base (default: ${CURSOR_PUBLIC_BASE_URL})
  --allow-private   Allow writing localhost / private IPs (Cursor Agent will 403 SSRF)

Cursor's cloud backend cannot reach private networks. Run \`npm run provision-tunnel\`
once, then \`npm run up\` (daemonizes app + tunnel) while using Cursor.

Quit Cursor before running (recommended).
`);
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${arg}`);
      process.exit(1);
    }
  }
  return { dryRun, force, pruneCombos, allowPrivate, baseUrl };
}

/**
 * Resolve OpenAI base for Cursor BYOK (first wins):
 * 1. --base-url
 * 2. CURSOR_OPENAI_BASE_URL
 * 3. https://9router.chrisvouga.dev (stable named tunnel)
 */
function resolveCursorOpenAIBaseUrl(cliBaseUrl?: string): {
  raw: string;
  source: string;
} {
  if (cliBaseUrl?.trim()) {
    return { raw: cliBaseUrl.trim(), source: "--base-url" };
  }
  const fromEnv = process.env.CURSOR_OPENAI_BASE_URL?.trim();
  if (fromEnv) {
    return { raw: fromEnv, source: "CURSOR_OPENAI_BASE_URL" };
  }
  return {
    raw: CURSOR_PUBLIC_BASE_URL,
    source: "CURSOR_PUBLIC_BASE_URL",
  };
}

function assertPublicOrAllowed(
  openAIBaseUrl: string,
  allowPrivate: boolean,
  source: string,
): void {
  if (!isPrivateOpenAIBaseUrl(openAIBaseUrl)) return;
  if (allowPrivate) {
    console.warn(
      `[sync-cursor] WARNING: writing private base URL (${openAIBaseUrl}). Cursor Agent/Chat will fail with "Access to private networks is forbidden".`,
    );
    return;
  }
  throw new Error(
    [
      `Refusing to sync private OpenAI base URL: ${openAIBaseUrl}`,
      `(source: ${source})`,
      "",
      "Cursor's cloud backend blocks loopback/RFC1918 addresses (SSRF protection).",
      "Use the stable public hostname:",
      "",
      "  npm run provision-tunnel   # once",
      "  npm run up                 # daemon: app + tunnel → 9router.chrisvouga.dev",
      "  npm run sync-cursor        # writes https://9router.chrisvouga.dev/v1",
      "",
      "Pass --allow-private only if you intentionally want localhost (will not work in Agent).",
    ].join("\n"),
  );
}

function readLastSyncedCombos(): string[] {
  if (!existsSync(SYNCED_COMBOS_FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(SYNCED_COMBOS_FILE, "utf8")) as {
      names?: string[];
    };
    return Array.isArray(raw.names) ? raw.names.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function writeLastSyncedCombos(names: string[]): void {
  writeFileSync(
    SYNCED_COMBOS_FILE,
    `${JSON.stringify({ names, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function ensureCursorApiKey(
  client: Awaited<ReturnType<typeof createAuthedClient>>,
  keyName: string,
): Promise<{ key: string; created: boolean }> {
  logStep("GET /api/keys…");
  const data = await client.json<{ keys: ApiKeyRow[] }>("/api/keys");
  const existing = (data.keys ?? []).find(
    (k) => k.name === keyName && k.isActive !== false && k.key,
  );
  if (existing?.key) {
    return { key: existing.key, created: false };
  }
  logStep(`POST /api/keys (create "${keyName}")…`);
  const created = await client.json<ApiKeyRow>("/api/keys", {
    method: "POST",
    body: JSON.stringify({ name: keyName }),
  });
  if (!created?.key) {
    throw new Error(`Failed to create 9Router API key named "${keyName}"`);
  }
  return { key: created.key, created: true };
}

async function main(): Promise<void> {
  const { dryRun, force, pruneCombos, allowPrivate, baseUrl } = parseArgs(
    process.argv.slice(2),
  );
  const dbPath = defaultCursorStateDb();
  const keyName =
    process.env.NINEROUTER_CURSOR_KEY_NAME?.trim() || "cursor";

  logStep(
    `Starting (dryRun=${dryRun} force=${force} pruneCombos=${pruneCombos} allowPrivate=${allowPrivate})`,
  );

  logStep(`Cursor DB: ${dbPath}`);
  const dbBytes = cursorStateDbSize(dbPath);
  logStep(
    `Cursor DB size: ${formatDbSize(dbBytes)} (row-level backup only, not full copy)`,
  );

  logStep("Checking Cursor DB lock via lsof…");
  if (!dryRun) {
    assertCursorQuitOrForce(force, dbPath);
    logStep("Cursor DB not locked by another process");
  } else if (isCursorHoldingDb(dbPath)) {
    console.warn(
      "[sync-cursor] NOTE: Cursor has state.vscdb open (dry-run only; quit Cursor before a real sync).",
    );
  } else {
    logStep("Cursor DB not locked by another process");
  }

  logStep("Loading combos.yaml…");
  const spec = loadCombosSpec();
  const comboNames = spec.combos.map((c) => c.name);
  const { raw, source } = resolveCursorOpenAIBaseUrl(baseUrl);
  const openAIBaseUrl = openAIBaseUrlFromRouter(raw);
  assertPublicOrAllowed(openAIBaseUrl, allowPrivate, source);
  const lastSynced = readLastSyncedCombos();
  logStep(`Loaded ${comboNames.length} combos`);

  console.log(`==> 9Router OpenAI base: ${openAIBaseUrl} (from ${source})`);
  console.log(`==> Combos: ${comboNames.join(", ")}`);

  let apiKey = "";
  let keyCreated = false;
  if (!dryRun) {
    const client = await createAuthedClient();
    const ensured = await ensureCursorApiKey(client, keyName);
    apiKey = ensured.key;
    keyCreated = ensured.created;
    console.log(
      keyCreated
        ? `==> Created 9Router API key "${keyName}"`
        : `==> Reusing 9Router API key "${keyName}"`,
    );
  } else {
    console.log(`==> (dry-run) would ensure 9Router API key "${keyName}"`);
  }

  logStep("Reading applicationUser from SQLite…");
  const before = readApplicationUser(dbPath);
  logStep("Computing patch…");
  const { user: patched, result } = patchApplicationUserForCombos(before, {
    openAIBaseUrl,
    comboNames,
    pruneCatalogNames: pruneCombos
      ? [...new Set([...lastSynced, ...comboNames])]
      : undefined,
  });

  console.log(
    `  base URL: ${result.beforeBaseUrl ?? "(unset)"} → ${result.afterBaseUrl}`,
  );
  console.log(
    result.addedModels.length
      ? `  + models: ${result.addedModels.join(", ")}`
      : "  models: already present",
  );
  if (result.prunedModels.length) {
    console.log(`  - pruned: ${result.prunedModels.join(", ")}`);
  }

  if (dryRun) {
    console.log("Dry run — no changes written.");
    return;
  }

  logStep("Backing up 2 ItemTable keys…");
  const backup = backupCursorSyncState(dbPath);
  console.log(`==> Backup: ${backup}`);

  logStep("Writing applicationUser…");
  writeApplicationUser(patched, dbPath);

  let keyWritten = false;
  try {
    logStep("Reading Cursor Safe Storage from Keychain…");
    const password = getCursorSafeStoragePassword();
    logStep("Encrypting API key (OSCrypt v10)…");
    const encrypted = encryptOsCryptV10(apiKey, password);
    if (decryptOsCryptV10(encrypted, password) !== apiKey) {
      throw new Error("OSCrypt round-trip mismatch");
    }
    logStep("Writing openAIKey secret…");
    writeOpenAIKeySecret(encrypted, dbPath);
    keyWritten = true;
    console.log(
      "==> Wrote encrypted OpenAI API key (secret://cursorAuth/openAIKey)",
    );
  } catch (err) {
    console.warn(
      `WARNING: Could not write encrypted API key into Cursor storage:\n${err instanceof Error ? err.message : err}`,
    );
    console.warn(
      `\nPaste this key manually in Cursor Settings → Models → OpenAI API Key:\n  ${apiKey}\n`,
    );
  }

  logStep("Writing .cursor-synced-combos.json…");
  writeLastSyncedCombos(comboNames);

  console.log(
    [
      "OK — Cursor config updated.",
      keyWritten
        ? "Reopen Cursor (or Reload Window), then pick a combo model (e.g. 9router-free, 9router-max-sub-claude)."
        : "Reopen Cursor, paste the API key above if prompted, then pick a combo model.",
      `Keep daemons up (\`npm run up\`) so ${CURSOR_PUBLIC_BASE_URL} reaches local 9Router.`,
    ].join("\n"),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
