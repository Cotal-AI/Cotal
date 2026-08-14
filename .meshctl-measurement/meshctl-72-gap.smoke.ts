/**
 * §7.2 DRIVE: after a durable membership is CLOSED and later re-opened, is the interval that was
 * missed in between (a) re-established by any named path, or (b) observable and re-fetchable by the
 * caller?
 *
 * WHY THIS DECIDES A SCOPE RULING. Re-target is deferred (§0) because closing an agent's durable
 * Plane-3 memberships is per-channel and non-atomic: a partial close leaves a source mesh silently
 * downgraded to live-only on SOME channels. fm-orchestrator named two conditions, either of which
 * would flip the ruling from DEFER to SHIP-WITH-REPORTED-PARTIAL-STATE:
 *     (1) a named path that RE-ESTABLISHES the missed interval, or
 *     (2) a demonstration that the gap is OBSERVABLE AND RE-FETCHABLE by the caller.
 * This probe is the tombstoned half of that partial close, in isolation: close one channel, post
 * into the gap, re-open it, and ask both questions.
 *
 * WHAT WOULD REFUTE MY OWN POSITION, stated before any result is cited. I committed the split, so
 * the bias runs toward confirming the deferral. Either of these REFUTES it and I report SHIP:
 *   Q1 the gap posts arrive after a durable RE-join (the backstop re-establishes the interval), OR
 *   Q2 the caller can enumerate and re-fetch the gap posts through a path it can call itself.
 * The deferral stands ONLY if both fail.
 *
 * INVERSE CONTROLS — without these, "nothing arrived" and "nothing came back" prove nothing:
 *   C1 the backstop delivers AT ALL: a post to a durable-joined, not-live-subscribed channel
 *      reaches the agent while it is joined.
 *   C2 the tombstone really closed it: a post made after the close is not delivered live.
 *   C3 recall WORKS on this fixture: the same recall call returns a message that was posted while
 *      the membership was open. Without C3, an empty gap recall is equally explained by a broken
 *      recall path, and Q2 would be an artefact.
 *
 * Run: tsx .meshctl-measurement/meshctl-72-gap.smoke.ts   (needs nats-server on PATH; local only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint, isReachable, createSpaceAuth, mintCreds, provisionAgent, mintLifecycleUid,
  serverConfig, newIdentity, setupSpaceStreams, seedChannelRegistry, DEV_OWNER,
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

const space = `meshctl-72-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "meshctl-72-"));
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
  // `review` replays (the default); `audit` does not. ARM C needs a channel where replay is OFF,
  // because that is what BOUNDS the answer: recall is replay-gated, and a partial close on a
  // replay-disabled channel loses the interval with no way back.
  await seedChannelRegistry({
    servers: SERVERS, space, creds: mgrCreds,
    file: { channels: { review: { replay: true }, audit: { replay: false } } },
  });
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
    subscribe: ["general"], allowSubscribe: ["general", "review", "audit"], lifecycleUid: uidA,
  });
  const aPrincipal = `${DEV_OWNER}.${aId.id}`;
  const aclFor = (id: string): string[] | undefined => (id === aPrincipal ? ["general", "review", "audit"] : undefined);

  const dlvId = newIdentity();
  dlv = new CotalEndpoint({
    space, servers: SERVERS, creds: await mintCreds(auth, dlvId, "delivery"),
    card: { id: dlvId.id, name: "delivery", role: "delivery", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: true,
  });
  await dlv.start();
  await dlv.startPlane3(aclFor);

  const got: string[] = [];
  a = new CotalEndpoint({
    space, servers: SERVERS, creds: aCreds,
    card: { id: aId.id, name: "alice", kind: "agent" },
    channels: ["general"], lifecycleUid: uidA, heartbeatMs: 500, ttlMs: 3000,
  });
  a.on("error", () => {});
  a.on("message", (m, d: Delivery, _meta: MessageMeta) => {
    got.push(m.parts.map((p) => (p.kind === "text" ? p.text : "")).join(""));
    d.ack();
  });
  await a.start();
  await wait(400);

  const j1 = await dlv.durableJoinFor(aPrincipal, "review", uidA);
  check("setup: durable membership on 'review' is open", j1.durable === true, j1);

  const ja = await dlv.durableJoinFor(aPrincipal, "audit", uidA);
  check("setup: durable membership on 'audit' (replay OFF) is open", ja.durable === true, ja);

  // ── C1: the backstop delivers at all ─────────────────────────────────────────────────────────
  await poster.multicast("before-close", { channel: "review" });
  check("C1 CONTROL: a durable member not live-subscribed receives a post while OPEN",
    await until(() => got.includes("before-close")), got);

  // ── The close (the tombstoned half of a partial re-target close) ──────────────────────────────
  await dlv.durableLeaveFor(aPrincipal, "review", uidA);
  await dlv.durableLeaveFor(aPrincipal, "audit", uidA);
  await wait(600);
  await poster.multicast("in-the-gap-1", { channel: "review" });
  await poster.multicast("in-the-gap-2", { channel: "review" });
  let auditPosted = false;
  try { await poster.multicast("audit-in-the-gap", { channel: "audit" }); auditPosted = true; } catch { /* recorded */ }
  await wait(1200);
  check("C2 CONTROL: with the membership closed, gap posts are NOT delivered (so a later absence means something)",
    !got.includes("in-the-gap-1") && !got.includes("in-the-gap-2"), got);

  // ── Q1: does a durable RE-join re-establish the missed interval? ──────────────────────────────
  console.log("\n--- Q1: does re-opening the membership replay the gap? ---");
  const j2 = await dlv.durableJoinFor(aPrincipal, "review", uidA);
  check("setup: the membership re-opened", j2.durable === true, j2);
  const q1 = await until(() => got.includes("in-the-gap-1") && got.includes("in-the-gap-2"), 8000);
  check(`Q1 RESULT — the gap ${q1 ? "IS" : "is NOT"} re-established by a durable re-join`, true, { q1, got });

  // ── C3 + Q2: is the gap observable and re-fetchable by the CALLER? ────────────────────────────
  console.log("\n--- Q2: can the caller enumerate and re-fetch the gap itself? ---");
  let recallErr: string | undefined;
  let recalled: string[] = [];
  let dropped: boolean | undefined;
  try {
    const r = await a.recallChannel("review", 0); // sinceSeq 0 = everything the caller may read
    dropped = r.dropped;
    recalled = r.messages.map((m) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join(""));
  } catch (e) {
    recallErr = (e as Error).message;
  }
  check("C3 CONTROL: recall works on this fixture — it returns a message posted while the membership was OPEN",
    recalled.includes("before-close"), { recalled, recallErr, dropped });
  const q2 = recalled.includes("in-the-gap-1") && recalled.includes("in-the-gap-2");
  check(`Q2 RESULT — the gap ${q2 ? "IS" : "is NOT"} re-fetchable by the caller`, true, { q2, recalled, recallErr, dropped });

  // ── Q2b: is it re-fetchable through a path the AGENT actually has? ───────────────────────────
  // `recallChannel(channel, 0)` is the ENDPOINT API. The only tool-reachable route to it is
  // MeshAgent.recallAmbient (agent.ts:710-729), and that is gated three ways — focus mode only,
  // `focusSince` pinned to the frontier at focus ENTRY, and live-joined channels only — so it
  // cannot reach an arbitrary earlier gap. Q2 alone would therefore overclaim. The path an agent
  // DOES have is `cotal_join`, which calls `agent.joinChannel` → `ep.joinChannel` and reports
  // `backfilled` (tool-specs.ts:513-526). Drive that.
  console.log("\n--- Q2b: the path the AGENT actually has — a live join's backfill ---");
  const jr = await a.joinChannel("review");
  const q2b = await until(() => got.includes("in-the-gap-1") && got.includes("in-the-gap-2"), 8000);
  check(`Q2b RESULT — a live join ${q2b ? "DOES" : "does NOT"} backfill the gap to the agent`,
    true, { backfilled: jr.backfilled, joined: jr.joined, got });

  // ── ARM C: the BOUND on Q2 — replay is per-channel, and where it is off the gap is gone ──────
  console.log("\n--- ARM C: the bound — a replay-disabled channel ---");
  let auditRecalled: string[] = [];
  try {
    const r = await a.recallChannel("audit", 0);
    auditRecalled = r.messages.map((m) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join(""));
  } catch { /* recorded as empty */ }
  check("C4 CONTROL: the audit channel really did receive the post (the poster's publish succeeded)",
    auditPosted, { auditPosted });
  const q2c = auditRecalled.includes("audit-in-the-gap");
  check(`ARM C RESULT — on a replay-DISABLED channel the gap is ${q2c ? "still" : "NOT"} re-fetchable`,
    true, { auditRecalled });

  console.log(`\n§7.2 VERDICT: Q1=${q1 ? "SATISFIED" : "failed"}  Q2(endpoint API)=${q2 ? "SATISFIED" : "failed"}  Q2b(agent path)=${q2b ? "SATISFIED" : "failed"}  replay-off=${q2c ? "also re-fetchable" : "NOT re-fetchable"}`);
  console.log(q1 || q2b
    ? `  → SHIP, BOUNDED. fm-orchestrator's condition (2) HOLDS through a path the agent has${q2c ? "" : ", BUT ONLY ON REPLAY-ENABLED CHANNELS"}.`
    : "  → DEFER STANDS. Neither condition holds through a path the caller actually has.");
  console.log(`\n§7.2 GAP PROBE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
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
