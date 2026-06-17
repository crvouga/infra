#!/usr/bin/env bun
/**
 * Reconcile Cloudflare DNS for Fly.io apps.
 *
 * Per public hostname: A/AAAA → Fly ingress (DNS-only; Fly terminates TLS).
 *
 * Usage:
 *   bun run scripts/sync-dns.ts
 *   bun run scripts/sync-dns.ts --apply
 *   bun run scripts/sync-dns.ts --id pickflix --apply
 */
import { $ } from "bun";
import { CloudflareApi, cloudflareCredentialsFromEnv, type CloudflareDnsRecord } from "../lib/cloudflare-api.js";
import {
  allDnsTargets,
  flyAppName,
  flyAppHostname,
  loadServicesConfig,
  standaloneVaultHostname,
  type DnsTarget,
  type ServicesConfig,
} from "../lib/services.js";
import { requireFlyApiToken } from "../lib/fly-token.js";

type RecordType = "A" | "AAAA" | "CNAME";

type DesiredRecord = {
  readonly type: RecordType;
  readonly content: string;
};

type Args = {
  readonly ids: readonly string[];
  readonly apply: boolean;
  readonly proxied: boolean;
  readonly pruneOrphans: boolean;
};

function parseArgs(argv: readonly string[]): Args {
  const ids: string[] = [];
  let apply = false;
  let proxied = false;
  let pruneOrphans = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--id") ids.push(argv[++i] ?? "");
    else if (arg === "--apply") apply = true;
    else if (arg === "--dns-only") proxied = false;
    else if (arg === "--no-prune") pruneOrphans = false;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun run scripts/sync-dns.ts [--id <id> ...] [--apply] [--dns-only] [--no-prune]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return { ids: ids.filter(Boolean), apply, proxied, pruneOrphans };
}

function servicesFromArgs(config: ServicesConfig, args: Args): readonly DnsTarget[] {
  if (args.ids.length === 0) return allDnsTargets(config);
  const all = allDnsTargets(config);
  const out: DnsTarget[] = [];
  for (const id of args.ids) {
    const s = all.find((x) => x.id === id);
    if (!s) {
      console.error(`No public service with id "${id}"`);
      process.exit(1);
    }
    out.push(s);
  }
  return out;
}

function flyCnameTarget(config: ServicesConfig, id: string): string {
  return flyAppHostname(config, id);
}

let cachedFlyIngress = new Map<string, { readonly v4?: string; readonly v6?: string }>();

async function flyIngressIps(app: string): Promise<{ readonly v4?: string; readonly v6?: string }> {
  const cached = cachedFlyIngress.get(app);
  if (cached) return cached;
  requireFlyApiToken();
  const result = await $`flyctl ips list -a ${app} --json`.env({ ...process.env }).quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`flyctl ips list (${app}) failed: ${result.stderr.toString().trim()}`);
  }
  const ips = JSON.parse(result.stdout.toString()) as Array<{ Address?: string; Type?: string }>;
  const v4 = ips.find((ip) => ip.Type === "shared_v4" || ip.Type === "v4")?.Address;
  const v6 = ips.find((ip) => ip.Type === "v6")?.Address;
  const resolved = { v4, v6 };
  cachedFlyIngress.set(app, resolved);
  return resolved;
}

async function desiredRecords(
  config: ServicesConfig,
  id: string,
  proxied: boolean,
): Promise<readonly DesiredRecord[]> {
  if (proxied) {
    return [{ type: "CNAME", content: flyCnameTarget(config, id) }];
  }
  const app = flyAppName(config, id);
  const ips = await flyIngressIps(app);
  const out: DesiredRecord[] = [];
  if (ips.v4) out.push({ type: "A", content: ips.v4 });
  if (ips.v6) out.push({ type: "AAAA", content: ips.v6 });
  if (out.length === 0) {
    throw new Error("No Fly ingress IPs found — deploy an app first");
  }
  return out;
}

type Action =
  | { readonly kind: "create"; readonly name: string; readonly record: DesiredRecord }
  | {
      readonly kind: "update";
      readonly name: string;
      readonly record: DesiredRecord;
      readonly recordId: string;
      readonly reason: string;
    }
  | { readonly kind: "delete"; readonly name: string; readonly recordId: string; readonly reason: string }
  | { readonly kind: "ok"; readonly name: string };

/** Fly terminates TLS — Cloudflare should use Full (strict). */
const DESIRED_SSL_MODE = "strict";

async function reconcileSslMode(
  cf: CloudflareApi,
  zoneId: string,
  apply: boolean,
): Promise<void> {
  const current = await cf.getZoneSetting(zoneId, "ssl");
  const mode = String(current.value);
  if (mode === DESIRED_SSL_MODE) {
    console.log(`  OK     SSL/TLS mode=${mode}`);
    return;
  }
  const line = `UPDATE SSL/TLS mode: ${mode} → ${DESIRED_SSL_MODE}`;
  if (!apply) {
    console.log(`  [plan] ${line}`);
    return;
  }
  await cf.setZoneSetting(zoneId, "ssl", DESIRED_SSL_MODE);
  console.log(`  [done] ${line}`);
}

async function planActions(
  records: readonly CloudflareDnsRecord[],
  config: ServicesConfig,
  services: readonly DnsTarget[],
  args: Args,
): Promise<readonly Action[]> {
  const byName = new Map<string, CloudflareDnsRecord[]>();
  for (const r of records) {
    const list = byName.get(r.name) ?? [];
    list.push(r);
    byName.set(r.name, list);
  }

  const actions: Action[] = [];
  const desiredNames = new Set<string>();

  for (const service of services) {
    desiredNames.add(service.hostname);
    const targets = await desiredRecords(config, service.id, args.proxied);
    const existing = byName.get(service.hostname) ?? [];
    const managedTypes = new Set(targets.map((t) => t.type));

    for (const record of existing) {
      if (!managedTypes.has(record.type as RecordType)) {
        actions.push({
          kind: "delete",
          name: record.name,
          recordId: record.id,
          reason: `unmanaged ${record.type} for Fly hostname`,
        });
      }
    }

    for (const target of targets) {
      const matches = existing.filter((r) => r.type === target.type);
      if (matches.length === 0) {
        actions.push({ kind: "create", name: service.hostname, record: target });
        continue;
      }

      const [primary, ...extra] = matches;
      for (const e of extra) {
        actions.push({ kind: "delete", name: e.name, recordId: e.id, reason: `duplicate ${target.type}` });
      }

      if (primary!.content !== target.content || primary!.proxied !== args.proxied) {
        actions.push({
          kind: "update",
          name: service.hostname,
          record: target,
          recordId: primary!.id,
          reason: "content/proxied drift",
        });
      }
    }

    const allOk = targets.every((target) => {
      const primary = existing.find((r) => r.type === target.type);
      return primary?.content === target.content && primary.proxied === args.proxied;
    });
    if (allOk && targets.every((t) => existing.some((r) => r.type === t.type))) {
      actions.push({ kind: "ok", name: service.hostname });
    }
  }

  if (args.pruneOrphans) {
    const originHostname = `origin.${config.zone}`;
    const excludedHostnames = new Set([standaloneVaultHostname(config)]);
    for (const r of records) {
      if (r.name === originHostname && r.type === "A") {
        actions.push({
          kind: "delete",
          name: r.name,
          recordId: r.id,
          reason: "legacy origin A record (DO droplet)",
        });
      }
      if (!["CNAME", "A", "AAAA"].includes(r.type)) continue;
      if (desiredNames.has(r.name)) continue;
      if (excludedHostnames.has(r.name)) continue;
      if (!r.name.endsWith(config.zone) && !r.name.includes(`.${config.zone}`)) continue;
      if (r.type === "CNAME" && !r.content.endsWith(".fly.dev")) continue;
      actions.push({
        kind: "delete",
        name: r.name,
        recordId: r.id,
        reason: `orphan ${r.type} → ${r.content}`,
      });
    }
  }

  return actions;
}

function summarise(action: Action): string {
  switch (action.kind) {
    case "create":
      return `CREATE ${action.name} ${action.record.type} → ${action.record.content}`;
    case "update":
      return `UPDATE ${action.name} ${action.record.type}: ${action.reason}`;
    case "delete":
      return `DELETE ${action.name} (${action.reason})`;
    case "ok":
      return `OK     ${action.name}`;
  }
}

async function applyAction(
  cf: CloudflareApi,
  zoneId: string,
  action: Action,
  args: Args,
  managedComment: string,
): Promise<void> {
  switch (action.kind) {
    case "create":
      await cf.createDnsRecord(zoneId, {
        name: action.name,
        type: action.record.type,
        content: action.record.content,
        proxied: args.proxied,
        ttl: 1,
        comment: managedComment,
      });
      return;
    case "update":
      await cf.updateDnsRecord(zoneId, action.recordId, {
        name: action.name,
        type: action.record.type,
        content: action.record.content,
        proxied: args.proxied,
        ttl: 1,
        comment: managedComment,
      });
      return;
    case "delete":
      await cf.deleteDnsRecord(zoneId, action.recordId);
      return;
    case "ok":
      return;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfCreds = cloudflareCredentialsFromEnv();
  if (!cfCreds) {
    console.warn(
      "Skipping DNS sync — CLOUDFLARE_API_TOKEN (or CF_API_TOKEN) not set",
    );
    return;
  }
  const config = loadServicesConfig();
  const services = servicesFromArgs(config, args);
  const managedComment = `managed by infra/scripts/sync-dns.ts (${config.zone})`;
  const cf = new CloudflareApi();
  const zone = await cf.findZoneByName(config.zone);
  if (!zone) {
    console.error(`Zone "${config.zone}" not found in Cloudflare account`);
    process.exit(1);
  }

  console.log(
    `Sync DNS (${args.apply ? "APPLY" : "DRY-RUN"}) zone=${config.zone} services=${services.length} proxied=${args.proxied}`,
  );

  const records = await cf.listDnsRecords(zone.id);
  const actions = await planActions(records, config, services, args);

  await reconcileSslMode(cf, zone.id, args.apply);

  let changes = 0;
  let errors = 0;
  for (const action of actions) {
    const line = summarise(action);
    if (action.kind === "ok") {
      console.log(`  ${line}`);
      continue;
    }
    changes += 1;
    if (!args.apply) {
      console.log(`  [plan] ${line}`);
      continue;
    }
    try {
      await applyAction(cf, zone.id, action, args, managedComment);
      console.log(`  [done] ${line}`);
    } catch (err) {
      errors += 1;
      console.error(`  [fail] ${line} — ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\nSummary: changes=${changes}, errors=${errors}`);
  if (errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
