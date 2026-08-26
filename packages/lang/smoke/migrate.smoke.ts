/**
 * The migration walk: why a settled scope is entered rather than consumed.
 *
 * A resume delivers a settled `race` from its own entry and marks the whole subtree accounted for
 * WITHOUT entering a branch. That is correct for a resume — the program hash is unchanged, so
 * nothing beneath the scope can have been removed, and the branches were decided rather than
 * deleted. Run EDITED source over the same journal and the identical short-circuit becomes a
 * defect: every entry beneath the scope is accounted for, so an effect the new source no longer
 * reaches never appears in `orphans()`, and a resolved human checkpoint inside the WINNING branch
 * disappears with L5004 never firing.
 *
 * The whole suite is one A/B on ONE journal: the same edited source walked with `migration: false`
 * and with `migration: true`. Anything that only asserted the migration side would pass against an
 * implementation that consumed nothing anywhere, which is a different system.
 *
 * Run: pnpm smoke:lang-migrate
 */
import { run, RuntimeFault, ScopeBranchMissing, UnwalkableScope } from "../src/interpret.js";
import { SimHandler } from "../src/sim.js";
import { Journal, type JournalEntry } from "../src/journal.js";
import { WALKER_LANGUAGE_VERSION } from "../src/pins.js";
import { stepKeyString } from "../src/keys.js";
import type { EffectContext } from "../src/effects.js";
import { journalEntryKeyString } from "../src/journal.js";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; return; }
  fail++;
  console.log("  ✗ FAIL:", name, extra === undefined ? "" : JSON.stringify(extra));
};

/** A handler that performs NOTHING. Reaching it means the walk hit the frontier — new work. */
class ReachedFrontier extends Error {
  constructor(readonly step: string) {
    super(`the walk reached new work at ${step}`);
    this.name = "ReachedFrontier";
  }
}
const checkHandler = (now: number) => {
  const stop = (ctx: { key: unknown }) => {
    throw new ReachedFrontier(JSON.stringify(ctx.key));
  };
  return {
    now: () => now,
    spawn: stop, turn: stop, ask: stop, checkpoint: stop, sleep: stop,
    wait: stop, notify: stop, monitor: stop, openConclave: stop, closeConclave: stop,
  } as never;
};

const EFFECTS = ["spawn", "turn", "ask", "checkpoint", "sleep", "wait", "notify", "monitor", "openConclave", "closeConclave"] as const;

/**
 * A sim handler that also RECORDS which steps it was asked to perform.
 *
 * The throwing handler above answers "did the walk reach new work?" only where the throw survives
 * the way out. Inside a `race` it does not — the winner tie-break drops a losing arm's rejection —
 * so a question about work performed has to be asked at the point the work is requested.
 */
const tapped = (): [never, string[]] => {
  const asked: string[] = [];
  const sim = new SimHandler({} as never) as unknown as Record<string, (r: unknown, c: EffectContext) => Promise<unknown>>;
  const h: Record<string, unknown> = { now: () => (sim as unknown as { now: () => number }).now() };
  for (const m of EFFECTS) {
    h[m] = async (r: unknown, c: EffectContext) => {
      asked.push(stepKeyString(c.key));
      return await sim[m]!(r, c);
    };
  }
  return [h as never, asked];
};

const keys = (entries: readonly JournalEntry[]) => entries.map((e) => journalEntryKeyString(e));

// A `parallel` rather than a `race` for the main scenario, deliberately: every branch is a winner,
// so the scenario is about the SHORT-CIRCUIT and not about which branch the tie-break picked. The
// race — where some branches are losers — is section 2's subject, and it reads the winner out of
// the recorded entry rather than assuming one.
const LIVE = `
await parallel({
  a: async () => {
    const approval = await checkpoint("approve", "ship it?", { timeout: "10m" });
    await sleep("1s", { name: "after-approve" });
  },
  b: async () => {
    await sleep("2s", { name: "other-work" });
  },
}, { name: "gate" });
await sleep("3s", { name: "tail" });
`;

// The SAME program with the checkpoint removed from branch `a`. Nothing else changes.
const EDITED = `
await parallel({
  a: async () => {
    await sleep("1s", { name: "after-approve" });
  },
  b: async () => {
    await sleep("2s", { name: "other-work" });
  },
}, { name: "gate" });
await sleep("3s", { name: "tail" });
`;

const SCRIPT = { checkpoints: { approve: { status: "resolved" as const, value: "yes", by: "david", at: 0 } } };

// ---- the recorded run -------------------------------------------------------------------------
const recorded = new Journal({ run: "r-live" });
const live = await run(LIVE, { runId: "r-live", handler: new SimHandler(SCRIPT as never), journal: recorded })
  .then((r) => r, (e: unknown) => e as Error);
ok("the recorded run completed", !(live instanceof Error), (live as Error)?.message?.slice(0, 120));
// Every walk below is over a COPY of this journal, and a walk is a resume: it carries the pins the
// recorded run was pinned to, because re-resolving them would put the walk on this host's clock and
// on a re-seeded PRNG — a different run reading the same history.
const livePins = (live as { pins: import("../src/index.js").RunPins }).pins;
const recordedKeys = keys(recorded.entries());
ok("its journal holds the checkpoint, inside branch `a`",
  recordedKeys.some((k) => k.includes("/b:a/checkpoint:approve")), recordedKeys);
ok("and the other branch's work", recordedKeys.some((k) => k.includes("/b:b/")), recordedKeys);

/** Walk the edited source over a COPY of the recorded journal, one mode or the other. */
const walk = async (migration: boolean) => {
  const j = new Journal({ run: "r-live", entries: recorded.entries(), readOnly: true });
  const outcome = await run(EDITED, {
    runId: "r-live",
    handler: checkHandler(recorded.entries().length === 0 ? 0 : 10_000_000),
    journal: j, pins: livePins,
    migration,
  }).then(() => null, (e: unknown) => e as Error);
  return { outcome, orphans: keys(j.orphans()) };
};

// ---- 1) the defect, and the fix, on one journal ------------------------------------------------
{
  const resumeMode = await walk(false);
  const migrateMode = await walk(true);

  ok("consuming the subtree HIDES the removed checkpoint: it is not an orphan",
    !resumeMode.orphans.some((k) => k.includes("checkpoint:approve")), resumeMode.orphans);
  ok("walking the winning branch REPORTS it",
    migrateMode.orphans.some((k) => k.includes("checkpoint:approve")), migrateMode.orphans);
  ok("and that is the only difference in what the two walks account for",
    migrateMode.orphans.length === resumeMode.orphans.length + 1,
    JSON.stringify({ resume: resumeMode.orphans, migrate: migrateMode.orphans }));
}

// ---- 2) a loser was DECIDED, not removed --------------------------------------------------------
{
  const { orphans } = await walk(true);
  ok("the surviving steps in both branches are not orphans",
    !orphans.some((k) => k.includes("after-approve") || k.includes("other-work")), orphans);
  ok("nor is the step after the scope, which the walk reaches through the recorded outcome",
    !orphans.some((k) => k.includes("sleep:tail")), orphans);

  // A RACE, where some branches really are losers: they were decided, not deleted, so the walk
  // accounts for them exactly as a resume does. The recorded loser is read out of the entry — the
  // sim's shared virtual clock decides who completes first, and a suite that assumed the answer
  // would be asserting its own guess.
  const RACE = `
await race({
  x: async () => { await sleep("1s", { name: "x-work" }); return "x"; },
  y: async () => { await sleep("2s", { name: "y-work" }); return "y"; },
}, { name: "pick" });
await sleep("1s", { name: "after-race" });
`;
  const rj = new Journal({ run: "r-race" });
  const racePins = (await run(RACE, { runId: "r-race", handler: new SimHandler({}), journal: rj })).pins;
  const scope = rj.entries().find((e) => e.kind === "race");
  const losers = (scope as { cancel?: { losers: readonly string[] } })?.cancel?.losers ?? [];
  ok("the race recorded at least one loser", losers.length > 0, JSON.stringify(scope?.result));

  const rj2 = new Journal({ run: "r-race", entries: rj.entries(), readOnly: true });
  const outcome = await run(RACE, {
    runId: "r-race", handler: checkHandler(10_000_000), journal: rj2, pins: racePins, migration: true,
  }).then(() => null, (e: unknown) => e as Error);
  ok("the migration walk completes over an unedited race", outcome === null, outcome?.message?.slice(0, 120));
  const raceOrphans = keys(rj2.orphans());
  ok("and the LOSER's own entries are not orphans: the race decided them",
    !raceOrphans.some((k) => losers.some((b) => k.includes(`/b:${b}/`))), JSON.stringify({ losers, raceOrphans }));
  ok("nothing at all is orphaned when the source did not change", raceOrphans.length === 0, raceOrphans);

  // An edit INSIDE the loser is caught by the entry's `branchDigest` and by nothing else. Read the
  // note below before treating this pair as the proof of either half.
  const DURATION: Record<string, string> = { x: "1s", y: "2s" };
  const loser = losers[0] as string;
  const EDITED_LOSER = RACE.replace(
    `sleep("${DURATION[loser]}", { name: "${loser}-work" })`,
    `sleep("7s", { name: "${loser}-work" })`,
  );
  ok("the edit landed on the losing branch", EDITED_LOSER !== RACE, JSON.stringify({ loser }));

  const rj3 = new Journal({ run: "r-race", entries: rj.entries(), readOnly: true });
  const overLoser = await run(EDITED_LOSER, {
    runId: "r-race", handler: checkHandler(10_000_000), journal: rj3, pins: racePins, migration: true,
  }).then(() => null, (e: unknown) => e as Error);
  ok("REPAIRED: an edit inside a branch the race decided now refuses the migration",
    overLoser?.name === "RunDivergence", `${overLoser?.name}: ${overLoser?.message?.slice(0, 140)}`);
  // AT THE SCOPE, and the step it names is the load-bearing half. The walk never enters a decided
  // loser, so a divergence reported from inside one would be a step nothing reached; the digest is
  // bound into the scope entry and compared at the scope's own lookup, before a branch runs.
  ok("at the scope that bound the arms, not at a step inside an arm nothing walked",
    overLoser?.message?.includes("/race:pick#0") === true, overLoser?.message?.slice(0, 140));
  // THE MECHANISM, asserted rather than inferred from the refusal: a refusal can come from
  // anywhere, and this suite has just claimed which thing produced it.
  ok("because the recorded scope entry carries a `branchDigest` over the arms the walk skips",
    typeof (scope as { branchDigest?: string })?.branchDigest === "string" &&
      (scope as { branchDigest?: string }).branchDigest?.startsWith("sha256:") === true,
    (scope as { branchDigest?: string })?.branchDigest);

  // THE NARROWNESS. A digest that refused everything would satisfy the three cells above perfectly
  // and make a decided race un-migratable and un-forkable. It is taken over the arm's STRUCTURE
  // with source offsets stripped, so reindenting an arm is not editing it — a check that fired on
  // whitespace is the false positive that teaches people to route around the check.
  const REINDENTED = RACE.replace(
    `  ${loser}: async () => { await sleep("${DURATION[loser]}", { name: "${loser}-work" }); return "${loser}"; },`,
    `  ${loser}: async () => {\n    await sleep("${DURATION[loser]}", { name: "${loser}-work" });\n    return "${loser}";\n  },`,
  );
  ok("the reindent landed", REINDENTED !== RACE, { loser });
  const rjReindent = new Journal({ run: "r-race", entries: rj.entries(), readOnly: true });
  const overReindent = await run(REINDENTED, {
    runId: "r-race", handler: checkHandler(10_000_000), journal: rjReindent, pins: racePins, migration: true,
  }).then(() => null, (e: unknown) => e as Error);
  ok("a REINDENTED losing arm is not an edited one: same structure, same digest, walk completes",
    overReindent === null, `${overReindent?.name}: ${overReindent?.message?.slice(0, 120)}`);

  // AND IT COVERS THE LOSERS ONLY, which is the second half of the narrowness and the reason the
  // winner's arm reads better than it would under a digest over every branch. The walk enters the
  // winner entry by entry, so an edit there already diverges AT THE STEP IT BROKE — a strictly more
  // useful error than "some arm of this race changed". A digest that bound the winner too would
  // replace that step with the scope key and lose the location.
  const winner = (scope?.result as { value?: { index?: string } } | undefined)?.value?.index as string;
  const EDITED_WINNER = RACE.replace(
    `sleep("${DURATION[winner]}", { name: "${winner}-work" })`,
    `sleep("11s", { name: "${winner}-work" })`,
  );
  ok("the edit landed on the winning branch", EDITED_WINNER !== RACE, { winner });
  const rjWinner = new Journal({ run: "r-race", entries: rj.entries(), readOnly: true });
  const overWinner = await run(EDITED_WINNER, {
    runId: "r-race", handler: checkHandler(10_000_000), journal: rjWinner, pins: racePins, migration: true,
  }).then(() => null, (e: unknown) => e as Error);
  ok("an edit in the WINNING arm diverges at the STEP it broke, not at the scope",
    overWinner?.name === "RunDivergence" &&
      overWinner.message.includes(`/race:pick#0/b:${winner}/sleep:${winner}-work#0`),
    overWinner?.message?.slice(0, 160));

  // AND ON THE RESUME PATH TOO, which is wider than the specified placement — the comparison in the
  // migrate walk only — but is the same guard on the same field, and a resume is where the edit is
  // most silent: the run record carries no program hash, so nothing upstream refused the edited
  // source before it got here, and a settled race is delivered from its entry without entering an
  // arm. One string comparison, and it never fires on source that did not change.
  const rjResume = new Journal({ run: "r-race", entries: rj.entries(), readOnly: true });
  const resumed = await run(EDITED_LOSER, {
    runId: "r-race", handler: checkHandler(10_000_000), journal: rjResume, pins: racePins, migration: false,
  }).then(() => null, (e: unknown) => e as Error);
  ok("a RESUME of the same edited source diverges as well, rather than replaying past it",
    resumed?.name === "RunDivergence", `${resumed?.name}: ${resumed?.message?.slice(0, 140)}`);

  // WHY THAT PAIR WAS NOT THE PROOF, AND WHAT IS. Kept, because the mutation it defends against is
  // still live: the digest closed the EDIT case, and this note is about the WALK case.
  //
  // Both cells above also pass against a build that walks the losers too, so the mutation that
  // removes the branch filter survives them. Not because the divergence does not happen — the loser
  // really does raise `RunDivergence` — but because the race's winner tie-break DISCARDS it: on a
  // full replay every branch clock reads the same instant, so declaration order picks the winner
  // and a losing arm's rejection is dropped on the floor. An edit inside a loser is therefore
  // invisible for TWO independent reasons, and a cell that cannot tell them apart is asserting the
  // one it did not mean. The digest fires at the scope's own lookup, upstream of both.
  //
  // So the proof is about WORK, not about the answer: the harm in walking a decided branch is that
  // the branch's steps get performed, and nothing downstream unperforms them. Give the loser a step
  // the recorded run never had and watch what the handler is ASKED for. Skipping the branch asks for
  // nothing; entering it asks for real work inside an arm the race already settled — and no
  // tie-break can swallow a request that was already made.
  const [recorder, asked] = tapped();

  const EXTRA = RACE.replace(
    `await sleep("${DURATION[loser]}", { name: "${loser}-work" }); return "${loser}";`,
    `await sleep("${DURATION[loser]}", { name: "${loser}-work" }); await sleep("1s", { name: "${loser}-extra" }); return "${loser}";`,
  );
  ok("the extra step landed inside the losing branch", EXTRA !== RACE, JSON.stringify({ loser }));

  // WRITABLE, deliberately: on a read-only journal the frontier is refused by the journal before the
  // handler is ever called, so the cell would be proving the journal's refusal and not the walk's
  // branch selection.
  const rj4 = new Journal({ run: "r-race", entries: rj.entries() });
  await run(EXTRA, { runId: "r-race", handler: recorder, journal: rj4, pins: racePins, migration: true })
    .then(() => null, (e: unknown) => e as Error);
  ok("a migration performs NO new work inside a branch the race decided",
    !asked.some((k) => k.includes(`/b:${loser}/`)), JSON.stringify(asked));

  // …and the recorder can see work at all, or the cell above passes because nothing was watching.
  const [watcher, seen] = tapped();
  const rj5 = new Journal({ run: "r-race", entries: rj.entries() });
  await run(`${RACE}\nawait sleep("5s", { name: "brand-new" });`, {
    runId: "r-race", handler: watcher, journal: rj5, pins: racePins, migration: true,
  }).then(() => null, (e: unknown) => e as Error);
  ok("the same instrument DOES record a step the recorded run never had",
    seen.some((k) => k.includes("brand-new")), JSON.stringify(seen));
}

// ---- 2b) a fanOut walks the branches the RECORDED run had, not the ones the edit added ----------
{
  // A fanOut has no losers, so the walk's branch set is the recorded one — and the edit can change
  // it in both directions. A branch the new source DROPPED must orphan its steps, which is the same
  // reporting rule as section 1. A branch the new source ADDED is not the check's subject: the walk
  // exists to say what the edit removed and what no longer hashes, and performing brand-new work
  // inside it would make a check that reads the journal into a run that writes to the world.
  const ITEMS = (list: string) =>
    `await fanOut([${list}], async (lens) => { await sleep("1m", { name: lens }); return lens; }, { name: "reviews", key: (lens) => lens });`;

  const fj = new Journal({ run: "r-fan" });
  const fanPins = (await run(ITEMS(`"a", "b"`), { runId: "r-fan", handler: new SimHandler({}), journal: fj })).pins;
  ok("the recorded fanOut has both branches",
    keys(fj.entries()).filter((k) => k.includes("/b:")).length === 2, keys(fj.entries()));

  const [handler, asked] = tapped();
  const fj2 = new Journal({ run: "r-fan", entries: fj.entries() });
  const added = await run(ITEMS(`"a", "b", "c"`), {
    runId: "r-fan", handler, journal: fj2, pins: fanPins, migration: true,
  }).then(() => null, (e: unknown) => e as Error);
  ok("a migration completes over a fanOut the edit widened", added === null, `${added?.name}: ${added?.message?.slice(0, 140)}`);
  ok("and performs no work in the branch the edit added",
    !asked.some((k) => k.includes("/b:c/")), JSON.stringify(asked));

  const fj3 = new Journal({ run: "r-fan", entries: fj.entries(), readOnly: true });
  const dropped = await run(ITEMS(`"a"`), {
    runId: "r-fan", handler: checkHandler(10_000_000), journal: fj3, pins: fanPins, migration: true,
  }).then(() => null, (e: unknown) => e as Error);
  ok("a migration completes over a fanOut the edit narrowed", dropped === null, `${dropped?.name}: ${dropped?.message?.slice(0, 140)}`);
  // BOTH HALVES, because "b orphaned" alone is also what a walk that entered NOTHING would report,
  // and those are different systems wearing one green: the casualty list has to name who survived.
  ok("and the dropped branch's step is an orphan, which is the whole point of walking",
    keys(fj3.orphans()).some((k) => k.includes("/b:b/")), keys(fj3.orphans()));
  ok("while the branch the edit KEPT was entered, so its step is not",
    !keys(fj3.orphans()).some((k) => k.includes("/b:a/")), keys(fj3.orphans()));
}

// ---- 3) a divergence INSIDE the winning branch is seen, because the branch is entered -----------
{
  const DIVERGED = EDITED.replace('await sleep("1s", { name: "after-approve" })', 'await sleep("9s", { name: "after-approve" })');
  const j = new Journal({ run: "r-live", entries: recorded.entries(), readOnly: true });
  const outcome = await run(DIVERGED, {
    runId: "r-live", handler: checkHandler(10_000_000), journal: j, pins: livePins, migration: true,
  }).then(() => null, (e: unknown) => e as Error);
  ok("an edited input inside the winning branch diverges", outcome?.name === "RunDivergence", outcome?.name);
  ok("and it names the step, in branch coordinates",
    outcome?.message.includes("/b:a/sleep:after-approve#0") === true, outcome?.message?.slice(0, 200));

  const resumeWalk = new Journal({ run: "r-live", entries: recorded.entries(), readOnly: true });
  const hidden = await run(DIVERGED, {
    runId: "r-live", handler: checkHandler(10_000_000), journal: resumeWalk, pins: livePins, migration: false,
  }).then(() => null, (e: unknown) => e as Error);
  ok("a resume-shaped walk never sees it, because it never enters the branch", hidden === null, hidden?.name);
}

// ---- 4) a scope the walk cannot enter is a REFUSAL, not a silent consume ------------------------
{
  const CONCLAVE = `
const team = await conclave([], async (room) => {
  await sleep("1s", { name: "inside" });
  return "done";
}, { name: "huddle" });
`;
  const j = new Journal({ run: "r-conclave" });
  const first = await run(CONCLAVE, { runId: "r-conclave", handler: new SimHandler({}), journal: j })
    .then((r) => r, (e: unknown) => e as Error);
  ok("a conclave run records", !(first instanceof Error), (first as Error)?.message?.slice(0, 120));
  const conclavePins = (first as { pins: import("../src/index.js").RunPins }).pins;

  const j2 = new Journal({ run: "r-conclave", entries: j.entries(), readOnly: true });
  const refused = await run(CONCLAVE, {
    runId: "r-conclave", handler: checkHandler(10_000_000), journal: j2, pins: conclavePins, migration: true,
  }).then(() => null, (e: unknown) => e as Error);
  ok("a migration REFUSES to walk it rather than consuming what it cannot check",
    refused instanceof UnwalkableScope, refused?.name);
  ok("and says why: the handle is handler-derived and was never journalled",
    refused?.message.includes("never journalled") === true, refused?.message?.slice(0, 120));

  const j3 = new Journal({ run: "r-conclave", entries: j.entries(), readOnly: true });
  const resumed = await run(CONCLAVE, {
    runId: "r-conclave", handler: checkHandler(10_000_000), journal: j3, pins: conclavePins, migration: false,
  }).then(() => null, (e: unknown) => e as Error);
  ok("a RESUME still short-circuits it, which is correct: nothing under it can have been removed",
    resumed === null, resumed?.name);
}

// ---- 5) THE WALK CANNOT ENTER AN ARM THE EDIT RENAMED AWAY, AND MUST SAY SO RATHER THAN HANG ----
//
// Found by a review seat walking the complement of the "losers only" digest rule. That rule is
// deliberate: the walk ENTERS the winner, so an edit there diverges at the step it broke, which is
// a better error than "some arm of this race changed". A RENAME removes the arm, so there is no
// step left to diverge at — and the failure was not a silent pass. The walk filtered the source's
// arms down to the recorded winner, got NOTHING, and awaited `Promise.race([])`, which never
// settles. Measured before the guard: a migration over a renamed winning arm ran to a 2s cap and
// returned no verdict at all, while an ordinary resume of the same source returned OK.
//
// Every cell here is wrapped in its own deadline. A guard against a HANG that is asserted by a bare
// `await` fails by hanging the suite, which grades as a timeout rather than as a red — and a
// mutation that removes the guard would then be scored on the harness's patience.
{
  const deadline = async (label: string, p: Promise<unknown>, ms = 2_000) => {
    let t: ReturnType<typeof setTimeout>;
    const timer = new Promise<"HUNG">((res) => { t = setTimeout(() => res("HUNG"), ms); });
    const outcome = await Promise.race([p.then(() => null, (e: unknown) => e as Error), timer]);
    clearTimeout(t!);
    return outcome === "HUNG" ? new Error(`HUNG: ${label} did not return within ${ms}ms`) : outcome;
  };

  const RACE5 = `
await race({
  x: async () => { await sleep("1s", { name: "x-work" }); return "x"; },
  y: async () => { await sleep("2s", { name: "y-work" }); return "y"; },
}, { name: "pick" });
`;
  const j = new Journal({ run: "r-rename" });
  const pins = (await run(RACE5, { runId: "r-rename", handler: new SimHandler({}), journal: j })).pins;
  const scope = j.entries().find((e) => e.kind === "race") as
    { result?: { value?: { index?: string } }; cancel?: { losers?: readonly string[] } } | undefined;
  // Read out, never guessed: the sim's shared virtual clock decides who wins, and a suite that
  // assumed the answer would be asserting its own guess.
  const won = scope?.result?.value?.index as string;
  const lost = (scope?.cancel?.losers ?? [])[0] as string;
  ok("the race recorded a winner and a loser", typeof won === "string" && typeof lost === "string",
    JSON.stringify({ won, lost }));

  const walk = async (src: string) => await deadline(
    "the migration walk",
    run(src, {
      runId: "r-rename", handler: checkHandler(10_000_000), pins, migration: true,
      journal: new Journal({ run: "r-rename", entries: j.entries(), readOnly: true }),
    }),
  );

  // THE CONTROL FIRST. Without it a refusal below is indistinguishable from a walk that refuses
  // every race it is shown, which is a different system wearing the same green.
  ok("an unedited race still walks to completion", (await walk(RACE5)) === null);

  const renamedWinner = RACE5.split(`  ${won}:`).join(`  ${won}${won}:`);
  ok("the winner rename landed", renamedWinner !== RACE5, { won });
  const overRenamed = await walk(renamedWinner);
  ok("REPAIRED: a walk into a recorded winning arm the edit renamed away RETURNS rather than hanging",
    overRenamed !== null && !overRenamed.message.startsWith("HUNG:"), overRenamed?.message?.slice(0, 90));
  ok("and it returns the refusal, not some incidental fault",
    overRenamed instanceof ScopeBranchMissing, `${overRenamed?.name}: ${overRenamed?.message?.slice(0, 90)}`);
  // The refusal has to be ACTIONABLE, and the whole repair is a NAME: an author who is told only
  // "this scope diverged" goes looking inside an arm's body, which is the one place nothing changed.
  ok("the refusal names the missing arm, the scope, and what the source does declare",
    overRenamed instanceof ScopeBranchMissing
      && overRenamed.missing.join() === won
      && overRenamed.scopeKey === "/race:pick#0"
      && overRenamed.source.includes(`${won}${won}`),
    overRenamed instanceof ScopeBranchMissing
      ? { missing: overRenamed.missing, scope: overRenamed.scopeKey, source: overRenamed.source } : String(overRenamed));

  // PARALLEL, which the seat did not walk and which failed the other way: `Promise.all([])` RESOLVES,
  // so the walk entered nothing, refused nothing, and handed the program back the recorded value
  // keyed by an arm the source no longer has. Silent is not better than hung.
  const PAR5 = `
await parallel({
  a: async () => { await sleep("1s", { name: "a-work" }); return "a"; },
  b: async () => { await sleep("2s", { name: "b-work" }); return "b"; },
}, { name: "pair" });
`;
  const pj = new Journal({ run: "r-rename-par" });
  const ppins = (await run(PAR5, { runId: "r-rename-par", handler: new SimHandler({}), journal: pj })).pins;
  const pwalk = async (src: string) => await deadline("the parallel walk", run(src, {
    runId: "r-rename-par", handler: checkHandler(10_000_000), pins: ppins, migration: true,
    journal: new Journal({ run: "r-rename-par", entries: pj.entries(), readOnly: true }),
  }));
  ok("an unedited parallel still walks to completion", (await pwalk(PAR5)) === null);
  const parRenamed = await pwalk(PAR5.split("  a:").join("  aa:"));
  ok("a parallel branch the edit renamed away is refused too, rather than completing silently",
    parRenamed instanceof ScopeBranchMissing, `${parRenamed?.name}: ${parRenamed?.message?.slice(0, 90)}`);

  // NARROWNESS, and it is the half that keeps migrations possible. A guard that refused any edited
  // race would satisfy every cell above and make an edited arm un-migratable and un-forkable. Each
  // neighbouring shape has an answer that does not come from this guard, and must keep it:
  //   - a renamed or deleted LOSER diverges through the branch digest (L5001, section 2);
  //   - an ADDED arm is not an edit to anything recorded, so the walk completes.
  const renamedLoser = await walk(RACE5.split(`  ${lost}:`).join(`  ${lost}${lost}:`));
  ok("a renamed LOSER still diverges through the digest rather than through this guard",
    renamedLoser?.name === "RunDivergence", `${renamedLoser?.name}: ${renamedLoser?.message?.slice(0, 90)}`);
  const addedArm = await walk(RACE5.replace(`}, { name: "pick" })`,
    `  z: async () => { await sleep("3s", { name: "z-work" }); return "z"; },\n}, { name: "pick" })`));
  ok("and an arm the edit ADDED does not trip it: nothing recorded went missing", addedArm === null,
    `${addedArm?.name}: ${addedArm?.message?.slice(0, 90)}`);

  // The RESIDUAL, recorded rather than fixed. A RESUME of the same renamed source is silent: resume
  // mode consumes a settled scope wholesale without entering an arm, which is its documented and
  // correct behaviour, and the thing that is supposed to refuse edited source on a resume is a
  // program-hash pin the run record does not carry yet. Asserted so the day it changes is loud.
  const resumedRename = await deadline("the resume", run(renamedWinner, {
    runId: "r-rename", handler: checkHandler(10_000_000), pins, migration: false,
    journal: new Journal({ run: "r-rename", entries: j.entries(), readOnly: true }),
  }));
  ok("KNOWN GAP: a RESUME of a renamed winning arm is still silent, because it never enters an arm",
    resumedRename === null, `${(resumedRename as Error)?.name}: ${(resumedRename as Error)?.message?.slice(0, 90)}`);
}

// ---- 6) A SCOPE THAT FAILED IS STILL MADE OF ARMS ----------------------------------------------
//
// Section 5's guard was narrower than its own name. It asked "is every RECORDED branch present in
// the source?", which is vacuously true when NO branch was recorded, so it passed and the walk
// still entered nothing and still hung. And no branch was recorded for a whole class of scope: a
// successful scope carries its arm names inside `result`, `settle` writes `result` only for
// `status: "ok"` (result and error are exclusive, correctly), so a scope that FAILED recorded no
// arm names anywhere. A migration over an UNEDITED program containing a failed race hung.
//
// The arm names are not an outcome, so they are a FACT on the entry now, written on the failed path
// only, where `result` is not already carrying them. Two places, never both, so they cannot come to
// disagree.
//
// Both directions are here on purpose. The `race` is the hang. The `parallel` is the silent one:
// `Promise.all([])` RESOLVES, so a failed parallel returned the recorded error having entered
// nothing, and an edit inside the failing arm was invisible rather than loud.
{
  const deadline = async (label: string, p: Promise<unknown>, ms = 2_000) => {
    let t: ReturnType<typeof setTimeout>;
    const timer = new Promise<"HUNG">((res) => { t = setTimeout(() => res("HUNG"), ms); });
    const outcome = await Promise.race([p.then(() => null, (e: unknown) => e as Error), timer]);
    clearTimeout(t!);
    return outcome === "HUNG" ? new Error(`HUNG: ${label} did not return within ${ms}ms`) : outcome;
  };
  const PINS6 = { seed: "s6", startedAt: 1_700_000_000_000, yieldEvery: 1000, stepBudget: 100_000,
    effectCeiling: 1000, languageVersion: WALKER_LANGUAGE_VERSION, runId: "r6" } as never;

  const record = async (runId: string, src: string) => {
    const j6 = new Journal({ run: runId });
    await run(src, { runId, handler: new SimHandler({} as never), journal: j6, pins: { ...(PINS6 as never as Record<string, unknown>), runId } as never })
      .then(() => null, () => null);
    return j6.entries();
  };
  /** The same entries as a run recorded them BEFORE scopes carried arm names on failure. */
  const asLegacy = (es: readonly JournalEntry[]) =>
    es.map((e) => { const c = { ...e } as Record<string, unknown>; delete c.branches; return c as unknown as JournalEntry; });
  const walk6 = async (runId: string, src: string, es: readonly JournalEntry[]) =>
    await deadline(`${runId} walk`, run(src, {
      runId, handler: checkHandler(10_000_000), migration: true,
      pins: { ...(PINS6 as never as Record<string, unknown>), runId } as never,
      journal: new Journal({ run: runId, entries: es, readOnly: true }),
    }));

  const RACE6 = `
await race({
  x: async () => { await sleep("1s", { name: "x-work" }); throw "x blew up"; },
  y: async () => { await sleep("2s", { name: "y-work" }); throw "y blew up"; },
}, { name: "doomed" });
`;
  const raceEntries = await record("r6-race", RACE6);
  const raceScope = raceEntries.find((e) => journalEntryKeyString(e).includes("race:doomed")
    && (e as { state?: string }).state === "settled") as (JournalEntry & { branches?: readonly string[] }) | undefined;
  ok("a race whose arms all threw settles FAILED", (raceScope as { status?: string })?.status === "failed",
    JSON.stringify(raceScope)?.slice(0, 120));
  ok("and it carries no `result`, which is why the arm names had nowhere to live",
    (raceScope as { result?: unknown })?.result === undefined);
  ok("so the arm names are recorded as a FACT on the entry instead",
    JSON.stringify(raceScope?.branches) === JSON.stringify(["x", "y"]), raceScope?.branches);

  // THE HANG, deliberately over UNEDITED source: a migration that cannot walk what it recorded is
  // broken before any edit is involved.
  const sameRace = await walk6("r6-race", RACE6, raceEntries);
  ok("a migration over an UNEDITED failed race returns rather than hanging",
    !(sameRace as Error)?.message?.startsWith("HUNG"), `${(sameRace as Error)?.name}: ${(sameRace as Error)?.message?.slice(0, 80)}`);
  ok("and what it returns is the failure the run recorded, because it entered the arm that failed",
    String((sameRace as unknown) ?? "") === "x blew up", JSON.stringify(sameRace)?.slice(0, 90));

  // THE OTHER DIRECTION. A failed `parallel` never hung, because `Promise.all([])` resolves — it
  // handed back the recorded error having walked nothing, so an edit inside the failing arm was
  // silent. Entering the arm turns that into new work at the step the edit made.
  const PAR6 = `
await parallel({
  x: async () => { await sleep("1s", { name: "x-work" }); throw "x blew up"; },
  y: async () => { await sleep("2s", { name: "y-work" }); },
}, { name: "doomedp" });
`;
  const parEntries = await record("r6-par", PAR6);
  ok("a failed parallel records its arm names too", 
    JSON.stringify((parEntries.find((e) => journalEntryKeyString(e).includes("parallel:doomedp")
      && (e as { state?: string }).state === "settled") as { branches?: readonly string[] } | undefined)?.branches)
      === JSON.stringify(["x", "y"]));
  const parEdited = await walk6("r6-par", PAR6.replace(`{ name: "x-work" }`, `{ name: "x-edited" }`), parEntries);
  ok("an edit INSIDE a failed parallel's failing arm is now reached instead of being skipped",
    (parEdited as Error)?.name === "JournalReadOnlyError" || (parEdited as Error) instanceof ReachedFrontier,
    `${(parEdited as Error)?.name}: ${(parEdited as Error)?.message?.slice(0, 90)}`);

  // THE BACKSTOP, for journals already written. Their entries carry no arm names and never will, so
  // the walk still has nothing to enter — but it refuses by name instead of waiting forever. The
  // message is its own, because "a recorded branch is missing" is FALSE here: nothing was recorded,
  // and printing an empty `missing:` list would send a reader hunting for an arm that never existed.
  const legacyRace = await walk6("r6-race", RACE6, asLegacy(raceEntries));
  ok("a journal written before the fix refuses rather than hanging",
    legacyRace instanceof ScopeBranchMissing, `${(legacyRace as Error)?.name}: ${(legacyRace as Error)?.message?.slice(0, 80)}`);
  ok("and says the arm names are ABSENT rather than reporting a branch as missing",
    (legacyRace as Error)?.message?.includes("recorded no branch names") === true
      && (legacyRace as ScopeBranchMissing)?.recorded?.length === 0,
    (legacyRace as Error)?.message?.split("\n")[0]);

  // NARROWNESS, and the fixture has to be chosen with care or the cell grades nothing. The
  // backstop's subject is a RECORD carrying no arm names, never a SOURCE declaring none, and the
  // only shape that separates those two is a legacy entry walked against an emptied scope: nothing
  // recorded AND nothing in the source. A first attempt used `race({})`, which is vacuous twice
  // over -- an empty `race` awaits `Promise.race([])` and hangs on a LIVE run too, so the cell
  // returned a timeout in both worlds and could not see the mutation at all. `parallel` resolves on
  // an empty arm set, so it is the one that can answer.
  //
  // What the walk does here is unchanged by this fix and is asserted as such: it completes and
  // re-raises the failure the run recorded. Refusing it instead would take the answer away from the
  // ordinary checks that already handle an emptied scope.
  const emptiedLegacy = await walk6("r6-par", `await parallel({}, { name: "doomedp" });`, asLegacy(parEntries));
  ok("an emptied scope over a record with no arm names is NOT caught by the backstop",
    !(emptiedLegacy instanceof ScopeBranchMissing),
    `${(emptiedLegacy as Error)?.name}: ${(emptiedLegacy as Error)?.message?.slice(0, 80)}`);
  ok("and it completes with the recorded failure rather than a refusal",
    (emptiedLegacy as Error)?.name === "EffectError",
    `${(emptiedLegacy as Error)?.name}: ${(emptiedLegacy as Error)?.message?.slice(0, 80)}`);
}

console.log(`migrate.smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
