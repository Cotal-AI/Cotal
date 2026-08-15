/**
 * Every option the validator accepts must reach the handler.
 *
 * This suite exists because six did not, and nothing anywhere would have said so. `spawn` accepted
 * `permits`, `supervise` and `onFork` and forwarded none of them: an author who wrote a turn budget
 * got a clean parse, a clean run, and no budget. `ask` accepted `deadline` and `attempts` and
 * forwarded neither. `checkpoint` accepted `to`, which decides WHICH PERSON gets asked, and
 * forwarded it nowhere.
 *
 * The shape of the failure is worth naming, because it is not a bug in any one function. There were
 * two lists of option names, one in the validator and one written out again at each dispatch site,
 * and nothing compared them. Every individual site looked complete. The defect lives in the gap
 * between two correct-looking lists, which is exactly the kind a reviewer reads past.
 *
 * So this does not re-read the dispatch code. It RUNS a program that passes every accepted option
 * and asserts the option arrived in the request the handler was actually given. A static scan was
 * tried first and produced two false positives, because it looked only inside the `case` blocks of
 * the primitive switch and `fanOut`'s `key` is read in the scope-combinator path instead. Reading
 * the code found the gap in the wrong places; running it finds the gap where it is.
 */
import { run, resume, RunDivergence } from "../src/interpret.js";
import { PRIMITIVES } from "../src/primitives.js";
import { SimHandler } from "../src/sim.js";
import type { EffectContext, EffectHandler } from "../src/effects.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ok ${name}`);
};

/** Capture the request object handed to each handler method, then delegate. */
const capturing = (inner: EffectHandler): { handler: EffectHandler; seen: Map<string, unknown[]> } => {
  const seen = new Map<string, unknown[]>();
  const wrap = <A extends { [k: string]: unknown }, R>(
    name: string,
    fn: (req: A, ctx: EffectContext) => Promise<R>,
  ) => {
    return async (req: A, ctx: EffectContext): Promise<R> => {
      const list = seen.get(name) ?? [];
      list.push(req);
      seen.set(name, list);
      return await fn.call(inner, req, ctx);
    };
  };
  const handler = {
    now: () => inner.now(),
    spawn: wrap("spawn", inner.spawn),
    turn: wrap("turn", inner.turn),
    ask: wrap("ask", inner.ask),
    checkpoint: wrap("checkpoint", inner.checkpoint),
    sleep: wrap("sleep", inner.sleep),
    wait: wrap("wait", inner.wait),
    notify: wrap("notify", inner.notify),
    monitor: wrap("monitor", inner.monitor),
    openConclave: wrap("openConclave", inner.openConclave),
    closeConclave: wrap("closeConclave", inner.closeConclave),
  } as unknown as EffectHandler;
  return { handler, seen };
};

/**
 * `name` never reaches a handler by design: it is the STEP name, consumed by the interpreter to
 * build the journal key, and a handler has no business seeing it. `schema` reaches `ask` and
 * `checkpoint` as a request field. `key` and `channel` on the combinators are interpreter-level.
 *
 * Exemptions are listed with their reason rather than filtered silently, so that a future option
 * added to this list has to be argued rather than slipped in.
 */
const NOT_A_HANDLER_FIELD: Readonly<Record<string, string>> = {
  "*.name": "the step name builds the journal key; the handler never sees it",
  "parallel.name": "combinator scope name, interpreter-level",
  "race.name": "combinator scope name, interpreter-level",
  "fanOut.name": "combinator scope name, interpreter-level",
  "fanOut.key": "maps an item to its branch key, evaluated by the interpreter before any dispatch",
  "conclave.name": "combinator scope name, interpreter-level",
};

// ---- 1) the capture instrument sees what it claims to see ---------------------------------------

{
  const sim = new SimHandler({ turns: { probe: { status: "done", at: 0 } } });
  const { handler, seen } = capturing(sim);
  await run('const a = await spawn("p", { name: "a", role: "r" });\nawait turn(a, { name: "probe", deadline: "5m" });\n', {
    runId: "o-0",
    handler,
  });
  ok("the capture sees a spawn request", (seen.get("spawn") ?? []).length === 1, seen.get("spawn"));
  ok("and the fields on it", (seen.get("spawn")?.[0] as { role?: string })?.role === "r");
  // The control: an option the interpreter does NOT forward must be visibly absent, or a green
  // below would mean the instrument cannot tell forwarded from dropped.
  const t = seen.get("turn")?.[0] as Record<string, unknown>;
  ok("and it can tell present from absent", t?.deadline === "5m" && t?.name === undefined, t);
}

// ---- 2) every accepted option reaches the handler ------------------------------------------------

{
  // One program per primitive, passing every option the validator accepts.
  const CASES: Readonly<Record<string, { src: string; method: string }>> = {
    spawn: {
      src: 'const t = channel("c");\nconst a = await spawn("p", { name: "a", worktree: "wt-1", join: [t], role: "r", permits: { turns: 3 }, supervise: { restart: "on-fail" }, onFork: "adopt" });\n',
      method: "spawn",
    },
    turn: {
      src: 'const a = await spawn("p", { name: "a" });\nawait turn(a, { name: "go", deadline: "5m" });\n',
      method: "turn",
    },
    ask: {
      src: 'const a = await spawn("p", { name: "a" });\nawait ask(a, { name: "q", schema: { days: "number" }, deadline: "5m", attempts: 2 });\n',
      method: "ask",
    },
    checkpoint: {
      // `to` only addresses an escalated mint (L3044), so the fixture that exercises every
      // accepted option has to escalate. The validator refused this fixture the moment that rule
      // landed, which is the audit catching its own test data rather than the other way round.
      src: 'await checkpoint("approve", "ok?", { schema: { ok: "boolean" }, timeout: "10m", onExpiry: "escalate", to: "david" });\n',
      method: "checkpoint",
    },
    wait: {
      src: 'const a = await spawn("p", { name: "a" });\nawait wait(replied(a), { name: "w", timeout: "1h" });\n',
      method: "wait",
    },
    // `conclave` is a scope, so its request is built on the scope path rather than in `callEffect`.
    // That is a second place an option can be dropped, and until this case existed nothing walked it.
    conclave: {
      src: 'const a = await spawn("p", { name: "a" });\nawait conclave([a], (ch) => turn(a, { name: "go" }), { name: "t", channel: "war-room" });\n',
      method: "openConclave",
    },
  };

  const script = {
    turns: { go: { status: "done", at: 0 } },
    asks: { q: { days: 3 } },
    checkpoints: { approve: { status: "resolved", value: true, by: "sim" } },
    events: { w: [null] },
  } as const;

  const dropped: string[] = [];
  let checkedOptions = 0;
  for (const [prim, { src, method }] of Object.entries(CASES)) {
    const spec = PRIMITIVES[prim as keyof typeof PRIMITIVES] as { options: readonly string[] };
    const { handler, seen } = capturing(new SimHandler(script));
    await run(src, { runId: `o-${prim}`, handler });
    const req = (seen.get(method) ?? [])[0] as Record<string, unknown> | undefined;
    if (req === undefined) {
      dropped.push(`${prim}: handler.${method} was never called`);
      continue;
    }
    for (const opt of spec.options) {
      if (opt === "name" || NOT_A_HANDLER_FIELD[`${prim}.${opt}`] !== undefined) continue;
      checkedOptions += 1;
      if (req[opt] === undefined) dropped.push(`${prim}.${opt}`);
    }
  }

  ok("the audit actually examined options", checkedOptions >= 12, checkedOptions);
  ok("no accepted option is silently dropped on its way to the handler", dropped.length === 0, dropped);
}

// ---- 3) every declared primitive is actually implemented ----------------------------------------

{
  // This section used to assert the opposite: `conclave` was declared, validated, and threw L1000,
  // and the cell certified that the skeleton was at least LOUD about it. It is implemented now, so
  // the claim worth holding is the one the catalog makes — a primitive that parses runs — and the
  // check that catches a regression is that no primitive reaches the interpreter's L1000 default.
  const { handler, seen } = capturing(new SimHandler({ turns: { h: { status: "done", at: 0 } } }));
  const r = await run(
    'const a = await spawn("a", { name: "a" });\nawait conclave([a], (ch) => turn(a, { name: "h" }), { name: "t", channel: "war-room" });\n',
    { runId: "o-c", handler },
  );
  ok("conclave opens its channel through the handler", (seen.get("openConclave") ?? []).length === 1);
  ok("and closes it", (seen.get("closeConclave") ?? []).length === 1);
  ok("and the body's own effect ran inside it", (seen.get("turn") ?? []).length === 1);
  ok(
    "and the scope is journalled under its own kind, so a migrate can ask whether it closed",
    r.journal.entries().some((e) => e.kind === "conclave" && e.status === "ok"),
    r.journal.entries().map((e) => `${e.kind}:${e.status ?? e.state}`),
  );
}

// ---- 4) the OBJECT form of spawn, which this suite did not exercise until it had to ------------

/**
 * `spawn` takes a persona name OR a record carrying the persona with its model and variant. This
 * suite tested only the string form, so it certified "no accepted option is silently dropped" while
 * the object form dropped `model` and `variant` from both the request and the input hash. Editing a
 * model did not diverge, and the handler was never told which model to run.
 *
 * The audit was not wrong about what it measured. It measured one of the two call forms, and
 * reported the answer as if it covered the primitive. An instrument's universe is a choice, and
 * this one was mine.
 */
{
  const capture: Record<string, unknown>[] = [];
  const spy = (inner: EffectHandler): EffectHandler =>
    ({
      ...inner,
      now: () => inner.now(),
      spawn: async (req: Record<string, unknown>, ctx: EffectContext) => {
        capture.push(req);
        return (inner as unknown as { spawn: (r: unknown, c: EffectContext) => Promise<unknown> }).spawn(req, ctx);
      },
    }) as unknown as EffectHandler;

  const src = (model: string) =>
    `await spawn({ persona: "worker", model: "${model}", variant: "v1" }, { name: "worker" });\n`;
  const a = await run(src("m1"), { runId: "o-obj", handler: spy(new SimHandler({})) });
  const b = await run(src("m2"), { runId: "o-obj", handler: spy(new SimHandler({})) });

  const req = capture[0] as { model?: string; variant?: string };
  ok("the object form forwards the model", req?.model === "m1", req);
  ok("and the variant", req?.variant === "v1", req);

  // The identity half: model and variant are hashed with the persona, so swapping a model is a
  // different agent and a resumed run must not replay a fact recorded about the other one.
  const ha = a.journal.entries()[0]?.inputHash;
  const hb = b.journal.entries()[0]?.inputHash;
  ok("and swapping the model changes the input hash", ha !== hb, { ha, hb });
}

// ---- 5) the hash table is a claim, not a comment ------------------------------------------------

/**
 * `hashedOptions` decides, for every option, whether editing it on a resumed run diverges or
 * replays. That is the difference between a run that notices you changed the question and one that
 * hands you an old answer to a new one, and it was DOCUMENTATION: the interpreter grew a projection
 * per primitive, the table stayed at whatever it said the day it was written, and the two disagreed
 * on four primitives at once. `checkpoint` was fixed in isolation while `wait.timeout`,
 * `turn.deadline` and `ask.attempts|deadline` still replayed clean under an edit; `sleep` hashed its
 * subject while the table said it did not.
 *
 * The gap is not "someone forgot". It is that a second copy of a rule with no test between them
 * decays, and this one decayed in the direction where nothing fails: a stale table makes the NEXT
 * person's "align the code to the table" a regression that looks like tidying.
 *
 * So the table is executed. Each option is edited on a real resume and the run must diverge exactly
 * when the table says the option is hashed. The controls matter as much as the positives: `permits`,
 * `supervise`, `onFork` and `fail`↔`proceed` must replay CLEAN, or "diverge on everything" would
 * pass this suite while destroying every legitimate migration.
 */
{
  const spec = (prim: string) =>
    PRIMITIVES[prim as keyof typeof PRIMITIVES] as unknown as {
      hashedOptions: readonly string[];
      hashedValues?: Readonly<Record<string, readonly unknown[]>>;
    };

  /**
   * What the TABLE predicts, derived rather than restated. An option is hashed outright, or it is
   * hashed for particular values and an edit that touches one of those crosses the boundary.
   */
  const tableSaysHashed = (prim: string, opt: string, a: unknown, b: unknown): boolean => {
    const s = spec(prim);
    if (s.hashedOptions.includes(opt)) return true;
    const values = s.hashedValues?.[opt];
    return values !== undefined && (values.includes(a) || values.includes(b));
  };

  interface Probe {
    readonly prim: string;
    readonly opt: string;
    /** The value on each side of the edit, for the table lookup. */
    readonly a: unknown;
    readonly b: unknown;
    /** The whole option bag on each side, because some options are only legal beside others. */
    readonly bagA: string;
    readonly bagB: string;
  }

  const SPAWN = (bag: string) => `const t = channel("t");\nconst u = channel("u");\nawait spawn("p", { ${bag} });\n`;
  const TURN = (bag: string) => `const a = await spawn("p", { name: "a" });\nawait turn(a, { ${bag} });\n`;
  const ASK = (bag: string) => `const a = await spawn("p", { name: "a" });\nawait ask(a, { ${bag} });\n`;
  const CP = (bag: string) => `await checkpoint("gate", "ok?", { ${bag} });\n`;
  const WAIT = (bag: string) => `const a = await spawn("p", { name: "a" });\nawait wait(replied(a), { ${bag} });\n`;

  const SOURCE: Readonly<Record<string, (bag: string) => string>> = {
    spawn: SPAWN, turn: TURN, ask: ASK, checkpoint: CP, wait: WAIT,
  };

  const PROBES: readonly Probe[] = [
    // spawn: identity is hashed, policy is not. `permits` is a budget and `supervise` a restart
    // rule; both decide how a recorded fact is ACTED ON, so they are reapplied from current source.
    { prim: "spawn", opt: "worktree", a: "wt-1", b: "wt-2", bagA: 'name: "a", worktree: "wt-1"', bagB: 'name: "a", worktree: "wt-2"' },
    { prim: "spawn", opt: "join", a: "t", b: "u", bagA: 'name: "a", join: [t]', bagB: 'name: "a", join: [u]' },
    { prim: "spawn", opt: "role", a: "r1", b: "r2", bagA: 'name: "a", role: "r1"', bagB: 'name: "a", role: "r2"' },
    { prim: "spawn", opt: "permits", a: 3, b: 9, bagA: 'name: "a", permits: { turns: 3 }', bagB: 'name: "a", permits: { turns: 9 }' },
    { prim: "spawn", opt: "supervise", a: "never", b: "on-fail", bagA: 'name: "a", supervise: { restart: "never" }', bagB: 'name: "a", supervise: { restart: "on-fail" }' },
    { prim: "spawn", opt: "onFork", a: "respawn", b: "adopt", bagA: 'name: "a", onFork: "respawn"', bagB: 'name: "a", onFork: "adopt"' },

    // The three siblings the checkpoint fix left behind. Each one STOPS OBSERVATION: the recorded
    // result answers "within this cutoff", and a longer cutoff is a different question.
    { prim: "turn", opt: "deadline", a: "1m", b: "10m", bagA: 'name: "go", deadline: "1m"', bagB: 'name: "go", deadline: "10m"' },
    { prim: "ask", opt: "deadline", a: "1m", b: "10m", bagA: 'name: "q", schema: { days: "number" }, deadline: "1m"', bagB: 'name: "q", schema: { days: "number" }, deadline: "10m"' },
    { prim: "ask", opt: "attempts", a: 1, b: 5, bagA: 'name: "q", schema: { days: "number" }, attempts: 1', bagB: 'name: "q", schema: { days: "number" }, attempts: 5' },
    { prim: "ask", opt: "schema", a: "days", b: "weeks", bagA: 'name: "q", schema: { days: "number" }', bagB: 'name: "q", schema: { weeks: "number" }' },
    { prim: "wait", opt: "timeout", a: "1m", b: "10m", bagA: 'name: "w", timeout: "1m"', bagB: 'name: "w", timeout: "10m"' },

    { prim: "checkpoint", opt: "schema", a: "ok", b: "fine", bagA: 'schema: { ok: "boolean" }', bagB: 'schema: { fine: "boolean" }' },
    { prim: "checkpoint", opt: "timeout", a: "1m", b: "10m", bagA: 'timeout: "1m"', bagB: 'timeout: "10m"' },
    // The conditional rule, both ways round. Reading an expiry differently is a reapply; minting a
    // second checkpoint is a new effect.
    { prim: "checkpoint", opt: "onExpiry", a: "fail", b: "proceed", bagA: 'timeout: "1m", onExpiry: "fail"', bagB: 'timeout: "1m", onExpiry: "proceed"' },
    { prim: "checkpoint", opt: "onExpiry", a: "proceed", b: "escalate", bagA: 'timeout: "1m", onExpiry: "proceed"', bagB: 'timeout: "1m", onExpiry: "escalate", to: "david"' },
    { prim: "checkpoint", opt: "to", a: "david", b: "sam", bagA: 'timeout: "1m", onExpiry: "escalate", to: "david"', bagB: 'timeout: "1m", onExpiry: "escalate", to: "sam"' },
  ];

  const script = {
    turns: { go: { status: "done", at: 0 } },
    asks: { q: { days: 3 } },
    // Resolved on the first mint, so no probe accidentally depends on an escalation hop.
    checkpoints: { gate: { status: "resolved", value: true, by: "sim" } },
    events: { w: ["hello"] },
    clock: { start: 0 },
  } as const;

  let audited = 0;
  let hashedSeen = 0;
  let cleanSeen = 0;
  const wrong: string[] = [];

  for (const p of PROBES) {
    const src = SOURCE[p.prim] as (bag: string) => string;
    const runId = `o-h-${p.prim}-${p.opt}-${String(p.b)}`;
    const live = await run(src(p.bagA), { runId, handler: new SimHandler(script) });

    let diverged: unknown;
    try {
      await resume(src(p.bagB), live.journal, { runId, handler: new SimHandler(script) });
    } catch (e) {
      diverged = e;
    }

    const predicted = tableSaysHashed(p.prim, p.opt, p.a, p.b);
    const actual = diverged instanceof RunDivergence;
    audited += 1;
    if (predicted) hashedSeen += 1;
    else cleanSeen += 1;
    if (predicted !== actual) {
      wrong.push(
        `${p.prim}.${p.opt} ${JSON.stringify(p.a)}->${JSON.stringify(p.b)}: table says ${predicted ? "hashed" : "reapplied"}, run ${actual ? "diverged" : "replayed clean"}`,
      );
    } else if (diverged !== undefined && !actual) {
      wrong.push(`${p.prim}.${p.opt}: resume threw something other than divergence - ${String(diverged).slice(0, 80)}`);
    }
  }

  // A count, because a loop that audits nothing prints the same green as one that audits everything.
  ok("the hash audit ran every probe", audited === PROBES.length && audited >= 16, audited);
  // Both halves present: an interpreter that diverged on EVERY edit would satisfy the positives
  // while breaking every reapply, and one that never diverged would satisfy the controls.
  ok("with both hashed options and reapplied ones under test", hashedSeen >= 10 && cleanSeen >= 4, { hashedSeen, cleanSeen });
  ok("the interpreter's projection matches the table on every option", wrong.length === 0, wrong);
}

console.log(`options.smoke: ${pass} checks passed`);
