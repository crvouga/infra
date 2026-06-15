#!/usr/bin/env bun
/**
 * Provision DigitalOcean droplet and write node SSH credentials to shared Vault.
 *
 * Usage:
 *   bun run scripts/provision-droplet.ts
 *   bun run scripts/provision-droplet.ts --dry-run
 *   bun run scripts/provision-droplet.ts --region sfo3 --skip-if-secrets-exist
 *
 * Env:
 *   DIGITALOCEAN_TOKEN
 *   GITHUB_TOKEN_SUPER  (gh CLI auth for workflow dispatch)
 *   VAULT_TOKEN         (exported by vault-secrets action in CI)
 *   NODE_SSH_*          (loaded from Vault when already provisioned)
 *   MIGRATE_FROM_LEGACY_NODE_SSH_*  (one-time copy from GitHub repo secrets)
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { $ } from "bun";
import {
  nodeSshFromEnv,
  nodeSshHostFromEnv,
  setNodeSshEnv,
  type NodeSshCredentials,
} from "../lib/node-ssh.js";
import { writeNodeSshToVault } from "../lib/vault-kv.js";
import {
  doProjectName,
  dropletName,
  infraGithubRepo,
  loadServicesConfig,
  zoneSlug,
} from "../lib/services.js";

const DO_API = "https://api.digitalocean.com/v2";

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
  let size = "s-2vcpu-4gb";
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
        "Usage: bun run scripts/provision-droplet.ts [--dry-run] [--region nyc3] [--size s-2vcpu-4gb] [--skip-if-secrets-exist] [--no-deploy]",
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

type DoProject = {
  id: string;
  name: string;
};

async function findDropletByName(token: string, name: string): Promise<Droplet | null> {
  const data = await doFetch<{ droplets: Droplet[] }>(
    token,
    "GET",
    `/droplets?name=${encodeURIComponent(name)}`,
  );
  return data.droplets.find((d) => d.name === name) ?? null;
}

async function deleteDroplet(token: string, id: number): Promise<void> {
  await doFetch(token, "DELETE", `/droplets/${id}`);
}

async function findDoProject(token: string, name: string): Promise<DoProject | null> {
  let page = 1;
  while (true) {
    const data = await doFetch<{ projects: DoProject[]; links?: { pages?: { next?: string } } }>(
      token,
      "GET",
      `/projects?page=${page}&per_page=200`,
    );
    const match = data.projects.find((p) => p.name === name);
    if (match) return match;
    if (!data.links?.pages?.next) return null;
    page += 1;
  }
}

async function assignDropletToProject(
  token: string,
  projectId: string,
  dropletId: number,
): Promise<void> {
  await doFetch(token, "POST", `/projects/${projectId}/resources`, {
    resources: [`do:droplet:${dropletId}`],
  });
}

type DoSshKey = {
  id: number;
  fingerprint: string;
  public_key: string;
  name: string;
};

async function ensureDoSshKey(
  token: string,
  name: string,
  publicKey: string,
): Promise<string> {
  const data = await doFetch<{ ssh_keys: DoSshKey[] }>(token, "GET", "/account/keys");
  const match =
    data.ssh_keys.find((k) => k.public_key.trim() === publicKey.trim()) ??
    data.ssh_keys.find((k) => k.name === name);
  if (match) return match.fingerprint;

  const created = await doFetch<{ ssh_key: { fingerprint: string } }>(
    token,
    "POST",
    "/account/keys",
    { name, public_key: publicKey },
  );
  return created.ssh_key.fingerprint;
}

async function waitForSsh(keyPath: string, ip: string): Promise<void> {
  const maxAttempts = 60;
  let lastError = "";
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await $`ssh -i ${keyPath} -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes root@${ip} echo ok`.quiet();
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const elapsed = (i + 1) * 10;
      if (i === 0 || (i + 1) % 6 === 0) {
        console.log(`  SSH not ready yet (${elapsed}s)...`);
      }
      if (i === maxAttempts - 1) {
        throw new Error(`SSH never became available after ${elapsed}s: ${lastError}`);
      }
      await Bun.sleep(10_000);
    }
  }
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

async function triggerDeploy(ghToken: string, repo: string): Promise<void> {
  process.env["GH_TOKEN"] = ghToken;
  await $`gh workflow run deploy-pipeline.yml --repo ${repo}`.quiet();
}

async function migrateLegacySshToVault(): Promise<boolean> {
  if (nodeSshHostFromEnv()) return false;

  const host = process.env.MIGRATE_FROM_LEGACY_NODE_SSH_HOST?.trim();
  const user = process.env.MIGRATE_FROM_LEGACY_NODE_SSH_USER?.trim() || "root";
  const privateKey = process.env.MIGRATE_FROM_LEGACY_NODE_SSH_KEY?.trim();
  if (!host || !privateKey) return false;

  const creds: NodeSshCredentials = { host, user, privateKey };
  await writeNodeSshToVault(creds);
  setNodeSshEnv(creds);
  console.log("Migrated legacy GitHub NODE_SSH_* repo secrets to Vault (NODE_SSH_*)");
  return true;
}

async function persistNodeSshToVault(creds: NodeSshCredentials): Promise<void> {
  await writeNodeSshToVault(creds);
  setNodeSshEnv(creds);
  console.log("Wrote NODE_SSH_* to Vault (secret/data/personal/prd)");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadServicesConfig();
  const name = dropletName(config);
  const projectName = doProjectName(config);
  const githubRepo = infraGithubRepo(config);
  const slug = zoneSlug(config.zone);

  const doToken = requireEnv("DIGITALOCEAN_TOKEN");
  const ghToken = requireEnv("GITHUB_TOKEN_SUPER");

  await migrateLegacySshToVault();

  if (args.skipIfSecretsExist && nodeSshHostFromEnv()) {
    console.log("NODE_SSH_HOST already in Vault — skipping provision");
    return;
  }

  const sshConfiguredInVault = nodeSshHostFromEnv() !== null;
  const existing = await findDropletByName(doToken, name);
  if (existing) {
    const ip = existing.networks.v4.find((n) => n.type === "public")?.ip_address;
    console.log(`Droplet "${name}" already exists (id=${existing.id}, ip=${ip})`);
    if (!ip) throw new Error("Existing droplet has no public IP");

    if (sshConfiguredInVault) {
      console.log("Vault SSH credentials present — reusing existing droplet");
      return;
    }

    const credsFromEnv = nodeSshFromEnv();
    if (!args.dryRun && credsFromEnv) {
      console.log("Re-using existing droplet — updating Vault SSH credentials from env");
      await persistNodeSshToVault(credsFromEnv);
      return;
    }

    if (args.dryRun) {
      console.log("[dry-run] Would delete orphaned droplet and recreate with a registered DO SSH key");
      return;
    }

    console.log("Orphaned droplet found (no NODE_SSH_* in Vault) — deleting and recreating");
    await deleteDroplet(doToken, existing.id);
    for (let i = 0; i < 30; i++) {
      const stillThere = await findDropletByName(doToken, name);
      if (!stillThere) break;
      await Bun.sleep(5_000);
    }
  }

  const workDir = join(tmpdir(), `${slug}-provision-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  const keyPath = join(workDir, "id_ed25519");
  const pubPath = `${keyPath}.pub`;

  if (args.dryRun) {
    console.log(`[dry-run] Would create droplet ${name} in ${args.region} (${args.size})`);
    console.log(`[dry-run] Would assign to DO project "${projectName}"`);
    rmSync(workDir, { recursive: true, force: true });
    return;
  }

  await $`ssh-keygen -t ed25519 -f ${keyPath} -N "" -q`.quiet();
  const pubKey = readFileSync(pubPath, "utf8").trim();
  const privateKey = readFileSync(keyPath, "utf8");

  const sshFingerprint = await ensureDoSshKey(
    doToken,
    `${name}-${new Date().toISOString().slice(0, 10)}`,
    pubKey,
  );

  const userData = `#!/bin/bash
set -euo pipefail
nohup bash -c 'curl -fsSL https://get.docker.com | sh && systemctl enable docker && systemctl start docker' >/var/log/docker-install.log 2>&1 &
`;

  const createBody = {
    name,
    region: args.region,
    size: args.size,
    image: "ubuntu-24-04-x64",
    ipv6: false,
    monitoring: true,
    tags: ["origin"],
    ssh_keys: [sshFingerprint],
    user_data: userData,
  };

  console.log(`Creating droplet ${name} in ${args.region}...`);
  const created = await doFetch<{ droplet: Droplet }>(
    doToken,
    "POST",
    "/droplets",
    createBody,
  );

  const droplet = await waitForDropletActive(doToken, created.droplet.id);
  const ip = droplet.networks.v4.find((n) => n.type === "public")?.ip_address;
  if (!ip) throw new Error("No public IP on new droplet");

  const project = await findDoProject(doToken, projectName);
  if (project) {
    await assignDropletToProject(doToken, project.id, droplet.id);
    console.log(`Assigned droplet to DO project "${projectName}"`);
  } else {
    console.warn(`DO project "${projectName}" not found — droplet created without project assignment`);
  }

  console.log(`Droplet active: ${ip}`);
  console.log("Waiting for SSH (DO-injected key, up to 10 min)...");
  await waitForSsh(keyPath, ip);
  console.log("SSH ready");

  await persistNodeSshToVault({ host: ip, user: "root", privateKey });

  rmSync(workDir, { recursive: true, force: true });

  if (args.triggerDeploy) {
    console.log("Triggering deploy-pipeline...");
    await triggerDeploy(ghToken, githubRepo);
  }

  console.log("Provision complete");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
