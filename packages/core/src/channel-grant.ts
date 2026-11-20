/**
 * Channel grants with exclusions (SPEC §9).
 *
 * A grant list is either a plain array of channel names and patterns, or, when it removes channels
 * from what it allows, `{ allow, exclude }`. Readers that predate exclusions require an array, so
 * they refuse the object form instead of reading the allow list alone.
 *
 * A grant is a set of concrete channels: those some `allow` entry matches and no `exclude` entry
 * matches. Both lists may hold names and patterns. Every decision here is exact on that set, using
 * the pattern algebra below; nothing is approximated.
 */
import { assertValidChannel, isChannelFamily, isConcreteChannel, patternInAllow, subjectMatches } from "./subjects.js";

/** A grant list as files and the wire carry it. */
export type ChannelGrantField = string[] | { allow: string[]; exclude: string[] };

/** A grant list in memory. `exclude` is empty for a list with no exclusions. */
export interface ChannelGrant {
  readonly allow: readonly string[];
  readonly exclude: readonly string[];
}

// ---- pattern algebra -----------------------------------------------------------------------------
//
// Patterns are NATS subject patterns: dotted tokens, `*` for one token, a final `>` for one or more.
// Two facts make every grant question exact. The subjects two patterns share are themselves one
// pattern (or none), so an intersection never has to be enumerated. And whether one pattern lies
// inside a union of patterns depends only on which literal each token equals, so a search that tries
// the literals the union names at each position plus one token none of them names, to one token past
// the longest pattern, visits a representative of every case.

const tokensOf = (pattern: string): string[] => {
  const t = pattern.split(".");
  if (t.some((x) => x.length === 0) || t.slice(0, -1).includes(">"))
    throw new Error(`"${pattern}" is not a subject pattern: empty token or '>' before the end`);
  return t;
};

/** The pattern matching exactly the subjects both `a` and `b` match, or `undefined` when none. */
export function patternMeet(a: string, b: string): string | undefined {
  const x = tokensOf(a), y = tokensOf(b);
  const out: string[] = [];
  for (let i = 0; ; i++) {
    const s = x[i], t = y[i];
    if (s === undefined && t === undefined) return out.join(".");
    if (s === ">") return t === undefined ? undefined : [...out, ...y.slice(i)].join(".");
    if (t === ">") return s === undefined ? undefined : [...out, ...x.slice(i)].join(".");
    if (s === undefined || t === undefined) return undefined;
    if (s === "*") out.push(t);
    else if (t === "*" || s === t) out.push(s);
    else return undefined;
  }
}

/** Do `a` and `b` match at least one common subject? */
export function patternsOverlap(a: string, b: string): boolean {
  return patternMeet(a, b) !== undefined;
}

// A token no pattern can name: channel tokens are `[A-Za-z0-9_-]`, NATS subject tokens never hold a
// NUL. It stands for every token the patterns under test do not name at that position.
const FRESH = "\u0000";

/** Does every subject `pattern` matches also match some entry of `union`? */
export function patternCoveredBy(pattern: string, union: readonly string[]): boolean {
  const p = tokensOf(pattern);
  const qs = union.map(tokensOf);
  const pEnd = p[p.length - 1] === ">" ? p.length - 1 : -1; // index of p's '>', or -1
  const limit = Math.max(p.length, ...qs.map((q) => q.length)) + 1;

  // Does some subject that starts with `s` and matches `p` escape every entry of `union`?
  const escapes = (s: string[], alive: readonly string[][]): boolean => {
    const n = s.length;
    // An entry whose '>' already has a token under it matches every extension of `s`, and `s`.
    if (alive.some((q) => q[q.length - 1] === ">" && q.length - 1 < n)) return false;
    const complete = pEnd < 0 ? n === p.length : n > pEnd;
    if (complete && !alive.some((q) => q.length === n && q[n - 1] !== ">")) return true;
    if (pEnd < 0 ? n >= p.length : n >= limit) return false;
    const fixed = pEnd < 0 || n < pEnd ? p[n] : "*";
    const candidates = fixed !== "*"
      ? [fixed]
      : [...new Set(alive.map((q) => q[n]).filter((t): t is string => t !== undefined && t !== "*" && t !== ">")), FRESH];
    for (const t of candidates) {
      const next = alive.filter((q) => n < q.length && (q[n] === "*" || q[n] === ">" || q[n] === t));
      if (escapes([...s, t], next)) return true;
    }
    return false;
  };
  return !escapes([], qs);
}

// ---- grants ----------------------------------------------------------------------------------------

/** Throws unless `exclude` is a valid exclusion set for `allow` (D3: the exclusion always wins, and an
 *  exclusion that removes nothing or removes a whole allow entry is refused). `field` names the list. */
export function assertExclusions(allow: readonly string[], exclude: readonly string[], field: string): void {
  for (const x of exclude) assertValidChannel(x);
  exclude.forEach((x, i) => {
    if (!allow.some((a) => patternsOverlap(a, x)))
      throw new Error(`${field}: exclusion "${x}" overlaps no entry of [${allow.join(", ")}], so it removes nothing`);
    const others = exclude.filter((_, j) => j !== i);
    if (patternCoveredBy(x, others))
      throw new Error(`${field}: exclusion "${x}" is already removed by [${others.join(", ")}]; list it once`);
  });
  if (exclude.length)
    for (const a of allow)
      if (patternCoveredBy(a, exclude))
        throw new Error(`${field}: "${a}" is both allowed and excluded in full by [${exclude.join(", ")}]; remove one of them`);
}

/** Parse either shape. Throws on anything else, including unknown keys on the object form. */
export function parseChannelGrant(value: unknown, field: string): ChannelGrant {
  const strings = (v: unknown, what: string): string[] => {
    if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) throw new Error(`${field}${what} must be a list of channel names`);
    return [...v];
  };
  if (Array.isArray(value)) return { allow: strings(value, ""), exclude: [] };
  if (value === null || typeof value !== "object") throw new Error(`${field} must be a list of channels or { allow, exclude }`);
  const extra = Object.keys(value).filter((k) => k !== "allow" && k !== "exclude");
  if (extra.length) throw new Error(`${field} carries unknown key(s) ${extra.join(", ")}; expected { allow, exclude }`);
  const allow = strings((value as { allow?: unknown }).allow, ".allow");
  const exclude = strings((value as { exclude?: unknown }).exclude, ".exclude");
  if (exclude.length === 0) throw new Error(`${field}: the { allow, exclude } form needs at least one exclusion; write a plain list otherwise`);
  for (const a of allow) assertValidChannel(a);
  assertExclusions(allow, exclude, field);
  return { allow, exclude };
}

/** The shape to write: a plain array unless there are exclusions, so a list without them stays
 *  byte-identical to what older readers accept. */
export function channelGrantField(allow: readonly string[], exclude: readonly string[] = []): ChannelGrantField {
  return exclude.length === 0 ? [...allow] : { allow: [...allow], exclude: [...exclude] };
}

/** Is concrete `channel` within the grant? */
export function channelInGrant(allow: readonly string[], exclude: readonly string[], channel: string): boolean {
  return allow.some((a) => subjectMatches(a, channel)) && !exclude.some((x) => subjectMatches(x, channel));
}

/** The exclusions that remove something from `pattern`. */
export function exclusionsOverlapping(pattern: string, exclude: readonly string[]): string[] {
  return exclude.filter((x) => patternsOverlap(pattern, x));
}

/** May a pattern subscription or join on `pattern` be admitted? It must lie inside one allow entry,
 *  as today, and must not be excluded in full: a partial overlap is admitted, and the excluded
 *  channels under it are never delivered (the broker filters live delivery, and every durable copy
 *  and history row is re-checked per channel). */
export function patternInGrant(allow: readonly string[], exclude: readonly string[], pattern: string): boolean {
  return patternInAllow([...allow], pattern) && !(exclude.length && patternCoveredBy(pattern, exclude));
}

/**
 * Does `child` stay within `parent`? Returns the parts of `child` that overreach, empty when within.
 * Exact: the child's channels `A \ E` lie inside the parent's `B \ F` when every child allow entry `a`
 * lies inside `B ∪ E`, and for every parent exclusion `f`, `a ∩ f` lies inside `E`.
 */
export function grantOverreachOf(child: ChannelGrant, parent: ChannelGrant): string[] {
  const over: string[] = [];
  for (const a of child.allow) {
    if (!patternCoveredBy(a, [...parent.allow, ...child.exclude])) { over.push(a); continue; }
    const missing = parent.exclude
      .map((f) => patternMeet(a, f))
      .filter((m): m is string => m !== undefined && !patternCoveredBy(m, child.exclude));
    if (missing.length) over.push(isConcreteChannel(a) ? a : `${a} (without excluding ${missing.join(", ")})`);
  }
  return over;
}

/** Does a read grant admit a durable membership on `channel`? A concrete channel must be within the
 *  grant ({@link channelInGrant}); a family must be admitted as a pattern ({@link patternInGrant}). */
export function membershipInGrant(allow: readonly string[], exclude: readonly string[], channel: string): boolean {
  return isChannelFamily(channel) ? patternInGrant(allow, exclude, channel) : channelInGrant(allow, exclude, channel);
}
