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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { isReachable, createEndpointStreams, activateRun, replayRunJournal, openRecordsBucket, readRunRecord, createRunSpec, RunJournalTailTruncated } from "@cotal-ai/core";
import { ENGINE_LANGUAGE_VERSION, LANGUAGE_VERSION, PIN_DEFAULTS, SimHandler, WALKER_LANGUAGE_VERSION, resolvePins, type JournalEntry } from "@cotal-ai/lang";
import { startRun, driveRun, RunJournalStore, PauseToken } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const SPACE = "wfjdrive";
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-wfjdrive-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const servers = `nats://127.0.0.1:${PORT}`;

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
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
  const out = await startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-1", source: PROGRAM, lease: lease("m1", 1, 1), handler,
  });
  c("a started run completes", out.status === "completed",
    out.status === "released" ? out.reason.name : out.status);
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
  const taken = await driveRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-1", source: PROGRAM, lease: lease("m2", 2, 2), handler: second,
  });
  c("a successor resumes a fully-journalled run to completion", taken.status === "completed",
    taken.status === "released" ? taken.reason.name : taken.status);
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
  const started = startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-2", source: PROGRAM, lease: lease("m1", 1, 1), handler: blocked,
  });
  await wait(300);
  const usurper = await activateRun(js, jsm, {
    space: SPACE, runId: "d-2", holder: "m2", fencingToken: 2, epoch: 2, takeoverId: `x${(takeovers += 1)}`, at: 1, expect: "existing",
  });
  release();
  const firstOut = await attempt(started);
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
  await startRun(js, jsm, { ...req, lease: lease("m1", 1, 5) });

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
  const started = startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-5", source: CATCHER, lease: lease("m1", 1, 1), handler: handler2,
  });
  await wait(300);
  await activateRun(js, jsm, {
    space: SPACE, runId: "d-5", holder: "m2", fencingToken: 2, epoch: 2, takeoverId: `x${(takeovers += 1)}`, at: 1, expect: "existing",
  });
  release();
  const lost = await attempt(started);
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
  const running = startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-5b", source: QUIET, lease: lease("m1", 1, 1), handler: quiet,
  });
  await wait(300);
  await activateRun(js, jsm, {
    space: SPACE, runId: "d-5b", holder: "m2", fencingToken: 2, epoch: 2, takeoverId: `x${(takeovers += 1)}`, at: 1, expect: "existing",
  });
  letGo();
  const quietOut = await attempt(running);
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
  const startedFresh = await startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-adopt", source: PROGRAM, lease: lease("m1", 1, takeovers += 1), handler: first,
  });
  // THE CONTROL, and it is the half that makes the next cell mean anything: a FRESH run is an
  // activation too. If `adopted` fired on every activation regardless, a successor calling it would
  // prove nothing about takeover — and re-arming timers for a run with no recorded prefix is work
  // over an empty list, which is not wrong, only uninformative.
  c("the fresh run completes", startedFresh.status === "completed",
    startedFresh.status === "released" ? startedFresh.reason.name : startedFresh.status);
  c("a fresh run's activation calls it with the empty prefix it actually resumed",
    first.seen.length === 1 && first.seen[0]!.length === 0, first.seen.map((e) => e.length).join(","));

  const second = new AdoptingCounter();
  const taken = await driveRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-adopt", source: PROGRAM, lease: lease("m2", 2, takeovers += 1), handler: second,
  });
  c("a takeover completes", taken.status === "completed", taken.status === "released" ? taken.reason.name : taken.status);
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
  await driveRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-adopt", source: PROGRAM, lease: lease("m3", 3, takeovers += 1), handler: third,
    onActivated: async (entries) => { viaCallback = entries.length; },
  });
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
  // THE STAMP IS THE ENGINE'S, NOT THE LANGUAGE'S, and the second half of this cell is what makes
  // the first half mean anything: with one shared constant both sides read the same and a driver
  // stamping the current language would pass. MEASURED before the split existed: a driver stamping
  // the current language and then calling the only engine it hosts refuses its own fresh runs,
  // `driver stamps "2" -> walker: REFUSED L5008`.
  c("and it is stamped with the version of the ENGINE that ran it, not with the current language",
    pinned.languageVersion !== LANGUAGE_VERSION && pinned.languageVersion === WALKER_LANGUAGE_VERSION,
    { stamped: pinned.languageVersion, engine: WALKER_LANGUAGE_VERSION, language: LANGUAGE_VERSION });

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
    && refused.reason.message.includes(`this build serves ${WALKER_LANGUAGE_VERSION}`),
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

  // THE RECORD THIS BUILD WILL ACTUALLY MEET, as opposed to a version nobody wrote: one stamped by
  // the ENGINE. It takes the same branch as the unserved number above and it is not the same claim -
  // that one says the table refuses what it does not list, this one says the version the other
  // engine really writes is on the far side of that line today. It is also the cell that must be
  // revisited rather than silently kept the day the engine joins the table: it will red, and the
  // red is the point, because on that day the dispatcher's answer for a v2 record changes.
  const v2 = { ...resolvePins({ runId: "d-v2" }, 1_000, WALKER_LANGUAGE_VERSION), languageVersion: ENGINE_LANGUAGE_VERSION };
  await createRunSpec(kv, EP, "d-v2", { pins: v2, createdAt: 1_000 });
  const engineRecord = await attempt(driveRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "d-v2", source: PROGRAM, lease: lease("m2", 2, takeovers += 1),
    handler: new CountingHandler(),
  }));
  c("a record at the version the ENGINE writes is released by the dispatcher, L5023, naming it",
    engineRecord.status === "released"
    && (engineRecord.reason as { code?: string }).code === "L5023"
    && engineRecord.reason.message.includes(`language version ${ENGINE_LANGUAGE_VERSION}`),
    engineRecord.status === "released" ? engineRecord.reason.message.slice(0, 120) : why(engineRecord));

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
    && absent.reason.message.includes(`this build serves ${WALKER_LANGUAGE_VERSION}`),
    absent.status === "released" ? absent.reason.message.slice(0, 140) : why(absent));

  // THE CONTROL, and without it the three cells above are satisfied by a driver that refuses every
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

console.log(`run-driver.smoke: ${ok} passed, ${fail} failed`);
done();
process.exit(fail === 0 ? 0 : 1);
