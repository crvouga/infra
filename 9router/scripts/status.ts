import { existsSync, readFileSync } from "node:fs";
import { APP_PID_FILE } from "./lib/paths.ts";

function statusOne(label: string, file: string): void {
  if (!existsSync(file)) {
    console.log(`${label}: not running`);
    return;
  }
  const pid = Number(readFileSync(file, "utf8").trim());
  try {
    if (pid > 0) process.kill(pid, 0);
    console.log(`${label}: running (pid ${pid})`);
  } catch {
    console.log(`${label}: not running`);
  }
}

function main(): void {
  statusOne("9router", APP_PID_FILE);
}

main();
