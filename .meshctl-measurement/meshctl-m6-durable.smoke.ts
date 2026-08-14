/**
 * M6 drive: DOES A SELF-DISCONNECT CLOSE A DURABLE (Plane-3) MEMBERSHIP?
 *
 * The declared gap in the design note. `durableLeaveChannel` has exactly two call sites —
 * `leaveChannel` (endpoint.ts:1613) and `closeRefusedMembership` (:3064). `stop()` (:1123-1153)
 * calls neither. So the READ says a disconnect leaves the membership open. This drives it.
 *
 * Why it matters: for disconnect→reconnect, keeping the membership is CORRECT — replaying what you
 * missed is the entire point of the backstop. For a RE-TARGET, it is a leak: the old mesh keeps
 * accumulating deliveries for an agent that is never coming back, and the "disconnect" is a lie at
 * the delivery plane while looking clean at the presence plane.
 *
 * REFUTATION CONDITION, stated before any result is cited:
 *   "A disconnect leaves the durable membership OPEN" is REFUTED if the post made while the agent
 *   was down does NOT replay when it returns. It is CONFIRMED if that post arrives on return.
 * INVERSE CONTROLS — both required, or the arms cannot differ:
 *   C1 the backstop delivers at all: a post to a durable-joined-but-not-live-subscribed channel
 *      reaches the agent while it is UP. Without this, a non-delivery later proves nothing.
 *   C2 the tombstone path works: after an explicit durableLeave, a later post is NOT delivered.
 *      Without this, a delivery in the disconnect arm could just mean "leave never works".
 *
 * Run: tsx packages/core/meshctl-m6-durable.smoke.ts   (needs nats-server on PATH; local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint, isReachable, createSpaceAuth, mintCreds, provisionAgent, mintLifecycleUid,
  serverConfig, newIdentity, setupSpaceStreams, DEV_OWNER,
  type Delivery, type MessageMeta,
} from "./src/index.js";
import { pickFreePort } from "./smoke/_free-port.js";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
if (SERVERS.includes("broker.cotal.ai")) throw new Error("REFUSING: live broker");
if (!/^nats:\/\/127\.0\.0\.1:/.test(SERVERS)) throw new Error("REFUSING: not loopback");
console.log(`[safety] target=${SERVERS} — asserted not broker.cotal.ai, loopback only`);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 6000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(150); }
  return fn();
};
const awaitExit = (p: ReturnType<typeof spawn>, ms = 3000): Promise<void> =>
  new Promise((res) => {
    if (p.exitCode !== null || p.signalCode !== null) return res();
    p.once("exit", () => res()); setTimeout(res, ms);
  });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const space = `meshctl-dur-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "meshctl-m6-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

let mgr: CotalEndpoint | undefined, dlv: CotalEndpoint | undefined,
    poster: CotalEndpoint | undefined, a1: CotalEndpoint | undefined, a2: CotalEndpoint | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

  const mgrId = newIdentity();
  const mgrCreds = await mintCreds(auth, mgrId, "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  mgr = new CotalEndpoint({
    space, servers: SERVERS, creds: mgrCreds,
    card: { id: mgrId.id, name: "mgr", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false,
  });
  await mgr.start();

  poster = new CotalEndpoint({
    space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "operator"),
    card: { name: "poster", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false,
  });
  await poster.start();

  const aId = newIdentity();
  const uidA = mintLifecycleUid();
  const aCreds = await provisionAgent(mgr, auth, aId, {
    subscribe: ["general"], allowSubscribe: ["general", "review"], lifecycleUid: uidA,
  });
  const aPrincipal = `${DEV_OWNER}.${aId.id}`;
  const aclFor = (id: string): string[] | undefined => (id === aPrincipal ? ["general", "review"] : undefined);

  const dlvId = newIdentity();
  dlv = new CotalEndpoint({
    space, servers: SERVERS, creds: await mintCreds(auth, dlvId, "delivery"),
    card: { id: dlvId.id, name: "delivery", role: "delivery", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: true,
  });
  await dlv.start();
  await dlv.startPlane3(aclFor);

  // ---- agent A, incarnation 1: live on "general" only ----------------------------------------
  const got1: string[] = [];
  a1 = new CotalEndpoint({
    space, servers: SERVERS, creds: aCreds,
    card: { id: aId.id, name: "alice", kind: "agent" },
    channels: ["general"], lifecycleUid: uidA, heartbeatMs: 500, ttlMs: 2000,
  });
  a1.on("error", () => {});
  a1.on("message", (m, d: Delivery, _meta: MessageMeta) => {
    got1.push(m.parts.map((p) => (p.kind === "text" ? p.text : "")).join(""));
    d.ack();
  });
  await a1.start();
  await wait(300);

  const j = await dlv.durableJoinFor(aPrincipal, "review", uidA);
  check("setup: durableJoinFor('review') committed", j.durable === true, j);

  // ---- C1: the backstop delivers at all -------------------------------------------------------
  console.log("\n--- INVERSE CONTROL C1: backstop delivers while the agent is UP ---");
  await poster.multicast("while-up", { channel: "review" });
  check("C1: a durable member not live-subscribed receives the post while UP",
    await until(() => got1.includes("while-up")), got1);

  // ---- THE MEASUREMENT: disconnect (stop), post, return ---------------------------------------
  console.log("\n--- MEASUREMENT: post while the agent is DISCONNECTED, then bring it back ---");
  await a1.stop(); // a DISCONNECT — not leaveChannel, not durableLeave
  a1 = undefined;
  await wait(600);
  await poster.multicast("while-disconnected", { channel: "review" });
  await wait(600);

  const got2: string[] = [];
  a2 = new CotalEndpoint({
    space, servers: SERVERS, creds: aCreds,
    card: { id: aId.id, name: "alice", kind: "agent" },
    channels: ["general"], lifecycleUid: uidA, heartbeatMs: 500, ttlMs: 2000,
  });
  a2.on("error", () => {});
  a2.on("message", (m, d: Delivery, _meta: MessageMeta) => {
    got2.push(m.parts.map((p) => (p.kind === "text" ? p.text : "")).join(""));
    d.ack();
  });
  await a2.start();
  const replayed = await until(() => got2.includes("while-disconnected"), 8000);
  check("MEASUREMENT: the post made while DISCONNECTED replays on return — the durable membership SURVIVED the disconnect",
    replayed, got2);

  // ---- C2: the tombstone path works ------------------------------------------------------------
  console.log("\n--- INVERSE CONTROL C2: an explicit durableLeave DOES close it ---");
  await dlv.durableLeaveFor(aPrincipal, "review", uidA);
  await wait(500);
  await poster.multicast("after-explicit-leave", { channel: "review" });
  const afterLeave = await until(() => got2.includes("after-explicit-leave"), 4000);
  check("C2: a post AFTER an explicit durableLeave is NOT delivered (so C1/measurement deliveries mean something)",
    !afterLeave, got2);

  console.log(`\nVERDICT: ${replayed && !afterLeave
    ? "CONFIRMED — a self-disconnect leaves the durable membership OPEN; only an explicit leave closes it.\n  For disconnect→reconnect this is CORRECT (replay is the backstop's purpose).\n  For RE-TARGET it is a LEAK: the old mesh keeps accumulating for an agent that will never return."
    : "see failures above"}`);

  console.log(`\nM6 DURABLE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  for (const ep of [a1, a2, poster, dlv, mgr]) { try { await ep?.stop(); } catch { /* ignore */ } }
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  console.log("[cleanup] broker exited, scratch removed");
}
