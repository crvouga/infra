import { $ } from "bun";
import {
  CloudflareApi,
  type CloudflareDnsRecord,
  type CloudflareDnsRecordInput,
} from "./cloudflare-api.js";

export type FlyCertDnsRequirements = {
  readonly a?: readonly string[];
  readonly aaaa?: readonly string[];
  readonly cname?: string;
  readonly ownership?: { readonly name: string; readonly app_value: string };
  readonly acme_challenge?: { readonly name: string; readonly target: string };
};

type HostRecordType = "A" | "AAAA" | "CNAME";

type DesiredRecord = {
  readonly name: string;
  readonly type: CloudflareDnsRecordInput["type"];
  readonly content: string;
};

const HOST_RECORD_TYPES: readonly HostRecordType[] = ["A", "AAAA", "CNAME"];
const DESIRED_SSL_MODE = "strict";

export async function fetchFlyCertDnsRequirements(
  hostname: string,
  flyApp: string,
): Promise<FlyCertDnsRequirements> {
  const result = await $`flyctl certs show ${hostname} --app ${flyApp} --json`
    .env({ ...process.env })
    .quiet()
    .nothrow();
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim() || result.stdout.toString().trim();
    throw new Error(`flyctl certs show (${hostname}) failed: ${detail}`);
  }
  const body = JSON.parse(result.stdout.toString()) as {
    dns_requirements?: FlyCertDnsRequirements;
  };
  return body.dns_requirements ?? {};
}

function normalizeCnameTarget(target: string): string {
  return target.replace(/\.$/, "");
}

function desiredHostRecords(
  hostname: string,
  reqs: FlyCertDnsRequirements,
): readonly DesiredRecord[] {
  const out: DesiredRecord[] = [];
  for (const ip of reqs.a ?? []) {
    out.push({ name: hostname, type: "A", content: ip });
  }
  for (const ip of reqs.aaaa ?? []) {
    out.push({ name: hostname, type: "AAAA", content: ip });
  }
  if (!out.some((r) => r.type === "A" || r.type === "AAAA") && reqs.cname) {
    out.push({ name: hostname, type: "CNAME", content: normalizeCnameTarget(reqs.cname) });
  }
  return out;
}

function desiredAuxRecords(reqs: FlyCertDnsRequirements): readonly DesiredRecord[] {
  const out: DesiredRecord[] = [];
  if (reqs.ownership?.name && reqs.ownership.app_value) {
    out.push({
      name: reqs.ownership.name,
      type: "TXT",
      content: reqs.ownership.app_value,
    });
  }
  if (reqs.acme_challenge?.name && reqs.acme_challenge.target) {
    out.push({
      name: reqs.acme_challenge.name,
      type: "CNAME",
      content: normalizeCnameTarget(reqs.acme_challenge.target),
    });
  }
  return out;
}

function recordsForName(
  records: readonly CloudflareDnsRecord[],
  name: string,
): readonly CloudflareDnsRecord[] {
  return records.filter((r) => r.name === name);
}

async function upsertDnsRecord(
  cf: CloudflareApi,
  zoneId: string,
  records: readonly CloudflareDnsRecord[],
  desired: DesiredRecord,
  proxied: boolean,
  dryRun: boolean,
  managedComment: string,
): Promise<void> {
  const existing = records.filter((r) => r.name === desired.name && r.type === desired.type);
  const [primary, ...extra] = existing;

  for (const duplicate of extra) {
    const line = `DELETE duplicate ${desired.type} ${desired.name}`;
    if (dryRun) {
      console.log(`  [dry-run] ${line}`);
      continue;
    }
    await cf.deleteDnsRecord(zoneId, duplicate.id);
    console.log(`  [done] ${line}`);
  }

  if (
    primary &&
    primary.content === desired.content &&
    primary.proxied === proxied
  ) {
    console.log(`  OK     ${desired.type} ${desired.name} → ${desired.content}`);
    return;
  }

  const input: CloudflareDnsRecordInput = {
    name: desired.name,
    type: desired.type,
    content: desired.content,
    proxied,
    ttl: 1,
    comment: managedComment,
  };

  if (dryRun) {
    const verb = primary ? "UPDATE" : "CREATE";
    console.log(`  [dry-run] ${verb} ${desired.type} ${desired.name} → ${desired.content}`);
    return;
  }

  if (primary) {
    await cf.updateDnsRecord(zoneId, primary.id, input);
    console.log(`  [done] UPDATE ${desired.type} ${desired.name} → ${desired.content}`);
    return;
  }

  await cf.createDnsRecord(zoneId, input);
  console.log(`  [done] CREATE ${desired.type} ${desired.name} → ${desired.content}`);
}

async function deleteStaleHostRecords(
  cf: CloudflareApi,
  zoneId: string,
  hostname: string,
  records: readonly CloudflareDnsRecord[],
  desiredHostTypes: ReadonlySet<HostRecordType>,
  dryRun: boolean,
): Promise<void> {
  for (const record of recordsForName(records, hostname)) {
    if (!HOST_RECORD_TYPES.includes(record.type as HostRecordType)) continue;
    if (desiredHostTypes.has(record.type as HostRecordType)) continue;
    const line = `DELETE stale ${record.type} ${record.name} → ${record.content}`;
    if (dryRun) {
      console.log(`  [dry-run] ${line}`);
      continue;
    }
    await cf.deleteDnsRecord(zoneId, record.id);
    console.log(`  [done] ${line}`);
  }
}

async function reconcileSslMode(
  cf: CloudflareApi,
  zoneId: string,
  dryRun: boolean,
): Promise<void> {
  const current = await cf.getZoneSetting(zoneId, "ssl");
  const mode = String(current.value);
  if (mode === DESIRED_SSL_MODE) {
    console.log(`  OK     SSL/TLS mode=${mode}`);
    return;
  }
  const line = `UPDATE SSL/TLS mode: ${mode} → ${DESIRED_SSL_MODE}`;
  if (dryRun) {
    console.log(`  [dry-run] ${line}`);
    return;
  }
  await cf.setZoneSetting(zoneId, "ssl", DESIRED_SSL_MODE);
  console.log(`  [done] ${line}`);
}

export async function reconcileFlyCertDns(opts: {
  readonly cf: CloudflareApi;
  readonly zoneId: string;
  readonly hostname: string;
  readonly flyApp: string;
  readonly dryRun: boolean;
  readonly managedComment: string;
  readonly proxied?: boolean;
}): Promise<void> {
  const proxied = opts.proxied ?? false;
  const reqs = await fetchFlyCertDnsRequirements(opts.hostname, opts.flyApp);
  const hostRecords = desiredHostRecords(opts.hostname, reqs);
  if (hostRecords.length === 0) {
    throw new Error(`Fly returned no DNS targets for ${opts.hostname}`);
  }

  const auxRecords = desiredAuxRecords(reqs);
  const allDesired = [...hostRecords, ...auxRecords];
  const desiredHostTypes = new Set(
    hostRecords.map((r) => r.type as HostRecordType),
  );

  let records = await opts.cf.listDnsRecords(opts.zoneId);

  console.log(
    `  Reconcile DNS for ${opts.hostname} (${opts.flyApp}) host=${hostRecords.map((r) => `${r.type}→${r.content}`).join(", ")}`,
  );
  if (reqs.ownership?.name) {
    console.log(`  ownership TXT ${reqs.ownership.name}=${reqs.ownership.app_value}`);
  }

  await deleteStaleHostRecords(
    opts.cf,
    opts.zoneId,
    opts.hostname,
    records,
    desiredHostTypes,
    opts.dryRun,
  );

  for (const desired of allDesired) {
    await upsertDnsRecord(
      opts.cf,
      opts.zoneId,
      records,
      desired,
      proxied,
      opts.dryRun,
      opts.managedComment,
    );
  }

  await reconcileSslMode(opts.cf, opts.zoneId, opts.dryRun);

  if (!opts.dryRun) {
    records = await opts.cf.listDnsRecords(opts.zoneId);
  }
}
