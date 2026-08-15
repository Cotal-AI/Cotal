/**
 * The journal's proof: resume returns recorded results, a changed input is a diagnosable
 * divergence rather than a silent re-run, a crash mid-effect leaves something recoverable, and
 * the run clock is deterministic under replay including inside concurrency.
 *
 * The negative cases matter most. Silently re-running an effect whose inputs changed is the exact
 * bug this keying scheme exists to prevent, so "diverged" has to be a verdict the interpreter
 * cannot accidentally treat as "miss".
 */
import { Journal, RunClock, type JournalEntry } from "../src/journal.js";
import { KeyScope, digest } from "../src/keys.js";
import { run } from "../src/interpret.js";
import { SimHandler } from "../src/sim.js";
import type { EffectHandler } from "../src/effects.js";

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
 * The store saying no and the world saying no are different facts, and the journal used to record
 * them as the same one. A handler that completed plus an append the store rejected produced the
 * durable sequence `[pending, settled:failed]` — a permanent record that work which really happened
 * had failed — because one `try` covered both the dispatch and the settling append, and the map was
 * mutated before the append was awaited.
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

console.log(`journal.smoke: ${pass} checks passed`);
