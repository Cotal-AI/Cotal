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
    return { kind: "atom", set: single(c!.charCodeAt(0)) };
  }

  charClass(): CharSet {
    let neg = false;
    if (this.peek() === "^") { this.next(); neg = true; }
    const ranges: Array<[number, number]> = [];
    let widened = false;
    let prev: number | undefined;
    while (this.peek() !== "]") {
      if (this.eof()) refuse("unterminated character class");
      let lo: number | undefined;
      const c = this.next();
      if (c === "\\") {
        const s = this.escape(true);
        if (s.neg || s.ranges.length !== 1 || s.ranges[0][0] !== s.ranges[0][1]) {
          widened = true; // \d, \w, \p{…} inside a class: fold in conservatively
          for (const r of s.neg ? [[0, 0x10ffff] as [number, number]] : s.ranges) ranges.push(r);
        } else lo = s.ranges[0][0];
      } else lo = c.charCodeAt(0);
      if (lo !== undefined) {
        if (this.peek() === "-" && this.src[this.i + 1] !== "]" && this.src[this.i + 1] !== undefined) {
          this.next();
          const hiC = this.next();
          const hi = hiC === "\\" ? (() => { const s = this.escape(true); return s.ranges[0]?.[0] ?? 0x10ffff; })() : hiC.charCodeAt(0);
          ranges.push([lo, hi]);
        } else ranges.push([lo, lo]);
      }
      prev = lo;
    }
    void prev; void widened;
    this.next(); // ']'
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
      case "u": { const m = /^[0-9a-fA-F]{4}/.exec(this.src.slice(this.i)); if (!m) refuse("malformed \\u escape"); this.i += 4; return single(parseInt(m![0], 16)); }
      case "p": case "P": {
        const m = /^\{[^}]*\}/.exec(this.src.slice(this.i));
        if (!m) refuse("malformed \\p escape");
        this.i += m![0].length;
        return FULL; // unknown property set: widen — uncertainty refuses more, never less
      }
      default: return single(c.charCodeAt(0)); // an escaped metacharacter is that literal
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
}

const isVariableQuant = (n: Node): n is Extract<Node, { kind: "quant" }> =>
  n.kind === "quant" && (n.max > n.min || (n.max > 1 && analyze(n.body).variable));

function analyze(node: Node): Facts {
  switch (node.kind) {
    case "anchor":
      return { set: EMPTY, nullable: true, variable: false, ambiguousAlt: false };
    case "atom":
      return { set: node.set, nullable: node.set.ranges.length === 0 && !node.set.neg, variable: false, ambiguousAlt: false };
    case "seq": {
      const facts = node.items.map(analyze);
      // The polynomial overlap class: two variable repetitions with intersecting sets and only
      // nullable items between them (`a*a*`, `a*b?a*`) — refuse.
      for (let i = 0; i < node.items.length; i++) {
        if (!isVariableQuant(node.items[i])) continue;
        for (let j = i + 1; j < node.items.length; j++) {
          if (isVariableQuant(node.items[j])) {
            if (intersects(facts[i].set, facts[j].set))
              refuse("two overlapping variable repetitions in sequence (polynomial backtracking class)");
            if (!facts[j].nullable) break; // an obligatory, disjoint repetition ends this window
            continue; // a nullable one is transparent (`a*b?a*` still overlaps through it)
          }
          if (!facts[j].nullable) break; // an obligatory consumer separates the repetitions
        }
      }
      return {
        set: facts.reduce((s, f) => union(s, f.set), EMPTY),
        nullable: facts.every((f) => f.nullable),
        variable: facts.some((f) => f.variable),
        ambiguousAlt: facts.some((f) => f.ambiguousAlt),
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
      return {
        set: facts.reduce((s, f) => union(s, f.set), EMPTY),
        nullable: facts.some((f) => f.nullable),
        variable: facts.some((f) => f.variable),
        ambiguousAlt: ambiguous,
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
      return {
        set: body.set,
        nullable: body.nullable || node.min === 0,
        variable: body.variable || node.max > node.min || repeats,
        ambiguousAlt: body.ambiguousAlt,
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
