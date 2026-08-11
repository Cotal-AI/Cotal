/**
 * The step journal.
 *
 * Resume is not a cursor and not a fast-forward: it is re-running the program from the top with
 * journalled effects returning recorded results, matched by key. That is precisely why
 * out-of-order concurrency replays correctly, and it is the same thing as an effect handler's
 * resume() implemented by re-running the deterministic prefix, which is why no continuation or VM
 * state is ever serialized.
 *
 * The input hash is deliberately NOT part of the lookup key. It is compared after the entry is
 * found, so a changed input is a diagnosable divergence naming the step, rather than a silent
 * miss that quietly re-runs the effect and lets two versions of the truth coexist.
 */

import type { EffectKind } from "./primitives.js";
import { type StepKey, stepKeyString } from "./keys.js";

export type EntryState = "pending" | "settled";
export type EntryStatus = "ok" | "failed" | "cancelled";

export interface EntryError {
  readonly code: string;
  readonly kind: string;
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface JournalEntry {
  readonly v: 1;
  /** Append order. For reading and rendering ONLY; matching never uses it. */
  readonly seq: number;
  readonly run: string;
  readonly scope: string;
  readonly kind: EffectKind;
  readonly name: string;
  readonly occurrence: number;
  readonly inputHash: string;
  /**
   * The identity the handler submits under, written HERE at `begin` rather than reported back
   * after the fact. Recovery reissues under it; `external` is what the handler learned and may be
   * absent entirely if the crash came first.
   */
  readonly requestId?: string;
  readonly state: EntryState;
  readonly status?: EntryStatus;
  readonly result?: unknown;
  readonly error?: EntryError;
  /** The external resource this effect bound, so a crash mid-effect is recoverable. */
  readonly external?: Readonly<Record<string, unknown>>;
  readonly startedAt: number;
  readonly endedAt?: number;
}

/** What the interpreter should do when it reaches an effect. */
export type LookupVerdict =
  /** Nothing recorded: perform the effect live. */
  | { readonly verdict: "miss" }
  /** Recorded and successful: return the result, perform nothing. */
  | { readonly verdict: "replay"; readonly entry: JournalEntry }
  /** Recorded as failed: throw the recorded error, perform nothing. */
  | { readonly verdict: "replay-failed"; readonly entry: JournalEntry }
  /** Recorded as cancelled: re-raise cancellation in this branch. */
  | { readonly verdict: "replay-cancelled"; readonly entry: JournalEntry }
  /** Started but never settled: re-bind to `entry.external` and await its terminal. */
  | { readonly verdict: "pending"; readonly entry: JournalEntry }
  /** Recorded with different inputs: abort, mutate nothing, and report the diff. */
  | {
      readonly verdict: "diverged";
      readonly entry: JournalEntry;
      readonly recordedHash: string;
      readonly programHash: string;
    };

export interface JournalInit {
  readonly run: string;
  readonly entries?: readonly JournalEntry[];
  /** Refuse to append. A migration's dry replay must never mutate the run it is checking. */
  readonly readOnly?: boolean;
}

export class JournalReadOnlyError extends Error {
  constructor(key: StepKey) {
    super(`journal is read-only; ${stepKeyString(key)} would have been appended`);
    this.name = "JournalReadOnlyError";
  }
}

export class Journal {
  readonly run: string;
  readonly readOnly: boolean;
  private readonly byKey = new Map<string, JournalEntry>();
  private readonly order: string[] = [];
  /** Every key the current replay has looked up. What is left over is an orphan. */
  private readonly consumed = new Set<string>();

  constructor(init: JournalInit) {
    this.run = init.run;
    this.readOnly = init.readOnly === true;
    for (const e of init.entries ?? []) {
      // The stored `scope` string is authoritative: it is what makes a journal readable back
      // without re-running the program that produced it.
      const full = `${e.scope}/${e.name === "" ? e.kind : `${e.kind}:${e.name}`}#${e.occurrence}`;
      this.byKey.set(full, e);
      this.order.push(full);
    }
  }

  private static keyOf(key: StepKey): string {
    return stepKeyString(key);
  }

  /**
   * Look the step up and say what the interpreter should do. Marks the key consumed, which is
   * what lets a migration tell "this step was removed" from "this step has not run yet".
   */
  lookup(key: StepKey, inputHash: string): LookupVerdict {
    const k = Journal.keyOf(key);
    this.consumed.add(k);
    const entry = this.byKey.get(k);
    if (entry === undefined) return { verdict: "miss" };
    if (entry.inputHash !== inputHash) {
      return {
        verdict: "diverged",
        entry,
        recordedHash: entry.inputHash,
        programHash: inputHash,
      };
    }
    if (entry.state === "pending") return { verdict: "pending", entry };
    if (entry.status === "failed") return { verdict: "replay-failed", entry };
    if (entry.status === "cancelled") return { verdict: "replay-cancelled", entry };
    return { verdict: "replay", entry };
  }

  /** Append the `pending` half: the effect is about to be performed. */
  begin(key: StepKey, inputHash: string, startedAt: number, requestId?: string): JournalEntry {
    if (this.readOnly) throw new JournalReadOnlyError(key);
    const k = Journal.keyOf(key);
    const entry: JournalEntry = {
      v: 1,
      seq: this.order.length,
      run: this.run,
      scope: k.slice(0, k.lastIndexOf("/")),
      kind: key.kind,
      name: key.name,
      occurrence: key.occurrence,
      inputHash,
      ...(requestId !== undefined ? { requestId } : {}),
      state: "pending",
      startedAt,
    };
    this.byKey.set(k, entry);
    this.order.push(k);
    this.consumed.add(k);
    return entry;
  }

  /** Record the external resource the handler created, before its terminal is awaited. */
  /**
   * Point the pending entry at a NEW open identity, before the work under it is issued.
   *
   * Escalation mints twice under one entry, so between the hops the row must name the attempt that
   * is about to be open rather than the one that already settled. Without this a crash after the
   * second mint leaves the far side holding work under an identity the journal never recorded, and
   * recovery reissues the first attempt and gets its cached expiry.
   */
  reissueAs(key: StepKey, requestId: string): void {
    if (this.readOnly) throw new JournalReadOnlyError(key);
    const k = Journal.keyOf(key);
    const entry = this.byKey.get(k);
    if (entry === undefined) throw new Error(`reissueAs before begin for ${k}`);
    this.byKey.set(k, { ...entry, requestId });
  }

  bind(key: StepKey, external: Readonly<Record<string, unknown>>): void {
    if (this.readOnly) throw new JournalReadOnlyError(key);
    const k = Journal.keyOf(key);
    const entry = this.byKey.get(k);
    if (entry === undefined) throw new Error(`bind before begin for ${k}`);
    this.byKey.set(k, { ...entry, external });
  }

  /** Append the `settled` half. */
  settle(
    key: StepKey,
    outcome:
      | { readonly status: "ok"; readonly result: unknown }
      | { readonly status: "failed"; readonly error: EntryError }
      | { readonly status: "cancelled" },
    endedAt: number,
  ): JournalEntry {
    if (this.readOnly) throw new JournalReadOnlyError(key);
    const k = Journal.keyOf(key);
    const entry = this.byKey.get(k);
    if (entry === undefined) throw new Error(`settle before begin for ${k}`);
    const settled: JournalEntry = {
      ...entry,
      state: "settled",
      status: outcome.status,
      endedAt,
      ...(outcome.status === "ok" ? { result: outcome.result } : {}),
      ...(outcome.status === "failed" ? { error: outcome.error } : {}),
    };
    this.byKey.set(k, settled);
    return settled;
  }

  /** Every entry, in append order. The journal is the prompt context for repair. */
  entries(): readonly JournalEntry[] {
    return this.order.map((k) => this.byKey.get(k)).filter((e): e is JournalEntry => e !== undefined);
  }

  get(key: StepKey): JournalEntry | undefined {
    return this.byKey.get(Journal.keyOf(key));
  }

  /**
   * Entries the current replay never looked up. On a migration these are the steps the edited
   * program removed, and what happens next depends on what they DID: a removed sleep is nothing,
   * a removed spawn leaks a live agent, a removed resolved checkpoint discards a human decision.
   */
  orphans(): readonly JournalEntry[] {
    return this.order
      .filter((k) => !this.consumed.has(k))
      .map((k) => this.byKey.get(k))
      .filter((e): e is JournalEntry => e !== undefined);
  }

  /** Start a fresh replay pass. */
  resetConsumed(): void {
    this.consumed.clear();
  }
}

/**
 * The run clock, per branch.
 *
 * `now()` is the maximum `endedAt` over the effects that causally precede the call, meaning the
 * ones this point actually awaited. Sequentially that is the previous effect's end; after joining
 * concurrent branches it is the maximum over all of them; inside a branch it is that branch's own
 * history. Deterministic under replay in every case, which is what makes "time advances only at
 * effect boundaries" a property of the design rather than a convention authors have to respect.
 *
 * A journal-wide max would NOT do: it would let a sibling branch's completion leak into a branch
 * that never awaited it, and live execution and replay would then disagree.
 */
export class RunClock {
  private value: number;

  constructor(startedAt: number) {
    this.value = startedAt;
  }

  now(): number {
    return this.value;
  }

  /** Advance past an effect this branch awaited. Monotone: an out-of-order settle cannot rewind. */
  advance(endedAt: number): void {
    if (endedAt > this.value) this.value = endedAt;
  }

  /** A branch inherits its parent's clock at the moment it forks. */
  fork(): RunClock {
    return new RunClock(this.value);
  }

  /** Joining concurrent branches takes the maximum, so the join sees all of their histories. */
  join(branches: readonly RunClock[]): void {
    for (const b of branches) this.advance(b.now());
  }
}
