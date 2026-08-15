import { existsSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR } from "./lib/paths.ts";
import { requireCmd, runInherit } from "./lib/spawn.ts";
import { patchOAuthRedirect } from "./oauth-redirect-patch.ts";

function main(): void {
  requireCmd("npm");
  requireCmd("node");
  if (!existsSync(join(APP_DIR, "package.json"))) {
    console.error("ERROR: app not cloned. Run: npm run sync-app");
    process.exit(1);
  }
  console.log(`==> npm run build in ${APP_DIR}`);
  runInherit("npm", ["run", "build"], { cwd: APP_DIR });
  const nextDir = join(APP_DIR, ".next");
  console.log(`==> Applying OAuth redirect patch to ${nextDir}`);
  patchOAuthRedirect(nextDir);
  console.log("Done.");
}

main();
