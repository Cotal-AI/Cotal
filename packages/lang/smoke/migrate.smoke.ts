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

  // The one above passes against a build that walks the losers too, because an UNEDITED loser
  // replays clean either way — so it is not the cell that proves the losers are skipped. EDIT the
  // losing branch, and the two builds part company: skipping it is silent, entering it hits a hash
  // that no longer matches and refuses the migration over a branch the race already decided. This
  // is the other diagonal of section 1 — that one catches a walk that reports too LITTLE, this one
  // catches a walk that reports too MUCH — and the two mutants have different casualty lists.
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
  ok("a migration does not enter a branch the race decided, so an edit inside the LOSER is invisible",
    overLoser === null, `${overLoser?.name}: ${overLoser?.message?.slice(0, 140)}`);
  ok("and the loser's steps are still accounted for rather than orphaned",
    keys(rj3.orphans()).length === 0, keys(rj3.orphans()));
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
