/** Presence runtime through the real publisher, broker KV and observer event boundary.
 * Run: pnpm smoke:presence-runtime
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { CotalEndpoint, DEV_OWNER, isReachable, mintLifecycleUid, presenceBucket, principalKey, type Presence, type PresenceRuntime } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

let checks = 0;
const check = (condition: unknown, label: string): void => { assert.ok(condition, label); console.log(`PASS ${++checks}: ${label}`); };
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(test: () => boolean | Promise<boolean>): Promise<boolean> {
  for (let n = 0; n < 200; n++) { if (await test()) return true; await sleep(25); }
  return false;
}
const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const space = "runtimewire";
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-p", String(port), "-sd", join(dir, "js")], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir);
const endpoints: CotalEndpoint[] = [];
const children: ChildProcess[] = [];
let nc: Awaited<ReturnType<typeof connect>> | undefined;
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  const ep = new CotalEndpoint({ servers, space, lifecycleUid: mintLifecycleUid(), consume: false, channels: [], heartbeatMs: 100, card: { id: "runtime_main", name: "main", kind: "agent" } });
  endpoints.push(ep);
  ep.on("error", () => {});
  await ep.start();
  nc = await connect({ servers });
  const kv = await new Kvm(nc).open(presenceBucket(space));
  const read = async (actor: string): Promise<Presence> => {
    const entry = await kv.get(principalKey(DEV_OWNER, actor).key);
    assert.ok(entry, "publisher wrote presence to broker");
    return entry.json<Presence>();
  };
  const initial = await read("runtime_main");
  const runtime = initial.runtime;
  check(runtime !== undefined, "actual published record carries runtime");
  check(runtime!.source === "endpoint-process", "runtime source is the closed endpoint-process value");
  check(Object.keys(runtime!).sort().join(",") === "id,source,startedAt", "runtime publishes only id, source and startedAt, no process details");
  check(/^[0-9a-f-]{36}$/.test(runtime!.id), "runtime id is an opaque random UUID");
  check(runtime!.startedAt === Math.floor(performance.timeOrigin), "start dates this connection-holding process, not a status or launch request");
  check(runtime!.startedAt <= initial.ts, "reported start precedes its heartbeat");
  await ep.setStatus("working");
  check(same((await read("runtime_main")).runtime, runtime), "status change preserves runtime id and start");
  await ep.setActivity("runtime smoke activity");
  check(same((await read("runtime_main")).runtime, runtime), "activity change preserves runtime id and start");
  const before = (await read("runtime_main")).ts;
  check(await until(async () => (await read("runtime_main")).ts > before), "real heartbeat advances the wire timestamp");
  check(same((await read("runtime_main")).runtime, runtime), "heartbeat preserves runtime id and start");
  await ep.reconnect();
  check(same((await read("runtime_main")).runtime, runtime), "in-process transport reconnect preserves runtime id and start");
  await ep.stop();
  const offline = await read("runtime_main");
  check(offline.status === "offline" && same(offline.runtime, runtime), "graceful offline record retains runtime without claiming current liveness");

  const late = new CotalEndpoint({ servers, space, lifecycleUid: mintLifecycleUid(), consume: false, channels: [], heartbeatMs: 60_000, card: { id: "runtime_late", name: "late", kind: "agent" } });
  endpoints.push(late);
  late.on("error", () => {});
  await late.start();
  const latePresence = await read("runtime_late");
  check(latePresence.lifecycleUid !== initial.lifecycleUid, "same process publishes two distinct lifecycle scopes");
  check(latePresence.runtime?.id !== runtime!.id, "one runtime id never spans two lifecycle UIDs");
  check(latePresence.runtime?.startedAt === runtime!.startedAt, "a later lifecycle reports the same real process start, not its registration time");
  await late.reconnect();
  check(same((await read("runtime_late")).runtime, latePresence.runtime), "a second lifecycle's in-process reconnect retains its own runtime scope");
  const sameScope = new CotalEndpoint({ servers, space, lifecycleUid: initial.lifecycleUid!, consume: false, channels: [], heartbeatMs: 60_000, card: { id: "runtime_same_scope", name: "same scope", kind: "agent" } });
  endpoints.push(sameScope);
  sameScope.on("error", () => {});
  await sameScope.start();
  check(same((await read("runtime_same_scope")).runtime, runtime), "another endpoint in the same process and lifecycle reuses that scope's observation");

  // Two genuine OS processes publish the same principal and lifecycle, not a simulated clock.
  const childLifecycle = mintLifecycleUid();
  async function childObservation(): Promise<PresenceRuntime> {
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./presence-runtime-child.ts", import.meta.url)), servers, space, childLifecycle], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child publisher readiness timeout")), 10_000);
      child.once("message", () => { clearTimeout(timer); resolve(); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("child publisher exited before readiness")); });
    });
    check(await until(async () => {
      const value = (await kv.get(principalKey(DEV_OWNER, "runtime_child").key))?.json<Presence>();
      return value?.status !== "offline" && value?.runtime !== undefined && value.runtime.id !== runtime!.id;
    }), "new process publishes a live runtime record on the broker");
    const value = await read("runtime_child");
    child.send("stop");
    check(await until(() => child.exitCode !== null || child.signalCode !== null), "child publisher exits after scoped graceful stop");
    assert.ok(value.runtime);
    return value.runtime;
  }
  const firstChild = await childObservation();
  const secondChild = await childObservation();
  check(firstChild.id !== runtime!.id && secondChild.id !== firstChild.id, "a new process gets a new runtime id even under the same lifecycle");
  check(firstChild.startedAt >= runtime!.startedAt && secondChild.startedAt >= firstChild.startedAt, "each child reports its own later process start");

  // Exercise the shipped observer dedup, including quiet equal-value heartbeats and optional-field edges.
  const observer = new CotalEndpoint({ servers, space, registerPresence: false, consume: false, watchChannels: false, card: { id: "runtime_observer", name: "observer", kind: "endpoint" } });
  endpoints.push(observer);
  observer.on("error", () => {});
  await observer.start();
  const key = principalKey(DEV_OWNER, "runtime_peer").key;
  const first: Presence = { card: { id: key, name: "peer", kind: "agent" }, lifecycleUid: mintLifecycleUid(), status: "working", ts: Date.now(), runtime: { id: randomUUID(), startedAt: Math.floor(performance.timeOrigin), source: "endpoint-process" } };
  await kv.put(key, JSON.stringify(first));
  check(await until(() => observer.getRoster().some(p => p.card.id === key)), "observer consumes the initial actual KV record");
  let updates = 0;
  observer.on("presence", event => { if (event.presence.card.id === key) updates++; });
  async function transition(value: Presence, expected: number, label: string): Promise<void> {
    value = { ...value, ts: Date.now() + updates + 1 };
    await kv.put(key, JSON.stringify(value));
    check(await until(() => {
      const held = observer.getRoster().find(p => p.card.id === key);
      return held?.ts === value.ts && same(held.runtime, value.runtime);
    }), `${label}: roster consumes wire value`);
    check(updates === expected, `${label}: presence update count is ${expected}`);
  }
  const changed = { ...first, runtime: { ...first.runtime!, id: randomUUID() } };
  await transition(changed, 1, "runtime-only id change");
  await transition({ ...changed, runtime: { ...changed.runtime } }, 1, "equal runtime values in another object remain a quiet heartbeat");
  const moved = { ...changed, runtime: { ...changed.runtime, startedAt: changed.runtime.startedAt - 1 } };
  await transition(moved, 2, "runtime-only start change");
  const unsupported = { ...moved, runtime: { ...moved.runtime, source: "future-source" } } as unknown as Presence;
  await transition(unsupported, 3, "runtime-only source change is not suppressed");
  const { runtime: _removed, ...absent } = first;
  await transition(absent, 4, "optional runtime removal");
  await transition(first, 5, "optional runtime addition");
  console.log(`presence-runtime smoke: ${checks} checks passed`);
} finally {
  for (const child of children) await killAndAwaitExit(child);
  for (const ep of endpoints.reverse()) await ep.stop().catch(() => {});
  await nc?.close();
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  release();
}
