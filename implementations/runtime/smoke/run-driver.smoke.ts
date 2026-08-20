/**
 * The run driver, against a real broker.
 *
 * Two claims, and the second is the one that is easy to get wrong. First, that a run driven to
 * completion, killed mid-flight and taken over by another driver performs each effect ONCE — the
 * resume replays the journal rather than the world. Second, that a driver which has lost the run
 * says so as `released` and never as a run result: a program whose journal refused an append has not
 * failed, and recording that it did would be the durability layer inventing an outcome.
 *
 * The handler here counts what it actually effects, which is the only way to tell a replayed
 * effect from a repeated one — a journal that looks right proves nothing if the world was touched
 * twice.
 *
 * Run: pnpm smoke:runtime-run-driver   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { isReachable, createEndpointStreams, activateRun, replayRunJournal, openRecordsBucket, readRunRecord, createRunSpec, RunJournalTailTruncated } from "@cotal-ai/core";
import { ENGINE_LANGUAGE_VERSION, Journal, PIN_DEFAULTS, SimHandler, WALKER_LANGUAGE_VERSION, resolvePins, run as walkProgram, type EffectHandler, type JournalEntry } from "@cotal-ai/lang";
import { startRun, driveRun, RunJournalStore, PauseToken } from "../src/index.js";
import { runOnHostedEngine } from "../src/engine-host.js";
import { pickFreePort } from "./_free-port.js";

const SPACE = "wfjdrive";
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-wfjdrive-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const servers = `nats://127.0.0.1:${PORT}`;

let ok = 0, fail = 0;
/** Every cell this run EXECUTED, in order, passed or failed. The seam check at the bottom reads it. */
const EXECUTED: string[] = [];
const c = (n: string, v: boolean, extra?: unknown) => { EXECUTED.push(n); if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const done = () => {
  try { broker.kill("SIGKILL"); } catch { /* already gone */ }
  rmSync(sd, { recursive: true, force: true });
};
process.on("exit", done);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 60 && !up; i += 1) { up = await isReachable(servers); if (!up) await wait(100); }
if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
const nc = await connect({ servers });
const jsm = await jetstreamManager(nc);
const js = jetstream(nc);
await createEndpointStreams(jsm, new Kvm(nc), SPACE);
const kv = await openRecordsBucket(nc, SPACE);
const EP = "manager";

let takeovers = 0;
const lease = (holder: string, epoch: number, fencingToken: number) =>
  ({ holder, epoch, fencingToken, takeoverId: `t${(takeovers += 1)}` });

/**
 * A drive attempt, with a THROW as a third observable outcome.
 *
 * The claim under test is that losing a run comes back as an answer rather than as an exception, so
 * a cell that let the exception escape would be asserting nothing — the suite would die instead of
 * failing, and the failure would name no claim.
 */
type Attempt = Awaited<ReturnType<typeof driveRun>> | { readonly status: "threw"; readonly reason: Error };
const attempt = async (p: Promise<Awaited<ReturnType<typeof driveRun>>>): Promise<Attempt> => {
  try { return await p; } catch (e) { return { status: "threw" as const, reason: e as Error }; }
};
const why = (a: Attempt) => (a.status === "completed" ? "completed" : a.reason.name);

/** A handler that COUNTS what it effects. A replayed effect must not reach it at all. */
class CountingHandler extends SimHandler {
  readonly effects: string[] = [];
  override async sleep(req: Parameters<SimHandler["sleep"]>[0], ctx: Parameters<SimHandler["sleep"]>[1]) {
    this.effects.push(`sleep:${req.duration}`);
    return await super.sleep(req, ctx);
  }
}

// A program is a top-level script, not a module: `export` is L1020.
const PROGRAM = `
await sleep("1h", { name: "first" });
await sleep("2h", { name: "second" });
`;

// ── 1) a run driven start to finish ───────────────────────────────────────────────────────────
{
  const handler = new CountingHandler();
  const out = await attempt(startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-1", source: PROGRAM, lease: lease("m1", 1, 1), handler,
  }));
  c("a started run completes", out.status === "completed", why(out));
  // Two logical entries, four durable records: the journal is keyed by STEP and each step is
  // written twice, pending then settled. The broker count below is the other half of that fact.
  c("its journal holds one entry per step, not one per append",
    out.status === "completed" && out.result.journal.entries().length === 2,
    out.status === "completed" ? out.result.journal.entries().length : "-");
  c("the handler effects each effect exactly once", handler.effects.join(",") === "sleep:1h,sleep:2h",
    handler.effects);
  const back = await replayRunJournal(js, jsm, SPACE, "d-1", `r${(takeovers += 1)}`);
  c("and both phases of both steps are durable on the broker, not in the driver",
    back.records.filter((r) => r.record.kind === "step").length === 4,
    back.records.map((r) => r.record.kind));
}

// ── 2) a takeover REPLAYS the journal rather than the world ──────────────────────────────────
//
// The property durability exists for. A second driver resumes a run whose effects are all recorded
// and performs NONE of them again: the journal answers, the handler is never asked. A journal that
// merely looks right proves nothing here — the handler counts what it actually did.
{
  const second = new CountingHandler();
  const taken = await attempt(driveRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-1", source: PROGRAM, lease: lease("m2", 2, 2), handler: second,
  }));
  c("a successor resumes a fully-journalled run to completion", taken.status === "completed", why(taken));
  c("and performs NOTHING again: every effect came back from the journal",
    second.effects.length === 0, second.effects);
  const back = await replayRunJournal(js, jsm, SPACE, "d-1", `r${(takeovers += 1)}`);
  c("the resume wrote no duplicate steps either — only its activation",
    back.records.filter((r) => r.record.kind === "step").length === 4 &&
    back.records.filter((r) => r.record.kind === "activation").length === 2,
    back.records.map((r) => r.record.kind).join(","));
}

// ── 2b) a driver superseded MID-FLIGHT is released, and its program is not called failed ──────
//
// The first driver is held inside an effect while a newer lease takes the run. Its next append is
// refused, so the interpreter unwinds — and the answer that comes back must be `released`, because
// nothing here is a fact about the program. A driver that reported this as a run failure would be
// recording a conclusion about work it can no longer see.
{
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  class Blocking extends CountingHandler {
    override async sleep(req: Parameters<CountingHandler["sleep"]>[0], ctx: Parameters<CountingHandler["sleep"]>[1]) {
      const out = await super.sleep(req, ctx);
      if (this.effects.length === 1) await gate; // held inside the FIRST effect
      return out;
    }
  }
  const blocked = new Blocking();
  const started = attempt(startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-2", source: PROGRAM, lease: lease("m1", 1, 1), handler: blocked,
  }));
  await wait(300);
  const usurper = await activateRun(js, jsm, {
    space: SPACE, runId: "d-2", holder: "m2", fencingToken: 2, epoch: 2, takeoverId: `x${(takeovers += 1)}`, at: 1, expect: "existing",
  });
  release();
  const firstOut = await started;
  c("the superseded driver is RELEASED, not completed and not thrown", firstOut.status === "released",
    why(firstOut));
  c("and it says so as a durability failure, which is what the journal actually reported",
    firstOut.status === "released" && firstOut.reason.name === "JournalAppendRejected",
    why(firstOut));
  c("the successor holds the run and can still write", (await usurper.append({ mine: true }, 1)) > 0);
}

// ── 3) the four ways a drive is not this driver's to make ─────────────────────────────────────
{
  const handler = new CountingHandler();
  const req = { space: SPACE, endpoint: EP, kv, runId: "d-3", source: PROGRAM, handler };
  // NOT A BARE CALL. Every refusal below refuses a run that already exists, so if this start
  // stopped being one the four cells would go on passing about a run nobody started.
  const seeded = await attempt(startRun(js, jsm, { ...req, lease: lease("m1", 1, 5) }));
  c("the run these four refusals refuse was really started", seeded.status === "completed", why(seeded));

  const restart = await attempt(startRun(js, jsm, { ...req, lease: lease("m1", 1, 6) }));
  c("starting a run that already has a journal is released, not silently re-run",
    restart.status === "released" && restart.reason.name === "RunAlreadyStarted",
    why(restart));

  const stale = await attempt(driveRun(js, jsm, { ...req, lease: lease("m9", 9, 1) }));
  c("driving on an older fencing token is released", stale.status === "released" &&
    stale.reason.name === "StaleLeaseToken", why(stale));

  const impostor = await attempt(driveRun(js, jsm, { ...req, lease: lease("m2", 2, 5) }));
  c("driving on another holder's current token is released", impostor.status === "released" &&
    impostor.reason.name === "ActivationNotAuthorized",
    why(impostor));

  const missing = await attempt(driveRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-3-never", source: PROGRAM, handler, lease: lease("m1", 1, 1),
  }));
  c("and resuming a run with no journal is released rather than started from scratch",
    missing.status === "released" && missing.reason.name === "RunNotResumable",
    why(missing));
  c("none of those touched the world", handler.effects.length === 2, handler.effects);
}

// ── 4) a program cannot CATCH the loss of its own journal ────────────────────────────────────
//
// The worst shape this seam can produce, and it was live: an ordinary `try { await sleep() } catch`
// swallowed the journal's refusal, the program went on to perform two more effects against the
// world, and the run returned normally — with nothing recorded from the refusal onward, so a resume
// would perform them all again. A cancellation was already uncatchable for the same reason. A run
// that cannot record must stop, and no catch block may decide otherwise.
{
  const CATCHER = `
try {
  await sleep("1h", { name: "first" });
} catch (e) {
  await sleep("2h", { name: "swallowed" });
}
await sleep("3h", { name: "after-the-catch" });
`;
  const handler = new CountingHandler();
  const out = await attempt(startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-4", source: CATCHER, lease: lease("m1", 1, 1), handler,
  }));
  // Take the run away while the first effect is in flight? No — simpler and stricter: the run is
  // superseded before it starts its second effect, by a driver that just activates.
  c("a run whose journal is intact completes normally", out.status === "completed", why(out));

  // Hold the run INSIDE its first effect so the takeover lands mid-flight: a virtual-clock sleep
  // returns instantly, so without the gate the program is finished before anything can supersede it.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  class Held extends CountingHandler {
    override async sleep(req: Parameters<CountingHandler["sleep"]>[0], ctx: Parameters<CountingHandler["sleep"]>[1]) {
      const out = await super.sleep(req, ctx);
      if (this.effects.length === 1) await gate;
      return out;
    }
  }
  const handler2 = new Held();
  const started = attempt(startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-5", source: CATCHER, lease: lease("m1", 1, 1), handler: handler2,
  }));
  await wait(300);
  await activateRun(js, jsm, {
    space: SPACE, runId: "d-5", holder: "m2", fencingToken: 2, epoch: 2, takeoverId: `x${(takeovers += 1)}`, at: 1, expect: "existing",
  });
  release();
  const lost = await started;
  c("but a run that LOSES its journal is released, not caught and carried on", lost.status === "released",
    why(lost));
  c("and it stopped at the refusal rather than performing the catch block's effects",
    handler2.effects.length < 3, handler2.effects);

  // The sharper shape, and the one a dead appender MASKS: when the catch block performs no further
  // effect, nothing else tries to append, so a swallowed refusal is never re-raised and the run
  // returns NORMALLY — a driver reporting success over a journal missing the tail of its own run.
  // Losing the journal has to end the run by itself, not by whatever the program does next.
  const QUIET = `
try {
  await sleep("1h", { name: "first" });
} catch (e) {
}
`;
  let letGo!: () => void;
  const held = new Promise<void>((r) => { letGo = r; });
  class HeldOnce extends CountingHandler {
    override async sleep(req: Parameters<CountingHandler["sleep"]>[0], ctx: Parameters<CountingHandler["sleep"]>[1]) {
      const out = await super.sleep(req, ctx);
      await held;
      return out;
    }
  }
  const quiet = new HeldOnce();
  const running = attempt(startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-5b", source: QUIET, lease: lease("m1", 1, 1), handler: quiet,
  }));
  await wait(300);
  await activateRun(js, jsm, {
    space: SPACE, runId: "d-5b", holder: "m2", fencingToken: 2, epoch: 2, takeoverId: `x${(takeovers += 1)}`, at: 1, expect: "existing",
  });
  letGo();
  const quietOut = await running;
  c("a run whose catch block is EMPTY still cannot report success over a journal it lost",
    quietOut.status === "released", why(quietOut));
}

// ── 5) a journal belongs to ONE run, at both ends ────────────────────────────────────────────
//
// The keys are structural, so another run's entry with the same scope and name MATCHES. A journal
// crossed with the wrong run does not mislabel anything — it returns another run's recorded results
// as this run's own, and a PubAck on one run's subject makes the other's journal say "durable".
{
  const a = await activateRun(js, jsm, {
    space: SPACE, runId: "d-6", holder: "m1", fencingToken: 1, epoch: 1, takeoverId: `x${(takeovers += 1)}`, at: 1, expect: "new",
  });
  const store = new RunJournalStore(a);
  let crossed: unknown;
  try {
    await store.append({
      v: 1, seq: 0, run: "SOME-OTHER-RUN", scope: "", kind: "sleep", name: "x", occurrence: 0,
      inputHash: "h", state: "pending", startedAt: 1,
    } as never);
  } catch (e) { crossed = e; }
  c("a store refuses an entry that belongs to another run", crossed instanceof Error,
    (crossed as Error)?.message?.slice(0, 60));
  const back = await replayRunJournal(js, jsm, SPACE, "d-6", `r${(takeovers += 1)}`);
  c("and nothing of it reached this run's subject",
    back.records.filter((r) => r.record.kind === "step").length === 0);
}

// ── 6) the work horizon: a driver stops at the deadline it accepted ──────────────────────────
//
// `workExpiry` is absolute, fixed at acceptance and never re-set (SPEC 13.8). Past it the pool has
// already reconciled the item, so a driver still appending is writing into a run the authority
// considers finished with — and no successor need ever exist to stop it, which is why the barrier
// alone does not cover this. It needs no read of anything: the horizon came with the lease, and
// that is exactly what makes it safe to check locally where a lease DEADLINE would not be.
{
  const handler = new CountingHandler();
  // The horizon passes WHILE the first effect is in flight — the case that matters. A clock that
  // ticks per call made this cell pass with nothing effects at all, which proved only that a
  // driver can refuse to start; asserting the exact count is what caught it.
  (handler as unknown as { now: () => number }).now = () => (handler.effects.length >= 1 ? 9_000 : 1_000);
  const out = await attempt(startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-7", source: PROGRAM, lease: lease("m1", 1, 1), handler,
    workExpiry: 5_000,
  }));
  c("a driver past its work horizon RELEASES the run rather than failing it",
    out.status === "released", why(out));
  c("and says so as the host's reason, not as a program error",
    out.status === "released" && /work horizon/.test(out.reason.message), why(out));
  c("it stopped BETWEEN effects, not before the run and not after it: exactly one effects",
    handler.effects.length === 1, handler.effects);
  // The load-bearing half, on the wire this time: a pending record here would be durable evidence
  // of work nobody effects, and the next driver would recover it — handing a resume token for a
  // handler that never ran.
  const back = await replayRunJournal(js, jsm, SPACE, "d-7", `r${(takeovers += 1)}`);
  const steps = back.records.filter((r) => r.record.kind === "step");
  c("and the journal on the wire has no step it did not finish",
    steps.length % 2 === 0, steps.length);

  // And the run is resumable from exactly there, by a successor with its own lease and its own
  // horizon — which is the whole point of stopping between effects rather than inside one.
  const successor = new CountingHandler();
  const done2 = await attempt(driveRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-7", source: PROGRAM, lease: lease("m2", 2, 2), handler: successor,
  }));
  c("a successor under a fresh horizon finishes the run from where it stopped",
    done2.status === "completed", why(done2));

  // AND A HORIZON ALREADY PAST WHEN THE DRIVE BEGINS stops the run before its FIRST effect. The
  // walker asks before every effect and answers this for free; the engine host must publish the
  // expired horizon before the thread's first pre-effect check, and this is the cell that holds it
  // to that — an engine that learned of the horizon only from append traffic would run one effect
  // first.
  const never = new CountingHandler();
  (never as unknown as { now: () => number }).now = () => 9_000;
  const early = await attempt(startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-7z", source: PROGRAM, lease: lease("m1", 1, takeovers += 1), handler: never,
    workExpiry: 5_000,
  }));
  c("a horizon already past at the start stops the run before its first effect",
    early.status === "released" && never.effects.length === 0, { status: why(early), effects: never.effects });

  // AND A STOP CHECK THAT ITSELF THROWS is the RUN'S fault, on the caller's stack. The poll's
  // callback runs on the timer's own stack, where an unguarded throw becomes an uncaught
  // exception that bypasses every catch the driver holds and kills the host process (MEASURED at
  // c24be213: Timeout._onTimeout, engine-host.ts). The throw window is deterministic, not timed:
  // the handler holds its effect open after the pending append landed, and in that window the
  // poll is the only caller of the stop check - the append boundary's own throw is a different,
  // already-graded path (the store witnesses a rejected append).
  {
    const sim = new SimHandler({});
    let pendingSeen = false;
    let parked = false;
    const parking: EffectHandler = {
      now: () => sim.now(),
      spawn: async (r, x) => {
        parked = true;
        await new Promise((res) => setTimeout(res, 400));
        parked = false;
        return sim.spawn(r, x);
      },
      turn: (r, x) => sim.turn(r, x),
      ask: (r, x) => sim.ask(r, x),
      checkpoint: (r, x) => sim.checkpoint(r, x),
      sleep: (r, x) => sim.sleep(r, x),
      wait: (r, x) => sim.wait(r, x),
      notify: (r, x) => sim.notify(r, x),
      monitor: (r, x) => sim.monitor(r, x),
      openConclave: (r, x) => sim.openConclave(r, x),
      closeConclave: (r, x) => sim.closeConclave(r, x),
    };
    let trapResolve!: (v: string) => void;
    const trap = new Promise<string>((resolve) => { trapResolve = resolve; });
    const onUncaught = (e: Error) => trapResolve(`uncaught: ${e.message}`);
    process.once("uncaughtException", onUncaught);
    const outcome = await Promise.race([
      runOnHostedEngine({
        source: `const a = await spawn("x", { name: "s" })\nlog("done", 1)`,
        runId: "d-7t",
        pins: resolvePins({ runId: "d-7t" }, sim.now(), ENGINE_LANGUAGE_VERSION),
        handler: parking,
        store: { append: async () => { pendingSeen = true; } },
        entries: [],
        shouldStop: () => {
          if (pendingSeen && parked) throw new Error("the stop check exploded");
          return undefined;
        },
      }).then(() => "completed", (e: Error) => `rejected: ${e.message}`),
      trap,
    ]);
    process.removeListener("uncaughtException", onUncaught);
    c("a stop check that throws on the poll's own stack is the RUN'S fault, never an uncaught exception",
      outcome === "rejected: the stop check exploded", outcome);
  }

  // AND THE POLL ITSELF IS LOAD-BEARING, graded in the one window only it serves: an effect parked
  // in the host with NO append traffic, and a stop that is true only inside that window (the
  // handler raises it entering the park and lowers it leaving, so the append boundaries on either
  // side of the park see nothing). Only the timer can carry that stop; without it the run
  // COMPLETES, performing a second effect the operator's stop should have prevented. The park is
  // six of the timer's periods with the event loop free, so a tick landing inside it is the timer
  // contract itself, not a bet on load.
  {
    const sim = new SimHandler({});
    let stopNow = false;
    const enters: string[] = [];
    const parking: EffectHandler = {
      now: () => sim.now(),
      spawn: async (r, x) => {
        enters.push(r.persona);
        if (r.persona === "x") {
          stopNow = true;
          await new Promise((res) => setTimeout(res, 600));
          stopNow = false;
        }
        return sim.spawn(r, x);
      },
      turn: (r, x) => sim.turn(r, x),
      ask: (r, x) => sim.ask(r, x),
      checkpoint: (r, x) => sim.checkpoint(r, x),
      sleep: (r, x) => sim.sleep(r, x),
      wait: (r, x) => sim.wait(r, x),
      notify: (r, x) => sim.notify(r, x),
      monitor: (r, x) => sim.monitor(r, x),
      openConclave: (r, x) => sim.openConclave(r, x),
      closeConclave: (r, x) => sim.closeConclave(r, x),
    };
    const outcome = await runOnHostedEngine({
      source: `const a = await spawn("x", { name: "s" })\nconst b = await spawn("y", { name: "t" })\nlog("done", 2)`,
      runId: "d-7p",
      pins: resolvePins({ runId: "d-7p" }, sim.now(), ENGINE_LANGUAGE_VERSION),
      handler: parking,
      store: { append: async () => {} },
      entries: [],
      shouldStop: () => (stopNow ? "operator stop" : undefined),
    }).then(() => "completed", (e: Error) => e.name);
    c("a stop only the poll can see, raised inside a parked effect with no append traffic, still stops the run at the next effect",
      outcome === "RunReleased" && enters.length === 1, { outcome, enters });
  }
}

// ── 7) pause: an operator stop is not a failure either ───────────────────────────────────────
//
// Same seam, different reason, and the difference matters at the boundary: a pause is a request
// about the HOST, so it must not settle an entry as failed. It is honoured at the next effect that
// is not already recorded — never inside one, because a handler that has dispatched has done real
// work and stopping it would record a lie about it.
{
  const handler = new CountingHandler();
  const pause = new PauseToken();
  pause.pause("operator asked");
  const out = await attempt(startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-8", source: PROGRAM, lease: lease("m1", 1, 1), handler, pause,
  }));
  c("a paused driver releases the run", out.status === "released", why(out));
  c("carrying the operator's reason", out.status === "released" && /operator asked/.test(out.reason.message),
    out.status === "released" ? out.reason.message : why(out));
  c("and effects nothing at all: the pause was already set at the first boundary",
    handler.effects.length === 0, handler.effects);
  const back = await replayRunJournal(js, jsm, SPACE, "d-8", `r${(takeovers += 1)}`);
  c("the run exists and holds only its activation: a pause writes no step",
    back.records.length === 1 && back.records[0]!.record.kind === "activation",
    back.records.map((r) => r.record.kind));
}

// ── 8) the run record: what the run IS, beside the journal that says what it DID ─────────────
{
  const out = await attempt(startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-9", source: PROGRAM, lease: lease("m1", 1, 1),
    handler: new CountingHandler(), seed: "seed-of-d-9",
  }));
  c("a started run completes", out.status === "completed", why(out));

  const rec = await readRunRecord(kv, EP, "d-9");
  c("and it has a record: the run exists as STATE, not only as a list of events", rec !== undefined);
  c("whose spec carries the pins resolved once at start",
    rec!.spec.value.pins.seed === "seed-of-d-9" && rec!.spec.value.pins.languageVersion.length > 0,
    rec!.spec.value.pins);
  c("and whose status says who held it, in what state, and how far its journal got",
    rec!.status?.value.state === "completed" && rec!.status?.value.holder === "m1"
    && rec!.status!.value.journalHigh > 0,
    rec!.status?.value);
}

// ── 9) pins are READ BACK on a resume, never re-derived ──────────────────────────────────────
//
// A default is a property of the interpreter, and the interpreter is the thing that may have
// changed between attempts. The logical epoch is the sharpest case: a resumed run that took the
// resuming host's clock would measure an elapsed time the recorded run never saw.
{
  const first = await attempt(startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-10", source: PROGRAM, lease: lease("m1", 1, 1),
    handler: new CountingHandler(), seed: "the-original-seed",
  }));
  c("a run starts and pins itself", first.status === "completed", why(first));
  const pinned = (await readRunRecord(kv, EP, "d-10"))!.spec.value.pins;

  // A successor that supplies NOTHING, on a host whose clock reads DIFFERENTLY. The differing clock
  // is the whole cell: with both attempts on the same fixed sim clock, a driver that re-derived the
  // epoch would produce the same number by accident and the cell would prove nothing.
  const later = new CountingHandler();
  (later as unknown as { now: () => number }).now = () => pinned.startedAt + 86_400_000;
  const second = await attempt(driveRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-10", source: PROGRAM, lease: lease("m2", 2, 2),
    handler: later,
  }));
  c("a successor resumes it", second.status === "completed", why(second));
  c("under the SAME seed it was started with, not one derived again on this host",
    second.status === "completed" && second.result.pins.seed === "the-original-seed",
    second.status === "completed" ? second.result.pins.seed : why(second));
  c("and the SAME logical epoch: the run's clock is a recorded fact, not this machine's",
    second.status === "completed" && second.result.pins.startedAt === pinned.startedAt,
    second.status === "completed" ? `${second.result.pins.startedAt} vs ${pinned.startedAt}` : why(second));
}

// ── 10) the tail anchor: the one truncation nothing inside the journal can see ────────────────
//
// Delete the NEWEST record and the survivors stay contiguous, so the ordinal chain has nothing to
// object to, and the subject's head recalculates backwards so the fence accepts an append at a head
// the run already moved past. The run record is the anchor OUTSIDE the journal, and this is the
// cell that says the driver refuses rather than resuming from a prefix missing real work.
{
  const out = await attempt(startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-11", source: PROGRAM, lease: lease("m1", 1, 1),
    handler: new CountingHandler(),
  }));
  c("a run completes and records how far its journal got", out.status === "completed", why(out));
  const high = (await readRunRecord(kv, EP, "d-11"))!.status!.value.journalHigh;

  const before = await replayRunJournal(js, jsm, SPACE, "d-11", `r${(takeovers += 1)}`);
  await jsm.streams.deleteMessage("WFJ_" + SPACE, before.records[before.records.length - 1]!.seq);

  const after = await attempt(driveRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-11", source: PROGRAM, lease: lease("m2", 2, 2),
    handler: new CountingHandler(),
  }));
  c("a successor REFUSES the truncated journal rather than resuming from it",
    after.status === "threw" && after.reason instanceof RunJournalTailTruncated,
    `${after.status}: ${after.status === "threw" ? after.reason.name : ""}`);
  c("and it refused loudly, not as a release: a corrupted journal is not a lost lease",
    after.status !== "released", why(after));
  c("the record still says how far the run really got", high > 0, high);
  // And nothing was written into the journal it refused: the check runs BEFORE the activation.
  const seen = await replayRunJournal(js, jsm, SPACE, "d-11", `r${(takeovers += 1)}`);
  c("no activation was appended over the rolled-back head",
    seen.records.length === before.records.length - 1,
    `${seen.records.length} vs ${before.records.length - 1}`);
}

// ── 11) a run id is claimed once, and the RECORD is what remembers ───────────────────────────
//
// The journal refuses a second start too, but only while it still has records. Purge them — a
// retirement, an operator, a stream limit — and the journal has no opinion left: an empty subject
// is exactly what a run that never started looks like. The spec is what survives that and says the
// id is spent, which matters because a second start under FRESH pins is a different run wearing the
// same name, and its journal would be a mix of two.
{
  const again = await attempt(startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-9", source: PROGRAM, lease: lease("m3", 3, 3),
    handler: new CountingHandler(), seed: "a-different-seed",
  }));
  c("starting a run that already has a spec is refused", again.status === "released", why(again));

  // Now take the journal's opinion away and ask again.
  await jsm.streams.purge("WFJ_" + SPACE, { filter: `cotal.${SPACE}.wfj.d-9` });
  const purged = await attempt(startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-9", source: PROGRAM, lease: lease("m4", 4, 4),
    handler: new CountingHandler(), seed: "a-different-seed",
  }));
  c("and it is STILL refused with the journal purged: the record is what remembers the id is spent",
    purged.status === "released", why(purged));
  c("with the recorded pins untouched by either attempt",
    (await readRunRecord(kv, EP, "d-9"))!.spec.value.pins.seed === "seed-of-d-9");
}

// ── 10) A HANDLER THAT OWNS EXTERNAL STATE REPAIRS IT ON TAKEOVER WITHOUT BEING WIRED TO ──────
//
// Found by review. The repair seam was an OPTIONAL `onActivated` callback, and nothing in the tree
// passed one — not a production path, not this suite. An optional hook with no caller is
// indistinguishable at runtime from a driver that has nothing to repair, and the thing it exists to
// repair is a checkpoint's armed schedule: it fires onto a subject derived from the instance and
// epoch that armed it, so an adopted run's timers fire where nobody is listening, and replaying the
// program does not fix it — the pause replays as pending and goes straight back to waiting.
//
// So the default is not "do nothing": a handler that knows how to repair its own state declares
// `adopted`, and the driver calls it. The callback remains, as an OVERRIDE.
{
  class AdoptingCounter extends CountingHandler {
    seen: (readonly JournalEntry[])[] = [];
    async adopted(entries: readonly JournalEntry[]): Promise<string[]> {
      this.seen.push(entries);
      return [];
    }
  }

  const first = new AdoptingCounter();
  const startedFresh = await attempt(startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-adopt", source: PROGRAM, lease: lease("m1", 1, takeovers += 1), handler: first,
  }));
  // THE CONTROL, and it is the half that makes the next cell mean anything: a FRESH run is an
  // activation too. If `adopted` fired on every activation regardless, a successor calling it would
  // prove nothing about takeover — and re-arming timers for a run with no recorded prefix is work
  // over an empty list, which is not wrong, only uninformative.
  c("the fresh run completes", startedFresh.status === "completed", why(startedFresh));
  c("a fresh run's activation calls it with the empty prefix it actually resumed",
    first.seen.length === 1 && first.seen[0]!.length === 0, first.seen.map((e) => e.length).join(","));

  const second = new AdoptingCounter();
  const taken = await attempt(driveRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-adopt", source: PROGRAM, lease: lease("m2", 2, takeovers += 1), handler: second,
  }));
  c("a takeover completes", taken.status === "completed", why(taken));
  c("REPAIRED: a successor repairs the previous holder's state WITHOUT any callback being wired",
    second.seen.length === 1, second.seen.length);
  // WITH THE PREFIX, not merely called. A repair handed nothing cannot re-arm anything, so "it was
  // called" is not the property — "it was told what the run already did" is.
  //
  // FOUR records for TWO steps, and the number is the point rather than an accident of this fixture:
  // the prefix is the raw append log the activation replayed, where a settled step is a pending
  // record followed by a settled one. That is the shape the re-armer folds for itself — it reads the
  // LAST record per key, so a pause that is over contributes nothing — and handing it the folded
  // view instead would take that decision away from the thing that knows how to make it.
  c("...and is handed the prefix the activation validated, which is what names the pauses to re-arm",
    second.seen[0]?.length === 4, second.seen[0]?.length);

  // THE OVERRIDE still wins, or the callback has quietly become dead surface.
  const third = new AdoptingCounter();
  let viaCallback = -1;
  const overridden = await attempt(driveRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-adopt", source: PROGRAM, lease: lease("m3", 3, takeovers += 1), handler: third,
    onActivated: async (entries) => { viaCallback = entries.length; },
  }));
  // The same reason as the seeded start above: `viaCallback` holding -1 is what a drive that never
  // ran looks like, and that is indistinguishable from a callback the driver declined to call.
  c("the overriding drive completes, so viaCallback is reporting a drive that happened",
    overridden.status === "completed", why(overridden));
  c("an explicit onActivated still wins: the default is a fallback, not a replacement",
    viaCallback === 4 && third.seen.length === 0, { viaCallback, adopted: third.seen.length });

  // NARROWNESS: a handler with no such method is not an error. Every other cell in this file uses
  // one, so without this the driver could require `adopted` and nothing here would notice.
  // THROUGH `attempt`, for this file's own stated reason: a driver that DEMANDED the method would
  // raise rather than return, and an escaping exception kills the suite instead of failing a cell —
  // which grades as "the run stopped" and names no claim at all.
  const plain = new CountingHandler();
  const noHook = await attempt(driveRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-adopt", source: PROGRAM, lease: lease("m4", 4, takeovers += 1), handler: plain,
  }));
  c("and a handler that owns no external state needs no method: the takeover still completes",
    noHook.status === "completed", why(noHook));
}

// ── 11) THE LOAD DOOR IS REACHED BY THIS DRIVER, WITH A BINDING ACTUALLY IN THE PREFIX ────────
//
// The language refuses a recorded binding with no canonical form (L5024) in the Journal
// CONSTRUCTOR, and this driver builds one at `new Journal({ run, entries: resumed, store })`. The
// lang suite's load cell hands that constructor a hand-built entry: once the write guards exist
// nothing shipped can PRODUCE such an entry, so that cell proves the scan depends on the value and
// cannot prove any entry point reaches it. This is the half that can: a real takeover, through
// this driver, over a prefix that carries a binding.
//
// IT HAD TO BE A NEW PROGRAM. Every other run in this file only sleeps, and `sleep` binds nothing,
// so a takeover of PROGRAM reaches the door with every `external` absent and the scan looks at
// nothing at all. A spawn is what makes the simulator bind, so this one spawns first.
{
  const BOUND = `
const a = await spawn("a");
await sleep("1h", { name: "first" });
`;
  const fresh = await attempt(startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-bind", source: BOUND, lease: lease("b1", 1, takeovers += 1), handler: new CountingHandler(),
  }));
  c("the run that binds completes", fresh.status === "completed", why(fresh));

  let prefix: readonly JournalEntry[] = [];
  const taken = await attempt(driveRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-bind", source: BOUND, lease: lease("b2", 2, takeovers += 1), handler: new CountingHandler(),
    onActivated: async (entries) => { prefix = entries; },
  }));
  // The completion IS the assertion about the door: the scan runs on the way in, so a takeover that
  // completes is one whose recorded bindings were read and accepted. A refusal would have come back
  // through `attempt` as a reason rather than a completion.
  c("a takeover over a journal that carries a binding still loads and completes", taken.status === "completed", why(taken));
  // AND THE PREFIX ACTUALLY CARRIED ONE, which is the part that keeps the cell above from being
  // green for the same reason the sleep-only takeovers are: a door walked over nothing.
  const bound = prefix.filter((e) => e.external !== undefined);
  c("...over a prefix that really did carry one, so the scan looked at a value rather than at nothing",
    bound.length > 0 && (bound[0]!.external as { simAgent?: string }).simAgent === "sim.a",
    { entries: prefix.length, withBinding: bound.length, first: bound[0]?.external });
}

// ── 12) WHICH ENGINE RUNS THIS: the capability table, and the record it refuses ────────────────
//
// The driver hosts a SET of language versions, and that set is a fact about this build rather than
// about the language. Two claims live here and they pull in opposite directions, which is why both
// are needed: a FRESH run must be stamped with the version of the engine that will actually execute
// it, and a RECORD whose version no engine here serves must be refused by name instead of walked by
// whichever engine happens to be present - which would run a program under semantics it was never
// recorded under, silently, because no recorded fact would disagree.
{
  const out = await attempt(startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-v-fresh", source: PROGRAM, lease: lease("m1", 1, 1),
    handler: new CountingHandler(),
  }));
  c("a fresh run completes on the engine this build serves", out.status === "completed", why(out));
  const pinned = (await readRunRecord(kv, EP, "d-v-fresh"))!.spec.value.pins;
  // THE STAMP IS THE ENGINE'S, NOT ANOTHER ENTRY'S, and the walker half of this cell is what makes
  // the first half mean anything: this build serves both versions, so a dispatcher stamping the
  // wrong table entry would still complete the run somewhere and every other cell here would pass.
  // MEASURED before the split existed: a driver stamping a version and then calling an engine of
  // the other refuses its own fresh runs, `driver stamps "2" -> walker: REFUSED L5008`.
  c("and it is stamped with the version of the ENGINE that ran it, not the walker's",
    pinned.languageVersion === ENGINE_LANGUAGE_VERSION && (ENGINE_LANGUAGE_VERSION as string) !== WALKER_LANGUAGE_VERSION,
    { stamped: pinned.languageVersion, engine: ENGINE_LANGUAGE_VERSION, walker: WALKER_LANGUAGE_VERSION });
  // AND IT EXECUTED THERE, said in the one unit that cannot be stamped: steps. A walker dispatch
  // and a transformed-site hit are different units (spec §8.4), so the same source walked
  // in-process and driven through the dispatcher agreeing on the count is what a walker behind the
  // dispatcher would produce, and their disagreement is the execution observed rather than read
  // off a record the dispatcher itself wrote. The loop is what keeps the two counts apart by more
  // than an off-by-one: five iterations charge dozens of dispatches and a handful of site hits.
  const UNITS = "let n = 0; for (let i = 0; i < 5; i = i + 1) { n = n + i; } log(n); await sleep(\"1h\", { name: \"tick\" });";
  const driven = await attempt(startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-units", source: UNITS, lease: lease("m1", 1, takeovers += 1),
    handler: new CountingHandler(),
  }));
  const walked = await walkProgram(UNITS, { runId: "d-units-walk", handler: new CountingHandler(), journal: new Journal({ run: "d-units-walk" }) });
  c("and it charges steps in the engine's own units: the same source, walked in-process, counts differently",
    driven.status === "completed" && driven.result.steps > 0 && walked.steps > 0 && driven.result.steps !== walked.steps,
    { driver: driven.status === "completed" ? driven.result.steps : why(driven), walker: walked.steps });

  // A RECORD FROM A BUILD THAT SERVES MORE THAN THIS ONE. Written directly, because that is exactly
  // what the driver will meet: a spec some other build's dispatcher stamped.
  const foreign = { ...resolvePins({ runId: "d-v9" }, 1_000, WALKER_LANGUAGE_VERSION), languageVersion: "9" };
  await createRunSpec(kv, EP, "d-v9", { pins: foreign, createdAt: 1_000 });
  const refused = await attempt(driveRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-v9", source: PROGRAM, lease: lease("m2", 2, takeovers += 1),
    handler: new CountingHandler(),
  }));
  c("a record no engine here serves is RELEASED, not failed and not thrown",
    refused.status === "released", why(refused));
  c("and it is refused by name, L5023",
    refused.status === "released" && (refused.reason as { code?: string }).code === "L5023",
    refused.status === "released" ? (refused.reason as { code?: string }).code : why(refused));
  c("and the refusal names both the version it met and the set this build serves",
    refused.status === "released" && /language version 9/.test(refused.reason.message)
    && refused.reason.message.includes(`this build serves ${ENGINE_LANGUAGE_VERSION}, ${WALKER_LANGUAGE_VERSION}`),
    refused.status === "released" ? refused.reason.message.slice(0, 120) : why(refused));
  // THE TEETH, AND THEY NEEDED A REAL JOURNAL TO HAVE ANY. A refusal that had already activated the
  // run would have taken the lease and written the activation, and "refused" would then describe the
  // message and not the effect. Asserted on `d-v9` alone that claim was OVERDETERMINED: that run has
  // no journal, so an activation would have been refused as not-resumable whatever the dispatcher
  // did, and no mutation of the dispatch could ever have redded it. So this record is built the way
  // one really arrives - activated once by a first holder and carrying a step - and what the cell
  // watches is whether the SECOND holder took it.
  const first = await activateRun(js, jsm, {
    space: SPACE, runId: "d-v9j", holder: "m1", fencingToken: 1, epoch: 1, takeoverId: `x${(takeovers += 1)}`, at: 1, expect: "new",
  });
  await new RunJournalStore(first).append({
    v: 1, seq: 0, run: "d-v9j", scope: "", kind: "sleep", name: "first", occurrence: 0,
    inputHash: "h", state: "settled", startedAt: 1, endedAt: 2, result: null,
  } as never);
  await createRunSpec(kv, EP, "d-v9j", { pins: foreign, createdAt: 1_000 });
  const held = await attempt(driveRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-v9j", source: PROGRAM, lease: lease("m2", 2, takeovers += 1),
    handler: new CountingHandler(),
  }));
  c("a foreign-version record WITH a journal is refused the same way",
    held.status === "released" && (held.reason as { code?: string }).code === "L5023",
    held.status === "released" ? (held.reason as { code?: string }).code : why(held));
  // WATCHED ON THE JOURNAL, not on the record: `activateRun` writes an activation RECORD into the
  // run's subject and does not write the run record's status - measured, the first attempt at this
  // cell asked for a status that is written by `startRun` and read back `undefined`, so it failed
  // for a reason that had nothing to do with the claim. A second holder taking this run would leave
  // a SECOND activation behind it, and that is the mark this cell looks for.
  const after = await replayRunJournal(js, jsm, SPACE, "d-v9j", `r${(takeovers += 1)}`);
  const activations = after.records.filter((r) => r.record.kind === "activation").length;
  c("and the run was not touched: the refusal came before the activation, so only the first holder's is there",
    activations === 1, after.records.map((r) => r.record.kind));

  // The narrow original, kept: a record with NO journal is refused without being activated either.
  const untouched = await readRunRecord(kv, EP, "d-v9");
  c("and a record with no journal is refused with no status written at all",
    untouched?.status === undefined, untouched?.status?.value);

  // THE RECORD THIS BUILD ACTUALLY WRITES, back at its own dispatcher: it routes to the engine
  // that wrote it. This cell held the opposite claim while the table served only the walker — a
  // v2 record was on the far side of the L5023 line, and its own comment said the red would be the
  // point the day the engine joined the table. That day: the record is `d-v-fresh`'s own, written
  // by the engine three cells up, and the proof of the ROUTE is the resume's shape — a journal
  // whose every entry is settled replays without re-effecting anything, so a successor whose
  // handler was never touched is a record that was read by an engine that speaks its language.
  const successor = new CountingHandler();
  const routed = await attempt(driveRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-v-fresh", source: PROGRAM, lease: lease("m2", 2, takeovers += 1),
    handler: successor,
  }));
  c("a record the engine wrote resumes through the dispatcher on the engine that wrote it",
    routed.status === "completed" && successor.effects.length === 0,
    { status: why(routed), effects: successor.effects });

  // A RECORD FROM BEFORE THE FIELD EXISTED. It reaches the same branch by a different route: not a
  // version this build does not serve, but no version at all, which `find` also fails to match. The
  // sentence is the whole cell - an operator reads it, and a refusal that interpolates a missing
  // value tells them the record says "undefined" when what happened is that it says nothing.
  const { languageVersion: _dropped, ...versionless } = foreign;
  await createRunSpec(kv, EP, "d-v-absent", { pins: versionless as typeof foreign, createdAt: 1_000 });
  const absent = await attempt(driveRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-v-absent", source: PROGRAM, lease: lease("m2", 2, takeovers += 1),
    handler: new CountingHandler(),
  }));
  c("a record that names no language version at all is refused the same way",
    absent.status === "released" && (absent.reason as { code?: string }).code === "L5023",
    absent.status === "released" ? (absent.reason as { code?: string }).code : why(absent));
  c("and the refusal says the record names none, rather than interpolating the missing value",
    absent.status === "released" && !/undefined/.test(absent.reason.message)
    && absent.reason.message.includes(`this build serves ${ENGINE_LANGUAGE_VERSION}, ${WALKER_LANGUAGE_VERSION}`),
    absent.status === "released" ? absent.reason.message.slice(0, 140) : why(absent));

  // A RECORD WHOSE VERSION IS NOT EVEN A STRING. The wire contract types `languageVersion` as a
  // string; a writer that put the NUMBER 2 there produced, before the repair, a released L5023
  // whose sentence read "recorded under language version 2" while "this build serves 2" - a
  // self-contradiction handed to an operator (MEASURED at c24be213, through this same driver,
  // against a real broker). A malformed record is a different statement from an unserved version,
  // and the dispatch says which one it met, before the table is consulted.
  const numbered = { ...foreign, languageVersion: 2 as unknown as string };
  await createRunSpec(kv, EP, "d-v-num", { pins: numbered, createdAt: 1_000 });
  const malformed = await attempt(driveRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-v-num", source: PROGRAM, lease: lease("m2", 2, takeovers += 1),
    handler: new CountingHandler(),
  }));
  c("a record whose languageVersion is a number is refused as MALFORMED, not as an unserved version",
    malformed.status === "released" && malformed.reason.name === "RunRecordMalformed" && (malformed.reason as { code?: string }).code === undefined,
    malformed.status === "released" ? `${malformed.reason.name}: ${malformed.reason.message.slice(0, 120)}` : why(malformed));
  c("and the refusal names the type it met rather than interpolating it into a version claim",
    malformed.status === "released" && malformed.reason.message.includes("carries a number") && !malformed.reason.message.includes("this build serves"),
    malformed.status === "released" ? malformed.reason.message.slice(0, 140) : why(malformed));

  // THE CONTROL, and without it the refusal cells above are satisfied by a driver that refuses every
  // hand-written spec. Same construction, same absent journal, ONE character different.
  const served = { ...foreign, languageVersion: WALKER_LANGUAGE_VERSION };
  await createRunSpec(kv, EP, "d-v1", { pins: served, createdAt: 1_000 });
  const other = await attempt(driveRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-v1", source: PROGRAM, lease: lease("m2", 2, takeovers += 1),
    handler: new CountingHandler(),
  }));
  c("while the same spec at a version this build DOES serve gets past the table",
    other.status !== "released" || (other.reason as { code?: string }).code !== "L5023",
    other.status === "released" ? `${other.reason.name}: ${(other.reason as { code?: string }).code ?? ""}` : why(other));
  // And the defaults are the ones the record carried, which is what a hand-written spec is for here.
  c("and the hand-written spec is a real one: its limits are the language's own defaults",
    served.yieldEvery === PIN_DEFAULTS.yieldEvery && served.stepBudget === PIN_DEFAULTS.stepBudget,
    served);
}

// ---- the cross-package index seam, answered by EXECUTION rather than by source text -------------
//
// `indexed-cells.json` beside this file lists the cells of this suite that the language package's
// version-split matrix cites. This half asserts every one of them RAN. The other half, in
// packages/lang/smoke/differential.smoke.ts, asserts set equality between that list and the matrix's
// driver rows, so between the two nothing in the index can be satisfied by a quotation.
//
// WHY THE LIST IS A DATA FILE AND NOT A CONST HERE. Put these sentences in this file as source text
// and a check that asks whether this file CONTAINS them becomes unconditionally true -- not a weaker
// check, one that cannot fail. Measured from both sides: comment out a cited call and containment
// still passes, because grep finds the sentence twice, once in the dead call and once in the list.
// A separate artefact leaves the containment answer honest and gives the other side something to
// PARSE rather than scrape out of TypeScript, which matters when a cell name carries an apostrophe.
//
// EXACTLY ONCE, not merely present: a sentence matching two executed cells leaves the row ambiguous
// about which cell carries it, and this file already has one name it uses twice.
const seam = JSON.parse(readFileSync(new URL("./indexed-cells.json", import.meta.url), "utf8")) as {
  suite: string;
  cells: string[];
};
c("the cited-cells file names this suite, so it is this file's seam and not another's",
  seam.suite.endsWith("run-driver.smoke.ts"), seam.suite);
const unrun = seam.cells.map((s) => ({ s, hits: EXECUTED.filter((e) => e === s).length })).filter(({ hits }) => hits !== 1);
c("every cell the language package's matrix cites from this file is one THIS RUN executed, exactly once",
  unrun.length === 0, unrun.map(({ s, hits }) => `${hits} execution(s): ${s}`));
console.log(`  (${seam.cells.length} cited cells checked against ${EXECUTED.length} executed)`);

console.log(`run-driver.smoke: ${ok} passed, ${fail} failed`);
done();
process.exit(fail === 0 ? 0 : 1);
