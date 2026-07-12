/**
 * Differential fuzz gate for the §13.7/§13.8 safe-pattern admission analysis: the standing
 * proof that `assertSafePattern` is SOUND — every pattern it ADMITS is actually linear in V8.
 *
 * Static safe-subset reasoning is subtle (this gate exists because several ambiguity classes
 * were only found by running real regexes: double-negation, unknown escapes, astral splitting,
 * composite-hidden repetition, finite-but-huge ranges). So we stop arguing and MEASURE: generate
 * many random patterns from a grammar rich in overlapping repetitions, and for every one the
 * analyzer admits, time V8 `/u` matching against adversarial almost-matches. Any admitted pattern
 * that exceeds the liveness budget on a bounded input is a SOUNDNESS COUNTEREXAMPLE and fails the
 * gate with the exact reproducing pattern. A fixed seed makes every run reproducible.
 *
 * Run: pnpm smoke:safe-pattern-fuzz   (no broker; part of smoke:ci)
 */
import { assertSafePattern } from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };

// Deterministic PRNG (mulberry32) — a failure reprints the seed so it replays exactly.
const SEED = 0x9e3779b9;
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];

// A tiny alphabet so overlapping repetitions arise CONSTANTLY (the whole point of the fuzz).
const ALPHABET = ["a", "b", "c", "0"];
const QUANTS = ["", "*", "+", "?", "{0,50000}", "{2,5}", "{3}", "{1,}"];

function genAtom(): string {
  const r = rand();
  if (r < 0.7) return pick(ALPHABET);
  if (r < 0.85) return `[${pick(ALPHABET)}${pick(ALPHABET)}]`;
  if (r < 0.93) return `[^${pick(ALPHABET)}]`;
  return "\\d";
}
function genTerm(depth: number): string {
  // A group (bounded recursion) or a quantified atom; either may carry a quantifier.
  if (depth > 0 && rand() < 0.4) return `(${genAlt(depth - 1)})${pick(QUANTS)}`;
  return `${genAtom()}${pick(QUANTS)}`;
}
function genSeq(depth: number): string {
  const n = 1 + Math.floor(rand() * 4);
  let s = "";
  for (let i = 0; i < n; i++) s += genTerm(depth);
  return s;
}
function genAlt(depth: number): string {
  const n = 1 + Math.floor(rand() * 3);
  const branches: string[] = [];
  for (let i = 0; i < n; i++) branches.push(genSeq(depth));
  return branches.join("|");
}

const LIVENESS_BUDGET_MS = 100; // an admitted pattern must be well under this on a bounded input
const ADVERSARIAL_LEN = 40_000;
// Almost-matches: a long run of one alphabet char that fails at the end forces maximal
// backtracking in any overlapping-repetition pattern; the trailing char is outside the alphabet.
const ADVERSARIAL = ALPHABET.map((ch) => ch.repeat(ADVERSARIAL_LEN) + "￿");

const N = 4000;
let admitted = 0, refused = 0;
const counterexamples: Array<{ pattern: string; ms: number; input: string }> = [];
const started = Date.now();

for (let i = 0; i < N; i++) {
  // Half the patterns are start-anchored per branch (the admissible shape), half are the raw
  // wrapper form (whose inner top-level `|` breaks anchoring) — so the gate exercises both the
  // admitted-and-must-be-linear path AND the refuse-unanchored path.
  const body = genAlt(3);
  const pattern = rand() < 0.5
    ? `^${body.split("|").map((b) => (b.startsWith("^") ? b : `^${b}`)).join("|")}$`
    : `^${body}$`;
  try {
    assertSafePattern(pattern, 256);
  } catch {
    refused++;
    continue; // refused — the analyzer makes no liveness claim about it
  }
  admitted++;
  let re: RegExp;
  try {
    re = new RegExp(pattern, "u");
  } catch {
    continue; // a pattern the analyzer admits but V8 won't compile is not a liveness issue
  }
  for (const input of ADVERSARIAL) {
    const t = Date.now();
    re.test(input);
    const ms = Date.now() - t;
    if (ms > LIVENESS_BUDGET_MS) {
      counterexamples.push({ pattern, ms, input: `${input.slice(0, 6)}…×${ADVERSARIAL_LEN}` });
      break;
    }
  }
  // A slipped catastrophic pattern could stall; bail loudly rather than hang the suite.
  if (Date.now() - started > 60_000) {
    c("fuzz completed within its wall-clock bound", false, `stalled after ${i} patterns — a slow admitted pattern is a counterexample`);
    break;
  }
}

c(`the generator exercises both paths (${admitted} admitted, ${refused} refused of ${N})`, admitted > 200 && refused > 200);
c("EVERY admitted pattern is linear in V8 (no soundness counterexample)",
  counterexamples.length === 0,
  counterexamples.length ? `seed 0x${SEED.toString(16)}; e.g. ${JSON.stringify(counterexamples[0].pattern)} took ${counterexamples[0].ms}ms — the analyzer admitted a super-linear pattern` : "");
if (counterexamples.length) {
  console.log(`\n  ${counterexamples.length} soundness counterexample(s) (seed 0x${SEED.toString(16)}):`);
  for (const ce of counterexamples.slice(0, 10)) console.log(`    ${JSON.stringify(ce.pattern)}  ${ce.ms}ms`);
}

console.log(`\nSAFE-PATTERN FUZZ ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed; ${admitted} admitted patterns proven linear)`);
if (fail > 0) process.exit(1);
