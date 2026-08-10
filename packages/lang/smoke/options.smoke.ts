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
import { run } from "../src/interpret.js";
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
  "conclave.channel": "conclave is not implemented in this interpreter and fails loud as L1000",
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
      src: 'await checkpoint("approve", "ok?", { schema: { ok: "boolean" }, timeout: "10m", onExpiry: "proceed", to: "david" });\n',
      method: "checkpoint",
    },
    wait: {
      src: 'const a = await spawn("p", { name: "a" });\nawait wait(replied(a), { name: "w", timeout: "1h" });\n',
      method: "wait",
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

// ---- 3) an unimplemented primitive fails loud rather than quietly ignoring its options -----------

{
  // `conclave` is declared, validated, and not implemented. That is a legitimate state for a
  // skeleton, but ONLY while it is loud: a primitive that parses and then does nothing is the
  // silent-drop defect at the level of a whole effect.
  let caught: unknown;
  try {
    await run(
      'const a = await spawn("a", { name: "a" });\nawait conclave([a], (ch) => turn(a, { name: "h" }), { name: "t", channel: "war-room" });\n',
      { runId: "o-c", handler: new SimHandler({ turns: { h: { status: "done", at: 0 } } }) },
    );
  } catch (e) {
    caught = e;
  }
  ok("conclave is refused at runtime, not ignored", (caught as { code?: string })?.code === "L1000", String(caught).slice(0, 80));
  ok("and the message names the primitive", String((caught as Error)?.message).includes("conclave"), String(caught).slice(0, 80));
}

console.log(`options.smoke: ${pass} checks passed`);
