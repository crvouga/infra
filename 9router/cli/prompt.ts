import { confirm, input, password, select, Separator } from "@inquirer/prompts";

export { Separator };

/** Confirm with a name and short description folded into the prompt. */
export async function askConfirm(
  name: string,
  description: string,
  defaultValue = false,
): Promise<boolean> {
  return confirm({
    message: `${name}\n  ${description}`,
    default: defaultValue,
  });
}

export async function askSelect<T extends string>(opts: {
  message: string;
  description?: string;
  choices: Array<{ name: string; value: T; description?: string } | Separator>;
  default?: T;
}): Promise<T> {
  return select({
    message: opts.description
      ? `${opts.message}\n  ${opts.description}`
      : opts.message,
    choices: opts.choices,
    default: opts.default,
  });
}

export async function askInput(opts: {
  message: string;
  description?: string;
  default?: string;
  validate?: (value: string) => boolean | string | Promise<boolean | string>;
}): Promise<string> {
  return input({
    message: opts.description
      ? `${opts.message}\n  ${opts.description}`
      : opts.message,
    default: opts.default,
    validate: opts.validate,
  });
}

export async function askPassword(opts: {
  message: string;
  description?: string;
}): Promise<string> {
  return password({
    message: opts.description
      ? `${opts.message}\n  ${opts.description}`
      : opts.message,
    mask: "*",
  });
}
