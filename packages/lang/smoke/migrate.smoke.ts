/**
 * The migration walk: why a settled scope is entered rather than consumed.
 *
 * A resume delivers a settled `race` from its own entry and marks the whole subtree accounted for
 * WITHOUT entering a branch. That is correct for a resume — the program hash is unchanged, so
 * nothing beneath the scope can have been removed, and the branches were decided rather than
 * deleted. Run EDITED source over the same journal and the identical short-circuit becomes a
 * defect: every entry beneath the scope is accounted for, so an effect the new source no longer
 * reaches never appears in `orphans()`, and a resolved human checkpoint inside the WINNING branch
 * disappears with L5004 never firing (design §8.4).
 *
 * The whole suite is one A/B on ONE journal: the same edited source walked with `migration: false`
 * and with `migration: true`. Anything that only asserted the migration side would pass against an
 * implementation that consumed nothing anywhere, which is a different system.
 *
 * Run: pnpm smoke:lang-migrate
 */
import { run, RuntimeFault, UnwalkableScope } from "../src/interpret.js";
import { SimHandler } from "../src/sim.js";
import { Journal, type JournalEntry } from "../src/journal.js";
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
    journal: j,
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
  await run(RACE, { runId: "r-race", handler: new SimHandler({}), journal: rj });
  const scope = rj.entries().find((e) => e.kind === "race");
  const losers = (scope as { cancel?: { losers: readonly string[] } })?.cancel?.losers ?? [];
  ok("the race recorded at least one loser", losers.length > 0, JSON.stringify(scope?.result));

  const rj2 = new Journal({ run: "r-race", entries: rj.entries(), readOnly: true });
  const outcome = await run(RACE, {
    runId: "r-race", handler: checkHandler(10_000_000), journal: rj2, migration: true,
  }).then(() => null, (e: unknown) => e as Error);
  ok("the migration walk completes over an unedited race", outcome === null, outcome?.message?.slice(0, 120));
  const raceOrphans = keys(rj2.orphans());
  ok("and the LOSER's own entries are not orphans: the race decided them",
    !raceOrphans.some((k) => losers.some((b) => k.includes(`/b:${b}/`))), JSON.stringify({ losers, raceOrphans }));
  ok("nothing at all is orphaned when the source did not change", raceOrphans.length === 0, raceOrphans);

  // An edit INSIDE the loser used to be invisible, which was the contract until §7.2's
  // `branchDigest` landed — read the note below before treating this pair as the proof of either.
  const DURATION: Record<string, string> = { x: "1s", y: "2s" };
  const loser = losers[0] as string;
  const EDITED_LOSER = RACE.replace(
    `sleep("${DURATION[loser]}", { name: "${loser}-work" })`,
    `sleep("7s", { name: "${loser}-work" })`,
  );
  ok("the edit landed on the losing branch", EDITED_LOSER !== RACE, JSON.stringify({ loser }));

  const rj3 = new Journal({ run: "r-race", entries: rj.entries(), readOnly: true });
  const overLoser = await run(EDITED_LOSER, {
    runId: "r-race", handler: checkHandler(10_000_000), journal: rj3, migration: true,
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

  // WHY THAT PAIR WAS NOT THE PROOF, AND WHAT IS. Kept, because the mutation it defends against is
  // still live: the digest closed the EDIT case, and this note is about the WALK case.
  //
  // Both cells above used to pass against a build that walks the losers too, and the mutation that
  // removes the branch filter SURVIVED them. Not because the divergence did not happen — the loser
  // really does raise `RunDivergence` — but because the race's winner tie-break DISCARDS it: on a
  // full replay every branch clock reads the same instant, so declaration order picks the winner
  // and a losing arm's rejection is dropped on the floor. An edit inside a loser was therefore
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
  await run(EXTRA, { runId: "r-race", handler: recorder, journal: rj4, migration: true })
    .then(() => null, (e: unknown) => e as Error);
  ok("a migration performs NO new work inside a branch the race decided",
    !asked.some((k) => k.includes(`/b:${loser}/`)), JSON.stringify(asked));

  // …and the recorder can see work at all, or the cell above passes because nothing was watching.
  const [watcher, seen] = tapped();
  const rj5 = new Journal({ run: "r-race", entries: rj.entries() });
  await run(`${RACE}\nawait sleep("5s", { name: "brand-new" });`, {
    runId: "r-race", handler: watcher, journal: rj5, migration: true,
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
  await run(ITEMS(`"a", "b"`), { runId: "r-fan", handler: new SimHandler({}), journal: fj });
  ok("the recorded fanOut has both branches",
    keys(fj.entries()).filter((k) => k.includes("/b:")).length === 2, keys(fj.entries()));

  const [handler, asked] = tapped();
  const fj2 = new Journal({ run: "r-fan", entries: fj.entries() });
  const added = await run(ITEMS(`"a", "b", "c"`), {
    runId: "r-fan", handler, journal: fj2, migration: true,
  }).then(() => null, (e: unknown) => e as Error);
  ok("a migration completes over a fanOut the edit widened", added === null, `${added?.name}: ${added?.message?.slice(0, 140)}`);
  ok("and performs no work in the branch the edit added",
    !asked.some((k) => k.includes("/b:c/")), JSON.stringify(asked));

  const fj3 = new Journal({ run: "r-fan", entries: fj.entries(), readOnly: true });
  const dropped = await run(ITEMS(`"a"`), {
    runId: "r-fan", handler: checkHandler(10_000_000), journal: fj3, migration: true,
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
    runId: "r-live", handler: checkHandler(10_000_000), journal: j, migration: true,
  }).then(() => null, (e: unknown) => e as Error);
  ok("an edited input inside the winning branch diverges", outcome?.name === "RunDivergence", outcome?.name);
  ok("and it names the step, in branch coordinates",
    outcome?.message.includes("/b:a/sleep:after-approve#0") === true, outcome?.message?.slice(0, 200));

  const resumeWalk = new Journal({ run: "r-live", entries: recorded.entries(), readOnly: true });
  const hidden = await run(DIVERGED, {
    runId: "r-live", handler: checkHandler(10_000_000), journal: resumeWalk, migration: false,
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
    .then(() => null, (e: unknown) => e as Error);
  ok("a conclave run records", first === null, first?.message?.slice(0, 120));

  const j2 = new Journal({ run: "r-conclave", entries: j.entries(), readOnly: true });
  const refused = await run(CONCLAVE, {
    runId: "r-conclave", handler: checkHandler(10_000_000), journal: j2, migration: true,
  }).then(() => null, (e: unknown) => e as Error);
  ok("a migration REFUSES to walk it rather than consuming what it cannot check",
    refused instanceof UnwalkableScope, refused?.name);
  ok("and says why: the handle is handler-derived and was never journalled",
    refused?.message.includes("never journalled") === true, refused?.message?.slice(0, 120));

  const j3 = new Journal({ run: "r-conclave", entries: j.entries(), readOnly: true });
  const resumed = await run(CONCLAVE, {
    runId: "r-conclave", handler: checkHandler(10_000_000), journal: j3, migration: false,
  }).then(() => null, (e: unknown) => e as Error);
  ok("a RESUME still short-circuits it, which is correct: nothing under it can have been removed",
    resumed === null, resumed?.name);
}

console.log(`migrate.smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
