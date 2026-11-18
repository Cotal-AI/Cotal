/**
 * The most one value a program builds may hold, and the refusal past it.
 *
 * A run's engine thread has a fixed heap limit. Node ends a thread that reaches it, and the run
 * fails cleanly, but only while the heap grows in steps the collector can see coming. One
 * allocation of tens of megabytes made close to the limit can end the whole process instead of the
 * thread. These bounds keep every value a builtin, a method, a spread, a template or `+` produces
 * small enough that reaching the limit by building them, however many, ends in the clean failure.
 * Measured on node 24 with the engine's limits: a fresh array of 2,000,000 elements and a string of
 * 16,000,000 two-byte units never ended the process; 3,000,000 elements and 24,000,000 units did.
 * The bounds sit at half of the clean sizes, and a case mapping, which can triple a string, stays
 * under them too.
 *
 * An array is bounded by its element count and a string by its length in UTF-16 units. Both are
 * checked before the host builds the value wherever the size is known in advance, and on the built
 * value otherwise.
 */

import { RuntimeFault } from "./errors.js";

/**
 * The heap limits every run's engine thread is created with.
 *
 * Without them a thread inherits the host process's own heap limit, so one program could grow until
 * the whole process ran out of memory. With them a thread that reaches its limit is ended by node,
 * its run fails naming the limit, and the process carries on. Everything the run holds counts: the
 * program's values and every journal entry the run has recorded so far.
 */
export const ENGINE_HEAP_LIMITS = Object.freeze({ maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32 });

/**
 * The largest heap limit, in MB, a thread created with {@link ENGINE_HEAP_LIMITS} may report and still run.
 *
 * A V8 heap flag on the process (`--max-old-space-size`, `--max-semi-space-size` and the like, on the
 * command line or in `NODE_OPTIONS`) replaces the limits a thread is created with, for every thread.
 * Measured on node 24: 560 MB with no flag, 515 MB under the daemon's `--max-semi-space-size=1`, 304 MB
 * under `--max-old-space-size=256`, and 4144 MB under `--max-old-space-size=4096`. A tighter limit
 * still holds a run, so only a thread over this one refuses to run.
 */
export const ENGINE_HEAP_MAX_MB = ENGINE_HEAP_LIMITS.maxOldGenerationSizeMb + 2 * ENGINE_HEAP_LIMITS.maxYoungGenerationSizeMb;

/** The most elements one array may hold. */
export const MAX_ARRAY_ELEMENTS = 1_000_000;

/** The most UTF-16 units one string may hold. */
export const MAX_STRING_UNITS = 4_000_000;

/**
 * The most fields one record may hold when `json.parse`, `merge` or a record literal builds it.
 *
 * Measured with the engine's limits: records of 500,000 fields built in a loop never ended the
 * process, and records of 600,000 fields parsed from one text always did. A record the program
 * builds field by field is held back by the step budget long before this.
 */
export const MAX_RECORD_FIELDS = 250_000;

/** Refuse an array of `n` elements before it is built, naming the operation that would build it. */
export function assertArrayFits(where: string, n: number): void {
  if (n > MAX_ARRAY_ELEMENTS) {
    throw new RuntimeFault(
      "L4016",
      `${where}: an array of ${n} elements is more than the ${MAX_ARRAY_ELEMENTS} one array may hold in a run. Work on the data in pieces, or keep it outside the run and pass a reference.`,
    );
  }
}

/** Refuse a string of `n` units before it is built, naming the operation that would build it. */
export function assertStringFits(where: string, n: number): void {
  if (n > MAX_STRING_UNITS) {
    throw new RuntimeFault(
      "L4016",
      `${where}: a string of ${n} units is more than the ${MAX_STRING_UNITS} one string may hold in a run. Work on the text in pieces, or keep it outside the run and pass a reference.`,
    );
  }
}

/** Refuse a record of `n` fields before it is built, naming the operation that would build it. */
export function assertRecordFits(where: string, n: number): void {
  if (n > MAX_RECORD_FIELDS) {
    throw new RuntimeFault(
      "L4016",
      `${where}: ${n} record fields is more than the ${MAX_RECORD_FIELDS} one call may build in a run. Work on the data in pieces, or keep it outside the run and pass a reference.`,
    );
  }
}

/** Refuse a built array or string over its bound. Returns the value. */
export function sized<T>(where: string, v: T): T {
  if (Array.isArray(v)) assertArrayFits(where, v.length);
  else if (typeof v === "string") assertStringFits(where, v.length);
  return v;
}

/** How many elements `xs.flat(depth)` makes, counted up to one past the array bound without building it. */
export function flatElements(xs: readonly unknown[], depth: number): number {
  let n = 0;
  for (const x of xs) {
    n += Array.isArray(x) && depth >= 1 ? flatElements(x, depth - 1) : 1;
    if (n > MAX_ARRAY_ELEMENTS) return n;
  }
  return n;
}

/** How many units `xs.join(sep)` makes, without building it. Every element is a primitive here. */
export function joinedUnits(xs: readonly unknown[], sep: string): number {
  let n = Math.max(0, xs.length - 1) * sep.length;
  for (const x of xs) {
    n += x === null || x === undefined ? 0 : String(x).length;
    if (n > MAX_STRING_UNITS) return n;
  }
  return n;
}

/** How many parts `s.split(sep)` makes, counted up to one past the array bound without building them. */
export function splitParts(s: string, sep: string): number {
  if (sep === "") return s.length;
  let n = 1;
  for (let at = s.indexOf(sep); at !== -1 && n <= MAX_ARRAY_ELEMENTS; at = s.indexOf(sep, at + sep.length)) n += 1;
  return n;
}

/**
 * The most units `s.replace(from, to)` (or `replaceAll`) can produce, without building it.
 *
 * Each match is replaced by `to` with JavaScript's patterns expanded: `$$` is one unit, `$&` the match,
 * and `` $` `` and `$'` at most the whole receiver.
 */
export function replacedUnits(s: string, from: string, to: string, all: boolean): number {
  let per = 0;
  for (let i = 0; i < to.length; i += 1) {
    const next = to[i + 1];
    if (to[i] === "$" && next === "$") { per += 1; i += 1; }
    else if (to[i] === "$" && next === "&") { per += from.length; i += 1; }
    else if (to[i] === "$" && (next === "`" || next === "'")) { per += s.length; i += 1; }
    else per += 1;
  }
  let matches = 0;
  if (from === "") matches = all ? s.length + 1 : 1;
  else {
    // Counted until the result is known to be over the bound, so the answer is exact up to the
    // bound and over it past that: the caller refuses either way.
    for (let at = s.indexOf(from); at !== -1; at = s.indexOf(from, at + from.length)) {
      matches += 1;
      if (!all || s.length + matches * Math.max(0, per - from.length) > MAX_STRING_UNITS) break;
    }
  }
  return s.length + matches * Math.max(0, per - from.length);
}

/**
 * A count, length or index argument IS a number.
 *
 * The host converts a string or a boolean to a number where it wants one, so `"x".repeat("9")` and
 * `range("9")` once built what a number would. That conversion is the implicit coercion the language
 * refuses everywhere else (L4018), and it let a count past the size bounds unchecked.
 */
export function numberArg(where: string, v: unknown): number | undefined {
  if (v === undefined || typeof v === "number") return v;
  throw new RuntimeFault(
    "L4018",
    `${where}: this argument is a count or a position, so it must be a number, and ${v === null ? "null" : Array.isArray(v) ? "an array" : `a ${typeof v}`} is not one. Nothing is converted for you here: parse it first (\`parseNumber(text)\`).`,
  );
}

/**
 * Refuse a literal or call whose spreads would build more than the bound, before it is built.
 *
 * `spread` holds the spread operands and `plain` counts the other elements or properties. An array
 * operand counts its elements; a record operand counts its own fields; anything else counts nothing.
 */
export function assertSpreadFits(kind: "array" | "record", where: string, spread: readonly unknown[], plain: number): void {
  let n = plain;
  for (const v of spread) {
    if (Array.isArray(v) || typeof v === "string") n += v.length;
    else if (v !== null && typeof v === "object") n += Object.keys(v).length;
  }
  if (kind === "array") assertArrayFits(where, n);
  else assertRecordFits(where, n);
}

/**
 * Refuse a JSON text that would build a container or string over its bound, before it is parsed.
 *
 * One scan, outside and inside string literals: each array counts its own elements, each record its
 * own fields, each string its own raw length (an escape only makes the decoded string shorter).
 */
export function assertJsonContainersFit(text: string): void {
  const stack: { record: boolean; n: number; empty: boolean }[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 34) {
      const open = i;
      for (i += 1; i < text.length; i += 1) {
        const d = text.charCodeAt(i);
        if (d === 92) i += 1;
        else if (d === 34) break;
      }
      assertStringFits("json.parse", i - open - 1);
      if (stack.length > 0) stack[stack.length - 1]!.empty = false;
    } else if (c === 91 || c === 123) {
      if (stack.length > 0) stack[stack.length - 1]!.empty = false;
      stack.push({ record: c === 123, n: 0, empty: true });
    } else if (c === 93 || c === 125) {
      const top = stack.pop();
      if (top !== undefined && !top.empty) {
        if (top.record) assertRecordFits("json.parse", top.n + 1);
        else assertArrayFits("json.parse", top.n + 1);
      }
    } else if (c === 44) {
      const top = stack[stack.length - 1];
      if (top !== undefined) {
        top.n += 1;
        if (top.record) assertRecordFits("json.parse", top.n + 1);
        else assertArrayFits("json.parse", top.n + 1);
      }
    } else if (c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 58) {
      if (stack.length > 0) stack[stack.length - 1]!.empty = false;
    }
  }
}

/**
 * The length of the canonical JSON text of `v`, in UTF-16 units, without building it.
 *
 * Counted as RFC 8785 writes it: a string's escapes are counted unit by unit, a record's keys as the
 * strings they are. The count stops as soon as it passes the string bound.
 */
export function canonicalUnits(v: unknown): number {
  let n = 0;
  const str = (s: string): void => {
    n += 2;
    for (let i = 0; i < s.length && n <= MAX_STRING_UNITS; i += 1) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 2; i += 1; continue; }
      // A lone surrogate is written as a six-unit escape.
      n += c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 2 : c < 32 || (c >= 0xd800 && c <= 0xdfff) ? 6 : 1;
    }
  };
  const walk = (x: unknown): void => {
    if (n > MAX_STRING_UNITS) return;
    if (typeof x === "string") str(x);
    else if (Array.isArray(x)) {
      n += 2 + Math.max(0, x.length - 1);
      for (const e of x) { walk(e); if (n > MAX_STRING_UNITS) return; }
    } else if (x !== null && typeof x === "object") {
      const keys = Object.keys(x);
      n += 2 + Math.max(0, keys.length - 1) + keys.length;
      for (const k of keys) { str(k); walk((x as Record<string, unknown>)[k]); if (n > MAX_STRING_UNITS) return; }
    } else n += String(x).length;
  };
  walk(v);
  return n;
}
