import { existsSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR, REPO_BRANCH, REPO_URL } from "./lib/paths.ts";
import { requireCmd, runInherit } from "./lib/spawn.ts";

function main(): void {
  requireCmd("git");

  if (existsSync(join(APP_DIR, ".git"))) {
    console.log(`==> Updating ${APP_DIR} (${REPO_BRANCH})...`);
    runInherit("git", ["-C", APP_DIR, "fetch", "origin"]);
    runInherit("git", ["-C", APP_DIR, "checkout", REPO_BRANCH]);
    runInherit("git", ["-C", APP_DIR, "pull", "--ff-only", "origin", REPO_BRANCH]);
  } else {
    if (existsSync(APP_DIR)) {
      console.error(`ERROR: ${APP_DIR} exists but is not a git repo. Remove it and retry.`);
      process.exit(1);
    }
    console.log(`==> Cloning ${REPO_URL} → ${APP_DIR} (${REPO_BRANCH})...`);
    runInherit("git", [
      "clone",
      "--branch",
      REPO_BRANCH,
      "--single-branch",
      REPO_URL,
      APP_DIR,
    ]);
  }

  console.log(`Done. App at ${APP_DIR}`);
}

main();
