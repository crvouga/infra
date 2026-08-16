export type CommandGroup =
  | "setup"
  | "lifecycle"
  | "app"
  | "secrets"
  | "tunnel"
  | "providers"
  | "combos"
  | "cursor"
  | "meta";

export type Command = {
  id: string;
  name: string;
  description: string;
  group: CommandGroup;
  run: () => Promise<void>;
};

export const GROUP_LABELS: Record<CommandGroup, string> = {
  setup: "Setup",
  lifecycle: "Lifecycle",
  app: "App",
  secrets: "Secrets",
  tunnel: "Tunnel",
  providers: "Providers",
  combos: "Combos",
  cursor: "Cursor",
  meta: "Meta",
};

/** Soft failure — printed, then return to the menu (does not crash the CLI). */
export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}
