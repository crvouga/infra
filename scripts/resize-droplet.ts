#!/usr/bin/env bun
/**
 * Resize an existing DigitalOcean droplet (power off → resize → power on → deploy).
 *
 * Usage:
 *   bun run scripts/resize-droplet.ts --size s-2vcpu-4gb
 *   bun run scripts/resize-droplet.ts --dry-run
 *
 * Env:
 *   DIGITALOCEAN_TOKEN
 *   GITHUB_TOKEN_SUPER
 *   NODE_SSH_HOST, NODE_SSH_USER, NODE_SSH_KEY
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { $ } from "bun";
import { nodeSshFromEnv } from "../lib/node-ssh.js";
import { dropletName, infraGithubRepo, loadServicesConfig } from "../lib/services.js";

const DO_API = "https://api.digitalocean.com/v2";

type Args = {
  dryRun: boolean;
  size: string;
  triggerDeploy: boolean;
};

function parseArgs(argv: readonly string[]): Args {
  let dryRun = false;
  let size = "s-2vcpu-4gb";
  let triggerDeploy = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--size") size = argv[++i] ?? size;
    else if (arg === "--no-deploy") triggerDeploy = false;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: bun run scripts/resize-droplet.ts [--size s-2vcpu-4gb] [--dry-run] [--no-deploy]");
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return { dryRun, size, triggerDeploy };
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

async function doFetch<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${DO_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`DO API ${method} ${path} failed (${res.status}): ${text}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

type Droplet = {
  id: number;
  name: string;
  status: string;
  size_slug: string;
  networks: { v4: Array<{ ip_address: string; type: string }> };
};

type DoAction = {
  id: number;
  status: string;
  type: string;
};

async function findDropletByName(token: string, name: string): Promise<Droplet | null> {
  const data = await doFetch<{ droplets: Droplet[] }>(
    token,
    "GET",
    `/droplets?name=${encodeURIComponent(name)}`,
  );
  return data.droplets.find((d) => d.name === name) ?? null;
}

async function waitForAction(token: string, dropletId: number, actionId: number): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const data = await doFetch<{ action: DoAction }>(
      token,
      "GET",
      `/droplets/${dropletId}/actions/${actionId}`,
    );
    if (data.action.status === "completed") return;
    if (data.action.status === "errored") {
      throw new Error(`DO action ${actionId} errored`);
    }
    await Bun.sleep(5_000);
  }
  throw new Error(`DO action ${actionId} timed out`);
}

async function dropletAction(
  token: string,
  dropletId: number,
  body: Record<string, unknown>,
): Promise<number> {
  const data = await doFetch<{ action: DoAction }>(
    token,
    "POST",
    `/droplets/${dropletId}/actions`,
    body,
  );
  return data.action.id;
}

async function waitForDropletStatus(
  token: string,
  dropletId: number,
  status: string,
): Promise<Droplet> {
  for (let i = 0; i < 60; i++) {
    const data = await doFetch<{ droplet: Droplet }>(token, "GET", `/droplets/${dropletId}`);
    if (data.droplet.status === status) return data.droplet;
    await Bun.sleep(5_000);
  }
  throw new Error(`Droplet ${dropletId} did not reach status ${status} in time`);
}

async function waitForSsh(keyPath: string, ip: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      await $`ssh -i ${keyPath} -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes root@${ip} echo ok`.quiet();
      return;
    } catch {
      await Bun.sleep(10_000);
    }
  }
  throw new Error(`SSH not available at ${ip} after resize`);
}

async function sshStopStack(creds: { host: string; user: string; privateKey: string }): Promise<void> {
  const workDir = join(tmpdir(), `resize-ssh-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  const keyPath = join(workDir, "id_ed25519");
  writeFileSync(keyPath, creds.privateKey, { mode: 0o600 });

  try {
    const config = loadServicesConfig();
    const deployDir = `/opt/${config.zone.replace(/\./g, "-")}`;
    await $`ssh -i ${keyPath} -o StrictHostKeyChecking=no ${creds.user}@${creds.host} cd ${deployDir} && docker compose stop`.quiet();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function triggerDeploy(ghToken: string, repo: string): Promise<void> {
  process.env["GH_TOKEN"] = ghToken;
  await $`gh workflow run deploy-pipeline.yml --repo ${repo}`.quiet();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadServicesConfig();
  const name = dropletName(config);
  const githubRepo = infraGithubRepo(config);
  const doToken = requireEnv("DIGITALOCEAN_TOKEN");

  const droplet = await findDropletByName(doToken, name);
  if (!droplet) throw new Error(`Droplet "${name}" not found`);

  if (droplet.size_slug === args.size) {
    console.log(`Droplet "${name}" already at size ${args.size}`);
    return;
  }

  console.log(`Resize ${name}: ${droplet.size_slug} → ${args.size} (id=${droplet.id})`);

  if (args.dryRun) {
    console.log("[dry-run] Would stop stack, power off, resize, power on, deploy");
    return;
  }

  const ssh = nodeSshFromEnv();
  if (!ssh) throw new Error("NODE_SSH_* credentials required for graceful stack stop");

  console.log("Stopping Docker stack on node...");
  await sshStopStack(ssh);

  console.log("Powering off droplet...");
  const offId = await dropletAction(doToken, droplet.id, { type: "power_off" });
  await waitForAction(doToken, droplet.id, offId);
  await waitForDropletStatus(doToken, droplet.id, "off");

  console.log(`Resizing to ${args.size}...`);
  const resizeId = await dropletAction(doToken, droplet.id, {
    type: "resize",
    size: args.size,
    disk: true,
  });
  await waitForAction(doToken, droplet.id, resizeId);

  console.log("Powering on droplet...");
  const onId = await dropletAction(doToken, droplet.id, { type: "power_on" });
  await waitForAction(doToken, droplet.id, onId);
  const active = await waitForDropletStatus(doToken, droplet.id, "active");
  const ip = active.networks.v4.find((n) => n.type === "public")?.ip_address;
  if (!ip) throw new Error("No public IP after resize");

  const workDir = join(tmpdir(), `resize-wait-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  const keyPath = join(workDir, "id_ed25519");
  writeFileSync(keyPath, ssh.privateKey, { mode: 0o600 });
  console.log(`Waiting for SSH at ${ip}...`);
  await waitForSsh(keyPath, ip);
  rmSync(workDir, { recursive: true, force: true });

  console.log(`Resize complete: ${name} is now ${args.size} at ${ip}`);

  if (args.triggerDeploy) {
    const ghToken = requireEnv("GITHUB_TOKEN_SUPER");
    console.log("Triggering deploy-pipeline...");
    await triggerDeploy(ghToken, githubRepo);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
