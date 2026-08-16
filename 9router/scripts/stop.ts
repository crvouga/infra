import { applyEnvFile, loadEnvFile } from "./lib/env.ts";
import { stopDaemon, stopPortOccupants } from "./lib/lifecycle.ts";
import {
  APP_PID_FILE,
  ENV_FILE,
  PID_DIR,
  TUNNEL_PID_FILE,
} from "./lib/paths.ts";

function main(): void {
  const fileEnv = loadEnvFile(ENV_FILE);
  applyEnvFile(ENV_FILE);
  const port = fileEnv.PORT?.trim() || process.env.PORT?.trim() || "20128";

  let stopped = false;
  if (stopDaemon(TUNNEL_PID_FILE, "tunnel")) stopped = true;
  if (stopDaemon(APP_PID_FILE, "9router")) stopped = true;
  if (stopPortOccupants(port)) stopped = true;

  if (!stopped) {
    console.log(
      `nothing to stop (no daemons under ${PID_DIR}, port :${port} free)`,
    );
  } else {
    console.log("down complete");
  }
}

main();
