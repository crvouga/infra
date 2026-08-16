import { askConfirm } from "../prompt.ts";
import { buildApp, installApp, syncApp } from "./app.ts";
import { pullSecrets } from "./secrets.ts";
import type { Command } from "../types.ts";

export async function fullSetup(): Promise<void> {
  const ok = await askConfirm(
    "Run full setup?",
    "Pull secrets → sync app → install deps → build. Requires Vault access and git/npm.",
    true,
  );
  if (!ok) {
    console.log("Cancelled.");
    return;
  }

  console.log("\n── Pull secrets ──");
  await pullSecrets();
  console.log("\n── Sync app ──");
  await syncApp();
  console.log("\n── Install app deps ──");
  await installApp();
  console.log("\n── Build app ──");
  await buildApp();
  console.log("\nOK — full setup complete.");
  console.log("Next: Provision tunnel, then Start daemons.");
}

export const setupCommands: Command[] = [
  {
    id: "setup",
    name: "Full setup",
    description: "Pull secrets, sync app, install deps, and build",
    group: "setup",
    run: fullSetup,
  },
];
