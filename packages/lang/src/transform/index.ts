/**
 * `transform(source, opts)`: validated cotal-lang source in, a JavaScript module string out.
 *
 * PURE. No clock, no filesystem, no randomness, no counter that outlives a call — the same source
 * produces the same bytes, which is what lets a run pin to its program and a host cache the result.
 * `transform.smoke` holds that as a cell rather than a claim.
 *
 * It validates rather than trusting its caller. The contract says the input is validator-accepted
 * source, and the cheapest way to keep that true is to make it true here: `validate` is pure, so
 * running it costs one parse and removes an entire class of "the emitter was handed something the
 * language does not admit".
 */

import { validate } from "../grammar.js";
import { programHashOf } from "../keys.js";
import { emit } from "./emit.js";
import type { AnyNode } from "./scope.js";

export interface TransformOptions {
  /** The file name errors are reported against, exactly as `validate` takes it. */
  readonly file?: string;
}

export interface TransformMeta {
  /** `digest({ source })`, from the language's own function: a run pins to this. */
  readonly programHash: string;
  /** The engine is languageVersion 2. Runs recorded under 1 replay on the walker forever. */
  readonly languageVersion: 2;
  /** How many times each seam member is reached, so a check can report its count. */
  readonly sites: Readonly<Record<string, number>>;
  /** Seam members this emission needed that are surfaced but NOT yet ruled. Empty is the landing condition. */
  readonly proposed: readonly string[];
  /** The ctx parameter's name, picked against the program's own identifiers (a program may declare `__ctx`). */
  readonly ctx: string;
}

export function transform(source: string, opts: TransformOptions = {}): { readonly module: string; readonly meta: TransformMeta } {
  const { ast } = validate(source, opts.file);
  const e = emit(ast as unknown as AnyNode);
  return {
    module: e.module,
    meta: {
      programHash: programHashOf(source),
      languageVersion: 2,
      sites: e.sites,
      proposed: e.proposed,
      ctx: e.names.ctx,
    },
  };
}

export { SEAM_MEMBERS, SEAM_RULED, SEAM_PROPOSED, UNARY_OPS } from "./seam.js";
