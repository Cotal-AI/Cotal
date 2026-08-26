/**
 * The concurrency scopes' proof: a scope is a durable record, and a replayed `race` resolves the
 * arm it resolved before.
 *
 * This suite exists because the interpreter shipped without it. Scopes pushed a key frame,
 * allocated an occurrence, and journalled NOTHING, so `race` was a bare `Promise.race`: both arms
 * could settle before the cancellation reached the loser, leaving two successful branches in the
 * journal and nothing recording which had won. A replayed run could then take the other path and
 * reach a step that was never recorded — a durable choice decided by the event loop.
 *
 * So the cells below are about WHAT IS RECORDED and WHAT REPLAY DOES WITH IT, not about whether
 * concurrency works. Section 4 is the one that matters: it hands the interpreter a journal where
 * both arms succeeded and requires the same winner every time.
 */
import { run, resume } from "../src/interpret.js";
import { validate } from "../src/grammar.js";
import { SimHandler } from "../src/sim.js";
import { Journal, type JournalEntry } from "../src/journal.js";
import type { EffectHandler } from "../src/effects.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ok ${name}`);
};

const logged: unknown[][] = [];
const sink = (line: { scope: string; values: readonly unknown[] }) => {
  logged.push([...line.values]);
};

const scopeOf = (j: Journal, kind: string) => j.entries().find((e) => e.kind === kind);

// ---- 1) a race is journalled, with BOTH the index and the value ------------------------------

// The arms are declared SLOW FIRST on purpose. If the winner were "whichever fulfilled promise
// comes first in declaration order" — which is what the code did before, and what a plausible
// simplification of it would do again — this program would resolve `slow`. The earliest arm being
// the second one declared is the only shape in which those two rules disagree, and a fixture where
// they agree cannot tell them apart.
//
// Each arm also LOGS on entry. Logs are not journalled, so they are the detector for section 4's
// real claim: a settled scope must deliver from its own entry and enter no branch at all, which is
// a stronger statement than "no live effect was performed" — the branches' own effects would
// replay from their own entries and look innocent.
const RACE = `
const r = await race({
  slow: async () => { log("entered-slow"); await sleep("5m"); return "from-slow"; },
  fast: async () => { log("entered-fast"); await sleep("1m"); return "from-fast"; },
}, { name: "first-answer" });
log(r.index, r.value);
`;

let raceJournal: Journal;
// The pins the recorded race ran under. Every replay below is a resume and carries them: resolving
// them again would put the replay on this host's clock and a re-seeded PRNG.
let racePins: import("../src/index.js").RunPins;
{
  logged.length = 0;
  // Caught, because the way a race breaks is not always a wrong answer. A rule that lets the
  // CANCELLED loser count as a candidate makes the winner a rejection, and the whole scope fails —
  // an uncaught throw here would kill the suite from outside every assertion, which reads as a
  // crash rather than as this rule being broken.
  let liveError: unknown;
  let r!: Awaited<ReturnType<typeof run>>;
  try {
    r = await run(RACE, { runId: "r-1", handler: new SimHandler({}), onLog: sink });
  } catch (e) {
    liveError = e;
  }
  ok("a live race resolves rather than failing on the branch it cancelled", liveError === undefined,
    String(liveError).slice(0, 80));
  raceJournal = r.journal;
  racePins = r.pins;

  const scope = scopeOf(r.journal, "race");
  ok("a race appends a scope entry of its own kind", scope !== undefined && scope.kind === "race");
  ok("keyed by its name and occurrence", scope?.name === "first-answer" && scope?.occurrence === 0);
  ok("it records the branches it launched", JSON.stringify((scope?.result as { branches: string[] }).branches) === '["slow","fast"]');

  const value = (scope?.result as { value: { index: string; value: unknown } }).value;
  // On the LIVE pass the simulator advances ONE virtual clock serially and both sleeps are in
  // flight before either settles, so both arms record the SAME endedAt (measured: 360000 and
  // 360000) and the tie goes to declaration order. That is a property of the simulator, not of the
  // rule, and it is fine: the live pass is where the choice is MADE and RECORDED, and the rule
  // itself is held by the disagreeing-clocks cell below and by section 4's replay. What must never
  // vary is what a replay does with the record.
  ok("the live pass records a winner (a simulator tie, broken by declaration order)", value.index === "slow", value);
  ok("both arms did run on the live pass", logged.some((l) => l[0] === "entered-slow") && logged.some((l) => l[0] === "entered-fast"));
  ok(
    "and BOTH the index and the value are recorded, so an edit to the arm's expression cannot resume as the new value",
    value.value === "from-slow",
    value,
  );
  const said = logged.find((l) => l.length === 2);
  ok("the program saw the same winner the journal recorded", said?.[0] === value.index && said?.[1] === value.value, logged);

  ok("the losers are recorded WITH the outcome, as intent", JSON.stringify(scope?.cancel?.losers) === '["fast"]');
  ok(
    "and the intent is UNDISCHARGED: a journal write cancels nothing by itself",
    scope?.cancel?.issued === false,
  );
}

// ---- 1b) LIVE, the recorded clocks decide, not the order the arms woke in -------------------
//
// A handler whose sleeps resolve in WALL order that disagrees with the clocks they record: the arm
// declared first wakes first with the LATER clock, the arm declared second wakes 25ms later with the
// EARLIER clock. Under "first to wake wins" the winner is `slow`; under the rule (least branch clock
// among settled arms) it is `fast`. This is the only live shape in which the two rules disagree, so
// it is the cell that goes red if the live pick ever falls back to wake order.
{
  class RecordedClock extends SimHandler {
    private stamp = 0;
    override now(): number { return this.stamp; }
    override async sleep(req: Parameters<SimHandler["sleep"]>[0], _ctx: Parameters<SimHandler["sleep"]>[1]) {
      const ms = req.duration === "5m" ? 0 : 25;
      await new Promise((r) => setTimeout(r, ms));
      this.stamp = req.duration === "5m" ? 300000 : 60000;
      return null;
    }
  }
  logged.length = 0;
  const r = await run(RACE, { runId: "r-1b", handler: new RecordedClock({}), onLog: sink });
  const scope = scopeOf(r.journal, "race");
  const value = (scope?.result as { value: { index: string; value: unknown } }).value;
  ok("a live race is decided by the recorded clocks, not by which arm woke first",
    value.index === "fast" && value.value === "from-fast", value);
  ok("and the program saw that winner", logged.some((l) => l[0] === "fast" && l[1] === "from-fast"), logged);
  ok("and the arm that woke first is the recorded loser", JSON.stringify(scope?.cancel?.losers) === '["slow"]', scope?.cancel);
}

// ---- 2) a parallel records branch keys and NO selected winner --------------------------------

{
  const r = await run(
    `await parallel({ a: async () => { await sleep("1m"); return 1; }, b: async () => { await sleep("2m"); return 2; } }, { name: "both" });`,
    { runId: "r-2", handler: new SimHandler({}) },
  );
  const scope = scopeOf(r.journal, "parallel");
  ok("a parallel appends its own scope entry", scope !== undefined);
  ok("recording its branch keys", JSON.stringify((scope?.result as { branches: string[] }).branches) === '["a","b"]');
  ok(
    "and NO selected winner, which is why an array index is a lint there and an error for race",
    scope?.cancel === undefined,
  );
}

// ---- 3) a fanOut records the keys its branches were namespaced by ----------------------------

{
  const r = await run(
    `await fanOut(["security", "perf"], async (lens) => { await sleep("1m"); return lens; }, { name: "reviews", key: (lens) => lens });`,
    { runId: "r-3", handler: new SimHandler({}) },
  );
  const scope = scopeOf(r.journal, "fanOut");
  ok("a fanOut appends its own scope entry", scope !== undefined);
  ok(
    "keyed by the stable branch keys, not by list position",
    JSON.stringify((scope?.result as { branches: string[] }).branches) === '["security","perf"]',
  );
}

// ---- 3b) a fanOut branch that rejects fails the scope and cancels its siblings ----------------
//
// The same law as `parallel`. Measured before it: a rejecting branch threw out of the scope alone,
// and its siblings went on performing effects against a scope whose entry had already settled
// failed. The handler below wakes `c`'s first sleep AFTER `b` has thrown, so `c` is the branch that
// would begin a new effect past the failure; the cell holds that it never does.
{
  const performed: string[] = [];
  class Staggered extends SimHandler {
    override async sleep(req: Parameters<SimHandler["sleep"]>[0], ctx: Parameters<SimHandler["sleep"]>[1]) {
      const name = String((ctx as { key?: { name?: string } }).key?.name ?? "");
      performed.push(name);
      await new Promise((r) => setTimeout(r, name === "first-c" ? 30 : 1));
      return await super.sleep(req, ctx);
    }
  }
  logged.length = 0;
  const r = await run(
    `try {
  await fanOut(["a", "b", "c"], async (x) => {
    await sleep("1m", { name: "first-" + x });
    if (x === "b") { throw { code: "mine", x }; }
    await sleep("1m", { name: "second-" + x });
    return x;
  }, { name: "f", key: (x) => x });
} catch (e) { log("caught", e.code, e.x); }
await sleep("1m", { name: "after" });`,
    { runId: "r-3b", handler: new Staggered(), onLog: sink },
  );
  const scope = scopeOf(r.journal, "fanOut");
  ok("a rejecting fanOut branch fails the scope with the branch's own thrown value, which the program can catch",
    JSON.stringify(logged) === '[["caught","mine","b"]]', logged);
  ok("and the siblings are cancelled: a branch whose effect completes after the failure begins no new effect",
    !performed.includes("second-c") && performed.includes("after"), performed);
  ok("and the failed scope entry records the losers as intent, like a failed parallel",
    scope?.status === "failed" && JSON.stringify(scope?.cancel?.losers) === '["a","c"]' && scope?.cancel?.issued === false,
    { status: scope?.status, cancel: scope?.cancel });
}

// ---- 4) THE ONE THAT MATTERS: a replayed race cannot re-decide -------------------------------

{
  // A settled race, replayed against an EMPTY simulation script. The simulator refuses every
  // unscripted effect with L6001, so if replay re-entered a branch it would die rather than
  // quietly resolve. Completing is the proof that no branch was entered.
  logged.length = 0;
  const j = new Journal({ run: "r-1", entries: raceJournal.entries() });
  await resume(RACE, j, { runId: "r-1", pins: racePins, handler: new SimHandler({}), onLog: sink });
  ok(
    "a settled race ENTERS NO BRANCH: neither arm's body ran",
    !logged.some((l) => String(l[0]).startsWith("entered-")),
    logged,
  );
  ok("and the program is handed the recorded winner", logged[0]?.[0] === "slow", logged);
  ok("and the recorded value, not a re-derived one", logged[0]?.[1] === "from-slow");
  ok("its subtree is accounted for rather than left as removed steps", j.orphans().length === 0, j.orphans().map((o) => o.kind));
}

{
  // The crash case the scope entry exists for: BOTH arms settled before the cancellation reached
  // the loser, and the scope itself never settled. Re-entering re-runs both branches from their
  // recorded results, so scheduling decides which promise resumes first — and the winner must NOT
  // be that. It must be the earliest recorded branch, every time.
  //
  // The fixture is built so DECLARATION ORDER AND RECORDED TIME DISAGREE: `slow` is declared first
  // and finished at 300000, `fast` is declared second and finished at 60000. A rule that took the
  // first fulfilled branch in order would answer `slow`; the recorded times say `fast`. Without
  // that disagreement the two rules are indistinguishable and this section proves nothing, which is
  // exactly what a mutation run showed about its first version.
  const entries = raceJournal.entries().map((e): JournalEntry => {
    if (e.kind === "race") {
      return { v: 1, seq: e.seq, run: e.run, scope: e.scope, kind: e.kind, name: e.name, occurrence: e.occurrence, inputHash: e.inputHash, state: "pending", startedAt: e.startedAt };
    }
    if (e.kind === "sleep") {
      const at = e.scope.endsWith("/b:fast") ? 60_000 : 300_000;
      return { ...e, startedAt: 0, endedAt: at };
    }
    return e;
  });
  ok("the fixture really does have a pending scope over two settled arms",
    entries.filter((e) => e.state === "pending").length === 1
    && entries.filter((e) => e.kind === "sleep" && e.status === "ok").length === 2);
  ok("and its recorded times disagree with declaration order, or the two rules cannot be told apart",
    (entries.find((e) => e.scope.endsWith("/b:fast"))?.endedAt ?? 0) < (entries.find((e) => e.scope.endsWith("/b:slow"))?.endedAt ?? 0));

  const winners: unknown[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    logged.length = 0;
    const jj = new Journal({ run: "r-1", entries });
    await resume(RACE, jj, { runId: "r-1", pins: racePins, handler: new SimHandler({}), onLog: sink });
    winners.push(logged.find((l) => l.length === 2)?.[0]);
  }
  ok("a re-entered race resolves the SAME arm every time", new Set(winners).size === 1, winners);
  ok("and it is the earliest arm, not the first one declared or the first the event loop woke", winners[0] === "fast", winners);
}

// ---- 5) a failed parallel owes its losers too -------------------------------------------------

{
  const FAILING = `
await parallel({
  ok:  async () => { await sleep("5m"); return 1; },
  bad: async () => { await turn(await spawn("x"), { name: "boom" }); },
}, { name: "both" });
`;
  let caught: unknown;
  let journal: Journal | undefined;
  try {
    await run(FAILING, {
      runId: "r-5",
      handler: new SimHandler({ faults: [{ at: "/parallel:both#0/b:bad/turn:boom#0", kind: "agent-down" }] }),
    });
  } catch (e) {
    caught = e;
  }
  ok("a rejecting branch fails the scope", caught !== undefined);

  // Re-run capturing the journal: the scope's failure has to carry the siblings it cancelled,
  // because a rejecting branch can crash before they hear about it.
  const j2 = new Journal({ run: "r-5b" });
  try {
    await run(FAILING, {
      runId: "r-5b",
      journal: j2,
      handler: new SimHandler({ faults: [{ at: "/parallel:both#0/b:bad/turn:boom#0", kind: "agent-down" }] }),
    });
  } catch {
    journal = j2;
  }
  const scope = journal === undefined ? undefined : scopeOf(journal, "parallel");
  ok("the failed scope is journalled as failed", scope?.status === "failed", scope?.status);
  ok("carrying the sibling it cancelled", JSON.stringify(scope?.cancel?.losers) === '["ok"]', scope?.cancel);
  ok("with the cancellation still undischarged", scope?.cancel?.issued === false);
}

{
  // THE SAME ENVELOPE RULE ON THE PARALLEL PATH. A branch may throw a primitive, and the losers are
  // the interpreter's fact about the scope, not a property to staple onto whatever the program
  // threw — `Object.assign(null, …)` is a TypeError, which would have replaced the branch's failure
  // with the recorder's and lost the cancellation intent with it.
  const j = new Journal({ run: "r-5c" });
  let caught: unknown = "nothing was thrown";
  try {
    await run('await parallel({ ok: async () => { await sleep("5m"); return 1; }, bad: async () => { throw null; } }, { name: "both" });',
      { runId: "r-5c", journal: j, handler: new SimHandler({}) });
  } catch (e) {
    caught = e;
  }
  const scope = scopeOf(j, "parallel");
  ok("a branch that throws a PRIMITIVE fails the scope with its own value", caught === null, String(caught));
  ok("and the losers are still recorded", JSON.stringify(scope?.cancel?.losers) === '["ok"]', scope?.cancel);
  ok("with the thrown value described rather than the recorder's own failure",
    scope?.error?.message === "null", scope?.error);
}

// ---- 6) conclave: a scope that is also an effect ---------------------------------------------

/**
 * A conclave gets ONE journal entry, of kind `conclave`, and that entry answers "is this sub-team
 * still live" — with an explicit `closed` FACT, not with its state. The state cannot answer it: a
 * body that failed after a clean close settles `failed` exactly like one whose close never
 * acknowledged, and a cancelled conclave is settled with its membership deliberately still joined.
 * Pending means a close is still owed. The migrate table reads the fact when it rejects an orphaned
 * conclave "unless the scope closed".
 *
 * The handler is watched method by method rather than spread over the simulator. A spread loses
 * SimHandler's prototype methods and the run dies as a handler fault, which is how this suite's
 * sibling learned the difference.
 */
const watching = (inner: SimHandler, slowSleep = false) => {
  const calls: string[] = [];
  const handler: EffectHandler = {
    now: () => inner.now(),
    spawn: (r, c) => inner.spawn(r, c),
    turn: (r, c) => inner.turn(r, c),
    ask: (r, c) => inner.ask(r, c),
    checkpoint: (r, c) => inner.checkpoint(r, c),
    // A macrotask, so that a race's arms settle in an order this test decides rather than one the
    // microtask queue happens to produce.
    sleep: async (r, c) => {
      if (slowSleep) await new Promise<void>((res) => setTimeout(res, 0));
      return await inner.sleep(r, c);
    },
    wait: (r, c) => inner.wait(r, c),
    notify: (r, c) => inner.notify(r, c),
    monitor: (r, c) => inner.monitor(r, c),
    openConclave: async (r, c) => {
      calls.push("open");
      return await inner.openConclave(r, c);
    },
    closeConclave: async (r, c) => {
      calls.push("close");
      return await inner.closeConclave(r, c);
    },
  };
  return { handler, calls };
};

const CONCLAVE = `
const a = await spawn("a", { name: "a" });
const out = await conclave([a], async (ch) => {
  log("inside");
  await sleep("1m", { name: "huddling" });
  return ch.channel;
}, { name: "huddle", channel: "war-room" });
log("out", out);
`;

let conclaveJournal: Journal;
let conclavePins: import("../src/index.js").RunPins;
{
  logged.length = 0;
  const { handler, calls } = watching(new SimHandler({}));
  const r = await run(CONCLAVE, { runId: "c-1", handler, onLog: sink });
  conclaveJournal = r.journal;
  conclavePins = r.pins;

  ok("a conclave opens and closes around its body", JSON.stringify(calls) === '["open","close"]', calls);
  ok("the body ran between them", logged.some((l) => l[0] === "inside"));
  ok("and the channel option reached the handler, so the body got the room it asked for",
    logged.find((l) => l[0] === "out")?.[1] === "war-room", logged);

  const scope = scopeOf(r.journal, "conclave");
  ok("it is journalled as ONE entry of its own kind, not as an open and a close", scope !== undefined
    && r.journal.entries().filter((e) => e.kind === "conclave").length === 1);
  ok("settled ok", scope?.status === "ok");
  // The status cannot answer "did this sub-team close" on its own: a CANCELLED conclave is also
  // `settled`, deliberately still open, and a scope whose body AND close both failed settles
  // `failed` too. So the closure is its own fact.
  ok("and it STATES that it closed, which is what an orphan walk reads", scope?.closed === true);
  ok("recording its single branch", JSON.stringify((scope?.result as { branches: string[] }).branches) === '["in"]',
    scope?.result);
  // And the branch key is checked WHERE IT BITES: on the scope path the body's own steps were filed
  // under. The recorded `branches` list is a claim, and a first version of this section asserted
  // only the claim — which a namespace keyed by the handler-minted channel satisfies while filing
  // every step somewhere else. A mutation run said so.
  const inner = conclaveJournal.entries().find((e) => e.kind === "sleep");
  ok(
    "and the body's steps are filed under that key, not under the handler-minted channel name",
    inner?.scope === "/conclave:huddle#0/b:in",
    inner?.scope,
  );
  ok("and it carries a request id, because it DISPATCHED: a crash after the mint must not lose who opened the room",
    typeof scope?.requestId === "string" && (scope?.requestId as string).length > 0, scope?.requestId);
  // The control. A scope that launches thunks and calls no handler has no request to identify, and
  // minting one anyway would be a durable field that means nothing.
  ok("while a parallel, which dispatches nothing, carries none", scopeOf(raceJournal, "race")?.requestId === undefined);
}

{
  // Replay. A settled conclave ENTERS NO BRANCH and RE-OPENS NOTHING: the members already left, so
  // re-joining them would recreate a room the recorded run had torn down.
  logged.length = 0;
  const { handler, calls } = watching(new SimHandler({}));
  const j = new Journal({ run: "c-1", entries: conclaveJournal.entries() });
  await resume(CONCLAVE, j, { runId: "c-1", pins: conclavePins, handler, onLog: sink });
  ok("a settled conclave re-opens nothing", JSON.stringify(calls) === "[]", calls);
  ok("and enters no branch", !logged.some((l) => l[0] === "inside"), logged);
  ok("the program still receives the recorded room", logged.find((l) => l[0] === "out")?.[1] === "war-room", logged);
  ok("and the body's own steps are accounted for, not left as removed steps", j.orphans().length === 0,
    j.orphans().map((o) => o.kind));
}

{
  // The members are part of the conclave's IDENTITY (`hashesSubject`), so editing the guest list
  // must diverge rather than resume into a different room with the old room's recorded answer.
  const BEFORE = `
const a = await spawn("a", { name: "a" });
const b = await spawn("b", { name: "b" });
await conclave([a], async (ch) => ch.channel, { name: "huddle" });
`;
  const AFTER = BEFORE.replace("conclave([a]", "conclave([a, b]");
  const { handler } = watching(new SimHandler({}));
  const r = await run(BEFORE, { runId: "c-2", handler });
  let caught: unknown;
  try {
    await resume(AFTER, new Journal({ run: "c-2", entries: r.journal.entries() }), { runId: "c-2", pins: r.pins, handler });
  } catch (e) {
    caught = e;
  }
  ok("adding a member diverges rather than replaying the old room's answer",
    (caught as { stepKey?: string })?.stepKey === "/conclave:huddle#0", String(caught).slice(0, 100));
  ok("and it is reported as a run divergence, with the fork the author can take from here",
    String((caught as Error)?.message).includes("L5001") && String((caught as Error)?.message).includes("fork(run,"),
    String(caught).slice(0, 120));
}

{
  // A body that FAILS still closes. This process is live and the world is reachable, so walking
  // away from joined members would be the `spawn` leak in another shape.
  const FAILING = `
const a = await spawn("a", { name: "a" });
await conclave([a], async (ch) => { await turn(a, { name: "t" }); return 1; }, { name: "huddle" });
`;
  const { handler, calls } = watching(
    new SimHandler({ faults: [{ at: "/conclave:huddle#0/b:in/turn:t#0", kind: "agent-down" }] }),
  );
  const j = new Journal({ run: "c-3" });
  let caught: unknown;
  try {
    await run(FAILING, { runId: "c-3", journal: j, handler });
  } catch (e) {
    caught = e;
  }
  ok("a failing body fails the conclave", caught !== undefined);
  ok("but the room is still closed", JSON.stringify(calls) === '["open","close"]', calls);
  ok("and the entry says it failed, not that it never happened", scopeOf(j, "conclave")?.status === "failed");
  ok("and it STATES that the room closed, because the status alone cannot say so",
    scopeOf(j, "conclave")?.closed === true, scopeOf(j, "conclave")?.closed);
}

{
  /**
   * A BODY MAY THROW A PRIMITIVE, and the disposition must survive it.
   *
   * `throw` is part of the language and `null` is a value, so a body can fail with something that
   * is not an object. Writing the facts ONTO the thrown value with `Object.assign` is a TypeError
   * on `null`, thrown after the close has been acknowledged: the caller gets a manufactured type
   * error instead of the body's own failure, and the entry records `closed: undefined` for a room
   * that was genuinely closed, so an orphan walk rejects a correctly closed conclave. The facts are
   * the interpreter's, so they travel in the interpreter's own envelope and the program's value
   * rides untouched.
   */
  const { handler, calls } = watching(new SimHandler({}));
  const j = new Journal({ run: "c-3p" });
  let caught: unknown = "nothing was thrown";
  try {
    await run(
      'const a = await spawn("a", { name: "a" });\nawait conclave([a], async (ch) => { throw null; }, { name: "huddle" });',
      { runId: "c-3p", journal: j, handler },
    );
  } catch (e) {
    caught = e;
  }
  const scope = scopeOf(j, "conclave");
  ok("a body that throws a PRIMITIVE still closes the room exactly once",
    JSON.stringify(calls) === '["open","close"]', calls);
  ok("and the entry states the closure it actually achieved", scope?.closed === true, scope?.closed);
  ok("settled failed, not pending", scope?.state === "settled" && scope?.status === "failed",
    `${scope?.state}:${scope?.status ?? ""}`);
  ok("and the caller gets the body's own thrown value, not one the interpreter manufactured",
    caught === null, String(caught));

  // A body can also fail WITH `undefined` — not by naming it, which does not resolve, but by
  // throwing an absent field, which is ordinary code. "The body failed" must not be read off what
  // it failed with: comparing the caught value against `undefined` makes this program, which threw,
  // look like one that returned cleanly — a conclave settling `ok` with no value the author wrote.
  const j2 = new Journal({ run: "c-3u" });
  const w2 = watching(new SimHandler({}));
  let caught2: unknown = "nothing was thrown";
  let returned = false;
  try {
    await run(
      'const a = await spawn("a", { name: "a" });\nconst empty = {};\nawait conclave([a], async (ch) => { throw empty.missing; }, { name: "huddle" });',
      { runId: "c-3u", journal: j2, handler: w2.handler },
    );
    returned = true;
  } catch (e) {
    caught2 = e;
  }
  ok("a body that fails WITH undefined fails the conclave rather than settling ok",
    !returned && caught2 === undefined && scopeOf(j2, "conclave")?.status === "failed",
    `${returned ? "returned" : "threw"}:${scopeOf(j2, "conclave")?.status ?? ""}`);
  ok("and it closed on the way out", scopeOf(j2, "conclave")?.closed === true, scopeOf(j2, "conclave")?.closed);
}

{
  /**
   * THE CASE THE DISPOSITION EXISTS FOR: the close itself is refused.
   *
   * A first version folded the close into the body's try, so a close rejection was caught, RETRIED
   * once, and then settled as an ordinary `failed` scope — indistinguishable from "the body failed
   * and the room closed cleanly", which an orphan walk reads as closed while the members are still
   * joined. Now the scope does not settle at all: a pending entry IS "a close is still owed".
   */
  const sim = new SimHandler({});
  let closes = 0;
  const handler: EffectHandler = {
    now: () => sim.now(),
    spawn: (r, c) => sim.spawn(r, c),
    turn: (r, c) => sim.turn(r, c),
    ask: (r, c) => sim.ask(r, c),
    checkpoint: (r, c) => sim.checkpoint(r, c),
    sleep: (r, c) => sim.sleep(r, c),
    wait: (r, c) => sim.wait(r, c),
    notify: (r, c) => sim.notify(r, c),
    monitor: (r, c) => sim.monitor(r, c),
    openConclave: (r, c) => sim.openConclave(r, c),
    closeConclave: async () => {
      closes += 1;
      throw new Error("the room would not close");
    },
  };
  const j = new Journal({ run: "c-3b" });
  let caught: unknown;
  try {
    await run(
      'const a = await spawn("a", { name: "a" });\nawait conclave([a], async (ch) => 1, { name: "huddle" });',
      { runId: "c-3b", journal: j, handler },
    );
  } catch (e) {
    caught = e;
  }
  const scope = scopeOf(j, "conclave");
  ok("a refused close fails the run", caught !== undefined);
  ok("and is not retried behind the author's back", closes === 1, closes);
  ok("the scope does NOT settle: a pending entry is the durable 'a close is still owed'",
    scope?.state === "pending", `${scope?.state}:${scope?.status ?? ""}`);
  ok("and it never claims to have closed while the members are still joined", scope?.closed !== true,
    scope?.closed);
  ok("the caller sees the handler's own error, not a manufactured one",
    String((caught as Error)?.message).includes("would not close"), String(caught).slice(0, 80));
}

{
  // A CANCELLED body does NOT close itself. A cancelled branch performs no new effects, and
  // releasing a loser's branch-local resources travels the recovery path along with everything else
  // it took. The entry settles `cancelled`, which is the record recovery reads — and which the
  // migrate table treats as "did not close" and rejects.
  //
  // `fast` is gated on the conclave's body having DISPATCHED its first sleep, so the cancellation
  // arrives while the room is open and the body is mid-flight — after the boundary's begin-gap
  // re-check, a cancel that arrives before the open means the room is never opened at all, which
  // is its own cell. The loser is decided by the test, not by the event loop.
  const CANCELLED_SRC = `
const a = await spawn("a", { name: "a" });
await race({
  slow: async () => await conclave([a], async (ch) => {
    await sleep("1m", { name: "s1" });
    await sleep("1m", { name: "s2" });
    return 1;
  }, { name: "huddle" }),
  fast: async () => { await sleep("1m", { name: "f" }); return "fast"; },
}, { name: "r" });
`;
  let bodyEntered!: () => void;
  const bodyGate = new Promise<void>((r) => { bodyEntered = r; });
  let landS1!: () => void;
  const s1Gate = new Promise<void>((r) => { landS1 = r; });
  const { handler, calls } = watching(new SimHandler({}));
  const sleepThrough = handler.sleep.bind(handler);
  handler.sleep = async (r, c) => {
    const name = String((c as { key?: { name?: string } }).key?.name ?? "");
    if (name === "s1") {
      bodyEntered();
      await s1Gate;
      return null;
    }
    if (name === "f") {
      await bodyGate;
      setTimeout(landS1, 5);
      return null;
    }
    return await sleepThrough(r, c);
  };
  const j = new Journal({ run: "c-4" });
  await run(CANCELLED_SRC, { runId: "c-4", journal: j, handler });
  ok("the conclave really was opened, or this cell proves nothing about closing", calls.includes("open"));
  ok("a cancelled conclave does NOT close itself from inside the losing branch",
    !calls.includes("close"), calls);
  ok("and its entry records that it did not close", scopeOf(j, "conclave")?.status === "cancelled"
    && scopeOf(j, "conclave")?.closed === false,
    `${scopeOf(j, "conclave")?.status}:${String(scopeOf(j, "conclave")?.closed)}`);
}

// ---- 7) a race arm that FAILS is still a settle ------------------------------------------------

{
  /**
   * The signal a `race` waits on must not propagate a rejection. A `p.then(() => undefined)` does,
   * so the first arm to FAIL throws straight out of the await: past the cancellation of its
   * siblings, past `allSettled`, and into a scope entry recorded as failed with no losers on it.
   * The run then terminates while a sibling is still performing effects, and nothing durable says
   * the two disagree.
   *
   * `bad` fails in microtasks while `slow` is parked in the watched handler's macrotask sleep, so
   * which arm settles first is decided here rather than by the event loop. `slow` then has a SECOND
   * effect after the park, which is where a cancelled branch learns it lost.
   */
  const FAILING_RACE = `
const a = await spawn("a", { name: "a" });
await race({
  bad: async () => { await turn(a, { name: "boom" }); return 1; },
  slow: async () => { await sleep("1m", { name: "s1" }); await sleep("1m", { name: "s2" }); return 2; },
}, { name: "r" });
`;
  const { handler } = watching(
    new SimHandler({ faults: [{ at: "/race:r#0/b:bad/turn:boom#0", kind: "agent-down" }] }),
    true,
  );
  const j = new Journal({ run: "c-5" });
  let caught: unknown;
  try {
    await run(FAILING_RACE, { runId: "c-5", journal: j, handler });
  } catch (e) {
    caught = e;
  }
  // Give the losing branch every chance to keep going. Without the cancellation it is a detached
  // promise that resumes from its macrotask AFTER the run has already thrown, which is precisely
  // the "run is over, agent is still working" state — and asserting before it wakes would let that
  // state pass as clean.
  await new Promise<void>((r) => setTimeout(r, 5));

  ok("a rejecting arm fails the race", caught !== undefined);
  ok("the loser really was mid-flight when the race ended", j.entries().some((e) => e.name === "s1"),
    j.entries().map((e) => e.name));
  // FIRST, because it is the claim that matters: the run being over and the sibling still working
  // is the state the scope entry exists to make impossible.
  ok("and it performed NO effect after the race ended", !j.entries().some((e) => e.name === "s2"),
    j.entries().map((e) => `${e.name}:${e.state}`));
  const scope = scopeOf(j, "race");
  ok("the scope is journalled as failed", scope?.status === "failed", scope?.status);
  ok("carrying the sibling it cancelled, because a failing arm owes its losers exactly as a winning one does",
    JSON.stringify(scope?.cancel?.losers) === '["slow"]', scope?.cancel);
  ok("with the cancellation still undischarged", scope?.cancel?.issued === false);

  // And the winning-arm-failed path carries the same envelope: a primitive is a legal thing to
  // throw, and the losers a race owes are the interpreter's fact, not a field on the program's
  // value. `bad` throws in microtasks while `slow` parks in the watched macrotask sleep.
  const jp = new Journal({ run: "c-5p" });
  const wp = watching(new SimHandler({}), true);
  let caughtP: unknown = "nothing was thrown";
  try {
    await run('await race({ bad: async () => { throw null; }, slow: async () => { await sleep("1m", { name: "s1" }); return 2; } }, { name: "r" });',
      { runId: "c-5p", journal: jp, handler: wp.handler });
  } catch (e) {
    caughtP = e;
  }
  const sp = scopeOf(jp, "race");
  ok("an arm that throws a PRIMITIVE fails the race with its own value", caughtP === null, String(caughtP));
  ok("and the race still records the loser it cancelled", JSON.stringify(sp?.cancel?.losers) === '["slow"]', sp?.cancel);
}

{
  // The other half of the same rule. A branch that rejected with `Cancelled` is not a candidate to
  // win: that is not an outcome it reached, it is what losing did to it. Counting it would let a
  // loser cut short at an early step outrank the winner that ran longer — and on a re-entered scope
  // the recorded clocks make that a durable wrong answer rather than a transient one.
  const entries = raceJournal.entries().map((e): JournalEntry => {
    if (e.kind === "race") {
      return { v: 1, seq: e.seq, run: e.run, scope: e.scope, kind: e.kind, name: e.name, occurrence: e.occurrence, inputHash: e.inputHash, state: "pending", startedAt: e.startedAt };
    }
    if (e.kind === "sleep" && e.scope.endsWith("/b:fast")) {
      // `fast` was cancelled at 10ms — far earlier than either real arm finished.
      return { ...e, startedAt: 0, endedAt: 10, status: "cancelled", result: undefined };
    }
    if (e.kind === "sleep") return { ...e, startedAt: 0, endedAt: 300_000 };
    return e;
  });
  logged.length = 0;
  const jj = new Journal({ run: "r-1", entries });
  // Admitting the cancelled arm does not merely pick the wrong winner: the winner is a rejection,
  // so the whole scope re-settles as cancelled and the resume throws. Caught here so the failure
  // lands on this cell rather than killing the suite from outside any assertion.
  let winner: unknown;
  try {
    await resume(RACE, jj, { runId: "r-1", pins: racePins, handler: new SimHandler({}), onLog: sink });
    winner = logged.find((l) => l.length === 2)?.[0];
  } catch (e) {
    winner = `threw:${(e as Error).name}`;
  }
  ok("a branch recorded as cancelled does not win the race it lost", winner === "slow", winner);
}

// ---- 8) L2032's runtime half: the branch the validator could not prove -------------------------

/**
 * The static rule follows inline branches and named ones, and follows a branch into the helpers it
 * calls. What it cannot follow is a branch that does not exist until the program runs — a record of
 * thunks returned from a function, reached through a parameter, built by a call. Banning that shape
 * would cost more than the hazard, so the rule has a second half that runs where the write happens:
 * a binding declared OUTSIDE a concurrent branch cannot be written from inside one.
 *
 * The fixture below passes the validator — there is no function node at the combinator call to
 * check — and must still be refused.
 */
{
  const UNPROVEN = `
let winner = "none";
function branches() {
  return {
    a: async () => { await sleep("5m", { name: "a" }); winner = "a"; return 1; },
    b: async () => { await sleep("1m", { name: "b" }); winner = "b"; return 2; },
  };
}
await parallel(branches(), { name: "p" });
`;
  // The control FIRST: if this program did not parse, the cell below would prove nothing about the
  // runtime, only that the validator caught it.
  let staticError: unknown;
  try {
    validate(UNPROVEN);
  } catch (e) {
    staticError = e;
  }
  ok("the fixture really is one the validator cannot prove", staticError === undefined,
    String(staticError).slice(0, 120));

  let caught: unknown;
  try {
    await run(UNPROVEN, { runId: "c-6", handler: new SimHandler({}) });
  } catch (e) {
    caught = e;
  }
  ok("a write to a binding declared outside the branch is refused where it happens",
    (caught as { code?: string })?.code === "L2032", String(caught).slice(0, 100));
  ok("and the refusal names the binding", String((caught as Error)?.message).includes("winner"),
    String(caught).slice(0, 120));
}

{
  // The inverse control, and the one that decides whether the rule is usable. A branch writing what
  // it declared itself is ordinary code and must run.
  const OWN = `
function branches() {
  return { a: async () => { let n = 0; await sleep("1m", { name: "a" }); n = n + 1; return n; } };
}
const r = await parallel(branches(), { name: "p" });
log(r.a);
`;
  logged.length = 0;
  await run(OWN, { runId: "c-7", handler: new SimHandler({}), onLog: sink });
  ok("a branch writing its OWN binding still runs", logged[0]?.[0] === 1, logged);
}

{
  // `conclave` is a scope but not a race: one body, nothing beside it, so the depth does not move
  // and a write from inside it is as ordered as a write anywhere else.
  const IN_CONCLAVE = `
let notes = "";
const a = await spawn("a", { name: "a" });
await conclave([a], async (ch) => { notes = ch.channel; return 1; }, { name: "t" });
log(notes);
`;
  logged.length = 0;
  // Caught: a conclave that DID raise the depth refuses the write, and an uncaught throw would kill
  // the suite from outside every assertion rather than reddening this claim.
  let caught: unknown;
  try {
    await run(IN_CONCLAVE, { runId: "c-8", handler: new SimHandler({}), onLog: sink });
  } catch (e) {
    caught = e;
  }
  ok("a conclave body may write an outer binding at runtime too, not just past the validator",
    caught === undefined && typeof logged[0]?.[0] === "string" && (logged[0][0] as string).length > 0,
    caught === undefined ? logged : String(caught).slice(0, 80));
}

// ---- 9) `now()` after a scope is the same value live and on resume ----------------------------
//
// The scope's entry is stamped with the JOINED branch clock at settle, not the host's clock at
// append time. Live, the parent clock joins every branch that ran; replay advances the parent from
// the entry's stamp and enters no branch. The two must be the same number, or a program that
// branches on `now()` after a scope takes a path on resume that the live run never took. The
// handlers below make the two sources DISAGREE on purpose: the last effect to land is not the
// effect with the greatest recorded clock, so a stamp taken from the handler's clock at append
// time is wrong and the cell goes red.
{
  // parallel: `sa` records 9000 but lands first; `sb` records 4000 and lands LAST, so the
  // handler's clock at the scope's settle is 4000 while the joined branch clock is 9000.
  class LastLandsLow extends SimHandler {
    private stamp = 0;
    override now(): number { return this.stamp; }
    override async sleep(req: Parameters<SimHandler["sleep"]>[0], ctx: Parameters<SimHandler["sleep"]>[1]) {
      const name = String((ctx as { key?: { name?: string } }).key?.name ?? "");
      await new Promise((r) => setTimeout(r, name === "sb" ? 25 : 1));
      this.stamp = name === "sb" ? 4000 : 9000;
      return null;
    }
  }
  const PAR = `
await parallel({
  a: async () => { await sleep("1m", { name: "sa" }); return 1; },
  b: async () => { await sleep("1m", { name: "sb" }); return 2; },
}, { name: "both" });
log("t", now());
`;
  logged.length = 0;
  const r = await run(PAR, { runId: "r-9", handler: new LastLandsLow({}), onLog: sink, startedAt: 1000, seed: "r-9" });
  const scope = scopeOf(r.journal, "parallel");
  const liveT = logged.find((l) => l[0] === "t")?.[1];
  ok("live, now() after a parallel is the join of the branch clocks", liveT === 9000, logged);
  ok("and the scope entry is stamped with that joined clock, not the handler's clock at append time",
    scope?.endedAt === 9000, scope?.endedAt);
  logged.length = 0;
  await resume(PAR, new Journal({ run: "r-9", entries: r.journal.entries() }), {
    runId: "r-9",
    pins: { seed: "r-9", startedAt: 1000, yieldEvery: 1024, stepBudget: 1_000_000, effectCeiling: 10_000, languageVersion: "1" },
    handler: new SimHandler({}),
    onLog: sink,
  });
  ok("and a resume answers the same now() the live run saw", logged.find((l) => l[0] === "t")?.[1] === 9000, logged);
}

{
  // race: the LOSER lands first with the greater clock (300000), the winner lands last with the
  // lesser one (60000). Joined clock 300000; handler clock at append time 60000. A program that
  // branches on now() after the race must take the same path live and on resume.
  class LoserLandsFirst extends SimHandler {
    private stamp = 0;
    override now(): number { return this.stamp; }
    override async sleep(req: Parameters<SimHandler["sleep"]>[0], _ctx: Parameters<SimHandler["sleep"]>[1]) {
      const late = req.duration === "5m";
      await new Promise((r) => setTimeout(r, late ? 1 : 25));
      this.stamp = late ? 300000 : 60000;
      return null;
    }
  }
  const PICK = `
const r = await race({
  early: async () => { await sleep("1m", { name: "se" }); return "E"; },
  late: async () => { await sleep("5m", { name: "sl" }); return "L"; },
}, { name: "pick" });
log("win", r.index);
if (now() > 200000) { log("path", "late"); } else { log("path", "early"); }
`;
  logged.length = 0;
  const r = await run(PICK, { runId: "r-9b", handler: new LoserLandsFirst({}), onLog: sink, startedAt: 1000, seed: "r-9b" });
  const livePath = logged.find((l) => l[0] === "path")?.[1];
  ok("the winner is the least recorded clock even when the loser landed first",
    logged.some((l) => l[0] === "win" && l[1] === "early"), logged);
  ok("live, now() after the race saw the loser's landing (the scope awaited it)", livePath === "late", logged);
  logged.length = 0;
  await resume(PICK, new Journal({ run: "r-9b", entries: r.journal.entries() }), {
    runId: "r-9b",
    pins: { seed: "r-9b", startedAt: 1000, yieldEvery: 1024, stepBudget: 1_000_000, effectCeiling: 10_000, languageVersion: "1" },
    handler: new SimHandler({}),
    onLog: sink,
  });
  ok("and the resume takes the SAME path", logged.find((l) => l[0] === "path")?.[1] === livePath, logged);
}

// ---- 10) an in-flight effect that lands past the frontier re-decides the cut ------------------
//
// A cancelled arm may see an effect it already issued land; landing advances its clock, and an arm
// that lands PAST the settled frontier has proven it cannot win. Before the re-decision existed,
// the verdict from the settle (reached with the arm's OLD clock) stood, the loser's pure tail ran
// on, and an infinite tail burned the whole step budget: the live run died on L4013 while a resume
// of its journal returned the winner. The cell holds that the live run completes.
{
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  class InFlight extends SimHandler {
    private stamp = 0;
    override now(): number { return this.stamp; }
    override async sleep(req: Parameters<SimHandler["sleep"]>[0], ctx: Parameters<SimHandler["sleep"]>[1]) {
      const name = String((ctx as { key?: { name?: string } }).key?.name ?? "");
      if (name === "sb") { await gate; this.stamp = 15000; return null; }
      this.stamp = 10000;
      setTimeout(release, 5);
      return null;
    }
  }
  const INFLIGHT = `
const r = await race({
  a: async () => { await sleep("1s", { name: "sa" }); return "A"; },
  b: async () => { await sleep("1s", { name: "sb" }); let n = 0; while (true) { n = n + 1; } },
}, { name: "inflight" });
log("win", r.index, r.value);
`;
  logged.length = 0;
  // The failure mode this cell guards is run() REJECTING (the tail burns the step budget, L4013):
  // caught here so the regression reds on this cell's name instead of crashing the suite unnamed.
  let r: Awaited<ReturnType<typeof run>> | null = null;
  let died: unknown = null;
  try {
    r = await run(INFLIGHT, { runId: "r-10", handler: new InFlight({}), onLog: sink, startedAt: 1000, seed: "r-10", yieldEvery: 64, stepBudget: 25_000 });
  } catch (e) {
    died = e;
  }
  ok("the loser's infinite pure tail is abandoned once its in-flight effect lands past the frontier, and the run completes",
    died === null && logged.some((l) => l[0] === "win" && l[1] === "a" && l[2] === "A"),
    died === null ? logged : String(died));
  const scope = r === null ? undefined : scopeOf(r.journal, "race");
  ok("with the race settled ok and the in-flight landing recorded",
    r !== null && scope?.status === "ok" && r.journal.entries().some((e) => e.name === "sb" && e.status === "ok" && e.endedAt === 15000),
    r === null ? "no journal" : r.journal.entries().map((e) => `${e.name}:${e.status ?? e.state}`));
}

{
  // And the other half of the same rule: an arm whose in-flight effect lands BEFORE the frontier
  // can still win, so it is NOT cut — its pure tail runs to a settle and it takes the race. This
  // is the cell that guards against over-cutting every cancelled arm on any landing.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  class LandsEarly extends SimHandler {
    private stamp = 0;
    override now(): number { return this.stamp; }
    override async sleep(req: Parameters<SimHandler["sleep"]>[0], ctx: Parameters<SimHandler["sleep"]>[1]) {
      const name = String((ctx as { key?: { name?: string } }).key?.name ?? "");
      if (name === "sb") { await gate; this.stamp = 5000; return null; }
      this.stamp = 10000;
      setTimeout(release, 5);
      return null;
    }
  }
  const STILL = `
const r = await race({
  a: async () => { await sleep("1s", { name: "sa" }); return "A"; },
  b: async () => { await sleep("1s", { name: "sb" }); let n = 0; while (n < 400) { n = n + 1; } return "B"; },
}, { name: "still" });
log("win", r.index, r.value);
`;
  logged.length = 0;
  await run(STILL, { runId: "r-10b", handler: new LandsEarly({}), onLog: sink, startedAt: 1000, seed: "r-10b", yieldEvery: 64, stepBudget: 25_000 });
  ok("an arm whose in-flight effect lands BEFORE the frontier runs its pure tail and wins",
    logged.some((l) => l[0] === "win" && l[1] === "b" && l[2] === "B"), logged);
}

// ---- 11) a cancellation that arrives during `begin` still stops the dispatch -------------------
//
// `begin` is awaited so the request id is durable before the work is issued, and that await is a
// gap: a sibling can settle the race and cancel this branch while the append is in flight. The
// boundary re-checks on the far side of the append, so the handler is never asked for work the
// branch already lost — measured before the re-check: the loser's effect was dispatched anyway,
// performed against the world, and recorded `ok` under a scope that had already picked its winner.
{
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  class SlowAppend extends Journal {
    override async begin(...args: Parameters<Journal["begin"]>): ReturnType<Journal["begin"]> {
      const entry = await super.begin(...args);
      if (args[0].name === "sb") await gate;
      return entry;
    }
  }
  const asked: string[] = [];
  class Asked extends SimHandler {
    private stamp = 0;
    override now(): number { return this.stamp; }
    override async sleep(req: Parameters<SimHandler["sleep"]>[0], ctx: Parameters<SimHandler["sleep"]>[1]) {
      asked.push(String((ctx as { key?: { name?: string } }).key?.name ?? ""));
      this.stamp = 10000;
      setTimeout(release, 5);
      return null;
    }
  }
  const GAP = `
const r = await race({
  a: async () => { await sleep("1s", { name: "sa" }); return "A"; },
  b: async () => { await sleep("1s", { name: "sb" }); return "B"; },
}, { name: "gap" });
log("win", r.index, r.value);
`;
  logged.length = 0;
  const journal = new SlowAppend({ run: "r-11" });
  await run(GAP, { runId: "r-11", journal, handler: new Asked({}), onLog: sink, startedAt: 1000, seed: "r-11" });
  ok("the handler is never asked for the effect a cancellation overtook inside `begin`",
    !asked.includes("sb") && asked.includes("sa"), asked);
  ok("and the pending entry settles as what the branch now is: cancelled, not ok",
    journal.entries().some((e) => e.name === "sb" && e.state === "settled" && e.status === "cancelled"),
    journal.entries().map((e) => `${e.name}:${e.status ?? e.state}`));
  ok("and the race records the winner that overtook it",
    logged.some((l) => l[0] === "win" && l[1] === "a"), logged);
}

console.log(`scopes.smoke: ${pass} checks passed`);
