/**
 * Presence offline-scrub test (no runner) — the WIRE-LEVEL guard for per-channel attention. When an
 * endpoint goes offline gracefully it must NOT publish the advisory attention fields in its raw presence
 * KV record (SPEC §6: attention removed / channelModes reset on offline). Observer-side roster
 * materialization (toOffline) also scrubs, but this reads the RAW KV record — what a direct wire consumer
 * (e.g. a dashboard reading the KV) would see — to prove the *publisher* itself is compliant.
 * Run: pnpm smoke:presence-scrub
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { CotalEndpoint, isReachable, presenceBucket, type Presence } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "scrubsmoke";
const id = "otto_scrub";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });

const dir = mkdtempSync(join(tmpdir(), "cotal-scrub-"));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

try {
  for (let i = 0; i < 50; i++) { if (await isReachable(servers)) break; await sleep(200); }

  const ep = new CotalEndpoint({ space, servers, channels: ["general"], card: { name: "otto", kind: "agent", id } });
  ep.on("error", () => {});
  await ep.start();
  await ep.setAttention("dnd");
  await ep.setChannelModes({ general: "muted" });
  await sleep(300);

  // A direct wire consumer of the presence KV (like a dashboard), bypassing observer-side scrub.
  const nc = await connect({ servers });
  const kv = await new Kvm(nc).open(presenceBucket(space));
  const read = async (): Promise<Presence | undefined> => (await kv.get(id))?.json<Presence>();

  const live = await read();
  check("LIVE raw record carries attention + channelModes", live?.attention === "dnd" && live?.channelModes?.general === "muted");

  await ep.stop(); // graceful → publishes an offline record
  await sleep(300);

  const off = await read();
  check(
    "PUBLISHED offline raw record is scrubbed (status offline, no attention/channelModes)",
    off?.status === "offline" && off?.attention === undefined && off?.channelModes === undefined,
    off,
  );

  await nc.close();
  console.log(`\nPRESENCE OFFLINE-SCRUB TEST PASSED ✅  (${pass} checks)`);
} finally {
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
