/**
 * The run's pins: the resolved values that select which effects a run performs.
 *
 * A run is not pinned by its source alone. The seed decides pure draws, the logical epoch decides
 * what `now()` returns before the first effect, and the three limits decide whether a loop
 * completes or raises. Two runs of one program under different pins are two different runs, so the
 * pins are resolved once at start, recorded, and read back on every resume.
 *
 * The RESOLVED value is what is pinned. Defaulting the seed from the run id is fine; defaulting it
 * again on the next host is not, because "the default" is a property of the interpreter and the
 * interpreter is the thing that may have changed.
 */

import { CATALOG } from "./errors.js";

/**
 * The interpreter's own semantic version, bumped when a release changes what a program MEANS: the
 * PRNG, a builtin, numeric behaviour, or walker scheduling.
 *
 * Deliberately NOT the package version. `@cotal-ai/lang` versions in lockstep with every other
 * package in the repo, so a release of an unrelated package would otherwise invalidate every open
 * run in the space — a loud failure with no cause behind it, which is worse than no check at all.
 *
 * It is here because source and seed are not sufficient across an upgrade: unchanged source can
 * take a different branch BEFORE the first effect, where there is no input hash to compare against
 * and nothing to diverge on.
 */
export const LANGUAGE_VERSION = "1";

export const PIN_DEFAULTS = Object.freeze({
  yieldEvery: 1_024,
  stepBudget: 1_000_000,
  effectCeiling: 10_000,
});

/** Every pin, resolved. This is what lands on the run record and what a resume reads back. */
export interface RunPins {
  readonly seed: string;
  /**
   * The run's logical epoch. `now()` derives from THIS, never from the resuming host's clock; the
   * host clock is used only to stamp effects performed live on this attempt.
   */
  readonly startedAt: number;
  readonly yieldEvery: number;
  /**
   * Interpreter dispatches allowed in ONE WALK — not in the run. Steps are not recorded, so a
   * resume has nothing to recover a count from, and a replay re-walks the program anyway. This is
   * deliberately unlike `effectCeiling`, which IS a run bound because the journal records every
   * dispatch: the two are listed together and a lane fixing both for symmetry would invent a
   * counter with no source of truth.
   */
  readonly stepBudget: number;
  readonly effectCeiling: number;
  readonly languageVersion: string;
}

/** The loose per-run options a caller may supply. On a resume every one of them must agree. */
export interface PinnableOptions {
  readonly runId: string;
  readonly seed?: string;
  readonly startedAt?: number;
  readonly yieldEvery?: number;
  readonly stepBudget?: number;
  readonly effectCeiling?: number;
}

/** A pin the caller supplied disagrees with the one the run was started under (L5009 / L5008). */
export class PinMismatch extends Error {
  constructor(
    readonly code: "L5008" | "L5009",
    readonly pin: string,
    readonly recorded: string | number,
    readonly supplied: string | number,
    message: string,
  ) {
    super(`${code} ${CATALOG[code]}\n\n${message}`);
    this.name = "PinMismatch";
  }
}

/**
 * Resolve the pin set for a FRESH run. `now` is the host clock, read exactly once: the logical
 * epoch is a recorded fact from here on, so a second read could not be the same run's epoch.
 */
export function resolvePins(options: PinnableOptions, now: number): RunPins {
  return Object.freeze({
    seed: options.seed ?? options.runId,
    startedAt: options.startedAt ?? now,
    yieldEvery: options.yieldEvery ?? PIN_DEFAULTS.yieldEvery,
    stepBudget: options.stepBudget ?? PIN_DEFAULTS.stepBudget,
    effectCeiling: options.effectCeiling ?? PIN_DEFAULTS.effectCeiling,
    languageVersion: LANGUAGE_VERSION,
  });
}

/**
 * Bind a RESUME to the recorded pins, refusing any caller value that disagrees.
 *
 * The direction matters and is the whole rule: an absent option takes the record, a present one
 * that AGREES is harmless, and a present one that differs is refused rather than honoured. Honouring
 * it would silently make this a different run against the same journal, which is the same failure
 * an edited sleep duration causes and gets the same fail-loud treatment.
 */
export function bindPins(recorded: RunPins, options: PinnableOptions): RunPins {
  if (recorded.languageVersion !== LANGUAGE_VERSION) {
    throw new PinMismatch(
      "L5008",
      "languageVersion",
      recorded.languageVersion,
      LANGUAGE_VERSION,
      `This run started under language version ${recorded.languageVersion} and this interpreter is version ${LANGUAGE_VERSION}. Source and seed do not pin behaviour across a semantics change: unchanged source can take a different branch before the first effect, where there is no input hash to diverge on.\n\nOptions\n  resume on the recorded version\n  fork(run, <step>)   start a new run on this version, keeping the prefix`,
    );
  }
  const checks: readonly [keyof RunPins & string, string | number | undefined, string | number][] = [
    ["seed", options.seed, recorded.seed],
    ["startedAt", options.startedAt, recorded.startedAt],
    ["yieldEvery", options.yieldEvery, recorded.yieldEvery],
    ["stepBudget", options.stepBudget, recorded.stepBudget],
    ["effectCeiling", options.effectCeiling, recorded.effectCeiling],
  ];
  for (const [pin, supplied, value] of checks) {
    if (supplied !== undefined && supplied !== value) {
      throw new PinMismatch(
        "L5009",
        pin,
        value,
        supplied,
        `This run is pinned to ${pin} ${JSON.stringify(value)} and the caller supplied ${JSON.stringify(supplied)}. Pins select which effects run, so a different value is a different run against a journal that was not written for it.\n\nOptions\n  resume without the override\n  fork(run, <step>)   re-run from a step under the new ${pin}`,
      );
    }
  }
  return recorded;
}
