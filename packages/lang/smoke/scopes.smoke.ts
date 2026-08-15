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

console.log(`scopes.smoke: ${pass} checks passed`);
