/**
 * CONSOLE PARTICIPANT smoke: the operator becoming a roster peer on its first send, driven through
 * the console's own pieces (`makeObserver` + `makeParticipant` + `MeshView`) against a real open
 * broker. pnpm --filter @cotal-ai/cli smoke:console-participant (needs nats-server on PATH).
 *
 * What it pins:
 *   A. Before the first send the operator is invisible. The participant peer puts it on the roster
 *      under the observer's own card (the same id the sends carry, kind endpoint, role operator),
 *      and an agent's DM reply shows in the DM lens with both sides of the thread, over the
 *      god-view tap the console already runs; the operator's own DM lands in the feed once.
 *   B. RECONNECT: the broker is killed and restarted on the same port; the peer's heartbeat re-arms
 *      on the fresh connection (a newer presence timestamp lands after the restart) and a DM sent
 *      after it still reaches the operator.
 *   C. LEAVE: stopping the peer publishes an offline record a watcher sees, not a lapsed TTL.
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import { CotalEndpoint, isReachable, setupSpaceStreams, type CotalMessage, type Presence } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { MeshView } from "../src/view/mesh-view.js";
import { makeObserver, makeParticipant } from "../src/console/root.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
/** Poll `probe` until it answers, or the deadline passes; returns the last answer. */
async function until<T>(probe: () => T | undefined, ms: number): Promise<T | undefined> {
  const t0 = Date.now();
  let v = probe();
  while (v === undefined && Date.now() - t0 < ms) { await wait(100); v = probe(); }
  return v;
}
const awaitExit = (p: ChildProcess, ms = 4000): Promise<void> =>
  new Promise((r) => { if (p.exitCode !== null || p.signalCode !== null) return r(); p.once("exit", () => r()); setTimeout(r, ms); });
async function up(servers: string): Promise<void> {
  for (let i = 0; i < 50; i++) { if (await isReachable(servers)) return; await wait(200); }
  throw new Error(`nats-server did not come up at ${servers}`);
}

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const port = await freePort();
const OPEN = `nats://127.0.0.1:${port}`;
const store = join(dir, "js");
const boot = (): ChildProcess => spawn("nats-server", ["-js", "-p", String(port), "-sd", store], { stdio: "ignore" });
let srv = boot();
let release = teardownOnSignal(srv, dir);

const stops: (() => Promise<unknown>)[] = [];
const rosterOf = (ep: CotalEndpoint, name: string): Presence | undefined => ep.getRoster().find((p) => p.card.name === name);

try {
  await up(OPEN);
  console.log("A. open mesh: the first send makes the operator a roster peer agents can reply to");
  const space = `part-${randomUUID().slice(0, 8)}`;
  await setupSpaceStreams({ servers: OPEN, space });
  const alice = new CotalEndpoint({ space, servers: OPEN, card: { name: "alice", kind: "agent", role: "worker" }, channels: ["general"], heartbeatMs: 500, ttlMs: 3000 });
  alice.on("error", () => {});
  alice.on("message", (m: CotalMessage) => {
    if (m.to === alice.card.id) void alice.unicast(m.from.id, "reply:" + m.parts.map((p) => (p.kind === "text" ? p.text : "")).join(""));
  });
  const watcher = new CotalEndpoint({ space, servers: OPEN, card: { name: "watcher", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: true });
  watcher.on("error", () => {});
  await alice.start();
  await watcher.start();
  stops.push(() => alice.stop(), () => watcher.stop());

  // The console's exact observer + model (open mode: no tap narrowing, the god-view).
  const op = makeObserver(space, OPEN, {}, "operator");
  const view = new MeshView(op, {});
  await view.start();
  stops.push(() => view.stop());
  await wait(700);
  check("before any send, the operator is not on the roster", rosterOf(watcher, "operator") === undefined);
  check("before any send, the model shows no presence of its own", !view.snapshot().endpoints.some((p) => p.card.name === "operator"));

  // The console's ensureParticipant: the presence peer first, then the send over the observer.
  const peer = makeParticipant(op, OPEN);
  await peer.start();
  await op.unicast(alice.card.id, "hello");
  const seen = await until(() => rosterOf(watcher, "operator"), 4000);
  check("after the first send the operator is on the roster", seen !== undefined, watcher.getRoster().map((p) => p.card.name));
  check("...as an endpoint with role operator, live", seen?.card.kind === "endpoint" && seen?.card.role === "operator" && seen?.status !== "offline", seen);
  check("...under the observer's own id, so it is the `from` of what the observer sends", seen?.card.id === op.card.id, { presence: seen?.card.id, observer: op.card.id });
  const thread = await until(() => {
    const p = view.snapshot().signals.dms.find((d) => d.name === "operator");
    const conv = p?.conversations.find((c) => c.with === "alice");
    const texts = conv?.messages.map((m) => m.text) ?? [];
    return texts.includes("hello") && texts.includes("reply:hello") ? texts : undefined;
  }, 5000);
  check("alice's DM reply lands in the operator's DM lens, both sides of the thread present", thread !== undefined, view.snapshot().signals.dms);
  check("the model shows the DM lens on an open mesh", view.snapshot().status.dmVisible === true);
  // The unicast burst window (400 ms) has to elapse before a DM reaches the feed; wait for it.
  const helloRows = await until(() => { const n = view.snapshot().feed.filter((e) => e.text === "hello").length; return n > 0 ? n : undefined; }, 3000);
  check("the operator's own DM lands in the feed once (the whole-space tap is the single source)", helloRows === 1, view.snapshot().feed.map((e) => e.text));

  console.log("B. reconnect: the broker restarts, the heartbeat re-arms and the inbox survives");
  const tsBefore = rosterOf(watcher, "operator")?.ts ?? 0;
  srv.kill("SIGTERM");
  await awaitExit(srv);
  release();
  await wait(1500);
  srv = boot();
  release = teardownOnSignal(srv, dir);
  await up(OPEN);
  const fresh = await until(() => {
    const p = rosterOf(watcher, "operator");
    return p && p.ts > tsBefore + 1500 && p.status !== "offline" ? p : undefined;
  }, 20_000);
  check("after the restart a NEWER heartbeat lands (the peer re-armed presence on the fresh connection)", fresh !== undefined, { tsBefore, now: rosterOf(watcher, "operator") });
  await until(() => (alice.getRoster().some((p) => p.card.name === "operator") ? true : undefined), 5000);
  await alice.unicast(op.card.id, "after-restart");
  const late = await until(() => {
    const p = view.snapshot().signals.dms.find((d) => d.name === "operator");
    return p?.conversations.some((c) => c.messages.some((m) => m.text === "after-restart")) ? true : undefined;
  }, 8000);
  check("a DM sent after the restart reaches the operator's inbox (the tap survived the reconnect)", late === true, view.snapshot().signals.dms);

  console.log("C. leave: stopping the peer publishes an offline record");
  await peer.stop();
  const gone = await until(() => { const p = rosterOf(watcher, "operator"); return p?.status === "offline" ? p : undefined; }, 2500);
  check("the watcher sees the operator offline within the heartbeat, not after a TTL lapse", gone !== undefined, rosterOf(watcher, "operator"));
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
} finally {
  for (const s of stops.reverse()) { try { await s(); } catch { /* down */ } }
  srv.kill("SIGKILL");
  await awaitExit(srv);
  release();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "CONSOLE-PARTICIPANT SMOKE OK ✅" : "CONSOLE-PARTICIPANT SMOKE FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
