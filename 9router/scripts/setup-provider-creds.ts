/**
 * Interactive walkthrough for API-key / cookie providers only:
 * open get-key URL → paste secret → patch Vault → create 9Router connection.
 * OAuth/import providers: use the dashboard or `npm run sync-providers -- --interactive`.
 */
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import { createAuthedClient, type NineRouterClient } from "./lib/client.ts";
import { loadCombosSpec } from "./lib/combos.ts";
import {
  activeConnectionsByProvider,
  buildCredWalkQueue,
  createApiKeyConnection,
  loadCredentialMap,
  loadProvidersSpec,
  loadRegistryMeta,
  primaryVaultKey,
  resolveProviderCatalog,
  syncOneProvider,
  type ResolvedProvider,
} from "./lib/providers.ts";
import {
  fetchProviderConnections,
  loadProviderIndex,
  providersReferencedBySpec,
} from "./lib/registry.ts";
import { defaultVaultKvConfig, patchVaultKv, vaultKvCliPath } from "./lib/vault.ts";

type Opts = {
  comboOnly: boolean;
  dryRun: boolean;
  noOpen: boolean;
  noConnect: boolean;
  force: boolean;
};

function parseArgs(argv: string[]): Opts {
  let comboOnly = false;
  let dryRun = false;
  let noOpen = false;
  let noConnect = false;
  let force = false;
  for (const arg of argv) {
    if (arg === "--combo-only") comboOnly = true;
    else if (arg === "--all") comboOnly = false;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--no-open") noOpen = true;
    else if (arg === "--no-connect") noConnect = true;
    else if (arg === "--force") force = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: npm run setup-provider-creds [-- --combo-only] [-- --all]
                   [-- --dry-run] [-- --no-open] [-- --no-connect] [-- --force]

Walk API-key providers one-by-one: open get-key URL → paste secret → Vault → connect.
(OAuth providers are not included — use the dashboard or sync-providers --interactive.)

  --combo-only   Only API-key providers referenced by combos.yaml
  --all          After combo providers, continue with remaining API-key catalog (default)
  --dry-run      Show steps; do not write Vault or create connections
  --no-open      Print URLs only (do not open browser)
  --no-connect   Write Vault only; skip 9Router connection create
  --force        Re-prompt even when Vault already has the key

Per step: paste value, empty or "s" to skip, "q" to quit (keeps progress).
`);
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${arg}`);
      process.exit(1);
    }
  }
  return { comboOnly, dryRun, noOpen, noConnect, force };
}

function openBrowser(url: string): void {
  try {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* ignore */
  }
}

async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await new Promise((resolve) => {
      rl.question(question, (answer) => resolve(answer ?? ""));
    });
  } finally {
    rl.close();
  }
}

/** Hidden secret prompt (TTY raw mode when available). */
async function promptSecret(question: string): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    console.warn("(TTY echo may show the secret — prefer a real terminal)");
    return (await promptLine(question)).trim();
  }

  output.write(question);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");

  return await new Promise((resolve) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r") {
          input.setRawMode(false);
          input.pause();
          input.removeListener("data", onData);
          output.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          input.setRawMode(false);
          input.pause();
          input.removeListener("data", onData);
          output.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }
        if (ch < " ") continue;
        value += ch;
        output.write("*");
      }
    };
    input.on("data", onData);
  });
}

function statusLine(vaultHas: boolean, connected: boolean): string {
  return [
    vaultHas ? "in Vault" : "missing in Vault",
    connected ? "connected in 9Router" : "no 9Router connection",
  ].join("; ");
}

async function connectAfterWrite(
  client: NineRouterClient,
  provider: ResolvedProvider,
  creds: Record<string, string>,
  connectionName: string,
): Promise<string> {
  const existing = activeConnectionsByProvider(
    await fetchProviderConnections(client),
  );
  const result = await syncOneProvider(client, provider, creds, existing, {
    dryRun: false,
    force: true,
    interactive: false,
    connectionName,
  });
  return `${result.kind}${result.detail ? ` (${result.detail})` : ""}`;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const spec = loadProvidersSpec();
  const catalog = await resolveProviderCatalog(spec);
  const meta = await loadRegistryMeta();
  const index = await loadProviderIndex();
  const comboIds = providersReferencedBySpec(loadCombosSpec(), index);
  const queue = buildCredWalkQueue(catalog, comboIds, {
    comboOnly: opts.comboOnly,
  });

  const { creds, vaultPath, vaultOk, vaultError } = await loadCredentialMap();
  console.log(`==> Setup API-key provider credentials`);
  console.log(
    vaultOk
      ? `    Vault: ${vaultPath} (ok)`
      : `    Vault: ${vaultPath} (unavailable${vaultError ? `: ${vaultError.slice(0, 60)}` : ""})`,
  );
  console.log(
    `    Queue: ${queue.length} API-key provider(s)${opts.comboOnly ? " (combo-only)" : " (combo-first, then catalog)"}`,
  );
  if (opts.dryRun) console.log("    Mode: dry-run");

  if (!vaultOk && !opts.dryRun) {
    console.error(
      `\nCannot write secrets without Vault access. Fix auth, then retry.`,
    );
    console.error(`  vault login -method=userpass username=crvouga`);
    process.exit(1);
  }

  const client = await createAuthedClient();
  let connections = await fetchProviderConnections(client);
  let connected = activeConnectionsByProvider(connections);

  let wrote = 0;
  let connectedN = 0;
  let skipped = 0;
  let quit = false;

  for (let i = 0; i < queue.length; i++) {
    const provider = queue[i]!;
    const info = meta.get(provider.id);
    const name = info?.name ?? provider.id;
    const helpUrl = info?.helpUrl ?? null;
    const vaultKey = primaryVaultKey(provider);
    const vaultHas = vaultKey ? Boolean(creds[vaultKey]?.trim()) : false;
    const isConnected = (connected.get(provider.id)?.length ?? 0) > 0;

    console.log(`\n[${i + 1}/${queue.length}] ${name}  (${provider.id})`);
    if (vaultKey) console.log(`  Vault key:  ${vaultKey}`);
    if (helpUrl) console.log(`  Get key:    ${helpUrl}`);
    else console.log(`  Get key:    (no URL in registry — check provider docs)`);
    console.log(`  Status:     ${statusLine(vaultHas, isConnected)}`);

    if (vaultHas && !opts.force) {
      const ans = (
        await promptLine(
          `  Already in Vault. Overwrite? [y/N/s/q] (s=skip): `,
        )
      )
        .trim()
        .toLowerCase();
      if (ans === "q") {
        quit = true;
        break;
      }
      if (ans !== "y" && ans !== "yes") {
        skipped += 1;
        if (!opts.noConnect && !isConnected && vaultKey && creds[vaultKey]) {
          if (!opts.dryRun) {
            try {
              const detail = await connectAfterWrite(
                client,
                provider,
                creds,
                spec.defaults.connectionName,
              );
              console.log(`  ✓ Connect: ${detail}`);
              connectedN += 1;
            } catch (err) {
              console.log(
                `  ! Connect failed: ${err instanceof Error ? err.message : err}`,
              );
            }
          }
        }
        continue;
      }
    }

    if (helpUrl && !opts.noOpen && !opts.dryRun) {
      console.log("  Opening browser…");
      openBrowser(helpUrl);
    }

    const promptKey = vaultKey ?? "API_KEY";
    const raw = await promptSecret(
      `  Paste ${promptKey} (empty/s skip, q quit): `,
    );
    const trimmed = raw.trim();

    if (trimmed.toLowerCase() === "q") {
      quit = true;
      break;
    }
    if (!trimmed || trimmed.toLowerCase() === "s") {
      skipped += 1;
      continue;
    }

    if (!vaultKey) {
      console.log("  ! No Vault key mapping for this provider; skipping write");
      skipped += 1;
      continue;
    }

    const fields: Record<string, string> = { [vaultKey]: trimmed };

    if (opts.dryRun) {
      console.log(
        `  (dry-run) would patch ${vaultKey} → ${vaultKvCliPath(defaultVaultKvConfig())}`,
      );
      wrote += 1;
      continue;
    }

    try {
      await patchVaultKv(fields);
      creds[vaultKey] = trimmed;
      console.log(
        `  ✓ Wrote ${vaultKey} to ${vaultKvCliPath(defaultVaultKvConfig())}`,
      );
      wrote += 1;
    } catch (err) {
      console.error(
        `  ! Vault write failed: ${err instanceof Error ? err.message : err}`,
      );
      continue;
    }

    if (!opts.noConnect) {
      try {
        if (!isConnected) {
          await createApiKeyConnection(
            client,
            provider.id,
            spec.defaults.connectionName,
            trimmed,
          );
          console.log(`  ✓ Created 9Router connection`);
          connectedN += 1;
        } else {
          const detail = await connectAfterWrite(
            client,
            provider,
            creds,
            spec.defaults.connectionName,
          );
          console.log(`  ✓ Connect: ${detail}`);
          if (detail.startsWith("created") || detail.startsWith("updated")) {
            connectedN += 1;
          }
        }
        connections = await fetchProviderConnections(client);
        connected = activeConnectionsByProvider(connections);
      } catch (err) {
        console.log(
          `  ! Connect failed (Vault key saved): ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  console.log(`\n==> Summary`);
  console.log(
    `    wrote=${wrote}  connected=${connectedN}  skipped=${skipped}${quit ? "  (quit early)" : ""}`,
  );
  console.log(
    `\nNext: npm run sync-providers && npm run check-combos`,
  );
  console.log(
    `OAuth (Claude, Kiro, …): dashboard or npm run sync-providers -- --interactive`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
