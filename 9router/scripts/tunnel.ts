import { existsSync } from "node:fs";
import { spawnCloudflared, ensureCloudflared } from "./lib/cloudflared.ts";
import {
  CLOUDFLARED_CONFIG,
  CURSOR_PUBLIC_BASE_URL,
  CURSOR_PUBLIC_HOST,
} from "./lib/paths.ts";

/**
 * Foreground tunnel for debugging. Day-to-day: `npm run up` / `npm run down`
 * daemonize app + tunnel together.
 */
function main(): void {
  console.log(
    "Note: day-to-day use is `npm run up` (daemonizes app + tunnel).",
  );
  console.log("This command runs the tunnel in the foreground for debugging.");
  console.log("");

  ensureCloudflared();

  if (!existsSync(CLOUDFLARED_CONFIG)) {
    console.error(
      [
        `Missing ${CLOUDFLARED_CONFIG}`,
        "Run once:",
        "  npm run provision-tunnel",
        "(requires: brew install cloudflared && cloudflared tunnel login)",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(`[tunnel] Named tunnel → ${CURSOR_PUBLIC_HOST}`);
  console.log(`[tunnel] Config: ${CLOUDFLARED_CONFIG}`);
  console.log(`[tunnel] Cursor OpenAI base: ${CURSOR_PUBLIC_BASE_URL}/v1`);
  console.log("");

  const child = spawnCloudflared(
    ["tunnel", "--config", CLOUDFLARED_CONFIG, "run"],
    { stdio: "inherit" },
  );

  child.on("error", (err) => {
    console.error(`[tunnel] Failed to start cloudflared: ${err.message}`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      console.log(`[tunnel] cloudflared exited on signal ${signal}`);
      process.exit(0);
    }
    process.exit(code ?? 1);
  });

  const shutdown = () => {
    child.kill("SIGTERM");
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
