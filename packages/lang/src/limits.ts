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
 * The heap limit, in MB, a thread created with {@link ENGINE_HEAP_LIMITS} may report and still run.
 *
 * A V8 heap flag on the process (`--max-old-space-size`, `--max-semi-space-size` and the like, on the
 * command line or in `NODE_OPTIONS`) replaces the limits a thread is created with, for every thread.
 * Measured on node 24: 560 MB with no flag, 515 MB under the daemon's `--max-semi-space-size=1`, and
 * 4144 MB under `--max-old-space-size=4096`. A thread outside this window refuses to run.
 */
export const ENGINE_HEAP_WINDOW_MB = Object.freeze({
  min: ENGINE_HEAP_LIMITS.maxOldGenerationSizeMb,
  max: ENGINE_HEAP_LIMITS.maxOldGenerationSizeMb + 2 * ENGINE_HEAP_LIMITS.maxYoungGenerationSizeMb,
});

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

/**
 * Refuse a JSON text that could build more than the bounds allow, before it is parsed.
 *
 * Every element after the first in an array is preceded by a comma and every record field carries a
 * colon, so counting them outside string literals over the whole text bounds what any one container
 * in it can hold.
 */
export function assertJsonFits(text: string): void {
  let commas = 0;
  let colons = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92) i += 1;
      else if (c === 34) inString = false;
    } else if (c === 34) inString = true;
    else if (c === 44) commas += 1;
    else if (c === 58) colons += 1;
  }
  assertArrayFits("json.parse", commas + 1);
  assertRecordFits("json.parse", colons);
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
    for (let at = s.indexOf(from); at !== -1; at = s.indexOf(from, at + from.length)) {
      matches += 1;
      if (!all || s.length + matches * per > MAX_STRING_UNITS) break;
    }
  }
  return s.length + matches * Math.max(0, per - from.length);
}
