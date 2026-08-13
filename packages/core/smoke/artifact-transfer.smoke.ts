/**
 * The transfer planner re-derives per chunk — and T5 is what makes the claim below true.
 *
 * A planner that sizes once and reuses returns entirely plausible numbers: every chunk "fits" the
 * budget it was measured against. It is wrong only about the envelope it is actually sent with, and
 * only once `seq` gains a digit. So these cells assert which `seq` values were framed and that the
 * budget was read per chunk — properties a returned array cannot show.
 *
 * Run: pnpm smoke:artifact-transfer
 */
import { planTransfer } from "../src/artifact-transfer.js";
import { MinimumChunkError, fitChunk } from "../src/artifact-chunk.js";

let ok = 0, fail = 0;
const check = (name: string, pass: boolean, extra?: unknown) => {
  if (pass) { ok++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};

// Fixture NAMED, because this suite exists because a number was quoted without one.
const FIX = { uploadId: "a".repeat(32), fromId: "o.a", fromName: "agentname", role: "r" };
const uploadFrame = (seq: number) => (rawBytes: number) =>
  JSON.stringify({
    op: "putArtifactChunk",
    args: { uploadId: FIX.uploadId, seq, bytes: Buffer.alloc(rawBytes).toString("base64") },
    from: { id: FIX.fromId, name: FIX.fromName, role: FIX.role },
  });
const replyFrame = (offset: number) => (rawBytes: number) =>
  JSON.stringify({ ok: true, data: { bytes: Buffer.alloc(rawBytes).toString("base64"), offset, complete: false } });

/** Records which seq values were framed and how often the budget was read. */
const spy = (frame: (seq: number) => (n: number) => string, budget: number) => {
  const framedSeqs: number[] = [];
  let budgetReads = 0;
  return {
    framedSeqs,
    reads: () => budgetReads,
    budget: () => { budgetReads++; return budget; },
    frame: (seq: number) => { framedSeqs.push(seq); return frame(seq); },
  };
};

console.log("transfer planner: per-call re-derivation\n");

// ---- T1 — the budget and the frame are consulted ONCE PER CHUNK ---------------------------------
{
  const s = spy(uploadFrame, 1000);
  const sizes = planTransfer({ totalBytes: 4000, budget: s.budget, frame: s.frame, maxRaw: 1 << 17 });
  check("T1a the transfer is chunked", sizes.length > 1, sizes.length);
  check("T1b the budget was read once per chunk — LIVE, not captured",
    s.reads() === sizes.length, { reads: s.reads(), chunks: sizes.length });
  check("T1c a frame was built once per chunk", s.framedSeqs.length === sizes.length, s.framedSeqs.length);
  // NON-EMPTY GUARD IN THIS CELL, not borrowed from T1c. An `every` over a derived list passes
  // vacuously on an empty one, and the list is emptiest exactly when the thing under test has
  // collapsed — so without this the cell is silent in precisely the failure it was written for, and
  // its name claims an ordering it did not check. Kept distinct from T1c on purpose: T1c asserts
  // the right NUMBER of frames, this asserts the frames that exist are in order and that some do.
  check("T1d and each chunk was framed with its OWN seq, ascending from 0",
    s.framedSeqs.length > 0 && s.framedSeqs.every((v, i) => v === i), s.framedSeqs.slice(0, 12));
  check("T1e the sizes sum to the whole payload — nothing dropped",
    sizes.reduce((a, b) => a + b, 0) === 4000, sizes.reduce((a, b) => a + b, 0));
}

// ---- T2 — DIGIT GROWTH actually changes the answer ----------------------------------------------
//
// THE BUDGET HERE IS NOT ARBITRARY, AND AN EARLIER VERSION OF THIS CELL WAS WRONG BECAUSE IT WAS.
//
// The envelope really does widen at seq 10 — 149 -> 150 bytes empty. But base64 quantises in 3-byte
// groups (4 chars), so that 1-byte growth only moves the chunk size when it crosses a 4-char
// boundary. The largest raw n is 3*floor((budget - envelope)/4), so seq 9 and seq 10 differ
// **iff (budget - 149) % 4 === 0**, i.e. `budget % 4 === 1`:
//
//     budget | n@seq9 | n@seq10 | differ?
//       1000 |   636  |   636   | no      <- an earlier version sat here and passed vacuously
//       1001 |   639  |   636   | YES
//       1002 |   639  |   639   | no
//       1005 |   642  |   639   | YES
//
// So the hazard is observable at ONE BUDGET IN FOUR. A cell placed at a round number misses it
// three times out of four, silently, with an entirely plausible plan — and the same quantisation
// that makes the maximality diagnostic elegant is what hides it here.
//
// The precondition is therefore ASSERTED, not just chosen: if someone later tidies this to 1000 the
// suite says so instead of quietly disarming.
{
  const BUDGET = 1001;
  const emptyAt9 = Buffer.byteLength(uploadFrame(9)(0));
  check("T2-pre the budget sits in the quarter where digit growth is OBSERVABLE",
    (BUDGET - emptyAt9) % 4 === 0, { BUDGET, emptyAt9, mod: (BUDGET - emptyAt9) % 4 });

  const s = spy(uploadFrame, BUDGET);
  const sizes = planTransfer({ totalBytes: 20_000, budget: s.budget, frame: s.frame, maxRaw: 1 << 17 });
  check("T2a the transfer reaches seq 10 (so the boundary is actually crossed)",
    s.framedSeqs.includes(10), s.framedSeqs.length);
  check("T2b the chunk at seq 10 is SMALLER than at seq 9 — the envelope widened",
    sizes[10] < sizes[9], { at9: sizes[9], at10: sizes[10] });
}

// ---- T3 — directions are sized separately --------------------------------------------------------
// Same budget, different envelope, different answer. A planner shared between directions would give
// one of them the other's size.
{
  const up = spy(uploadFrame, 1000);
  const rep = spy(replyFrame, 1000);
  const upSizes = planTransfer({ totalBytes: 2000, budget: up.budget, frame: up.frame, maxRaw: 1 << 17 });
  const repSizes = planTransfer({ totalBytes: 2000, budget: rep.budget, frame: rep.frame, maxRaw: 1 << 17 });
  check("T3 the reply direction carries MORE per chunk at the same budget — its envelope is smaller",
    repSizes[0] > upSizes[0], { upload: upSizes[0], reply: repSizes[0] });
}

// ---- T5 — WHAT IT FRAMES, which this suite's own header claimed and did not check ----------------
//
// The header above says the planner is "proven by what it FRAMES, not by what it returns". That was
// FALSE: the spy records `seq` and nothing else, so no cell ever related a returned size to the
// frame it was measured against. `take = Math.min(fit * 2, remaining)` — chunks at DOUBLE the fitted
// size — survived all ten cells, including T1e, because the sum is still the payload no matter how
// it is divided.
//
// A right comment beside wrong code, and the comment is this file's own thesis statement.
//
// Two distinct properties, deliberately separate cells: every chunk must FIT its own frame (the
// safety property — an oversize chunk is rejected by the broker mid-transfer), and every chunk but
// the last must be MAXIMAL (the progress property — a planner that under-fills wastes a round trip
// per chunk and no fit-only check would notice).
{
  const BUDGET = 1000;
  const s = spy(uploadFrame, BUDGET);
  const sizes = planTransfer({ totalBytes: 4000, budget: s.budget, frame: s.frame, maxRaw: 1 << 17 });

  const overs = sizes
    .map((n, i) => ({ i, framed: Buffer.byteLength(uploadFrame(i)(n)), n }))
    .filter((x) => x.framed > BUDGET);
  check("T5a EVERY chunk's own frame fits the budget it was sized against",
    overs.length === 0, overs.slice(0, 4));

  // Maximality, checked against a FRESH fitChunk for the same seq — the returned size must be the
  // answer, not merely an answer under it. The last chunk is excluded because it is bounded by what
  // remains, not by the budget.
  const shortfalls = sizes.slice(0, -1)
    .map((n, i) => ({ i, n, fit: fitChunk({ budget: BUDGET, frame: uploadFrame(i), maxRaw: 1 << 17 }) }))
    .filter((x) => x.n !== x.fit);
  check("T5b and every chunk but the last is EXACTLY the fitted maximum",
    shortfalls.length === 0, shortfalls.slice(0, 4));

  // NON-EMPTY GUARDS, in these cells rather than borrowed. Both assertions above are `filter`s over
  // a derived list and pass vacuously on an empty one — and the list is emptiest precisely when the
  // planner has collapsed, which is the failure they were written for.
  check("T5c (guard) the plan was non-trivial, so T5a/T5b examined something",
    sizes.length > 1, sizes.length);
}

// ---- T4 — the floor still refuses mid-plan --------------------------------------------------------
{
  let threw: unknown;
  try { planTransfer({ totalBytes: 100, budget: () => 90, frame: uploadFrame, maxRaw: 1 << 17 }); }
  catch (e) { threw = e; }
  check("T4 a below-floor budget refuses by name rather than looping at zero",
    threw instanceof MinimumChunkError, threw instanceof Error ? threw.message.slice(0, 70) : threw);
}

console.log(`\nartifact-transfer: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
