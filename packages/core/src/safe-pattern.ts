/**
 * The safe regex subset behind SPEC §13.7/§13.8 "bounded pattern complexity" / "bounded regex".
 *
 * A length cap is not a complexity bound (`^(a+)+$` is 8 characters and exponential), and a
 * denylist of known-bad shapes is not one either (`^(a|aa)+$` has no nested quantifier and is
 * exponential all the same). This module instead ADMITS a demonstrably-safe subset and refuses
 * everything it cannot prove, at registration time (`contract-invalid` at the caller):
 *
 *  - parse refusals: backreferences, lookarounds, and anything outside the subset grammar;
 *  - a variable repetition (`*`, `+`, `{m,}`, `{m,n}` with n>m>0, `{m}` with m>1 over variable
 *    content) REFUSES a body that is itself variable (nested repetition, `(a+)+`), nullable
 *    (`(a?)*`), or ambiguous (an alternation anywhere inside with overlapping or multiply
 *    nullable branches, `(a|aa)+`) — the three per-input-character ambiguity sources;
 *  - in a sequence, two variable repetitions with intersecting character sets and only
 *    nullable items between them refuse (`a*a*`, `a*b?a*` — the polynomial overlap class);
 *  - `?` (0-or-1) is repetition-exempt where it cannot multiply per input character: `(…)?`
 *    over quantified content stays admitted (one alternative in total).
 *
 * Character sets are computed conservatively (unknown escapes like `\p{…}` widen to ALL, so
 * uncertainty always refuses more, never less). Every admitted pattern backtracks at most a
 * constant number of alternatives per input position; every refused pattern names its reason.
 */

// ---- conservative character sets -------------------------------------------------------------

/** `neg: true` means the COMPLEMENT of `ranges` (so FULL = { neg: true, ranges: [] }). */
interface CharSet {
  neg: boolean;
  ranges: Array<[number, number]>;
}

const FULL: CharSet = { neg: true, ranges: [] };
const EMPTY: CharSet = { neg: false, ranges: [] };
const set = (...ranges: Array<[number, number]>): CharSet => ({ neg: false, ranges });
const single = (c: number): CharSet => set([c, c]);

function rangesOverlap(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  for (const [al, ah] of a) for (const [bl, bh] of b) if (al <= bh && bl <= ah) return true;
  return false;
}

function rangesCover(outer: Array<[number, number]>, [lo, hi]: [number, number]): boolean {
  // Conservative single-range cover test (enough for the complement cases below).
  return outer.some(([ol, oh]) => ol <= lo && hi <= oh);
}

/** Conservative non-empty-intersection test: uncertainty answers `true` (refuse-more). */
function intersects(a: CharSet, b: CharSet): boolean {
  if (!a.neg && !b.neg) return rangesOverlap(a.ranges, b.ranges);
  if (a.neg && b.neg) return true; // two complements always share almost everything
  const pos = a.neg ? b : a;
  const neg = a.neg ? a : b;
  // pos ∩ complement(neg.ranges) is empty only if neg's ranges cover every pos range.
  return !pos.ranges.every((r) => rangesCover(neg.ranges, r));
}

function union(a: CharSet, b: CharSet): CharSet {
  if (a.neg || b.neg) return FULL; // conservative: complements widen to ALL
  return { neg: false, ranges: [...a.ranges, ...b.ranges] };
}

// ---- the subset grammar (recursive descent) --------------------------------------------------

type Node =
  | { kind: "seq"; items: Node[] }
  | { kind: "alt"; branches: Node[] }
  | { kind: "atom"; set: CharSet }
  | { kind: "anchor" }
  | { kind: "quant"; body: Node; min: number; max: number } // max = Infinity for unbounded
  ;

class PatternRefused extends Error {}
const refuse = (reason: string): never => { throw new PatternRefused(reason); };

class Parser {
  i = 0;
  constructor(readonly src: string) {}
  peek(): string | undefined { return this.src[this.i]; }
  next(): string { return this.src[this.i++]; }
  eof(): boolean { return this.i >= this.src.length; }

  parse(): Node {
    const node = this.alternation();
    if (!this.eof()) refuse(`unexpected "${this.peek()}" at ${this.i}`);
    return node;
  }

  alternation(): Node {
    const branches = [this.sequence()];
    while (this.peek() === "|") { this.next(); branches.push(this.sequence()); }
    return branches.length === 1 ? branches[0] : { kind: "alt", branches };
  }

  sequence(): Node {
    const items: Node[] = [];
    while (!this.eof() && this.peek() !== "|" && this.peek() !== ")") items.push(this.quantified());
    return { kind: "seq", items };
  }

  quantified(): Node {
    let node = this.atom();
    for (;;) {
      const c = this.peek();
      let min: number, max: number;
      if (c === "*") { min = 0; max = Infinity; }
      else if (c === "+") { min = 1; max = Infinity; }
      else if (c === "?") { min = 0; max = 1; }
      else if (c === "{") {
        const m = /^\{(\d+)(?:,(\d*))?\}/.exec(this.src.slice(this.i));
        if (!m) break; // a literal '{'
        min = parseInt(m[1], 10);
        max = m[2] === undefined ? min : m[2] === "" ? Infinity : parseInt(m[2], 10);
        if (max < min) refuse(`quantifier {${min},${max}} is inverted`);
        this.i += m[0].length - 1; // -1: the shared next() below consumes one char
      } else break;
      this.next();
      if (this.peek() === "?") this.next(); // lazy marker — same admitted language
      node = { kind: "quant", body: node, min, max };
    }
    return node;
  }

  atom(): Node {
    const c = this.next();
    if (c === "(") {
      if (this.peek() === "?") {
        const ahead = this.src.slice(this.i, this.i + 3);
        if (/^\?(:|<[a-zA-Z_])/.test(ahead)) {
          // non-capturing or named group: plain grouping
          this.next(); // '?'
          if (this.peek() === "<") { while (this.next() !== ">") { if (this.eof()) refuse("unterminated group name"); } }
          else this.next(); // ':'
        } else {
          refuse("lookarounds and special groups are outside the profile's safe subset");
        }
      }
      const body = this.alternation();
      if (this.next() !== ")") refuse("unterminated group");
      return body;
    }
    if (c === "[") return { kind: "atom", set: this.charClass() };
    if (c === ".") return { kind: "atom", set: FULL };
    if (c === "^" || c === "$") return { kind: "anchor" };
    if (c === "\\") return { kind: "atom", set: this.escape(false) };
    if (c === ")" || c === undefined) refuse("unbalanced group");
    return { kind: "atom", set: single(this.codePoint()) };
  }

  /** One literal code POINT (never a lone code unit): `/u` semantics treat an astral pair as
   *  one atom, so the analyzer must too, or `😀*` models as high-surrogate + repeated
   *  low-surrogate and adjacency/overlap analysis silently under-approximates. */
  codePoint(): number {
    const cp = this.src.codePointAt(this.i - 1)!;
    if (cp > 0xffff) this.i++; // consumed the low half too
    return cp;
  }

  charClass(): CharSet {
    let neg = false;
    if (this.peek() === "^") { this.next(); neg = true; }
    const ranges: Array<[number, number]> = [];
    let approx = false; // any widened member: the set is an over-approximation
    while (this.peek() !== "]") {
      if (this.eof()) refuse("unterminated character class");
      let lo: number | undefined;
      const c = this.next();
      if (c === "\\") {
        if (this.peek() === "b") { this.next(); lo = 0x08; } // in a class, \b is backspace
        else {
          const s = this.escape(true);
          if (s.neg || s.ranges.length !== 1 || s.ranges[0][0] !== s.ranges[0][1]) {
            approx = true; // \d, \D, \p{…} inside a class: fold in conservatively
            for (const r of s.neg ? [[0, 0x10ffff] as [number, number]] : s.ranges) ranges.push(r);
          } else lo = s.ranges[0][0];
        }
      } else lo = this.codePoint();
      if (lo !== undefined) {
        if (this.peek() === "-" && this.src[this.i + 1] !== "]" && this.src[this.i + 1] !== undefined) {
          this.next();
          const hiC = this.next();
          const hi = hiC === "\\" ? (() => { const s = this.escape(true); if (s.neg || s.ranges.length !== 1) { approx = true; return 0x10ffff; } return s.ranges[0][0]; })() : this.codePoint();
          ranges.push([lo, hi]);
        } else ranges.push([lo, lo]);
      }
    }
    this.next(); // ']'
    // An over-approximated set NEGATED becomes an UNDER-approximation ([^\D] would model as
    // complement(ALL) = EMPTY while the engine sees \d) — widening must survive negation, so
    // an approximate negated class is FULL, never its complement.
    if (neg && approx) return FULL;
    return { neg, ranges };
  }

  escape(inClass: boolean): CharSet {
    const c = this.next();
    if (c === undefined) refuse("dangling escape");
    if (!inClass && c >= "1" && c <= "9") refuse(`backreference \\${c} is outside the profile's safe subset`);
    if (c === "k") refuse("named backreferences are outside the profile's safe subset");
    if (c === "b" || c === "B") return EMPTY; // word boundary: zero-width (as an atom: anchor-like)
    switch (c) {
      case "d": return set([0x30, 0x39]);
      case "D": return { neg: true, ranges: [[0x30, 0x39]] };
      case "w": return set([0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]);
      case "W": return { neg: true, ranges: [[0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]] };
      case "s": return set([0x09, 0x0d], [0x20, 0x20], [0xa0, 0xa0], [0x2028, 0x2029]);
      case "S": return { neg: true, ranges: [[0x09, 0x0d], [0x20, 0x20], [0xa0, 0xa0], [0x2028, 0x2029]] };
      case "n": return single(0x0a);
      case "r": return single(0x0d);
      case "t": return single(0x09);
      case "f": return single(0x0c);
      case "v": return single(0x0b);
      case "0": return single(0);
      case "x": { const m = /^[0-9a-fA-F]{2}/.exec(this.src.slice(this.i)); if (!m) refuse("malformed \\x escape"); this.i += 2; return single(parseInt(m![0], 16)); }
      case "u": {
        const braced = /^\{([0-9a-fA-F]{1,6})\}/.exec(this.src.slice(this.i));
        if (braced) {
          this.i += braced[0].length;
          const cp = parseInt(braced[1], 16);
          if (cp >= 0xd800 && cp <= 0xdfff) refuse("surrogate code point escapes are outside the safe subset");
          return single(cp);
        }
        const m = /^[0-9a-fA-F]{4}/.exec(this.src.slice(this.i));
        if (!m) refuse("malformed \\u escape");
        this.i += 4;
        const cp = parseInt(m![0], 16);
        // Under /u a surrogate escape pairs with its sibling into one code point; modeling the
        // halves separately under-approximates repetition — refuse, write the character or \u{…}.
        if (cp >= 0xd800 && cp <= 0xdfff) refuse("surrogate escapes are outside the safe subset (write the character or \\u{…})");
        return single(cp);
      }
      case "p": case "P": {
        const m = /^\{[^}]*\}/.exec(this.src.slice(this.i));
        if (!m) refuse("malformed \\p escape");
        this.i += m![0].length;
        return FULL; // unknown property set: widen — uncertainty refuses more, never less
      }
      default:
        // An escaped ALPHANUMERIC we do not model has (or may gain) engine meaning (\cA is
        // control-A, not literal c+A — modeling it as such under-approximated repetition):
        // refuse instead of fallback-admitting. Escaped punctuation is exactly that literal.
        if (/[A-Za-z0-9]/.test(c)) refuse(`escape \\${c} is outside the profile's safe subset`);
        return single(c.codePointAt(0)!);
    }
  }
}

// ---- the safety analysis ---------------------------------------------------------------------

interface Facts {
  set: CharSet;
  nullable: boolean;
  /** Contains a VARIABLE repetition (a quantifier that can iterate more than a fixed shape:
   *  max>min, or any max>1 over variable content — everything the nested-repetition rule keys on). */
  variable: boolean;
  /** Contains an alternation with overlapping or multiply-nullable branches (the per-input
   *  ambiguity `(a|aa)` even without any quantifier of its own). */
  ambiguousAlt: boolean;
  /** The character sets an UNBOUNDED repetition (`*`/`+`/`{n,}`) can match at this node's
   *  LEADING and TRAILING edge — even when the repetition is hidden inside an alternation
   *  branch or group (`(a*|b)` exposes `{a}` at both edges). Two nodes adjacent in a sequence
   *  (through nullable-only gaps) whose trailing and leading repeat-sets intersect are the
   *  `a*a*` polynomial class regardless of how deep the repetitions are nested. */
  leadRep: CharSet;
  trailRep: CharSet;
}

/** Front-to-back accumulation of an edge repeat-set across a sequence: a leading repetition can
 *  surface through any nullable prefix, so union each item's edge set while items stay nullable,
 *  and include the first obligatory item's edge set before stopping. `pick` selects the edge. */
function edgeRepeat(facts: Facts[], pick: (f: Facts) => CharSet): CharSet {
  let acc = EMPTY;
  for (const f of facts) {
    acc = union(acc, pick(f));
    if (!f.nullable) break;
  }
  return acc;
}

function analyze(node: Node): Facts {
  switch (node.kind) {
    case "anchor":
      return { set: EMPTY, nullable: true, variable: false, ambiguousAlt: false, leadRep: EMPTY, trailRep: EMPTY };
    case "atom":
      return { set: node.set, nullable: node.set.ranges.length === 0 && !node.set.neg, variable: false, ambiguousAlt: false, leadRep: EMPTY, trailRep: EMPTY };
    case "seq": {
      const facts = node.items.map(analyze);
      // The polynomial overlap class (`a*a*`, `a*b?a*`, and — via edge repeat-sets — repetitions
      // hidden inside groups/alternations like `(a*|b)a*`): a node whose TRAILING repeat-set
      // intersects a later node's LEADING repeat-set, through a nullable-only gap, is refused.
      for (let i = 0; i < facts.length; i++) {
        if (facts[i].trailRep.ranges.length === 0 && !facts[i].trailRep.neg) continue;
        for (let j = i + 1; j < facts.length; j++) {
          if (intersects(facts[i].trailRep, facts[j].leadRep))
            refuse("two overlapping variable repetitions in sequence (polynomial backtracking class)");
          if (!facts[j].nullable) break; // an obligatory consumer separates the repetitions
        }
      }
      return {
        set: facts.reduce((s, f) => union(s, f.set), EMPTY),
        nullable: facts.every((f) => f.nullable),
        variable: facts.some((f) => f.variable),
        ambiguousAlt: facts.some((f) => f.ambiguousAlt),
        leadRep: edgeRepeat(facts, (f) => f.leadRep),
        trailRep: edgeRepeat([...facts].reverse(), (f) => f.trailRep),
      };
    }
    case "alt": {
      const facts = node.branches.map(analyze);
      let ambiguous = facts.some((f) => f.ambiguousAlt);
      if (facts.filter((f) => f.nullable).length > 1) ambiguous = true; // two empty-matching branches
      for (let i = 0; i < facts.length && !ambiguous; i++) {
        for (let j = i + 1; j < facts.length; j++) {
          if (intersects(facts[i].set, facts[j].set)) { ambiguous = true; break; }
        }
      }
      // ANY branch may be the matched one, so its edge repeat-sets are all exposed at this
      // alternation's edges.
      return {
        set: facts.reduce((s, f) => union(s, f.set), EMPTY),
        nullable: facts.some((f) => f.nullable),
        variable: facts.some((f) => f.variable),
        ambiguousAlt: ambiguous,
        leadRep: facts.reduce((s, f) => union(s, f.leadRep), EMPTY),
        trailRep: facts.reduce((s, f) => union(s, f.trailRep), EMPTY),
      };
    }
    case "quant": {
      const body = analyze(node.body);
      const repeats = node.max > 1 || node.max === Infinity; // a `?` (0-or-1) cannot multiply per input char
      if (repeats) {
        if (body.variable) refuse("repeats a group that itself contains a quantifier (exponential backtracking class)");
        if (body.nullable) refuse("repeats a nullable body (unbounded ambiguity on empty matches)");
        if (body.ambiguousAlt) refuse("repeats an ambiguous alternation (branches overlap — exponential backtracking class)");
      }
      // Every NONDETERMINISTIC repetition (`max > min`: `*`, `+`, `{n,}`, `?`, and any `{m,n}`
      // with n>m) drives the polynomial overlap, because it can match a VARIABLE number of the
      // same characters, so an adjacent one over an intersecting set is a `C(input,k)` split
      // ambiguity — and an author-chosen finite bound like `{0,100000}` is not a "constant
      // factor" at a 10ms budget. Only a FIXED `{n}` (max===min) is deterministic and exempt.
      // A nondeterministic repetition exposes its BODY's set at both edges (its own repeated
      // content), plus any repeat-set the body already carried.
      const nondet = node.max > node.min;
      return {
        set: body.set,
        nullable: body.nullable || node.min === 0,
        variable: body.variable || nondet || repeats,
        ambiguousAlt: body.ambiguousAlt,
        leadRep: nondet ? union(body.set, body.leadRep) : body.leadRep,
        trailRep: nondet ? union(body.set, body.trailRep) : body.trailRep,
      };
    }
  }
}

/** Assert `pattern` is inside the profile's safe subset. Throws a plain `Error` naming the
 *  refusal reason (callers wrap it in their boundary's error type). `maxChars` is the §13.7
 *  length bound, checked first. */
export function assertSafePattern(pattern: string, maxChars: number): void {
  if (pattern.length > maxChars)
    throw new Error(`pattern of ${pattern.length} characters exceeds the profile complexity bound (${maxChars})`);
  try {
    analyze(new Parser(pattern).parse());
  } catch (e) {
    if (e instanceof PatternRefused) throw new Error(`pattern ${JSON.stringify(pattern)} is outside the profile's safe subset: ${e.message}`);
    throw new Error(`pattern ${JSON.stringify(pattern)} did not parse under the profile's safe subset: ${(e as Error).message}`);
  }
}
