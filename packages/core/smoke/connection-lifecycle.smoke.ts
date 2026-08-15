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
/** Every cell name that actually reached a verdict, in order — the input to the roll call below. */
const ran: string[] = [];
const check = (name: string, cond: boolean, extra?: unknown) => {
  ran.push(name);
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
/** Cells that were REACHED but NOT EVALUATED. Kept out of `ran` deliberately: this list used to be
 *  folded into it, and the roll call — which asks "did every declared cell reach a verdict?" —
 *  therefore printed `all 55 declared cells reached a verdict` on the same run that printed
 *  `21 VOID`. The name appearing in the log is not the cell being answered; that is the exact
 *  substitution this suite's own mutation harness made when it read a `⊘ VOID` line as a kill. */
const voidedNames: string[] = [];
const armCheck = (arm: string, name: string, cond: boolean, extra?: unknown) => {
  if (contaminated.has(arm)) { voided++; voidedNames.push(name); console.log(`  ⊘ VOID (${arm} fixture contaminated upstream): ${name}`); return; }
  check(name, cond, extra);
};

// ---- CELLS-RUN vs CELLS-DECLARED --------------------------------------------------------------
// A run that dies before a cell is indistinguishable from a cell that failed, by exit code alone —
// both are non-zero, and on a MUTATION arm the vanished cell reads as the catch. So the cells are
// declared by name up front and reconciled in `finally`, where a throw cannot skip the reconcile.
// A cell that never ran is reported as MISSING, which is neither a pass nor a failure but a
// statement that the question was never asked.
const DECLARED = ["D1a", "D1-ctl", "D1b", "D1c", "D1d", "D1e", "D1f", "D1g", "D1-ctl4",
                  "D2-setup", "D2a", "D2b", "D2c", "D2d", "D2e", "D2f", "D2g", "D2h", "D2i", "D2j", "D2k",
                  "D3-setup1", "D3-setup2", "D3-setup3", "D3-setup4", "D3-setup5",
                  "D3a", "D3b", "D3c", "D3d", "D3e", "D3f", "D3g", "D3h", "D3i", "D3j", "D3k", "D3l", "D3m",
                  "D4-ctl", "D4a", "D4b", "D4c", "D4d", "D4e", "D4f",
                  "D5e", "D5a", "D5b", "D5f", "D5-ctl", "D5c", "D5d", "D5-ctl2",
                  "D5g", "D5h", "D5i", "D5j", "D5-ctl3",
                  "D6-ctl", "D6a", "D6b", "D6c", "D6d"];

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
/** ARM 6's credential, minted for the same reason as ARM 4's: provisioning needs the manager alive,
 *  and the manager is retired long before ARM 6 runs. A credential this fixture PROVISIONED is what
 *  makes ARM 6's control meaningful — a refusal from a credential the broker was never going to take
 *  would prove nothing about the classifier. */
let creds6: string | undefined, id6: ReturnType<typeof newIdentity> | undefined, uid6: string | undefined;
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
  check("D2-setup the observer sees the subject online", await until(() => seen()?.status !== undefined && seen()!.status !== "offline"), seen());

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
  // `newIdentity()` takes no arguments — the name/kind ARM 6 needs are carried on the presence card
  // at its connect, not on the identity. Two arguments used to be passed here and were discarded in
  // silence: tsx strips types, so the suite never saw it, and the per-package typecheck covers `src`
  // only, so nothing in the repo's own gate typechecks a smoke file at all (see below).
  id6 = newIdentity();
  uid6 = mintLifecycleUid();
  creds6 = await provisionAgent(mgr!, auth, id6, { subscribe: ["general"], allowSubscribe: ["general"], lifecycleUid: uid6 });

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

  // ── THE SAME FAULT THROUGH THE RECOVERY VERB ────────────────────────────────────────────────
  // `connect()` passes `lastRebuildFailedPostDial` to the classifier (endpoint.ts:1578); `reconnect()`
  // does not (:1391), so the post-dial short-circuit at :390 is unreachable from it and the English
  // substring ladder decides instead. One fault, two verbs, two names — and the wrong one sends an
  // operator to the network when the broker is answering fine.
  //
  // THE PAIRING IS TWO STATES, NOT TWO VERBS ON ONE STATE, AND THE CODE DEMANDS THAT: `reconnect()`
  // refuses `not-connected` at :1372 whenever `selfDisconnected` is set, which is exactly the state
  // D1a runs in. A probe that drove both verbs from D1a's state would never reach the classifier and
  // would be measuring that guard instead. So the subject is CONNECTED here (D1d put it back), and
  // the fault is re-created underneath it rather than the state being reused.
  const beforeRc = await varz();
  await stopBroker();
  await startBroker(false); // same accounts, same port, JetStream OFF — the identical fault as D1a
  const rcErr = await b.reconnect().then(() => undefined, (e: Error) => e);
  armCheck("ARM 1", "D1f the RECOVERY verb names the same condition connect() named for the same fault — bind-failed",
    rcErr !== undefined && (rcErr as any).reason === "bind-failed",
    { threw: rcErr !== undefined, reason: (rcErr as any)?.reason, message: rcErr?.message });
  // The half that makes this a defect and not a naming quibble: the broker itself contradicts
  // `broker-unreachable`. Cumulative, so it witnesses a connection that has since been discarded.
  const afterRc = await varz();
  armCheck("ARM 1", "D1g CONTROL: the broker's CUMULATIVE count ROSE across that failure — it accepted the socket, so this fault is post-dial and 'broker-unreachable' is a claim the broker denies",
    afterRc.total > beforeRc.total, { before: beforeRc, after: afterRc, reason: (rcErr as any)?.reason });

  console.log("\n--- INVERSE CONTROL: with JetStream restored, the SAME reconnect() succeeds ---");
  await stopBroker();
  await startBroker(true);
  // RETRIED, AND THE REASON IS NOT "flaky". A failed `reconnect()` leaves `reestablishLoop()`
  // running (endpoint.ts:1390), so the moment JetStream is back there are TWO dialers racing for
  // the same socket, and a single 2s client dial can lose that race — measured here first time out,
  // as `TimeoutError: timeout` with `reason: broker-unreachable`, which is a scheduling artefact of
  // the control and says nothing about the bind. Retrying the CONTROL is safe in a way that retrying
  // the assertion would not be: it can only ever turn a red into a green for the arm it is meant to
  // enable, and the attempt count is reported so a control that needed twenty tries is visible
  // rather than smoothed away.
  let rcOk: "resolved" | Error = new Error("never attempted");
  let attempts = 0;
  for (; attempts < 15; attempts++) {
    rcOk = await b.reconnect().then(() => "resolved" as const, (e: Error) => e);
    if (rcOk === "resolved") break;
    await wait(500);
  }
  armCheck("ARM 1", "D1-ctl4 CONTROL: reconnect() through the same path SUCCEEDS once JetStream is back (so D1f's refusal was the bind, not an endpoint that could never come back)",
    rcOk === "resolved", { attempts: attempts + 1, last: rcOk });

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
  check("D3-setup1 a renewal is HELD inside its source call (the state a fresh run cannot produce)", held, { mints });
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
  check("D3-setup2 a second renewal is held, this time with no disconnect", held2, { mints });
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
  check("D3-setup3 a third renewal is held", held3, { mints });
  const d3c = await c.disconnect("arm3c");
  check("D3-setup4 disconnected while it was held", d3c.outcome === "disconnected", d3c);
  release!(); // discarded
  await wait(TTL * 1000 + 1500); // now past the cached credential's own exp
  const mintsBeforeReturn = mints;
  // DIRECT, not inferred: read the cached credential's own `exp` at the moment of the return. The
  // re-fetch count below is a proxy — it says the source was called, not that the cached credential
  // was actually dead — so establish the premise from the credential itself.
  const cachedExpMs = (credsClaims((c as any).currentCreds as string).exp ?? 0) * 1000;
  check("D3-setup5 the CACHED credential really is past its own exp at the moment of the return (D3m's premise, measured rather than derived from the TTL)",
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
  // FOUND BY THE MUTANT, and it is the reason the mutation run was worth more than the green one.
  // This cell used to assert only that the second connect answers `already-connected`. Under the
  // mutant it PASSED — because the residual half-bound handle produces that same reason for a
  // session that never connected at all. A cell whose assertion holds in both the safe and the
  // unsafe state is not a control, however it is labelled. So it now carries its own premise: the
  // FIRST connect must have genuinely succeeded, in this cell, rather than being inherited from
  // D4d standing next to it in the log.
  armCheck("ARM 4", "D4e CONTROL: a SECOND connect() on a session that GENUINELY connected does answer `already-connected` (so D4c's arms can differ — it is not that the reason is never produced)",
    r4ok.outcome === "connected" && r4again.outcome === "refused" && (r4again as any).reason === "already-connected",
    { first: r4ok, second: r4again });
  armCheck("ARM 4", "D4f CONTROL: the broker now shows a live connection (so D4a could have failed)",
    (await varz()).current > 0, await varz());

  // ══ ARM 5 — TWO REFUSALS THIS REPO PRODUCES AND NO SUITE NAMED ═══════════════════════════════
  // `in-flight-request` and `transition-unconfirmed` are in the endpoint's vocabulary, are reachable
  // on the disconnect path, and were asserted by nothing anywhere in the tree. A refusal nothing
  // names can be renamed, widened to swallow a neighbouring condition, or replaced by a generic
  // error, and every suite stays green — which is the same defect this arm's neighbours were
  // written to close, one vocabulary entry over.
  console.log("\n=== ARM 5: in-flight-request / transition-unconfirmed ===");
  const e = d; // the ARM 4 subject, genuinely connected — established by D4d/D4e, not assumed here
  precondition("ARM 5", "the subject is connected and not mid-transition, so BOTH arms can differ",
    (e as any).nc !== undefined && (e as any).transitionInFlight !== true && e.isSelfDisconnected() === false,
    { hasNc: (e as any).nc !== undefined, inFlight: (e as any).transitionInFlight, self: e.isSelfDisconnected() });

  // ── D5e/D5a/D5b/D5f — in-flight-request, from a REAL request ─────────────────────────────────
  // THIS ARM USED TO PLANT ITS OWN INPUT. It added a rejector to `pendingRequests` by hand and
  // asserted the refusal — which certified the manufacture: it proved the endpoint refuses when that
  // set is non-empty, and said nothing about whether any real code path ever fills it. A cell whose
  // subject is built by the cell can survive the removal of everything that would populate it.
  //
  // So the input is now produced by the PUBLIC entry point. `requestControl()` is the caller-facing
  // control-plane verb; `pendingRequests.add(reject)` happens SYNCHRONOUSLY inside `requestBounded`
  // before its first await, and `disconnect()`'s inspection is likewise synchronous — no await
  // precedes it — so an un-awaited `requestControl()` followed by `disconnect()` observes the real
  // registration deterministically, in one microtask, with no sleep and no timing race.
  //
  // WHAT IS AND IS NOT REAL HERE, stated rather than blurred: the request is published on the real
  // connection through the real path and is genuinely awaiting a reply, but no responder exists for
  // it in this fixture, so it ends in NoResponders rather than in an answer. At the instant of the
  // disconnect the endpoint's state is exactly the state a real outstanding request produces — that
  // is the claim. RESIDUAL, much smaller than the one it replaces: a request that completes a full
  // round-trip against a live responder is not exercised here.
  const pending: Set<(reason: Error) => void> = (e as any).pendingRequests;
  precondition("ARM 5", "nothing is outstanding before the real request, so D5e's arms can differ",
    pending.size === 0, { size: pending.size });
  // Not awaited on purpose: this is the in-flight window, and it is entered synchronously.
  // The handler is attached in the SAME statement, not at D5f: this request rejects (NoResponders),
  // and a rejection that lands before a handler exists kills the process. Under the unmutated code
  // the refusal returns fast enough that it never did — which is timing, not design, and a mutation
  // run proved it by crashing the suite here instead of reddening the cells it should have.
  const inflight = e.requestControl("delivery", { op: "listMemberships" }, 3000);
  const inflightOutcome = inflight.then(() => "answered" as const, (err: Error) => err);
  armCheck("ARM 5", "D5e a REAL requestControl() registers exactly one pending rejector (the set is filled by the code, not by this cell)",
    pending.size === 1, { size: pending.size });
  const d5 = await e.disconnect("arm5-inflight");
  armCheck("ARM 5", "D5a a disconnect with a reply still outstanding refuses as in-flight-request",
    d5.outcome === "refused" && (d5 as any).reason === "in-flight-request", d5);
  armCheck("ARM 5", "D5b and it says how many, so the caller can tell 'retry shortly' from 'something is wedged'",
    d5.outcome === "refused" && /1 request\(s\)/.test((d5 as any).detail), d5);
  // The refusal left the endpoint UP, so this request settles on its own terms rather than being
  // stranded by a teardown — which is what makes the control below a removal of the CONDITION.
  const inflightSettled = await inflightOutcome;
  armCheck("ARM 5", "D5f once that request settles the set drains itself — the arm's own cleanup did not empty it",
    pending.size === 0, { size: pending.size, settled: String(inflightSettled) });
  // The latch is taken BEFORE the inspection, so the refusal leaves it set. Clearing it here is
  // fixture teardown, not part of the assertion — without it every later cell would answer
  // `transition-in-progress` and the arm would prove only that it had wedged itself.
  (e as any).transitionInFlight = false;
  (e as any).admissionClosed = false;
  const d5ctl = await e.disconnect("arm5-inflight-control");
  armCheck("ARM 5", "D5-ctl CONTROL: with the request settled the SAME call succeeds (so D5a's refusal was the condition, not the path)",
    d5ctl.outcome === "disconnected", d5ctl);

  // ── D5c/D5d — transition-unconfirmed, the QUIET branch ───────────────────────────────────────
  // The branch under test is the QUIET one: the presence write neither throws nor returns a broker
  // revision. A departure that cannot be confirmed must refuse and STAY CONNECTED rather than go
  // dark silently — going dark on an unconfirmed write is precisely how a peer's roster ends up
  // showing a live agent as departed.
  //
  // THE TAG IS NOT THE SITE. `transition-unconfirmed` has TWO producers on this path — the quiet
  // one below and the throwing one at `endpoint.ts:1451` — so a cell that asserts only the tag
  // cannot say which fired, and a mutation to either is gradeable by the other's cell. That is the
  // MX17 defect one refusal over. Each of these arms therefore asserts its own DETAIL text and
  // asserts the other's absent, so the two cannot cover for each other.
  const QUIET = "returned no broker revision";        // endpoint.ts:1463
  const THREW = "could not be confirmed at the broker"; // endpoint.ts:1451
  const backForD5 = await e.connect();
  precondition("ARM 5", "the subject is back on the mesh, so the unconfirmed branch is reachable at all",
    backForD5.outcome === "connected", backForD5);
  const realPublish = (e as any).publishPresence.bind(e);
  (e as any).publishPresence = async () => undefined; // stored-or-not is exactly what is unknown
  const d5u = await e.disconnect("arm5-unconfirmed");
  armCheck("ARM 5", "D5c an unconfirmable departure refuses as transition-unconfirmed FROM THE QUIET BRANCH, not as a success and not from the throwing one",
    d5u.outcome === "refused" && (d5u as any).reason === "transition-unconfirmed"
      && (d5u as any).detail.includes(QUIET) && !(d5u as any).detail.includes(THREW), d5u);
  armCheck("ARM 5", "D5d and it stays CONNECTED rather than going dark on an unconfirmed write",
    (e as any).nc !== undefined && e.isSelfDisconnected() === false,
    { hasNc: (e as any).nc !== undefined, self: e.isSelfDisconnected() });
  (e as any).publishPresence = realPublish;
  (e as any).transitionInFlight = false;
  (e as any).admissionClosed = false;
  const d5uctl = await e.disconnect("arm5-unconfirmed-control");
  armCheck("ARM 5", "D5-ctl2 CONTROL: with the write confirming again the SAME call succeeds (so D5c's arms can differ)",
    d5uctl.outcome === "disconnected", d5uctl);

  // ── D5g–D5j — transition-unconfirmed, the THROWING branch, and the claim it must not make ────
  // `endpoint.ts:1451` was UNREACHED by this suite rather than tested — a distinction only an entry
  // probe or a red cell can draw, and from a green they are identical. D5c reaches the quiet branch
  // by returning undefined; this reaches the throwing one by throwing, which is the difference
  // between "the broker did not confirm" and "the write blew up on the way".
  //
  // AND IT CARRIES A SECOND CLAIM THE TAG CANNOT SEE. That branch re-asserts presence before
  // refusing, and reports whether the re-assertion happened. Its docblock records that it once
  // stated flatly that presence "has been re-asserted" while discarding the result — a refusal
  // claiming a correction it never made, which is worse than one admitting it could not make it.
  // Both wordings are reachable and neither was asserted anywhere, so both run here: a refusal that
  // always claims the good outcome passes a single-arm test perfectly.
  const REASSERTED = "current presence HAS been re-asserted";
  const NOT_REASSERTED = "COULD NOT BE RE-ASSERTED";
  const backForD5g = await e.connect();
  precondition("ARM 5", "the subject is back on the mesh, so the throwing branch is reachable at all",
    backForD5g.outcome === "connected", backForD5g);

  // Arm A — the write throws EVERY time, so the re-assertion fails too.
  (e as any).publishPresence = async () => { throw new Error("presence write blew up"); };
  const d5t = await e.disconnect("arm5-threw");
  armCheck("ARM 5", "D5g a departure write that THROWS refuses as transition-unconfirmed FROM THE THROWING BRANCH, not from the quiet one",
    d5t.outcome === "refused" && (d5t as any).reason === "transition-unconfirmed"
      && (d5t as any).detail.includes(THREW) && !(d5t as any).detail.includes(QUIET), d5t);
  armCheck("ARM 5", "D5h and it stays CONNECTED — a write that threw is not a departure",
    (e as any).nc !== undefined && e.isSelfDisconnected() === false,
    { hasNc: (e as any).nc !== undefined, self: e.isSelfDisconnected() });
  armCheck("ARM 5", "D5i when the re-assertion also fails the refusal SAYS SO, instead of claiming a correction it never made",
    d5t.outcome === "refused" && (d5t as any).detail.includes(NOT_REASSERTED)
      && !(d5t as any).detail.includes(REASSERTED), d5t);

  // Arm B — a TRANSIENT failure: the departure write throws once, the re-assertion then succeeds.
  // This is D5i's paired arm. Without it, "it said COULD NOT" is equally explained by a branch that
  // says COULD NOT unconditionally, and D5i would prove nothing about the reported outcome.
  (e as any).transitionInFlight = false;
  (e as any).admissionClosed = false;
  let throwsLeft = 1;
  (e as any).publishPresence = async (...a: unknown[]) =>
    throwsLeft-- > 0 ? Promise.reject(new Error("presence write blew up once")) : realPublish(...a);
  const d5r = await e.disconnect("arm5-threw-then-recovered");
  armCheck("ARM 5", "D5j and when the re-assertion DOES land the same branch reports that instead (so D5i's text is the condition, not the branch)",
    d5r.outcome === "refused" && (d5r as any).reason === "transition-unconfirmed"
      && (d5r as any).detail.includes(REASSERTED) && !(d5r as any).detail.includes(NOT_REASSERTED),
    { detail: (d5r as any).detail, throwsLeft });

  (e as any).publishPresence = realPublish;
  (e as any).transitionInFlight = false;
  (e as any).admissionClosed = false;
  const d5tctl = await e.disconnect("arm5-threw-control");
  armCheck("ARM 5", "D5-ctl3 CONTROL: with the write no longer throwing the SAME call succeeds (so D5g's arms can differ)",
    d5tctl.outcome === "disconnected", d5tctl);

  // ══ ARM 6 — THE CLASSIFIER'S TWO UNASSERTED OUTPUTS ══════════════════════════════════════════
  // `classifyConnectFailure` turns a dial failure into a named reason, and its own docblock records
  // that text-matching once reported a presence-write failure as `broker-unreachable`. Two of its
  // outputs were asserted nowhere: `credential-source-unavailable` and `broker-unreachable` — and
  // they are the pair the classifier exists to keep apart, because they send an operator to
  // DIFFERENT systems (the launcher vs the broker host). Asserting one without the other would
  // prove nothing about the discrimination, so both run here against the same fixture.
  console.log("\n=== ARM 6: credential-source-unavailable / broker-unreachable ===");
  precondition("ARM 6", "the credential minted for this arm while the manager was alive is present",
    typeof creds6 === "string" && !!id6 && !!uid6, { hasCreds: typeof creds6 === "string" });
  const mk6 = (o: Partial<{ creds: any; servers: string }>) => new CotalEndpoint({
    space, servers: o.servers ?? SERVERS, creds: o.creds ?? creds6!,
    card: { id: id6!.id, name: "subject-arm6", kind: "agent" },
    channels: ["general"], lifecycleUid: uid6!, heartbeatMs: 400, ttlMs: 3000,
  });

  // CONTROL FIRST. Both cells below assert a REFUSAL, so without an arm in which this exact
  // fixture CONNECTS, "refused" is equally explained by a credential the broker was never going to
  // take — and the arm would be measuring its own setup.
  const e6ok = mk6({});
  e6ok.on("error", () => { /* the cells below break this fixture on purpose */ });
  const r6ok = await e6ok.connect();
  armCheck("ARM 6", "D6-ctl CONTROL: this fixture's credential and target DO connect (so both refusals below can differ)",
    r6ok.outcome === "connected", r6ok);
  await e6ok.stop();

  // ── D6a — the credential SOURCE failed, and nothing was dialled ──────────────────────────────
  const e6src = mk6({ creds: async () => { throw new Error("spawn cotal-bearer ENOENT"); } });
  e6src.on("error", () => { /* expected */ });
  const r6src = await e6src.connect();
  armCheck("ARM 6", "D6a a creds SOURCE that will not run refuses as credential-source-unavailable",
    r6src.outcome === "refused" && (r6src as any).reason === "credential-source-unavailable", r6src);
  armCheck("ARM 6", "D6b and NOT as broker-unreachable — the host is fine; sending an operator there is the bug this classifier exists to prevent",
    r6src.outcome === "refused" && (r6src as any).reason !== "broker-unreachable", r6src);
  await e6src.stop();

  // ── D6c — the grant is fine and the target is simply not answering ───────────────────────────
  // A port this run picked and never bound: nothing is listening, and nothing else can be.
  const deadPort = await pickFreePort();
  const e6dead = mk6({ servers: `nats://127.0.0.1:${deadPort}` });
  e6dead.on("error", () => { /* expected */ });
  const r6dead = await e6dead.connect();
  armCheck("ARM 6", "D6c a target that is not answering refuses as broker-unreachable",
    r6dead.outcome === "refused" && (r6dead as any).reason === "broker-unreachable", r6dead);
  armCheck("ARM 6", "D6d and NOT as credential-source-unavailable — the SAME credential connected in D6-ctl, so the source is not the fault",
    r6dead.outcome === "refused" && (r6dead as any).reason !== "credential-source-unavailable", r6dead);
  await e6dead.stop();

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
  // THE ROLL CALL, in `finally` so a throw cannot skip it. Without this a mutation that kills the
  // suite partway looks exactly like a mutation the suite caught: both exit non-zero, and the cells
  // that were supposed to answer simply are not in the log to be missed.
  // Three outcomes per declared cell, and the roll call prints all three INLINE. It used to print a
  // single ✓ whenever nothing was MISSING, which was true and misleading in the same breath: VOID
  // cells were in `ran`, so `all 55 declared cells reached a verdict` appeared directly above
  // `21 VOID — not evaluated`. A summary that has to be read against another line to be true is a
  // defect of the same family as the harness bug that read a VOID line as a kill.
  const hit = (ids: string[], n: string) => ids.some((id) => n === id || n.startsWith(`${id} `));
  const evaluated = DECLARED.filter((id) => ran.some((n) => n === id || n.startsWith(`${id} `)));
  const voidedDeclared = DECLARED.filter((id) => !evaluated.includes(id) && voidedNames.some((n) => n === id || n.startsWith(`${id} `)));
  const missing = DECLARED.filter((id) => !evaluated.includes(id) && !voidedDeclared.includes(id));
  // Drift the other way: a cell that ran under a name no declaration covers is invisible to every
  // count above, so a typo silently shrinks the roll call instead of breaking it.
  const undeclared = [...ran, ...voidedNames].filter((n) => !hit(DECLARED, n));
  console.log(
    `\n  ROLL CALL: ${DECLARED.length} declared — ${evaluated.length} EVALUATED, ` +
    `${voidedDeclared.length} VOID (reached, not evaluated), ${missing.length} NEVER RAN.`,
  );
  if (voidedDeclared.length) console.log(`  ⊘ VOID: ${voidedDeclared.join(", ")}`);
  if (missing.length) {
    console.log(`  ⚠ NEVER RAN — not a pass and not a failure, a question never asked: ${missing.join(", ")}`);
    process.exitCode = 1;
  }
  if (undeclared.length) {
    console.log(`  ⚠ ${undeclared.length} cell(s) ran under an UNDECLARED name (the declaration and the code have drifted): ${undeclared.join(" | ")}`);
    process.exitCode = 1;
  }
  if (!voidedDeclared.length && !missing.length && !undeclared.length)
    console.log(`  ✓ all ${DECLARED.length} declared cells were EVALUATED — none reached-but-void, none absent, none undeclared.`);
  for (const ep of [d, c, b, a, obs, mgr]) { try { await ep?.stop(); } catch { /* ignore */ } }
  await stopBroker(); // await the exit BEFORE removing the scratch it is running out of
  rmSync(dir, { recursive: true, force: true });
}
