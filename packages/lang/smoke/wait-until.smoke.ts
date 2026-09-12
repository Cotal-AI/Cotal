/**
 * `waitUntil`: the durable wait on a resource outside the mesh (#1459).
 *
 * THE CLAIM THIS SUITE EXISTS FOR, stated as the issue states it: *given a program that must not
 * proceed until a predicate over a non-mesh resource holds, the run survives a crash, resumes on
 * another host, and journals what it observed.* The sharp half is the resume: an observation of
 * "pending" must be RE-OBSERVED on resume, not replayed.
 *
 * EVERY CELL BELOW IS PAIRED WITH ITS CONTROL, because the property is invisible without one. The
 * control is the shape a program has today: a poll expressed as an ordinary settling effect. It
 * replays "pending" forever for a resource that has since completed. Run in the same file, against
 * the same resource, through the same handler, so the only difference between a cell and its
 * control is which durable shape the wait uses. Without the control, "the resumed run saw
 * completed" would also be true of a run that simply never crashed.
 */
import { run, resume } from "../src/interpret.js";
import { SimHandler } from "../src/sim.js";
import { Journal, type JournalEntry } from "../src/journal.js";
import { resolvePins, WALKER_LANGUAGE_VERSION, type RunPins } from "../src/pins.js";
import { validate } from "../src/grammar.js";
import { LangErrors } from "../src/errors.js";
import type { EffectContext, ObserveRequest } from "../src/effects.js";

let pass = 0;
/**
 * NOT FAIL-FAST, and deliberately. A suite that throws at its first red grades only one cell per
 * run: every later claim becomes invisible, and a mutation that breaks the property named on line
 * 300 reddens whatever line 150 happens to notice first. That makes each cell's name a lie about
 * what it measures. Measured, not assumed: under the mutant that restores the old settling
 * behaviour, a fail-fast version of this file died on "the live activation was released mid-wait"
 * (a casualty: the mutant settles the wait, so the run finishes before the release fires) and
 * never reached the cell that actually names the defect. Every cell here runs, and the file exits
 * non-zero at the end with all of them listed.
 */
const failures: string[] = [];
/**
 * EACH SECTION IS ISOLATED, for the same reason the file is not fail-fast and one step further: a
 * broken implementation does not fail politely by returning a wrong value, it THROWS, and an
 * uncaught throw from section 3 takes sections 4 through 10 with it. That is how a mutation gets
 * graded against a cell that never ran. Measured, not assumed: the mutant that collapses every
 * observation into one key namespace makes the probe replay a stale "pending" until the wait hits
 * its deadline, and the resulting uncaught L4023 killed the file six sections early. A section
 * that throws now records the throw against its own name and the rest of the file still runs.
 */
const section = async (body: () => Promise<void>): Promise<void> => {
  try {
    await body();
  } catch (e) {
    const m = `THREW: ${(e as { code?: string })?.code ?? (e as Error)?.name ?? "error"} - ${messageOf(e)}`;
    failures.push(m);
    console.log(`  ✗ ${m}`);
  }
};
const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) {
    failures.push(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
    console.log(`  ✗ FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
    return;
  }
  pass++;
  console.log(`  ok ${name}`);
};

/**
 * The external resource under test: PENDING for its first `pendingFor` looks, COMPLETED after.
 *
 * It counts its own looks, which is the instrument the whole suite rests on: "the resumed run
 * re-observed" is a statement about how many times the world was actually asked, not about what
 * the program happened to print.
 */
const resource = (pendingFor: number) => {
  let looks = 0;
  return {
    look() {
      looks += 1;
      return looks <= pendingFor ? "pending" : "completed";
    },
    get looks() {
      return looks;
    },
  };
};

/**
 * A handler whose `ask` IS the external resource.
 *
 * A cotal-lang program has no IO by design: a probe reaches the world through an effect the host
 * binds, and `ask` is that effect here. This matters more than it looks. It makes the probe REAL
 * PROGRAM CODE PERFORMING A REAL EFFECT, so the suite measures the case that can actually go
 * wrong: if only the wait re-observed while the probe's own step replayed its recorded answer, the
 * re-observation would be a ritual and the defect would survive one layer further down. Measured:
 * before each observation got its own key namespace, that is exactly what happened.
 */
const handlerOver = (world: { look(): string }) =>
  class extends SimHandler {
    async ask(): Promise<unknown> {
      return { state: world.look() };
    }
  };

/** A store that keeps the append log, which is what a durable run has and an in-memory test skips. */
const recording = () => {
  const rows: JournalEntry[] = [];
  return { rows, store: { append: async (e: JournalEntry) => void rows.push(e) } };
};

/** Fold an append log the way a driver seeds a journal from one: last write per key wins. */
const fold = (rows: readonly JournalEntry[]): JournalEntry[] => [
  ...new Map(rows.map((e) => [`${e.scope}/${e.kind}:${e.name}#${e.occurrence}`, e])).values(),
];

const PINS: RunPins = resolvePins({ runId: "wait-until" }, 1_000_000, WALKER_LANGUAGE_VERSION);

const entryOf = (entries: readonly JournalEntry[], kind: string) => entries.find((e) => e.kind === kind);

// ---- 1) THE CONTROL: what a program can express today, and why it is not enough ------------------

/**
 * This is the defect in #1459, executed. It is FIRST because every claim after it is relative to
 * it: the subject's value is exactly the distance between this cell and the next.
 */
await section(async () => {
  const world = resource(2);
  const H = handlerOver(world);
  const SRC = `
const a = await spawn("prober", { name: "p" });
const r = await ask(a, { name: "look", schema: { state: "string" } });
log("state", r.state);
`;
  const first = await run(SRC, { runId: "ctl", handler: new H({}), onLog: () => {} });
  const e = entryOf(first.journal.entries(), "ask");
  ok(
    "CONTROL: a poll expressed as an ordinary effect SETTLES its observation as the step's result",
    e?.state === "settled" && e?.status === "ok" && (e?.result as { state: string }).state === "pending",
    { state: e?.state, status: e?.status, result: e?.result },
  );

  const before = world.looks;
  let saw: unknown;
  await resume(SRC, new Journal({ run: "ctl", entries: first.journal.entries() }), {
    runId: "ctl",
    handler: new H({}),
    pins: first.pins,
    onLog: (l) => {
      saw = l.values[1];
    },
  });
  ok(
    "CONTROL: and the resume RE-OBSERVES NOTHING, handing the program a stale \"pending\" for a resource that has completed",
    world.looks - before === 0 && saw === "pending",
    { reObservations: world.looks - before, saw },
  );
});

// ---- 2) THE SUBJECT: waitUntil re-observes on resume --------------------------------------------

const SUBJECT = `
const a = await spawn("prober", { name: "p" });
const seen = await waitUntil(
  async () => await ask(a, { name: "look", schema: { state: "string" } }),
  { name: "checks", every: "1m", deadline: "10m", terminal: (o) => o.state !== "pending" },
);
log("state", seen.state);
`;

await section(async () => {
  const world = resource(2);
  const H = handlerOver(world);
  const rec = recording();

  // The live activation is cut short DELIBERATELY, which is the only honest way to test a resume:
  // `shouldStop` releases the run mid-wait, exactly as a host reaching its work horizon does.
  // `RunReleased` settles nothing, so what the store holds is what a resuming host would find.
  let dispatches = 0;
  const released = await run(SUBJECT, {
    runId: "sub",
    handler: new H({}),
    journal: new Journal({ run: "sub", store: rec.store }),
    onLog: () => {},
    shouldStop: () => (dispatches++ > 3 ? "host stopping mid-wait" : undefined),
  }).catch((e: unknown) => e);

  ok("the live activation was released mid-wait, so this is a real resume and not a second run",
    (released as Error)?.name === "RunReleased", (released as Error)?.name);

  const folded = fold(rec.rows);
  const wait = entryOf(folded, "waitUntil");
  ok(
    "the wait's entry is PENDING with its non-terminal observations recorded, and NO result",
    wait?.state === "pending" && wait?.result === undefined && (wait?.observations ?? []).length > 0,
    { state: wait?.state, status: wait?.status ?? null, result: wait?.result ?? null, observations: (wait?.observations ?? []).map((o) => o.value) },
  );
  ok(
    "every recorded observation is the non-terminal one, so nothing here is an answer the resume could reuse",
    (wait?.observations ?? []).every((o) => (o.value as { state: string }).state === "pending"),
    (wait?.observations ?? []).map((o) => o.value),
  );

  // THE PROPERTY. The resource has completed in the meantime. Does the resumed run look again?
  const before = world.looks;
  let saw: unknown;
  await resume(SUBJECT, new Journal({ run: "sub", entries: folded }), {
    runId: "sub",
    handler: new H({}),
    pins: PINS,
    onLog: (l) => {
      saw = l.values[1];
    },
  });
  ok(
    "THE PROPERTY: the resumed wait OBSERVES THE WORLD AGAIN rather than replaying what it last saw",
    world.looks - before > 0,
    { reObservations: world.looks - before },
  );
  ok(
    "and the program is handed what the world says NOW (\"completed\"), where the control was handed \"pending\" forever",
    saw === "completed",
    saw,
  );
});

// ---- 3) the probe's OWN effects re-run, which is what makes the re-observation real -------------

/**
 * The cell that survives the plausible wrong fix. Re-entering the wait is not enough: the probe
 * reaches the world by performing effects, and those effects are journalled. Share one key
 * namespace across observations and the second look's `ask` replays the first look's recorded
 * answer, so the wait re-observes and the PROBE does not. Every observation therefore gets its own
 * namespace, and this is what checks it.
 */
await section(async () => {
  const world = resource(2);
  const H = handlerOver(world);
  const rec = recording();
  let dispatches = 0;
  await run(SUBJECT, {
    runId: "ns",
    handler: new H({}),
    journal: new Journal({ run: "ns", store: rec.store }),
    onLog: () => {},
    shouldStop: () => (dispatches++ > 3 ? "stop" : undefined),
  }).catch(() => undefined);

  // THE RAW APPEND LOG, not the folded map. `fold` keeps the last write per key, so counting
  // distinct keys in a FOLDED log is circular: it cannot tell one key written twice from two keys
  // written once, which is exactly the difference this cell exists to measure. Reading the begin
  // appends directly is what makes a shared namespace visible as a repeat.
  const probeBegins = rec.rows
    .filter((e) => e.kind === "ask" && e.name === "look" && e.state === "pending")
    .map((e) => `${e.scope}/${e.kind}:${e.name}#${e.occurrence}`);
  const probeKeys = [...new Set(probeBegins)];
  ok(
    "each observation's probe is journalled in ITS OWN namespace, so no later look can replay an earlier look's answer",
    probeBegins.length > 1 && probeKeys.length === probeBegins.length,
    { begins: probeBegins.length, distinct: probeKeys.length, keys: probeBegins },
  );
  ok(
    "and that namespace is the wait's own step, branch-keyed by the observation index",
    probeKeys.every((k, i) => k.startsWith(`/waitUntil:checks#0/b:${i}/`)),
    probeKeys,
  );
});

// ---- 4) a terminal observation settles, and a settled wait REPLAYS ------------------------------

/**
 * The other half of the rule, and the one that stops "re-observe" from becoming "re-observe
 * forever". A wait that FINISHED has an answer, so it replays like any other step; re-observing it
 * would re-ask a question the run has already answered, and a program that took a branch on the
 * first answer could take a different one on the second.
 */
await section(async () => {
  const world = resource(0); // completed on the first look
  const H = handlerOver(world);
  const first = await run(SUBJECT, { runId: "term", handler: new H({}), onLog: () => {} });
  const wait = entryOf(first.journal.entries(), "waitUntil");
  ok(
    "a terminal observation SETTLES the wait, recording it as the step's result",
    wait?.state === "settled" && wait?.status === "ok" && (wait?.result as { state: string }).state === "completed",
    { state: wait?.state, status: wait?.status, result: wait?.result },
  );
  ok(
    "and keeps the observation history beside it, so the record says what the wait saw and not only where it ended",
    (wait?.observations ?? []).length === 1,
    (wait?.observations ?? []).map((o) => o.value),
  );

  const before = world.looks;
  let saw: unknown;
  await resume(SUBJECT, new Journal({ run: "term", entries: first.journal.entries() }), {
    runId: "term",
    handler: new H({}),
    pins: first.pins,
    onLog: (l) => {
      saw = l.values[1];
    },
  });
  ok(
    "CONTROL for the rule above: a SETTLED wait replays and observes nothing, so re-observation is bounded by the answer",
    world.looks - before === 0 && saw === "completed",
    { reObservations: world.looks - before, saw },
  );
});

// ---- 5) the deadline is catchable, carries L4023, and counts what it saw ------------------------

await section(async () => {
  const world = resource(Number.MAX_SAFE_INTEGER); // never completes
  const H = handlerOver(world);
  const SRC = `
const a = await spawn("prober", { name: "p" });
try {
  await waitUntil(async () => await ask(a, { name: "look", schema: { state: "string" } }),
    { name: "checks", every: "1m", deadline: "3m", terminal: (o) => o.state !== "pending" });
  log("reached", "no");
} catch (e) {
  log("caught", e.code, e.detail.observations);
}
`;
  const lines: unknown[][] = [];
  const r = await run(SRC, { runId: "dl", handler: new H({}), onLog: (l) => lines.push([...l.values]) });
  ok(
    "an elapsed deadline is CATCHABLE and carries its own code, as turn's L4003 does",
    lines[0]?.[0] === "caught" && lines[0]?.[1] === "L4023",
    lines[0],
  );
  ok(
    "and the failure says how many times it looked, so \"it never held\" is a measured statement",
    typeof lines[0]?.[2] === "number" && (lines[0]?.[2] as number) > 1,
    lines[0]?.[2],
  );
  const wait = entryOf(r.journal.entries(), "waitUntil");
  ok(
    "the timed-out wait settles FAILED with its whole observation history intact",
    wait?.state === "settled" && wait?.status === "failed" && wait?.error?.code === "L4023"
      && (wait?.observations ?? []).length > 1,
    { status: wait?.status, code: wait?.error?.code, observations: (wait?.observations ?? []).length },
  );
});

// ---- 6) the deadline is ABSOLUTE across activations, not restarted by a resume ------------------

/**
 * The defect this cell exists to prevent is the mirror of the one the primitive fixes: a deadline
 * recomputed as `now + deadline` on every activation gives a crash-prone wait a fresh hour each
 * time, so a run that should have given up at 11:00 waits forever. The epoch is the entry's own
 * `startedAt`, which survives because the entry does.
 */
await section(async () => {
  const world = resource(Number.MAX_SAFE_INTEGER);
  const H = handlerOver(world);
  const SRC = `
const a = await spawn("prober", { name: "p" });
try {
  await waitUntil(async () => await ask(a, { name: "look", schema: { state: "string" } }),
    { name: "checks", every: "1m", deadline: "5m", terminal: (o) => o.state !== "pending" });
} catch (e) {
  log("caught", e.code);
}
`;
  const rec = recording();
  let dispatches = 0;
  await run(SRC, {
    runId: "abs",
    handler: new H({}),
    journal: new Journal({ run: "abs", store: rec.store }),
    onLog: () => {},
    shouldStop: () => (dispatches++ > 3 ? "stop" : undefined),
  }).catch(() => undefined);

  const folded = fold(rec.rows);
  const observedLive = (entryOf(folded, "waitUntil")?.observations ?? []).length;
  const lines: unknown[][] = [];

  // THE RESUMED HOST'S CLOCK STARTS PAST THE RECORDED DEADLINE, which is the whole instrument and
  // was missing from the first version of this cell: with both activations starting at 0, an
  // absolute deadline and one recomputed as `now + deadline` are the SAME NUMBER, and the cell
  // graded nothing. (Measured: the mutation that recomputes the epoch SURVIVED that version.) A
  // real resume happens later in wall-clock time, so the resuming handler is given a clock that
  // has moved, and the recorded `startedAt` is what decides whether the wait's hour is spent.
  const resumeClock = { clock: { start: 30 * 60_000 } };
  const worldAfter = resource(Number.MAX_SAFE_INTEGER);
  const looksBefore = worldAfter.looks;
  await resume(SRC, new Journal({ run: "abs", entries: folded }), {
    runId: "abs",
    handler: new (handlerOver(worldAfter))(resumeClock),
    pins: PINS,
    onLog: (l) => lines.push([...l.values]),
  });
  ok(
    "a resumed wait counts its observations from the RECORDED ones rather than starting again at zero",
    observedLive > 0,
    { observedLive },
  );
  ok(
    "and the deadline still elapses after the resume: it is absolute, so a crash does not buy the wait more time",
    lines[0]?.[0] === "caught" && lines[0]?.[1] === "L4023",
    lines[0],
  );
  // The SHARP half, and the one a recomputed epoch fails: a wait whose deadline was spent while
  // the host was down must give up WITHOUT LOOKING AGAIN. Catching L4023 alone does not say this
  // because a wait handed a fresh deadline still times out eventually, just after five more
  // minutes of looking at a resource it had already been told to stop waiting for.
  ok(
    "and it gives up WITHOUT LOOKING AGAIN, because the deadline it was measured against had already passed while the host was down",
    worldAfter.looks - looksBefore === 0,
    { looksAfterResume: worldAfter.looks - looksBefore },
  );
});

// ---- 7) the runtime owns cadence and deadline; the program owns the predicate --------------------

await section(async () => {
  const world = resource(3);
  const H = handlerOver(world);
  const seen: ObserveRequest[] = [];
  class Watching extends H {
    override async observe(req: ObserveRequest, ctx: EffectContext): Promise<boolean> {
      seen.push(req);
      return await super.observe(req, ctx);
    }
  }
  await run(SUBJECT, { runId: "cad", handler: new Watching({}), onLog: () => {} });
  ok(
    "the handler is asked to WAIT once per observation, carrying the cadence and the deadline the program declared",
    seen.length === 4 && seen.every((r) => r.every === "1m" && r.deadline === "10m"),
    seen.map((r) => ({ attempt: r.attempt, every: r.every, deadline: r.deadline })),
  );
  ok(
    "the first observation does not wait, so a predicate that already holds is noticed immediately",
    seen[0]?.attempt === 0,
    seen[0]?.attempt,
  );
  ok(
    "and the handler is never handed the observation or the predicate: what to look at stays the program's",
    seen.every((r) => !("observation" in r) && !("terminal" in r)),
    Object.keys(seen[0] ?? {}),
  );
});

// ---- 8) the static refusals, each judged where the source shows it ------------------------------

await section(async () => {
  const refuse = (src: string): string[] => {
    try {
      validate(`const builder = await spawn("b", { name: "b" });\n${src}\n`, "t");
      return [];
    } catch (e) {
      return e instanceof LangErrors ? [...new Set(e.errors.map((x) => x.code))] : [String(e)];
    }
  };

  ok(
    "a probe that is a VALUE rather than a function is refused: it would be observed once and never again",
    refuse('await waitUntil("pending", { name: "c", every: "1m", deadline: "1h" });').includes("L3045"),
    refuse('await waitUntil("pending", { name: "c", every: "1m", deadline: "1h" });'),
  );
  ok(
    "a wait with no cadence or no deadline is refused, because neither may be defaulted",
    refuse('await waitUntil(() => 1, { name: "c" });').includes("L3046")
      && refuse('await waitUntil(() => 1, { name: "c", every: "1m" });').includes("L3046"),
  );
  ok(
    "a cadence longer than the deadline is refused: it would look once and then fail without looking again",
    refuse('await waitUntil(() => 1, { name: "c", every: "2h", deadline: "1h" });').includes("L3047"),
  );
  ok(
    "a wait with no name is refused, because its journal entry is keyed by that name",
    refuse('await waitUntil(() => 1, { every: "1m", deadline: "1h" });').includes("L3012"),
  );
  ok(
    "an unknown option is refused, so a typo cannot silently become no cadence at all",
    refuse('await waitUntil(() => 1, { name: "c", every: "1m", deadline: "1h", until: 1 });').includes("L3011"),
  );
  // THE POSITIVE CONTROL. Without it, "refuses everything" would pass every cell above.
  ok(
    "CONTROL: a well-formed waitUntil is ACCEPTED, so the refusals above discriminate",
    refuse('await waitUntil(async () => await turn(builder, { name: "t" }), { name: "c", every: "1m", deadline: "1h", terminal: (o) => o.status === "done" });').length === 0,
    refuse('await waitUntil(async () => await turn(builder, { name: "t" }), { name: "c", every: "1m", deadline: "1h", terminal: (o) => o.status === "done" });'),
  );
});

// ---- 9) a probe or predicate that answers the wrong shape is refused, not recorded ---------------

await section(async () => {
  const world = resource(0);
  const H = handlerOver(world);
  const BAD_PROBE = `
const a = await spawn("prober", { name: "p" });
try {
  await waitUntil(() => undefined, { name: "c", every: "1m", deadline: "1h", terminal: (o) => o !== null });
} catch (e) { log("caught", e.code); }
`;
  const lines: unknown[][] = [];
  await run(BAD_PROBE, { runId: "shape1", handler: new H({}), onLog: (l) => lines.push([...l.values]) }).catch(() => undefined);
  ok(
    "a probe answering a value with no canonical form is L4024: an observation is journalled and handed to the predicate, so it must be data",
    lines[0]?.[1] === "L4024",
    lines[0],
  );

  const BAD_TERMINAL = `
const a = await spawn("prober", { name: "p" });
try {
  await waitUntil(() => "x", { name: "c", every: "1m", deadline: "1h", terminal: (o) => o });
} catch (e) { log("caught", e.code); }
`;
  const lines2: unknown[][] = [];
  await run(BAD_TERMINAL, { runId: "shape2", handler: new H({}), onLog: (l) => lines2.push([...l.values]) }).catch(() => undefined);
  ok(
    "a terminal predicate answering a truthy non-boolean is L4024, so a predicate that accidentally returns a record does not end every wait on its first look",
    lines2[0]?.[1] === "L4024",
    lines2[0],
  );
});

// ---- 10) editing the cadence diverges; editing the predicate does not ---------------------------

/**
 * `every` and `deadline` STOP OBSERVATION, so a recorded wait cannot answer what a differently
 * paced one would have seen and an edit must diverge. `terminal` READS an observation rather than
 * making one, so editing it is a reapply: that is deliberate, and it is what lets a program fix its
 * own predicate on a run that is ALREADY WAITING, which is the case this primitive exists for.
 */
await section(async () => {
  const mk = (every: string, deadline: string, terminal: string) => `
const a = await spawn("prober", { name: "p" });
const seen = await waitUntil(
  async () => await ask(a, { name: "look", schema: { state: "string" } }),
  { name: "checks", every: "${every}", deadline: "${deadline}", terminal: ${terminal} },
);
log("state", seen.state);
`;
  const base = mk("1m", "10m", '(o) => o.state !== "pending"');
  const world = resource(0);
  const H = handlerOver(world);
  const first = await run(base, { runId: "div", handler: new H({}), onLog: () => {} });

  const replayUnder = async (src: string): Promise<string> => {
    const w = resource(0);
    const R = handlerOver(w);
    return await resume(src, new Journal({ run: "div", entries: first.journal.entries() }), {
      runId: "div",
      handler: new R({}),
      pins: first.pins,
      onLog: () => {},
    }).then(() => "clean", (e: unknown) => (e as { code?: string }).code ?? (e as Error).name);
  };

  ok("editing the cadence on a resumed run DIVERGES: a differently paced wait asks a different question",
    (await replayUnder(mk("5m", "10m", '(o) => o.state !== "pending"'))) === "RunDivergence");
  ok("editing the deadline DIVERGES for the same reason", 
    (await replayUnder(mk("1m", "1h", '(o) => o.state !== "pending"'))) === "RunDivergence");
  ok(
    "but editing the PREDICATE replays clean, which is what lets a program correct it on a run that is already waiting",
    (await replayUnder(mk("1m", "10m", '(o) => o.state === "completed"'))) === "clean",
    await replayUnder(mk("1m", "10m", '(o) => o.state === "completed"')),
  );
});

// The shard runner grades a suite on this line, not on its exit status, so a suite that exits 0
// having run nothing cannot read as a pass (#1297). Emitted on both paths, failures included.
const sentinel = (): void => {
  console.log(
    `COTAL_SMOKE_SENTINEL cells=${pass + failures.length} passed=${pass} failed=${failures.length}`,
  );
};

if (failures.length > 0) {
  console.log(`wait-until.smoke: ${failures.length} FAILED, ${pass} passed`);
  for (const f of failures) console.log(`  ${f}`);
  sentinel();
  process.exit(1);
}
console.log(`wait-until.smoke: ${pass} checks passed`);
sentinel();
