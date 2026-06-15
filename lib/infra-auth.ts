const BCRYPT_COST = 11;

async function bcryptHash(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "bcrypt", cost: BCRYPT_COST });
}

export async function buildDozzleUsersYml(
  username: string,
  password: string,
  email = "",
): Promise<string> {
  const hash = await bcryptHash(password);
  const lines = ["users:", `  ${username}:`];
  if (email) lines.push(`    email: ${email}`);
  lines.push(`    password: ${hash}`);
  lines.push("    filter:");
  lines.push("    roles:");
  return lines.join("\n");
}

/** Traefik basicAuth accepts bcrypt hashes (same format as htpasswd -nbB). */
export async function buildNetdataBasicAuthUser(
  username: string,
  password: string,
): Promise<string> {
  const hash = await bcryptHash(password);
  return `${username}:${hash}`;
}
