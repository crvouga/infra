import { search, Separator } from "@inquirer/prompts";
import { loadHistory } from "./history.ts";
import {
  GROUP_LABELS,
  type Command,
  type CommandGroup,
} from "./types.ts";

const GROUP_ORDER: CommandGroup[] = [
  "setup",
  "lifecycle",
  "app",
  "secrets",
  "tunnel",
  "providers",
  "combos",
  "cursor",
  "meta",
];

function matches(cmd: Command, term: string): boolean {
  const q = term.trim().toLowerCase();
  if (!q) return true;
  const hay = `${cmd.name} ${cmd.description} ${cmd.id} ${GROUP_LABELS[cmd.group]}`.toLowerCase();
  return q.split(/\s+/).every((token) => hay.includes(token));
}

export async function searchableMenu(
  commands: Command[],
): Promise<Command | null> {
  const byId = new Map(commands.map((c) => [c.id, c]));

  const choice = await search({
    message: "9router — choose a command (type to filter)",
    pageSize: 16,
    source: async (input) => {
      const term = input ?? "";
      const filtering = term.trim().length > 0;
      const items: Array<
        | { name: string; value: string; description: string }
        | Separator
      > = [];

      if (!filtering) {
        const recent = loadHistory()
          .map((id) => byId.get(id))
          .filter((c): c is Command => c !== undefined && c.id !== "exit");
        if (recent.length > 0) {
          items.push(new Separator("── Recent ──"));
          for (const cmd of recent) {
            items.push({
              name: cmd.name,
              value: `recent:${cmd.id}`,
              description: cmd.description,
            });
          }
        }
      }

      const visible = commands.filter((c) => matches(c, term));
      if (filtering) {
        for (const cmd of visible) {
          items.push({
            name: cmd.name,
            value: cmd.id,
            description: `${GROUP_LABELS[cmd.group]} · ${cmd.description}`,
          });
        }
        return items;
      }

      for (const group of GROUP_ORDER) {
        const groupCmds = visible.filter((c) => c.group === group);
        if (groupCmds.length === 0) continue;
        items.push(new Separator(`── ${GROUP_LABELS[group]} ──`));
        for (const cmd of groupCmds) {
          items.push({
            name: cmd.name,
            value: cmd.id,
            description: cmd.description,
          });
        }
      }

      return items;
    },
  });

  if (!choice) return null;
  const id = choice.startsWith("recent:") ? choice.slice("recent:".length) : choice;
  return byId.get(id) ?? null;
}
