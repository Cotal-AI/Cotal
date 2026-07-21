/**
 * Differential fuzz gate for the §13.7/§13.8 safe-pattern admission analysis: the standing
 * proof that `assertSafePattern` is SOUND — every pattern it ADMITS is actually linear in V8.
 *
 * Static safe-subset reasoning is subtle (this gate exists because several ambiguity classes
 * were only found by running real regexes: double-negation, unknown escapes, astral splitting,
 * composite-hidden repetition, finite-but-huge ranges, grouped run-slosh, fixed-alternation
 * chains). So we stop arguing and MEASURE, with three layers:
 *
 *  1. A DETERMINISTIC exploit corpus every reviewer contributed: each MUST refuse. A fixed
 *     corpus is the only defense against "the random seed happened not to sample this family" —
 *     the failure mode that let earlier folds ship. A companion idiom corpus MUST admit.
 *  2. A seeded random generator rich in overlapping repetitions, bare-alternation chains, and
 *     grouped-first-mandatory sequences (the families the earlier generator missed).
 *  3. Every admitted pattern (corpus + random) timed in V8 `/u` against adversarial
 *     almost-matches — inside a KILLABLE worker so a catastrophic match is terminated and
 *     recorded, not left to block the gate's own wall-clock. Any admitted pattern that exceeds
 *     the liveness budget OR stalls is a SOUNDNESS COUNTEREXAMPLE with its exact pattern.
 *
 * Run: pnpm smoke:safe-pattern-fuzz   (no broker; part of smoke:ci)
 */
import { Worker } from "node:worker_threads";
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

const ALPHABET = ["a", "b", "c", "0"];
const QUANTS = ["", "*", "+", "?", "{0,50000}", "{2,5}", "{3}", "{1,}"];
const LIVENESS_BUDGET_MS = 100; // an admitted pattern must be well under this on a bounded input
const ADVERSARIAL_LEN = 40_000;

// ── the killable V8 timing worker (§ layer 3) ──
// One long-lived worker compiles each pattern and times `re.test` against long almost-matches
// (a run of one alphabet char failing on a trailing out-of-alphabet char — maximal backtracking
// for any overlapping-repetition pattern). The parent enforces a HARD per-pattern wall by
// terminating a stalled worker: a catastrophic match cannot block the gate, it becomes a
// recorded counterexample. The worker rebuilds the adversarial corpus itself so 40k-char inputs
// never cross the channel.
const WORKER_SRC = `
const { parentPort } = require('worker_threads');
const ALPHABET = ${JSON.stringify(ALPHABET)};
const LEN = ${ADVERSARIAL_LEN};
const ADV = ALPHABET.map((ch) => ch.repeat(LEN) + '\\uffff');
parentPort.on('message', (msg) => {
  let re;
  try { re = new RegExp(msg.pattern, 'u'); }
  catch { parentPort.postMessage({ id: msg.id, compileError: true }); return; }
  let maxMs = 0;
  for (const input of ADV) {
    const t = Date.now();
    re.test(input);
    const ms = Date.now() - t;
    if (ms > maxMs) maxMs = ms;
  }
  parentPort.postMessage({ id: msg.id, ms: maxMs });
});
`;

const HARD_STALL_MS = 2_000; // a bounded pattern finishes 4×40k well under this; a stall = counterexample
let worker = new Worker(WORKER_SRC, { eval: true });
worker.unref();
let msgId = 0;

type TimeResult = { ms: number } | { compileError: true } | { stalled: true };
function timePattern(pattern: string): Promise<TimeResult> {
  const id = ++msgId;
  const w = worker;
  return new Promise<TimeResult>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      w.off("message", onMsg);
      void w.terminate();
      worker = new Worker(WORKER_SRC, { eval: true }); // respawn for the next probe
      worker.unref();
      resolve({ stalled: true });
    }, HARD_STALL_MS);
    const onMsg = (m: { id: number; ms?: number; compileError?: boolean }) => {
      if (m.id !== id || done) return;
      done = true;
      clearTimeout(timer);
      w.off("message", onMsg);
      resolve(m.compileError ? { compileError: true } : { ms: m.ms! });
    };
    w.on("message", onMsg);
    w.postMessage({ id, pattern });
  });
}

// ── layer 1: the deterministic corpora ──
// Exploits that MUST refuse — one per family every reviewer surfaced. These are the gate's real
// teeth: a fixed set can never "not sample" the counterexample the way a random seed can.
const MUST_REFUSE: Array<[string, string]> = [
  ["^(a+)+$", "nested repetition"],
  ["^(a|aa)+$", "ambiguous alternation under repetition"],
  ["^a*a*$", "direct overlapping repetition"],
  ["^(a*|b)a*$", "composite-hidden overlap"],
  ["^a{0,100000}a{0,100000}$", "finite-but-huge overlap"],
  ["^\\d*00{3}0*$", "run-slosh through absorbable fixed tokens"],
  ["^a*(aa*)$", "grouped run-slosh (edge set hidden behind a mandatory absorbable atom)"],
  ["^a*(a(a*(aa*)))$", "nested grouped run-slosh"],
  ["^a*(aa*)b$", "grouped run-slosh with a trailing obligation"],
  ["^" + "(a|aa)".repeat(25) + "X$", "fixed-alternation chain ×25 (2^25 paths, no quantifier)"],
  ["^" + "(a|aa)".repeat(7) + "X$", "fixed-alternation chain just over the path budget"],
  ["[0b]*$", "unanchored (Ajv tests patterns unanchored)"],
  ["^a|b*$", "one alternation branch not start-anchored"],
];
// Idioms that MUST admit — real contract patterns the analyzer may not over-refuse.
const MUST_ADMIT: string[] = [
  "^colou?r$",
  "^\\d{1,9}[a-z]{1,9}$",
  "^(foo|bar)?baz$",
  "^[a-z][a-z0-9-]*$",
  "^sha256:[0-9a-f]{64}$",
  "^v[0-9]+\\.[0-9]+\\.[0-9]+$",
  "^[a-z]+@[a-z]+\\.[a-z]+$",
  "^" + "(a|aa)".repeat(6) + "X$", // 64 paths — exactly at the budget, still admitted
  "^(a|b|c)(d|e)(f|g)$",
];

let refuseOk = 0;
for (const [p, family] of MUST_REFUSE) {
  let admitted = true;
  try { assertSafePattern(p, 4096); } catch { admitted = false; }
  if (admitted) c(`MUST-REFUSE admitted a known exploit (${family})`, false, JSON.stringify(p));
  else refuseOk++;
}
c(`every deterministic exploit refuses (${refuseOk}/${MUST_REFUSE.length})`, refuseOk === MUST_REFUSE.length);

const admitCorpus: string[] = [];
for (const p of MUST_ADMIT) {
  let admitted = true;
  try { assertSafePattern(p, 4096); } catch { admitted = false; }
  if (!admitted) c(`MUST-ADMIT refused a legitimate idiom`, false, JSON.stringify(p));
  else admitCorpus.push(p);
}
c(`every idiom admits (${admitCorpus.length}/${MUST_ADMIT.length})`, admitCorpus.length === MUST_ADMIT.length);

// ── layer 2: the seeded generator ──
function genAtom(): string {
  const r = rand();
  if (r < 0.7) return pick(ALPHABET);
  if (r < 0.85) return `[${pick(ALPHABET)}${pick(ALPHABET)}]`;
  if (r < 0.93) return `[^${pick(ALPHABET)}]`;
  return "\\d";
}
function genTerm(depth: number): string {
  // A group (bounded recursion) or a quantified atom; either may carry a quantifier. A share of
  // groups are emitted with NO outer quantifier so bare-alternation chains and grouped
  // first-mandatory sequences (the missed families) arise in the random stream too.
  if (depth > 0 && rand() < 0.4) {
    const inner = `(${genAlt(depth - 1)})`;
    return rand() < 0.5 ? `${inner}${pick(QUANTS)}` : inner;
  }
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

const N = 4000;
let admitted = 0, refused = 0, compileSkipped = 0;
const seededAdmits: string[] = [];
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
  seededAdmits.push(pattern);
}
c(`the generator exercises both paths (${admitted} admitted, ${refused} refused of ${N})`, admitted > 200 && refused > 200);

// ── layer 3: time EVERY admitted pattern (corpus idioms + seeded) in the killable worker ──
const toTime = [...admitCorpus, ...seededAdmits];
const counterexamples: Array<{ pattern: string; why: string }> = [];
for (const pattern of toTime) {
  const r = await timePattern(pattern);
  if ("compileError" in r) { compileSkipped++; continue; } // analyzer-admitted but V8 won't compile → contract-invalid at Ajv, not a liveness bug
  if ("stalled" in r) { counterexamples.push({ pattern, why: `stalled past ${HARD_STALL_MS}ms (killed)` }); continue; }
  if (r.ms > LIVENESS_BUDGET_MS) counterexamples.push({ pattern, why: `${r.ms}ms > ${LIVENESS_BUDGET_MS}ms budget` });
}

c("EVERY admitted pattern is linear in V8 (no soundness counterexample)",
  counterexamples.length === 0,
  counterexamples.length ? `seed 0x${SEED.toString(16)}; e.g. ${JSON.stringify(counterexamples[0].pattern)} ${counterexamples[0].why}` : "");
if (counterexamples.length) {
  console.log(`\n  ${counterexamples.length} soundness counterexample(s) (seed 0x${SEED.toString(16)}):`);
  for (const ce of counterexamples.slice(0, 10)) console.log(`    ${JSON.stringify(ce.pattern)}  ${ce.why}`);
}

await worker.terminate();
console.log(`\nSAFE-PATTERN FUZZ ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed; ${toTime.length} admitted patterns proven linear, ${compileSkipped} V8-incompatible skipped)`);
process.exit(fail > 0 ? 1 : 0);
