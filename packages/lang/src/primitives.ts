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
  /**
   * Option keys folded into the input hash. Everything else only steered live execution.
   *
   * NORMATIVE AND EXECUTED. This was documentation for a while, and drifted: the interpreter grew
   * a projection per primitive and this table stayed at whatever it said on the day it was written,
   * so "align interpret to the table" was a change that would have reintroduced the very holes the
   * projections closed. `options.smoke` now edits each key on a resumed run and requires exactly
   * the keys listed here to raise L5001, which is what makes the table a claim rather than a note.
   */
  readonly hashedOptions: readonly string[];
  /**
   * Keys whose VALUE decides whether they are hashed: listed here with the values that put them
   * into the projection, absent from `hashedOptions` because they are not always in it.
   *
   * There is exactly one of these and it is the subtlest rule in the table. `onExpiry` chooses how
   * to READ a recorded expiry at `fail` and `proceed`, which is a reapply and must replay clean;
   * at `escalate` it MINTS A SECOND EFFECT, which is a different question being asked and must
   * diverge. Flattening that either way breaks something real: hash it always and editing `fail`
   * to `proceed` stops working, hash it never and switching an answered checkpoint to `escalate`
   * silently keeps the old answer.
   */
  readonly hashedValues?: Readonly<Record<string, readonly unknown[]>>;
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
    example: 'const builder = await spawn("builder", { worktree: "wt-1", join: [team] })',
  },
  turn: {
    kind: "turn",
    nameRequired: true,
    options: ["name", "deadline"],
    optionsAt: 1,
    hashedOptions: ["deadline"],
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
    hashedOptions: ["schema", "deadline", "attempts"],
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
    // `to` is unconditionally hashed because it cannot legally appear without `escalate` (L3044),
    // so wherever it exists it is addressing a mint. `onExpiry` is the conditional one.
    hashedOptions: ["schema", "timeout", "to"],
    hashedValues: { onExpiry: ["escalate"] },
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
    // The duration is the subject and it IS hashed: a resumed run reads elapsed time back through
    // the run clock, so editing 1h to 1m must diverge rather than silently keep the path the old
    // duration chose. This said `false` while the interpreter hashed it.
    hashesSubject: true,
    opensScope: false,
    signature: "sleep(duration, { name? }) -> null",
    doc: "A durable timer. A resumed run does not re-sleep an elapsed sleep; use fork to re-run from this step.",
    example: 'await sleep("30m")',
  },
  wait: {
    kind: "wait",
    nameRequired: false,
    options: ["name", "timeout"],
    optionsAt: 1,
    // A recorded null means "not within THIS timeout", never "never".
    hashedOptions: ["timeout"],
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
    example: 'await monitor(builder)\nconst d = await wait(down(builder), { name: "gone", timeout: "1h" })',
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

/**
 * Value names: identifiers that name a value rather than a function, and may not be shadowed.
 *
 * `undefined` is what a missing field, an out-of-range index, and a function without a `return`
 * produce, so a program has to be able to name it to test for it. It stays a value that cannot
 * cross an effect boundary (L3041): the journal records `null` for "no value", never `undefined`.
 */
export const VALUE_NAMES: readonly string[] = Object.freeze(["undefined"]);

/** Every name the program may reference without defining it, and may never shadow. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(PRIMITIVES),
  ...Object.keys(EVENT_CONSTRUCTORS),
  ...Object.keys(PURE_PRIMITIVES),
  ...BUILTINS,
  ...VALUE_NAMES,
  "any",
  "all",
]);

/**
 * Host globals a program might reach for out of habit, each rejected by name (L2012) with the
 * replacement this language offers, when it offers one. A name with no replacement carries the
 * generic fix.
 */
export const HOST_GLOBAL_HINTS: Readonly<Record<string, string>> = Object.freeze({
  Math: "Use `min`, `max`, `abs`, `floor`, `ceil`, `round`, `random()` and `randomInt(n)`.",
  JSON: "Use `json.parse(text)` and `json.stringify(value)`.",
  Object: "Use `keys`, `values`, `entries`, `has` and `merge`.",
  Array: "Write an array literal, or `range(n)`; `xs.length` and the array methods are available.",
  Number: "Use `parseNumber(text)`; arithmetic needs no conversion.",
  String: "Use a template literal: `${value}`.",
  Boolean: "Use `!!value`, or compare explicitly.",
  parseInt: "Use `floor(parseNumber(text))`.",
  parseFloat: "Use `parseNumber(text)`.",
  isNaN: "Use `parseNumber(text) !== parseNumber(text)`; a NaN cannot cross an effect boundary anyway.",
  isFinite: "Check the input before parsing it; an infinite number cannot cross an effect boundary.",
  Infinity: "There is no infinity here: it has no canonical form and cannot cross an effect boundary.",
  NaN: "There is no NaN value to name here: it has no canonical form and cannot cross an effect boundary.",
  Date: "Use `now()`, which reads the run clock, and `duration(text)` for spans.",
  Map: "Use a record: `{}` with `has`, `keys` and `entries`.",
  Set: "Use an array with `unique`, `contains` and `filter`.",
  Error: "Throw a record: `throw { code: \"my-error\", message: \"...\" }`.",
  console: "Use `log(...values)`.",
  setTimeout: "Use `sleep(duration)`.",
  setInterval: "Use a loop with `sleep(duration)` inside it.",
});

/** Host globals a program might reach for out of habit, each rejected by name (L2012). */
export const FORBIDDEN_GLOBALS: ReadonlySet<string> = new Set([
  ...Object.keys(HOST_GLOBAL_HINTS),
  "globalThis", "global", "window", "self", "process", "fetch",
  "RegExp", "Reflect", "Proxy", "Symbol", "WeakMap", "WeakSet", "WeakRef", "Function",
  "setImmediate", "queueMicrotask", "require", "module",
  "exports", "__dirname", "__filename", "Buffer", "crypto", "performance", "structuredClone",
  "eval", "arguments", "BigInt", "Intl", "Atomics", "SharedArrayBuffer", "ArrayBuffer",
  "DataView", "TextEncoder", "TextDecoder", "URL", "URLSearchParams", "AbortController",
  "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI", "escape", "unescape",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array",
  "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
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
