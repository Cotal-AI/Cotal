import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { CotalEndpoint, assertPresenceRow, isPresenceRow, isReachable, mintLifecycleUid, presenceBucket, type Presence } from "../src/index.js";
import { awaitBrokerReady, emitSentinel, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";

let passed = 0, failed = 0;
const check = (name: string, ok: boolean) => { if (ok) passed++; else { failed++; console.error(`FAIL: ${name}`); } };
const port = await pickFreePort(), servers = `nats://127.0.0.1:${port}`, space = "presencewriter";
const directory = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", join(directory, "js")], { stdio: "ignore" });
const release = teardownOnSignal(broker, directory);
let writer: CotalEndpoint | undefined, reader: CotalEndpoint | undefined, nc: NatsConnection | undefined;
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  writer = new CotalEndpoint({ space, servers, channels: [], consume: false, watchPresence: false, watchChannels: false,
    heartbeatMs: 60_000, ttlMs: 120_000, card: { id: "writer", name: "writer", kind: "agent" }, lifecycleUid: mintLifecycleUid() });
  reader = new CotalEndpoint({ space, servers, channels: [], consume: false, watchPresence: false, watchChannels: false,
    card: { id: "reader", name: "reader", kind: "endpoint" }, lifecycleUid: mintLifecycleUid() });
  writer.on("error", () => {}); reader.on("error", () => {});
  await writer.start(); await reader.start();
  nc = await connect({ servers });
  const kv = await new Kvm(nc).open(presenceBucket(space)), key = "local.writer";
  const read = async () => { const row = await kv.get(key); assert.ok(row); return { revision: row.revision, value: row.json<Presence>() }; };
  const visible = async () => (await reader!.readPresence()).some((p) => p.card.id === key && p.status !== "offline");
  const restore = async () => { await writer!.setActivity("stable"); await writer!.setStatus("idle"); await writer!.setCondition(null); await writer!.setAttention("open"); };
  await restore();
  check("valid initial writer is visible through the actual roster reader", await visible());

  const cases: Array<{ field: string; call: () => Promise<void> }> = [
    { field: "activity", call: () => writer!.setActivity({ invalid: true } as never) },
    { field: "activity", call: () => writer!.setActivity(null as never) },
    { field: "activity", call: () => writer!.setStatus("working", ["invalid"] as never) },
    { field: "status", call: () => writer!.setStatus("unsupported" as never, "must-not-stick") },
    { field: "status", call: () => writer!.setStatus({ invalid: true } as never) },
    { field: "attention", call: () => writer!.setAttention({ invalid: true } as never) },
    { field: "attention", call: () => writer!.setAttention(7 as never) },
    { field: "condition", call: () => writer!.setCondition("invalid" as never) },
    { field: "condition", call: () => writer!.setCondition([] as never) },
    { field: "condition.code", call: () => writer!.setCondition({ code: {} } as never) },
    { field: "condition.code", call: () => writer!.setCondition({} as never) },
  ];
  for (const [index, item] of cases.entries()) {
    await restore(); const before = await read();
    let error: unknown;
    try { await item.call(); } catch (caught) { error = caught; }
    const after = await read();
    check(`${index}: ${item.field} refuses at the setter with a named TypeError`, error instanceof TypeError && error.message.includes(item.field));
    check(`${index}: invalid input writes no KV revision`, after.revision === before.revision);
    check(`${index}: actual reader still accepts the published row`, isPresenceRow(after.value, key) && await visible());
    // A subsequent unrelated write exposes poisoned local state even if the first publish refused.
    await writer.setChannelModes({});
    const retained = (await read()).value;
    check(`${index}: rejected update leaves local fields unchanged`, retained.activity === before.value.activity && retained.status === before.value.status && retained.attention === before.value.attention && JSON.stringify(retained.condition) === JSON.stringify(before.value.condition));
    check(`${index}: rejected update leaves timestamp state unchanged`, retained.statusSince === before.value.statusSince && retained.activitySince === before.value.activitySince);
  }
  await restore();
  await writer.setStatus("working", "valid update");
  await writer.setCondition({ code: "retrying", message: "bounded fixture", since: Date.now() });
  await writer.setAttention("focus");
  const valid = (await read()).value;
  check("valid updates still reach the wire", valid.status === "working" && valid.activity === "valid update" && valid.condition?.code === "retrying" && valid.attention === "focus");
  check("valid updates remain visible to the actual reader", await visible());
  await writer.setCondition(null);
  check("null condition still clears the wire field", (await read()).value.condition === undefined);
  await writer.stop(); writer = undefined;
  const offline = (await read()).value;
  check("graceful offline scrub stays reader-valid", offline.status === "offline" && offline.attention === undefined && isPresenceRow(offline, key));
  check("all native writer controls ran", passed + failed === 60);
  const row = { card: { id: key, name: "fixture" }, status: "idle", ts: Date.now() };
  for (const [field, invalid] of [
    ["row", null], ["card", { ...row, card: [] }],
    ["card.id", { ...row, card: { ...row.card, id: "foreign" } }],
    ["card.name", { ...row, card: { ...row.card, name: 1 } }],
    ["card.role", { ...row, card: { ...row.card, role: {} } }],
    ["ts", { ...row, ts: Infinity }], ["activity", { ...row, activity: [] }],
    ["attention", { ...row, attention: {} }], ["condition", { ...row, condition: null }],
    ["condition.code", { ...row, condition: { code: 1 } }],
  ] as const) {
    let error: unknown;
    try { assertPresenceRow(invalid, key); } catch (caught) { error = caught; }
    check(`reader and throwing guard agree: ${field}`, !isPresenceRow(invalid, key) && error instanceof TypeError && error.message === `invalid presence ${field}`);
  }
  const future = { ...row, attention: "future-mode", condition: { code: "future-code" } };
  assertPresenceRow(future, key);
  check("shared shape guard retains the reader's forward-compatible strings", isPresenceRow(future, key));
  const disconnected = new CotalEndpoint({ space, servers, channels: [], card: { id: "unstarted", name: "unstarted", kind: "agent" } });
  let preconnectError: unknown;
  try { await disconnected.setActivity({ invalid: true } as never); } catch (caught) { preconnectError = caught; }
  check("setters validate even before a presence bucket is bound", preconnectError instanceof TypeError && preconnectError.message.includes("activity"));
} finally {
  await writer?.stop(); await reader?.stop(); await nc?.close();
  await killAndAwaitExit(broker); rmSync(directory, { recursive: true, force: true }); release();
}
emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
