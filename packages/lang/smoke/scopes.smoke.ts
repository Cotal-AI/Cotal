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
{
  logged.length = 0;
  const r = await run(RACE, { runId: "r-1", handler: new SimHandler({}), onLog: sink });
  raceJournal = r.journal;

  const scope = scopeOf(r.journal, "race");
  ok("a race appends a scope entry of its own kind", scope !== undefined && scope.kind === "race");
  ok("keyed by its name and occurrence", scope?.name === "first-answer" && scope?.occurrence === 0);
  ok("it records the branches it launched", JSON.stringify((scope?.result as { branches: string[] }).branches) === '["slow","fast"]');

  const value = (scope?.result as { value: { index: string; value: unknown } }).value;
  // On the LIVE pass the simulator advances ONE virtual clock serially, so the arm that runs first
  // is the arm that records the earlier endedAt whatever duration it asked for. That is a property
  // of the simulator, not of the rule, and it is fine: the live pass is where the choice is MADE
  // and RECORDED. What must never vary is what a replay does with the record, which is section 4.
  ok("the live pass records a winner", value.index === "slow", value);
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

// ---- 4) THE ONE THAT MATTERS: a replayed race cannot re-decide -------------------------------

{
  // A settled race, replayed against an EMPTY simulation script. The simulator refuses every
  // unscripted effect with L6001, so if replay re-entered a branch it would die rather than
  // quietly resolve. Completing is the proof that no branch was entered.
  logged.length = 0;
  const j = new Journal({ run: "r-1", entries: raceJournal.entries() });
  await resume(RACE, j, { runId: "r-1", handler: new SimHandler({}), onLog: sink });
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
    await resume(RACE, jj, { runId: "r-1", handler: new SimHandler({}), onLog: sink });
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

// ---- 6) conclave: a scope that is also an effect ---------------------------------------------

/**
 * A conclave gets ONE journal entry, of kind `conclave`, and that entry's state is the durable
 * answer to "is this sub-team still live". Settled means the members left; pending or cancelled
 * means a close is still owed, which is exactly what the migrate table reads when it rejects an
 * orphaned conclave "unless the scope closed".
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
{
  logged.length = 0;
  const { handler, calls } = watching(new SimHandler({}));
  const r = await run(CONCLAVE, { runId: "c-1", handler, onLog: sink });
  conclaveJournal = r.journal;

  ok("a conclave opens and closes around its body", JSON.stringify(calls) === '["open","close"]', calls);
  ok("the body ran between them", logged.some((l) => l[0] === "inside"));
  ok("and the channel option reached the handler, so the body got the room it asked for",
    logged.find((l) => l[0] === "out")?.[1] === "war-room", logged);

  const scope = scopeOf(r.journal, "conclave");
  ok("it is journalled as ONE entry of its own kind, not as an open and a close", scope !== undefined
    && r.journal.entries().filter((e) => e.kind === "conclave").length === 1);
  ok("settled, which is the durable answer to 'did this sub-team close'", scope?.status === "ok");
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
  await resume(CONCLAVE, j, { runId: "c-1", handler, onLog: sink });
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
    await resume(AFTER, new Journal({ run: "c-2", entries: r.journal.entries() }), { runId: "c-2", handler });
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
}

{
  // A CANCELLED body does NOT close itself. A cancelled branch performs no new effects, and
  // releasing a loser's branch-local resources travels the recovery path along with everything else
  // it took. The entry settles `cancelled`, which is the record recovery reads — and which the
  // migrate table treats as "did not close" and rejects.
  //
  // `fast` awaits nothing and so settles in the first microtask, while `slow` is parked in the
  // watched handler's macrotask sleep. The loser is decided by the test, not by the event loop.
  const CANCELLED_SRC = `
const a = await spawn("a", { name: "a" });
await race({
  slow: async () => await conclave([a], async (ch) => {
    await sleep("1m", { name: "s1" });
    await sleep("1m", { name: "s2" });
    return 1;
  }, { name: "huddle" }),
  fast: async () => "fast",
}, { name: "r" });
`;
  const { handler, calls } = watching(new SimHandler({}), true);
  const j = new Journal({ run: "c-4" });
  await run(CANCELLED_SRC, { runId: "c-4", journal: j, handler });
  ok("the conclave really was opened, or this cell proves nothing about closing", calls.includes("open"));
  ok("a cancelled conclave does NOT close itself from inside the losing branch",
    !calls.includes("close"), calls);
  ok("and its entry records that it did not close", scopeOf(j, "conclave")?.status === "cancelled",
    scopeOf(j, "conclave")?.status);
}

// ---- 7) a race arm that FAILS is still a settle ------------------------------------------------

{
  /**
   * The signal a `race` waits on used to be `p.then(() => undefined)`, which propagates a rejection.
   * So the first arm to FAIL threw straight out of the await — past the cancellation of its
   * siblings, past `allSettled`, and into a scope entry recorded as failed with no losers on it.
   * The run terminated while a sibling was still performing effects: the run says it is over, an
   * agent keeps working, and nothing durable says the two disagree.
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
    await resume(RACE, jj, { runId: "r-1", handler: new SimHandler({}), onLog: sink });
    winner = logged.find((l) => l.length === 2)?.[0];
  } catch (e) {
    winner = `threw:${(e as Error).name}`;
  }
  ok("a branch recorded as cancelled does not win the race it lost", winner === "slow", winner);
}

console.log(`scopes.smoke: ${pass} checks passed`);
