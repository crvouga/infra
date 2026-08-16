import { applyEnvFile, loadEnvFile } from "./lib/env.ts";
import { livePidFromFile, pidsOnPort } from "./lib/lifecycle.ts";
import {
  APP_LOG_FILE,
  APP_PID_FILE,
  CURSOR_PUBLIC_BASE_URL,
  ENV_FILE,
  TUNNEL_LOG_FILE,
  TUNNEL_PID_FILE,
} from "./lib/paths.ts";

function main(): void {
  const fileEnv = loadEnvFile(ENV_FILE);
  applyEnvFile(ENV_FILE);
  const port = fileEnv.PORT?.trim() || process.env.PORT?.trim() || "20128";

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
  console.log(`public:  ${CURSOR_PUBLIC_BASE_URL}`);
  console.log(`logs:    ${APP_LOG_FILE}`);
  console.log(`         ${TUNNEL_LOG_FILE}`);
}

main();
