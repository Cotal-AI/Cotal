/**
 * Step keys: `(scope path, effect kind, step name, occurrence)`, with the input hash compared
 * after lookup rather than folded into the key.
 *
 * Never execution position. Positional keying is the durable-execution field's documented worst
 * production pain, and an LLM author restructures control flow freely, so positions are the one
 * thing that will not survive an edit.
 *
 * The scope path exists for one reason: inside a concurrency combinator, branches interleave, so
 * a per-run occurrence counter would race. Two branches both calling `turn(x, { name: "review" })`
 * would fight over occurrence 0 and the winner would depend on wall-clock timing, which is
 * exactly the nondeterminism replay cannot tolerate. Each branch therefore gets its own counter
 * namespace, and a combinator's own occurrence is allocated synchronously at the call, which sits
 * in already-deterministic code.
 */

import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import type { EffectKind } from "./primitives.js";

/** The concurrency combinators that open a scope. */
export type ScopeKind = "parallel" | "race" | "fanOut" | "conclave";

export interface ScopeFrame {
  readonly kind: ScopeKind;
  /** The combinator's step name, or null when it was not named. */
  readonly name: string | null;
  /** Which entry into this combinator, within the enclosing namespace. */
  readonly occurrence: number;
  /** Array index, record field name, or the fan-out item's key. */
  readonly branch: string;
}

export interface StepKey {
  readonly scope: readonly ScopeFrame[];
  readonly kind: EffectKind;
  /** The literal step name, or "" when the effect was not named. */
  readonly name: string;
  readonly occurrence: number;
}

/** `sha256:<hex>` over the RFC 8785 canonical form, matching the digest discipline used for
 *  contract artifacts elsewhere in the repo. */
export const DIGEST_PREFIX = "sha256:" as const;

export function digest(value: unknown): string {
  return DIGEST_PREFIX + createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

function frameString(f: ScopeFrame): string {
  const named = f.name === null ? f.kind : `${f.kind}:${f.name}`;
  return `/${named}#${f.occurrence}/b:${f.branch}`;
}

/** The canonical string form, used in the journal, the trace, and error messages. */
export function scopePathString(scope: readonly ScopeFrame[]): string {
  return scope.map(frameString).join("");
}

export function stepKeyString(key: StepKey): string {
  const named = key.name === "" ? key.kind : `${key.kind}:${key.name}`;
  return `${scopePathString(key.scope)}/${named}#${key.occurrence}`;
}

export function stepKeyEquals(a: StepKey, b: StepKey): boolean {
  return stepKeyString(a) === stepKeyString(b);
}

/**
 * One counter namespace. A run has one at the root, and every branch of every concurrency scope
 * gets its own child.
 *
 * Both counters are allocated synchronously at the call site, before the first await. That is the
 * whole determinism argument: the allocating code is either sequential or is itself inside an
 * already-deterministic namespace, so no two allocations can race.
 */
export class KeyScope {
  private readonly effectCounts = new Map<string, number>();
  private readonly scopeCounts = new Map<string, number>();

  constructor(readonly path: readonly ScopeFrame[] = []) {}

  /** Allocate the next occurrence for an effect in this namespace, and build its key. */
  nextEffect(kind: EffectKind, name = ""): StepKey {
    const tag = `${kind}:${name}`;
    const occurrence = this.effectCounts.get(tag) ?? 0;
    this.effectCounts.set(tag, occurrence + 1);
    return { scope: this.path, kind, name, occurrence };
  }

  /**
   * Allocate the next occurrence for a concurrency scope entered from this namespace. Call once
   * per combinator call, then {@link branch} once per branch.
   */
  nextScope(kind: ScopeKind, name: string | null = null): number {
    const tag = `${kind}:${name ?? ""}`;
    const occurrence = this.scopeCounts.get(tag) ?? 0;
    this.scopeCounts.set(tag, occurrence + 1);
    return occurrence;
  }

  /** The child namespace for one branch of a scope opened from here. */
  branch(kind: ScopeKind, name: string | null, occurrence: number, branchKey: string): KeyScope {
    return new KeyScope([...this.path, { kind, name, occurrence, branch: branchKey }]);
  }
}

/**
 * The branch keys for a combinator's argument. The record form is the default because its keys
 * survive both reordering and insertion; the array form is keyed by index, which shifts when a
 * branch is inserted, and the validator lints it.
 */
export function branchKeys(branches: readonly unknown[] | Readonly<Record<string, unknown>>): string[] {
  return Array.isArray(branches)
    ? branches.map((_, i) => String(i))
    : Object.keys(branches as Record<string, unknown>);
}
