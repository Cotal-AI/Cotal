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

const RACE = `
const r = await race({
  fast: async () => { await sleep("1m"); return "from-fast"; },
  slow: async () => { await sleep("5m"); return "from-slow"; },
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
  ok("it records the branches it launched", JSON.stringify((scope?.result as { branches: string[] }).branches) === '["fast","slow"]');

  const value = (scope?.result as { value: { index: string; value: unknown } }).value;
  ok("the winner is the earliest arm", value.index === "fast", value);
  ok(
    "and BOTH the index and the value are recorded, so an edit to the arm's expression cannot resume as the new value",
    value.value === "from-fast",
    value,
  );
  ok("the program saw the same winner", logged[0]?.[0] === "fast" && logged[0]?.[1] === "from-fast");

  ok("the losers are recorded WITH the outcome, as intent", JSON.stringify(scope?.cancel?.losers) === '["slow"]');
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
  ok("a settled race replays without entering a branch", logged[0]?.[0] === "fast", logged[0]);
  ok("and returns the recorded value, not a re-derived one", logged[0]?.[1] === "from-fast");
  ok("its subtree is accounted for rather than left as removed steps", j.orphans().length === 0, j.orphans().map((o) => o.kind));
}

{
  // The crash case the scope entry exists for: BOTH arms settled before the cancellation reached
  // the loser, and the scope itself never settled. Re-entering re-runs both branches from their
  // recorded results, so scheduling decides which promise resumes first — and the winner must NOT
  // be that. It must be the earliest recorded branch, every time.
  const entries = raceJournal.entries().map((e): JournalEntry =>
    e.kind === "race" ? { v: 1, seq: e.seq, run: e.run, scope: e.scope, kind: e.kind, name: e.name, occurrence: e.occurrence, inputHash: e.inputHash, state: "pending", startedAt: e.startedAt } : e,
  );
  ok("the fixture really does have a pending scope over two settled arms",
    entries.filter((e) => e.state === "pending").length === 1
    && entries.filter((e) => e.kind === "sleep" && e.status === "ok").length === 2);

  const winners: unknown[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    logged.length = 0;
    const jj = new Journal({ run: "r-1", entries });
    await resume(RACE, jj, { runId: "r-1", handler: new SimHandler({}), onLog: sink });
    winners.push(logged[0]?.[0]);
  }
  ok("a re-entered race resolves the SAME arm every time", new Set(winners).size === 1, winners);
  ok("and it is the earliest arm, not whichever promise the event loop woke first", winners[0] === "fast", winners);
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

console.log(`scopes.smoke: ${pass} checks passed`);
