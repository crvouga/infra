import { existsSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR } from "./lib/paths.ts";
import { requireCmd, runInherit } from "./lib/spawn.ts";

function main(): void {
  requireCmd("npm");
  if (!existsSync(join(APP_DIR, "package.json"))) {
    console.error("ERROR: app not cloned. Run: npm run sync-app");
    process.exit(1);
  }
  console.log(`==> npm install in ${APP_DIR}`);
  runInherit("npm", ["install"], { cwd: APP_DIR });
  console.log("Done.");
}

main();
