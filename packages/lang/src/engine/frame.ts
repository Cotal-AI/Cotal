/**
 * The engine's per-branch state, and the AsyncLocalStorage that carries it.
 *
 * The walker threads a `Frame` through every call because it owns every call. The engine does not:
 * the program is native JavaScript inside a Compartment, and the only thing it hands the host is
 * arguments. So the frame travels out-of-band, in an AsyncLocalStorage, and every seam member reads
 * it from there.
 *
 * That this works at all is a measured property of the floor, not an assumption (lane 1's decision,
 * re-measured here at ses@2.3.0 on node v26.7.0): a compartment shares the one locked-down realm's
 * intrinsics, so its promises are the host's promises and ALS propagation is native. Two interleaved
 * runs of the same compartment-evaluated program, each awaiting a host timer inside the seam, kept
 * their own frames with no cross-contamination. Node's remaining documented loss cases are callback
 * APIs and custom thenables — and a program value with its own callable `then` is exactly such a
 * thenable, which is why the seam refuses one outright (`born`/`set`/`await`) rather than trusting
 * the frame to survive it.
 *
 * `Signal` and `EngineFrame` are re-authored here rather than imported because the walker's are
 * private to interpret.ts, which this lane does not edit. They are held to the walker's semantics by
 * the differential suite; the shared `performEffect` the orchestrator is extracting should take a
 * STRUCTURAL frame (`{ keys, clock, signal, depth }`) so the walker's Frame and this one both
 * satisfy it without either importing the other.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { CancelSignal } from "../effects.js";
import type { RunClock } from "../journal.js";
import type { KeyScope, ScopeKind } from "../keys.js";

/**
 * A branch's cancellation, in the walker's two degrees.
 *
 * `cancelled` is the law: a cancelled branch performs no NEW effect, and every effect boundary
 * refuses it. `cutPure` is the stronger cut a scope applies to an arm that can no longer win, and it
 * is observed only at a fuel yield. Both degrees flow to child signals, and a signal already
 * cancelled softly can be escalated.
 */
export class Signal implements CancelSignal {
  cancelled = false;
  cutPure = false;
  reason?: string;
  private readonly listeners: ((reason: string, cutPure: boolean) => void)[] = [];

  onCancel(fn: (reason: string, cutPure: boolean) => void): void {
    this.listeners.push(fn);
  }

  cancel(reason: string, opts?: { readonly cutPure: boolean }): void {
    const cut = opts?.cutPure ?? true;
    const first = !this.cancelled;
    if (first) {
      this.cancelled = true;
      this.reason = reason;
    }
    const escalated = cut && !this.cutPure;
    if (escalated) this.cutPure = true;
    if (first || escalated) for (const l of this.listeners) l(reason, this.cutPure);
  }

  child(): Signal {
    const s = new Signal();
    if (this.cancelled) s.cancel(this.reason ?? "parent cancelled", { cutPure: this.cutPure });
    this.onCancel((r, cut) => s.cancel(r, { cutPure: cut }));
    return s;
  }
}

/** One branch of execution: its own key namespace, its own clock, its own cancellation signal. */
export class EngineFrame {
  constructor(
    readonly keys: KeyScope,
    readonly clock: RunClock,
    readonly signal: Signal,
    /** How many CONCURRENT scopes deep. L2032's runtime half; `born` stamps with it. */
    readonly depth: number = 0,
  ) {}

  branch(kind: ScopeKind, name: string | null, occurrence: number, branchKey: string): EngineFrame {
    return new EngineFrame(
      this.keys.branch(kind, name, occurrence, branchKey),
      this.clock.fork(),
      this.signal.child(),
      // `conclave` opens a scope but not a RACE: one body, nothing running beside it, so a write
      // from inside it is as ordered as a write anywhere else and the depth does not move.
      kind === "conclave" ? this.depth : this.depth + 1,
    );
  }
}

const FRAMES = new AsyncLocalStorage<EngineFrame>();

/** Run `body` with `frame` as the ambient frame. Every seam call inside it reads that frame. */
export function withFrame<T>(frame: EngineFrame, body: () => T): T {
  return FRAMES.run(frame, body);
}

/**
 * The ambient frame, or a loud failure.
 *
 * No fallback frame, deliberately. A seam call with no frame means the program is running outside
 * any branch — host machinery invoked it — and inventing a root frame there would give it a key
 * namespace, a clock and a depth that belong to no branch, which is how a step lands in the wrong
 * place in the journal instead of failing.
 */
export function currentFrame(): EngineFrame {
  const f = FRAMES.getStore();
  if (f === undefined) {
    throw new Error(
      "cotal-lang engine: a seam call ran with no frame. The program was reached from outside a branch, " +
        "so there is no key namespace, clock or depth to charge it to.",
    );
  }
  return f;
}
