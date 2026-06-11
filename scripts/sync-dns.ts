#!/usr/bin/env bun
/**
 * Reconcile Cloudflare DNS for the single-node stack.
 *
 * Ensures:
 *   origin.<zone>  A      → NODE_SSH_HOST (droplet IP)
 *   <hostname>     CNAME  → origin.<zone>  (proxied=true by default)
 *
 * Prunes orphan CNAMEs pointing at *.fly.dev.
 *
 * Usage:
 *   bun run scripts/sync-dns.ts
 *   bun run scripts/sync-dns.ts --apply
 *   bun run scripts/sync-dns.ts --id pickflix --apply
 */
import { CloudflareApi, type CloudflareDnsRecord } from "../lib/cloudflare-api.js";
import { loadServicesConfig, type ServiceSpec } from "../lib/services.js";

type Args = {
  readonly ids: readonly string[];
  readonly apply: boolean;
  readonly proxied: boolean;
  readonly pruneOrphans: boolean;
};

function parseArgs(argv: readonly string[]): Args {
  const ids: string[] = [];
  let apply = false;
  let proxied = true;
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

function nodeIp(): string {
  const ip = process.env["NODE_SSH_HOST"]?.trim();
  if (!ip) {
    throw new Error("NODE_SSH_HOST is required (droplet IP for origin A record).");
  }
  return ip;
}

function servicesFromArgs(config: ReturnType<typeof loadServicesConfig>, args: Args): readonly ServiceSpec[] {
  if (args.ids.length === 0) return config.services;
  const out: ServiceSpec[] = [];
  for (const id of args.ids) {
    const s = config.services.find((x) => x.id === id);
    if (!s) {
      console.error(`No service with id "${id}"`);
      process.exit(1);
    }
    out.push(s);
  }
  return out;
}

type Action =
  | { readonly kind: "create"; readonly name: string; readonly type: "A" | "CNAME"; readonly content: string }
  | { readonly kind: "update"; readonly name: string; readonly type: "A" | "CNAME"; readonly content: string; readonly recordId: string; readonly reason: string }
  | { readonly kind: "delete"; readonly name: string; readonly recordId: string; readonly reason: string }
  | { readonly kind: "ok"; readonly name: string };

const FLY_SUFFIX = ".fly.dev";

async function planActions(
  records: readonly CloudflareDnsRecord[],
  config: ReturnType<typeof loadServicesConfig>,
  services: readonly ServiceSpec[],
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
  const origin = config.origin_hostname;
  const originTarget = nodeIp();

  desiredNames.add(origin);
  const originRecords = byName.get(origin) ?? [];
  const originA = originRecords.filter((r) => r.type === "A");
  if (originA.length === 0) {
    actions.push({ kind: "create", name: origin, type: "A", content: originTarget });
  } else {
    const [primary, ...extra] = originA;
    for (const e of extra) {
      actions.push({ kind: "delete", name: e.name, recordId: e.id, reason: "duplicate origin A" });
    }
    if (primary!.content !== originTarget || primary!.proxied !== args.proxied) {
      actions.push({
        kind: "update",
        name: origin,
        type: "A",
        content: originTarget,
        recordId: primary!.id,
        reason: `content/proxied drift`,
      });
    } else {
      actions.push({ kind: "ok", name: origin });
    }
  }

  for (const service of services) {
    desiredNames.add(service.hostname);
    const existing = byName.get(service.hostname) ?? [];
    const cnames = existing.filter((r) => r.type === "CNAME");
    const others = existing.filter((r) => r.type !== "CNAME");

    for (const o of others) {
      actions.push({
        kind: "delete",
        name: o.name,
        recordId: o.id,
        reason: `non-CNAME ${o.type} collides with managed CNAME`,
      });
    }

    if (cnames.length === 0) {
      actions.push({ kind: "create", name: service.hostname, type: "CNAME", content: origin });
      continue;
    }

    const [primary, ...extra] = cnames;
    for (const e of extra) {
      actions.push({ kind: "delete", name: e.name, recordId: e.id, reason: "duplicate CNAME" });
    }

    if (primary!.content !== origin || primary!.proxied !== args.proxied) {
      actions.push({
        kind: "update",
        name: service.hostname,
        type: "CNAME",
        content: origin,
        recordId: primary!.id,
        reason: `content/proxied drift`,
      });
    } else {
      actions.push({ kind: "ok", name: service.hostname });
    }
  }

  if (args.pruneOrphans) {
    for (const r of records) {
      if (r.type !== "CNAME") continue;
      if (!r.content.endsWith(FLY_SUFFIX)) continue;
      if (desiredNames.has(r.name)) continue;
      if (!r.name.endsWith(config.zone) && !r.name.includes(`.${config.zone}`)) continue;
      actions.push({
        kind: "delete",
        name: r.name,
        recordId: r.id,
        reason: `orphan fly.dev CNAME → ${r.content}`,
      });
    }
  }

  return actions;
}

function summarise(action: Action): string {
  switch (action.kind) {
    case "create":
      return `CREATE ${action.name} ${action.type} → ${action.content}`;
    case "update":
      return `UPDATE ${action.name}: ${action.reason}`;
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
): Promise<void> {
  switch (action.kind) {
    case "create":
      await cf.createDnsRecord(zoneId, {
        name: action.name,
        type: action.type,
        content: action.content,
        proxied: args.proxied,
        ttl: 1,
        comment: "managed by chrisvouga.dev/scripts/sync-dns.ts",
      });
      return;
    case "update":
      await cf.updateDnsRecord(zoneId, action.recordId, {
        name: action.name,
        type: action.type,
        content: action.content,
        proxied: args.proxied,
        ttl: 1,
        comment: "managed by chrisvouga.dev/scripts/sync-dns.ts",
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
  const config = loadServicesConfig();
  const services = servicesFromArgs(config, args);
  const cf = new CloudflareApi();
  const zone = await cf.findZoneByName(config.zone);
  if (!zone) {
    console.error(`Zone "${config.zone}" not found in Cloudflare account`);
    process.exit(1);
  }

  console.log(
    `Sync DNS (${args.apply ? "APPLY" : "DRY-RUN"}) zone=${config.zone} origin=${config.origin_hostname}→${nodeIp()} services=${services.length} proxied=${args.proxied}`,
  );

  const records = await cf.listDnsRecords(zone.id);
  const actions = await planActions(records, config, services, args);

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
      await applyAction(cf, zone.id, action, args);
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
