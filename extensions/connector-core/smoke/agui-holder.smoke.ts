/**
 * The lazy holder — the lifecycle the cutover will swap onto, graded BEFORE the cutover.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT. The holder is real. The emitter is NOT: the holder touches
 * exactly two things on it, `stopped` and `pump()`, and substituting those with an instrument that
 * COUNTS is what lets these cells testify to calls that must not happen. A real emitter would drag
 * in a WAL, a source and a broker, none of which this class has any opinion about, and would make
 * every absence assertion ambiguous between "the holder did not call it" and "the emitter did not
 * get that far". `agui-emitter.smoke.ts` grades the emitter; this file grades WHEN it exists.
 *
 * WHY THIS FILE EXISTS AT ALL, and it is a sequencing argument rather than a coverage one. The
 * cutover deleted the transcript mirror and put the emitter behind the same hooks. Had the holder
 * been written in that commit, the irreversible step would also have carried a lifecycle nobody had
 * graded, and the two failure modes — "the mapping is wrong" and "the emitter never started" —
 * would have arrived together looking identical from the channel.
 *
 * THE DESIGN CHANGED BECAUSE OF THIS SUITE, AND THEN THE RECORD OF IT WENT STALE. Both halves are
 * worth keeping. The holder first had TWO mechanisms preventing a double start: the serialized
 * chain, and a memo on the in-flight start promise. Both work, and that is the problem: a cell
 * asserting "started exactly once" would have passed with either one broken, so it would have
 * proved neither. The in-flight memo went. What this header then claimed, that the chain is the
 * single mechanism and the `lazy:` cells can now actually fail, was never re-measured. It is wrong.
 *
 * MEASURED AT THIS TIP, one mutation at a time, each run to a full verdict:
 *
 *   the chain de-serialized                  -> SURVIVED, 33 passed 0 failed
 *   the `this.emitter` shortcut removed      -> SURVIVED, 33 passed 0 failed
 *   `boundPath` bound AFTER the await        -> SURVIVED, 33 passed 0 failed
 *   the `boundPath` gate forced always-taken -> SURVIVED, 33 passed 0 failed
 *   shortcut removed AND gate forced         -> KILLED both `lazy:` cells
 *   the `this.emitter =` assignment dropped  -> KILLED both `CONTROL:` cells
 *
 * So start-once is held by the `boundPath` gate, and the shortcut and the trailing
 * `return this.emitter` answer for each other on every sequential call this surface can make. It is
 * the same masking the M5/M7 pair below documents, found a second time in the same file, which is
 * the argument for measuring a claim like this one rather than carrying it forward.
 *
 * AND THE FIRST CONCLUSION DRAWN FROM THAT TABLE WAS ALSO WRONG, WHICH IS WORTH LEAVING IN. It said
 * no mutation could be registered, because `scripts/mutation-proof.mjs` takes one find and one
 * replace per mutation. That treated "one find/replace" as "one site", and the two sites here are
 * ADJACENT: a single contiguous span covers the shortcut and the gate together, which is a legal
 * mutation and kills. A reviewer proved it with the shipped tool instead of arguing it. It is
 * registered as H1 in `mutations/agui-holder.json`, reds this file's two `lazy:` cells, and
 * `expectRed` names the first while the config states the second. Claiming a property cannot be
 * graded is a claim like any other, and this one was false.
 *
 * KILL SET — predicted as NAMES before the run, with what actually happened recorded rather than
 * the prediction restated. Each mutation was verified present in the file that RUNS (the suite
 * imports `../src/agui-holder.js`, so a source edit is the code under test) before its run.
 *
 *   M1  drop the empty-path guard -> KILLED `pump:a-flush-with-NO-usable-path-starts-nothing`
 *       and `pump:a-flush-with-NO-usable-path-pumps-nothing`. As predicted.
 *   M2  drop the started-emitter memo, the `this.emitter =` assignment -> KILLED
 *       `CONTROL:a-holder-that-adopted-reports-running` and `CONTROL:a-healthy-flush-DOES-call-pump`.
 *       NOT the two `lazy:` cells this line claimed for it until the table above was measured: a
 *       holder that never memoizes still starts exactly once, because the gate is what stops the
 *       second start and the memo only decides what a later caller gets back. Corrected in place
 *       rather than deleted, because the wrong version is the one a reader would have acted on.
 *   M3  re-adopt a different path instead of refusing -> KILLED the three `rebind:` REFUSAL cells.
 *       It did NOT kill `rebind:a-refused-rebind-starts-NO-second-emitter` or
 *       `rebind:the-holder-stays-bound-to-the-FIRST-path`, and that is the lesson rather than a
 *       gap: both are OUTCOME cells, and the outcome survives because the memo returns the existing
 *       emitter whether or not the guard ran. **They would have reported this guard working while it
 *       was deleted.** The refusal cells are the ones grading it.
 *   M4  swallow a failed start -> KILLED five, two more than predicted:
 *       `failure:a-failed-start-REACHES-the-error-sink`, `failure:the-sink-gets-the-ORIGINAL-error`,
 *       `failure:the-failure-is-READABLE-from-the-holder`,
 *       `failure:the-FIRST-failure-is-kept-not-the-latest`, `hook:the-failure-still-arrived-at-the-sink`.
 *   M6  pump a stopped emitter -> KILLED `pump:a-STOPPED-emitter-is-not-pumped`. As predicted.
 *
 * **M5 AND M7 EACH SURVIVED ALONE, AND THE REASON IS THAT THEY MASK EACH OTHER.**
 *   M5  keep the LATEST failure (drop `die()`'s first-wins guard) -> SURVIVED, 33/33.
 *   M7  drop `ensureStarted`'s dead short-circuit                 -> SURVIVED, 33/33.
 *   M5+M7 together -> KILLED `failure:the-FIRST-failure-is-kept-not-the-latest` and
 *       `failure:a-dead-holder-reports-ONE-failure-not-a-cascade` (2 errors instead of 1).
 *
 * The M5 survival was INSTRUMENTED rather than argued: a probe in `die()` showed it runs 4 times
 * across this suite and that ZERO of those arrive with `dead` already set — so the guard never
 * fires, the mutation provably executed, and it is an EQUIVALENT MUTANT under current reachability
 * rather than a hole. It is only reachable once M7's short-circuit is also gone, at which point the
 * rebind refusal fires on an already-dead holder and the second error appears. Two guards, one
 * outcome: **neither single mutation can be killed, and a suite that ran only single mutations
 * would have called both of them proven.**
 *
 * A related honest note on `failure:a-failed-start-is-TERMINAL`: it survives M4 and M7 because
 * terminality is actually held by `boundPath` already being set, not by the `dead` flag. It is a
 * true assertion about the holder and a weak one about any single line of it.
 *
 * THE CONTROLS ARE THE INVERSE PREDICATE, not extra coverage. Six cells here assert that something
 * did NOT happen — no start, no pump, no second emitter. A holder that is simply broken and never
 * does anything satisfies every one of them. Each is therefore paired with a control that drives
 * the SAME surface down the working path and asserts the call DID happen, and the refusal helper
 * gets a control proving it cannot pass on a different refusal.
 *
 * Set COTAL_SMOKE_VERBOSE=1 to print passing cell names. The other suites here print only on
 * failure, which means a green total names nothing and cannot show that a NEW cell ran at all.
 */
import { AguiEmitterHolder } from "../src/agui-holder.js";
import type { AguiEmitter } from "../src/agui.js";

let ok = 0,
  fail = 0;
const VERBOSE = process.env.COTAL_SMOKE_VERBOSE === "1";
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) {
    ok++;
    if (VERBOSE) console.log("  . PASS:", n);
  } else {
    fail++;
    console.log("  x FAIL:", n, extra ?? "");
  }
};

/**
 * A refusal cell that asserts WHICH refusal.
 *
 * `needle` must appear in the message. A refusal helper that only checks "something was recorded"
 * passes on any failure at all, including one caused by the cell's own setup — so the two cases it
 * exists to separate (refused because correct, refused because broken) look the same to it.
 */
const refusedWith = (e: Error | undefined, needle: string): boolean =>
  e !== undefined && e.message.includes(needle);

/** The emitter stand-in: counts pumps, and can be stopped. */
class FakeEmitter {
  pumps = 0;
  stopped = false;
  async pump(): Promise<{ frames: number; events: number }> {
    this.pumps++;
    return { frames: 1, events: 1 };
  }
}

/** A holder plus the instruments around it. `starts` is the count that most cells turn on. */
const rig = (opts?: { fail?: Error; emitter?: FakeEmitter }) => {
  const errors: Error[] = [];
  const paths: string[] = [];
  const emitter = opts?.emitter ?? new FakeEmitter();
  let starts = 0;
  const holder = new AguiEmitterHolder<unknown>(
    async (path: string) => {
      starts++;
      paths.push(path);
      if (opts?.fail) throw opts.fail;
      return emitter as unknown as AguiEmitter<unknown>;
    },
    (e) => errors.push(e),
  );
  return {
    holder,
    emitter,
    errors,
    paths,
    get starts() {
      return starts;
    },
  };
};

const A = "/tmp/session-a.jsonl";
const B = "/tmp/session-b.jsonl";

// ---- LAZY -----------------------------------------------------------------------------------
{
  const r = rig();
  await r.holder.settled();
  c("lazy:construction-starts-NOTHING", r.starts === 0, r.starts);
  c("lazy:construction-is-not-running", !r.holder.running);
  c("lazy:construction-has-bound-no-path", r.holder.path === undefined, r.holder.path);
}

{
  const r = rig();
  r.holder.adopt(A);
  await r.holder.settled();
  // CONTROL for every "starts NOTHING" cell above: same surface, working path, call DID happen.
  c("CONTROL:a-valid-adopt-DOES-call-the-start-function", r.starts === 1, r.starts);
  c("lazy:the-first-adopt-binds-the-path-it-was-given", r.holder.path === A, r.holder.path);
  c("lazy:the-first-adopt-starts-the-emitter-on-THAT-path", r.paths[0] === A, r.paths);
  c("CONTROL:a-holder-that-adopted-reports-running", r.holder.running);
}

{
  const r = rig();
  r.holder.adopt(A);
  r.holder.adopt(A);
  r.holder.adopt(A);
  await r.holder.settled();
  c("lazy:a-second-adopt-of-the-SAME-path-does-not-start-a-second", r.starts === 1, r.starts);
}

{
  const r = rig();
  r.holder.adopt(A);
  r.holder.flush(A);
  await r.holder.settled();
  c("lazy:a-flush-after-an-adopt-does-not-start-a-second", r.starts === 1, r.starts);
}

{
  // A flush with no prior adopt is the mirror's behaviour too: it adopts, then flushes.
  const r = rig();
  r.holder.flush(A);
  await r.holder.settled();
  c("lazy:a-flush-with-no-prior-adopt-starts-the-emitter-itself", r.starts === 1, r.starts);
}

// ---- PUMP -----------------------------------------------------------------------------------
{
  const r = rig();
  r.holder.flush(A);
  await r.holder.settled();
  c("CONTROL:a-healthy-flush-DOES-call-pump", r.emitter.pumps === 1, r.emitter.pumps);
}

{
  const r = rig();
  r.holder.adopt(A);
  await r.holder.settled();
  c("pump:an-ADOPT-does-not-pump", r.emitter.pumps === 0, r.emitter.pumps);
}

{
  const r = rig();
  r.holder.flush(undefined);
  r.holder.flush("");
  await r.holder.settled();
  c("pump:a-flush-with-NO-usable-path-starts-nothing", r.starts === 0, r.starts);
  c("pump:a-flush-with-NO-usable-path-pumps-nothing", r.emitter.pumps === 0, r.emitter.pumps);
}

{
  const stopped = new FakeEmitter();
  const r = rig({ emitter: stopped });
  r.holder.adopt(A);
  await r.holder.settled();
  stopped.stopped = true; // the emitter halted itself, as it does on a duplicate ack or CAS loss
  r.holder.flush(A);
  await r.holder.settled();
  c("pump:a-STOPPED-emitter-is-not-pumped", stopped.pumps === 0, stopped.pumps);
  c("pump:a-STOPPED-emitter-is-not-reported-running", !r.holder.running);
}

// ---- REBIND ---------------------------------------------------------------------------------
{
  const r = rig();
  r.holder.adopt(A);
  await r.holder.settled();
  r.holder.adopt(B);
  await r.holder.settled();
  c("rebind:a-DIFFERENT-path-is-REFUSED", r.errors.length === 1, r.errors.map((e) => e.message));
  c(
    "rebind:the-refusal-NAMES-both-transcripts",
    refusedWith(r.errors[0], A) && refusedWith(r.errors[0], B),
    r.errors[0]?.message,
  );
  c(
    "rebind:the-refusal-says-WHY-not-merely-that-it-refused",
    refusedWith(r.errors[0], "write-ahead log"),
    r.errors[0]?.message,
  );
  c("rebind:a-refused-rebind-starts-NO-second-emitter", r.starts === 1, r.starts);
  c("rebind:the-holder-stays-bound-to-the-FIRST-path", r.holder.path === A, r.holder.path);
}

{
  // CONTROL for the refusal helper itself: it must NOT pass on a different refusal. Without this,
  // `refusedWith` is satisfied by any error at all and the three cells above grade nothing.
  const wrong = new Error("event WAL belongs to a different principal");
  c("CONTROL:the-refusal-helper-FAILS-on-a-DIFFERENT-refusal", !refusedWith(wrong, "write-ahead log"));
  c(
    "CONTROL:the-refusal-helper-PASSES-on-the-one-under-test",
    refusedWith(new Error("needs its own write-ahead log"), "write-ahead log"),
  );
}

// ---- FAILURE --------------------------------------------------------------------------------
{
  const boom = new Error("preflight refused: stream is R3");
  const r = rig({ fail: boom });
  r.holder.adopt(A);
  await r.holder.settled();
  c("failure:a-failed-start-REACHES-the-error-sink", r.errors.length === 1, r.errors.length);
  c("failure:the-sink-gets-the-ORIGINAL-error", r.errors[0] === boom, r.errors[0]?.message);
  c("failure:a-failed-start-is-not-reported-running", !r.holder.running);
  c("failure:the-failure-is-READABLE-from-the-holder", r.holder.failure === boom);

  const before = r.starts;
  r.holder.flush(A);
  r.holder.flush(A);
  await r.holder.settled();
  c("failure:a-failed-start-is-TERMINAL", r.starts === before, `${before} -> ${r.starts}`);
  c("failure:a-dead-holder-does-not-pump", r.emitter.pumps === 0, r.emitter.pumps);
}

{
  const first = new Error("FIRST failure");
  const r = rig({ fail: first });
  r.holder.adopt(A);
  await r.holder.settled();
  r.holder.adopt(B); // would raise the rebind refusal, were the holder not already dead
  await r.holder.settled();
  c("failure:the-FIRST-failure-is-kept-not-the-latest", r.holder.failure === first, r.holder.failure?.message);
  c("failure:a-dead-holder-reports-ONE-failure-not-a-cascade", r.errors.length === 1, r.errors.length);
}

// ---- THE HOOK CONTRACT ----------------------------------------------------------------------
{
  // adopt/flush run behind a hook that must reply immediately and must not see an exception. These
  // assert the SYNCHRONOUS contract: the call returns, having thrown nothing, before any await.
  const r = rig({ fail: new Error("start explodes") });
  let threw: Error | undefined;
  try {
    r.holder.adopt(A);
    r.holder.flush(A);
  } catch (e) {
    threw = e as Error;
  }
  c("hook:adopt-and-flush-throw-NOTHING-into-the-caller", threw === undefined, threw?.message);
  await r.holder.settled();
  c("hook:the-failure-still-arrived-at-the-sink", r.errors.length === 1, r.errors.length);
}

console.log(`agui-holder smoke: ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
