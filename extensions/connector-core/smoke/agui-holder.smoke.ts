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
import type { AguiEmitter, HeldTerminal, ReportedTerminal } from "../src/agui-emitter.js";

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

/** The source stand-in: a count of records written, and the turns among them with the position
 *  each began at. The holder takes the position at every terminal, and a pump reads the turns
 *  written since the last pump that read. */
class FakeSource {
  written = 0;
  turns: { turn: string | null; at: number }[] = [];
  /** Write a record: one that begins a turn, as the run it opens or `null` for one that opens
   *  none, or a record that begins no turn. */
  write(turn?: string | null): void {
    this.written++;
    if (turn !== undefined) this.turns.push({ turn, at: this.written });
  }
  end(): Promise<string> {
    return Promise.resolve(String(this.written));
  }
}

/** The emitter stand-in: counts pumps, can be stopped, and can be told which pumps fail. A pump
 *  that fails leaves the emitter as it was, which is what a real one does on a failed publish:
 *  the frame stays frozen pending and every later pump refuses it until a start settles it. A pump
 *  that returns places the terminals it was handed as the real one does: each on the last turn
 *  begun at or before the position it was reported at, the open run when none was. */
class FakeEmitter {
  pumps = 0;
  stopped = false;
  /** The 1-based pump calls that fail. */
  failOn = new Set<number>();
  /** The run a close would close now, as the real emitter reports it. */
  openRunId: string | undefined;
  /** Every close, in order, with the pump count when it ran. */
  closes: { pumpsBefore: number; runId?: string; error?: { message: string; code?: string } }[] = [];
  /** The 1-based close calls that fail before anything is written, leaving the run open. */
  failClose = new Set<number>();
  closeCalls = 0;
  /** Every terminal handed to this emitter, with the pump count when it was and whether a pump was
   *  in progress. A log: the ones no pump has placed are `waiting`, the ones placed on runs `debts`. */
  queued: { terminal: HeldTerminal; pumpsBefore: number; duringPump: boolean }[] = [];
  waiting: ReportedTerminal[] = [];
  debts = new Map<string, ReportedTerminal>();
  /** The last turn begun, as the real emitter keeps it: the open run until a pump reads a turn or a
   *  seed says otherwise. */
  private lastTurn: { turn: string | null | undefined } | undefined;
  seeded: { turn: string | null | undefined } | undefined;
  /** Every run a pump closed itself, under the next prompt, with the owed error if one was owed. */
  pumpClosed: { runId: string; error?: { message: string; code?: string } }[] = [];
  /** Awaited at the top of the next pump, once: that pump is IN PROGRESS until released, and its
   *  read sees what is written before the release. */
  pumpGate: Promise<void> | undefined;
  /** Awaited after the next pump's read, once: that pump has READ and is publishing until
   *  released, so what is written before the release is past its read. */
  readGate: Promise<void> | undefined;
  inPump = false;
  /** The source this emitter reads, set by the rig: shared by every emitter it makes. */
  source = new FakeSource();
  get waitingTerminals(): number {
    return this.waiting.length;
  }
  queueTerminal(entry: ReportedTerminal): void {
    entry.at.catch(() => undefined);
    this.waiting.push(entry);
    this.queued.push({ terminal: entry.terminal, pumpsBefore: this.pumps, duringPump: this.inPump });
  }
  takeOwed(runId: string): ReportedTerminal | undefined {
    const entry = this.debts.get(runId);
    this.debts.delete(runId);
    return entry;
  }
  unsettled(): { terminals: ReportedTerminal[]; lastTurn: string | null | undefined } {
    return { terminals: [...this.debts.values(), ...this.waiting], lastTurn: this.last() };
  }
  seedLastTurn(turn: string | null | undefined): void {
    if (this.pumps > 0) throw new Error("the last turn can only be seeded before the first pump");
    this.seeded = { turn };
    this.lastTurn = { turn };
  }
  private last(): string | null | undefined {
    return this.lastTurn ? this.lastTurn.turn : this.openRunId;
  }
  async pump(): Promise<{ frames: number; events: number }> {
    this.pumps++;
    this.inPump = true;
    try {
      if (this.pumpGate) {
        const gate = this.pumpGate;
        this.pumpGate = undefined;
        await gate;
      }
      if (this.failOn.has(this.pumps)) throw new Error(`pump ${this.pumps} failed: a frame is still pending`);
      const end = this.source.written;
      const read = this.source.turns.splice(0);
      if (this.readGate) {
        const gate = this.readGate;
        this.readGate = undefined;
        await gate;
      }
      for (const entry of [...this.waiting]) {
        const at = Number(await entry.at);
        if (at > end) continue; // reported past this read: the next pump places it
        this.waiting = this.waiting.filter((w) => w !== entry);
        let turn = this.last();
        for (const t of read) if (t.at <= at) turn = t.turn;
        if (turn === undefined || turn === null || this.debts.has(turn)) continue;
        if (turn !== this.openRunId && !read.some((t) => t.turn === turn)) continue;
        this.debts.set(turn, entry);
      }
      for (const t of read) {
        if (t.turn !== null) {
          // The next prompt closes the open run: with its owed error, or as a finish.
          const open = this.openRunId;
          if (open !== undefined) {
            const owed = this.debts.get(open);
            this.debts.delete(open);
            this.pumpClosed.push({ runId: open, ...(owed?.terminal.error ? { error: owed.terminal.error } : {}) });
          }
          this.openRunId = t.turn;
        }
        this.lastTurn = { turn: t.turn };
      }
      return { frames: 1, events: 1 };
    } finally {
      this.inPump = false;
    }
  }
  async closeRun(o: { timestamp: number; error?: { message: string; code?: string } }): Promise<string | null> {
    this.closeCalls++;
    if (this.failClose.has(this.closeCalls)) throw new Error(`close ${this.closeCalls} failed: the log directory is not writable`);
    const run = this.openRunId;
    this.closes.push({ pumpsBefore: this.pumps, ...(run === undefined ? {} : { runId: run }), ...(o.error ? { error: o.error } : {}) });
    if (run !== undefined) this.debts.delete(run);
    this.openRunId = undefined;
    return run ?? null;
  }
}

/** A holder plus the instruments around it. `starts` is the count that most cells turn on.
 *  `make` hands each start its own emitter, as a real factory does; without it every start
 *  returns the one shared `emitter`. */
const rig = (opts?: {
  fail?: Error;
  failTimes?: number;
  /** The 1-based starts that fail on their own, with the others succeeding. */
  failStarts?: Set<number>;
  emitter?: FakeEmitter;
  retryMs?: number;
  make?: (start: number) => FakeEmitter;
  /** Awaited inside the start, by start number: a start held here is IN FLIGHT until released. */
  gate?: (start: number) => Promise<void>;
}) => {
  const errors: Error[] = [];
  const delays: (number | null)[] = [];
  const paths: string[] = [];
  const contexts: unknown[] = [];
  const made: FakeEmitter[] = [];
  const emitter = opts?.emitter ?? new FakeEmitter();
  const src = new FakeSource();
  let starts = 0;
  const holder = new AguiEmitterHolder<unknown, string>(
    async (path: string, context) => {
      starts++;
      paths.push(path);
      contexts.push(context);
      // `failTimes` fails the first N starts and lets the rest succeed; `fail` alone fails every one.
      if (opts?.fail && (opts.failTimes === undefined || starts <= opts.failTimes)) throw opts.fail;
      if (opts?.failStarts?.has(starts)) throw new Error(`start ${starts} failed: the broker preflight was refused`);
      if (opts?.gate) await opts.gate(starts);
      const e = opts?.make ? opts.make(starts) : emitter;
      e.source = src;
      made.push(e);
      return e as unknown as AguiEmitter<unknown>;
    },
    {
      onError: (e, retryInMs) => {
        errors.push(e);
        delays.push(retryInMs);
      },
      sourceEnd: () => src.end(),
      ...(opts?.retryMs !== undefined ? { retryMs: opts.retryMs } : {}),
    },
  );
  return {
    holder,
    emitter,
    made,
    /** Write a record to the source: one that begins a turn (the run it opens, or `null` for one
     *  that opens none), or one that begins no turn. */
    write: (turn?: string | null) => src.write(turn),
    errors,
    delays,
    paths,
    contexts,
    get starts() {
      return starts;
    },
  };
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

// ---- FIRST-ADOPT CONTEXT --------------------------------------------------------------------
{
  const contexts: unknown[] = [];
  const emitter = new FakeEmitter();
  const holder = new AguiEmitterHolder<unknown, string>(
    async (_path, context) => {
      contexts.push(context);
      return emitter as unknown as AguiEmitter<unknown>;
    },
    { onError: () => {}, sourceEnd: async () => "0" },
  );
  holder.adopt(A, "startup");
  await holder.settled();
  c("context:the-FIRST-adopt-context-reaches-the-start-factory", contexts.length === 1 && contexts[0] === "startup", contexts);
  holder.adopt(A, "resume");
  await holder.settled();
  c("context:a-later-adopt-does-not-restart-or-replace-the-first-context", contexts.length === 1, contexts);
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
  c("rebind:a-holder-killed-by-the-refusal-is-not-reported-running", !r.holder.running, {
    failure: r.holder.failure?.message,
    running: r.holder.running,
  });
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
  c("failure:a-failed-start-is-NOT-retried-on-the-next-hook", r.starts === before, `${before} -> ${r.starts}`);
  c("failure:a-dead-holder-does-not-pump", r.emitter.pumps === 0, r.emitter.pumps);
  await r.holder.close(); // or the default one-second revive timer keeps the process up
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
  await r.holder.close();
}

// ---- RE-ESTABLISH ---------------------------------------------------------------------------
// A failure stops the plane, never the seat: the holder starts the emitter again on its own backoff,
// as the first start ran, and reports every failure with the delay. Measured on 2026-10-12: the
// seat-stop this replaced showed in Claude Code as "MCP server cotal has disconnected", and the
// harness restarted the connector on the next tool call anyway, once per keystroke.
{
  const boom = new Error("preflight refused: stream is R3");
  const r = rig({ fail: boom, failTimes: 1, retryMs: 20 });
  r.holder.adopt(A, "startup");
  await r.holder.settled();
  c("CONTROL:the-first-start-failed-and-was-reported", r.errors.length === 1 && r.starts === 1, { errors: r.errors.length, starts: r.starts });
  c("revive:the-sink-is-told-the-delay-before-the-re-establish", r.delays[0] === 20, r.delays);
  c("revive:nothing-is-retried-before-the-delay", r.starts === 1, r.starts);
  await sleep(60);
  await r.holder.settled();
  c("revive:the-emitter-is-started-again-after-the-delay", r.starts === 2, r.starts);
  c("revive:the-re-establish-uses-the-FIRST-path", r.paths[1] === A, r.paths);
  c("revive:the-re-establish-uses-the-FIRST-adopt-context", r.contexts[1] === "startup", r.contexts);
  c("revive:a-re-established-holder-reports-running", r.holder.running && r.holder.failure === undefined, { running: r.holder.running, failure: r.holder.failure?.message });
  c("revive:the-re-establish-pumps-what-the-outage-left-behind", r.emitter.pumps === 1, r.emitter.pumps);
  r.holder.flush(A);
  await r.holder.settled();
  c("revive:a-later-flush-pumps-the-re-established-emitter", r.emitter.pumps === 2, r.emitter.pumps);
  await r.holder.close();
}

{
  // The delay doubles while the failure repeats, and a success resets it.
  const boom = new Error("broker unreachable");
  const r = rig({ fail: boom, failTimes: 3, retryMs: 10 });
  r.holder.adopt(A);
  await r.holder.settled();
  await sleep(10 + 20 + 40 + 60);
  await r.holder.settled();
  c("revive:the-delay-DOUBLES-per-consecutive-failure", r.delays.slice(0, 3).join(",") === "10,20,40", r.delays);
  c("revive:the-plane-comes-back-after-repeated-failures", r.holder.running && r.starts === 4, { running: r.holder.running, starts: r.starts });
  await r.holder.close();
}

{
  // The cap: a failure that outlives a few retries is paced to a minute, never faster.
  const r = rig({ retryMs: 70_000 });
  r.holder.adopt(A);
  await r.holder.settled();
  r.holder.adopt(B); // the rebind refusal
  await r.holder.settled();
  c("revive:the-delay-is-CAPPED-at-the-ceiling", r.delays[0] === AguiEmitterHolder.RETRY_BACKOFF_CAP_MS, r.delays);
  await r.holder.close();
}

{
  // Every re-establish is a START, whether or not the emitter halted. The rebind refusal kills
  // nothing underneath, and the first cut kept the running emitter for exactly that case; but a
  // failure that leaves the emitter running leaves it running with state the log never accepted,
  // and only a start settles that (the cell after this one). One rule, so the holder never has to
  // guess which kind of failure it saw.
  const r = rig({ retryMs: 10 });
  r.holder.adopt(A);
  await r.holder.settled();
  r.holder.adopt(B);
  await r.holder.settled();
  await sleep(40);
  await r.holder.settled();
  c("revive:a-RUNNING-emitter-is-started-again-too", r.starts === 2 && r.holder.running, { starts: r.starts, running: r.holder.running });
  await r.holder.close();
}

{
  // THE WEDGE THE REBUILD EXISTS FOR. A publish that fails on the wire leaves the frame frozen
  // pending, and every later pump of that emitter refuses to read past it; a write that fails
  // before the freeze leaves the mapper holding a run the log never opened, and the re-read of
  // the same record closes a run the brackets never saw. Measured on 2026-10-12 with the real
  // reader, mapper, log and frontier: with the running emitter kept, both wedged the plane for
  // good behind a retry every minute. Only a start settles either, so the re-establish must be
  // one. Here the first emitter fails every pump from its first on, as the real one does once
  // wedged, and only a fresh emitter from a fresh start can pump.
  const r = rig({
    retryMs: 10,
    make: (start) => {
      const e = new FakeEmitter();
      if (start === 1) for (let i = 1; i <= 50; i++) e.failOn.add(i);
      return e;
    },
  });
  r.holder.adopt(A);
  await r.holder.settled();
  r.holder.flush(A);
  await r.holder.settled();
  c("CONTROL:the-first-emitter-wedged-on-its-first-pump", r.errors.length === 1 && r.starts === 1 && !r.made[0]!.stopped, { errors: r.errors.length, starts: r.starts });
  await sleep(40);
  await r.holder.settled();
  c("revive:a-WEDGED-emitter-is-replaced-by-a-fresh-start", r.starts === 2 && r.holder.running && r.made[1]!.pumps === 1, { starts: r.starts, running: r.holder.running, pumps: r.made.map((e) => e.pumps) });
  c("revive:the-wedged-emitter-is-never-pumped-again", r.made[0]!.pumps === 1, r.made[0]!.pumps);
  await r.holder.close();
}

{
  // The backoff counts failures since the last pump that RETURNED, not failures ever and not
  // failures since the last start. A start reaches the broker only for its preflight, so a broker
  // that refuses every publish passes every start; a reset there would retry every second for as
  // long as the outage lasts. Two outages with a working plane between them each get the base
  // delay (Sol, review of 2026-10-12: the first cut inherited the accumulated delay into an
  // independent later outage).
  const r = rig({
    retryMs: 10,
    make: (start) => {
      const e = new FakeEmitter();
      if (start === 1 || start === 2) e.failOn.add(1); // two starts in a row whose pump fails
      if (start === 3) e.failOn.add(2); // the third pumps once, then a NEW outage
      return e;
    },
  });
  r.holder.adopt(A);
  await r.holder.settled();
  r.holder.flush(A); // start 1 pumps and fails: delay 10
  await r.holder.settled();
  await sleep(15);
  await r.holder.settled(); // start 2's revive pump fails: delay 20, a start passed in between
  await sleep(30);
  await r.holder.settled(); // start 3's revive pump returns: the plane is back
  c("CONTROL:two-failures-with-a-passing-start-between-them", r.starts === 3 && r.holder.running, { starts: r.starts, running: r.holder.running });
  c("revive:a-start-that-passes-does-NOT-reset-the-delay", r.delays.slice(0, 2).join(",") === "10,20", r.delays);
  r.holder.flush(A); // start 3's second pump fails: a new outage after a pump that returned
  await r.holder.settled();
  c("revive:a-pump-that-returns-DOES-reset-the-delay", r.delays[2] === 10, r.delays);
  await r.holder.close();
}

{
  // A TERMINAL THAT ARRIVES WHILE THE PLANE IS DOWN IS HELD. It is not a record in the source, so
  // the re-establish cannot read it back; dropped, the run the log has open stays open on the
  // wire until a later prompt closes it as a finish, the wrong terminal for a failed turn (Sol,
  // review of 2026-10-12: a StopFailure during an outage emitted no RUN_ERROR after recovery and
  // the next assistant record was attributed to the failed run). Applied AFTER the re-establish
  // pump, because the turn's own records were unread when the terminal arrived, and only to the
  // run it names.
  const r = rig({
    retryMs: 10,
    make: (start) => {
      const e = new FakeEmitter();
      e.openRunId = "run-2"; // the frozen frame opened run-2, and the fresh start comes back with it
      if (start === 1) e.failOn.add(1);
      return e;
    },
  });
  r.holder.adopt(A);
  await r.holder.settled();
  r.holder.flush(A); // pump 1 fails: down
  await r.holder.settled();
  r.holder.closeRun(7, { message: "rate_limit", code: "rate_limit" }); // the turn's terminal, while down
  await r.holder.settled();
  c("CONTROL:the-terminal-arrived-while-the-plane-was-down", r.errors.length === 1 && r.made[0]!.closes.length === 0, { errors: r.errors.length, closes: r.made[0]!.closes });
  await sleep(40);
  await r.holder.settled();
  // Read without non-null assertions: a mutation that drops the re-establish or the held close
  // leaves these absent, and a cell that throws on absence stops the suite instead of reddening.
  const fresh = r.made[1];
  c("revive:a-terminal-held-through-the-outage-closes-its-run-after-the-re-establish", fresh?.closes.length === 1 && fresh.closes[0]?.error?.code === "rate_limit" && r.holder.running, { closes: fresh?.closes, running: r.holder.running });
  c("revive:the-held-terminal-is-applied-AFTER-the-re-establish-pump", fresh?.closes[0]?.pumpsBefore === 1 && fresh.pumps === 1, { closes: fresh?.closes, pumps: fresh?.pumps });
  r.write("run-3"); // the next turn, with the plane up, and its terminal: the live path
  r.holder.closeRun(8);
  await r.holder.settled();
  c("revive:a-terminal-after-the-re-establish-closes-the-next-run-on-the-fresh-emitter", fresh?.closes.length === 2 && fresh.closes[1]?.runId === "run-3" && fresh.closes[1]?.error === undefined, fresh?.closes);
  await r.holder.close();
}

{
  // The held terminal names a run. The fresh start coming back with ANOTHER run open means a
  // later prompt among the unread records closed the named one and opened its own, which the
  // terminal must not close; coming back with none means the log never held that run.
  for (const comesBackWith of ["run-3", undefined]) {
    const r = rig({
      retryMs: 10,
      make: (start) => {
        const e = new FakeEmitter();
        e.openRunId = start === 1 ? "run-2" : comesBackWith;
        if (start === 1) e.failOn.add(1);
        return e;
      },
    });
    r.holder.adopt(A);
    await r.holder.settled();
    r.holder.flush(A);
    await r.holder.settled();
    r.holder.closeRun(7, { message: "rate_limit" });
    await sleep(40);
    await r.holder.settled();
    c(`revive:a-held-terminal-is-DROPPED-when-the-fresh-start-comes-back-with-${comesBackWith ?? "no-run"}`, r.made[1]?.closes.length === 0 && r.made[1].pumps === 1 && r.holder.running, { closes: r.made[1]?.closes, running: r.holder.running });
  }
}

{
  // A CLOSE THAT FAILS HOLDS ITS TERMINAL. The plane was up when the terminal arrived, and the
  // close's own log write is what failed (Sol, review of 2026-10-13, through the built MCP entry
  // point: a terminal-only write failure lost the terminal and the next prompt closed the failed
  // run as a finish). The run is still open, so the re-establish owes it the terminal.
  const r = rig({
    retryMs: 10,
    make: () => {
      const e = new FakeEmitter();
      e.openRunId = "run-2";
      return e;
    },
  });
  r.holder.adopt(A);
  await r.holder.settled();
  r.made[0]!.failClose.add(1);
  r.holder.closeRun(7, { message: "rate_limit", code: "rate_limit" }); // the close itself fails
  await r.holder.settled();
  c("CONTROL:the-close-failed-and-killed-the-plane", r.errors.length === 1 && r.made[0]!.closes.length === 0 && !r.holder.running, { errors: r.errors.map((e) => e.message), closes: r.made[0]!.closes });
  await sleep(40);
  await r.holder.settled();
  const fresh = r.made[1];
  c("revive:a-close-that-FAILED-holds-its-terminal-for-the-re-establish", fresh?.closes.length === 1 && fresh.closes[0]?.error?.code === "rate_limit" && fresh.pumps === 1 && r.holder.running, { closes: fresh?.closes, running: r.holder.running });
  await r.holder.close();
}

{
  // EVERY TURN THAT ENDS WHILE THE PLANE IS DOWN KEEPS ITS OWN TERMINAL. The connector reports a
  // turn's terminal once its records are in the source and before the next turn's are, so the
  // position the source had reached at each terminal names its turn: the first is the open run's,
  // the second the next prompt's, which the fresh emitter's pump finds in the unread records. Held
  // for the one run that was open when the plane went down, the second turn's terminal was dropped
  // as a repeat of the first, and the next prompt closed that failed turn as a finish (Sol, round
  // 10 of 2026-10-13, through the built MCP entry point).
  const r = rig({
    retryMs: 10,
    make: (start) => {
      const e = new FakeEmitter();
      e.openRunId = "run-2";
      if (start === 1) e.failOn.add(1);
      return e;
    },
  });
  r.holder.adopt(A);
  await r.holder.settled();
  r.holder.flush(A); // down
  await r.holder.settled();
  r.holder.closeRun(7, { message: "rate_limit", code: "rate_limit" }); // run-2's turn fails
  r.write("run-3"); // the next prompt and its answer, written while down
  r.holder.closeRun(8, { message: "overloaded", code: "overloaded" }); // the next turn fails too
  await r.holder.settled();
  await sleep(40);
  await r.holder.settled();
  const fresh = r.made[1];
  c("revive:the-first-terminal-of-the-outage-closes-the-run-that-was-open", fresh?.pumpClosed.length === 1 && fresh.pumpClosed[0]?.runId === "run-2" && fresh.pumpClosed[0]?.error?.code === "rate_limit", fresh?.pumpClosed);
  c("revive:the-second-terminal-of-the-outage-closes-the-NEXT-turns-run-with-its-own-error", fresh?.closes.length === 1 && fresh.closes[0]?.runId === "run-3" && fresh.closes[0]?.error?.code === "overloaded" && fresh.openRunId === undefined && r.holder.running, { closes: fresh?.closes, open: fresh?.openRunId });
  await r.holder.close();
}

{
  // A TURN THAT OPENS NO RUN STILL TAKES ITS TERMINAL. Four turns end while the plane is down: the
  // open run's, the next prompt's, one the source begins and the mapper opens no run for (a
  // harness notification the connector deliberately does not publish), and a fourth that opens a
  // run. The third terminal, a finish, is placed on the turn that opened nothing and does nothing,
  // as a close with no run open does live; the fourth closes the fourth turn's run with its own
  // error. Placed on runs instead of turns, the finish would land on the fourth run and its error
  // would be lost.
  const r = rig({
    retryMs: 10,
    make: (start) => {
      const e = new FakeEmitter();
      e.openRunId = "run-2";
      if (start === 1) e.failOn.add(1);
      return e;
    },
  });
  r.holder.adopt(A);
  await r.holder.settled();
  r.holder.flush(A); // down
  await r.holder.settled();
  r.holder.closeRun(7, { message: "rate_limit", code: "rate_limit" }); // run-2's turn
  r.write("run-3");
  r.holder.closeRun(8); // run-3's turn finishes
  r.write(null); // a turn the mapper opens no run for
  r.holder.closeRun(9); // the turn that opens no run finishes
  r.write("run-4");
  r.holder.closeRun(10, { message: "overloaded", code: "overloaded" }); // run-4's turn fails
  await r.holder.settled();
  await sleep(40);
  await r.holder.settled();
  const fresh = r.made[1];
  c("revive:the-pump-closes-each-earlier-run-with-its-own-terminal", fresh?.pumpClosed.map((p) => p.runId + ":" + (p.error?.code ?? "finish")).join(",") === "run-2:rate_limit,run-3:finish", fresh?.pumpClosed);
  c("revive:a-turn-that-opened-no-run-takes-its-terminal-and-the-run-after-it-gets-its-own", fresh?.closes.length === 1 && fresh.closes[0]?.runId === "run-4" && fresh.closes[0]?.error?.code === "overloaded" && fresh.waiting.length === 0 && fresh.debts.size === 0 && r.holder.running, { closes: fresh?.closes, waiting: fresh?.waiting.length, debts: [...(fresh?.debts.keys() ?? [])] });
  await r.holder.close();
}

{
  // A terminal reported PAST THE RECOVERY READ stays waiting at the emitter, and the pump the
  // settle runs after it places it: the terminal arrived after the recovery read, for a turn whose
  // records were written after that read. Nothing is lost and nothing is closed early.
  let release: (() => void) | undefined;
  let armed = false;
  const r = rig({
    retryMs: 10,
    make: (start) => {
      const e = new FakeEmitter();
      e.openRunId = "run-2";
      if (start === 1) e.failOn.add(1);
      else if (armed) {
        armed = false;
        e.readGate = new Promise<void>((res) => (release = res));
      }
      return e;
    },
  });
  r.holder.adopt(A);
  await r.holder.settled();
  r.holder.flush(A); // down
  await r.holder.settled();
  r.holder.closeRun(7); // run-2's turn finishes
  armed = true;
  await sleep(40); // the retry fires, the fresh start returns, and its pump has read and is held
  const fresh = r.made[1];
  c("CONTROL:the-recovery-pump-is-in-progress-with-the-finish-waiting", r.starts === 2 && fresh?.inPump === true && fresh.waiting.length === 1, { starts: r.starts, inPump: fresh?.inPump, waiting: fresh?.waiting.length });
  r.write("run-3"); // the next turn's records, and its terminal, past the read in progress
  r.holder.closeRun(8, { message: "overloaded", code: "overloaded" });
  release?.();
  await r.holder.settled();
  c("revive:a-terminal-reported-past-the-recovery-read-is-placed-by-the-pump-after-it", fresh?.pumps === 2 && fresh.closes.length === 1 && fresh.closes[0]?.runId === "run-3" && fresh.closes[0]?.error?.code === "overloaded" && fresh.waiting.length === 0 && r.holder.running, { pumps: fresh?.pumps, closes: fresh?.closes, waiting: fresh?.waiting.length });
  c("revive:the-finish-reported-before-it-closed-run-2-under-the-next-prompt", fresh?.pumpClosed.length === 1 && fresh.pumpClosed[0]?.runId === "run-2" && fresh.pumpClosed[0]?.error === undefined, fresh?.pumpClosed);
  await r.holder.close();
}

{
  // A TERMINAL A DYING EMITTER STILL HELD IS CARRIED TO THE FRESH ONE. The recovery handed the
  // next turn's terminal to the fresh emitter, whose pump then failed before reading that turn:
  // the holder takes the terminal back from the emitter it drops, and the re-establish after that
  // hands it on again.
  const r = rig({
    retryMs: 10,
    make: (start) => {
      const e = new FakeEmitter();
      e.openRunId = "run-2";
      if (start === 1) e.failOn.add(1);
      if (start === 2) e.failOn.add(1); // the recovery pump fails again
      return e;
    },
  });
  r.holder.adopt(A);
  await r.holder.settled();
  r.holder.flush(A); // down
  await r.holder.settled();
  r.holder.closeRun(7, { message: "rate_limit", code: "rate_limit" });
  r.write("run-3");
  r.holder.closeRun(8, { message: "overloaded", code: "overloaded" });
  await sleep(40);
  await r.holder.settled();
  c("CONTROL:the-second-re-establish-took-both-terminals-and-its-pump-failed", r.made[1]?.queued.length === 2 && r.made[1]?.waiting.length === 2 && r.errors.length === 2, { queued: r.made[1]?.queued, errors: r.errors.length });
  await sleep(60);
  await r.holder.settled();
  const third = r.made[2];
  c("revive:the-terminals-a-dying-emitter-held-reach-the-next-one-in-order", third?.pumpClosed[0]?.runId === "run-2" && third.pumpClosed[0]?.error?.code === "rate_limit" && third.closes[0]?.runId === "run-3" && third.closes[0]?.error?.code === "overloaded" && r.holder.running, { pumpClosed: third?.pumpClosed, closes: third?.closes, starts: r.starts });
  await r.holder.close();
}

{
  // A held terminal whose close fails AT the re-establish stays held, and the next re-establish
  // applies it. Releasing the hold before a close that can fail would lose it.
  const r = rig({
    retryMs: 10,
    make: (start) => {
      const e = new FakeEmitter();
      e.openRunId = "run-2";
      if (start === 1) e.failOn.add(1);
      if (start === 2) e.failClose.add(1); // the fresh emitter's log is still unwritable for the close
      return e;
    },
  });
  r.holder.adopt(A);
  await r.holder.settled();
  r.holder.flush(A);
  await r.holder.settled();
  r.holder.closeRun(7, { message: "rate_limit", code: "rate_limit" });
  await sleep(40);
  await r.holder.settled();
  c("CONTROL:the-held-close-failed-at-the-first-re-establish", r.made[1]?.closes.length === 0 && r.errors.length === 2, { closes: r.made[1]?.closes, errors: r.errors.length });
  await sleep(60);
  await r.holder.settled();
  c("revive:a-held-close-that-fails-at-the-re-establish-is-applied-by-the-NEXT", r.made[2]?.closes.length === 1 && r.made[2].closes[0]?.error?.code === "rate_limit" && r.holder.running, { closes: r.made[2]?.closes, starts: r.starts, running: r.holder.running });
  await r.holder.close();
}

{
  // A HELD ERROR IS HANDED TO THE EMITTER BEFORE THE PUMP. The unread records may hold the next
  // prompt, whose mapping closes the held run as a finish; the emitter publishes the owed error in
  // that finish's place (Sol, review of 2026-10-13, through the built MCP entry point: the error
  // was dropped behind the synthesized finish). Here the fresh emitter's pump finds the next prompt
  // and closes run-2 itself, so the holder's own close must not run and the hold is released.
  const r = rig({
    retryMs: 10,
    make: (start) => {
      const e = new FakeEmitter();
      e.openRunId = "run-2";
      if (start === 1) e.failOn.add(1);
      return e;
    },
  });
  r.holder.adopt(A);
  await r.holder.settled();
  r.holder.flush(A);
  await r.holder.settled();
  r.holder.closeRun(7, { message: "rate_limit", code: "rate_limit" });
  r.write("run-3"); // the next prompt, written while down
  await sleep(40);
  await r.holder.settled();
  const fresh = r.made[1];
  c("revive:a-held-ERROR-is-handed-to-the-fresh-emitter-BEFORE-the-pump", fresh?.queued.length === 1 && fresh.queued[0]?.terminal.error?.code === "rate_limit" && fresh.queued[0]?.pumpsBefore === 0 && fresh.pumpClosed[0]?.runId === "run-2" && fresh.pumpClosed[0]?.error?.code === "rate_limit", { queued: fresh?.queued, pumpClosed: fresh?.pumpClosed });
  c("revive:a-run-the-pump-closed-with-the-owed-terminal-is-not-closed-again", fresh?.closes.length === 0 && fresh.openRunId === "run-3" && r.holder.running, { closes: fresh?.closes, open: fresh?.openRunId });
  r.holder.closeRun(9); // the next run's own terminal, with the plane up
  await r.holder.settled();
  c("revive:the-released-hold-does-not-reach-the-next-run", fresh?.closes.length === 1 && fresh.closes[0]?.error === undefined, fresh?.closes);
  await r.holder.close();
}

{
  // A held FINISH owes nothing: the finish a later prompt synthesizes is the same terminal.
  const r = rig({
    retryMs: 10,
    make: (start) => {
      const e = new FakeEmitter();
      e.openRunId = "run-2";
      if (start === 1) e.failOn.add(1);
      return e;
    },
  });
  r.holder.adopt(A);
  await r.holder.settled();
  r.holder.flush(A);
  await r.holder.settled();
  r.holder.closeRun(7);
  await sleep(40);
  await r.holder.settled();
  c("revive:a-held-FINISH-is-handed-over-too-and-closes-the-run-after-the-pump", r.made[1]?.queued.length === 1 && r.made[1]?.queued[0]?.terminal.error === undefined && r.made[1]?.closes.length === 1 && r.made[1]?.closes[0]?.error === undefined, { queued: r.made[1]?.queued, closes: r.made[1]?.closes });
  await r.holder.close();
}

{
  // THE BACKOFF RESETS ONLY ONCE THE WHOLE RE-ESTABLISH HAS GONE THROUGH, the owed terminal
  // included. A terminal whose write keeps failing behind a pump that reads nothing was retried
  // every second for as long as the failure lasted (Sol, review of 2026-10-13: five delays of one
  // second under a terminal-only write failure held for four seconds).
  const r = rig({
    retryMs: 10,
    make: () => {
      const e = new FakeEmitter();
      e.openRunId = "run-2";
      e.failClose.add(1); // every emitter's first close fails: the log stays unwritable
      return e;
    },
  });
  r.holder.adopt(A);
  await r.holder.settled();
  r.holder.closeRun(7, { message: "rate_limit", code: "rate_limit" }); // fails: delay 10
  await r.holder.settled();
  await sleep(15);
  await r.holder.settled(); // re-establish 1: empty pump, held close fails: delay 20
  await sleep(30);
  await r.holder.settled(); // re-establish 2: the same: delay 40
  c("revive:the-delay-DOUBLES-while-the-held-close-keeps-failing", r.delays.slice(0, 3).join(",") === "10,20,40", r.delays);
  await r.holder.close();
}

{
  // THE LAST TURN BEGUN IS CARRIED ACROSS THE RE-ESTABLISH. The plane goes down after a turn the
  // mapper opened no run for was published, with the earlier run still open on the wire, and that
  // turn's terminal arrives while down. Placed on the last turn begun, it is taken by the turn that
  // opened nothing and closes nothing; placed on the open run, which is all a fresh emitter can see
  // in the log, it would close the earlier run with a terminal that was never its own.
  const r = rig({
    retryMs: 10,
    make: (start) => {
      const e = new FakeEmitter();
      e.openRunId = "run-2";
      if (start === 1) e.failOn.add(2);
      return e;
    },
  });
  r.holder.adopt(A);
  await r.holder.settled();
  r.write(null); // a turn that opens no run
  r.holder.flush(A); // pump 1 publishes it: the last turn begun opened nothing
  await r.holder.settled();
  r.holder.flush(A); // pump 2 fails: down
  await r.holder.settled();
  r.holder.closeRun(7); // the finish of the turn that opened nothing, while down
  await sleep(40);
  await r.holder.settled();
  const fresh = r.made[1];
  c("revive:the-last-turn-begun-is-carried-so-a-terminal-for-a-turn-that-opened-no-run-closes-nothing", fresh?.seeded?.turn === null && fresh.closes.length === 0 && fresh.debts.size === 0 && fresh.waiting.length === 0 && r.holder.running, { seeded: fresh?.seeded, closes: fresh?.closes, debts: [...(fresh?.debts.keys() ?? [])], running: r.holder.running });
  await r.holder.close();
}

{
  // THE LIVE PATH PLACES BY POSITION TOO. A turn's terminal is reported while the flush before it
  // is still pumping, and the next prompt is written before that pump reads. The pump reads the
  // prompt, which closes the turn's run and opens the next; a close of whatever run is open when
  // the terminal's step runs would end the NEXT run with this turn's terminal. Handed to the
  // emitter at the hook, with its position, the terminal closes its own turn under the prompt and
  // the next run opens clean.
  let release: (() => void) | undefined;
  const e = new FakeEmitter();
  e.openRunId = "run-2";
  e.pumpGate = new Promise<void>((res) => (release = res));
  const r = rig({ emitter: e });
  r.holder.adopt(A);
  await r.holder.settled();
  r.holder.flush(A); // the flush's pump is held at its gate, before its read
  await sleep(5);
  c("CONTROL:the-flush-is-pumping-and-has-read-nothing", e.inPump === true && e.pumps === 1, { inPump: e.inPump, pumps: e.pumps });
  r.holder.closeRun(7, { message: "rate_limit", code: "rate_limit" }); // the turn's terminal, during the pump
  r.write("run-3"); // the next prompt, written before the held read
  release?.();
  await r.holder.settled();
  c("live:a-terminal-reported-during-a-flushs-read-closes-its-own-turn-under-the-prompt-the-read-returned", e.queued.length === 1 && e.queued[0]?.duringPump === true && e.pumpClosed.length === 1 && e.pumpClosed[0]?.runId === "run-2" && e.pumpClosed[0]?.error?.code === "rate_limit" && e.closes.length === 0 && e.openRunId === "run-3" && r.holder.running, { queued: e.queued, pumpClosed: e.pumpClosed, closes: e.closes, open: e.openRunId });
  await r.holder.close();
}

{
  // A TERMINAL FOR A TURN WHOSE FRAME NEVER FROZE. The first turn's records are written and the
  // pump that would open its run fails before the freeze: the log has no run, the wire has none,
  // and the terminal arrives while down. The re-read opens the run again and the terminal is
  // placed on it by position, not dropped for naming a run the log never had (Sol, round 11 of
  // 2026-10-13, through the built MCP entry point: the first turn's terminal was held for the run
  // the failed pump had opened in memory, which the fresh start did not have, and dropped).
  const r = rig({
    retryMs: 10,
    make: (start) => {
      const e = new FakeEmitter();
      if (start === 1) e.failOn.add(1);
      return e;
    },
  });
  r.holder.adopt(A);
  await r.holder.settled();
  r.write("run-1"); // the first turn's records
  r.holder.flush(A); // the frame fails before the freeze: down, with no run anywhere
  await r.holder.settled();
  r.holder.closeRun(7, { message: "rate_limit", code: "rate_limit" });
  await sleep(40);
  await r.holder.settled();
  c("revive:a-terminal-for-a-turn-whose-frame-never-froze-closes-the-run-the-re-read-opens", r.made[1]?.closes.length === 1 && r.made[1].closes[0]?.runId === "run-1" && r.made[1].closes[0]?.error?.code === "rate_limit" && r.holder.running, { closes: r.made[1]?.closes, running: r.holder.running });
  await r.holder.close();
}

{
  const halted = new FakeEmitter();
  const r = rig({ emitter: halted, retryMs: 10 });
  r.holder.adopt(A);
  await r.holder.settled();
  halted.stopped = true; // the emitter halted itself
  r.holder.adopt(B); // any failure now re-establishes
  await r.holder.settled();
  await sleep(40);
  await r.holder.settled();
  c("revive:a-HALTED-emitter-is-started-again", r.starts === 2, r.starts);
  await r.holder.close();
}

{
  // Close cancels a pending re-establish: a released holder never starts again.
  const r = rig({ fail: new Error("start explodes"), failTimes: 1, retryMs: 10 });
  r.holder.adopt(A);
  await r.holder.settled();
  await r.holder.close();
  await sleep(40);
  await r.holder.settled();
  c("revive:close-CANCELS-a-pending-re-establish", r.starts === 1, r.starts);
  // `enqueue` would refuse the start anyway; what shows the TIMER was cancelled is that the
  // failure is still on the holder, which a revive that ran would have cleared first.
  c("revive:a-closed-holder-keeps-its-failure-readable", r.holder.failure?.message === "start explodes", r.holder.failure?.message);
  c("revive:a-closed-holder-stays-not-running", !r.holder.running);
}

{
  // A failure that lands after close is reported with no delay: nothing will retry it. A start
  // queued before close never runs (a closed holder never starts), so the one way to fail after
  // close is a pump that was already in flight when close arrived.
  const slow = new FakeEmitter();
  let failPump: (() => void) | undefined;
  slow.pump = () =>
    new Promise((_, reject) => {
      failPump = () => reject(new Error("pump failed after close"));
    });
  const r = rig({ emitter: slow });
  r.holder.flush(A);
  await sleep(10); // the pump is in flight
  const closing = r.holder.close();
  failPump!();
  await closing;
  c("revive:a-failure-after-close-reports-NO-retry", r.delays.length === 1 && r.delays[0] === null, r.delays);
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

// ---- WAIT-LIVE (#1868) ----------------------------------------------------------------------
//
// A flush landing in a mesh rebuild window measured max_payload off a connection that was not
// there and killed the seat. The holder's answer is the optional waitLive parameter: the step
// holds BEFORE it touches the emitter, and publishes once the caller says the plane is live.
// These cells grade the holder's side of that seam only — WHEN the wait runs, what it never
// swallows, and that absent the parameter nothing changes. The jcode suite grades the seat.
{
  // A wait that is pending holds the pump; releasing it lets exactly one pump through.
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => (release = r));
  const r = rig();
  const holder = new AguiEmitterHolder<unknown>(
    async () => r.emitter as unknown as AguiEmitter<unknown>,
    { onError: (e) => r.errors.push(e), waitLive: () => gate, sourceEnd: async () => "0" },
  );
  holder.flush(A);
  await new Promise((r2) => setTimeout(r2, 20));
  c("waitlive:a-pending-wait-HOLDS-the-pump", r.emitter.pumps === 0, r.emitter.pumps);
  release!();
  await holder.settled();
  c("waitlive:releasing-the-wait-lets-EXACTLY-one-pump-through", r.emitter.pumps === 1, r.emitter.pumps);
  c("waitlive:a-held-then-released-flush-reports-NO-error", r.errors.length === 0, r.errors.map((e) => e.message));
}

{
  // The wait runs BEFORE closeRun touches the emitter, so a close held through a window cannot
  // read max_payload off a dead connection either. The stand-in records the close rather than
  // publishing: this cell grades WHEN the wait released, not what a real emitter sends.
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => (release = r));
  const emitter = new FakeEmitter();
  emitter.openRunId = "run-a";
  const closedRuns: string[] = [];
  const errors: Error[] = [];
  const holder = new AguiEmitterHolder<unknown>(
    async () => emitter as unknown as AguiEmitter<unknown>,
    {
      onError: (e) => errors.push(e),
      onRunClosed: (runId) => closedRuns.push(runId),
      waitLive: () => gate,
      sourceEnd: async () => "0",
    },
  );
  holder.adopt(A);
  await holder.settled();
  holder.closeRun(1);
  await new Promise((r2) => setTimeout(r2, 20));
  c("waitlive:a-closeRun-is-HELD-by-a-pending-wait", closedRuns.length === 0, closedRuns);
  release!();
  await holder.settled();
  c("waitlive:a-closeRun-waits-for-live-and-still-reports-the-run", closedRuns.length === 1 && closedRuns[0] === "run-a", closedRuns);
  c("waitlive:a-held-close-reports-NO-error", errors.length === 0, errors.map((e) => e.message));
}

{
  // A REJECTING wait is a failing step: it reaches the terminal sink with the original error.
  // Liveness-waiting must never swallow what the emitter would have surfaced.
  const boom = new Error("wait rejected: endpoint stopped");
  const r = rig();
  const holder = new AguiEmitterHolder<unknown>(
    async () => r.emitter as unknown as AguiEmitter<unknown>,
    { onError: (e) => r.errors.push(e), waitLive: () => Promise.reject(boom), sourceEnd: async () => "0" },
  );
  holder.flush(A);
  await holder.settled();
  c("waitlive:a-REJECTING-wait-is-terminal-with-the-original-error", r.errors[0] === boom, r.errors[0]?.message);
  c("waitlive:a-rejected-wait-pumps-NOTHING", r.emitter.pumps === 0, r.emitter.pumps);
}

{
  // CONCURRENT steps SHARE one in-flight wait: a burst of flushes during one outage is one
  // wait, one release, and still exactly one pump per flushed path-record (the emitter stand-in
  // counts calls; the chain serializes them after the shared gate).
  let waits = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => (release = r));
  const r = rig();
  const holder = new AguiEmitterHolder<unknown>(
    async () => r.emitter as unknown as AguiEmitter<unknown>,
    {
      onError: (e) => r.errors.push(e),
      sourceEnd: async () => "0",
      waitLive: () => {
        waits++;
        return gate;
      },
    },
  );
  holder.adopt(A);
  await holder.settled();
  holder.flush(A);
  await new Promise((r2) => setTimeout(r2, 10)); // the first flush's wait is now in flight
  holder.flush(A);
  holder.flush(A);
  await new Promise((r2) => setTimeout(r2, 20));
  c("waitlive:concurrent-steps-SHARE-one-wait-while-in-flight", waits === 1, waits);
  release!();
  await holder.settled();
  c("waitlive:after-the-shared-release-every-flush-still-pumped", r.emitter.pumps === 3, r.emitter.pumps);
}

{
  // A terminal that arrives WHILE THE FRESH START IS IN FLIGHT. The failed emitter is dropped and
  // the fresh one has not returned, so there is no emitter to hand it to; and the next prompt is
  // written before the start returns. A close queued behind the recovery would run after the pump
  // had read that prompt, and close the SUCCESSOR run with the failed run's error (Sol, round 7 of
  // 2026-10-13, through a real broker with the start held at its startup boundary). It must be
  // held at the hook, with the position the source had then, and handed to the fresh emitter
  // before its pump.
  let release: (() => void) | undefined;
  let entered = false;
  // The gate is ARMED right before the retry is due, not keyed on the start number: a mutation that
  // starts on every flush would otherwise reach the gate from the flush, and a cell that waits on a
  // gate nobody releases hangs the suite instead of reddening (seen under H1, 2026-10-13).
  let armed = false;
  const r = rig({
    retryMs: 10,
    gate: () =>
      armed
        ? new Promise<void>((res) => {
            armed = false;
            entered = true;
            release = res;
          })
        : Promise.resolve(),
    make: (start) => {
      const e = new FakeEmitter();
      e.openRunId = "run-2";
      if (start === 1) e.failOn.add(1);
      return e;
    },
  });
  r.holder.adopt(A);
  await r.holder.settled();
  r.holder.flush(A); // pump 1 fails: down
  await r.holder.settled();
  armed = true;
  await sleep(40); // the retry fires and the fresh start is held at its gate
  c("CONTROL:the-fresh-start-is-in-flight", entered && r.starts === 2 && !r.holder.running, { entered, starts: r.starts, running: r.holder.running });
  r.holder.closeRun(7, { message: "rate_limit", code: "rate_limit" }); // the failed turn's terminal, during the start
  r.write("run-3"); // the next prompt, written while the start is in flight
  release?.();
  await r.holder.settled();
  const fresh = r.made[1];
  c("revive:a-terminal-during-an-in-flight-start-is-handed-to-the-fresh-emitter-BEFORE-its-pump", fresh?.queued.length === 1 && fresh.queued[0]?.terminal.error?.code === "rate_limit" && fresh.queued[0].pumpsBefore === 0 && fresh.pumpClosed[0]?.runId === "run-2" && fresh.pumpClosed[0]?.error?.code === "rate_limit", { queued: fresh?.queued, pumpClosed: fresh?.pumpClosed });
  c("revive:a-terminal-during-an-in-flight-start-does-NOT-close-the-successor-run", fresh?.closes.length === 0 && fresh.openRunId === "run-3" && r.holder.running, { closes: fresh?.closes, open: fresh?.openRunId, running: r.holder.running });
  await r.holder.close();
}

{
  // A terminal that arrives WHILE THE RECOVERY PUMP IS IN PROGRESS, before the next prompt the
  // held read will return is written. A terminal held only for after the pump is too late, since
  // the pump closes the run itself under that prompt (Sol, round 8 of 2026-10-13, through a real
  // broker with the recovery read paused). It must be handed to the emitter at the hook, with the
  // position the source had then, for the pump to place before it packs that prompt.
  let release: (() => void) | undefined;
  // Armed right before the retry is due, not keyed on the start number, for the reason the
  // in-flight start cell gives: a mutation that starts on every flush must not reach the gate.
  let armed = false;
  const r = rig({
    retryMs: 10,
    make: (start) => {
      const e = new FakeEmitter();
      e.openRunId = "run-2";
      if (start === 1) e.failOn.add(1);
      else if (armed) {
        armed = false;
        e.pumpGate = new Promise<void>((res) => (release = res));
      }
      return e;
    },
  });
  r.holder.adopt(A);
  await r.holder.settled();
  r.holder.flush(A); // pump 1 fails: down
  await r.holder.settled();
  armed = true;
  await sleep(40); // the retry fires, the fresh start returns, and its pump is held at its gate
  const fresh = r.made[1];
  c("CONTROL:the-recovery-pump-is-in-progress", r.starts === 2 && fresh?.inPump === true && fresh.queued.length === 0, { starts: r.starts, inPump: fresh?.inPump, queued: fresh?.queued });
  r.holder.closeRun(7, { message: "rate_limit", code: "rate_limit" }); // the failed turn's terminal, during the pump
  r.write("run-3"); // the next prompt, which the held read returns
  c("revive:a-terminal-during-the-recovery-pump-is-handed-to-the-emitter-AT-THE-HOOK", fresh?.queued.length === 1 && fresh.queued[0]?.terminal.error?.code === "rate_limit" && fresh.queued[0].duringPump === true, { queued: fresh?.queued });
  release?.();
  await r.holder.settled();
  c("revive:a-terminal-during-the-recovery-pump-does-NOT-close-the-successor-run", fresh?.pumpClosed[0]?.runId === "run-2" && fresh.pumpClosed[0]?.error?.code === "rate_limit" && fresh.closes.length === 0 && fresh.openRunId === "run-3" && r.holder.running, { pumpClosed: fresh?.pumpClosed, closes: fresh?.closes, open: fresh?.openRunId, running: r.holder.running });
  await r.holder.close();
}

{
  // A LATER TERMINAL NEVER REPLACES THE ONE HELD BEFORE IT. A finish held while the plane was down,
  // then a failure delivered while the recovery pump is in progress, after the next turn's records:
  // the finish is the open run's and the failure the next turn's, each placed by its position (Sol,
  // round 9 of 2026-10-13, through the built MCP entry point: the error was owed over the held
  // finish and the first run closed as a failure).
  let release: (() => void) | undefined;
  let armed = false;
  const r = rig({
    retryMs: 10,
    make: (start) => {
      const e = new FakeEmitter();
      e.openRunId = "run-2";
      if (start === 1) e.failOn.add(1);
      else if (armed) {
        armed = false;
        e.pumpGate = new Promise<void>((res) => (release = res));
      }
      return e;
    },
  });
  r.holder.adopt(A);
  await r.holder.settled();
  r.holder.flush(A); // pump 1 fails: down
  await r.holder.settled();
  r.holder.closeRun(7); // the turn's FINISH, while down: held first
  armed = true;
  await sleep(40); // the retry fires and the fresh emitter's pump is held at its gate
  const fresh = r.made[1];
  c("CONTROL:a-finish-is-handed-over-and-the-recovery-pump-is-in-progress", r.starts === 2 && fresh?.inPump === true && fresh.queued.length === 1 && fresh.queued[0]?.terminal.error === undefined, { starts: r.starts, inPump: fresh?.inPump, queued: fresh?.queued });
  r.write("run-3"); // the next turn's records, which the held read returns, and its failure
  r.holder.closeRun(8, { message: "rate_limit", code: "rate_limit" });
  c("revive:a-failure-after-a-held-finish-is-handed-over-after-it-and-replaces-nothing", fresh?.queued.length === 2 && fresh.queued[0]?.terminal.error === undefined && fresh.queued[1]?.terminal.error?.code === "rate_limit" && fresh.queued[1]?.duringPump === true, { queued: fresh?.queued });
  release?.();
  await r.holder.settled();
  c("revive:the-pump-closes-the-first-run-as-the-finish-and-the-failure-closes-the-next-turns-run", fresh?.pumpClosed.length === 1 && fresh.pumpClosed[0]?.runId === "run-2" && fresh.pumpClosed[0]?.error === undefined && fresh.closes.length === 1 && fresh.closes[0]?.runId === "run-3" && fresh.closes[0]?.error?.code === "rate_limit" && r.holder.running, { pumpClosed: fresh?.pumpClosed, closes: fresh?.closes, running: r.holder.running });
  await r.holder.close();
}

{
  // A terminal that arrives while the plane is down AFTER a re-establish start FAILED. The failed
  // start left no emitter to ask, so the run the wire had open is carried from the first failure of
  // the outage, and the terminal is held for it until a start goes through.
  const r = rig({
    retryMs: 20,
    failStarts: new Set([2]),
    make: (start) => {
      const e = new FakeEmitter();
      e.openRunId = "run-2";
      if (start === 1) e.failOn.add(1);
      return e;
    },
  });
  r.holder.adopt(A);
  await r.holder.settled();
  r.holder.flush(A); // pump 1 fails: down
  await r.holder.settled();
  await sleep(35); // the first retry at 20ms: start 2 fails, the plane is down again with no emitter
  c("CONTROL:the-re-establish-start-failed-and-the-plane-is-down-with-no-emitter", r.starts === 2 && r.errors.length === 2 && !r.holder.running, { starts: r.starts, errors: r.errors.length });
  r.holder.closeRun(7, { message: "rate_limit", code: "rate_limit" }); // the terminal, while down after the failed start
  await sleep(80); // the second retry at 40ms more: start 3 goes through
  await r.holder.settled();
  const fresh = r.made[1]; // start 2 made nothing
  c("revive:a-terminal-while-down-after-a-FAILED-re-establish-start-is-held-for-the-down-run", r.starts === 3 && fresh?.closes.length === 1 && fresh.closes[0]?.error?.code === "rate_limit" && r.holder.running, { starts: r.starts, closes: fresh?.closes, running: r.holder.running });
  await r.holder.close();
}

console.log(`agui-holder smoke: ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
