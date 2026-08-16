/**
 * §8.5's fork: the cut, the mode that decides it, and the two things a fork must not re-decide.
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
  c("it holds the scope entry and the sibling branch that ran before the cut",
    keys(p.cut).join() === "/parallel:pair#0,/parallel:pair#0/b:a/sleep:a#0", keys(p.cut));
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
  // deciding it, and §8.5 does not say which it wants: `inherit the consumption` (the prefix is the
  // child's history and the child claims those effects as its own) or `a fresh allowance` (a fork
  // exists to do NEW work, and the frontier is the whole point).
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
}

// ── 4) the refusals, each naming a different repair ────────────────────────────────────────────
{
  const entries = await record("r-parent", FLAT);
  const code = (p: Awaited<ReturnType<typeof plan>>, k: string) => p.refusals.some((x) => x.code === k);

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

  const pinned = await plan({ entries, source: FLAT, fromStepKey: "/sleep:three#0", newProgramHash: "sha256:new" });
  c("a fork onto a new program is refused, because nothing pins a program hash", code(pinned, "L5002"), pinned.refusals);

  const wt = await plan({ entries, source: FLAT, fromStepKey: "/sleep:three#0", worktreeBranches: true });
  c("asking for the fork's own worktree branches is refused rather than silently skipped",
    code(wt, "L5019"), wt.refusals);
  c("and the refusal says there is no plane to cut one from",
    wt.refusals.some((r) => r.why.includes("worktree plane")), wt.refusals);

  // A spawn in the CUT, which §8.5 says the fork must respawn or adopt at the frontier.
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
    space: SPACE, endpoint: EP, kv, runId: "r-durable", holder: "m1", fencingToken: 1, epoch: 1,
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
    space: SPACE, endpoint: EP, kv, runId: "r-durable", holder: "m2", fencingToken: 2, epoch: 1,
    takeoverId: "t-retry", at: NOW, expect: "new",
  }).then(() => null, (e: unknown) => e as Error);
  c("and the retry is refused at the door a caller actually uses: a journal with records is not NEW",
    fenced instanceof RunAlreadyStarted, fenced?.name ?? "activated");
}

console.log(`fork-run.smoke: ${ok} passed, ${fail} failed`);
done();
process.exit(fail === 0 ? 0 : 1);
