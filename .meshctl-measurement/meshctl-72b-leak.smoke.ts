/**
 * §7.2 (b) DRIVE: does a durable membership that is never closed keep ACCRUING deliveries for an
 * agent that is never coming back?
 *
 * WHY THIS DECIDES THE REST OF A SCOPE RULING. The §7.2 gap probe (`meshctl-72-gap.smoke.ts`)
 * refuted the deferral's first reason — the agent CAN recover the interval it missed, on
 * replay-enabled channels. fm-orchestrator then narrowed the deferral to its second reason, which
 * no probe on this lane had touched:
 *     "(b) channels that FAIL to close stay open on the abandoned mesh, accruing deliveries for an
 *      agent that is never coming back. This is a leak on the SOURCE, not a gap for the agent, and
 *      no amount of re-joining fixes it because the agent is gone."
 * If (b) is also false, the deferral has no stated reason left. If it holds, it is the whole reason.
 *
 * WHAT WOULD REFUTE (b), STATED BEFORE ANY RESULT IS CITED. I have already refuted this ruling once
 * and the orchestrator asked to be refuted again, so the bias runs the OTHER way now — toward
 * finding a leak. (b) is REFUTED if EITHER:
 *   B1 something closes the membership on its own once the agent is gone (a reaper, a lease expiry,
 *      a presence-TTL eviction), OR
 *   B2 the delivery plane stops writing for an absent member, so nothing accrues.
 * (b) HOLDS only if the membership is still open AND the delivery stream keeps growing for it.
 *
 * INVERSE CONTROLS — without these neither arm means anything:
 *   C1 the backstop works at all: a post reaches the durable member while it is UP.
 *   C2 THE ATTRIBUTION CONTROL, and the one that carries the result: after an explicit durableLeave,
 *      the same posts must NOT grow the delivery stream. Without it, "the stream grew" is equally
 *      explained by "messages were published", which is true whether or not anyone is owed them.
 *
 * Run: tsx .meshctl-measurement/meshctl-72b-leak.smoke.ts   (needs nats-server on PATH; local only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint, isReachable, createSpaceAuth, mintCreds, provisionAgent, mintLifecycleUid,
  serverConfig, newIdentity, setupSpaceStreams, dlvStream, DEV_OWNER,
  type Delivery, type MessageMeta,
} from "../packages/core/src/index.js";
import { pickFreePort } from "../packages/core/smoke/_free-port.js";

for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
if (SERVERS.includes("broker.cotal.ai")) throw new Error("REFUSING: live broker");
if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(SERVERS)) throw new Error(`REFUSING: not loopback (${SERVERS})`);
console.log(`[safety] inherited COTAL_* cleared; target=${SERVERS}`);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 6000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(150); }
  return fn();
};
const awaitExit = (p: ReturnType<typeof spawn>, ms = 4000): Promise<void> =>
  new Promise((res) => {
    if (p.exitCode !== null || p.signalCode !== null) return res();
    p.once("exit", () => res()); setTimeout(res, ms);
  });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const space = `meshctl-72b-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "meshctl-72b-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore", detached: true });

let mgr: CotalEndpoint | undefined, dlv: CotalEndpoint | undefined, poster: CotalEndpoint | undefined, a: CotalEndpoint | undefined;
try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
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

  /** Broker-side truth for "is anything being written for this member": the Plane-3 delivery
   *  stream's own message count, read from the server rather than from any client's belief. */
  const dlvCount = async (): Promise<number> => {
    const info = await (mgr as any).jsm.streams.info(dlvStream(space));
    return info.state.messages as number;
  };
  const memberships = async (): Promise<{ channel: string; generation: number }[]> =>
    ((await (dlv as any).ownerMemberships(aPrincipal, uidA)) ?? []) as { channel: string; generation: number }[];

  const got: string[] = [];
  a = new CotalEndpoint({
    space, servers: SERVERS, creds: aCreds,
    card: { id: aId.id, name: "alice", kind: "agent" },
    channels: ["general"], lifecycleUid: uidA, heartbeatMs: 400, ttlMs: 2000,
  });
  a.on("error", () => {});
  a.on("message", (m, d: Delivery, _meta: MessageMeta) => {
    got.push(m.parts.map((p) => (p.kind === "text" ? p.text : "")).join(""));
    d.ack();
  });
  await a.start();
  await wait(400);

  const j = await dlv.durableJoinFor(aPrincipal, "review", uidA);
  check("setup: durable membership on 'review' is open", j.durable === true, j);

  // ── C1: the backstop works at all ────────────────────────────────────────────────────────────
  await poster.multicast("while-up", { channel: "review" });
  check("C1 CONTROL: a durable member not live-subscribed receives a post while UP",
    await until(() => got.includes("while-up")), got);

  // ── THE ABANDONMENT: the agent goes and never comes back ─────────────────────────────────────
  console.log("\n--- the agent is abandoned: stopped, never returns, presence TTL allowed to expire ---");
  await a.stop(); a = undefined;
  await wait(3500); // > ttlMs (2000) + heartbeat, so presence has lapsed at the broker

  // ── B1: does anything close it on its own? ───────────────────────────────────────────────────
  const openAfter = await memberships();
  check(`B1 RESULT — after the agent is gone and its presence has lapsed, the membership is ${openAfter.some((m) => m.channel === "review") ? "STILL OPEN" : "CLOSED by something"}`,
    true, openAfter);
  const stillOpen = openAfter.some((m) => m.channel === "review");

  // ── B2: does the delivery plane keep writing for it? ─────────────────────────────────────────
  const K = 5;
  const before = await dlvCount();
  for (let i = 0; i < K; i++) await poster.multicast(`abandoned-${i}`, { channel: "review" });
  await wait(1500);
  const afterAbandoned = await dlvCount();
  const grewWhileOpen = afterAbandoned - before;
  check(`B2 RESULT — with the membership open and the agent gone, the delivery stream grew by ${grewWhileOpen} for ${K} posts`,
    true, { before, after: afterAbandoned });

  // ── C2: THE ATTRIBUTION CONTROL ──────────────────────────────────────────────────────────────
  console.log("\n--- INVERSE CONTROL C2: close it, post the same again, and see whether it still grows ---");
  await dlv.durableLeaveFor(aPrincipal, "review", uidA);
  await wait(800);
  const beforeClosed = await dlvCount();
  for (let i = 0; i < K; i++) await poster.multicast(`after-close-${i}`, { channel: "review" });
  await wait(1500);
  const afterClosed = await dlvCount();
  const grewWhileClosed = afterClosed - beforeClosed;
  check("C2 CONTROL: with the membership CLOSED the same posts do NOT grow the delivery stream (so B2's growth is attributable to the open membership, not to publishing)",
    grewWhileClosed < grewWhileOpen, { grewWhileOpen, grewWhileClosed });

  const leaks = stillOpen && grewWhileOpen > 0 && grewWhileClosed < grewWhileOpen;
  console.log(`\n§7.2(b) VERDICT: membership ${stillOpen ? "stays OPEN" : "is CLOSED"} · grew ${grewWhileOpen} while open vs ${grewWhileClosed} while closed`);
  console.log(leaks
    ? "  → (b) HOLDS. An abandoned membership stays open and the delivery plane keeps writing for an agent that is never coming back.\n    The deferral's surviving reason is real."
    : "  → (b) REFUTED. The deferral has no stated reason left; report SHIP and say so.");

  console.log(`\n§7.2(b) LEAK PROBE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  for (const ep of [a, poster, dlv, mgr]) { try { await ep?.stop(); } catch { /* ignore */ } }
  try { process.kill(-srv.pid!, "SIGKILL"); } catch { try { srv.kill("SIGKILL"); } catch { /* gone */ } }
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}
