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

/**
 * What a journal entry can be keyed as: an effect, or a concurrency SCOPE.
 *
 * The scope kinds are here because a combinator writes an entry for itself, and without them that
 * entry has no legal key and no legal kind — which is the state this package was in: scopes pushed
 * a frame, allocated an occurrence, and journalled nothing, so a replayed `race` re-raced and could
 * resolve a different arm with nothing recorded saying which one had won.
 */
export type JournalKind = EffectKind | ScopeKind;

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
  readonly kind: JournalKind;
  /** The literal step name, or "" when the effect was not named. */
  readonly name: string;
  readonly occurrence: number;
}

/** `sha256:<hex>` over the RFC 8785 canonical form, matching the digest discipline used for
 *  contract artifacts elsewhere in the repo. */
export const DIGEST_PREFIX = "sha256:" as const;

/**
 * The identity a handler submits under, written on the pending entry BEFORE the handler runs.
 *
 * Four components, each load-bearing rather than defensive. `runId`, because two runs reaching the
 * same step with the same inputs would otherwise derive the same id and collide at a caller-scoped
 * idempotency boundary. `attempt`, because escalation mints twice under one entry, so the second
 * mint needs a second identity that is still derivable before it happens. The step key and input
 * hash are what make it the identity of THIS step's THIS call.
 *
 * base64url, not the `sha256:<hex>` form this carried first: an endpoint id token is
 * `[A-Za-z0-9_-]{1,64}`, and that form is 71 characters with a colon in it, so it was never a
 * legal id. This is 43 characters in exactly that alphabet, with no `.` to confuse the
 * dot-separated subject a goal id rides.
 */
export function requestId(runId: string, key: StepKey, inputHash: string, attempt = 0): string {
  return createHash("sha256")
    .update(canonicalize([runId, stepKeyString(key), inputHash, attempt]), "utf8")
    .digest("base64url");
}

export function digest(value: unknown): string {
  return DIGEST_PREFIX + createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

/**
 * A program's identity, as one function so there is only one answer.
 *
 * The interpreter pins a run to this and a migration records the source it moved TO, and those two
 * must be the same hash of the same thing — a second copy of `digest({ source })` in another package
 * is a different function's answer wearing this one's name the moment either side changes.
 */
export function programHashOf(source: string): string {
  return digest({ source });
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

  /**
   * The scope's OWN key, in the namespace that opened it.
   *
   * Allocation-free on purpose: {@link KeyScope.nextScope} already allocated the occurrence, and
   * calling this must not consume a second one. The scope entry therefore sits beside the effects
   * of the namespace that opened it (`/race:first-answer#0`), while its branches live under it.
   */
  scopeKey(kind: ScopeKind, name: string | null, occurrence: number): StepKey {
    return { scope: this.path, kind, name: name ?? "", occurrence };
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
