#!/usr/bin/env bun
/**
 * Provision DigitalOcean droplet and wire NODE_SSH_* GitHub secrets.
 *
 * Usage:
 *   bun run scripts/provision-droplet.ts
 *   bun run scripts/provision-droplet.ts --dry-run
 *   bun run scripts/provision-droplet.ts --region sfo3 --skip-if-secrets-exist
 *
 * Env:
 *   DIGITALOCEAN_TOKEN
 *   SETUP_GITHUB_TOKEN  (gh CLI auth for secret set + workflow dispatch)
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { $ } from "bun";

const DO_API = "https://api.digitalocean.com/v2";
const DROPLET_NAME = "chrisvouga-origin";
const GITHUB_REPO = "crvouga/chrisvouga.dev";

type Args = {
  dryRun: boolean;
  region: string;
  size: string;
  skipIfSecretsExist: boolean;
  triggerDeploy: boolean;
};

function parseArgs(argv: readonly string[]): Args {
  let dryRun = false;
  let region = "nyc3";
  let size = "s-4vcpu-8gb";
  let skipIfSecretsExist = false;
  let triggerDeploy = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--region") region = argv[++i] ?? region;
    else if (arg === "--size") size = argv[++i] ?? size;
    else if (arg === "--skip-if-secrets-exist") skipIfSecretsExist = true;
    else if (arg === "--no-deploy") triggerDeploy = false;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun run scripts/provision-droplet.ts [--dry-run] [--region nyc3] [--size s-4vcpu-8gb] [--skip-if-secrets-exist] [--no-deploy]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return { dryRun, region, size, skipIfSecretsExist, triggerDeploy };
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
  networks: { v4: Array<{ ip_address: string; type: string }> };
};

async function findDropletByName(token: string, name: string): Promise<Droplet | null> {
  const data = await doFetch<{ droplets: Droplet[] }>(
    token,
    "GET",
    `/droplets?name=${encodeURIComponent(name)}`,
  );
  return data.droplets.find((d) => d.name === name) ?? null;
}

async function waitForDropletActive(token: string, id: number): Promise<Droplet> {
  for (let i = 0; i < 60; i++) {
    const data = await doFetch<{ droplet: Droplet }>(token, "GET", `/droplets/${id}`);
    if (data.droplet.status === "active") {
      const ip = data.droplet.networks.v4.find((n) => n.type === "public")?.ip_address;
      if (ip) return data.droplet;
    }
    await Bun.sleep(10_000);
  }
  throw new Error(`Droplet ${id} did not become active in time`);
}

async function ghSecretExists(name: string, ghToken: string): Promise<boolean> {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/actions/secrets/${name}`,
    {
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  return res.status === 200;
}

async function ghSecretSet(name: string, value: string, ghToken: string): Promise<void> {
  process.env["GH_TOKEN"] = ghToken;
  await $`gh secret set ${name} --repo ${GITHUB_REPO} --body ${value}`.quiet();
}

async function triggerDeploy(ghToken: string, runFlyTeardown: boolean): Promise<void> {
  process.env["GH_TOKEN"] = ghToken;
  const args = ["workflow", "run", "deploy-pipeline.yml", "--repo", GITHUB_REPO];
  if (runFlyTeardown) {
    args.push("-f", "run_fly_teardown=true");
  }
  await $`gh ${args}`.quiet();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const doToken = requireEnv("DIGITALOCEAN_TOKEN");
  const ghToken = requireEnv("SETUP_GITHUB_TOKEN");

  if (args.skipIfSecretsExist) {
    const exists = await ghSecretExists("NODE_SSH_HOST", ghToken);
    if (exists) {
      console.log("NODE_SSH_HOST secret already set — skipping provision");
      return;
    }
  }

  const existing = await findDropletByName(doToken, DROPLET_NAME);
  if (existing) {
    const ip = existing.networks.v4.find((n) => n.type === "public")?.ip_address;
    console.log(`Droplet "${DROPLET_NAME}" already exists (id=${existing.id}, ip=${ip})`);
    if (!ip) throw new Error("Existing droplet has no public IP");
    if (!args.dryRun && process.env["NODE_SSH_PRIVATE_KEY"]?.trim()) {
      console.log("Re-using existing droplet — updating NODE_SSH_* secrets from env");
      await ghSecretSet("NODE_SSH_HOST", ip, ghToken);
      await ghSecretSet("NODE_SSH_USER", "root", ghToken);
      await ghSecretSet("NODE_SSH_KEY", process.env["NODE_SSH_PRIVATE_KEY"].trim(), ghToken);
    }
    return;
  }

  const workDir = join(tmpdir(), `chrisvouga-provision-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  const keyPath = join(workDir, "id_ed25519");
  const pubPath = `${keyPath}.pub`;

  if (args.dryRun) {
    console.log(`[dry-run] Would create droplet ${DROPLET_NAME} in ${args.region} (${args.size})`);
    rmSync(workDir, { recursive: true, force: true });
    return;
  }

  await $`ssh-keygen -t ed25519 -f ${keyPath} -N "" -q`.quiet();
  const pubKey = readFileSync(pubPath, "utf8").trim();
  const privateKey = readFileSync(keyPath, "utf8");

  const userData = `#!/bin/bash
set -euo pipefail
mkdir -p /root/.ssh
chmod 700 /root/.ssh
grep -qF '${pubKey}' /root/.ssh/authorized_keys 2>/dev/null || echo '${pubKey}' >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker
`;

  writeFileSync(join(workDir, "user-data.sh"), userData);

  const createBody = {
    name: DROPLET_NAME,
    region: args.region,
    size: args.size,
    image: "ubuntu-24-04-x64",
    ipv6: false,
    monitoring: true,
    tags: ["chrisvouga", "origin"],
    user_data: userData,
  };

  console.log(`Creating droplet ${DROPLET_NAME} in ${args.region}...`);
  const created = await doFetch<{ droplet: Droplet }>(
    doToken,
    "POST",
    "/droplets",
    createBody,
  );

  const droplet = await waitForDropletActive(doToken, created.droplet.id);
  const ip = droplet.networks.v4.find((n) => n.type === "public")?.ip_address;
  if (!ip) throw new Error("No public IP on new droplet");

  console.log(`Droplet active: ${ip}`);
  console.log("Waiting for SSH...");
  for (let i = 0; i < 30; i++) {
    try {
      await $`ssh -i ${keyPath} -o StrictHostKeyChecking=no -o ConnectTimeout=5 root@${ip} echo ok`.quiet();
      break;
    } catch {
      if (i === 29) throw new Error("SSH never became available");
      await Bun.sleep(10_000);
    }
  }

  console.log("Setting GitHub secrets...");
  await ghSecretSet("NODE_SSH_HOST", ip, ghToken);
  await ghSecretSet("NODE_SSH_USER", "root", ghToken);
  await ghSecretSet("NODE_SSH_KEY", privateKey, ghToken);

  rmSync(workDir, { recursive: true, force: true });

  if (args.triggerDeploy) {
    console.log("Triggering deploy-pipeline...");
    await triggerDeploy(ghToken, false);
  }

  console.log("Provision complete");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
