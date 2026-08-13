/**
 * The transfer planner — where the §8 contract stops being a rule and becomes control flow.
 *
 * THE WHOLE POINT IS "PER CALL". A plan computed once is a constant wearing a computation's
 * clothes: the envelope holds live values, and `seq` gains a digit as the transfer proceeds, so a
 * size that fits at `seq: 9` can cross the boundary at `seq: 10`. This module therefore re-derives
 * the fit for EVERY chunk, from the frame built for THAT chunk's own `seq`, against the budget read
 * LIVE at that moment.
 *
 * It is structured so that re-derivation is not a discipline someone must remember: `frame` is a
 * function OF `seq`, so there is no way to express "size it once and reuse" without deleting a
 * parameter. The suite spies on which `seq` values were framed, and the mutation that hoists the
 * computation out of the loop reddens a named cell.
 *
 * DIRECTIONS ARE SEPARATE. An upload request and a fetch reply have different envelopes — measured
 * at 149 against 59 bytes empty — so one budget does not characterise both, and a planner shared
 * between them would be wrong for one. Each direction passes its own `frame`.
 */
import { fitChunk, type FrameBuilder } from "./artifact-chunk.js";

export interface TransferPlanOpts {
  /** Total raw bytes to move. */
  totalBytes: number;
  /** Read LIVE, per chunk — `max_payload` is configuration and an operator can change it mid-transfer. */
  budget: () => number;
  /** The frame for a given `seq`. A function OF seq so "compute once" cannot be expressed. */
  frame: (seq: number) => FrameBuilder;
  /** Ceiling on any single chunk, independent of the budget. */
  maxRaw: number;
}

/**
 * The raw size of each chunk, in order.
 *
 * Throws `MinimumChunkError` (from {@link fitChunk}) the moment a chunk cannot carry one raw byte —
 * including partway through, when digit growth crosses the boundary. That is deliberate: the
 * alternative is shrinking toward a floor while every individual call reports success, which is a
 * transfer that never completes and never complains.
 */
export function planTransfer(opts: TransferPlanOpts): number[] {
  const sizes: number[] = [];
  let remaining = opts.totalBytes;
  let seq = 0;
  while (remaining > 0) {
    // RE-DERIVED HERE, INSIDE THE LOOP, AND THAT PLACEMENT IS THE PROPERTY.
    // Hoisting this above the loop is the defect: it would size the whole transfer against seq 0's
    // envelope and silently overrun once seq gains a digit. A named cell exists for exactly that
    // mutation, because the sizes it produces are still plausible and every chunk still "fits" the
    // number it was measured against — just not the one it is actually sent with.
    const fit = fitChunk({ budget: opts.budget(), frame: opts.frame(seq), maxRaw: opts.maxRaw });
    const take = Math.min(fit, remaining);
    sizes.push(take);
    remaining -= take;
    seq++;
  }
  return sizes;
}
