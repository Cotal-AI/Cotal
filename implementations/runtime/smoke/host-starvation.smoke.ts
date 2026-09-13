/**
 * A starved host reports ITSELF, and does not kill the run for it (#1508).
 *
 * THE INCIDENT. `run-45bc480e6b8d87988ce4e482d9c1c233` executed `sleep("4m")` and journalled
 * `#5 /sleep#0 failed (L4000)` at load1 118.26. The identical program with the identical sleep,
 * `run-22c6020359ef685feed66fd52ff74afb`, journalled `#5 /sleep#0 ok` at load1 9.08. Nothing in the
 * program changed. What changed was the host.
 *
 * THE MECHANISM, measured on this tree before the repair and re-measured by cell 0 below: a pause's
 * plane reads ride a NATS API request whose client-side deadline is a `setTimeout`. A process that
 * does not return to its event loop cannot run that timer either, so it fires late and rejects with
 * the client's bare `timeout` — with the broker healthy, having answered, the reply unread in the
 * socket. `perform.ts` flattens a thrown non-`EffectError` into `{ code: "L4000",
 * kind: "handler-fault" }`, and the run dies blaming the effect.
 *
 * WHAT THIS SUITE IS FOR, and the shape is deliberately a PAIR:
 *
 *   - the STARVED cell: the loop is genuinely blocked across the wait, and the sleep must COMPLETE.
 *   - the GENUINE cell: a real host fault under the same wait, which must still fail as `L4000`.
 *
 * Either one alone is satisfiable by a band-aid. A fix that swallows every timeout passes the first
 * and fails the second; a fix that changes nothing passes the second and fails the first.
 *
 * THE WITNESS IS NOT A NO-OP. @mgr-i1411 found a cell on another lane whose action early-returned
 * on a flag its own fixture set, so it would have gone green against a system that did nothing at
 * all. The witness here is the resolution of the `sleep` promise itself under a loop that was
 * measurably blocked: the cell fails if the sleep rejects, AND fails if the block it depends on did
 * not actually happen (cell 1a grades the starvation itself, against the same observer the
 * implementation reads). A sleep cannot resolve without the plane having been read.
 *
 * Run: pnpm smoke:runtime-host-starvation   (needs nats-server on PATH)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable,
  createEndpointStreams,
  openRecordsBucket,
  timerWriterContext,
  timerWriterConsumerConfig,
  timerWriterDurable,
  armCheckpointTimer,
  readCheckpointSettle,
  readCheckpointStatus,
  eptReqStreamName,
} from "@cotal-ai/core";
import { EffectError } from "@cotal-ai/lang";
import { MeshHandler, EpfSettleWatcher } from "../src/index.js";
import {
  classifyPauseFailure,
  isDeadlineShaped,
  wasStarved,
  loopLagObserver,
  servedDespiteStarvation,
  STARVED_ATTEMPTS,
  type LoopLagObserver,
  type LoopLagWindow,
} from "../src/host-starvation.js";
import { pickFreePort } from "./_free-port.js";

const SPACE = "meshstarve";
const EP = "manager";
const IID = "s".repeat(26);
const EPOCH = 2;
const HOLDER = { id: "manager", lifecycleUid: "u_meshstarve" };
const CALLER = { owner: "local", actor: "wf_meshsuite", uid: "b".repeat(26) };

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A cell whose claim is "this ENDS" must fail as a RED, not as a suite that stops. */
const withDeadline = async <T>(p: Promise<T>, ms: number, what: string): Promise<T | undefined> => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), ms); });
  try {
    const got = await Promise.race([p.then((v) => ({ v })), late]);
    if (got === undefined) { fail++; console.log(`  ✗ FAIL: ${what} did not end within ${ms}ms`); return undefined; }
    return got.v;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** Block the event loop for real: a synchronous spin, which is what a host under load does to this
 *  process from the outside. Nothing here is simulated — the timers genuinely cannot run. */
const starveLoop = (ms: number): void => {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* the starvation */ }
};

/**
 * Starve the loop ACROSS a window, in rounds, and the shape is the difference between a cell that
 * proves something and a cell that is merely lucky.
 *
 * A spin only produces a client-side timeout if a request was ALREADY IN FLIGHT when the spin
 * began — the deadline it blocks is that request's own. MEASURED, twice: a single 11s spin, and
 * then rounds separated by a 20ms yield, both completed the sleep with ZERO starvations absorbed,
 * because in each gap the overdue poll timers fired, issued their requests, AND the local broker's
 * replies landed before the next spin. The cell was green with nothing starved. That is why the
 * witness in cell 1 exists.
 *
 * The repair is WHERE the spin runs. Node's loop is phases in order: timers, then poll (where a
 * socket reply is read), then check (`setImmediate`). Spinning from a `setImmediate` scheduled
 * before the yield puts the block in the CHECK phase of the same turn whose TIMERS phase issued the
 * poll requests — after they are on the wire, before their replies can be processed. The spin then
 * outlasts the client's 5s deadline with the request genuinely pending, which is the incident.
 */
const starveInCheckPhase = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(() => {
      starveLoop(ms);
      resolve();
    });
  });

const starveAcross = async (rounds: number, spinMs = 6_000): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    // One macrotask first, so the overdue timers this process owes get to run and issue their
    // reads; the check-phase spin then lands on top of those reads while they are unanswered.
    await new Promise((r) => setTimeout(r, 1));
    await starveInCheckPhase(spinMs);
  }
};

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-meshstarve-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const done = () => {
  try { broker.kill("SIGKILL"); } catch { /* already gone */ }
  rmSync(sd, { recursive: true, force: true });
};
process.on("exit", done);

let up = false;
for (let i = 0; i < 60 && !up; i += 1) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
const js = jetstream(nc);
const jsm = await jetstreamManager(nc);
await createEndpointStreams(jsm, new Kvm(nc), SPACE);
const kv = await openRecordsBucket(nc, SPACE);

// The mediated timer writer as its own loop, exactly as the other mesh suites drive it: the handler
// publishes `.schedule` REQUESTS and arms nothing itself, so a suite that never arms is a suite
// where no deadline ever passes.
await jsm.consumers.add(eptReqStreamName(SPACE), timerWriterConsumerConfig(SPACE, { ackWaitMs: 5_000 }));
const writerC = await js.consumers.get(eptReqStreamName(SPACE), timerWriterDurable(SPACE));
const wctx = await timerWriterContext(nc, SPACE);
const armPending = async (expect: number): Promise<number> => {
  let armed = 0;
  for await (const m of await writerC.fetch({ max_messages: expect, expires: 1_000 })) {
    const r = await armCheckpointTimer(wctx, { subject: m.subject, headers: m.headers, data: m.data });
    if (r.armed) armed += 1;
    m.ack();
  }
  return armed;
};

const ctxOf = (requestId: string) => ({
  requestId,
  attempt: 0,
  signal: { cancelled: false, reason: undefined as string | undefined, onCancel: () => { /* never */ } },
}) as never;

const handlerWith = (lag?: LoopLagObserver, clock: () => number = () => Date.now(), onStarved?: (note: string) => void) =>
  new MeshHandler(
    nc, kv, js, jsm,
    { space: SPACE, endpoint: EP, runId: "r-starve", caller: CALLER, instanceId: IID, epoch: EPOCH, holder: HOLDER, defaultCheckpointTimeout: "1h" },
    new EpfSettleWatcher(jsm, SPACE, 1_000),
    clock,
    undefined,
    lag,
    onStarved,
  );

// ── 0) the mechanism, stated as a measurement rather than as a claim ──────────────────────────
//
// Not decoration: every cell below is about a distinction that only exists if the client's deadline
// really does elapse on a blocked loop while the broker is healthy. If this ever stops reproducing,
// the rest of the suite is grading a defect that is no longer there, and it should say so here.
{
  const ref = { endpoint: EP, token: "c3RhcnZlX21lY2hhbmlzbV8wMDAwMQ" };
  const t0 = Date.now();
  const healthy = await readCheckpointSettle(jsm, SPACE, ref).then(() => "served", (e: Error) => `${e.name}: ${e.message}`);
  c("a plane read on a HEALTHY loop is served promptly", healthy === "served" && Date.now() - t0 < 3_000, `${healthy} in ${Date.now() - t0}ms`);

  const inFlight = readCheckpointSettle(jsm, SPACE, ref).then(() => "served", (e: Error) => e);
  starveLoop(9_000);
  const starved = await inFlight;
  c("the SAME read, with only this process's loop blocked, rejects with the client's bare deadline",
    starved instanceof Error && starved.name === "TimeoutError" && starved.message === "timeout",
    starved instanceof Error ? `${starved.name}: ${starved.message}` : starved);
  const after = await readCheckpointSettle(jsm, SPACE, ref).then(() => "healthy", (e: Error) => `broken: ${e.message}`);
  c("and the broker was healthy on the other side of it: nothing about the plane failed", after === "healthy", after);
  console.log("• 0 — the mechanism reproduces: a blocked loop, not a broken plane");
}

// ── 1) THE DEFECT CELL: a sleep whose deadline passes while the loop is blocked COMPLETES ────
//
// The pre-fix control for this cell is the whole point (see mutations/host-starvation.json, and the
// PRE-FIX measurement recorded in the PR): against the tree before the repair this cell is RED,
// because the starved read's `timeout` escapes `settle` and the effect rejects.
{
  console.log("• 1 — a starved sleep completes late rather than failing");
  const TOKEN = "c3RhcnZlX3NsZWVwX3Rva2VuXzAwMDE";
  // THE WITNESS, and it is the whole difference between this cell and a vacuous one. "The sleep
  // completed" is ALSO true of a sleep that was never starved, so a cell asserting only that would
  // go green on a run where the loop was never blocked, and green against a tree with no repair in
  // it at all. An absorbed starvation is a thing that HAPPENED, so the cell requires the evidence
  // of it: a notice the wrapper emits only on the path that re-enters a starved operation. The
  // pre-fix tree cannot produce that notice, because the code that emits it is the code being
  // removed.
  const absorbed: string[] = [];
  const handler = handlerWith(undefined, undefined, (note) => absorbed.push(note));
  const sleeping = handler.sleep({ duration: "3s" }, ctxOf(TOKEN)).then(() => "ok" as const, (e: Error) => e);
  await wait(400);
  const st = await readCheckpointStatus(kv, { endpoint: EP, token: TOKEN });
  c("the pause is durable before the starvation begins", st?.value.state === "waiting", st?.value.state);
  const armed = await armPending(4);
  c("and its timer is really armed on the broker, so the deadline will pass for real", armed === 1, armed);

  // THE STARVATION, straddling the deadline: the sleep's own 3s expires inside it, and the plane
  // reads that would have observed it cannot run. Four rounds, for the reason `starveAcross`
  // documents: one spin catches only a read that was already in flight, which is a race.
  await starveAcross(4);

  const out = await withDeadline(sleeping, 60_000, "the starved sleep");
  c("the sleep COMPLETES: a lower-bound wait that was late is not a failed wait",
    out === "ok", out instanceof Error ? `${(out as EffectError).code ?? out.name}: ${out.message}` : out);
  c("and it did NOT fail as L4000, which is the misattribution #1508 is about",
    !(out instanceof EffectError && out.code === "L4000"), out instanceof Error ? out.message : "(completed)");
  const settle = await readCheckpointSettle(jsm, SPACE, { endpoint: EP, token: TOKEN });
  c("the pause really did settle on the plane: the sleep read a fact, it did not skip the wait",
    settle?.settle === "expired", settle?.settle);
  // THE WITNESS. Asserted AFTER the completion cells, so a failure here reads as "it completed but
  // nothing was absorbed" rather than masking the completion result.
  c("and a starvation was actually ABSORBED on the way: the completion is the repair's, not luck",
    absorbed.length > 0, `${absorbed.length} notices`);
  c("the notice names the measurement rather than asserting the conclusion",
    absorbed.some((n) => /event-loop lag \d+ms of a \d+ms window, \d+ of \d+ scheduled ticks/.test(n)),
    absorbed[0]?.slice(0, 200) ?? "(none)");
}

// ── 1a) the starvation the cell above depends on was REAL, measured by the same observer ─────
//
// Without this, cell 1 would go green on a host that was never blocked at all — the exact vacuity
// class @mgr-i1411 reported on #1517. It reads the observer the implementation reads.
{
  const lag = loopLagObserver(50);
  const mark = lag.mark();
  starveLoop(2_000);
  await wait(60);
  const w = lag.since(mark);
  lag.stop();
  c("a synchronous block is visible to the observer as lag across the window", w.lagMs >= 1_000, JSON.stringify(w));
  c("and as ticks the window should have contained and did not", w.ticksObserved * 2 < w.ticksExpected, JSON.stringify(w));
  c("so the same evidence the handler acts on says this process was not scheduled", wasStarved(w), JSON.stringify(w));
}

// ── 1b) the OTHER half of the pause: a starved ARM is absorbed too ───────────────────────────
//
// A pause has two plane operations, and cell 1 only reaches one of them. The mint happens before
// any waiting, so a host already loaded when the step BEGINS starves the arm rather than the
// settle, and that is the ordinary case for the incident in #1508: the wave program's host was
// already at load1 118 when the sleep started. MP12 found this gap by surviving — the arm's
// wrapper could be removed with every other cell still green.
//
// The starvation is driven the same way as cell 1 and the witness is the same: the arm's notice
// names the arming, which no other operation emits.
{
  console.log("• 1b — a sleep whose MINT is starved is absorbed too");
  const TOKEN = "c3RhcnZlX2FybV90b2tlbl8wMDFi";
  const absorbed: string[] = [];
  const handler = handlerWith(undefined, undefined, (note) => absorbed.push(note));
  // THE DURATION OUTLIVES THE BLOCK, and that is a real constraint rather than a convenience. The
  // deadline is computed before the mint, so a sleep whose whole duration elapses while the mint is
  // still starved is a DIFFERENT condition: the plane refuses a deadline already in the past
  // (`failed-precondition`), which is not deadline-shaped and correctly stays a fault. Measured on
  // the way to this line: a 3s sleep under an 18s block failed exactly that way. This cell grades
  // the arm's starvation, so it keeps the deadline live across it.
  const sleeping = handler.sleep({ duration: "25s" }, ctxOf(TOKEN)).then(() => "ok" as const, (e: Error) => e);
  // NO settle time first: the block begins while the mint's own writes are in flight, which is what
  // makes this the arm's starvation rather than a second copy of cell 1.
  await starveAcross(2);
  await armPending(4);
  const out = await withDeadline(sleeping, 60_000, "the arm-starved sleep");
  c("the sleep completes despite its MINT being starved",
    out === "ok", out instanceof Error ? `${(out as EffectError).code ?? out.name}: ${out.message}` : out);
  c("and an arming starvation was absorbed by name, not just a waiting one",
    absorbed.some((n) => n.includes("arming the pause")), absorbed.map((n) => n.slice(0, 40)).join(" | ") || "(none)");
}

// ── 2) THE PAIRED CELL: a genuine host fault under the same wait still fails as L4000 ────────
//
// A repair that simply swallowed every timeout would pass cell 1 and fail here. The fault is real
// and not deadline-shaped: the plane refuses the read outright.
{
  console.log("• 2 — a genuine fault still fails as L4000, by name");
  const TOKEN = "c3RhcnZlX2ZhdWx0X3Rva2VuXzAwMDI";
  // A REAL refusal from the plane, reached through the handler's own path: the settle watcher
  // raises the way a broken plane raises, which is what the handler's dispatch sees.
  const boom = new Error("the endpoint's fact stream is gone");
  const faulted = new MeshHandler(
    nc, kv, js, jsm,
    { space: SPACE, endpoint: EP, runId: "r-starve", caller: CALLER, instanceId: IID, epoch: EPOCH, holder: HOLDER, defaultCheckpointTimeout: "1h" },
    { awaitSettle: () => Promise.reject(boom) },
    () => Date.now(),
    undefined,
    loopLagObserver(50),
  );
  const out = await withDeadline(faulted.sleep({ duration: "3s" }, ctxOf(TOKEN)).then(() => "ok" as const, (e: Error) => e), 30_000, "the faulting sleep");
  c("the effect FAILS: a broken plane is not something to retry past", out instanceof Error, String(out));
  c("and it fails with its own error, which the interpreter records as L4000 handler-fault",
    out instanceof Error && !(out instanceof EffectError && out.code === "L4025") && out.message.includes("fact stream is gone"),
    out instanceof Error ? out.message : String(out));
}

// ── 3) the classifier's branches, each with a REFUSING case that differs only in context ─────
//
// Three accepting branches across two predicates: `isDeadlineShaped` accepts a bare `TimeoutError`
// (A1) and a `RequestError` caused by one (A2); `wasStarved` accepts a window that is both laggy
// and tick-short (A3). Each has a refusal that differs from its acceptance in exactly one thing.
{
  console.log("• 3 — one refusing case per accepting branch");
  const timeoutError = Object.assign(new Error("timeout"), { name: "TimeoutError" });
  const requestWithTimeout = Object.assign(new Error("request"), { name: "RequestError", cause: timeoutError });

  // A1 accept / refuse: same message, different class. The message is what the old code would have
  // had to match on, so a refusal that differs ONLY by class is the one that matters.
  c("A1 accepts the client's own deadline class", isDeadlineShaped(timeoutError));
  c("A1 refuses an error carrying the identical message from another class",
    !isDeadlineShaped(Object.assign(new Error("timeout"), { name: "EpEnvelopeError" })));

  // A2 accept / refuse: same wrapper class, different cause.
  c("A2 accepts a request whose CAUSE is the deadline", isDeadlineShaped(requestWithTimeout));
  c("A2 refuses the same wrapper caused by no-responders, which is a plane fault",
    !isDeadlineShaped(Object.assign(new Error("request"), { name: "RequestError", cause: Object.assign(new Error("no responders"), { name: "NoResponders" }) })));

  // A3 accept / refuse: the starved window, then four windows each failing one condition.
  const starvedWindow: LoopLagWindow = { elapsedMs: 10_000, lagMs: 9_000, ticksExpected: 40, ticksObserved: 3 };
  c("A3 accepts a window that is both laggy and short of its ticks", wasStarved(starvedWindow));
  c("A3 refuses a window whose lag is under the floor", !wasStarved({ ...starvedWindow, lagMs: 400, elapsedMs: 900, ticksExpected: 3, ticksObserved: 0 }));
  c("A3 refuses lag that is real but a small share of a long window",
    !wasStarved({ elapsedMs: 240_000, lagMs: 2_000, ticksExpected: 960, ticksObserved: 8 }));
  // THE CLOCK-JUMP REFUSAL, and the reason the tick count exists: every tick ran, so the loop was
  // fine and the wall clock moved. Lag alone would call this starvation.
  c("A3 refuses a window with large lag whose ticks all ran: a clock that jumped, not a loop that stopped",
    !wasStarved({ elapsedMs: 10_000, lagMs: 9_000, ticksExpected: 40, ticksObserved: 40 }));
  c("A3 refuses a window too short to have contained a tick at all",
    !wasStarved({ elapsedMs: 30, lagMs: 30_000, ticksExpected: 0, ticksObserved: 0 }));

  // And the composition: the classifier needs BOTH, so each half alone is a fault.
  c("the classifier calls it starved only when the shape AND the evidence agree",
    classifyPauseFailure(timeoutError, starvedWindow).condition === "starved");
  c("a deadline on a loop that was RUNNING is a fault, not starvation",
    classifyPauseFailure(timeoutError, { elapsedMs: 10_000, lagMs: 12, ticksExpected: 40, ticksObserved: 40 }).condition === "fault");
  c("a non-deadline failure on a starved loop is still a fault: starvation does not launder it",
    classifyPauseFailure(new Error("stream not found"), starvedWindow).condition === "fault");
}

// ── 4) a caller that truly cannot be served FAILS, and says what it measured ──────────────────
//
// The other half of the guarantee: a run must not hang forever on a host that never recovers. The
// operation starves on every attempt, and the bound turns that into a named failure.
{
  console.log("• 4 — an unservable caller fails, bounded, under its own code");
  const alwaysStarved: LoopLagObserver = {
    mark: () => ({ at: 0, lagMs: 0, ticks: 0 }),
    since: () => ({ elapsedMs: 10_000, lagMs: 9_500, ticksExpected: 40, ticksObserved: 1 }),
  };
  let attempts = 0;
  const out = await withDeadline(
    servedDespiteStarvation(
      () => { attempts += 1; return Promise.reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })); },
      alwaysStarved,
      "waiting on the pause t",
      () => { /* quiet in the transcript */ },
    ).then(() => "ok" as const, (e: unknown) => e),
    30_000,
    "the unservable operation",
  );
  c("it ends rather than retrying forever", out !== undefined && out !== "ok");
  c("after a bounded number of attempts", attempts === STARVED_ATTEMPTS, attempts);
  c("under L4025, which names the HOST rather than the effect",
    out instanceof EffectError && out.code === "L4025" && out.kind === "host-starved",
    out instanceof EffectError ? `${out.code}/${out.kind}` : String(out));
  c("carrying the measurement, so the operator reads why rather than guessing",
    out instanceof EffectError && /event-loop lag \d+ms of a \d+ms window, 1 of 40 scheduled ticks/.test(out.message),
    out instanceof Error ? out.message.slice(0, 160) : String(out));

  // And the counterpart: a fault is raised on the FIRST attempt, with no retry at all.
  let faultAttempts = 0;
  const fault = await servedDespiteStarvation(
    () => { faultAttempts += 1; return Promise.reject(new Error("stream not found")); },
    alwaysStarved,
    "waiting on the pause t",
    () => { /* quiet */ },
  ).then(() => "ok" as const, (e: unknown) => e);
  c("a genuine fault is raised on the first attempt, unretried and unwrapped",
    faultAttempts === 1 && fault instanceof Error && fault.message === "stream not found", `${faultAttempts} ${String(fault)}`);
}

// The tally banner the shard's sentinel parser reads, in the spelling every other runtime mesh
// suite prints: a suite that returns 0 having run no cells is the same false green as an empty
// chain, so the count is part of the output and not just the exit status.
console.log(`host-starvation.smoke: ${ok} passed, ${fail} failed`);
done();
process.exit(fail === 0 ? 0 : 1);
