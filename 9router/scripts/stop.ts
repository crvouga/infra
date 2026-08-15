import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { APP_PID_FILE, PID_DIR } from "./lib/paths.ts";

function stopOne(name: string, file: string): boolean {
  if (!existsSync(file)) return false;
  const pid = Number(readFileSync(file, "utf8").trim());
  try {
    if (pid > 0) {
      process.kill(pid, "SIGTERM");
      console.log(`stopped ${name} (pid ${pid})`);
    }
  } catch {
    console.log(`stale pid file ${file}`);
  }
  try {
    unlinkSync(file);
  } catch {
    // ignore
  }
  return true;
}

function main(): void {
  const stopped = stopOne("9router", APP_PID_FILE);

  if (!stopped) {
    console.log(`nothing to stop (no pid files under ${PID_DIR})`);
    console.log("If npm run up is in the foreground, use Ctrl-C instead.");
  }
}

main();
