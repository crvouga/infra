import { existsSync, readFileSync } from "node:fs";
import { applyEnvFile, loadEnvFile } from "./lib/env.ts";
import { livePidFromFile, pidsOnPort } from "./lib/lifecycle.ts";
import {
  APP_LOG_FILE,
  APP_PID_FILE,
  CLOUDFLARED_CONFIG,
  CURSOR_PUBLIC_BASE_URL,
  ENV_FILE,
  LOCAL_BASE_URL,
  TUNNEL_LOG_FILE,
  TUNNEL_PID_FILE,
} from "./lib/paths.ts";

/** Local origin the named tunnel ingress points at (from .cloudflared/config.yml). */
function tunnelLocalService(): string | null {
  if (!existsSync(CLOUDFLARED_CONFIG)) return null;
  const text = readFileSync(CLOUDFLARED_CONFIG, "utf8");
  // First ingress rule: `service: http://127.0.0.1:20128`
  const match = text.match(/^\s*service:\s*(https?:\/\/\S+)/m);
  return match?.[1]?.replace(/\/$/, "") ?? null;
}

function resolveLocalBase(fileEnv: Record<string, string>): string {
  return (
    tunnelLocalService() ||
    fileEnv.BASE_URL?.trim() ||
    fileEnv.NEXT_PUBLIC_BASE_URL?.trim() ||
    process.env.BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_BASE_URL?.trim() ||
    LOCAL_BASE_URL
  ).replace(/\/$/, "");
}

function main(): void {
  const fileEnv = loadEnvFile(ENV_FILE);
  applyEnvFile(ENV_FILE);
  const port = fileEnv.PORT?.trim() || process.env.PORT?.trim() || "20128";
  const local = resolveLocalBase(fileEnv);

  const appPid = livePidFromFile(APP_PID_FILE);
  const tunnelPid = livePidFromFile(TUNNEL_PID_FILE);
  const listeners = pidsOnPort(port);

  console.log(
    `9router: ${appPid ? `running (pid ${appPid})` : "not running"}`,
  );
  console.log(
    `tunnel:  ${tunnelPid ? `running (pid ${tunnelPid})` : "not running"}`,
  );
  console.log(
    `port :${port}: ${
      listeners.length
        ? `LISTEN (pid ${listeners.join(", ")})`
        : "free"
    }`,
  );
  console.log(`local:   ${local}`);
  console.log(`public:  ${CURSOR_PUBLIC_BASE_URL}`);
  console.log(`logs:    ${APP_LOG_FILE}`);
  console.log(`         ${TUNNEL_LOG_FILE}`);
}

main();
