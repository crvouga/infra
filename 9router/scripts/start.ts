import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ensureCloudflared, resolveCloudflaredBin } from "./lib/cloudflared.ts";
import { applyEnvFile, loadEnvFile } from "./lib/env.ts";
import {
  livePidFromFile,
  pidsOnPort,
  spawnDaemon,
  stopDaemon,
  waitForHealth,
} from "./lib/lifecycle.ts";
import {
  APP_DIR,
  APP_LOG_FILE,
  APP_PID_FILE,
  CLOUDFLARED_CONFIG,
  CURSOR_PUBLIC_BASE_URL,
  CURSOR_PUBLIC_HOST,
  ENV_FILE,
  LOCAL_BASE_URL,
  PID_DIR,
  ROOT,
  SECRET_KEYS,
  TUNNEL_LOG_FILE,
  TUNNEL_PID_FILE,
  dataDirFromEnvFile,
} from "./lib/paths.ts";
import { ensureAppSecrets } from "./lib/secrets.ts";
import { requireCmd } from "./lib/spawn.ts";

function printAlreadyRunning(port: string): void {
  const appPid = livePidFromFile(APP_PID_FILE);
  const tunnelPid = livePidFromFile(TUNNEL_PID_FILE);
  console.log("Already running.");
  console.log(
    `  9router: ${appPid ? `pid ${appPid}` : "not running"} → http://127.0.0.1:${port}`,
  );
  console.log(
    `  tunnel:  ${tunnelPid ? `pid ${tunnelPid}` : "not running"} → ${CURSOR_PUBLIC_BASE_URL}`,
  );
  console.log(`  logs:    ${APP_LOG_FILE}`);
  console.log(`           ${TUNNEL_LOG_FILE}`);
  console.log("  npm run status | npm run down");
}

async function main(): Promise<void> {
  requireCmd("node");

  if (!existsSync(ENV_FILE)) {
    console.log(`==> No ${ENV_FILE} — fetching secrets from Vault…`);
    await ensureAppSecrets({ writeEnv: true });
  }

  if (!existsSync(ENV_FILE)) {
    console.error(`ERROR: missing ${ENV_FILE}. Run: npm run pull-secrets`);
    process.exit(1);
  }
  if (!existsSync(join(APP_DIR, "package.json"))) {
    console.error(
      "ERROR: app not cloned. Run: npm run sync-app && npm run install-app && npm run build",
    );
    process.exit(1);
  }
  if (!existsSync(join(APP_DIR, ".next", "BUILD_ID"))) {
    console.error(
      "ERROR: app not built (missing .next/BUILD_ID). Run: npm run build",
    );
    process.exit(1);
  }
  if (!existsSync(CLOUDFLARED_CONFIG)) {
    console.error(
      [
        `ERROR: missing ${CLOUDFLARED_CONFIG}`,
        "Run once: npm run provision-tunnel",
        "(requires: brew install cloudflared && cloudflared tunnel login)",
      ].join("\n"),
    );
    process.exit(1);
  }

  ensureCloudflared();
  mkdirSync(join(ROOT, "data"), { recursive: true });
  mkdirSync(PID_DIR, { recursive: true });

  const fileEnv = loadEnvFile(ENV_FILE);
  applyEnvFile(ENV_FILE);
  await ensureAppSecrets();

  const port = fileEnv.PORT?.trim() || process.env.PORT?.trim() || "20128";
  const hostname =
    fileEnv.HOSTNAME?.trim() || process.env.HOSTNAME?.trim() || "0.0.0.0";
  const nodeEnv =
    fileEnv.NODE_ENV?.trim() || process.env.NODE_ENV?.trim() || "production";
  const dataDir = dataDirFromEnvFile();
  const baseUrl =
    fileEnv.BASE_URL?.trim() ||
    process.env.BASE_URL?.trim() ||
    LOCAL_BASE_URL;
  const nextPublic =
    fileEnv.NEXT_PUBLIC_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_BASE_URL?.trim() ||
    baseUrl;
  const cookieSecure =
    fileEnv.AUTH_COOKIE_SECURE?.trim() ||
    process.env.AUTH_COOKIE_SECURE?.trim() ||
    "false";

  for (const key of SECRET_KEYS) {
    if (!process.env[key]?.trim()) {
      console.error(`ERROR: ${key} is empty in .env. Run: npm run pull-secrets`);
      process.exit(1);
    }
  }

  const appAlive = livePidFromFile(APP_PID_FILE);
  const tunnelAlive = livePidFromFile(TUNNEL_PID_FILE);
  if (appAlive && tunnelAlive) {
    printAlreadyRunning(port);
    return;
  }

  // Partial state: tear down our daemons before starting clean
  if (appAlive || tunnelAlive) {
    console.log("Partial daemon state — restarting…");
    stopDaemon(TUNNEL_PID_FILE, "tunnel");
    stopDaemon(APP_PID_FILE, "9router");
  }

  const portPids = pidsOnPort(port);
  if (portPids.length > 0) {
    console.error(
      [
        `ERROR: port ${port} is already in use (pid ${portPids.join(", ")})`,
        "Run: npm run down",
      ].join("\n"),
    );
    process.exit(1);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: port,
    HOSTNAME: hostname,
    NODE_ENV: nodeEnv,
    DATA_DIR: dataDir,
    NEXT_PUBLIC_BASE_URL: nextPublic,
    BASE_URL: baseUrl,
    AUTH_COOKIE_SECURE: cookieSecure,
  };

  console.log(`==> Starting 9router daemon on ${hostname}:${port}`);
  console.log(`    DATA_DIR=${dataDir}`);
  const appPid = spawnDaemon({
    cmd: "node",
    args: ["custom-server.js", "--port", port, "--hostname", hostname],
    cwd: APP_DIR,
    env,
    pidFile: APP_PID_FILE,
    logFile: APP_LOG_FILE,
  });
  console.log(`    pid ${appPid}  log ${APP_LOG_FILE}`);

  const healthUrl = `http://127.0.0.1:${port}/api/health`;
  try {
    console.log(`==> Waiting for ${healthUrl}…`);
    await waitForHealth(healthUrl);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    console.error(`See log: ${APP_LOG_FILE}`);
    stopDaemon(APP_PID_FILE, "9router");
    process.exit(1);
  }
  console.log("    health OK");

  const cloudflared = resolveCloudflaredBin();
  console.log(`==> Starting tunnel daemon → ${CURSOR_PUBLIC_HOST}`);
  const tunnelPid = spawnDaemon({
    cmd: cloudflared,
    args: ["tunnel", "--config", CLOUDFLARED_CONFIG, "run"],
    cwd: ROOT,
    env: process.env,
    pidFile: TUNNEL_PID_FILE,
    logFile: TUNNEL_LOG_FILE,
  });
  console.log(`    pid ${tunnelPid}  log ${TUNNEL_LOG_FILE}`);

  // Brief settle — cloudflared should stay alive
  await new Promise((r) => setTimeout(r, 800));
  if (!livePidFromFile(TUNNEL_PID_FILE)) {
    console.error("ERROR: tunnel exited immediately");
    console.error(`See log: ${TUNNEL_LOG_FILE}`);
    stopDaemon(APP_PID_FILE, "9router");
    process.exit(1);
  }

  console.log("");
  console.log("OK — daemons running (CLI exiting).");
  console.log(`  local:  http://127.0.0.1:${port}`);
  console.log(`  public: ${CURSOR_PUBLIC_BASE_URL}`);
  console.log(`  Cursor: ${CURSOR_PUBLIC_BASE_URL}/v1`);
  console.log("  npm run status | npm run down | npm run sync-cursor");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
