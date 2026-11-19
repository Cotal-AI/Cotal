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

/**
 * The most bytes one message from a run's engine thread to its host may serialize to: a log line's
 * values, an effect's request, a journal entry, and the run's own answer.
 *
 * A value leaves the thread by structured clone, and the clone writes every reference to a string
 * out in full: 120 references to one 4,000,000-unit string are 8 MB in the thread and a 480 MB
 * message to the host, outside the thread's heap limit. Measured through the binary before this
 * bound, 400 logs of one two-byte string of 3,999,999 units took the host to 6 GB. A message is
 * counted here the way the clone writes it, before it is posted, so what reaches the host is at
 * most this, and the host prints or records each message before the thread may send another of
 * any size past {@link MAX_CROSSING_IN_FLIGHT}.
 *
 * Twice the largest string, because one string the program may hold must be able to cross: a
 * two-byte string of {@link MAX_STRING_UNITS} units clones to 8,000,000 bytes.
 */
export const MAX_CROSSING_BYTES = 2 * MAX_STRING_UNITS + 4096;

/**
 * The most bytes of log lines a thread may have posted that its host has not yet taken.
 *
 * Each line is bounded by {@link MAX_CROSSING_BYTES}, but a loop can post lines faster than a host
 * prints them, and the queue between them is the host's memory. Four of the largest lines.
 */
export const MAX_CROSSING_IN_FLIGHT = 4 * MAX_CROSSING_BYTES;

/**
 * The bytes the structured clone of `v` writes, counted up to one past `limit`.
 *
 * Every reference to a string is charged in full, because the clone writes each one out: a string
 * whose units are all under 256 is one byte a unit, any other two. An array or a record is written
 * once and then referred to (measured: `[o, o]` clones to the size of one `o`), so each is charged
 * once, which also ends the count on a cycle. A number, a boolean or a null is charged nine bytes.
 */
export function cloneBytes(v: unknown, limit = MAX_CROSSING_BYTES): number {
  let n = 0;
  const seen = new Set<object>();
  const str = (s: string): void => {
    let wide = false;
    for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) > 0xff) { wide = true; break; }
    n += 5 + (wide ? 2 : 1) * s.length;
  };
  // An explicit stack, so a deeply nested value is counted rather than ending the count on the
  // host's stack.
  const stack: unknown[] = [v];
  while (stack.length > 0 && n <= limit) {
    const x = stack.pop();
    if (typeof x === "string") str(x);
    else if (x === null || typeof x !== "object") n += 9;
    else if (seen.has(x)) n += 5;
    else {
      seen.add(x);
      n += 10;
      if (Array.isArray(x)) for (let i = x.length - 1; i >= 0; i -= 1) stack.push(x[i]);
      else for (const k of Object.keys(x)) { str(k); stack.push((x as Record<string, unknown>)[k]); }
    }
  }
  return n;
}

/** Refuse a message from the thread whose clone would pass {@link MAX_CROSSING_BYTES}, naming what it carries. */
export function assertCrossingFits(where: string, v: unknown): number {
  const n = cloneBytes(v);
  if (n > MAX_CROSSING_BYTES) {
    throw new RuntimeFault(
      "L4016",
      `${where} is more than the ${MAX_CROSSING_BYTES} bytes one value may take out of a run (a value counts each reference to a string in full). Pass less, or keep it outside the run and pass a reference.`,
    );
  }
  return n;
}

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
 * The length `s.replace(from, to)` (or `replaceAll`) produces, computed without building it, and
 * exact while it is under the bound: the caller refuses past it either way.
 *
 * Each match is replaced by `to` with JavaScript's patterns expanded, measured per match: `$$` is one
 * unit, `$&` the match, `` $` `` the text before the match (as long as its index) and `$'` the text
 * after it. A `$` that starts no pattern, a `$1` (there are no groups without regular expressions)
 * and a trailing `$` are themselves.
 */
export function replacedUnits(s: string, from: string, to: string, all: boolean): number {
  // The fixed part of one replacement, and how many times it takes the text before and after.
  let fixed = 0;
  let before = 0;
  let after = 0;
  for (let i = 0; i < to.length; i += 1) {
    const next = to[i + 1];
    if (to[i] === "$" && next === "$") { fixed += 1; i += 1; }
    else if (to[i] === "$" && next === "&") { fixed += from.length; i += 1; }
    else if (to[i] === "$" && next === "`") { before += 1; i += 1; }
    else if (to[i] === "$" && next === "'") { after += 1; i += 1; }
    else fixed += 1;
  }
  const per = (at: number): number => fixed + before * at + after * (s.length - at - from.length) - from.length;
  let n = s.length;
  if (from === "") {
    // An empty pattern matches before every unit and at the end (all), or once at the start.
    const last = all ? s.length : 0;
    for (let at = 0; at <= last; at += 1) {
      n += per(at) + from.length;
      if (n > MAX_STRING_UNITS) return n;
    }
    return n;
  }
  for (let at = s.indexOf(from); at !== -1; at = all ? s.indexOf(from, at + from.length) : -1) {
    n += per(at);
    if (n > MAX_STRING_UNITS) return n;
  }
  return n;
}

/**
 * A count, length or position argument as the host reads it: a number is itself, and any other
 * primitive is converted with ECMAScript's `Number` (spec §4.5, §5.4: a primitive passes to the host
 * with its conversion, and only an array, a record or a function is refused, by the argument gate
 * before this). So `"x".repeat("3")` is `"xxx"`, and the size bound is checked against the number the
 * host will use, not against what the program spelled. `undefined` stays absent.
 */
export function numberArg(_where: string, v: unknown): number | undefined {
  if (v === undefined || typeof v === "number") return v;
  return Number(v);
}

/**
 * Refuse a literal or call whose spreads would build more than the bound, before it is built.
 *
 * `spread` holds the spread operands copied so far. For an array, `plain` counts the other
 * elements so far, and each operand counts its elements. For a record, `plain` is the plain keys so
 * far, and what is counted is the DISTINCT keys across them and every operand's own fields, because
 * a key written twice is one field (`{ ...a, ...a }` holds what `a` holds).
 */
export function assertSpreadFits(kind: "array" | "record", where: string, spread: readonly unknown[], plain: number | readonly unknown[], excluded: readonly unknown[] = []): void {
  if (kind === "array") {
    let n = typeof plain === "number" ? plain : plain.length;
    for (const v of spread) if (Array.isArray(v) || typeof v === "string") n += v.length;
    assertArrayFits(where, n);
    return;
  }
  const keys = new Set<string>(typeof plain === "number" ? [] : plain.map(String));
  const skip = new Set<string>(excluded.map(String));
  for (const v of spread) {
    if (v === null || v === undefined) continue;
    for (const k of Object.keys(v)) {
      if (!skip.has(k)) keys.add(k);
    }
  }
  assertRecordFits(where, keys.size + (typeof plain === "number" ? plain : 0));
}

/** How many distinct fields `out` would hold after `entries` are written into it. */
export function distinctFields(out: object, entries: readonly (readonly [string, unknown])[]): number {
  let n = Object.keys(out).length;
  for (const [k] of entries) if (!Object.prototype.hasOwnProperty.call(out, k)) n += 1;
  return n;
}

/** How many elements `[...s]` makes: its code points, a surrogate pair counting once. */
export function codePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) i += 1;
    n += 1;
  }
  return n;
}

/**
 * The elements of `[...s]` (its code points) a destructuring pattern takes, without building the
 * rest. A pattern with no rest element names `take` of them, and only those are read: `const [a, b]
 * = s` takes two code points of any string a program may hold. A pattern with a rest element takes
 * every one, so the code points after the first `take` are counted first, exactly and without
 * building them, and a rest over the array bound is refused before it is built.
 */
export function stringElements(s: string, take: number, rest: boolean, where: string): string[] {
  if (rest) {
    assertArrayFits(where, Math.max(0, codePoints(s) - take));
    return [...s];
  }
  const out: string[] = [];
  for (let i = 0; i < s.length && out.length < take; ) {
    const unit = s.codePointAt(i)! > 0xffff ? 2 : 1;
    out.push(s.slice(i, i + unit));
    i += unit;
  }
  return out;
}

/**
 * Each record's field count, as member writes have grown it. A program removes no field (`delete` is
 * refused, L1021), so a count only grows, and a record first written to is counted once, here.
 */
const fieldCounts = new WeakMap<object, number>();

/**
 * Refuse a member write that would add a field past the record bound, before it is added. A write
 * to a field the record already has adds nothing and is never refused.
 *
 * Measured before this check, about 6,000,000 fields added one write at a time ended the process,
 * when an embedder had raised the step budget.
 */
export function assertFieldWriteFits(o: object, key: string): void {
  if (Object.prototype.hasOwnProperty.call(o, key)) return;
  const n = (fieldCounts.get(o) ?? Object.keys(o).length) + 1;
  assertRecordFits("this field write", n);
  fieldCounts.set(o, n);
}

/**
 * Refuse a JSON text that would build a container or string over its bound, before it is parsed.
 *
 * One scan, outside and inside string literals: each array counts its own elements, each record its
 * DISTINCT keys (a key written twice is one field, the last value winning, as the host parses it),
 * each string its own raw length (an escape only makes the decoded string shorter). A malformed text
 * is left to the host, which refuses it.
 */
export function assertJsonContainersFit(text: string): void {
  const stack: { record: boolean; n: number; empty: boolean; keys?: Set<string>; expectKey?: boolean }[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 34) {
      const open = i;
      let escaped = false;
      for (i += 1; i < text.length; i += 1) {
        const d = text.charCodeAt(i);
        if (d === 92) { i += 1; escaped = true; }
        else if (d === 34) break;
      }
      assertStringFits("json.parse", i - open - 1);
      const top = stack[stack.length - 1];
      if (top !== undefined) {
        top.empty = false;
        if (top.record && top.expectKey === true) {
          top.expectKey = false;
          let key = text.slice(open + 1, i);
          if (escaped) {
            try { key = JSON.parse(text.slice(open, i + 1)) as string; } catch { /* the host refuses it */ }
          }
          top.keys!.add(key);
          assertRecordFits("json.parse", top.keys!.size);
        }
      }
    } else if (c === 91 || c === 123) {
      if (stack.length > 0) stack[stack.length - 1]!.empty = false;
      stack.push(c === 123 ? { record: true, n: 0, empty: true, keys: new Set(), expectKey: true } : { record: false, n: 0, empty: true });
    } else if (c === 93 || c === 125) {
      const top = stack.pop();
      if (top !== undefined && !top.empty && !top.record) assertArrayFits("json.parse", top.n + 1);
    } else if (c === 44) {
      const top = stack[stack.length - 1];
      if (top !== undefined) {
        if (top.record) top.expectKey = true;
        else {
          top.n += 1;
          assertArrayFits("json.parse", top.n + 1);
        }
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
