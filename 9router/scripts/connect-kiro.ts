/**
 * Start Kiro device-code login, open the verification URL, and poll until connected.
 * Writes no secrets to stdout (only user_code + status).
 */
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createAuthedClient } from "./lib/client.ts";

const STATE_FILE = join(tmpdir(), "9router-kiro-device.json");

async function main(): Promise<void> {
  const client = await createAuthedClient();
  const device = await client.json<Record<string, unknown>>(
    "/api/oauth/kiro/device-code",
  );

  const userCode = String(device.user_code ?? "");
  const verifyUrl = String(
    device.verification_uri_complete ??
      device.verification_uri ??
      "https://view.awsapps.com/start/#/device",
  );
  const intervalMs = Math.max(1, Number(device.interval ?? 2)) * 1000;
  const deadline = Date.now() + Number(device.expires_in ?? 600) * 1000;

  writeFileSync(STATE_FILE, JSON.stringify(device), { mode: 0o600 });

  console.log(`Kiro device login`);
  console.log(`  user_code: ${userCode}`);
  console.log(`  open:      ${verifyUrl}`);
  console.log(`  Complete AWS/Kiro login in the browser, then wait…`);

  try {
    spawn("open", [verifyUrl], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* ignore */
  }

  const deviceCode = String(device.device_code ?? "");
  // Kiro pollToken reads underscore-prefixed fields from the device-code response.
  const extraData = {
    _clientId: device._clientId,
    _clientSecret: device._clientSecret,
    _region: device._region ?? "us-east-1",
    _authMethod: device._authMethod,
    _startUrl: device._startUrl,
  };

  while (Date.now() < deadline) {
    const res = await client.fetch("/api/oauth/kiro/poll", {
      method: "POST",
      body: JSON.stringify({ deviceCode, extraData }),
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { raw: text.slice(0, 200) };
    }

    if (body.success && body.connection) {
      const conn = body.connection as { id?: string; provider?: string };
      console.log(
        `Connected Kiro: id=${conn.id ?? "?"} provider=${conn.provider ?? "kiro"}`,
      );
      if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
      return;
    }

    const err = String(body.error ?? "");
    if (
      body.pending ||
      err === "authorization_pending" ||
      err === "slow_down"
    ) {
      process.stdout.write(".");
      await new Promise((r) =>
        setTimeout(r, err === "slow_down" ? intervalMs * 2 : intervalMs),
      );
      continue;
    }

    console.error(`\nPoll failed: ${err || res.status} ${text.slice(0, 200)}`);
    process.exit(1);
  }

  console.error("\nDevice code expired before authorization completed");
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
