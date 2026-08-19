/**
 * The journal's proof: resume returns recorded results, a changed input is a diagnosable
 * divergence rather than a silent re-run, a crash mid-effect leaves something recoverable, and
 * the run clock is deterministic under replay including inside concurrency.
 *
 * The negative cases matter most. Silently re-running an effect whose inputs changed is the exact
 * bug this keying scheme exists to prevent, so "diverged" has to be a verdict the interpreter
 * cannot accidentally treat as "miss".
 */
import { Journal, JournalAppendRejected, RunClock, journalEntryKeyString, type JournalEntry } from "../src/journal.js";
import { KeyScope, digest, stepKeyString } from "../src/keys.js";
import { resume, run } from "../src/interpret.js";
import { readFileSync } from "node:fs";
import { SimHandler } from "../src/sim.js";
import { assertNoCode } from "../src/values.js";
import { WALKER_LANGUAGE_VERSION, resolvePins } from "../src/pins.js";
import { EffectError, type EffectHandler } from "../src/effects.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ok ${name}`);
};

const H = (v: unknown) => digest(v);

// ---- 1) a fresh run appends; a resumed run replays ------------------------------------------

{
  const live = new Journal({ run: "r-1" });
  const s = new KeyScope();
  const k = s.nextEffect("turn", "build");
  const h = H({ agent: "builder" });

  ok("a fresh key misses", live.lookup(k, h).verdict === "miss");
  await live.begin(k, h, 1000);
  await live.settle(k, { status: "ok", result: { status: "done", at: 1100 } }, 1100);

  // Resume: re-run from the top, so a NEW KeyScope allocates the same key again.
  const resumed = new Journal({ run: "r-1", entries: live.entries() });
  const s2 = new KeyScope();
  const v = resumed.lookup(s2.nextEffect("turn", "build"), h);
  ok("the same key replays after a resume", v.verdict === "replay", v.verdict);
  ok(
    "and returns the recorded result rather than performing the effect",
    v.verdict === "replay" && (v.entry.result as { status: string }).status === "done",
  );
}

// ---- 2) a changed input is a divergence, never a silent re-run ------------------------------

{
  const j = new Journal({ run: "r-2" });
  const s = new KeyScope();
  const k = s.nextEffect("ask", "estimate");
  await j.begin(k, H({ agent: "planner", schema: { days: "number" } }), 1000);
  await j.settle(k, { status: "ok", result: { days: 3 } }, 1100);

  const resumed = new Journal({ run: "r-2", entries: j.entries() });
  const s2 = new KeyScope();
  // The program's schema changed, which is exactly the case that makes a recorded answer wrong.
  const v = resumed.lookup(
    s2.nextEffect("ask", "estimate"),
    H({ agent: "planner", schema: { days: "number", confidence: "number" } }),
  );
  ok("a changed input hash diverges", v.verdict === "diverged", v.verdict);
  ok(
    "and the verdict carries both hashes so the error can print a diff",
    v.verdict === "diverged" && v.recordedHash !== v.programHash,
  );
  ok(
    "the divergence is NOT reported as a miss, which would silently re-ask the agent",
    v.verdict !== "miss",
  );
}

// ---- 3) a crash mid-effect leaves something recoverable --------------------------------------

{
  const j = new Journal({ run: "r-3" });
  const s = new KeyScope();
  const k = s.nextEffect("turn", "build");
  const h = H({ agent: "builder" });
  await j.begin(k, h, 1000);
  await j.bind(k, { goalId: "g-77" });
  // ...and the host dies here, before the turn settles.

  const resumed = new Journal({ run: "r-3", entries: j.entries() });
  const v = resumed.lookup(new KeyScope().nextEffect("turn", "build"), h);
  ok("an unsettled effect replays as pending", v.verdict === "pending", v.verdict);
  ok(
    "and points at the external resource to re-bind to, so no second goal is issued",
    v.verdict === "pending" && (v.entry.external as { goalId: string }).goalId === "g-77",
  );
}

// ---- 4) failures and cancellations replay as themselves ---------------------------------------

{
  const j = new Journal({ run: "r-4" });
  const s = new KeyScope();
  const kf = s.nextEffect("turn", "build");
  await j.begin(kf, H({ agent: "b" }), 1000);
  await j.settle(kf, { status: "failed", error: { code: "L4002", kind: "agent-down", message: "died" } }, 1100);
  const kc = s.nextEffect("turn", "build");
  await j.begin(kc, H({ agent: "b" }), 1200);
  await j.settle(kc, { status: "cancelled" }, 1250);

  const r = new Journal({ run: "r-4", entries: j.entries() });
  const s2 = new KeyScope();
  ok("a failed effect replays its throw", r.lookup(s2.nextEffect("turn", "build"), H({ agent: "b" })).verdict === "replay-failed");
  ok("a cancelled effect replays as cancelled", r.lookup(s2.nextEffect("turn", "build"), H({ agent: "b" })).verdict === "replay-cancelled");
}

// ---- 5) a retry loop: each iteration is its own entry -----------------------------------------

// This is the mechanism standing in for the plan's `rescue` keyword, so it has to survive a
// resume: attempt 0 failed, attempt 1 succeeded, and a replay must reproduce both in order.
{
  const j = new Journal({ run: "r-5" });
  const s = new KeyScope();
  const k0 = s.nextEffect("turn", "build");
  await j.begin(k0, H({ agent: "b1" }), 1000);
  await j.settle(k0, { status: "failed", error: { code: "L4002", kind: "agent-down", message: "died" } }, 1100);
  const k1 = s.nextEffect("turn", "build");
  await j.begin(k1, H({ agent: "b2" }), 1200);
  await j.settle(k1, { status: "ok", result: { status: "done", at: 1300 } }, 1300);

  const r = new Journal({ run: "r-5", entries: j.entries() });
  const s2 = new KeyScope();
  const v0 = r.lookup(s2.nextEffect("turn", "build"), H({ agent: "b1" }));
  const v1 = r.lookup(s2.nextEffect("turn", "build"), H({ agent: "b2" }));
  ok("the failed attempt replays first", v0.verdict === "replay-failed");
  ok("the respawned attempt replays second", v1.verdict === "replay");
  ok("the two attempts are distinct entries", j.entries().length === 2);
}

// ---- 6) orphans: what an edit removed ---------------------------------------------------------

{
  const j = new Journal({ run: "r-6" });
  const s = new KeyScope();
  for (const [kind, name] of [["turn", "build"], ["spawn", ""], ["sleep", ""]] as const) {
    const k = s.nextEffect(kind, name);
    await j.begin(k, H({ n: name }), 1000);
    await j.settle(k, { status: "ok", result: null }, 1100);
  }

  // The edited program only reaches the turn.
  const r = new Journal({ run: "r-6", entries: j.entries() });
  const s2 = new KeyScope();
  r.lookup(s2.nextEffect("turn", "build"), H({ n: "build" }));
  const orphans = r.orphans();
  ok("steps the new program never reached are orphans", orphans.length === 2, orphans.map((o) => o.kind));
  ok(
    "and their kinds are what decides the migration policy",
    orphans.some((o) => o.kind === "spawn") && orphans.some((o) => o.kind === "sleep"),
  );
}

// ---- 7) a dry replay must not mutate the run it is checking ------------------------------------

{
  const j = new Journal({ run: "r-7", readOnly: true });
  let threw = false;
  let named = false;
  try {
    await j.begin(new KeyScope().nextEffect("turn", "build"), H({}), 1000);
  } catch (e) {
    threw = true;
    // The refusal has to say WHICH step it declined, or a dry replay that stops tells its caller
    // nothing about where it stopped.
    named = e instanceof Error && e.message.includes("/turn:build#0");
  }
  ok("a read-only journal refuses to append", threw);
  ok("and the refusal names the step it declined", named);
}

// ---- 8) the run clock -------------------------------------------------------------------------

{
  const root = new RunClock(1000);
  ok("before any effect the clock is the run start", root.now() === 1000);
  root.advance(1500);
  ok("an awaited effect advances it", root.now() === 1500);
  root.advance(1200);
  ok("a later out-of-order settle cannot rewind it", root.now() === 1500);

  // Concurrency: a branch sees only its OWN history until the join. A journal-wide max would let
  // a sibling's completion leak into a branch that never awaited it, and then live execution and
  // replay would disagree about what now() returned.
  const a = root.fork();
  const b = root.fork();
  a.advance(9000);
  ok("a sibling branch's clock does not leak", b.now() === 1500, { a: a.now(), b: b.now() });
  ok("and the parent is untouched before the join", root.now() === 1500);
  root.join([a, b]);
  ok("the join takes the maximum over all branches", root.now() === 9000);
}

// ---- 9) the durable store: what a crash would find, and WHEN ---------------------------------

// The ordering is the whole property. A pending entry that becomes durable only after the handler
// was called names work that already exists, which is the crash window the two-phase write exists
// to close. So this section does not assert that appends happen; it asserts WHEN.

{
  const trace: string[] = [];
  const store = {
    append: async (e: JournalEntry) => {
      trace.push(`store:${e.state}:${e.kind}:${e.name}`);
    },
  };

  const j = new Journal({ run: "r-9", store });
  const s = new KeyScope();
  const k = s.nextEffect("turn", "build");
  const h = H({ agent: "builder" });

  await j.begin(k, h, 1000, "req-1");
  ok("a begin reaches the store", trace[0] === "store:pending:turn:build", trace);
  await j.bind(k, { goalId: "g-1" });
  ok("a bind reaches the store, so a crash finds what the handler learned", trace[1] === "store:pending:turn:build");
  await j.settle(k, { status: "ok", result: { status: "done", at: 1100 } }, 1100);
  ok("a settle reaches the store", trace[2] === "store:settled:turn:build", trace);
  ok("every write went to the store, none silently skipped", trace.length === 3, trace);

  const persisted = j.get(k);
  ok("and the in-memory view agrees with what was persisted", persisted?.status === "ok" && persisted.external?.goalId === "g-1");
}

{
  // A journal with NO store is in-memory only: durability is a property of where a run is hosted,
  // not of what a program means, so the simulator and the dry run must not need one.
  const j = new Journal({ run: "r-9b" });
  const k = new KeyScope().nextEffect("sleep", "");
  await j.begin(k, H({ duration: "1m" }), 0);
  await j.settle(k, { status: "ok", result: null }, 60_000);
  ok("a journal with no store still records in memory", j.get(k)?.status === "ok");
}

{
  // THE ORDERING CELL. A real program, a real interpreter, and a store that says when it was
  // written relative to the handler being called.
  const order: string[] = [];
  // A REAL store does not finish in the same tick it was called in, and the distinction is the
  // whole test: a store that records synchronously would show the right order whether or not the
  // interpreter awaited it, so this one crosses a macrotask before it records — exactly as a write
  // to a stream does. Now "durable before dispatch" is a claim only an awaited append can satisfy.
  const store = {
    append: async (e: JournalEntry) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      order.push(`append:${e.state}:${e.kind}`);
    },
  };
  const sim = new SimHandler({ turns: { build: [{ status: "done" }] } });
  // Built method by method rather than spread: a class instance's methods live on its prototype,
  // so a spread wrapper is an object with none of them.
  const watched: EffectHandler = {
    now: () => sim.now(),
    spawn: (req, ctx) => sim.spawn(req, ctx),
    turn: async (req, ctx) => {
      order.push("handler:turn");
      return await sim.turn(req, ctx);
    },
    ask: (req, ctx) => sim.ask(req, ctx),
    checkpoint: (req, ctx) => sim.checkpoint(req, ctx),
    sleep: (req, ctx) => sim.sleep(req, ctx),
    wait: (req, ctx) => sim.wait(req, ctx),
    notify: (req, ctx) => sim.notify(req, ctx),
    monitor: (req, ctx) => sim.monitor(req, ctx),
    openConclave: (req, ctx) => sim.openConclave(req, ctx),
    closeConclave: (req, ctx) => sim.closeConclave(req, ctx),
  };

  const journal = new Journal({ run: "r-9c", store });
  await run(`const b = await spawn("builder");\nawait turn(b, { name: "build" });`, {
    runId: "r-9c",
    handler: watched,
    journal,
  });

  const pendingAt = order.indexOf("append:pending:turn");
  const settledAt = order.indexOf("append:settled:turn");
  const handlerAt = order.indexOf("handler:turn");
  ok("the turn's PENDING entry is durable before the handler is called", pendingAt !== -1 && pendingAt < handlerAt, order);
  ok("and its settled entry only after the handler returned", settledAt > handlerAt, order);
}

// ---- 10) a REFUSED append is a durability failure, not an effect failure -----------------------

/**
 * The store saying no and the world saying no are different facts and must not be recorded as the
 * same one. Under a single `try` covering both the dispatch and the settling append, a handler that
 * completed plus an append the store rejected produces the durable sequence
 * `[pending, settled:failed]`: a permanent record that work which really happened had failed.
 *
 * So: nothing recorded, nothing moved in memory, and the error travels as itself.
 */

/** A handler built method by method, counting the dispatches the interpreter actually made. */
const counting = (sim: SimHandler, calls: string[]): EffectHandler => ({
  now: () => sim.now(),
  spawn: (req, ctx) => sim.spawn(req, ctx),
  turn: (req, ctx) => sim.turn(req, ctx),
  ask: (req, ctx) => sim.ask(req, ctx),
  checkpoint: (req, ctx) => sim.checkpoint(req, ctx),
  sleep: async (req, ctx) => {
    calls.push("sleep");
    return await sim.sleep(req, ctx);
  },
  wait: (req, ctx) => sim.wait(req, ctx),
  notify: (req, ctx) => sim.notify(req, ctx),
  monitor: (req, ctx) => sim.monitor(req, ctx),
  openConclave: (req, ctx) => sim.openConclave(req, ctx),
  closeConclave: (req, ctx) => sim.closeConclave(req, ctx),
});

{
  // The store accepts the pending half and refuses the settling one: the effect succeeded, the log
  // would not take the completion.
  const calls: string[] = [];
  const accepted: string[] = [];
  const store = {
    append: async (e: JournalEntry) => {
      if (e.state === "settled") throw new Error("stream said no");
      accepted.push(e.state);
    },
  };
  const journal = new Journal({ run: "r-10", store });
  let caught: unknown;
  try {
    await run('await sleep("1m", { name: "s" });', {
      runId: "r-10",
      journal,
      handler: counting(new SimHandler({}), calls),
    });
  } catch (e) {
    caught = e;
  }

  ok("the handler really did complete, or this cell is about nothing", calls.length === 1, calls);
  ok("a refused append is raised as a durability failure", (caught as Error)?.name === "JournalAppendRejected", String(caught).slice(0, 60));
  ok("under its own code, not as a handler fault", (caught as { code?: string })?.code === "L5010");
  ok("naming the step and the half that was refused", (caught as { stepKey?: string })?.stepKey === "/sleep:s#0"
    && (caught as { state?: string })?.state === "settled", [(caught as { stepKey?: string })?.stepKey, (caught as { state?: string })?.state]);
  // The lie this replaces: `settled:failed` for work that succeeded.
  ok("and NOTHING is recorded as failed", journal.entries().every((e) => e.status !== "failed"),
    journal.entries().map((e) => `${e.state}:${e.status ?? ""}`));
  ok("the entry stays exactly as durable as the store left it: pending", journal.entries().length === 1
    && journal.entries()[0]?.state === "pending", journal.entries().map((e) => e.state));
  ok("the store was asked once and accepted once", accepted.length === 1, accepted);
}

{
  // The other half. A refused PENDING append must leave no entry at all: an in-memory `pending` the
  // store never took reads to a later lookup as recoverable work, and there is no work.
  const calls: string[] = [];
  const store = { append: async (_e: JournalEntry) => { throw new Error("stream said no"); } };
  const journal = new Journal({ run: "r-10b", store });
  let caught: unknown;
  try {
    await run('await sleep("1m", { name: "s" });', {
      runId: "r-10b",
      journal,
      handler: counting(new SimHandler({}), calls),
    });
  } catch (e) {
    caught = e;
  }
  ok("a refused pending append also raises the durability failure", (caught as { code?: string })?.code === "L5010");
  ok("and the effect was never dispatched, because its identity never became durable", calls.length === 0, calls);
  ok("leaving no entry behind for a resume to try to recover", journal.entries().length === 0,
    journal.entries().map((e) => e.state));
}

{
  // The third place a refusal can land: `ctx.bind`, which a handler calls from INSIDE its own
  // dispatch to record the external resource it just created. That append is inside the handler's
  // try by construction, so without a domain check it comes back as a handler fault — the run
  // blaming the agent for something the log did.
  const sim = new SimHandler({});
  const binding: EffectHandler = {
    ...counting(sim, []),
    turn: async (_req, ctx) => {
      await ctx.bind({ goalId: "g-1" });
      return { status: "done", at: 0 };
    },
  };
  const store = {
    append: async (e: JournalEntry) => {
      if (e.external !== undefined) throw new Error("stream said no");
    },
  };
  const journal = new Journal({ run: "r-10c", store });
  let caught: unknown;
  try {
    await run('const b = await spawn("b");\nawait turn(b, { name: "build" });', {
      runId: "r-10c",
      journal,
      handler: binding,
    });
  } catch (e) {
    caught = e;
  }
  ok("a refusal raised from inside the handler's own dispatch is still a durability failure",
    (caught as { code?: string })?.code === "L5010", String(caught).slice(0, 60));
  ok("not an effect failure blamed on the agent", (caught as Error)?.name !== "EffectError", (caught as Error)?.name);
  ok("and the external resource is not recorded, because recording it is what was refused",
    journal.entries().every((e) => e.external === undefined),
    journal.entries().map((e) => e.external));
}

// ---- 11) append order is ALLOCATED, not read off a list the append has not joined yet ---------

/**
 * Two concurrent branches are the normal shape, and `begin` awaits a durable append before its key
 * joins the order list — so both branches read the same length and both claimed the same `seq`.
 * Rendering showed two "first" steps, and any tool ordering by it saw a tie with nothing to break
 * it. The store here yields, which is what a real network does and what a synchronous fake hides.
 */
{
  const seen: JournalEntry[] = [];
  const journal = new Journal({
    run: "seq-1",
    store: {
      append: async (entry) => {
        await new Promise<void>((r) => setTimeout(r, 0));
        seen.push(entry);
      },
    },
  });
  await run(
    'await parallel({ a: async () => await sleep("1m", { name: "a" }), b: async () => await sleep("1m", { name: "b" }) }, { name: "p" });',
    { runId: "seq-1", journal, handler: new SimHandler({}) },
  );
  const begins = journal.entries().filter((e) => e.kind === "sleep");
  ok("two concurrently-begun steps really did both start before either was durable",
    begins.length === 2, begins.length);
  ok("and they hold DISTINCT append orders", begins[0]?.seq !== begins[1]?.seq,
    begins.map((e) => `${e.name}:${e.seq}`));
  ok("no two entries in the journal share one seq",
    new Set(journal.entries().map((e) => e.seq)).size === journal.entries().length,
    journal.entries().map((e) => `${e.kind}:${e.seq}`));
  // A journal loaded from a prefix keeps allocating past it, or a resumed run's first new step
  // collides with a recorded one.
  const reloaded = new Journal({ run: "seq-1", entries: journal.entries() });
  const next = await reloaded.begin({ scope: [], kind: "sleep", name: "later", occurrence: 0 }, "h", 0);
  ok("and a journal reloaded from a prefix allocates PAST it",
    next.seq > Math.max(...journal.entries().map((e) => e.seq)), next.seq);
}

// ── a journal is ONE run's, and the keys are what make that matter ────────────────────────────
//
// Step keys are structural, so another run's entry with the same scope, kind, name and occurrence
// MATCHES. Seeding across runs is therefore not a labelling mistake: it is one run resuming from
// another run's history and returning its recorded results as its own.
{
  const k = new KeyScope().nextEffect("sleep", "nap");
  const foreign = new Journal({ run: "other" });
  await foreign.begin(k, "h1", 1000);
  await foreign.settle(k, { status: "ok", result: { from: "the other run" } }, 1100);
  let crossed: unknown;
  try { new Journal({ run: "mine", entries: foreign.entries() }); } catch (e) { crossed = e; }
  ok("a journal refuses to be seeded with another run's entries", crossed instanceof Error,
    (crossed as Error)?.message?.slice(0, 70));
  // And the reason, made concrete: without the check, that entry answers this run's lookup.
  const same = new Journal({ run: "other", entries: foreign.entries() });
  ok("because the key would have matched — same scope, same name, same occurrence",
    same.lookup(k, "h1").verdict === "replay");
}

// ── a program cannot CATCH the loss of its own journal ────────────────────────────────────────
//
// A store that refuses ONE append (the settle of the first effect) and then works again. If the
// program's own `try/catch` can swallow that refusal, the run performs two more effects against the
// world and returns normally with nothing recorded from the refusal onward, so a resume performs
// all three again. A cancellation is uncatchable for exactly this reason: neither is a program
// error, and neither is the program's to handle. The store has to be TRANSIENT to see it; a
// permanently dead one masks it, because the next append fails too and the run stops for the wrong
// reason.
{
  let appends = 0;
  const flaky = {
    async append() {
      appends += 1;
      if (appends === 2) throw new Error("the stream refused this expectation");
    },
  };
  const performed: string[] = [];
  class Counting extends SimHandler {
    override async sleep(req: Parameters<SimHandler["sleep"]>[0], ctx: Parameters<SimHandler["sleep"]>[1]) {
      performed.push(req.duration);
      return await super.sleep(req, ctx);
    }
  }
  const PROGRAM = `
try {
  await sleep("1h", { name: "first" });
} catch (e) {
  await sleep("2h", { name: "swallowed" });
}
await sleep("3h", { name: "after-the-catch" });
`;
  let outcome: unknown;
  try {
    await run(PROGRAM, { runId: "catch-1", handler: new Counting(), journal: new Journal({ run: "catch-1", store: flaky }) });
    outcome = "COMPLETED";
  } catch (e) { outcome = e; }
  ok("a refused append ends the run rather than reaching the program's catch block",
    outcome instanceof JournalAppendRejected, outcome instanceof Error ? outcome.name : outcome);
  ok("and the program performed nothing after the refusal: the world stops where the journal did",
    performed.join(",") === "1h", performed);
}

// ---- an entry can be addressed by the key it was written under ------------------------------
//
// A resolver outside the language names a step by its key string — "the checkpoint called approve
// in this run" — and the journal is what maps that to the identity a handler submitted under. The
// entry keeps its scope as a string and its own (kind, name, occurrence) beside it, so the key is
// recoverable, but only by re-applying the grammar `stepKeyString` owns. This is the cell that says
// the two agree; a second hand-rolled join would address a different step rather than fail.
{
  const root = new KeyScope();
  const plain = root.nextEffect("checkpoint", "approve");
  const j = new Journal({ run: "addr" });
  const e1 = await j.begin(plain, H({ p: 1 }), 0, "req-1");
  ok("a root-level entry re-derives its own step key",
    journalEntryKeyString(e1) === stepKeyString(plain), [journalEntryKeyString(e1), stepKeyString(plain)]);

  const occurrence = root.nextScope("race", "first");
  const branch = root.branch("race", "first", occurrence, "b0");
  const nested = branch.nextEffect("checkpoint", "approve");
  const e2 = await j.begin(nested, H({ p: 2 }), 1, "req-2");
  ok("and so does one inside a concurrency scope, where the two would otherwise collide",
    journalEntryKeyString(e2) === stepKeyString(nested), [journalEntryKeyString(e2), stepKeyString(nested)]);
  ok("the two are DIFFERENT keys: the scope path is part of the address, not decoration",
    journalEntryKeyString(e1) !== journalEntryKeyString(e2), [journalEntryKeyString(e1), journalEntryKeyString(e2)]);

  const unnamed = root.nextEffect("sleep");
  const e3 = await j.begin(unnamed, H(0), 2);
  ok("an UNNAMED step addresses by its kind alone, exactly as the key grammar writes it",
    journalEntryKeyString(e3) === stepKeyString(unnamed), [journalEntryKeyString(e3), stepKeyString(unnamed)]);
}

// ── SEEDING FROM AN APPEND LOG, which is the only shape a real driver holds ─────────────────────
//
// Every cell here that says WRONG TODAY pins a defect and is written to die when it is repaired.
//
// The stream is append-only and says so in its own suite: `journal-store.smoke` asserts that
// "settling appends a second record rather than editing the first", so ONE step is TWO records on
// the broker. `RunJournalAppender.steps()` hands back every step record in order, and
// `run-driver.ts`'s `drive` seeds a journal straight from `appender.steps()`. So a resumed run's
// journal is seeded with two rows per completed step, in production, today: not a hypothetical
// caller.
//
// The journal folds that log HALFWAY: `byKey` keeps the last write, `order` keeps both keys. Its
// two views then disagree with each other, which is what makes this a bug rather than a contract
// question — nothing here is asking the journal to accept a shape it rejects.
{
  const root = new KeyScope();
  const k = root.nextEffect("sleep", "nap");
  const src = new Journal({ run: "log" });
  const pending = await src.begin(k, H({ d: 1 }), 1_000);
  const settled = await src.settle(k, { status: "ok", result: null }, 2_000);

  // The log, exactly as the appender would replay it: the pending record, then the settled one.
  const asLogged: JournalEntry[] = [pending, settled];
  const seeded = new Journal({ run: "log", entries: asLogged });

  ok("the log really does carry two rows for one step, which is what append-only means",
    asLogged.length === 2 && journalEntryKeyString(pending) === journalEntryKeyString(settled),
    asLogged.map((e) => `${journalEntryKeyString(e)}:${e.state}`));

  // THE POSITIVE CONTROL, and it is what makes the rest a defect rather than a misuse. The keyed
  // half of the fold is right: the lookup resolves to the settled row and the effect ceiling counts
  // the step once. A journal that could not read this input at all would be a contract question.
  ok("the KEYED view folds correctly: the ceiling counts the step once, not twice",
    seeded.dispatchedEffects() === 1, seeded.dispatchedEffects());

  // REPAIRED. `entries()` is documented as the prompt context for repair, so two rows where one
  // step happened is history this run does not have.
  ok("REPAIRED: the ORDERED view folds too — one step is one entry",
    seeded.entries().length === 1, seeded.entries().map((e) => `${journalEntryKeyString(e)}:${e.state}`));

  // WHICH row survives is its own claim: an unfolded duplicate brings the PENDING row back as a
  // second copy of the settled one. The fold keeps the last write, so the step reads as what it
  // ended up being rather than as what it started as.
  ok("and it is the LAST write, so a step that settled reads settled",
    seeded.entries()[0]?.state === "settled" && seeded.entries()[0]?.status === "ok",
    seeded.entries()[0]);

  // The live consumer. `migrateRun` builds its orphan table from `journal.orphans()` and computes
  // `consumedThrough` from its length, so a doubled orphan is a doubled row in the operator's table
  // and arithmetic over a doubled input: one decision presented as two, about one step.
  ok("and an unconsumed step is an orphan ONCE, so the migrate table counts one decision",
    seeded.orphans().length === 1, seeded.orphans().map((e) => journalEntryKeyString(e)));

  // THE NARROWNESS, and it is two claims because the fold can be wrong in two directions.
  //
  // A fold that collapsed everything to one entry would satisfy all three cells above perfectly and
  // erase a run's history. And a fold keyed on the LAST occurrence would keep every step but
  // reorder them by COMPLETION rather than by start — a different sequence, silently, and exactly
  // the one a reader of a concurrent run must not be given: with `b` beginning before `a` settles,
  // last-occurrence ordering reports `b` first, so a repair reader sees the run doing its work in an
  // order it never did.
  const ka = root.nextEffect("sleep", "a");
  const kb = root.nextEffect("sleep", "b");
  const src2 = new Journal({ run: "log2" });
  const pa = await src2.begin(ka, H({ d: 1 }), 1_000);
  const pb = await src2.begin(kb, H({ d: 2 }), 1_100);
  const sa = await src2.settle(ka, { status: "ok", result: null }, 3_000);
  const two = new Journal({ run: "log2", entries: [pa, pb, sa] });
  ok("two different steps are still two entries: the fold is by key, not a collapse",
    two.entries().length === 2, two.entries().map((e) => journalEntryKeyString(e)));
  ok("and they keep the order the run PERFORMED them in, not the order they finished in",
    two.entries().map((e) => journalEntryKeyString(e)).join() === "/sleep:a#0,/sleep:b#0",
    two.entries().map((e) => `${journalEntryKeyString(e)}:${e.state}`));
}


// ---- a run recorded under language version 1 replays on the walker that is current --------------
//
// "Runs recorded under version 1 replay on the walker forever" is a property ACROSS commits, and no
// in-process journal can test it: a journal written and read by the same walker at the same sha agrees
// with itself whatever that walker does. So this recording was written ONCE (fixtures/, by the walker
// at feat/lang-engine 4724cdc4) and is replayed here by whatever walker is current, against a handler
// that refuses every dispatch. Its program logs a builtin, a namespace and a record carrying a function
// on purpose: the engine refuses those in a log line (its rule, declared in the differential), and
// this cell is what keeps that rule off the v1 replay path - measured before it existed, a rule landed
// in the shared builtin made this exact record fail L4016 one line after its first recorded sleep.

{
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/v1-recorded-log-builtin.json", import.meta.url), "utf8")) as {
    readonly languageVersion: string;
    readonly source: string;
    readonly runId: string;
    readonly seed: string;
    readonly startedAt: number;
    readonly pins: { readonly languageVersion: string };
    readonly entries: readonly JournalEntry[];
    readonly logs: readonly unknown[][];
  };
  ok("the checked-in recording is a language version 1 record with journalled effects", fixture.languageVersion === "1" && fixture.entries.length === 2, fixture.pins);
  const refusing = new Proxy(new SimHandler({}), {
    get(target, key) {
      if (key === "now") return () => fixture.startedAt;
      throw new Error(`the replay dispatched ${String(key)} instead of reading the journal`);
    },
  }) as unknown as EffectHandler;
  const replayed: unknown[][] = [];
  const outcome = await resume(fixture.source, new Journal({ run: fixture.runId, entries: fixture.entries }), {
    runId: fixture.runId,
    handler: refusing,
    pins: fixture.pins as never,
    seed: fixture.seed,
    startedAt: fixture.startedAt,
    onLog: (l) => replayed.push([...l.values]),
  }).then((r) => ({ ran: true as const, entries: r.journal.entries() }), (e: Error) => ({ ran: false as const, error: e.message }));
  ok(
    "the walker that is current replays it: same entries, same log lines, no dispatch",
    outcome.ran && JSON.stringify(outcome.entries) === JSON.stringify(fixture.entries) && JSON.stringify(replayed) === JSON.stringify(fixture.logs),
    outcome.ran ? { replayed } : outcome,
  );
  // The pin above is a RENDERING, and JSON draws a function, `undefined`, NaN and an empty record
  // the same way (`null` or `{}`), so it cannot tell "the builtin reached the host" from "code was
  // dropped from the trace", which is one of the remedies this recording exists to keep off the v1
  // path. So the values are checked for what they ARE: the builtin arrives as a function, and the
  // namespace and the record still carry code (the log rule's own predicate, so this cannot drift
  // from it).
  const carriesCode = (v: unknown): boolean => {
    try {
      assertNoCode(v, "v");
      return false;
    } catch {
      return true;
    }
  };
  ok(
    "and the recorded values arrive as they were recorded: the builtin as a function, the namespace and the record carrying code",
    typeof replayed[0]?.[1] === "function" && carriesCode(replayed[1]?.[1]) && carriesCode(replayed[1]?.[2]),
    replayed.map((line) => line.map((v) => (typeof v === "function" ? "function" : carriesCode(v) ? "object+code" : typeof v))),
  );
}

// ---- and a v1 record whose program called `len` on a record does NOT replay ---------------------
//
// THE DISCLOSED EXCEPTION to the line above, and the reason it is disclosed rather than repaired.
// `len` was narrowed to arrays and strings; the narrowing is right and it is main's. But a version 1
// run whose program called `len` on a record COMPLETED on the walker that recorded it, answering
// `undefined`, and that record does not replay on the walker that is current: it is refused L4016 at
// that line, BEFORE any recorded entry is consumed. The spec says so at §5.4 and §8.4 rather than
// this being discovered by a resume that dies in the field.
//
// TWO ARMS ARE WHAT MAKE THIS A MEASUREMENT. The record dying at the current walker cannot, alone,
// tell "this walker broke replay" from "this record was never replayable"; the fixture beside it was
// written by the SAME pre-move walker and still replays, which is the half that distinguishes them.
//
// THE FIXTURES ARE PINNED BY THEIR CONTENTS, NOT BY THEIR FILENAMES. A checked-in record that
// silently drifts (its `len` call edited away, its entries emptied, its pins losing version 1) would
// make these cells pass for the wrong reason forever. So each arm asserts what its own fixture
// CONTAINS before it asserts what the walker does with it.
{
  type V1Fixture = {
    readonly languageVersion: string;
    readonly source: string;
    readonly runId: string;
    readonly seed: string;
    readonly startedAt: number;
    readonly pins: { readonly languageVersion: string };
    readonly entries: readonly JournalEntry[];
    readonly logs: readonly unknown[][];
  };
  const loadFixture = (name: string): V1Fixture =>
    JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as V1Fixture;
  const refusingHandler = (startedAt: number): EffectHandler =>
    new Proxy(new SimHandler({}), {
      get(_target, key) {
        if (key === "now") return () => startedAt;
        throw new Error(`the replay dispatched ${String(key)} instead of reading the journal`);
      },
    }) as unknown as EffectHandler;

  const blocked = loadFixture("v1-len-on-a-record.json");
  ok(
    "the checked-in record is a version 1 record whose program really does call `len` on a record, and carries an entry to replay",
    blocked.languageVersion === "1" && blocked.pins.languageVersion === "1"
      && /const r = \{ a: 1, b: 2 \};/.test(blocked.source) && /len\(r\)/.test(blocked.source)
      && blocked.entries.length >= 1,
    { version: blocked.pins.languageVersion, entries: blocked.entries.length, source: blocked.source.split("\n").slice(0, 2) },
  );
  const blockedJournal = new Journal({ run: blocked.runId, entries: blocked.entries });
  const blockedOutcome = await resume(blocked.source, blockedJournal, {
    runId: blocked.runId,
    handler: refusingHandler(blocked.startedAt),
    pins: blocked.pins as never,
    seed: blocked.seed,
    startedAt: blocked.startedAt,
  }).then(() => ({ replayed: true as const }), (e: Error & { code?: string }) => ({ replayed: false as const, code: e.code, message: e.message }));
  ok(
    "the walker that is current REFUSES it, by the language's own code and not by dying somewhere unnamed",
    blockedOutcome.replayed === false && blockedOutcome.code === "L4016",
    blockedOutcome,
  );
  ok(
    "and it refuses BEFORE consuming the recorded entry, which is what makes this a replay that never starts rather than one that half-runs",
    blockedJournal.orphans().length === blocked.entries.length,
    { orphans: blockedJournal.orphans().length, entries: blocked.entries.length },
  );

  // THE POSITIVE CONTROL, written by the same walker at the same sha, differing only in the value
  // `len` is handed. Without it, every cell above is satisfied by a walker that refuses every v1
  // record, which is a far worse fault than the one being disclosed.
  const fine = loadFixture("v1-len-on-an-array.json");
  ok(
    "the control fixture is the same shape of program over an ARRAY, so the two arms differ in the value and nothing else",
    fine.languageVersion === "1" && /const xs = \[1, 2, 3\];/.test(fine.source) && /len\(xs\)/.test(fine.source)
      && fine.entries.length === blocked.entries.length,
    { version: fine.pins.languageVersion, entries: fine.entries.length },
  );
  const fineJournal = new Journal({ run: fine.runId, entries: fine.entries });
  const fineLogs: unknown[][] = [];
  const fineOutcome = await resume(fine.source, fineJournal, {
    runId: fine.runId,
    handler: refusingHandler(fine.startedAt),
    pins: fine.pins as never,
    seed: fine.seed,
    startedAt: fine.startedAt,
    onLog: (l) => fineLogs.push([...l.values]),
  }).then((r) => ({ replayed: true as const, entries: r.journal.entries() }), (e: Error) => ({ replayed: false as const, error: e.message }));
  ok(
    "and a v1 record of the same age that did NOT call `len` on a record still replays and completes, with its entry consumed",
    fineOutcome.replayed === true && JSON.stringify(fineLogs) === JSON.stringify(fine.logs) && fineJournal.orphans().length === 0,
    fineOutcome.replayed ? { logs: fineLogs, orphans: fineJournal.orphans().length } : fineOutcome,
  );
}

// ---- a BINDING is a value, and answers to the value rule (L5024) --------------------------------

/**
 * The third path into an entry. `result` crosses `assertCrossable` when it settles and the arguments
 * cross it when they dispatch; `external` reached the record through `ctx.bind` with no domain check
 * at all. Measured before the guard existed, on BOTH engines: a handler binding
 * `{ when: new Date(0), n: -0, bad: NaN, gone: undefined }` recorded all four, and the durable store
 * gives them back as a string, `0`, `null` and an absent key, so the value a resume RE-BINDS to was
 * not the value that was bound.
 *
 * The rule is CANONICAL, not round-trip-exact: `-0` is admitted and JSON still flattens it. The
 * guard's own comment says so; these cells do not claim more than that.
 */
{
  // THE WRITE SIDE, ON THE REAL PATH: a handler calling its own `ctx.bind` from inside its dispatch,
  // which is how every shipped binder reaches it (sim.ts binds on spawn, turn, ask and checkpoint;
  // the mesh handler binds a chat sequence). Not a hand-built context.
  const sim = new SimHandler({ turns: { build: { status: "done", at: 0 } } });
  // Object.create, NOT a spread: spreading a class instance drops its prototype methods and the run
  // dies on `options.handler.now is not a function`, measured twice within an hour on two sides, and
  // once with a zero that agreed with the hypothesis under test.
  const binder = Object.create(sim) as EffectHandler;
  binder.turn = async (_req, ctx) => {
    await ctx.bind({ when: new Date(0) });
    return { status: "done", at: 0 };
  };
  const journal = new Journal({ run: "r-bind-w" });
  let caught: unknown;
  try {
    await run('const b = await spawn("b");\nawait turn(b, { name: "build" });', { runId: "r-bind-w", journal, handler: binder });
  } catch (e) {
    caught = e;
  }
  ok(
    "a handler that binds a value with no canonical form is refused AT the bind",
    /the binding of .*has no canonical form/.test(String((caught as Error)?.message)),
    String((caught as Error)?.message).slice(0, 120),
  );
  ok(
    "and it is blamed on the handler's dispatch, where L4000 already says exactly that, rather than on a code of its own",
    (caught as { code?: string })?.code === "L4000",
    (caught as { code?: string })?.code,
  );
  // NARROWED ON PURPOSE, because the first draft of this cell asserted that NO entry carries a
  // binding and reded on the simulator's own `spawn`, which binds a string and must be allowed to.
  // The claim is about the entry whose bind was refused, not about the run.
  const turned = journal.entries().find((e) => e.kind === "turn");
  ok(
    "so the unbindable value never reaches the record, while the spawn's ordinary binding still does",
    turned?.external === undefined && journal.entries().some((e) => (e.external as { simAgent?: string })?.simAgent === "sim.b"),
    journal.entries().map((e) => ({ kind: e.kind, external: e.external })),
  );
}

{
  // THE SCOPE SIDE. `conclave` is the one scope that dispatches, and its `openConclave` receives the
  // scope's own context, so this is a real program reaching the second wrapper, not a hand-built
  // ctx. Before this cell, that wrapper was executed by NOTHING in the corpus in either direction:
  // 275 reaches of the effect wrapper across the lang suites, 0 of this one.
  const sim = new SimHandler({ turns: { huddle: { status: "done", at: 0 } } });
  const binder = Object.create(sim) as EffectHandler;
  binder.openConclave = async (req, ctx) => {
    await ctx.bind({ when: new Date(0) });
    return { channel: req.channel ?? "c-1" };
  };
  const journal = new Journal({ run: "r-bind-s" });
  let caught: unknown;
  try {
    await run(
      'const a = await spawn("a");\nconst b = await spawn("b");\nawait conclave([a, b], () => turn(a, { name: "huddle" }), { name: "triage" });',
      { runId: "r-bind-s", journal, handler: binder },
    );
  } catch (e) {
    caught = e;
  }
  // ASSERTED ON THE RECORD, NOT ON THE CAUGHT ERROR, and that is a finding rather than a style
  // choice: `performScope` records a coded EntryError and RETHROWS THE RAW REASON, so a program
  // catching a scope fault sees an error with no language code where the effect path hands it one.
  // Measured with a plain `throw new Error("boom")` on both paths, so it predates this guard and is
  // the scope path's own behaviour. Writing this cell by analogy to the effect side above would have
  // reded it for a reason that has nothing to do with the binding.
  const settled = journal.entries().find((e) => e.kind === "conclave");
  ok(
    "the scope wrapper is guarded too, on a real conclave, and the refusal is recorded against the scope",
    settled?.status === "failed" && settled?.error?.code === "L4000" && settled?.error?.kind === "scope-fault",
    { status: settled?.status, error: settled?.error?.code, kind: settled?.error?.kind },
  );
  ok(
    "and the scope's own binding never lands either, on the same narrowing",
    settled?.external === undefined,
    journal.entries().map((e) => ({ kind: e.kind, external: e.external })),
  );
}

{
  // THE LOAD SIDE, AND ITS INPUT IS HAND-BUILT OF NECESSITY. Once the write guards exist, no shipped
  // path can PRODUCE an entry whose binding has no canonical form (which is the point of them), so
  // the only way to hand one to a loader is to write it out here. Say that plainly: a hand-built
  // input proves the scan DEPENDS on the value, never that a real entry point reaches it. The
  // reachability half is carried by the driver cell in run-driver.smoke, which comes through
  // `run-driver.ts`'s own `new Journal({ entries })`, and the two together are the claim.
  const recorded = [
    {
      v: 1, seq: 0, run: "r-bind-l", scope: "", kind: "spawn", name: "b", occurrence: 0,
      inputHash: H({ persona: "b" }), state: "settled", status: "done", external: { when: new Date(0) },
    },
  ] as unknown as readonly JournalEntry[];
  let caught: unknown;
  try {
    new Journal({ run: "r-bind-l", entries: recorded });
  } catch (e) {
    caught = e;
  }
  ok(
    "a journal already carrying such a binding is refused ON LOAD, by name",
    (caught as { code?: string })?.code === "L5024",
    (caught as { code?: string })?.code ?? String(caught).slice(0, 90),
  );
  ok(
    "and the refusal says which entry and what is wrong with it, because 'this journal cannot load' is otherwise unactionable",
    /entry seq 0/.test(String((caught as Error)?.message)) && /spawn:b#0/.test(String((caught as Error)?.message)) && /has no canonical form/.test(String((caught as Error)?.message)),
    String((caught as Error)?.message).slice(0, 160),
  );
  // THE MIRROR, without which the cell above is satisfied by a scan that refuses everything.
  const fine = [
    {
      v: 1, seq: 0, run: "r-bind-m", scope: "", kind: "spawn", name: "b", occurrence: 0,
      inputHash: H({ persona: "b" }), state: "settled", status: "done", external: { simAgent: "sim.b", n: -0 },
    },
  ] as unknown as readonly JournalEntry[];
  const loaded = new Journal({ run: "r-bind-m", entries: fine });
  ok(
    "an ordinary recorded binding still loads, including the `-0` the rule admits and JSON does not preserve",
    loaded.entries().length === 1 && (loaded.entries()[0]?.external as { simAgent?: string })?.simAgent === "sim.b",
    loaded.entries().map((e) => e.external),
  );
}

{
  // THE DURABLE ROUTE, AND IT CORRECTS A CLAIM THE SOURCE AT THE FAULT USED TO MAKE. That comment
  // said every value `JSON.parse` can produce is one this rule ADMITS, so the driver's door was only
  // insurance against a FUTURE store. False, and the counter-example round-trips the store we ship:
  // `JSON.parse` installs its keys as OWN properties, so a journal TEXT carrying `"__proto__"` mints
  // an own field a literal cannot spell, `assertCrossable` refuses it by name, and `JSON.stringify`
  // writes it straight back out. This is the reachability half the hand-built cell above cannot
  // carry: nothing here is hand-built as an object, only text and the parse a store performs.
  //
  // THE TEXT IS A STRING LITERAL ON PURPOSE. Writing `{ "__proto__": 1 }` as an object literal SETS
  // A PROTOTYPE instead of naming a field, and `JSON.stringify` would then emit `{}`: a fixture
  // that silently stopped carrying the hazard, and a cell that goes green for the wrong reason. So
  // the first assertion below is about the FIXTURE, not the rule.
  const text = `{"v":1,"seq":0,"run":"r-bind-p","scope":"","kind":"spawn","name":"b","occurrence":0,`
    + `"inputHash":"${H({ persona: "b" })}","state":"settled","status":"done","external":{"__proto__":1}}`;
  const parsed = JSON.parse(text) as { external: unknown };
  ok(
    "the fixture really does carry an own `__proto__`, which is what makes it the hazard and not a prototype write",
    Object.prototype.hasOwnProperty.call(parsed.external, "__proto__")
      && Object.getPrototypeOf(parsed.external) === Object.prototype,
    Object.getOwnPropertyNames(parsed.external),
  );
  ok(
    "and the durable store writes it BACK, so the value round-trips the encoding this repo ships",
    JSON.stringify(parsed.external).includes('"__proto__"'),
    JSON.stringify(parsed.external),
  );
  let caughtProto: unknown;
  try {
    new Journal({ run: "r-bind-p", entries: [parsed] as unknown as readonly JournalEntry[] });
  } catch (e) {
    caughtProto = e;
  }
  ok(
    "so a journal PARSED from durable text is refused on load too, and the driver's door is not insurance against a future store",
    (caughtProto as { code?: string })?.code === "L5024" && /__proto__/.test(String((caughtProto as Error)?.message)),
    (caughtProto as { code?: string })?.code ?? String(caughtProto).slice(0, 90),
  );
}

// ---- a SCOPE's settled value answers to the same rule, and the durable arm is why --------------
//
// The write fence and the load door meet here on the one route that produced a SILENT wrong answer
// rather than a loud failure. Before the fence: this program completed on the walker with a
// function sitting in `result.value.a`, the durable store encoded the record with `JSON.stringify`
// exactly as core's `encodeRecord` does, the function went to the wire as `{}` with no error, and
// the resume replayed `undefined` where the live run had a function and raised NOTHING. Measured,
// all of it, before any of this existed.
//
// SO THE CELL BELOW IS ABOUT WHAT THE STORE CARRIES, not only about what the fence throws. It runs
// the program, round trips the journal the way the store does, and resumes: the recorded step must
// be a FAULT the resume reports, never an ok entry whose value quietly changed shape in transit.
{
  const src = `const r = await parallel({ a: async () => (x) => x }, { name: "p" });\nlog("a is", r.a);`;
  const pins = resolvePins({ runId: "scope-dur", seed: "scope-dur", startedAt: 0 }, 0, WALKER_LANGUAGE_VERSION);
  const live = new Journal({ run: "scope-dur" });
  const liveLogs: unknown[][] = [];
  const liveOutcome = await run(src, {
    runId: "scope-dur", handler: new SimHandler({}), journal: live, pins,
    onLog: (l) => liveLogs.push([...l.values]),
  } as never).then(() => ({ completed: true as const }), (e: Error) => ({ completed: false as const, name: e.name }));

  const settled = live.entries()[0];
  ok(
    "the scope is RECORDED as a fault rather than completing with a value the record cannot hold",
    liveOutcome.completed === false && liveOutcome.name === "NotCrossable"
      && settled?.status === "failed" && settled?.error?.code === "L4000" && settled?.kind === "parallel",
    { outcome: liveOutcome, status: settled?.status, code: settled?.error?.code },
  );
  ok(
    "and the program never saw the value either, because the refusal lands before the scope returns",
    liveLogs.length === 0,
    liveLogs,
  );

  // THE STORE'S OWN ENCODING, not a stand-in for it: `encodeRecord` is `JSON.stringify` over the
  // record, so this is the transit that used to lose the function without saying so.
  const onTheWire = JSON.parse(new TextDecoder().decode(new TextEncoder().encode(JSON.stringify({ entries: live.entries() })))) as { entries: readonly JournalEntry[] };
  const resumed = await resume(src, new Journal({ run: "scope-dur", entries: onTheWire.entries }), {
    runId: "scope-dur", handler: new SimHandler({}), pins, onLog: () => undefined,
  } as never).then(() => ({ replayed: true as const }), (e: Error & { code?: string }) => ({ replayed: false as const, code: e.code, name: e.name }));
  ok(
    "and a resume from the round-tripped record REPORTS that fault, where before this rule it replayed a silent `undefined` and completed",
    resumed.replayed === false,
    resumed,
  );
}

// ---- and a record written by something else, with a function in `result`, is refused on load ----
{
  const withFunction = [
    {
      v: 1, seq: 3, run: "r-res", scope: "", kind: "parallel", name: "p", occurrence: 0,
      inputHash: H({ persona: "b" }), state: "settled", status: "done",
      result: { branches: ["a"], value: { a: () => 1 } },
    },
  ] as unknown as readonly JournalEntry[];
  let caughtResult: unknown;
  try {
    new Journal({ run: "r-res", entries: withFunction });
  } catch (e) {
    caughtResult = e;
  }
  ok(
    "a hand-built record carrying a function in `result` is refused ON LOAD, by name",
    (caughtResult as { code?: string })?.code === "L5024",
    (caughtResult as { code?: string })?.code ?? String(caughtResult).slice(0, 90),
  );
  ok(
    "and it names the entry, the kind and the FIELD, so the operator knows which of the three doors refused",
    /entry seq 3/.test(String((caughtResult as Error)?.message))
      && /parallel/.test(String((caughtResult as Error)?.message))
      && /`result` UNREADABLE/.test(String((caughtResult as Error)?.message)),
    String((caughtResult as Error)?.message).slice(0, 170),
  );
  // THE MIRROR, and it is the one that keeps the absence exemption honest: a branch that produced
  // NO value is ordinary, and a scan that refused it would refuse most `parallel` records ever
  // written. Measured: fencing the assembled value whole did exactly that, on this suite's siblings.
  const absentBranch = [
    {
      v: 1, seq: 0, run: "r-res-m", scope: "", kind: "parallel", name: "p", occurrence: 0,
      inputHash: H({ persona: "b" }), state: "settled", status: "done",
      result: { branches: ["a", "b"], value: { a: undefined, b: 2 } },
    },
  ] as unknown as readonly JournalEntry[];
  const loadedScope = new Journal({ run: "r-res-m", entries: absentBranch });
  ok(
    "while a branch that answered NOTHING still loads, because absence is not a value that failed the rule",
    loadedScope.entries().length === 1,
    (loadedScope.entries()[0]?.result as { value?: unknown })?.value,
  );
}

// ---- and so is a failure's DETAIL, which a run can succeed while carrying -----------------------

/**
 * The second field a handler chooses and the record keeps. It is reachable in a way `external` is
 * not: a FAILING run never hands its entries anywhere, because the worker host builds a small
 * `{ok, code, name, message}` on that path, so `detail` only matters when the run SUCCEEDS, which
 * it does whenever the program catches the failure. Measured before this rule: such a run completed
 * in-process with a function sitting in a settled entry, and died through the worker on a
 * structured-clone error naming a host algorithm rather than the language.
 */
{
  // THE EFFECT SITE, on the real path: the program catches, so the run succeeds and the entry is
  // the only place the unreadable value could have survived.
  const sim = new SimHandler({});
  const thrower = Object.create(sim) as EffectHandler;
  thrower.turn = async () => {
    throw new EffectError("L6002", "handler-fault", "the handler refused", { cb: () => 1 });
  };
  const journal = new Journal({ run: "r-det-w" });
  let threw: unknown;
  try {
    await run(
      'const b = await spawn("b");\nlet caught = null;\ntry {\n  await turn(b, { name: "build" });\n} catch (e) {\n  caught = "caught";\n}\ncaught;',
      { runId: "r-det-w", journal, handler: thrower },
    );
  } catch (e) {
    threw = e;
  }
  // COMPLETION is the claim, not the program's value: a program whose last line is a statement ends
  // with no value at all, and it is the run REACHING ITS END that leaves the failed entry behind for
  // a loader to meet.
  ok("a program that catches an effect failure still COMPLETES, which is what makes the detail reachable at all",
    threw === undefined, threw === undefined ? "completed" : String((threw as Error).message).slice(0, 80));
  const failed = journal.entries().find((e) => e.status === "failed");
  ok(
    "a failure whose detail has no canonical form is recorded as the handler fault it is, not with the code the handler chose",
    failed?.error?.code === "L4000" && failed?.error?.kind === "handler-fault",
    failed?.error,
  );
  ok(
    "...and the unreadable detail is not recorded at all, with the record saying why rather than dropping it silently",
    failed?.error?.detail === undefined && /could not be recorded/.test(String(failed?.error?.message)) && /the handler refused/.test(String(failed?.error?.message)),
    failed?.error?.message,
  );
}

{
  // THE SCOPE SITE. Its own guard, because a fix at the effect site alone leaves this one open,
  // the same half-fence the two bind wrappers had.
  const sim = new SimHandler({ turns: { huddle: { status: "done", at: 0 } } });
  const thrower = Object.create(sim) as EffectHandler;
  thrower.openConclave = async () => {
    throw new EffectError("L6002", "handler-fault", "the room refused", { cb: () => 1 });
  };
  const journal = new Journal({ run: "r-det-s" });
  try {
    await run(
      'const a = await spawn("a");\nconst b = await spawn("b");\nawait conclave([a, b], () => turn(a, { name: "huddle" }), { name: "triage" });',
      { runId: "r-det-s", journal, handler: thrower },
    );
  } catch {
    // The scope path rethrows its raw reason, which is the parked asymmetry; the record is the subject here.
  }
  const scoped = journal.entries().find((e) => e.kind === "conclave");
  ok(
    "the same rule on the scope's own failure record, which a fix at the effect site alone would leave open",
    scoped?.error?.code === "L4000" && scoped?.error?.kind === "scope-fault" && scoped?.error?.detail === undefined,
    scoped?.error,
  );
}

{
  // THE LOAD DOOR, for the second field. Hand-built for the same reason the binding's load cell is:
  // with the write guards in place nothing shipped can produce such an entry.
  const bad = [
    {
      v: 1, seq: 0, run: "r-det-l", scope: "", kind: "turn", name: "build", occurrence: 0,
      inputHash: H({ name: "build" }), state: "settled", status: "failed",
      error: { code: "L6002", kind: "handler-fault", message: "refused", detail: { when: new Date(0) } },
    },
  ] as unknown as readonly JournalEntry[];
  let caught: unknown;
  try {
    new Journal({ run: "r-det-l", entries: bad });
  } catch (e) {
    caught = e;
  }
  ok(
    "a recorded failure detail with no canonical form is refused on load by the same door, naming the FIELD",
    (caught as { code?: string })?.code === "L5024" && /error\.detail/.test(String((caught as Error)?.message)),
    String((caught as Error)?.message).slice(0, 130),
  );
  // THE MIRROR, so the door is not satisfied by refusing every failure that carries a detail.
  const fine = [
    {
      v: 1, seq: 0, run: "r-det-m", scope: "", kind: "turn", name: "build", occurrence: 0,
      inputHash: H({ name: "build" }), state: "settled", status: "failed",
      error: { code: "L6002", kind: "handler-fault", message: "refused", detail: { why: "no capacity", after: 3 } },
    },
  ] as unknown as readonly JournalEntry[];
  const loaded = new Journal({ run: "r-det-m", entries: fine });
  ok(
    "an ordinary failure detail still loads, so the door reads the value rather than the field's presence",
    (loaded.entries()[0]?.error?.detail as { why?: string })?.why === "no capacity",
    loaded.entries()[0]?.error,
  );
}

console.log(`journal.smoke: ${pass} checks passed`);
