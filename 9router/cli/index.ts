import { allCommands } from "./commands/index.ts";
import { pushHistory } from "./history.ts";
import { searchableMenu } from "./menu.ts";
import { CommandError, type Command } from "./types.ts";

function isExitPromptError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "name" in err &&
    (err as { name: string }).name === "ExitPromptError"
  );
}

async function main(): Promise<void> {
  console.log("9router interactive CLI");
  console.log("Type to search · ↑↓ to navigate · Enter to run · Ctrl+C to quit\n");

  for (; ;) {
    let selected: Command | null = null;
    try {
      selected = await searchableMenu(allCommands);
    } catch (err) {
      if (isExitPromptError(err)) {
        console.log("\nBye.");
        process.exit(0);
      }
      throw err;
    }

    if (!selected || selected.id === "exit") {
      console.log("Bye.");
      process.exit(0);
      return;
    }

    const cmd = selected;
    pushHistory(cmd.id);
    console.log(`\n▶ ${cmd.name}`);
    console.log(`  ${cmd.description}\n`);

    try {
      await cmd.run();
    } catch (err) {
      if (isExitPromptError(err)) {
        console.log("\nCancelled.");
      } else if (err instanceof CommandError) {
        console.error(`\nERROR: ${err.message}`);
      } else {
        console.error(
          `\nERROR: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    console.log("");
  }
}

main().catch((err) => {
  if (isExitPromptError(err)) {
    console.log("\nBye.");
    process.exit(0);
  }
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
