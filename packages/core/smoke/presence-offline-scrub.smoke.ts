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
import { CotalEndpoint, isReachable, mintLifecycleUid, presenceBucket, principalKey, DEV_OWNER, type Presence } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, teardownOnSignal } from "@cotal-ai/smoke-kit";

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

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });

  const reader = new CotalEndpoint({ space, servers, channels: [], consume: false, registerPresence: false, watchChannels: false, heartbeatMs: 200, ttlMs: 1_200, card: { name: "reader", kind: "endpoint", id: "reader_scrub" } });
  reader.on("error", () => {});
  const readerWarnings: string[] = [];
  reader.on("warning", (err: Error) => readerWarnings.push(err.message));
  await reader.start();

  const ep = new CotalEndpoint({ space, servers, channels: ["general"], heartbeatMs: 200, ttlMs: 1_200, card: { name: "otto", kind: "agent", id }, lifecycleUid: mintLifecycleUid() });
  ep.on("error", () => {});
  const writerWarnings: string[] = [];
  ep.on("warning", (err: Error) => writerWarnings.push(err.message));
  await ep.start();
  await ep.setActivity("reading");
  await ep.setCondition({ code: "approval", since: 123 });
  await ep.setAttention("dnd");
  await ep.setChannelModes({ general: "muted" });
  await sleep(300);

  // A direct wire consumer of the presence KV (like a dashboard), bypassing observer-side scrub.
  const nc = await connect({ servers });
  const kv = await new Kvm(nc).open(presenceBucket(space));
  // Presence is keyed by the PRINCIPAL dot-form (`local.<id>` = card.id under the owner+actor grammar), not the raw id.
  const read = async (): Promise<Presence | undefined> => (await kv.get(principalKey(DEV_OWNER, id).key))?.json<Presence>();

  const live = await read();
  check("LIVE raw record carries attention + channelModes", live?.attention === "dnd" && live?.channelModes?.general === "muted");
  check(
    "positive control: valid activity, condition and attention propagate with no drops",
    live?.status === "idle"
      && live.activity === "reading"
      && live.condition?.code === "approval"
      && live.attention === "dnd"
      && reader.presenceBindingDropCount === 0
      && readerWarnings.length === 0
      && writerWarnings.length === 0
      && reader.getRoster().find((p) => p.card.id === ep.card.id)?.status === "idle",
    { live, roster: reader.getRoster(), drops: reader.presenceBindingDropCount },
  );

  // #4003: presence setters refuse non-string display fields, invalid statuses and malformed
  // conditions with a TypeError naming the field before mutating local state or publishing.
  const hostile = { toString: null, valueOf: null };
  const rejectedCalls: Array<[string, () => Promise<void>, RegExp]> = [
    ["setActivity with an object", () => ep.setActivity({ text: "reading" } as unknown as string), /\bactivity\b/],
    ["setActivity with a hostile object", () => ep.setActivity(hostile as unknown as string), /\bactivity\b/],
    ["setActivity with a number", () => ep.setActivity(42 as unknown as string), /\bactivity\b/],
    ["setActivity with null", () => ep.setActivity(null as unknown as string), /\bactivity\b/],
    ["setActivity with undefined", () => ep.setActivity(undefined as unknown as string), /\bactivity\b/],
    ["setStatus with an object activity", () => ep.setStatus("working", { text: "reading" } as unknown as string), /\bactivity\b/],
    ["setStatus with a null activity", () => ep.setStatus("working", null as unknown as string), /\bactivity\b/],
    ["setStatus with an object status", () => ep.setStatus({ status: "working" } as unknown as "working"), /\bstatus\b/],
    ["setStatus with an unknown status", () => ep.setStatus("busy" as unknown as "working"), /\bstatus\b/],
    ["setCondition with an object condition.code", () => ep.setCondition({ code: { id: "approval" } as unknown as "approval", since: 1 }), /\bcondition\.code\b/],
    ["setCondition with a hostile condition.code", () => ep.setCondition({ code: hostile as unknown as "approval" }), /\bcondition\.code\b/],
    ["setCondition with no code", () => ep.setCondition({ since: 1 } as unknown as null), /\bcondition\.code\b/],
    ["setCondition with a string", () => ep.setCondition("approval" as unknown as null), /\bcondition\b/],
    ["setCondition with undefined", () => ep.setCondition(undefined as unknown as null), /\bcondition\b/],
    ["setAttention with an object", () => ep.setAttention({ mode: "open" } as unknown as "open"), /\battention\b/],
    ["setAttention with a hostile object", () => ep.setAttention(hostile as unknown as "open"), /\battention\b/],
    ["setAttention with a number", () => ep.setAttention(7 as unknown as "open"), /\battention\b/],
    ["setAttention with null", () => ep.setAttention(null as unknown as "open"), /\battention\b/],
    ["setAttention with undefined", () => ep.setAttention(undefined as unknown as "open"), /\battention\b/],
  ];
  for (const [label, run, fieldPattern] of rejectedCalls) {
    let thrown: unknown;
    try {
      await run();
    } catch (err) {
      thrown = err;
    }
    check(
      `${label} throws TypeError naming the field`,
      thrown instanceof TypeError && fieldPattern.test(thrown.message),
      thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : thrown,
    );
  }
  await sleep(300);
  const afterRejected = await read();
  const rosterEntry = reader.getRoster().find((p) => p.card.id === ep.card.id);
  check(
    "rejected setter calls leave local state, the stored KV row and the reader roster intact with zero drops",
    afterRejected?.status === "idle"
      && afterRejected.activity === "reading"
      && afterRejected.condition?.code === "approval"
      && afterRejected.attention === "dnd"
      && afterRejected.statusSince === live?.statusSince
      && afterRejected.activitySince === live?.activitySince
      && reader.presenceBindingDropCount === 0
      && readerWarnings.length === 0
      && writerWarnings.length === 0
      && rosterEntry?.status === "idle"
      && rosterEntry.activity === "reading"
      && rosterEntry.condition?.code === "approval"
      && rosterEntry.attention === "dnd",
    { afterRejected, rosterEntry, drops: reader.presenceBindingDropCount, readerWarnings, writerWarnings },
  );

  await ep.stop(); // graceful → publishes an offline record
  await reader.stop();
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
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
process.exit(0);
