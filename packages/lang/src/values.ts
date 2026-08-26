/**
 * Values, freezing, and the tamed nondeterminism.
 *
 * Jessie asks the author to call `harden()` before a value may be aliased or escape. An explicit
 * call whose omission produces silent aliasing is the wrong shape for an author who is a language
 * model, so we do it for them: every value crossing an effect boundary, in either direction, is
 * deep-frozen by the interpreter. The rule the design states as "freeze on share" is therefore a
 * property of the runtime rather than a discipline anyone has to remember.
 */

import { createHash } from "node:crypto";
import type { ScopeFrame } from "./keys.js";
import { scopePathString } from "./keys.js";

/** Deep-freeze a value on its way across an effect boundary. Cycles are not reachable here: a
 *  value that crosses a boundary has to canonicalize, and a cycle does not. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  return value;
}

/**
 * The depth a container was born at: L2032's runtime half for VALUES.
 *
 * A binding carries the concurrent depth it was declared at ({@link Env.depth}), which is what
 * refuses `outer = 1` from inside a branch. A write through a member (`outer.a = 1`, `xs.push(x)`)
 * reaches the value the binding holds, and a value can arrive in a branch through any alias, so the
 * fact travels on the value itself: every array and record the program builds is stamped with the
 * depth of the frame that built it, and a member write from a deeper frame is refused. A container
 * born at the top level (depth 0) carries no stamp at all, so an unstamped container IS a depth-0
 * one by construction rather than by default. Frozen values need no stamp: a write to one is L2031
 * whatever depth it came from. The stamp is a symbol-keyed, non-enumerable property, which nothing
 * in the language can name (there are no symbols) and nothing that canonicalizes, freezes, spreads,
 * or enumerates ever sees.
 */
const BIRTH: unique symbol = Symbol("cotal-lang birth depth");

/** Stamp a freshly built container with the depth of the frame building it. Returns the container. */
export function born<T>(value: T, depth: number): T {
  if (depth > 0 && value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.defineProperty(value, BIRTH, { value: depth, enumerable: false, writable: false, configurable: false });
  }
  return value;
}

/** The depth a container was born at. */
export function birthDepth(value: object): number {
  const d = (value as Record<symbol, unknown>)[BIRTH];
  return typeof d === "number" ? d : 0;
}

/**
 * Define an OWN property, never a prototype. `obj[key] = value` with key `__proto__` sets the
 * prototype instead of a field, so every place the interpreter materializes a program-authored key
 * (record literals, member writes, rest patterns) goes through here.
 */
export function setOwn(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * A value refused at an effect boundary, and WHY: a function is its own refusal (L3042) and every
 * other shape without a canonical form is the same refusal (L3041), so the interpreter picks the
 * code from `why` rather than from the message.
 */
export class NotCrossable extends TypeError {
  constructor(
    readonly why: "function" | "undefined" | "non-finite" | "opaque",
    message: string,
  ) {
    super(message);
    this.name = "NotCrossable";
  }
}

/**
 * A log line is DATA for a human reading the trace, and on the ENGINE code never crosses to it: the
 * engine's log sink (src/engine/ctx.ts) refuses a function anywhere inside a logged value before the
 * line reaches any transport, naming the value and the path. Measured before the rule: the worker
 * thread died on the host's own DataCloneError, whose message carried the emitted module body verbatim.
 * The WALKER is deliberately untouched: it is the replay engine for every run recorded under language
 * version 1, and a v1 record whose program logs a builtin (`log(map)`) must replay as it was recorded
 * (a checked-in recording in journal.smoke holds that), so this is a rule of the engine, declared as a
 * divergence in the differential, not a change to v1. Everything else a program can build crosses to a
 * trace as it is - `undefined` and a non-finite number included, because the trace is not the journal
 * and a human wants to see them - so this is deliberately NOT `assertCrossable`. `seen` marks
 * everything visited: a second visit answers the same question, and a cycle terminates.
 */
export function assertNoCode(value: unknown, path: string, seen = new Set<object>()): void {
  if (typeof value === "function") {
    throw new NotCrossable(
      "function",
      `${path} is a function. A log line is data for a human reading the trace, and code does not cross to it; log what it computes instead`,
    );
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) assertNoCode(value[i], `${path}[${i}]`, seen);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) assertNoCode(v, `${path}.${k}`, seen);
}

/**
 * A value that cannot canonicalize cannot be journalled, and a value that cannot be journalled
 * cannot be replayed. Catching it at the boundary is strictly better than discovering it at
 * digest time, because here we still know which argument it was.
 */
export function assertCrossable(value: unknown, path = "value", seen?: Set<object>): void {
  if (value === null) return;
  switch (typeof value) {
    case "boolean":
    case "string":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new NotCrossable(
          "non-finite",
          `${path} is ${String(value)}, which has no canonical form and so cannot cross an effect boundary`,
        );
      }
      return;
    case "function":
      throw new NotCrossable(
        "function",
        `${path} is a function. Functions are not serializable, so they never cross an effect boundary; pass the data instead`,
      );
    case "undefined":
      throw new NotCrossable(
        "undefined",
        `${path} is undefined, which is not a value here. Use null when you mean "no value"`,
      );
    case "object": {
      // A CYCLE has no canonical form either, and before this set existed it was "checked" by the
      // host's stack overflowing — a raw RangeError in place of the refusal, measured. The set
      // tracks the path down, not everything visited, so a diamond (one sub-record referenced
      // twice) still crosses.
      const s = seen ?? new Set<object>();
      if (s.has(value)) {
        throw new NotCrossable("opaque", `${path} closes a cycle: the value contains itself, and a cycle has no canonical form`);
      }
      s.add(value);
      if (Array.isArray(value)) {
        // By index, not forEach: forEach SKIPS holes, which is how a sparse array crossed and
        // canonicalized its holes into silent nulls (measured).
        for (let i = 0; i < value.length; i += 1) {
          if (!(i in value)) {
            throw new NotCrossable(
              "opaque",
              `${path}[${i}] is a hole: this array is sparse, and a hole has no canonical form (canonicalizing would silently turn it into null)`,
            );
          }
          assertCrossable(value[i], `${path}[${i}]`, s);
        }
        s.delete(value);
        return;
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        throw new NotCrossable("opaque", `${path} is not plain data, so it has no canonical form`);
      }
      if (Object.prototype.hasOwnProperty.call(value, "__proto__")) {
        throw new NotCrossable(
          "opaque",
          `${path} carries an own "__proto__" field, which names an object's prototype and cannot be a field here`,
        );
      }
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        assertCrossable(v, `${path}.${k}`, s);
      }
      s.delete(value);
      return;
    }
    default:
      throw new NotCrossable("opaque", `${path} has no canonical form`);
  }
}

/**
 * The seeded PRNG.
 *
 * Derived per scope rather than as one stream over the run: `H(seed, scopePath, draw)`. A single
 * global counter would mean that inserting a draw anywhere shifts every later draw, so an
 * unrelated edit elsewhere in the program would change the randomness a given scope sees. Per
 * scope, an edit only disturbs the scope it is in, which is what makes randomness survive a
 * migration. Draws are never journalled: they are a pure function of journalled state.
 */
export class Prng {
  private readonly draws = new Map<string, number>();

  constructor(readonly seed: string) {}

  next(scope: readonly ScopeFrame[]): number {
    const path = scopePathString(scope);
    const n = this.draws.get(path) ?? 0;
    this.draws.set(path, n + 1);
    const h = createHash("sha256").update(`${this.seed}\u0000${path}\u0000${n}`, "utf8").digest();
    // 48 bits is the mantissa budget a double gives without rounding surprises.
    let v = 0;
    for (let i = 0; i < 6; i += 1) v = v * 256 + (h[i] ?? 0);
    return v / 2 ** 48;
  }
}

/**
 * The value rule over a SCOPE's settled value. The exemption it carries is ABSENCE, and it is
 * POSITIONAL, so it has to follow the scope's KIND rather than its shape.
 *
 * `parallel`, `fanOut` and `race` settle an INTERPRETER ASSEMBLY: a record or array of branch
 * values, or `{ index, value }` for a race. A branch whose last line is a statement produced no
 * value, which is legal and ordinary, so `undefined` in a branch SLOT is absence rather than a value
 * that failed the rule. That is the exemption, and it is exactly one level deep, where the assembly
 * puts branch outcomes. A branch that returns `{ x: undefined }` is refused exactly as an effect
 * result carrying the same record is: that `undefined` is a field the PROGRAM wrote.
 *
 * `conclave` HAS NO ASSEMBLY. Its settled value is the body's own value, so level one is already the
 * program's own record fields, and giving them the slot exemption hands it to exactly the values it
 * was never meant to cover. Measured, on the rule's first version: a conclave body returning
 * `{ x: e.missing }` completed, the durable store wrote the field away as `{}` with nothing raised,
 * and a replay handed the program `keys(r) == []` where the live run had `["x"]`. The same silent
 * false replay the rule exists to stop, with `undefined` in the place of a function. So a conclave
 * exempts only a body that produced NO VALUE AT ALL, and everything inside a value it did produce
 * answers to the effect door's rule.
 *
 * UNKNOWN KINDS TAKE THE STRICTER READING, because a kind this function has not been taught about
 * is one nobody has decided the shape of, and the wrong default there is the silent one.
 *
 * It lives here rather than beside either caller because BOTH doors need the same rule: the write
 * fence in `perform.ts` and the load scan in `journal.ts`. Two copies of a rule this positional is
 * how the two ends stop agreeing.
 */
const ASSEMBLING_SCOPES: ReadonlySet<string> = new Set(["parallel", "race", "fanOut"]);

export function assertScopeValueCrossable(value: unknown, where: string, scopeKind: string): void {
  if (value === undefined) return;
  if (!ASSEMBLING_SCOPES.has(scopeKind)) {
    assertCrossable(value, where);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((el, i) => {
      if (el !== undefined) assertCrossable(el, `${where}[${i}]`);
    });
    return;
  }
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [k, el] of Object.entries(value as Record<string, unknown>)) {
      if (el !== undefined) assertCrossable(el, `${where}.${k}`);
    }
    return;
  }
  assertCrossable(value, where);
}
