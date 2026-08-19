/**
 * The library: the free builtins (design doc §4) and the curated methods on arrays, strings and
 * numbers, as one table each.
 *
 * Nothing here is reached by name resolution on a host object. A member access on a string, an
 * array or a number resolves against these tables and nowhere else, so `xs.map` is the entry in
 * {@link ARRAY_METHODS} and never `Array.prototype.map`, and a name that is not in the table is a
 * refusal (L4014) rather than a host function called with the wrong calling convention. Every
 * method here has the meaning JavaScript gives it; the language adds nothing and takes nothing away
 * inside this table, which is what lets `semantics.smoke` run the same programs on node and here.
 *
 * Callbacks are AWAITED. A method that takes a function (`map`, `filter`, `find`, ...) calls it one
 * element at a time and awaits each call, because a function here may perform an effect. For a pure
 * callback that is exactly JavaScript; for one that performs effects it is the sequential order the
 * source reads in, and a program that wants concurrency says so with `parallel` or `fanOut`.
 *
 * Mutators are in the table too ({@link MUTATING_METHODS}), because a fresh local array is a value
 * the program owns until it shares it: `out.push(x)` inside a loop is the shape every author writes.
 * Each mutator asks the interpreter whether the receiver may be written (frozen values and values
 * born outside a concurrent branch may not), so freeze-on-share holds for method writes exactly as
 * for member writes.
 */

import { canonicalize } from "json-canonicalize";
import { RuntimeFault } from "./errors.js";
import { parseDuration } from "./duration.js";
import type { ScopeFrame } from "./keys.js";
import { scopePathString } from "./keys.js";
import { NotCrossable, Prng, assertCrossable, assertNoCode, born, deepFreeze } from "./values.js";

/** What the library needs of the interpreter's frame. `Frame` in interpret.ts satisfies it. */
export interface LibFrame {
  readonly depth: number;
  readonly keys: { readonly path: readonly ScopeFrame[] };
  readonly clock: { now(): number };
}

/** A function value as the interpreter calls it: user closures and builtins share this shape. */
export type Callable = (frame: LibFrame, args: unknown[]) => Promise<unknown>;

/** What the builtins read from the run. */
export interface LibraryContext {
  readonly runId: string;
  readonly programHash: string;
  readonly startedAt: number;
  readonly prng: Prng;
  readonly onLog?: (line: { scope: string; values: readonly unknown[] }) => void;
  /** Refuse a write to `target` from `frame`, or return normally. Owned by the interpreter. */
  assertWritable(target: object, frame: LibFrame): void;
}

// ---- host errors --------------------------------------------------------------------------------

/**
 * A builtin or a method given inputs the host refuses (`"a".repeat(-1)`, `json.parse("{")`) raises
 * a host error. It leaves as a language fault that names the builtin, never as the host's own
 * class: a program can `catch` a record with a code, and an interpreter fault carrying a host stack
 * would put a frame from this file in front of the author.
 */
function guarded<T extends unknown[]>(name: string, impl: (...args: T) => unknown): (...args: T) => Promise<unknown> {
  return async (...args: T): Promise<unknown> => {
    try {
      return await impl(...args);
    } catch (e) {
      if (e instanceof TypeError || e instanceof RangeError || e instanceof SyntaxError) {
        throw new RuntimeFault("L4016", `${name}: ${e.message}`);
      }
      throw e;
    }
  };
}

const asCallable = (v: unknown, where: string): Callable => {
  if (typeof v !== "function") throw new RuntimeFault("L4011", `${where} needs a function, and this value is not one`);
  return v as Callable;
};

/**
 * The operators' no-implicit-conversion law (L4018, reference §4.5) applied at the library
 * boundary: where a primitive is expected, a record, array or function is refused BEFORE the host
 * can coerce it. Host coercion reads `valueOf`/`toString` off the value, and a program closure
 * stored there runs without a Frame (measured before the gate: `parseNumber({ valueOf: () => 99 })`
 * logged null, the run settled ok — a journal could have recorded the wrong value — and the
 * closure's Frame-less rejection killed the process AFTER the run returned; `Math.abs({})` was a
 * silent NaN; `sum([{ valueOf: () => 9 }])` answered the string "0[object Object]").
 */
const noCoerce = (name: string, v: unknown): void => {
  if (v !== null && (typeof v === "object" || typeof v === "function")) {
    const kind = typeof v === "function" ? "a function" : Array.isArray(v) ? "an array" : "a record";
    throw new RuntimeFault(
      "L4018",
      `${name} cannot take ${kind} in this argument: there is no implicit conversion here, because converting would read \`valueOf\`/\`toString\` off the value — host machinery this language does not have. Convert explicitly: \`json.stringify(value)\` for text, or pass the primitive you mean.`,
    );
  }
};

/**
 * Which argument positions of a callable legitimately take a container or a function. STRICT BY
 * DEFAULT: a position not named here refuses a container or function with L4018, so a callable
 * added without a declaration fails safe and loud in its own cell — the hazard class (silent host
 * coercion) cannot re-enter through a forgotten entry.
 */
type Takes = "all" | { readonly any?: readonly number[]; readonly restFrom?: number } | undefined;

const gateArgs = (name: string, args: readonly unknown[], takes: Takes): void => {
  if (takes === "all") return;
  const any = takes?.any ?? [];
  const restFrom = takes?.restFrom ?? Number.POSITIVE_INFINITY;
  args.forEach((v, i) => {
    if (i < restFrom && !any.includes(i)) noCoerce(name, v);
  });
};

/** Wrap a method-shaped impl with the argument gate. */
const gate = <R,>(
  k: string,
  impl: (frame: LibFrame, r: R, args: unknown[]) => unknown,
  takes?: Takes,
): ((frame: LibFrame, r: R, args: unknown[]) => unknown) =>
  (frame, r, args) => {
    gateArgs(k, args, takes);
    return impl(frame, r, args);
  };

// ---- the total order `sort` uses ----------------------------------------------------------------

/**
 * A TOTAL order over the language's values (design §3.4.3): kinds rank first (undefined, null,
 * false, true, numbers, strings, arrays, records, everything else), numbers by value with NaN
 * after every number, strings by code unit, containers by canonical form. The shipped comparator
 * was not total (measured): NaN answered "equal" to every number because both `<` and `>` are
 * false, so `sort([1, NaN, 0])` returned an unsorted list, and `undefined` — whose canonical form
 * is not a string — compared "equal" to everything too, so `[undefined, null]` kept whatever order
 * it arrived in. What is left equal here is identical (or canonically indistinguishable), and a
 * stable sort keeps its order.
 */
function rankOf(v: unknown): number {
  if (v === undefined) return 0;
  if (v === null) return 1;
  if (typeof v === "boolean") return v ? 3 : 2;
  if (typeof v === "number") return 4;
  if (typeof v === "string") return 5;
  if (Array.isArray(v)) return 6;
  if (typeof v === "object") return 7;
  return 8;
}

function compareTotal(a: unknown, b: unknown): number {
  const ra = rankOf(a);
  const rb = rankOf(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : 1;
    if (Number.isNaN(b)) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (ra < 4) return 0; // same rank among undefined/null/false/true means identical
  const ca = safeCanonical(a);
  const cb = safeCanonical(b);
  return ca < cb ? -1 : ca > cb ? 1 : 0;
}

/** The canonical form where one exists; a stable, deterministic stand-in where it does not. */
function safeCanonical(v: unknown): string {
  try {
    const c = canonicalize(v) as unknown;
    if (typeof c === "string") return c;
  } catch {
    // fall through
  }
  return `\uFFFF${String(v)}`;
}

// ---- methods ---------------------------------------------------------------------------------------

export type Method = (frame: LibFrame, receiver: never, args: unknown[]) => unknown;

/** Methods that write to their receiver. The static L2032 walk and the runtime write check read this. */
export const MUTATING_METHODS: ReadonlySet<string> = new Set(["push", "pop", "shift", "unshift", "splice"]);

/** The array methods, JavaScript's meaning, callbacks awaited. */
export function arrayMethods(ctx: LibraryContext): Readonly<Record<string, Method>> {
  const write = (xs: unknown[], frame: LibFrame): void => ctx.assertWritable(xs, frame);
  const table: Record<string, (frame: LibFrame, xs: unknown[], args: unknown[]) => unknown> = {
    // pure, callback-taking (each callback awaited in order)
    // Every callback-taking method captures the length BEFORE the first call, as JavaScript
    // captures it: an element the callback appends is not visited (measured before the fix: a
    // `push` inside `map` grew the walk and the result).
    map: async (frame, xs, a) => {
      const f = asCallable(a[0], "map");
      const out: unknown[] = [];
      const len = xs.length;
      for (let i = 0; i < len; i += 1) out.push(await f(frame, [xs[i], i, xs]));
      return born(out, frame.depth);
    },
    filter: async (frame, xs, a) => {
      const f = asCallable(a[0], "filter");
      const out: unknown[] = [];
      const len = xs.length;
      for (let i = 0; i < len; i += 1) if (await f(frame, [xs[i], i, xs])) out.push(xs[i]);
      return born(out, frame.depth);
    },
    find: async (frame, xs, a) => {
      const f = asCallable(a[0], "find");
      const len = xs.length;
      for (let i = 0; i < len; i += 1) if (await f(frame, [xs[i], i, xs])) return xs[i];
      return undefined;
    },
    findIndex: async (frame, xs, a) => {
      const f = asCallable(a[0], "findIndex");
      const len = xs.length;
      for (let i = 0; i < len; i += 1) if (await f(frame, [xs[i], i, xs])) return i;
      return -1;
    },
    findLast: async (frame, xs, a) => {
      const f = asCallable(a[0], "findLast");
      for (let i = xs.length - 1; i >= 0; i -= 1) if (await f(frame, [xs[i], i, xs])) return xs[i];
      return undefined;
    },
    findLastIndex: async (frame, xs, a) => {
      const f = asCallable(a[0], "findLastIndex");
      for (let i = xs.length - 1; i >= 0; i -= 1) if (await f(frame, [xs[i], i, xs])) return i;
      return -1;
    },
    some: async (frame, xs, a) => {
      const f = asCallable(a[0], "some");
      const len = xs.length;
      for (let i = 0; i < len; i += 1) if (await f(frame, [xs[i], i, xs])) return true;
      return false;
    },
    every: async (frame, xs, a) => {
      const f = asCallable(a[0], "every");
      const len = xs.length;
      for (let i = 0; i < len; i += 1) if (!(await f(frame, [xs[i], i, xs]))) return false;
      return true;
    },
    forEach: async (frame, xs, a) => {
      const f = asCallable(a[0], "forEach");
      const len = xs.length;
      for (let i = 0; i < len; i += 1) await f(frame, [xs[i], i, xs]);
      return undefined;
    },
    reduce: async (frame, xs, a) => {
      const f = asCallable(a[0], "reduce");
      let i = 0;
      let acc: unknown;
      if (a.length >= 2) acc = a[1];
      else {
        if (xs.length === 0) throw new RuntimeFault("L4016", "reduce: Reduce of empty array with no initial value");
        acc = xs[0];
        i = 1;
      }
      const len = xs.length;
      for (; i < len; i += 1) acc = await f(frame, [acc, xs[i], i, xs]);
      return acc;
    },
    flatMap: async (frame, xs, a) => {
      const f = asCallable(a[0], "flatMap");
      const out: unknown[] = [];
      const len = xs.length;
      for (let i = 0; i < len; i += 1) {
        const r = await f(frame, [xs[i], i, xs]);
        if (Array.isArray(r)) out.push(...r);
        else out.push(r);
      }
      return born(out, frame.depth);
    },
    // pure, no callback
    includes: (_f, xs, a) => xs.includes(a[0]),
    indexOf: (_f, xs, a) => xs.indexOf(a[0], a[1] as number | undefined),
    lastIndexOf: (_f, xs, a) => (a.length >= 2 ? xs.lastIndexOf(a[0], a[1] as number) : xs.lastIndexOf(a[0])),
    slice: (frame, xs, a) => born(xs.slice(a[0] as number | undefined, a[1] as number | undefined), frame.depth),
    concat: (frame, xs, a) => born(xs.concat(...a), frame.depth),
    join: (_f, xs, a) => {
      for (const el of xs) noCoerce("join", el);
      return xs.join(a[0] as string | undefined);
    },
    flat: (frame, xs, a) => born(xs.flat(a[0] as number | undefined), frame.depth),
    at: (_f, xs, a) => xs.at(a[0] as number),
    toReversed: (frame, xs) => born([...xs].reverse(), frame.depth),
    // mutators
    push: (frame, xs, a) => {
      write(xs, frame);
      return xs.push(...a);
    },
    pop: (frame, xs) => {
      write(xs, frame);
      return xs.pop();
    },
    shift: (frame, xs) => {
      write(xs, frame);
      return xs.shift();
    },
    unshift: (frame, xs, a) => {
      write(xs, frame);
      return xs.unshift(...a);
    },
    splice: (frame, xs, a) => {
      write(xs, frame);
      const removed = a.length >= 2 ? xs.splice(a[0] as number, a[1] as number, ...a.slice(2)) : xs.splice(a[0] as number);
      return born(removed, frame.depth);
    },
  };
  const TAKES: Record<string, Takes> = {
    map: { any: [0] }, filter: { any: [0] }, find: { any: [0] }, findIndex: { any: [0] },
    findLast: { any: [0] }, findLastIndex: { any: [0] }, some: { any: [0] }, every: { any: [0] },
    forEach: { any: [0] }, flatMap: { any: [0] },
    reduce: { any: [0, 1] },
    includes: { any: [0] }, indexOf: { any: [0] }, lastIndexOf: { any: [0] },
    concat: "all", push: "all", unshift: "all",
    splice: { restFrom: 2 },
  };
  return Object.freeze(
    Object.fromEntries(Object.entries(table).map(([k, impl]) => [k, guarded(k, gate(k, impl, TAKES[k])) as unknown as Method])),
  );
}

/** The string methods, JavaScript's meaning. Patterns are strings: there are no regular expressions. */
export function stringMethods(): Readonly<Record<string, Method>> {
  const str = (name: string, v: unknown): string => {
    if (typeof v !== "string") throw new RuntimeFault("L4016", `${name}: the pattern must be a string (there are no regular expressions here)`);
    return v;
  };
  const table: Record<string, (frame: LibFrame, s: string, args: unknown[]) => unknown> = {
    trim: (_f, s) => s.trim(),
    trimStart: (_f, s) => s.trimStart(),
    trimEnd: (_f, s) => s.trimEnd(),
    toLowerCase: (_f, s) => s.toLowerCase(),
    toUpperCase: (_f, s) => s.toUpperCase(),
    startsWith: (_f, s, a) => s.startsWith(str("startsWith", a[0]), a[1] as number | undefined),
    endsWith: (_f, s, a) => s.endsWith(str("endsWith", a[0]), a[1] as number | undefined),
    includes: (_f, s, a) => s.includes(str("includes", a[0]), a[1] as number | undefined),
    indexOf: (_f, s, a) => s.indexOf(str("indexOf", a[0]), a[1] as number | undefined),
    lastIndexOf: (_f, s, a) => (a.length >= 2 ? s.lastIndexOf(str("lastIndexOf", a[0]), a[1] as number) : s.lastIndexOf(str("lastIndexOf", a[0]))),
    slice: (_f, s, a) => s.slice(a[0] as number | undefined, a[1] as number | undefined),
    substring: (_f, s, a) => s.substring(a[0] as number, a[1] as number | undefined),
    split: (frame, s, a) => born(a.length === 0 ? [s] : s.split(str("split", a[0]), a[1] as number | undefined), frame.depth),
    // The replacement string means what JavaScript says it means, `$$`/`$&`/`$\``/`$'` included
    // (measured before the fix: the function form made every `$` literal, a meaning JavaScript
    // gives neither method).
    replace: (_f, s, a) => s.replace(str("replace", a[0]), String(a[1])),
    replaceAll: (_f, s, a) => s.replaceAll(str("replaceAll", a[0]), String(a[1])),
    repeat: (_f, s, a) => s.repeat(a[0] as number),
    padStart: (_f, s, a) => s.padStart(a[0] as number, a[1] as string | undefined),
    padEnd: (_f, s, a) => s.padEnd(a[0] as number, a[1] as string | undefined),
    at: (_f, s, a) => s.at(a[0] as number),
    charAt: (_f, s, a) => s.charAt(a[0] as number),
    concat: (_f, s, a) => s.concat(...a.map(String)),
  };
  return Object.freeze(
    Object.fromEntries(Object.entries(table).map(([k, impl]) => [k, guarded(k, gate(k, impl)) as unknown as Method])),
  );
}

/** The number methods, JavaScript's meaning. */
export function numberMethods(): Readonly<Record<string, Method>> {
  const table: Record<string, (frame: LibFrame, n: number, args: unknown[]) => unknown> = {
    toFixed: (_f, n, a) => n.toFixed(a[0] as number | undefined),
    toString: (_f: LibFrame, n: number, a: unknown[]) => n.toString(a[0] as number | undefined),
    toPrecision: (_f, n, a) => n.toPrecision(a[0] as number | undefined),
  };
  return Object.freeze(
    Object.fromEntries(Object.entries(table).map(([k, impl]) => [k, guarded(k, gate(k, impl)) as unknown as Method])),
  );
}

// ---- builtins ------------------------------------------------------------------------------------------

/**
 * The free builtins, as `[name, callable]` pairs in the order design §4 lists them. The interpreter
 * declares each as an immutable binding; `surface.smoke` holds this list to `BUILTINS` in
 * `primitives.ts` so a name the validator resolves is always a name the interpreter defines.
 */
export function builtins(ctx: LibraryContext): readonly (readonly [string, unknown])[] {
  const fn = (name: string, impl: (frame: LibFrame, args: unknown[]) => unknown, takes?: Takes): Callable =>
    guarded(name, (frame: LibFrame, args: unknown[]) => {
      gateArgs(name, args, takes);
      return impl(frame, args);
    });
  const higher =
    (name: string, impl: (frame: LibFrame, list: unknown[], f: Callable) => Promise<unknown>): Callable =>
    guarded(name, async (frame: LibFrame, args: unknown[]) => await impl(frame, args[0] as unknown[], asCallable(args[1], name)));

  const json = deepFreeze({
    parse: fn("json.parse", (frame, a) => {
      // Every container the text describes is born here, in this frame — and checked: JSON can
      // spell an OWN field named `__proto__`, which the literal refuses statically (L1028) and
      // the member write refuses dynamically (L4014), so a parse that minted one was a bypass
      // around both (measured before the check).
      const stamp = (v: unknown): unknown => {
        if (v !== null && typeof v === "object") {
          if (!Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, "__proto__")) {
            throw new RuntimeFault(
              "L4016",
              'json.parse: the text carries a "__proto__" key, which names an object\'s prototype and cannot be a field here, exactly as it cannot in a literal',
            );
          }
          for (const inner of Object.values(v as Record<string, unknown>)) stamp(inner);
          born(v, frame.depth);
        }
        return v;
      };
      return stamp(JSON.parse(a[0] as string));
    }),
    // Canonical form (RFC 8785): the same text the journal hashes, so a program that stringifies a
    // value writes what the run record would — and REFUSES what the journal would refuse. The
    // unchecked call silently dropped undefined members, turned undefined elements and NaN into
    // null (measured), which is information loss wearing the canonical name.
    stringify: fn("json.stringify", (_f, a) => {
      try {
        assertCrossable(a[0], "json.stringify: the value");
      } catch (e) {
        if (e instanceof NotCrossable) throw new RuntimeFault("L4016", e.message);
        throw e;
      }
      return canonicalize(a[0]);
    }, { any: [0] }),
  });

  return [
    // records
    ["keys", fn("keys", (frame, a) => born(Object.keys(a[0] as object), frame.depth), { any: [0] })],
    ["values", fn("values", (frame, a) => born(Object.values(a[0] as object), frame.depth), { any: [0] })],
    ["entries", fn("entries", (frame, a) => born(Object.entries(a[0] as object).map((e) => born(e, frame.depth)), frame.depth), { any: [0] })],
    ["has", fn("has", (_f, a) => Object.prototype.hasOwnProperty.call(a[0] as object, a[1] as string), { any: [0] })],
    ["merge", fn("merge", (frame, a) => born({ ...(a[0] as object), ...(a[1] as object) }, frame.depth), { any: [0, 1] })],
    // arrays
    ["len", fn("len", (_f, a) => (a[0] as { length: number }).length, { any: [0] })],
    [
      "map",
      higher("map", async (frame, list, f) => {
        const out: unknown[] = [];
        for (let i = 0; i < list.length; i += 1) out.push(await f(frame, [list[i], i]));
        return born(out, frame.depth);
      }),
    ],
    [
      "filter",
      higher("filter", async (frame, list, f) => {
        const out: unknown[] = [];
        for (let i = 0; i < list.length; i += 1) if (await f(frame, [list[i], i])) out.push(list[i]);
        return born(out, frame.depth);
      }),
    ],
    [
      "find",
      higher("find", async (frame, list, f) => {
        for (let i = 0; i < list.length; i += 1) if (await f(frame, [list[i], i])) return list[i];
        return null;
      }),
    ],
    [
      "some",
      higher("some", async (frame, list, f) => {
        for (let i = 0; i < list.length; i += 1) if (await f(frame, [list[i], i])) return true;
        return false;
      }),
    ],
    [
      "every",
      higher("every", async (frame, list, f) => {
        for (let i = 0; i < list.length; i += 1) if (!(await f(frame, [list[i], i]))) return false;
        return true;
      }),
    ],
    [
      "sort",
      fn("sort", async (frame, a) => {
        const list = a[0] as unknown[];
        const keyFn = a[1] === undefined ? undefined : asCallable(a[1], "sort");
        const keyed: { key: unknown; value: unknown; at: number }[] = [];
        for (let i = 0; i < list.length; i += 1) {
          keyed.push({ key: keyFn === undefined ? list[i] : await keyFn(frame, [list[i], i]), value: list[i], at: i });
        }
        keyed.sort((x, y) => compareTotal(x.key, y.key) || compareTotal(x.value, y.value) || x.at - y.at);
        return born(
          keyed.map((k) => k.value),
          frame.depth,
        );
      }, { any: [0, 1] }),
    ],
    ["slice", fn("slice", (frame, a) => born((a[0] as unknown[]).slice(a[1] as number, a[2] as number | undefined), frame.depth), { any: [0] })],
    ["concat", fn("concat", (frame, a) => born((a[0] as unknown[]).concat(a[1] as unknown[]), frame.depth), { any: [0, 1] })],
    ["join", fn("join", (_f, a) => {
      for (const el of a[0] as unknown[]) noCoerce("join", el);
      return (a[0] as unknown[]).join(a[1] as string);
    }, { any: [0] })],
    ["reverse", fn("reverse", (frame, a) => born([...(a[0] as unknown[])].reverse(), frame.depth), { any: [0] })],
    ["unique", fn("unique", (frame, a) => born([...new Set(a[0] as unknown[])], frame.depth), { any: [0] })],
    ["range", fn("range", (frame, a) => born(Array.from({ length: a[0] as number }, (_, i) => i), frame.depth))],
    ["sum", fn("sum", (_f, a) => {
      for (const el of a[0] as unknown[]) noCoerce("sum", el);
      return (a[0] as number[]).reduce((x, y) => x + y, 0);
    }, { any: [0] })],
    // strings
    ["split", fn("split", (frame, a) => born((a[0] as string).split(a[1] as string), frame.depth))],
    ["trim", fn("trim", (_f, a) => (a[0] as string).trim())],
    ["lower", fn("lower", (_f, a) => (a[0] as string).toLowerCase())],
    ["upper", fn("upper", (_f, a) => (a[0] as string).toUpperCase())],
    ["startsWith", fn("startsWith", (_f, a) => (a[0] as string).startsWith(a[1] as string))],
    ["endsWith", fn("endsWith", (_f, a) => (a[0] as string).endsWith(a[1] as string))],
    ["contains", fn("contains", (_f, a) => (a[0] as string).includes(a[1] as string))],
    ["replace", fn("replace", (_f, a) => (a[0] as string).split(a[1] as string).join(a[2] as string))],
    // numbers
    ["min", fn("min", (_f, a) => Math.min(...(a as number[])))],
    ["max", fn("max", (_f, a) => Math.max(...(a as number[])))],
    ["abs", fn("abs", (_f, a) => Math.abs(a[0] as number))],
    ["floor", fn("floor", (_f, a) => Math.floor(a[0] as number))],
    ["ceil", fn("ceil", (_f, a) => Math.ceil(a[0] as number))],
    ["round", fn("round", (_f, a) => Math.round(a[0] as number))],
    ["parseNumber", fn("parseNumber", (_f, a) => Number(a[0] as string))],
    // data and control
    ["json", json],
    [
      "assert",
      fn("assert", (_f, a) => {
        if (!a[0]) throw new RuntimeFault("L4012", String(a[1] ?? "assertion failed"));
        return null;
      }, { any: [0] }),
    ],
    [
      "log",
      fn("log", (frame, a) => {
        // A log line is data, and this is the ONE place the rule is held: both engines log through
        // here, so no transport (a host callback, a worker thread) ever sees code. Refused as the
        // builtin refuses (L4016 naming the value and the path), the way json.stringify does.
        a.forEach((v, i) => {
          try {
            assertNoCode(v, `log: value ${i + 1}`);
          } catch (e) {
            if (e instanceof NotCrossable) throw new RuntimeFault("L4016", e.message);
            throw e;
          }
        });
        ctx.onLog?.({ scope: scopePathString(frame.keys.path), values: a });
        return null;
      }, "all"),
    ],
    // tamed nondeterminism. `now()` reads the branch's own run clock, which is the maximum endedAt
    // over the effects this point actually awaited: time advances at effect boundaries as a
    // property of the design rather than a rule anyone has to follow.
    ["random", fn("random", (frame) => ctx.prng.next(frame.keys.path))],
    ["randomInt", fn("randomInt", (frame, a) => Math.floor(ctx.prng.next(frame.keys.path) * (a[0] as number)))],
    [
      "pick",
      fn("pick", (frame, a) => {
        const list = a[0] as unknown[];
        return list[Math.floor(ctx.prng.next(frame.keys.path) * list.length)];
      }, { any: [0] }),
    ],
    ["now", fn("now", (frame) => frame.clock.now())],
    ["duration", fn("duration", (_f, a) => parseDuration(a[0] as string))],
  ];
}
