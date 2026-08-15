/**
 * Connection-lifecycle smoke: the three failure paths of the self-connect verbs, driven against a
 * real auth broker and asserted AT THE BROKER rather than from the endpoint's own report.
 *
 * SCOPE, stated up front so nothing here overclaims. These are CORE-level cells on
 * `CotalEndpoint.disconnect()` / `.connect()`. The tool path
 * (`extensions/connector-core/smoke/connection-control.smoke.ts`) drives the same two methods
 * through `cotalToolSpecs`, and covers the grant gate and the happy path. It cannot cover THESE
 * faults: a drain that rejects, and a creds-SOURCE endpoint, are states the connector cannot
 * construct (MeshAgent passes static creds bytes). So this suite proves the METHODS behave, and
 * makes no claim that a tool caller can reach arm 3 at all — for arm 3 that claim would be false.
 *
 * ARM INDEPENDENCE, and why this suite has a THIRD outcome. The arms share one broker and its
 * connection counters are global, so a mutation that breaks an early arm used to redden cells in the
 * later ones. Those reds were worthless: a red cell downstream of a broken fixture cannot tell
 * "the mutation broke this arm too" apart from "this arm never had a fair run". Each arm therefore
 * declares a NAMED ENTRY PRECONDITION for the fixture it needs — ARM 1 goes further and BUILDS its
 * own subject rather than inheriting ARM 2's — and if that precondition fails the arm's cells are
 * recorded VOID rather than failed. "Green elsewhere" is this suite's central mutation-adequacy
 * claim, and it is only worth stating when the elsewhere is known to have run on a clean fixture.
 *
 * WHAT EACH ARM MEASURES, AND WHAT WOULD HAVE REFUTED IT — written before any result is cited:
 *
 * ARM 1  A refused `connect()` must leave NOTHING live.
 *        connectAndBind assigns `this.nc` at the handshake and then does fallible KV/JetStream
 *        binds. A throw there used to leave an authenticated connection open with no supervisor,
 *        while the caller was told the connect was refused.
 *        REFUTED IF: the broker still shows a live connection after the refusal.
 *        CONTROL D1-ctl: the broker's CUMULATIVE connection count must RISE across the refusal.
 *        Without it, "no live connection" is equally explained by an auth rejection that never
 *        opened one, and the arm proves nothing.
 *        CONTROL D1c: with JetStream restored, the SAME call succeeds. Arms can differ.
 *
 * ARM 2  A `teardown-failed` refusal must not report a retraction it did not send.
 *        disconnect() announces the departure, then tears down. When the teardown fails it must
 *        put the true state back — and it used to drop the KV handle first, so the re-assert was
 *        a no-op while the text said "the announcement has been retracted".
 *        REFUTED IF: an independent observer still sees the subject OFFLINE after the refusal.
 *        CONTROL D2c: with the fault removed, the same disconnect succeeds and the observer DOES
 *        see offline. Without it, "not offline" is equally explained by an observer that never
 *        sees anything.
 *
 * ARM 3  Credential renewal must not outlive a deliberate disconnect.
 *        The standing-creds arm proves its candidate with an AUTHENTICATED broker preflight, so a
 *        deliberately-off endpoint kept dialling the mesh it had just left.
 *        REFUTED IF: the source is called, or the broker's cumulative connection count rises,
 *        while the endpoint is off.
 *        CONTROL D3c: after connect(), both DO rise again. Without it, a quiet endpoint is
 *        equally explained by a timer that was never armed.
 *
 * ARM 3b THE CROSSING: a renewal already inside its source call when the disconnect lands is past
 *        every timer fence, and the next thing it touches is the preflight. Reproduced by review at
 *        an earlier tip. Held open, disconnected, released.
 *        REFUTED IF: the broker's cumulative count rises after the release.
 *        CONTROL D3k: the same held call released while CONNECTED must still dial. Without it,
 *        "did not dial" is equally explained by a renewal that never fires.
 *
 * D3l    WHAT THE FIX COSTS. The crossing is fixed by DISCARDING the candidate unproven, so the
 *        session keeps its old cached credential with no armed timer until connect(). Does a gap
 *        past that credential's own expiry then leave it dead? Raised by review; driven, not argued.
 *        CONTROL D3m: it must come back by RE-FETCHING, not by presenting the cached credential —
 *        and the premise (that the cached one really was past `exp`) is read off the credential
 *        itself rather than derived from the TTL, because the re-fetch count alone is only a proxy.
 *
 * Run: tsx packages/core/smoke/connection-lifecycle.smoke.ts   (needs `nats-server` on PATH)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint, isReachable, createSpaceAuth, mintCreds, provisionAgent, mintLifecycleUid,
  serverConfig, newIdentity, setupSpaceStreams, credsClaims,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

// ── Safety FIRST, before anything is constructed: never point a smoke at the live broker. ──────
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
const PORT = await pickFreePort();
const MON = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
if (SERVERS.includes("broker.cotal.ai")) throw new Error("REFUSING: live broker");
if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(SERVERS)) throw new Error(`REFUSING: not loopback (${SERVERS})`);
console.log(`[safety] inherited COTAL_* cleared; target=${SERVERS} monitor=127.0.0.1:${MON}`);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 8000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(100); }
  return fn();
};
const awaitExit = (p: ReturnType<typeof spawn>, ms = 4000): Promise<void> =>
  new Promise((res) => {
    if (p.exitCode !== null || p.signalCode !== null) return res();
    p.once("exit", () => res()); setTimeout(res, ms);
  });
let pass = 0, fail = 0, voided = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

/** ── ARM INDEPENDENCE ───────────────────────────────────────────────────────────────────────────
 *  The arms share one broker, and the broker's connection counters are GLOBAL. That once cost this
 *  suite a real claim: under MX2 an early arm's failure left the fixture in a state the later arms
 *  assume away, so cells in ARM 1 and ARM 3 reddened too. Those extra reds proved NOTHING — a red
 *  cell downstream of a broken fixture cannot distinguish "the mutation broke this arm too" from
 *  "this arm never had a fair run". One observation, two worlds, and "green elsewhere" is the
 *  central mutation-adequacy argument this suite exists to make.
 *
 *  So each arm now opens with a NAMED ENTRY PRECONDITION describing the fixture it requires, and
 *  its substantive cells run through `armCheck`. If the precondition fails, the arm's cells are
 *  recorded **VOID — not evaluated**, never as passes and never as failures. VOID is the honest
 *  third outcome: it says the arm was never fairly run, which is exactly what a cascade means. */
const contaminated = new Set<string>();
// Latched like `armCheck`. NOT a bug fix here — each arm carries exactly one precondition today, so
// the second-precondition-on-a-dead-fixture path is currently unreachable in this file. It is closed
// anyway because the sibling suite HAD five preconditions on one arm and the hole was live there,
// and "unreachable" is a property of the current cell list, not of the helper.
const precondition = (arm: string, name: string, cond: boolean, extra?: unknown) => {
  if (contaminated.has(arm)) {
    voided++;
    console.log(`  ⊘ VOID (${arm} contaminated by an earlier precondition — observed, not evidence): ${name}`, extra ?? "");
    return;
  }
  if (cond) { pass++; console.log(`  ✓ PRE-${arm}: ${name}`); }
  else { fail++; contaminated.add(arm); console.log(`  ✗ FAIL PRE-${arm}: ${name}`, extra ?? ""); }
};
const armCheck = (arm: string, name: string, cond: boolean, extra?: unknown) => {
  if (contaminated.has(arm)) { voided++; console.log(`  ⊘ VOID (${arm} fixture contaminated upstream): ${name}`); return; }
  check(name, cond, extra);
};

/** Broker-side truth. `total_connections` is CUMULATIVE (it only ever rises, so it witnesses a
 *  connection that has since been closed); `num_connections` is CURRENT. The pair is what
 *  separates "never opened one" from "opened one and left it open". */
const varz = async (): Promise<{ total: number; current: number }> => {
  const r = await fetch(`http://127.0.0.1:${MON}/varz`);
  const j = (await r.json()) as { total_connections: number; connections: number };
  return { total: j.total_connections, current: j.connections };
};

const space = `conn-life-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-conn-life-"));
const storeDir = join(dir, "js");
const baseConf = serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir });
/** The same broker, same accounts, same port — with or without JetStream, plus a monitoring port.
 *  Dropping the `jetstream { ... }` line is what makes ARM 1 a NATURAL post-dial failure: the
 *  socket and the credential are accepted exactly as before, and only the bind fails. No injection. */
const confFor = (jetstream: boolean): string =>
  `${baseConf.split("\n").filter((l) => jetstream || !l.trim().startsWith("jetstream")).join("\n")}\nhttp: 127.0.0.1:${MON}\n`;

let srv: ReturnType<typeof spawn> | undefined;
const startBroker = async (jetstream: boolean): Promise<void> => {
  writeFileSync(join(dir, "server.conf"), confFor(jetstream));
  srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore", detached: true });
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVERS)) return; await wait(200); }
  throw new Error(`nats-server (jetstream=${jetstream}) did not come up on ${PORT}`);
};
const stopBroker = async (): Promise<void> => {
  if (!srv) return;
  // The wrapper's pid is not necessarily the daemon's — signal the GROUP, then await the exit, or
  // the next spawn races a port still held by a process nobody waited for.
  try { process.kill(-srv.pid!, "SIGKILL"); } catch { try { srv.kill("SIGKILL"); } catch { /* gone */ } }
  await awaitExit(srv);
  srv = undefined;
};

let mgr: CotalEndpoint | undefined, obs: CotalEndpoint | undefined, a: CotalEndpoint | undefined,
    b: CotalEndpoint | undefined, c: CotalEndpoint | undefined, d: CotalEndpoint | undefined;
/** ARM 4's credential and lifecycle uid, minted early — see the note where they are filled in. */
let dCreds: string | undefined, dId: ReturnType<typeof newIdentity> | undefined, uidD: string | undefined;
try {
  await startBroker(true);

  const mgrId = newIdentity();
  const mgrCreds = await mintCreds(auth, mgrId, "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  mgr = new CotalEndpoint({
    space, servers: SERVERS, creds: mgrCreds,
    card: { id: mgrId.id, name: "mgr", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false,
  });
  await mgr.start();

  // The INDEPENDENT observer. It never publishes presence; everything it reports about the subject
  // came off the broker's presence KV, not from the subject's own in-process state.
  obs = new CotalEndpoint({
    space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "operator"),
    card: { name: "observer", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: true,
  });
  await obs.start();
  const seen = (): { status?: string; activity?: string } | undefined => {
    const row = (obs!.getRoster() as any[]).find((p) => (p.name ?? p.card?.name) === "subject");
    return row ? { status: row.status, activity: row.activity } : undefined;
  };

  const aId = newIdentity();
  const uidA = mintLifecycleUid();
  const aCreds = await provisionAgent(mgr, auth, aId, { subscribe: ["general"], allowSubscribe: ["general"], lifecycleUid: uidA });
  a = new CotalEndpoint({
    space, servers: SERVERS, creds: aCreds,
    card: { id: aId.id, name: "subject", kind: "agent" },
    channels: ["general"], lifecycleUid: uidA, heartbeatMs: 400, ttlMs: 3000,
  });
  a.on("error", () => { /* the arms below break this connection on purpose */ });
  await a.start();
  check("setup: the observer sees the subject online", await until(() => seen()?.status !== undefined && seen()!.status !== "offline"), seen());

  // ══ ARM 2 — a teardown-failed refusal must not claim a retraction it never sent ═══════════════
  console.log("\n=== ARM 2: teardown-failed ===");
  // ARM 2 runs FIRST and inherits nothing, so its precondition is the cheapest of the three — but
  // it is stated rather than assumed, because "the first arm cannot be contaminated" stops being
  // true the moment someone reorders the arms.
  precondition("ARM 2", "the subject is connected, not self-disconnected, and visible to the observer",
    (a as any).nc !== undefined && a.isSelfDisconnected() === false && seen()?.status !== undefined,
    { hasNc: (a as any).nc !== undefined, self: a.isSelfDisconnected(), seen: seen() });
  const liveNc = (a as any).nc;
  const realDrain = liveNc.drain.bind(liveNc);
  liveNc.drain = () => Promise.reject(new Error("injected drain failure"));
  const d2 = await a.disconnect("arm2");
  armCheck("ARM 2", "D2a it refuses as THAT refusal — teardown-failed, not a generic error",
    d2.outcome === "refused" && (d2 as any).reason === "teardown-failed", d2);
  armCheck("ARM 2", "D2b the retraction is reported only if it was SENT (a broker revision came back)",
    d2.outcome === "refused" && /HAS been retracted/.test((d2 as any).detail), d2);
  // The cell that matters, and the one that reddens on the defect: the OBSERVER's view.
  await wait(1200);
  armCheck("ARM 2", "D2c the observer does NOT see the subject offline — the announcement really was retracted",
    seen()?.status !== "offline", seen());
  armCheck("ARM 2", "D2d and the endpoint is not stranded in a third state (connection still held, not self-disconnected)",
    (a as any).nc !== undefined && a.isSelfDisconnected() === false,
    { hasNc: (a as any).nc !== undefined, self: a.isSelfDisconnected() });

  console.log("\n--- INVERSE CONTROL: with the fault removed, the same call succeeds ---");
  liveNc.drain = realDrain; // restore on the CAPTURED object: under a mutant that drops the handle
  // early, `this.nc` may be gone, and a harness that crashes there hides the cells after it.
  const d2ok = await a.disconnect("arm2-control");
  armCheck("ARM 2", "D2e CONTROL: the same disconnect now SUCCEEDS (so D2a's refusal was the fault, not the path)",
    d2ok.outcome === "disconnected", d2ok);
  armCheck("ARM 2", "D2f CONTROL: and the observer DOES see offline (so D2c could have failed)",
    await until(() => seen()?.status === "offline"), seen());

  // ── D2g/D2h — COMING BACK MUST NOT LEAVE A GHOST ─────────────────────────────────────────────
  // Raised by evidence review: connect() set `status = "idle"` only AFTER rebuild(), so the
  // presence publish inside connectAndBind announced the agent with the disconnect's `offline`
  // status on the very connection that had just restored it. A best-effort re-assert was the only
  // thing that took it back, its result was discarded, and the caller was told `connected` either
  // way — a live agent showing as departed to every peer, which is the exact ghost this lane exists
  // not to manufacture. The status is now set BEFORE the rebuild, so no window exists to correct.
  // D2f is the inverse control and it has already run: the observer DOES report offline while the
  // agent is genuinely off, so "not offline" here cannot be an observer that never sees anything.
  //
  // ⚠️ D2h IS A REGRESSION GUARD, NOT EVIDENCE FOR THE FIX. Mutation MX5 restored the old ordering
  // AND deleted the correction, and D2h stayed GREEN: this subject heartbeats every 400ms and each
  // heartbeat republishes the current status, so the bad window closes before an 8s poll can see it.
  // Proving that window needs an arm with heartbeats disabled, which does not exist yet. The fix is
  // right on its own terms -- publish the truth rather than publish a lie and race a timer to undo
  // it -- but it is UNPROVEN BY MUTATION and is not claimed otherwise. See MUTATION-LIFECYCLE.md.
  console.log("\n--- D2g/D2h: the agent comes BACK — no ghost may survive it ---");
  const r2back = await a.connect();
  armCheck("ARM 2", "D2g it comes back through the same path", r2back.outcome === "connected", r2back);
  armCheck("ARM 2", "D2h and an INDEPENDENT observer no longer sees it offline — coming back left no ghost",
    await until(() => seen()?.status !== undefined && seen()!.status !== "offline"), seen());

  // ── D2i/D2j — A REFUSAL MUST NOT NAME THE WRONG CONDITION ────────────────────────────────────
  // `reconnect()` never took the `transitionInFlight` latch that `connect()` and `disconnect()` both
  // take. The symptom was not a missing refusal but a WRONG one: a disconnect landing inside
  // reconnect's null window found `this.nc` already gone and refused `not-connected` — naming a
  // condition that was false, on an endpoint that was mid-transition and would be back. That is
  // worse than an unnamed error, because a caller can act on it: "already off, nothing to do" is
  // precisely the wrong conclusion. `transition-in-progress` was already in the vocabulary and was
  // simply unreachable from this path.
  //
  // THE ASSERTION IS THE FLIP, NOT THE VALUE. D2j drives the SAME call to the SAME method and gets
  // `not-connected` — so D2i passing is a discrimination between two reachable reasons, not a method
  // that answers `transition-in-progress` to everything.
  console.log("\n--- D2i/D2j: a disconnect landing inside reconnect's null window ---");
  const reconnecting = a.reconnect().catch(() => { /* settled below; the refusal is what we assert */ });
  const dDuring = await a.disconnect("arm2-during-reconnect");
  armCheck("ARM 2", "D2i a disconnect inside reconnect's window refuses TRANSITION-IN-PROGRESS, not the false 'not-connected'",
    dDuring.outcome === "refused" && (dDuring as any).reason === "transition-in-progress", dDuring);
  await reconnecting;
  const dOff = await a.disconnect("arm2-settle");
  const dAgain = await a.disconnect("arm2-really-off");
  armCheck("ARM 2", "D2j DISCRIMINATION: with no transition in flight and the endpoint genuinely off, the SAME call refuses NOT-CONNECTED",
    dAgain.outcome === "refused" && (dAgain as any).reason === "not-connected", { settle: dOff.outcome, again: dAgain });
  const backOn = await a.connect(); // leave the fixture connected for what follows
  armCheck("ARM 2", "D2k the fixture is restored to connected after the discrimination arm",
    backOn.outcome === "connected", backOn);

  // ══ ARM 1 — a refused connect() must leave nothing live ══════════════════════════════════════
  console.log("\n=== ARM 1: refused connect leaves nothing live ===");
  // ARM 1 BUILDS ITS OWN SUBJECT INSTEAD OF INHERITING ARM 2's.
  // It does need "an endpoint connected earlier and now deliberately off" — a state a fresh
  // environment cannot produce — but it does NOT need ARM 2's endpoint to be the one in that state.
  // Under MX2 that inheritance is precisely what went wrong: ARM 2's control disconnect refused, so
  // ARM 1 began with a live connection where it had assumed none, and its cells reddened for a
  // reason that had nothing to do with the code ARM 1 exists to test.
  // `b` is provisioned, connected and cleanly disconnected HERE, while JetStream is still on and the
  // manager is still alive to provision it.
  const bId = newIdentity();
  const uidB = mintLifecycleUid();
  const bCreds = await provisionAgent(mgr!, auth, bId, { subscribe: ["general"], allowSubscribe: ["general"], lifecycleUid: uidB });
  b = new CotalEndpoint({
    space, servers: SERVERS, creds: bCreds,
    card: { id: bId.id, name: "subject-arm1", kind: "agent" },
    channels: ["general"], lifecycleUid: uidB, heartbeatMs: 400, ttlMs: 3000,
  });
  b.on("error", () => { /* this arm breaks its connection on purpose */ });
  await b.start();
  const dB = await b.disconnect("arm1-setup");

  // ARM 4's credential is minted HERE for the same reason `b`'s is: provisioning needs the manager
  // alive and JetStream on, and ARM 4 runs against a broker with JetStream OFF and every other
  // endpoint retired. Its endpoint is NOT constructed yet — ARM 4 needs an endpoint that has never
  // connected, and constructing it here would only invite a later edit to start it early.
  dId = newIdentity();
  uidD = mintLifecycleUid();
  dCreds = await provisionAgent(mgr!, auth, dId, { subscribe: ["general"], allowSubscribe: ["general"], lifecycleUid: uidD });

  // The broker's connection counters are GLOBAL. Retire every other endpoint so that what they
  // report is attributable to `b` and to nothing else — otherwise the manager and the observer
  // reconnecting after the restart below would both raise the cumulative count (making the control
  // pass for the wrong reason) and hold the current count above zero (making D1b fail for the wrong
  // reason). Their work is done: only ARM 2 needed the observer, and ARM 2 is over.
  await a!.stop(); a = undefined;
  await obs!.stop(); obs = undefined;
  await mgr!.stop(); mgr = undefined;
  await stopBroker();
  await startBroker(false); // same accounts, same port, JetStream OFF — a natural post-dial failure
  let settle = (await varz()).current;
  for (let i = 0; i < 30 && settle !== 0; i++) { await wait(100); settle = (await varz()).current; }
  // THE ENTRY PRECONDITION. Everything ARM 1 assumes, asserted rather than inherited: its own
  // subject really is deliberately off, and the global counters really do speak about it alone.
  // If this fails, ARM 1's cells go VOID — the fixture was wrong before its code ever ran.
  precondition("ARM 1",
    "ARM 1's OWN subject is deliberately off holding no connection, and nothing else is live at the broker",
    dB.outcome === "disconnected" && (b as any).nc === undefined && b.isSelfDisconnected() === true && settle === 0,
    { setupDisconnect: dB.outcome, hasNc: (b as any).nc !== undefined, self: b.isSelfDisconnected(), current: settle });

  const before1 = await varz();
  const r1 = await b.connect();
  armCheck("ARM 1", "D1a it refuses as bind-failed — the broker answered, so 'broker-unreachable' would be a lie",
    r1.outcome === "refused" && (r1 as any).reason === "bind-failed", r1);
  const after1 = await varz();
  armCheck("ARM 1", "D1-ctl CONTROL: the broker's CUMULATIVE count ROSE — it accepted an authenticated connection, so this is a post-dial failure and not an auth rejection",
    after1.total > before1.total, { before: before1, after: after1 });
  let current1 = (await varz()).current;
  for (let i = 0; i < 30 && current1 !== 0; i++) { await wait(100); current1 = (await varz()).current; }
  armCheck("ARM 1", "D1b nothing is left live at the broker after the refusal", current1 === 0, { current: current1 });
  // The in-process half of D1b, and the sharper of the two: the defect kept the connection ON THE
  // ENDPOINT, where disconnect() then refused `not-connected` over a live socket.
  armCheck("ARM 1", "D1c the endpoint holds no connection and is still deliberately off, not in a third state",
    (b as any).nc === undefined && b.isSelfDisconnected() === true,
    { hasNc: (b as any).nc !== undefined, self: b.isSelfDisconnected() });

  console.log("\n--- INVERSE CONTROL: with JetStream restored, the SAME call succeeds ---");
  await stopBroker();
  await startBroker(true);
  const r1ok = await b.connect();
  armCheck("ARM 1", "D1d CONTROL: connect() through the same path SUCCEEDS (so D1a's refusal was the bind, not the verb)",
    r1ok.outcome === "connected", r1ok);
  armCheck("ARM 1", "D1e CONTROL: and the broker now shows a live connection (so D1b could have failed)",
    (await varz()).current > 0, await varz());

  // ══ ARM 3 — credential renewal must not outlive a deliberate disconnect ══════════════════════
  // CORE-LEVEL ONLY. A creds SOURCE is not something the connector can construct, so this proves
  // the endpoint contract and says nothing about what a tool caller can reach.
  console.log("\n=== ARM 3: credential renewal does not outlive a deliberate disconnect (core API only) ===");
  // Same reason as above: the counters must speak about `c` alone. ARM 1 left `b` CONNECTED (D1d),
  // so retiring it here is what makes ARM 3's baseline attributable rather than merely plausible.
  await b!.stop(); b = undefined;
  // AND RESTART THE BROKER — this, not the stop() above, is what actually makes ARM 3 independent.
  // Retiring the endpoint OBJECTS is not enough, and that was measured rather than assumed: under
  // the MX2 mutant an earlier arm left a connection alive at the broker that its endpoint no longer
  // held, and `PRE-ARM 3` caught it as `current: 2`. Every ARM 3 cell is a cumulative-counter delta,
  // so a stray socket that reconnects during the window would be indistinguishable from the renewal
  // dial this arm exists to detect. A restart drops every stray, making ARM 3's baseline a fact
  // about ARM 3 rather than a hope about its predecessors.
  await stopBroker();
  await startBroker(true);
  const TTL = 4; // renewal arms at 75% ⇒ ~3s
  const cid = newIdentity();
  let mints = 0;
  // ARM 3b needs to HOLD a source call open across a disconnect — the crossing that no timer fence
  // can reach, because the call is already past every fence when the disconnect happens.
  let holdNext = false;
  let release: (() => void) | undefined;
  const heldSource = async (): Promise<string> => {
    mints++;
    const cred = await mintCreds(auth, cid, "supervisor", { expiresInSeconds: TTL });
    if (holdNext) {
      holdNext = false;
      await new Promise<void>((r) => { release = r; });
    }
    return cred;
  };
  c = new CotalEndpoint({
    space, servers: SERVERS,
    creds: heldSource,
    card: { id: cid.id, name: "renewer", kind: "endpoint" },
    consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
  });
  c.on("error", () => { /* renewal failures are reported, not thrown */ });
  await c.start();
  // THE ENTRY PRECONDITION for ARM 3. Its endpoint is its own, but the BROKER is still shared, and
  // every cell below is a cumulative-counter delta — so what needs asserting is that `c` is the only
  // thing live at the broker. Without this, "no new connection while it is off" is equally explained
  // by an earlier arm's endpoint having been retired at the right moment.
  const live3 = (await varz()).current;
  precondition("ARM 3",
    "the creds-source endpoint fetched once before its first connect, and it is the ONLY endpoint live at the broker",
    mints === 1 && live3 === 1, { mints, current: live3 });
  const d3 = await c.disconnect("arm3");
  armCheck("ARM 3", "D3a it disconnects cleanly", d3.outcome === "disconnected", d3);
  const mintsAtOff = mints;
  const before3 = await varz();
  await wait(TTL * 1000 + 1500); // well past the 75% arm point
  armCheck("ARM 3", "D3b the credential source is NOT called while the endpoint is deliberately off",
    mints === mintsAtOff, { at: mintsAtOff, now: mints });
  armCheck("ARM 3", "D3c the broker sees NO new connection while it is off — the renewal preflight did not dial",
    (await varz()).total === before3.total, { before: before3.total, after: (await varz()).total });

  console.log("\n--- INVERSE CONTROL: after connect(), renewal really is armed and really does dial ---");
  const before3c = await varz();
  const r3 = await c.connect();
  armCheck("ARM 3", "D3d CONTROL: it comes back", r3.outcome === "connected", r3);
  const mintsAtOn = mints;
  armCheck("ARM 3", "D3e CONTROL: the timer re-armed — the source is called AGAIN without another connect()",
    await until(() => mints > mintsAtOn, TTL * 1000 + 2000), { atOn: mintsAtOn, now: mints });
  // D3f — NAME CORRECTED. It was called an inverse control for D3c ("so D3c could have failed"),
  // and it is not one. `varz().total` has TWO authors here: `connect()` itself and the renewal
  // preflight. `before3c` is sampled BEFORE `c.connect()`, so D3d (outcome === "connected") already
  // implies the dial this cell counts — if D3d passed, D3f CANNOT fail, whatever the renewal timer
  // did. Concretely: a mutant that never re-arms renewal reddens D3e and leaves D3f green.
  // D3c's broker half therefore still has NO inverse control; the honest arm would sample AFTER the
  // connect settles and require a FURTHER rise attributable to the preflight alone. Not written.
  // (D3k is the real inverse of D3h and is unaffected.)
  armCheck("ARM 3", "D3f the broker's cumulative count rose across connect() (NOT an inverse control for D3c — connect() is itself an author of this counter; see comment)",
    (await varz()).total > before3c.total, { before: before3c.total, after: (await varz()).total });

  // ══ ARM 3b — the CROSSING: a source call already in flight when the disconnect lands ══════════
  // Reproduced by review at the previous tip: every earlier fence is already behind this call, and
  // the next thing it touches is the preflight — an authenticated dial from an endpoint that has
  // left the mesh. Clearing the timer cannot reach it; the fence has to sit between the source
  // await and the proof. Discarding is the only correct outcome: prove-before-adopt forbids
  // committing without the broker proof, and being deliberately off forbids taking it.
  console.log("\n=== ARM 3b: a renewal already inside its source call when disconnect lands ===");
  holdNext = true;
  release = undefined;
  const held = await until(() => release !== undefined, TTL * 1000 + 3000);
  check("setup: a renewal is HELD inside its source call (the state a fresh run cannot produce)", held, { mints });
  const d3b = await c.disconnect("arm3b");
  armCheck("ARM 3", "D3g it disconnects while that renewal is mid-flight", d3b.outcome === "disconnected", d3b);
  const before3b = await varz();
  release!(); // the crossing: the held call now returns, past every earlier fence
  await wait(2000);
  armCheck("ARM 3", "D3h the crossed renewal does NOT dial the broker — the candidate is discarded unproven",
    (await varz()).total === before3b.total, { before: before3b.total, after: (await varz()).total });
  armCheck("ARM 3", "D3i and it did not re-arm behind the disconnect", c.isSelfDisconnected() === true, { self: c.isSelfDisconnected() });

  console.log("\n--- INVERSE CONTROL: the same held call, WITHOUT a disconnect, DOES dial ---");
  const r3b = await c.connect();
  armCheck("ARM 3", "D3j CONTROL: it comes back", r3b.outcome === "connected", r3b);
  holdNext = true;
  release = undefined;
  const held2 = await until(() => release !== undefined, TTL * 1000 + 3000);
  check("setup: a second renewal is held, this time with no disconnect", held2, { mints });
  const before3j = await varz();
  release!();
  const dialled = await (async () => {
    for (let i = 0; i < 40; i++) { if ((await varz()).total > before3j.total) return true; await wait(100); }
    return false;
  })();
  armCheck("ARM 3", "D3k CONTROL: released with the endpoint CONNECTED, the renewal DOES reach the broker (so D3h could have failed)",
    dialled, { before: before3j.total, after: (await varz()).total });

  // ── D3l/D3m — does DISCARDING leave anything worse than it fixes? ─────────────────────────────
  // The discard drops a candidate mid-flight, so the session keeps its OLD cached credential and
  // has no armed timer until connect(). If the endpoint then stays off past that credential's own
  // expiry, coming back has to re-fetch or it presents a dead cred. Raised as an open question by
  // review; driven here rather than reasoned about.
  console.log("\n=== D3l: a discarded renewal, then a gap past the cached credential's expiry ===");
  holdNext = true;
  release = undefined;
  const held3 = await until(() => release !== undefined, TTL * 1000 + 3000);
  check("setup: a third renewal is held", held3, { mints });
  const d3c = await c.disconnect("arm3c");
  check("setup: disconnected while it was held", d3c.outcome === "disconnected", d3c);
  release!(); // discarded
  await wait(TTL * 1000 + 1500); // now past the cached credential's own exp
  const mintsBeforeReturn = mints;
  // DIRECT, not inferred: read the cached credential's own `exp` at the moment of the return. The
  // re-fetch count below is a proxy — it says the source was called, not that the cached credential
  // was actually dead — so establish the premise from the credential itself.
  const cachedExpMs = (credsClaims((c as any).currentCreds as string).exp ?? 0) * 1000;
  check("setup: the CACHED credential really is past its own exp at the moment of the return (D3m's premise, measured rather than derived from the TTL)",
    cachedExpMs > 0 && cachedExpMs < Date.now(), { cachedExpMs, now: Date.now() });
  const r3c = await c.connect();
  armCheck("ARM 3", "D3l after a DISCARDED renewal and a gap past the cached credential's expiry, connect() still comes back",
    r3c.outcome === "connected", r3c);
  armCheck("ARM 3", "D3m CONTROL: it came back by RE-FETCHING (the cached credential was treated as stale) — without this, D3l is equally explained by a credential that never expired",
    mints > mintsBeforeReturn, { before: mintsBeforeReturn, after: mints });

  // ══ ARM 4 — a FAILED FIRST START must leave nothing behind ═══════════════════════════════════
  // ARM 1 proves the REBUILD path cleans up after a post-dial failure. This arm proves the FIRST
  // START path does, and until the fix it did not: the cleanup lived only inside `doRebuild()`,
  // while `start()` called `connectAndBind()` directly. One missing arm, two reported defects —
  // a false `already-connected` refusal, and one orphaned authenticated socket per retry.
  //
  // WHAT IS ASSERTED IS THE POSITIVE, AND THAT CHOICE IS THE WHOLE ARM. "start() failed" is true in
  // the leaking state and in the fixed state alike, so it discriminates nothing. What separates them
  // is whether the broker's CURRENT connection count comes back to baseline afterwards — and it is
  // read AT THE BROKER, not at the endpoint. The endpoint is the thing that lost the handle; asking
  // it how many sockets it holds is asking the defect to report itself.
  //
  // REFUTATION CONDITIONS, stated before any result below is cited:
  //  - D4a is REFUTED if current connections stays above baseline after the failed starts.
  //  - D4a is NOT EVIDENCE unless D4-ctl shows the cumulative count ROSE by at least one per
  //    attempt: if the broker never accepted the connections, "back to baseline" is a statement
  //    about a broker that counted nothing, and would be true of any code at all.
  //  - D4c is REFUTED if `connect()` answers `already-connected` for this never-connected session,
  //    and it is NOT EVIDENCE unless D4e shows the same call DOES answer `already-connected` when
  //    the session really is on the mesh.
  console.log("\n=== ARM 4: N failed FIRST starts leave nothing behind ===");
  // Same attributability discipline as ARM 1 and ARM 3: the counters are GLOBAL, so retire the
  // previous arm's endpoint AND restart the broker. A stray socket from ARM 3 would be
  // indistinguishable from a leaked one here, which is the only thing this arm measures.
  await c!.stop(); c = undefined;
  await stopBroker();
  await startBroker(false); // JetStream OFF — the same NATURAL post-dial failure ARM 1 uses, no injection
  let base4 = (await varz()).current;
  for (let i = 0; i < 30 && base4 !== 0; i++) { await wait(100); base4 = (await varz()).current; }
  precondition("ARM 4", "nothing is live at the broker before the first start, so the counts below are about ARM 4 alone",
    base4 === 0, { current: base4 });

  d = new CotalEndpoint({
    space, servers: SERVERS, creds: dCreds!,
    card: { id: dId!.id, name: "subject-arm4", kind: "agent" },
    channels: ["general"], lifecycleUid: uidD!, heartbeatMs: 400, ttlMs: 3000,
  });
  d.on("error", () => { /* this arm fails its connect on purpose */ });

  const FAILED_STARTS = 3;
  const before4 = await varz();
  const threw: string[] = [];
  // The exact call `MeshAgent.connectLoop` repeats: `await this.ep.start()` on the SAME endpoint
  // object, forever, on every failure (extensions/connector-core/src/agent.ts:246-263). Core cannot
  // import the connector, so this reproduces that loop rather than driving it; the connector-level
  // reach is measured separately in the m11 probe, which drives `MeshAgent` itself.
  for (let i = 0; i < FAILED_STARTS; i++) {
    try { await d.start(); threw.push("(no throw)"); }
    catch (e) { threw.push((e as Error).message); }
  }
  precondition("ARM 4", `all ${FAILED_STARTS} starts really did fail (a start that SUCCEEDED would make every cell below meaningless)`,
    threw.length === FAILED_STARTS && threw.every((m) => m !== "(no throw)"), { threw });
  const after4 = await varz();
  armCheck("ARM 4", `D4-ctl CONTROL: the broker's CUMULATIVE count rose by at least ${FAILED_STARTS} — it ACCEPTED an authenticated connection each time, so these are post-dial failures and D4a could have failed`,
    after4.total - before4.total >= FAILED_STARTS, { before: before4.total, after: after4.total, threw });
  let current4 = (await varz()).current;
  for (let i = 0; i < 30 && current4 !== 0; i++) { await wait(100); current4 = (await varz()).current; }
  armCheck("ARM 4", `D4a THE POSITIVE: after ${FAILED_STARTS} failed starts the broker's CURRENT connections is back to baseline — no half-bound socket was orphaned`,
    current4 === base4, { baseline: base4, current: current4, accepted: after4.total - before4.total });
  armCheck("ARM 4", "D4b and the endpoint itself holds no connection — the in-process half of the same fact",
    (d as any).nc === undefined, { hasNc: (d as any).nc !== undefined });

  // The refusal half of the same root: a residual `nc` made `connect()` answer `already-connected`
  // for a session that had never finished connecting. JetStream is still off, so the honest answer
  // is the one that names what actually failed.
  const r4 = await d.connect();
  armCheck("ARM 4", "D4c connect() on a never-connected session does NOT claim `already-connected` — it names the condition that actually failed",
    r4.outcome === "refused" && (r4 as any).reason === "bind-failed", r4);

  console.log("\n--- INVERSE CONTROLS: with JetStream restored, the same call succeeds and the same refusal appears where it IS true ---");
  await stopBroker();
  await startBroker(true);
  const r4ok = await d.connect();
  armCheck("ARM 4", "D4d CONTROL: connect() through the same path SUCCEEDS (so D4c's refusal was the bind, not the verb)",
    r4ok.outcome === "connected", r4ok);
  const r4again = await d.connect();
  armCheck("ARM 4", "D4e CONTROL: a SECOND connect() on the now genuinely-connected session DOES answer `already-connected` (so D4c's arms can differ — it is not that the reason is never produced)",
    r4again.outcome === "refused" && (r4again as any).reason === "already-connected", r4again);
  armCheck("ARM 4", "D4f CONTROL: the broker now shows a live connection (so D4a could have failed)",
    (await varz()).current > 0, await varz());

  // VOID is reported separately and never folded into either column. A voided arm is not a pass
  // (nothing was proven) and not a failure (nothing was disproven) — it is a run that did not
  // happen, and a suite that hides that behind a green total is lying by arithmetic.
  const voidNote = voided ? `, ${voided} VOID — arms: ${[...contaminated].join(", ")}` : "";
  console.log(`\nCONNECTION-LIFECYCLE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed${voidNote})`);
  if (voided) console.log(`  ⊘ ${voided} cell(s) were NOT EVALUATED: their arm's entry precondition failed, so their colour would not have been evidence.`);
  if (fail) process.exitCode = 1;
} catch (e) {
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  for (const ep of [d, c, b, a, obs, mgr]) { try { await ep?.stop(); } catch { /* ignore */ } }
  await stopBroker(); // await the exit BEFORE removing the scratch it is running out of
  rmSync(dir, { recursive: true, force: true });
}
