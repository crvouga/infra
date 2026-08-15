import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  APP_DIR,
  APP_PID_FILE,
  ENV_FILE,
  LOCAL_BASE_URL,
  PID_DIR,
  ROOT,
  SECRET_KEYS,
  resolveDataDir,
} from "./lib/paths.ts";
import { applyEnvFile } from "./lib/env.ts";
import { requireCmd, spawnDetached } from "./lib/spawn.ts";

function writePid(file: string, pid: number): void {
  writeFileSync(file, `${pid}\n`, { mode: 0o600 });
}

function readPid(file: string): string {
  return readFileSync(file, "utf8").trim();
}

function killPidFile(file: string): void {
  if (!existsSync(file)) return;
  try {
    const pid = Number(readPid(file));
    if (pid > 0) process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
  try {
    unlinkSync(file);
  } catch {
    // ignore
  }
}

function main(): void {
  requireCmd("node");
  requireCmd("npm");

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
  if (!existsSync(join(APP_DIR, ".next"))) {
    console.error("ERROR: app not built. Run: npm run build");
    process.exit(1);
  }

  mkdirSync(join(ROOT, "data"), { recursive: true });
  mkdirSync(PID_DIR, { recursive: true });

  applyEnvFile(ENV_FILE);

  const port = process.env.PORT?.trim() || "20128";
  const hostname = process.env.HOSTNAME?.trim() || "0.0.0.0";
  const nodeEnv = process.env.NODE_ENV?.trim() || "production";
  const dataDir = resolveDataDir(process.env.DATA_DIR);
  const baseUrl = process.env.BASE_URL?.trim() || LOCAL_BASE_URL;
  const nextPublic = process.env.NEXT_PUBLIC_BASE_URL?.trim() || baseUrl;
  const cookieSecure = process.env.AUTH_COOKIE_SECURE?.trim() || "false";

  for (const key of SECRET_KEYS) {
    if (!process.env[key]?.trim()) {
      console.error(`ERROR: ${key} is empty in .env. Run: npm run pull-secrets`);
      process.exit(1);
    }
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

  const children: ChildProcess[] = [];
  let shuttingDown = false;

  const cleanup = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
      if (child.pid && !child.killed) {
        try {
          process.kill(child.pid, "SIGTERM");
        } catch {
          // ignore
        }
      }
    }
    killPidFile(APP_PID_FILE);
    process.exit(code);
  };

  process.on("SIGINT", () => cleanup(0));
  process.on("SIGTERM", () => cleanup(0));

  console.log(`==> Starting 9router on ${hostname}:${port} (DATA_DIR=${dataDir})`);
  const app = spawnDetached("npm", ["run", "start"], { cwd: APP_DIR, env });
  if (!app.pid) {
    console.error("ERROR: failed to start 9router");
    process.exit(1);
  }
  children.push(app);
  writePid(APP_PID_FILE, app.pid);
  app.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`9router exited (code ${code ?? "?"})`);
      cleanup(code ?? 1);
    }
  });

  console.log(`Ready. ${baseUrl} (Ctrl-C to stop)`);
}

main();
