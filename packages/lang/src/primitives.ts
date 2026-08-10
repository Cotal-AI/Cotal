/**
 * The effect primitives and the builtins, as data.
 *
 * One table drives four things that must never disagree: the validator's call-shape checks, the
 * error catalog's callee documentation, the interpreter's dispatch, and the derived flowchart's
 * node kinds. Keeping them in one place is why an unknown option key can answer with a full
 * signature instead of a shrug.
 */

import type { CalleeDoc } from "./errors.js";

/** The journalled effect kinds. `channel` is pure and deliberately absent. */
export const EFFECT_KINDS = [
  "spawn",
  "turn",
  "ask",
  "checkpoint",
  "sleep",
  "wait",
  "notify",
  "monitor",
  "conclave",
] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

/** Which of a call's inputs decide whether a recorded result is still valid (design doc 5.12). */
export interface PrimitiveSpec extends CalleeDoc {
  /** The effect kind journalled, or null for a pure primitive that writes no entry. */
  readonly kind: EffectKind | null;
  /** A step name is required, not merely allowed. */
  readonly nameRequired: boolean;
  /** Every accepted option key. Bags are closed: anything else is L3011. */
  readonly options: readonly string[];
  /** The argument index the option bag occupies. Fixed per primitive, never "the last record":
   *  `notify(agents, fact, opts)` and `checkpoint(name, prompt, opts)` both take a record in an
   *  earlier position, and treating that as options would reject perfectly good data. */
  readonly optionsAt: number;
  /** Option keys folded into the input hash. Everything else only steered live execution. */
  readonly hashedOptions: readonly string[];
  /** True when the positional subject is part of the input hash. */
  readonly hashesSubject: boolean;
  /** This primitive opens a concurrency scope, so it pushes a scope frame. */
  readonly opensScope: boolean;
}

export const PRIMITIVES: Readonly<Record<string, PrimitiveSpec>> = Object.freeze({
  spawn: {
    kind: "spawn",
    nameRequired: false,
    options: ["name", "worktree", "join", "role", "permits", "supervise", "onFork"],
    optionsAt: 1,
    hashedOptions: ["worktree", "join", "role"],
    hashesSubject: true,
    opensScope: false,
    signature:
      "spawn(persona, { name?, worktree?, join?, role?, permits?, supervise?, onFork? }) -> AgentHandle",
    doc: "Bring an agent into the run. Permits are budgets whose violation is catchable; supervise is a declarative restart policy.",
    example: 'const builder = spawn("builder", { worktree: "wt-1", join: [team] })',
  },
  turn: {
    kind: "turn",
    nameRequired: true,
    options: ["name", "deadline"],
    optionsAt: 1,
    hashedOptions: [],
    hashesSubject: true,
    opensScope: false,
    signature: "turn(agent, { name, deadline? }) -> { status, to?, note?, at }",
    doc: "Wake an agent for one turn. It reads its own channels and speaks for itself; the result is its yield status, one of done, blocked, or handoff.",
    example:
      'const r = await turn(builder, { name: "build" })\nif (r.status === "blocked") { await turn(planner, { name: "unblock" }) }',
  },
  ask: {
    kind: "ask",
    nameRequired: true,
    options: ["name", "schema", "deadline", "attempts"],
    optionsAt: 1,
    hashedOptions: ["schema"],
    hashesSubject: true,
    opensScope: false,
    signature: "ask(agent, { name, schema, deadline?, attempts? }) -> record",
    doc: "The narrow case where the program itself needs a value. The agent publishes a record, the program awaits it, and the record is schema-checked.",
    example:
      'const est = await ask(planner, { name: "estimate", schema: { days: "number" } })',
  },
  checkpoint: {
    kind: "checkpoint",
    nameRequired: true,
    options: ["schema", "timeout", "onExpiry", "to"],
    optionsAt: 2,
    hashedOptions: ["schema"],
    hashesSubject: true,
    opensScope: false,
    signature:
      'checkpoint(name, prompt, { schema?, timeout?, onExpiry?, to? }) -> { status, value?, by?, at, artifact? }',
    doc: "A durable pause a human or another agent resolves from anywhere, raced against a durable timer. onExpiry is fail, proceed, or escalate.",
    example:
      'const ok = await checkpoint("approve-plan", "Approve the plan?", { timeout: "10m", onExpiry: "proceed" })',
  },
  sleep: {
    kind: "sleep",
    nameRequired: false,
    options: ["name"],
    optionsAt: 1,
    hashedOptions: [],
    hashesSubject: false,
    opensScope: false,
    signature: "sleep(duration, { name? }) -> null",
    doc: "A durable timer. A resumed run does not re-sleep an elapsed sleep; rename the step to force a fresh wait.",
    example: 'await sleep("30m")',
  },
  wait: {
    kind: "wait",
    nameRequired: false,
    options: ["name", "timeout"],
    optionsAt: 1,
    hashedOptions: [],
    hashesSubject: true,
    opensScope: false,
    signature: "wait(event, { name?, timeout? }) -> value | null",
    doc: "Await one event. Resolves null on timeout rather than throwing, which is what makes ?? the recovery operator.",
    example:
      'const m = await wait(message(team, { from: builder }), { name: "await-build", timeout: "20m" })\n           ?? await turn(planner, { name: "chase" })',
  },
  notify: {
    kind: "notify",
    nameRequired: false,
    options: ["name"],
    optionsAt: 2,
    hashedOptions: [],
    hashesSubject: true,
    opensScope: false,
    signature: "notify(agents, fact, { name? }) -> null",
    doc: "Tell agents about a branch decision. It writes a notice onto the run, rendered ahead of each agent's next turn; it is never a channel message.",
    example:
      'await notify([planner], { decision: "build", outcome: "blocked" })',
  },
  monitor: {
    kind: "monitor",
    nameRequired: false,
    options: ["name"],
    optionsAt: 1,
    hashedOptions: [],
    hashesSubject: true,
    opensScope: false,
    signature: "monitor(agent, { name? }) -> null",
    doc: "Register interest in an agent's health, after which down(agent) is an ordinary awaitable event a concurrent branch can watch.",
    example: 'monitor(builder)\nconst d = await wait(down(builder), { timeout: "1h" })',
  },
  parallel: {
    kind: null,
    nameRequired: false,
    options: ["name"],
    optionsAt: 1,
    hashedOptions: [],
    hashesSubject: false,
    opensScope: true,
    signature: "parallel(branches, { name? }) -> results",
    doc: "Run branches concurrently and settle all of them. The record form is the default; array branches are keyed by index and are linted. The first rejection cancels the rest.",
    example:
      'await parallel({ lint: () => turn(linter, { name: "lint" }),\n                 tests: () => turn(tester, { name: "tests" }) }, { name: "checks" })',
  },
  race: {
    kind: null,
    nameRequired: false,
    options: ["name"],
    optionsAt: 1,
    hashedOptions: [],
    hashesSubject: false,
    opensScope: true,
    signature: "race(branches, { name? }) -> { index, value }",
    doc: "Run branches concurrently and take the first to settle. Losers are cancelled by semantics: they perform no new effects, and an in-flight agent reply completes and is ignored.",
    example:
      'await race({ reply: () => wait(replied(builder), { timeout: "20m" }),\n             giveUp: () => sleep("1h") }, { name: "await-or-move-on" })',
  },
  fanOut: {
    kind: null,
    nameRequired: true,
    options: ["name", "key"],
    optionsAt: 2,
    hashedOptions: [],
    hashesSubject: false,
    opensScope: true,
    signature: "fanOut(items, fn, { name, key? }) -> results",
    doc: "Run fn(item, index) per item concurrently. key maps an item to the stable string that names its journal namespace, and defaults to a record item's string id.",
    example:
      'await fanOut(["security", "perf"], (lens) => turn(reviewers[lens], { name: "review" }),\n             { name: "reviews", key: (lens) => lens })',
  },
  conclave: {
    kind: "conclave",
    nameRequired: true,
    options: ["name", "channel"],
    optionsAt: 2,
    hashedOptions: [],
    hashesSubject: true,
    opensScope: true,
    signature: "conclave(members, fn, { name, channel? }) -> result",
    doc: "Open a scoped sub-team: create a conclave channel, join the members, run fn with that channel, then have them leave. It scopes the derived flowchart the same way it scopes the journal.",
    example:
      'await conclave([a, b], (ch) => turn(a, { name: "huddle" }), { name: "triage" })',
  },
});

/** Event constructors. Pure: they build a descriptor and perform no effect. */
export const EVENT_CONSTRUCTORS: Readonly<Record<string, CalleeDoc>> = Object.freeze({
  replied: {
    signature: "replied(agent) -> Event",
    doc: "The agent finished a reply.",
    example: 'await wait(replied(builder), { timeout: "20m" })',
  },
  message: {
    signature: "message(channel, { from?, matches? }) -> Event",
    doc: "A message landed on the channel, optionally filtered by sender or content match.",
    example: 'await wait(message(team, { from: builder }), { timeout: "20m" })',
  },
  idle: {
    signature: "idle(channel, duration) -> Event",
    doc: "The channel went quiet for the duration.",
    example: 'await wait(idle(team, "10m"), { timeout: "1h" })',
  },
  down: {
    signature: "down(agent) -> Event",
    doc: "A monitored agent died. Carries the reason.",
    example: 'const d = await wait(down(builder), { timeout: "1h" })',
  },
});

/** Pure primitives that write no journal entry. */
export const PURE_PRIMITIVES: Readonly<Record<string, CalleeDoc>> = Object.freeze({
  channel: {
    signature: "channel(name) -> ChannelHandle",
    doc: "Name a channel. Pure: a name is a name, and membership is what costs something.",
    example: 'const team = channel("feat-auth")',
  },
  run: {
    signature: "run() -> { id, programHash, startedAt }",
    doc: "This run's own metadata.",
    example: "const id = run().id",
  },
});

/** The builtin library. Small on purpose (design doc 4). */
export const BUILTINS: readonly string[] = Object.freeze([
  // records
  "keys", "values", "entries", "has", "merge",
  // arrays
  "len", "map", "filter", "find", "some", "every", "sort", "slice", "concat", "join",
  "reverse", "unique", "range", "sum",
  // strings
  "split", "trim", "lower", "upper", "startsWith", "endsWith", "contains", "replace",
  // numbers
  "min", "max", "abs", "floor", "ceil", "round", "parseNumber",
  // data and control
  "json", "assert", "log",
  // tamed nondeterminism
  "random", "randomInt", "pick", "now", "duration",
]);

/** Every name the program may reference without defining it, and may never shadow. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(PRIMITIVES),
  ...Object.keys(EVENT_CONSTRUCTORS),
  ...Object.keys(PURE_PRIMITIVES),
  ...BUILTINS,
  "any",
  "all",
]);

/** Host globals a program might reach for out of habit, each rejected by name (L2012). */
export const FORBIDDEN_GLOBALS: ReadonlySet<string> = new Set([
  "globalThis", "global", "window", "self", "process", "console", "fetch", "Date", "Math",
  "RegExp", "Object", "Reflect", "Proxy", "Symbol", "WeakMap", "WeakSet", "Function",
  "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "require", "module",
  "exports", "__dirname", "__filename", "Buffer", "crypto", "performance", "structuredClone",
]);

/** The Promise API, rejected separately so its error can point at the right replacement (L2011). */
export const PROMISE_NAMES: ReadonlySet<string> = new Set(["Promise"]);

/** Step names: kebab-case, 1 to 64 characters. */
export const STEP_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * The bound on a `notify` fact.
 *
 * `notify` is the only primitive that moves program-authored bytes toward an agent's context, so
 * an unconstrained field here would be scripted payloads through the side door and the first
 * non-negotiable would hold everywhere except the one place it is easiest to break. Eight short
 * scalars rendered as a labelled table is not enough room to write an instruction, which is the
 * property we want.
 */
export const NOTIFY_BOUND = Object.freeze({
  /** `decision` and `outcome` are tokens, not prose. */
  tokenRe: STEP_NAME_RE,
  detailKeyRe: /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/,
  maxDetailKeys: 8,
  maxDetailStringLength: 128,
});

export function primitiveDoc(name: string): CalleeDoc | undefined {
  return PRIMITIVES[name] ?? EVENT_CONSTRUCTORS[name] ?? PURE_PRIMITIVES[name];
}
