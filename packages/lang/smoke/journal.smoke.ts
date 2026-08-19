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

// ---- 3b) ...and it recovers the resource for THAT effect, not for whichever ran first ----------
//
// Cell 3 keeps one row, so the row it reads is also the only row a bind could have written, and a
// `bind` that ignored its key entirely would satisfy it. Measured, not argued: with
// `Journal.bind` targeting `this.byKey.keys().next().value` instead of the key it was handed, all
// fifteen lang suites stayed green at 788 checks while the fact landed on an unrelated settled
// row. That is worse than a missing bind, because the row the resume reads has no external and the
// row that does have one describes work that is already finished, so recovery re-creates the
// resource AND the record points somewhere that will never be resumed.
//
// Two rows are the whole repair: the effect that binds is not the first one, so the target and the
// default stop being the same row.
{
  const j = new Journal({ run: "r-3b" });
  const s = new KeyScope();
  const first = s.nextEffect("turn", "warm");
  const second = s.nextEffect("turn", "build");
  const h1 = H({ agent: "warmer" });
  const h2 = H({ agent: "builder" });
  await j.begin(first, h1, 1000);
  await j.settle(first, { status: "ok", result: { status: "done", at: 1100 } }, 1100);
  await j.begin(second, h2, 1000);
  await j.bind(second, { goalId: "g-88" });

  const resumed = new Journal({ run: "r-3b", entries: j.entries() });
  const s2 = new KeyScope();
  const vFirst = resumed.lookup(s2.nextEffect("turn", "warm"), h1);
  const vSecond = resumed.lookup(s2.nextEffect("turn", "build"), h2);
  ok(
    "the bind lands on the effect that asked for it, not on whichever row came first",
    vSecond.verdict === "pending"
      && (vSecond.entry.external as { goalId?: string } | undefined)?.goalId === "g-88",
    JSON.stringify(resumed.entries().map((e) => ({ name: e.name, external: e.external }))),
  );
  const firstExternal = vFirst.verdict === "replay" ? vFirst.entry.external : "not replayable";
  ok(
    "and the row that did not bind is left alone, so no settled effect carries a live resource",
    vFirst.verdict === "replay" && firstExternal === undefined,
    JSON.stringify({ verdict: vFirst.verdict, external: firstExternal }),
  );
}

// ---- 3c) ...and the scope is part of that identity, not just the step's own name ---------------
//
// 3b's two rows differ by NAME, so a bind that matched on the leaf alone (kind, name, occurrence)
// and discarded the scope path would still land on the right row and the cell would pass. Measured
// by a review, not argued: with `Journal.keyOf` reduced to the leaf, all fifteen lang suites stayed
// green while a bind meant for one parallel branch landed on the other. Sibling branches are the
// case that actually collides, because a parallel runs the SAME step in each of them: `left` and
// `right` here both hold `turn:build#0` and differ only in the branch they run under. Recovery
// reads the branch that never bound, so it re-creates the resource, while the branch that did bind
// carries a reference to work the other branch owns.
{
  const j = new Journal({ run: "r-3c" });
  const s = new KeyScope();
  const occ = s.nextScope("parallel", "review");
  const left = s.branch("parallel", "review", occ, "left").nextEffect("turn", "build");
  const right = s.branch("parallel", "review", occ, "right").nextEffect("turn", "build");
  const h = H({ agent: "builder" });
  await j.begin(left, h, 1000);
  await j.begin(right, h, 1000);
  await j.bind(right, { goalId: "g-right" });

  const resumed = new Journal({ run: "r-3c", entries: j.entries() });
  const s2 = new KeyScope();
  const occ2 = s2.nextScope("parallel", "review");
  const vLeft = resumed.lookup(s2.branch("parallel", "review", occ2, "left").nextEffect("turn", "build"), h);
  const vRight = resumed.lookup(s2.branch("parallel", "review", occ2, "right").nextEffect("turn", "build"), h);
  ok(
    "the bind lands in the branch that asked for it, and its sibling running the same step is untouched",
    vRight.verdict === "pending" && vLeft.verdict === "pending"
      && (vRight.entry.external as { goalId?: string } | undefined)?.goalId === "g-right"
      && vLeft.entry.external === undefined,
    JSON.stringify(resumed.entries().map((e) => ({ scope: e.scope, name: e.name, external: e.external }))),
  );
}

// ---- 3d) ...and so is the occurrence, which neither the scope nor the leaf name pins down -------
//
// 3b's two rows differ by NAME and 3c's by SCOPE, so a bind that matched on (scope, kind, name) and
// discarded the occurrence lands on the right row in both and both cells stay green. A loop is the
// case that collides: one scope runs `turn:build` twice, so the two rows differ ONLY by occurrence.
// Measured by a review, not argued: with `Journal.bind` selecting the first entry that matches
// scope, kind and name alone, all fifteen lang suites stayed green while the second iteration's
// reference landed on the first iteration's settled row. Recovery then resumes the iteration that
// is still pending with no external at all and re-creates the resource, while the iteration that
// already finished carries a live reference to work nobody will resume.
{
  const j = new Journal({ run: "r-3d" });
  const s = new KeyScope();
  const first = s.nextEffect("turn", "build");
  const second = s.nextEffect("turn", "build");
  const h = H({ agent: "builder" });
  await j.begin(first, h, 1000);
  await j.settle(first, { status: "ok", result: { status: "done", at: 1100 } }, 1100);
  await j.begin(second, h, 1200);
  await j.bind(second, { goalId: "g-second" });

  const resumed = new Journal({ run: "r-3d", entries: j.entries() });
  const s2 = new KeyScope();
  const vFirst = resumed.lookup(s2.nextEffect("turn", "build"), h);
  const vSecond = resumed.lookup(s2.nextEffect("turn", "build"), h);
  const firstExternal = vFirst.verdict === "replay" ? vFirst.entry.external : "not replayable";
  ok(
    "the bind lands on the iteration that asked for it, and the earlier one running the same step under the same scope is untouched",
    vSecond.verdict === "pending"
      && (vSecond.entry.external as { goalId?: string } | undefined)?.goalId === "g-second"
      && vFirst.verdict === "replay" && firstExternal === undefined,
    JSON.stringify(resumed.entries().map((e) => ({ occurrence: e.occurrence, external: e.external }))),
  );
}

// ---- 3e) ...and the KIND, the last field of the key with no cell of its own ------------------
//
// The key is (scope, kind, name, occurrence). 3b pins the name, 3c the scope, 3d the occurrence,
// and each of those three cells is satisfied by a lookup that discards the KIND, because in every
// one of them the two rows already differ in the field that cell is about. The collision this needs
// is one scope running two DIFFERENT kinds under the SAME name: `KeyScope.nextEffect` counts
// occurrences per `${kind}:${name}` tag, so `turn:build` and `checkpoint:build` are both #0 and
// differ in nothing else. A kind-discarding lookup then lands the checkpoint's reference on the
// settled turn, which is the same durable loss the three cells above describe, reached through the
// one field none of them constrains.
{
  const j = new Journal({ run: "r-3e" });
  const s = new KeyScope();
  const turn = s.nextEffect("turn", "build");
  const cp = s.nextEffect("checkpoint", "build");
  const h = H({ agent: "builder" });
  await j.begin(turn, h, 1000);
  await j.settle(turn, { status: "ok", result: { status: "done", at: 1100 } }, 1100);
  await j.begin(cp, h, 1200);
  await j.bind(cp, { goalId: "g-checkpoint" });

  const resumed = new Journal({ run: "r-3e", entries: j.entries() });
  const s2 = new KeyScope();
  const vTurn = resumed.lookup(s2.nextEffect("turn", "build"), h);
  const vCp = resumed.lookup(s2.nextEffect("checkpoint", "build"), h);
  const turnExternal = vTurn.verdict === "replay" ? vTurn.entry.external : "not replayable";
  ok(
    "the bind lands on the kind that asked for it, and the other kind sharing its name and occurrence is untouched",
    vCp.verdict === "pending"
      && (vCp.entry.external as { goalId?: string } | undefined)?.goalId === "g-checkpoint"
      && vTurn.verdict === "replay" && turnExternal === undefined,
    JSON.stringify(resumed.entries().map((e) => ({ kind: e.kind, name: e.name, external: e.external }))),
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
  const sim = new SimHandler({ turns: { build: [{ status: "done", at: 0 }] } });
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

console.log(`journal.smoke: ${pass} checks passed`);
