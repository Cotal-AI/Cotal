/**
 * The fork: the cut, the mode that decides it, and the two things a fork must not re-decide.
 *
 * Four claims, each a different way to ship a fork that looks right:
 *
 * 1. **The cut ends BEFORE the step it names.** A fork re-runs from that step; a cut that included it
 *    would give the child a replay of the very work it was forked to redo.
 * 2. **The cut is computed in MIGRATION mode.** A resume's replay short-circuits a settled scope, so
 *    a cut inside one is never reached and the prefix becomes the WHOLE journal — silently. This
 *    file runs the wrong walk on purpose and shows the answer it gives, because a cell that cannot
 *    produce the defect cannot claim to exclude it.
 * 3. **The child inherits the parent's pins verbatim.** `resolvePins` defaults a seed to the run id,
 *    so a child that resolves its own pins is reseeded — and a reseeded prefix redecides every pure
 *    draw inside history it was supposed to be copying, with nothing diverging to say so.
 * 4. **The record is written LAST.** A crash between the copy and the record must leave a child no
 *    driver will touch, rather than one with a record and half a history.
 *
 * Run: pnpm smoke:runtime-fork   (needs nats-server on PATH)
 */
import { spawn as spawnProc } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  isReachable,
  createEndpointStreams,
  activateRun,
  openRecordsBucket,
  readRunRecord,
  RunAlreadyStarted,
} from "@cotal-ai/core";
import { jetstream } from "@nats-io/jetstream";
import {
  CATALOG,
  Journal,
  journalEntryKeyString,
  resolvePins,
  run as runProgram,
  SimHandler,
  type JournalEntry,
  type EffectContext,
  type EffectHandler,
  stepKeyString,
  type JournalStore,
} from "@cotal-ai/lang";
import { planFork, commitFork, ForkNotAdmissible, CutJournal, CutReached, RunJournalStore } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const SPACE = "forkrun";
const EP = "manager";
const NOW = 1_770_000_000_000;
const PINS = resolvePins({ runId: "r-parent" }, NOW);

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) { ok++; return; }
  fail++;
  console.log("  ✗ FAIL:", n, extra === undefined ? "" : JSON.stringify(extra));
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-forkrun-"));
const broker = spawnProc("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const done = () => {
  try { broker.kill("SIGKILL"); } catch { /* already gone */ }
  rmSync(sd, { recursive: true, force: true });
};
process.on("exit", done);

let up = false;
for (let i = 0; i < 60 && !up; i += 1) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
await createEndpointStreams(await jetstreamManager(nc), new Kvm(nc), SPACE);
const kv = await openRecordsBucket(nc, SPACE);
const js = jetstream(nc);
const jsm = await jetstreamManager(nc);

/** Record a run in the simulator and hand back its journal entries. */
const record = async (runId: string, source: string, script: unknown = {}): Promise<JournalEntry[]> => {
  const j = new Journal({ run: runId });
  await runProgram(source, { runId, handler: new SimHandler(script as never), journal: j, pins: PINS });
  return [...j.entries()];
};

const keys = (es: readonly JournalEntry[]): string[] => es.map((e) => journalEntryKeyString(e));

/** A store that collects, and optionally dies on the Nth append — which is what a crash looks like. */
const collector = (dieOn?: number): { store: JournalStore; got: JournalEntry[] } => {
  const got: JournalEntry[] = [];
  return {
    got,
    store: {
      append: async (e: JournalEntry): Promise<void> => {
        if (dieOn !== undefined && got.length === dieOn) throw new Error("the store died mid-copy");
        got.push(e);
      },
    },
  };
};

const FLAT = `await sleep("1m", { name: "one" });\nawait sleep("2m", { name: "two" });\nawait sleep("3m", { name: "three" });\nawait sleep("4m", { name: "four" });`;
const SCOPED =
  `await parallel({ a: async () => { await sleep("1m", { name: "a" }); return 1; }, ` +
  `b: async () => { await sleep("2m", { name: "b" }); return 2; } }, { name: "pair" });\n` +
  `await sleep("3m", { name: "after" });`;

const plan = async (
  over: Partial<Parameters<typeof planFork>[0]> & { entries: readonly JournalEntry[]; fromStepKey: string; source: string },
) =>
  await planFork({
    parent: "r-parent", child: "r-child", pins: PINS, actor: "david", now: () => NOW, ...over,
  });

// ── 1) the cut, and the step it stops before ───────────────────────────────────────────────────
{
  const entries = await record("r-parent", FLAT);
  const p = await plan({ entries, source: FLAT, fromStepKey: "/sleep:three#0" });

  c("a fork at a recorded step is admissible", p.admissible === true, p.refusals);
  c("the cut is what happened BEFORE it", keys(p.cut).join() === "/sleep:one#0,/sleep:two#0", keys(p.cut));
  c("the step forked at is NOT in the cut: the child re-runs it",
    !keys(p.cut).includes("/sleep:three#0"), keys(p.cut));
  c("and neither is anything after it", !keys(p.cut).includes("/sleep:four#0"), keys(p.cut));
  c("the plan names the step it cut at", p.fromStep === "/sleep:three#0", p.fromStep);
  c("and who asked, because a fork is somebody's decision", p.actor === "david", p.actor);
  c("the parent's own entries are untouched by planning",
    entries.every((e) => e.run === "r-parent") && entries.length === 4, entries.length);
}

// ── 2) THE MODE. The wrong walk is run here on purpose ──────────────────────────────────────────
{
  const entries = await record("r-parent", SCOPED);
  const CUT = "/parallel:pair#0/b:b/sleep:b#0";

  // The WRONG walk, spelled out rather than described: a resume's replay, over the same journal,
  // with the same stop. It is not an error and it does not throw — which is exactly the danger.
  const stopAll = new Proxy({}, {
    get: (_t, k) => (k === "now" ? () => NOW : () => { throw new Error("frontier"); }),
  }) as never;
  const wrong = new CutJournal({ run: "r-parent", entries, readOnly: true }, CUT);
  let wrongReached = false;
  try {
    await runProgram(SCOPED, { runId: "r-parent", handler: stopAll, journal: wrong, migration: false, pins: PINS });
  } catch (e) {
    let cur: unknown = e;
    for (let i = 0; i < 8 && (cur as { reason?: unknown })?.reason !== undefined; i += 1) cur = (cur as { reason: unknown }).reason;
    if (cur instanceof CutReached) wrongReached = true;
  }
  const wrongOrphans = new Set(keys(wrong.orphans()));
  const wrongCut = keys(entries.filter((e) => !wrongOrphans.has(journalEntryKeyString(e))));

  c("a resume's replay never reaches a cut inside a settled scope: it short-circuits it",
    wrongReached === false, wrongReached);
  c("and it accounts for the WHOLE journal, cut step and everything after it included",
    wrongCut.length === entries.length && wrongCut.includes(CUT) && wrongCut.includes("/sleep:after#0"),
    wrongCut);

  const p = await plan({ entries, source: SCOPED, fromStepKey: CUT });

  c("the real plan reaches a cut inside a settled scope, because it walks in migration mode",
    p.admissible === true, p.refusals);
  c("its cut is NOT the resume walk's answer", p.cut.length !== wrongCut.length,
    { plan: keys(p.cut), resume: wrongCut });
  // The enclosing `/parallel:pair#0` entry must stay OUT of the cut. A child replays in RESUME mode,
  // where a settled scope is taken wholesale, so a child that inherits it never re-enters the scope:
  // it skips the step it was forked for and adopts a recorded answer to the branch the caller wanted
  // re-decided.
  c("it holds the sibling branch that ran before the cut, and NOT the scope enclosing it",
    keys(p.cut).join() === "/parallel:pair#0/b:a/sleep:a#0", keys(p.cut));
  c("the enclosing scope is projected out, so the child re-enters instead of short-circuiting past it",
    !keys(p.cut).includes("/parallel:pair#0"), keys(p.cut));
  c("and neither the cut step nor the step after the scope",
    !keys(p.cut).includes(CUT) && !keys(p.cut).includes("/sleep:after#0"), keys(p.cut));
}

// ── 3) the pins, which a child must never resolve for itself ───────────────────────────────────
{
  const entries = await record("r-parent", FLAT);
  const p = await plan({ entries, source: FLAT, fromStepKey: "/sleep:three#0" });

  c("the plan carries the PARENT's pins", p.pins.seed === PINS.seed, { seed: p.pins.seed });
  c("whose seed is the parent's id, not the child's", p.pins.seed === "r-parent", p.pins.seed);
  // What the child would get if it resolved its own: the same call the parent made, with the child's
  // id. It is a different seed, and every pure draw in the copied prefix would be a different draw.
  c("a child that resolved its own pins would be reseeded, which is the defect",
    resolvePins({ runId: "r-child" }, NOW).seed !== p.pins.seed,
    resolvePins({ runId: "r-child" }, NOW).seed);
  c("the epoch is the parent's too: a fork does not restart the run clock",
    p.pins.startedAt === PINS.startedAt, { plan: p.pins.startedAt, parent: PINS.startedAt });

  const { store, got } = collector();
  const r = await commitFork(kv, EP, { ...p, child: "r-pins" }, store);
  const rec = await readRunRecord(kv, EP, "r-pins");
  c("the child's record is created", rec !== undefined, rec === undefined ? "absent" : "present");
  c("and it is pinned to the parent's seed, so the copied prefix decides what it decided",
    (rec?.spec.value.pins as { seed?: string } | undefined)?.seed === "r-parent",
    (rec?.spec.value.pins as { seed?: string } | undefined)?.seed);
  c("the copy reports what it copied", r.copied === got.length && r.copied === 2, { r, got: got.length });

  // WHAT THE CHILD INHERITS BESIDE THE PINS, and this cell exists to make a provisional answer
  // visible rather than to defend it. The effect ceiling is a RUN bound recovered from the journal,
  // so a child that replays the copied prefix starts having already spent it — a fork near the
  // ceiling gets a nearly-spent allowance. That follows from the recovery rather than from anyone
  // deciding it, and the rule does not say which it wants: `inherit the consumption` (the prefix is
  // the child's history and the child claims those effects as its own) or `a fresh allowance` (a
  // fork exists to do NEW work, and the frontier is the whole point).
  //
  // NAMED RE-OPEN TRIGGER: if that question is settled the other way, this cell FAILS, and it is
  // meant to. A design decision recorded only in a plan is one nobody re-reads; one asserted here
  // cannot be reversed quietly.
  // Guarded: a Journal refuses entries belonging to another run, so a fault in the copy shows up
  // here as a THROW rather than as a wrong number, and a thrown cell must fail rather than end the
  // suite — every cell below it is evidence too.
  let consumed: number | string;
  try { consumed = new Journal({ run: "r-pins", entries: got }).dispatchedEffects(); }
  catch (e) { consumed = `threw: ${(e as Error).message.slice(0, 60)}`; }
  c("the child inherits the prefix's effect CONSUMPTION, not just the ceiling — provisional, by construction",
    consumed === 2, consumed);

  // THE SCOPED TWIN, and the cell above is why it exists. `2` there is measured over a program with
  // NO SCOPES, so the claim-1 repair — which projects enclosing scope rows out of the cut — cannot
  // change it. As a re-open trigger for "does the child inherit the consumption" it was blind to the
  // only case that puts the question in doubt: it is live on the flat input and dead on the scoped
  // one, and every liveness check on it passes.
  //
  // This pins the SCOPED number instead, and pins it as behaviour-under-a-known-defect rather than
  // as behaviour that is right. Today a cut inside a branch is admissible with NO refusal and its
  // prefix carries the settled `/parallel:pair#0` fact, whose recorded result already holds b=2 —
  // the value the child was forked to re-decide, and which it then short-circuits over instead of
  // performing. So the count below is charged for a decision the child never makes.
  //
  // WHEN CLAIM 1 IS REPAIRED THIS CELL FAILS, and that is its whole purpose: the repair changes what
  // is in the cut, and a fork-inheritance closure that rested on "the prefix is the child's history"
  // must be re-argued at that moment rather than inherited silently.
  //
  // WHAT IT WOULD NOT HAVE CAUGHT, named here because a re-open mechanism that cannot say which
  // case it fires on is the same blind artifact it replaced. Had this existed when the closure was
  // made, it would have PASSED: `planFork`'s scope-internal path is unchanged since then, and the
  // reviewer measured this exact cut at `c641f90c` and got this exact answer. **It detects that the
  // premise's GROUND CHANGED. It cannot detect that the premise was FALSE.** The cell that would
  // have fired is the one that seeds a child and asserts its first live lookup is the requested key
  // — it does not exist yet, it belongs to the driver's own suite, and it is the only kind that
  // measures inheritance rather than the planner agreeing with itself.
  {
    const sEntries = await record("r-scoped", SCOPED);
    const sp = await plan({
      parent: "r-scoped", entries: sEntries, source: SCOPED,
      fromStepKey: "/parallel:pair#0/b:b/sleep:b#0",
    });
    c("a cut inside a branch of a `parallel` is admissible — re-entering it is sound",
      sp.admissible === true && sp.refusals.length === 0, sp.refusals);
    c("REPAIRED (claim 1): the settled enclosing scope is NOT in the prefix",
      !keys(sp.cut).includes("/parallel:pair#0"), keys(sp.cut));
    c("but the sibling branch that ran before the cut still is, so the child replays it rather than redoing it",
      keys(sp.cut).includes("/parallel:pair#0/b:a/sleep:a#0"), keys(sp.cut));

    // THE ONLY CELL THAT MEASURES THE FORK RATHER THAN THE PLANNER.
    //
    // Every other cell in this file asserts the SHAPE OF THE PLAN — which keys came back — and a
    // plan agreeing with itself is what let claim 1 stand through 200 determinism trials and three
    // journal shapes. What falsified it was seeding a child with exactly the entries `commitFork`
    // writes and printing the first step the child actually asks to PERFORM. So that is what this
    // does. It runs the child in the ordinary resume mode a driver would use, not in the migration
    // mode the planner uses, because the defect lived precisely in the gap between those two.
    const seeded = new Journal({
      run: "s-child",
      entries: sp.cut.map((e) => ({ ...e, run: "s-child" })),
    });
    let firstLive: string | null = null;
    const spy: EffectHandler = {
      ...new SimHandler({}),
      now: () => NOW,
      sleep: async (rq: unknown, ctx: EffectContext) => {
        firstLive ??= stepKeyString(ctx.key);
        return await new SimHandler({}).sleep(rq as never, ctx);
      },
    } as unknown as EffectHandler;
    await runProgram(SCOPED, { runId: "s-child", handler: spy, journal: seeded, pins: PINS });

    c("the CHILD's first live step is the step it was forked to re-run, not the one after the scope",
      firstLive === "/parallel:pair#0/b:b/sleep:b#0", { firstLive, expected: "/parallel:pair#0/b:b/sleep:b#0" });

    // The other side of the projection, and the reason it is not simply "drop enclosing scopes".
    // Re-entering is sound only where every branch RUNS. A `race` decided a winner; a child that
    // re-entered would race again on a fresh handler and could resolve the other arm — re-deciding
    // what the parent recorded. Copying it settled is the claim-1 defect; re-entering it is a
    // different run. Both are silent, so it is refused instead.
    const RACED =
      `await race({ quick: async () => { await sleep("1m", { name: "q" }); return 1; }, ` +
      `slow: async () => { await sleep("9m", { name: "s" }); return 2; } }, { name: "first" });\n` +
      `await sleep("3m", { name: "after" });`;
    const rEntries = await record("r-raced", RACED);
    const winner = keys(rEntries).find((k) => k.includes("/b:") && k.endsWith("#0"));
    const rp = await plan({ parent: "r-raced", entries: rEntries, source: RACED, fromStepKey: winner ?? "" });
    c("a cut inside a decided `race` is refused with L5020 rather than re-raced",
      rp.refusals.some((r) => r.code === "L5020"), { refusals: rp.refusals, at: winner });
    c("and the refusal says where to fork instead, so the caller repairs rather than guesses",
      rp.refusals.some((r) => r.code === "L5020" && r.why.includes("Fork at a step outside")), rp.refusals);
    let sConsumed: number | string;
    try {
      sConsumed = new Journal({
        run: "r-schild", entries: sp.cut.map((e) => ({ ...e, run: "r-schild" })),
      }).dispatchedEffects();
    } catch (e) { sConsumed = `threw: ${(e as Error).message.slice(0, 60)}`; }
    c("so the ceiling charges the child for a scope whose result already answers the step it was forked to redo",
      sConsumed === 1, { consumed: sConsumed, cut: keys(sp.cut) });

    // THE NARROWNESS OF THE PROJECTION, measured on the child rather than on the plan.
    //
    // Its kill-set twin — "project EVERY scope, not only the enclosing one" — SURVIVED the first
    // run, and survived honestly: the cell it was graded on forks a program with no scopes in it at
    // all, so the widening changed nothing there and the harness reported coverage this suite did
    // not have. A projection that dropped every settled scope would have satisfied the repair's own
    // mutation perfectly while re-running work the parent had already finished.
    //
    // So the case is put where it can actually differ: the same `parallel`, SETTLED, with the cut
    // AFTER it. Nothing about it is being re-decided, and it must stay in the prefix.
    //
    // The discriminator is what the child APPENDS, not what the planner returns and not which step
    // goes live first. Under the too-broad projection the branch sleeps are still in the prefix and
    // still replay, so the first live step is `/sleep:after#0` either way — a spy on `sleep` sees
    // nothing. What differs is the scope row: with it copied the child replays the settled parallel,
    // without it the child re-enters and records the scope a second time.
    const aEntries = await record("r-after", SCOPED);
    const ap = await plan({
      parent: "r-after", entries: aEntries, source: SCOPED, fromStepKey: "/sleep:after#0",
    });
    c("a fork AFTER a settled scope is admissible — nothing in it is being re-decided",
      ap.admissible === true && ap.refusals.length === 0, ap.refusals);
    c("and the scope it does not enclose STAYS in the prefix: the projection is enclosing-only",
      keys(ap.cut).includes("/parallel:pair#0"), keys(ap.cut));

    const { store: aStore, got: appended } = collector();
    await runProgram(SCOPED, {
      runId: "a-child",
      handler: new SimHandler({ clock: { start: NOW } }),
      journal: new Journal({ run: "a-child", entries: ap.cut.map((e) => ({ ...e, run: "a-child" })), store: aStore }),
      pins: PINS,
    });
    c("so the CHILD replays that scope instead of re-entering it: it records no second `parallel:pair`",
      !keys(appended).includes("/parallel:pair#0"), keys(appended));
    c("and it does append the step it was forked to run, so the run really happened",
      keys(appended).includes("/sleep:after#0"), keys(appended));
  }
}

// ── 4) the refusals, each naming a different repair ────────────────────────────────────────────
{
  const entries = await record("r-parent", FLAT);
  const code = (p: Awaited<ReturnType<typeof plan>>, k: string) => p.refusals.some((x) => x.code === k);
  /**
   * Presence is half a claim. A cell named "with L5001, NOT with a cut refusal" that only calls
   * `code()` checks the first clause and asserts nothing about the second — and the second was the
   * one that was false: L5018 was riding along with every other refusal, telling the caller the
   * program does not go there when it does. A cell that claims exclusivity has to be able to fail
   * on the exclusivity.
   */
  const noCode = (p: Awaited<ReturnType<typeof plan>>, k: string) => !p.refusals.some((x) => x.code === k);

  const unknown = await plan({ entries, source: FLAT, fromStepKey: "/sleep:nope#0" });
  c("a step the journal never recorded is refused", unknown.admissible === false, unknown.refusals);
  c("with L5017 rather than a cut at the end of history", code(unknown, "L5017"), unknown.refusals);

  // Recorded, but the source handed to the fork does not reach it — a different failure, and a
  // reader repairs it differently: one is a wrong key, the other is a wrong program.
  const unreached = await plan({
    entries, fromStepKey: "/sleep:three#0",
    source: `await sleep("1m", { name: "one" });\nawait sleep("2m", { name: "two" });`,
  });
  c("a recorded step this program never arrives at is refused too", unreached.admissible === false, unreached.refusals);
  c("with L5018, because a cut never reached is the whole journal", code(unreached, "L5018"), unreached.refusals);
  c("and an unreached plan carries no cut at all, rather than a plausible one",
    unreached.cut.length === 0, keys(unreached.cut));

  // WHY THAT EMPTINESS IS OVERDETERMINED, pinned rather than left to a reader's argument.
  //
  // The cut is now gated on `reached && refusals.length === 0`, and the second clause subsumes the
  // first on every path this source has: unreached-and-unrecorded pushes L5017, unreached-and-
  // recorded pushes L5018 unless L5001/L5014/L5020 already explains the stop — so `!reached` always
  // arrives with at least one refusal, and mutating `reached` away changes nothing. That makes the
  // `reached` clause defence in depth against a FUTURE path that returns unreached with an empty
  // refusal set, where the cut would otherwise be handed back silently. Defence in depth is only
  // honest if the premise it rests on is asserted, so this asserts it: the day a path can be both
  // unreached and refusal-free, this cell fails and the ungradable mutation on `reached` becomes
  // gradable again.
  c("an unreached plan always carries a refusal, which is what makes its empty cut overdetermined",
    unreached.refusals.length > 0, unreached.refusals);

  // AN EMPTY CUT IS TWO DIFFERENT ANSWERS, and only one of them is admissible. Above it means the
  // walk never reached the step, and the plan is REFUSED. Here it means the step is the run's FIRST,
  // so nothing happened before it — a fork at the beginning is a legal fork of no history, and a
  // refusal would be wrong. The pair is what makes `cut.length === 0` readable at all; on its own it
  // would be a number that means "refused" in one plan and "correct" in the next.
  const atFirst = await plan({ entries, source: FLAT, fromStepKey: "/sleep:one#0" });
  c("a fork at the run's FIRST step is admissible", atFirst.admissible === true, atFirst.refusals);
  c("and its cut is empty because nothing happened before it, not because nothing was reached",
    atFirst.cut.length === 0 && atFirst.fromStep === "/sleep:one#0", { cut: keys(atFirst.cut), at: atFirst.fromStep });

  const pinned = await plan({ entries, source: FLAT, fromStepKey: "/sleep:three#0", newProgramHash: "sha256:new" });
  c("a fork onto a new program is refused, because nothing pins a program hash", code(pinned, "L5002"), pinned.refusals);

  const wt = await plan({ entries, source: FLAT, fromStepKey: "/sleep:three#0", worktreeBranches: true });
  c("asking for the fork's own worktree branches is refused rather than silently skipped",
    code(wt, "L5019"), wt.refusals);
  c("and the refusal says there is no plane to cut one from",
    wt.refusals.some((r) => r.why.includes("worktree plane")), wt.refusals);

  // A scope the walk cannot ENTER, which is L5014 rather than L5018. Added because a mutation that
  // deleted the whole L5014 branch SURVIVED: `L5014` and `UnwalkableScope` appeared zero times in
  // this file. The throw itself is asserted on the lang side (migrate.smoke §4); what nothing
  // watched was `planFork` TRANSLATING it into a refusal, which is this file's half of the seam.
  //
  // The pairing with L5018 is the point. Both come back "not admissible, cut empty", and the codes
  // are the only thing that tells the caller whether the program never goes there (repair the key)
  // or the walk could not follow it there (fork before the conclave). Swallowing the first would
  // report the second, and the caller would repair a step key that was correct all along.
  {
    const CONCLAVE =
      `const team = await conclave([], async (room) => {\n` +
      `  await sleep("1s", { name: "inside" });\n  return "done";\n}, { name: "huddle" });\n` +
      `await sleep("2m", { name: "after" });`;
    const cEntries = await record("r-conclave", CONCLAVE);
    const past = await plan({
      parent: "r-conclave", entries: cEntries, source: CONCLAVE, fromStepKey: "/sleep:after#0",
    });
    c("a fork past a settled conclave is refused with L5014, not waved through",
      code(past, "L5014"), past.refusals);
    c("and NOT with L5018, which would send the caller to repair a step key that is correct",
      noCode(past, "L5018"), past.refusals);
    c("the refusal names the scope it could not enter, so the caller knows where to fork instead",
      past.refusals.some((r) => r.code === "L5014" && r.step !== undefined), past.refusals);
    c("and a refused fork carries no cut", past.admissible === false && past.cut.length === 0,
      { admissible: past.admissible, cut: keys(past.cut) });
  }

  // THE OTHER WAY THE WALK FAILS TO ENTER A SCOPE, and it did not refuse at all: it HUNG. A fork
  // walks in migration mode, so it enters a settled race's recorded winning arm; rename that arm in
  // the source and the walk filtered the arms down to nothing and awaited `Promise.race([])`, which
  // never settles. `planFork` returned no verdict — not a refusal, not a cut, nothing.
  //
  // Its own code and not L5014's, for the same reason the pairing above matters: both stop the walk
  // at a scope, but a conclave stops it because the handle was never journalled and this one because
  // the arm is gone, and a caller told the wrong one repairs the wrong thing.
  {
    const RACE =
      `await race({\n  x: async () => { await sleep("1s", { name: "x-work" }); return "x"; },\n` +
      `  y: async () => { await sleep("2s", { name: "y-work" }); return "y"; },\n}, { name: "pick" });\n` +
      `await sleep("2m", { name: "after" });`;
    const rEntries = await record("r-race-fork", RACE);
    const won = (rEntries.find((e) => e.kind === "race")?.result as
      { value?: { index?: string } } | undefined)?.value?.index as string;
    // THE CONTROL. A planFork that refused every race would satisfy the refusal cells below, and a
    // suite cannot tell "this edit is refused" from "this shape is refused" without it.
    const clean = await plan({
      parent: "r-race-fork", entries: rEntries, source: RACE, fromStepKey: "/sleep:after#0",
    });
    c("a fork past an UNEDITED settled race is admissible", clean.admissible === true, clean.refusals);
    // CAUGHT, deliberately. The claim is that planFork REPORTS this rather than raising it, so a
    // build that raises has to redden this cell — not abort the file before the cells below it and
    // before the terminal marker, which grades as "the suite stopped" rather than as a finding.
    const renamed = await plan({
      parent: "r-race-fork", entries: rEntries, fromStepKey: "/sleep:after#0",
      source: RACE.split(`  ${won}:`).join(`  ${won}${won}:`),
    }).then((r) => r, (e: unknown) => e as Error);
    c("a fork over a race whose winning arm the source renamed away RETURNS rather than hanging",
      !(renamed instanceof Error), (renamed as Error)?.name);
    // The three below are ABOUT the report, so a raise makes each of them false rather than
    // skipped. A skip would leave the suite green on the claim it stopped being able to check, and
    // "no evidence" scored as a pass is the false negative whose repair is always a weaker test.
    const raised = renamed instanceof Error ? (renamed as Error).name : null;
    c("and it is refused with L5022, naming the arm the source no longer declares",
      raised === null && code(renamed as Exclude<typeof renamed, Error>, "L5022")
        && (renamed as Exclude<typeof renamed, Error>).refusals.some((r) => r.why.includes(won)),
      raised ?? (renamed as Exclude<typeof renamed, Error>).refusals);
    c("not with L5014, which would send the caller to fork before a conclave that is not there",
      raised === null && noCode(renamed as Exclude<typeof renamed, Error>, "L5014"),
      raised ?? (renamed as Exclude<typeof renamed, Error>).refusals);
    c("and a refused fork carries no cut",
      raised === null && (renamed as Exclude<typeof renamed, Error>).admissible === false
        && (renamed as Exclude<typeof renamed, Error>).cut.length === 0,
      raised ?? { admissible: (renamed as Exclude<typeof renamed, Error>).admissible });
  }

  // A spawn in the CUT, which a fork must respawn or adopt at the frontier.
  const spawned = await record(
    "r-spawn",
    `const d = await spawn("dev", { name: "dev" });\nawait sleep("1m", { name: "after" });\nawait sleep("2m", { name: "later" });`,
  );
  const withSpawn = await plan({
    parent: "r-spawn", entries: spawned, fromStepKey: "/sleep:later#0",
    source: `const d = await spawn("dev", { name: "dev" });\nawait sleep("1m", { name: "after" });\nawait sleep("2m", { name: "later" });`,
  });
  c("a cut containing a spawn is refused: the fork would have to respawn an agent this host cannot mint",
    withSpawn.admissible === false && code(withSpawn, "L5019"), withSpawn.refusals);
  c("and the refusal names the spawn, not just the fork",
    withSpawn.refusals.some((r) => r.step === "/spawn:dev#0"), withSpawn.refusals);
  c("a fork BEFORE the spawn is admissible, so the refusal is about the cut and not about the run",
    (await plan({
      parent: "r-spawn", entries: spawned, fromStepKey: "/spawn:dev#0",
      source: `const d = await spawn("dev", { name: "dev" });\nawait sleep("1m", { name: "after" });\nawait sleep("2m", { name: "later" });`,
    })).admissible === true, "");

  // An edited source that diverges before the cut: the prefix is not decided, so there is nothing
  // to copy. Reported as a divergence rather than as an unreachable step, because they repair
  // differently — migrate the run, or fork on the source it recorded.
  const diverged = await plan({
    entries, fromStepKey: "/sleep:three#0",
    source: `await sleep("9m", { name: "one" });\nawait sleep("2m", { name: "two" });\nawait sleep("3m", { name: "three" });`,
  });
  c("a source that diverged before the cut is refused", diverged.admissible === false, diverged.refusals);
  c("with L5001, the divergence, not with a cut refusal", code(diverged, "L5001"), diverged.refusals);
  c("and the 'not' in that sentence is checked: no L5018 rides along saying the path does not go there",
    noCode(diverged, "L5018"), diverged.refusals);
  c("and every code this file hands out is in the language's catalog",
    [unknown, unreached, pinned, wt, withSpawn, diverged]
      .flatMap((p) => p.refusals.map((r) => r.code))
      .every((k) => k in CATALOG),
    [unknown, unreached, pinned, wt, withSpawn, diverged].flatMap((p) => p.refusals.map((r) => r.code)));
}

// ── 5) the commit, and the order that makes a half-fork harmless ───────────────────────────────
{
  const entries = await record("r-parent", FLAT);
  const p = await plan({ entries, source: FLAT, fromStepKey: "/sleep:three#0" });

  const { store, got } = collector();
  const r = await commitFork(kv, EP, { ...p, child: "r-ok" }, store);
  c("the cut is copied entry for entry", got.length === 2, keys(got));
  c("onto the CHILD's run, because the prefix is now the child's history",
    got.every((e) => e.run === "r-ok"), got.map((e) => e.run));
  c("while the parent's copies still say the parent: fork is not rollback",
    entries.every((e) => e.run === "r-parent"), entries.map((e) => e.run));
  c("and the entries keep their recorded identity, so a replay finds them where they were",
    keys(got).join() === "/sleep:one#0,/sleep:two#0", keys(got));
  c("the lineage is reported as NOT recorded, rather than left for a reader to discover",
    r.lineageRecorded === false, r);

  // The order. A store that dies mid-copy is the crash this ordering exists for.
  const dying = collector(1);
  const crashed = await commitFork(kv, EP, { ...p, child: "r-crash" }, dying.store)
    .then(() => null, (e: unknown) => e as Error);
  c("a copy that dies partway through fails loudly", crashed !== null, crashed);
  c("and leaves NO record behind: the spec is written last",
    (await readRunRecord(kv, EP, "r-crash")) === undefined, "a record exists");
  c("which is the point — a child with a record and half a history is one a driver would take over",
    dying.got.length === 1, dying.got.length);

  const refused = await commitFork(
    kv, EP,
    { ...p, child: "r-refused", admissible: false, refusals: [{ code: "L5017", why: "test" }] },
    collector().store,
  ).then(() => null, (e: unknown) => e as Error);
  c("committing a refused plan is refused before anything is written",
    refused instanceof ForkNotAdmissible, refused?.name);
  c("and nothing was created for it", (await readRunRecord(kv, EP, "r-refused")) === undefined, "a record exists");

  const twice = await commitFork(kv, EP, { ...p, child: "r-ok" }, collector().store)
    .then(() => null, (e: unknown) => e as Error);
  c("forking into a run that already exists is refused: a fork mints a new run",
    twice instanceof ForkNotAdmissible, twice?.name);

  // THE RETRY THE CELL ABOVE DOES NOT COVER, AND THE HAND-BUILT STORE IS WHY. `commitFork`'s guard
  // reads the RECORD, and the record is written LAST — so after a crash mid-copy there is no record
  // to find, the guard passes, and a retry with the same child id appends the prefix a SECOND time.
  // Against the collector above that is exactly what happens, and it is a corrupt journal.
  //
  // It is unreachable through the real path, and that is a claim about a DIFFERENT component, so it
  // is proved here rather than assumed: a caller gets a durable store by activating the child's
  // journal, and an activation that expects a NEW run refuses one whose journal already has records.
  // A suite that builds its inputs by hand proves the code it drives and nothing about what reaches
  // it — so the fence is observed, not reasoned about.
  const retryHandBuilt = collector();
  const retryErr = await commitFork(kv, EP, { ...p, child: "r-crash" }, retryHandBuilt.store)
    .then(() => null, (e: unknown) => e as Error);
  c("a hand-built store lets a crashed fork be retried, and the prefix lands TWICE",
    retryErr === null && retryHandBuilt.got.length === 2 && dying.got.length === 1,
    { retry: retryHandBuilt.got.length, crashed: dying.got.length, err: retryErr?.name });

  // The same crash, on the DURABLE plane this time: a real appender, dying after one entry, so the
  // child ends up with journal records on the wire and no record — the exact state the write-last
  // ordering produces. Then the retry, through the door a caller actually has.
  const appender = await activateRun(js, jsm, {
    space: SPACE, runId: "r-durable", holder: "m1", fencingToken: 1, epoch: 1,
    takeoverId: "t-first", at: NOW, expect: "new",
  });
  const real = new RunJournalStore(appender);
  let wrote = 0;
  const dyingReal: JournalStore = {
    append: async (e: JournalEntry): Promise<void> => {
      if (wrote >= 1) throw new Error("the store died mid-copy");
      wrote += 1;
      await real.append(e);
    },
  };
  const durableCrash = await commitFork(kv, EP, { ...p, child: "r-durable" }, dyingReal)
    .then(() => null, (e: unknown) => e as Error);
  c("a durable copy that dies partway leaves entries on the wire and no record",
    durableCrash !== null && wrote === 1 && (await readRunRecord(kv, EP, "r-durable")) === undefined,
    { wrote, err: durableCrash?.message });

  const fenced = await activateRun(js, jsm, {
    space: SPACE, runId: "r-durable", holder: "m2", fencingToken: 2, epoch: 1,
    takeoverId: "t-retry", at: NOW, expect: "new",
  }).then(() => null, (e: unknown) => e as Error);
  c("and the retry is refused at the door a caller actually uses: a journal with records is not NEW",
    fenced instanceof RunAlreadyStarted, fenced?.name ?? "activated");
}

// ── 6) THE LOSING ARM. Every cell here pins behaviour that is WRONG TODAY ───────────────────────
//
// These land BEFORE the repair on purpose, and they are written to DIE when it arrives. A cell
// authored after a fix asserts what the fix does; a cell authored before it has to state what is
// wrong first, which is the only moment the claim can still be falsified by the code.
//
// This is not left open. A MIGRATION IS NOT A RESUME AND MUST NOT USE THE RESUME SHORT-CIRCUIT ...
// walk the RECORDED WINNING BRANCH and run the ordinary hash and orphan checks inside it, APPLY
// LOST-BRANCH POLICY TO THE OTHERS, and compare `branchDigest` if the entry carries one." The walk
// here does the first clause and neither of the other two: `branchDigest` exists nowhere in this
// tree (it is optional, so that is not the defect), and the losing arms are consumed wholesale —
// which is the short-circuit the paragraph forbids by name, applied to the arms the winner's walk
// does not cover.
{
  const RACED =
    `await race({ quick: async () => { await sleep("1m", { name: "q" }); return 1; }, ` +
    `slow: async () => { await sleep("9m", { name: "s" }); return 2; } }, { name: "first" });\n` +
    `await sleep("3m", { name: "after" });`;
  // The LOSING arm edited: its step is renamed, so the recorded loser key is unreachable from it.
  const EDITED_LOSER = RACED.replace(`{ name: "s" }`, `{ name: "s-renamed" }`);
  // The WINNING arm edited instead — the arm the walk does cover. This is the POSITIVE CONTROL,
  // and without it every cell below is indistinguishable from "the divergence check is switched
  // off in this fixture".
  const EDITED_WINNER = RACED.replace(`{ name: "q" }`, `{ name: "q-renamed" }`);

  const WINNER = "/race:first#0/b:quick/sleep:q#0";
  const LOSER = "/race:first#0/b:slow/sleep:s#0";
  const AFTER = "/sleep:after#0";

  const rEntries = await record("r-loser", RACED);
  const atKey = async (source: string, fromStepKey: string) =>
    await plan({ parent: "r-loser", entries: rEntries, source, fromStepKey });

  const control = await atKey(RACED, AFTER);
  const winnerEdit = await atKey(EDITED_WINNER, AFTER);
  const loserEdit = await atKey(EDITED_LOSER, AFTER);

  c("the parent really did record the loser's step, settled — this is not an unrecorded branch",
    rEntries.some((e) => journalEntryKeyString(e) === LOSER && e.state === "settled"),
    rEntries.map((e) => `${journalEntryKeyString(e)}:${e.state}`));

  // THE CONTROL, and it proves the instrument: the checker is alive on the arm the walk enters.
  c("editing the WINNING arm is caught — the walk enters it, so the recorded step stops being reached",
    winnerEdit.admissible === false && winnerEdit.refusals.some((r) => r.code === "L5018"),
    winnerEdit.refusals);

  // The losers' bodies are bound into the scope entry by its `branchDigest`, so an edit to an arm
  // the walk never enters still diverges at the scope. Without that binding an edited loser and an
  // unedited source produce the same plan.
  c("REPAIRED: editing the LOSING arm diverges, at the scope that bound it",
    loserEdit.admissible === false && loserEdit.refusals.some((r) => r.code === "L5001"),
    loserEdit.refusals);
  c("and its plan is no longer indistinguishable from the plan for the UNEDITED source",
    JSON.stringify(keys(loserEdit.cut)) !== JSON.stringify(keys(control.cut)),
    { edited: keys(loserEdit.cut), control: keys(control.cut) });

  // THE NARROWNESS, in the same block, because a digest that refused everything would satisfy the
  // cell above perfectly and make every fork over a race impossible. The digest is over STRUCTURE
  // with source offsets stripped: reindenting a losing arm is not an edit to it, and a check that
  // fired on whitespace is the false positive that teaches people to route around the check.
  const REFORMATTED = RACED.replace(
    `slow: async () => { await sleep("9m", { name: "s" }); return 2; }`,
    `slow: async () => {\n      await sleep("9m", { name: "s" });\n      return 2;\n    }`,
  );
  const reformatted = await atKey(REFORMATTED, AFTER);
  c("and a REFORMATTED losing arm is not an edited one: same structure, same digest, still admissible",
    reformatted.admissible === true && reformatted.refusals.length === 0, reformatted.refusals);

  // WRONG TODAY, and DELIBERATELY still wrong: the mechanism the digest hardens over rather than
  // replaces. The dry walk never looks the loser's entry up, so by the orphan definition ("ORPHANS
  // = journal entries never looked up by the dry replay") it is an orphan and lost-branch policy
  // decides it. Instead it is swept into the prefix as accounted-for — the wholesale consumption
  // that paragraph forbids by name, applied to the arms the winner's walk does not cover, so a
  // resolved checkpoint inside a losing arm never reaches the orphan table.
  //
  // Measured on the UNEDITED source on purpose. Against edited source the digest now refuses the
  // whole plan, which empties the cut and would make this cell pass for a reason that has nothing
  // to do with disposition — a cell that dies for the wrong reason stops being a tripwire.
  //
  // Lost-branch policy is NAMED and DEFINED NOWHERE, and routing losers into the existing
  // orphan table would change what already-working UNEDITED source does: every migration over a
  // race with a rejected-kind orphan in a losing arm would start being refused. That is a semantic
  // decision, so it is a SPEC proposal rather than something this package invents. The cell stays red-
  // when-fixed until that lands.
  c("WRONG TODAY: an unedited fork sweeps the loser's step into the prefix rather than dispositioning it",
    keys(control.cut).includes(LOSER), keys(control.cut));

  // WRONG TODAY, a different failure with the same root: the walk does not go there, so the loser's
  // OWN step is reported unreached. L5018 tells the caller their program does not reach a step the
  // parent demonstrably performed and settled — a repair aimed at a key that is correct. It is the
  // ride-along already fixed for L5001/L5014, one code short: the gate does not count L5020.
  const atLoser = await atKey(RACED, LOSER);
  c("a cut at the loser's step is refused, and L5020 is the right half of that",
    atLoser.admissible === false && atLoser.refusals.some((r) => r.code === "L5020"), atLoser.refusals);
  c("REPAIRED: L5018 no longer rides along, because the step IS one the program reaches",
    !atLoser.refusals.some((r) => r.code === "L5018"), atLoser.refusals);
  c("and the refusal set is exactly the one true code, so it reads as one repair",
    atLoser.refusals.length === 1, atLoser.refusals);

  // An inadmissible plan carries no cut on either path. A caller that reads `cut` without reading
  // `admissible` must get nothing usable-shaped out of a fork that will not happen.
  const atWinner = await atKey(RACED, WINNER);
  c("REPAIRED: an INADMISSIBLE plan carries no cut",
    atWinner.admissible === false && atWinner.cut.length === 0, { cut: keys(atWinner.cut) });
  // The narrowness of that, in the same block: emptiness must come from the REFUSAL, not from the
  // plan having stopped producing cuts. `control` is admissible over the same journal and carries
  // the full prefix.
  c("and an admissible plan over the same journal still carries its prefix",
    control.admissible === true && control.cut.length === 3, keys(control.cut));
}

// ── 7) THE SHAPE THE CALLER ACTUALLY HOLDS ─────────────────────────────────────────────────────
//
// Every other block in this file hands `planFork` a KEYED view, because `record()` builds one from
// `Journal.entries()`. No driver has one. The stream is append-only — `journal-store.smoke` proves
// one step is two records — `RunJournalAppender.steps()` replays every step record in order, and
// `run-driver.ts`'s `drive` seeds a journal straight from `appender.steps()`. **A suite that only
// passes the tidy shape cannot see what the real caller's shape does**, which is why this exists.
//
// The language folds that log when it SEEDS a journal. `planFork` filters `req.entries` directly,
// so it does not.
{
  const log: JournalEntry[] = [];
  const j = new Journal({
    run: "r-log",
    store: { append: async (e: JournalEntry) => { log.push(e); } },
  });
  await runProgram(FLAT, { runId: "r-log", handler: new SimHandler({ clock: { start: NOW } }), journal: j, pins: PINS });

  c("the log really carries two rows per step, which is what append-only means",
    log.length === 2 * [...j.entries()].length, { rows: log.length, steps: [...j.entries()].length });

  const p = await plan({ parent: "r-log", entries: log, source: FLAT, fromStepKey: "/sleep:three#0" });
  c("a fork over the log is admissible, exactly as it is over the keyed view",
    p.admissible === true && p.refusals.length === 0, p.refusals);

  // The plan addresses the journal's KEYED view, so one step is one row in the cut. A plan over the
  // raw log would copy the pending row and the settled row of every step, handing the child a
  // history twice the size of the one its parent performed, with every key correct and two of each.
  c("REPAIRED: the cut carries one row per step, folded by the journal rather than by a second rule",
    keys(p.cut).length === 2 && new Set(keys(p.cut)).size === 2, keys(p.cut));
  c("and it is the SETTLED row that survives, not the pending one the log opened with",
    p.cut.every((e) => e.state === "settled"), p.cut.map((e) => `${journalEntryKeyString(e)}:${e.state}`));

  // And the reason it is worth repairing at the fork rather than left to the child's journal to
  // absorb: `commitFork` COPIES the cut, so the doubling is written to the child's durable stream
  // as real records. The seeded journal folds them on read; the stream keeps them forever.
  c("and the same fork over the keyed view carries one row per step, which is the answer both should give",
    keys((await plan({ parent: "r-log", entries: [...j.entries()], source: FLAT, fromStepKey: "/sleep:three#0" })).cut)
      .join() === "/sleep:one#0,/sleep:two#0",
    keys((await plan({ parent: "r-log", entries: [...j.entries()], source: FLAT, fromStepKey: "/sleep:three#0" })).cut));
}

console.log(`fork-run.smoke: ${ok} passed, ${fail} failed`);
done();
process.exit(fail === 0 ? 0 : 1);
