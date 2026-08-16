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

import { type JournalKind, type StepKey, stepKeyString } from "./keys.js";

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
  readonly kind: JournalKind;
  readonly name: string;
  readonly occurrence: number;
  readonly inputHash: string;
  /**
   * The identity the handler submits under, written HERE at `begin` rather than reported back
   * after the fact. Recovery reissues under it; `external` is what the handler learned and may be
   * absent entirely if the crash came first.
   */
  readonly requestId?: string;
  /**
   * WHICH attempt {@link JournalEntry.requestId} names, counted from 0.
   *
   * The id alone is not enough to recover an escalation. An escalated checkpoint mints twice under
   * one entry, and a resumed run that knows only the open id cannot tell whether the hop has been
   * spent: it re-runs the live body, mints a second time under the id the far side already holds,
   * and collects that mint's cached expiry as if it were a fresh observation. The index is what
   * makes "complete the open attempt" expressible at all. Absent on an entry written before this
   * rule, which reads as attempt 0 and is correct for every non-escalating effect.
   */
  readonly attempt?: number;
  readonly state: EntryState;
  readonly status?: EntryStatus;
  readonly result?: unknown;
  readonly error?: EntryError;
  /** The external resource this effect bound, so a crash mid-effect is recoverable. */
  readonly external?: Readonly<Record<string, unknown>>;
  /**
   * A cancelling scope's INTENT, durable with its outcome.
   *
   * A journal write cancels nothing by itself: marking a branch cancelled while its agent keeps
   * working is how two agents come to share a worktree, one of them invisibly. So the losers are
   * recorded WITH the result, and `issued` flips only once the world agrees they are quiescent —
   * which is a fact about the world, established by whoever is driving, not by this record.
   */
  readonly cancel?: { readonly losers: readonly string[]; readonly issued: boolean };
  /**
   * A `conclave`'s CLOSURE, stated rather than inferred from the entry's state.
   *
   * The state cannot answer it. A cancelled conclave is `settled`/`cancelled` while its membership
   * is deliberately still live, and a scope whose body failed AND whose close failed settled
   * `failed` too — indistinguishable from "body failed, close succeeded", which an orphan walk
   * reads as closed. So the disposition is its own fact: `true` only once the handler acknowledged
   * the close. An entry that never settled is open by definition and carries nothing.
   */
  readonly closed?: boolean;
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

/**
 * Where a journal entry goes to survive the process that wrote it.
 *
 * The interpreter owns WHAT is recorded and WHEN; a store owns only durability, and it is handed
 * whole entries rather than deltas so it never has to reconstruct one. `append` must resolve only
 * once the entry is somewhere a resume on another host will find it — the pending half is awaited
 * before the handler runs, so a store that resolves early hands back exactly the crash window the
 * two-phase write exists to close.
 *
 * A run with no store is in-memory, which is what the simulator, the dry run and every test want:
 * durability is a property of where a run is hosted, not of what a program means.
 */
export interface JournalStore {
  append(entry: JournalEntry): Promise<void>;
}

/**
 * A store's refusal that could NOT be determined to have failed.
 *
 * A store that knows the append never landed says so by throwing an ordinary error. One that cannot
 * tell — a publish that timed out, a connection that died mid-flight — sets this, because the two
 * are different facts and the run must not be told the safer one. Everything else about the failure
 * is identical: the run stops either way.
 */
export interface IndeterminateAppend {
  readonly indeterminate: true;
}

export interface JournalInit {
  readonly run: string;
  readonly entries?: readonly JournalEntry[];
  /** Refuse to append. A migration's dry replay must never mutate the run it is checking. */
  readonly readOnly?: boolean;
  /** Where appends go to survive this process. Omitted, the journal is in-memory only. */
  readonly store?: JournalStore;
}

/**
 * A durable append the store REFUSED.
 *
 * This is not an effect failure, and conflating the two is not cosmetic. A handler that completed
 * plus a log that would not accept the completion used to produce an entry saying the work FAILED,
 * so a later replay reported failure for work the world had actually done — the journal lying about
 * the one thing it exists to remember. The domains are separate: "the world said no" is the run's
 * result, "the log said no" is the run losing its ability to have one. A driver reads the second as
 * "stop, and do not record anything else", never as an outcome.
 *
 * Nothing was written and nothing in memory moved, so a caller holding this error knows exactly as
 * much as it did before the call.
 */
export class JournalAppendRejected extends Error {
  readonly code = "L5010";

  /** True when the store could not tell whether the entry landed. See {@link IndeterminateAppend}. */
  readonly indeterminate: boolean;

  constructor(
    readonly stepKey: string,
    readonly state: EntryState,
    readonly reason: Error,
  ) {
    const indeterminate = (reason as Partial<IndeterminateAppend> | null | undefined)?.indeterminate === true;
    super(
      `L5010 Journal append rejected\n\n  step  ${stepKey}   ${state}\n\n${reason.message}\n\n${
        indeterminate
          ? "Whether the entry was recorded is UNKNOWN — the store could not tell — and the in-memory journal was left as it was."
          : "The entry was not recorded and the in-memory journal was left as it was."
      } This is a durability failure, not an effect failure: whatever the effect did, it stands, and this run can no longer say so.`,
    );
    this.indeterminate = indeterminate;
    this.name = "JournalAppendRejected";
  }
}

export class JournalReadOnlyError extends Error {
  constructor(key: StepKey) {
    super(`journal is read-only; ${stepKeyString(key)} would have been appended`);
    this.name = "JournalReadOnlyError";
  }
}

/**
 * The step-key string an entry was written under, rebuilt from the entry itself.
 *
 * A recorded entry keeps the scope path as a STRING and its own `(kind, name, occurrence)` beside
 * it, so the key it was filed under is recoverable — but only by re-applying the grammar that
 * `stepKeyString` owns. That grammar lives in exactly one place and this is how anything outside
 * the language addresses a recorded step: a caller that re-joined the parts by hand would be
 * maintaining a second copy of a rule, and the first edit to the naming would silently address a
 * different step rather than fail.
 */
export function journalEntryKeyString(entry: JournalEntry): string {
  const named = entry.name === "" ? entry.kind : `${entry.kind}:${entry.name}`;
  return `${entry.scope}/${named}#${entry.occurrence}`;
}

export class Journal {
  readonly run: string;
  readonly readOnly: boolean;
  private readonly store?: JournalStore;
  private readonly byKey = new Map<string, JournalEntry>();
  private readonly order: string[] = [];
  /**
   * Append order, allocated where the entry is BUILT rather than read off `order.length`.
   *
   * `begin` awaits a durable append before the key joins `order`, so two concurrent branches — which
   * is the normal shape, not an edge case — both read the same length and both claimed the same
   * `seq`. Rendering then showed two "first" steps, and any tooling ordering by it saw a tie it had
   * no way to break. A counter is allocated synchronously, so the two branches cannot observe the
   * same value however their awaits interleave.
   */
  private nextSeq = 0;
  /** Every key the current replay has looked up. What is left over is an orphan. */
  private readonly consumed = new Set<string>();

  constructor(init: JournalInit) {
    this.run = init.run;
    this.readOnly = init.readOnly === true;
    if (init.store !== undefined) this.store = init.store;
    for (const e of init.entries ?? []) {
      // A journal is ONE run's. Seeding it with another run's entry would make this run resume
      // against a history it never had — the keys are structural, so a foreign entry with the same
      // scope and name matches, and its recorded result is returned as if this run had produced it.
      if (e.run !== this.run)
        throw new Error(`journal for run ${this.run} was seeded with an entry from run ${e.run}; a run resumes only from its own journal`);
      // The stored `scope` string is authoritative: it is what makes a journal readable back
      // without re-running the program that produced it.
      const full = `${e.scope}/${e.name === "" ? e.kind : `${e.kind}:${e.name}`}#${e.occurrence}`;
      this.byKey.set(full, e);
      this.order.push(full);
      if (e.seq >= this.nextSeq) this.nextSeq = e.seq + 1;
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

  /**
   * Durably record one entry, BEFORE the in-memory map is allowed to hold it.
   *
   * The order is the whole point and it was the other way round once. Mutating first leaves a
   * volatile transition behind when the store refuses: a `begin` whose append was rejected still
   * read as `pending`, and a `settle` whose append was rejected still read as settled, so the
   * in-memory journal claimed a durability the store had explicitly declined to provide. Persisting
   * first means a rejected append changes nothing at all, which is the only state a caller can
   * reason about.
   *
   * A journal with no store keeps the old behaviour exactly: `persist` returns, the map is updated,
   * and nothing is awaited that could fail.
   */
  private async persist(k: string, entry: JournalEntry): Promise<void> {
    if (this.store === undefined) return;
    try {
      await this.store.append(entry);
    } catch (e) {
      throw new JournalAppendRejected(k, entry.state, e as Error);
    }
  }

  /**
   * Append the `pending` half: the effect is about to be performed.
   *
   * AWAIT THIS BEFORE DISPATCHING. The entry carries the request id the handler will submit under,
   * and an identity that is not durable when the work is issued names nothing a resume can find.
   */
  async begin(key: StepKey, inputHash: string, startedAt: number, requestId?: string): Promise<JournalEntry> {
    if (this.readOnly) throw new JournalReadOnlyError(key);
    const k = Journal.keyOf(key);
    const entry: JournalEntry = {
      v: 1,
      seq: this.nextSeq++,
      run: this.run,
      scope: k.slice(0, k.lastIndexOf("/")),
      kind: key.kind,
      name: key.name,
      occurrence: key.occurrence,
      inputHash,
      ...(requestId !== undefined ? { requestId, attempt: 0 } : {}),
      state: "pending",
      startedAt,
    };
    await this.persist(k, entry);
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
   *
   * The INDEX moves with the id, and it is the half that recovery reads: an id says what to submit
   * under, the index says how much of the chain is already spent.
   */
  async reissueAs(key: StepKey, requestId: string, attempt: number): Promise<void> {
    if (this.readOnly) throw new JournalReadOnlyError(key);
    const k = Journal.keyOf(key);
    const entry = this.byKey.get(k);
    if (entry === undefined) throw new Error(`reissueAs before begin for ${k}`);
    const next = { ...entry, requestId, attempt };
    await this.persist(k, next);
    this.byKey.set(k, next);
  }

  async bind(key: StepKey, external: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.readOnly) throw new JournalReadOnlyError(key);
    const k = Journal.keyOf(key);
    const entry = this.byKey.get(k);
    if (entry === undefined) throw new Error(`bind before begin for ${k}`);
    const next = { ...entry, external };
    await this.persist(k, next);
    this.byKey.set(k, next);
  }

  /**
   * Append the `settled` half.
   *
   * `facts.cancel` is for a scope that cancels siblings: the intent is recorded WITH the outcome
   * rather than after it, because a process dies between instructions and two appends are two
   * network operations however few keywords separate them. `facts.closed` is a `conclave`'s
   * membership disposition, for the same reason and with the same rule: it goes down with the
   * outcome or not at all.
   */
  async settle(
    key: StepKey,
    outcome:
      | { readonly status: "ok"; readonly result: unknown }
      | { readonly status: "failed"; readonly error: EntryError }
      | { readonly status: "cancelled" },
    endedAt: number,
    facts: {
      readonly cancel?: { readonly losers: readonly string[]; readonly issued: boolean };
      readonly closed?: boolean;
    } = {},
  ): Promise<JournalEntry> {
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
      ...(facts.cancel !== undefined ? { cancel: facts.cancel } : {}),
      ...(facts.closed !== undefined ? { closed: facts.closed } : {}),
    };
    await this.persist(k, settled);
    this.byKey.set(k, settled);
    return settled;
  }

  /**
   * Account for everything under a settled scope WITHOUT entering a branch.
   *
   * A settled scope is delivered from its own entry, so the branches are never walked — and an
   * entry nothing walks is an orphan, which on a migration means "the edit removed this step". The
   * branches were not removed; they were decided. So the subtree is marked consumed explicitly.
   *
   * A loser still sitting `pending` is settled `cancelled` in the same pass, because that is what
   * it is: the scope resolved without it. Settling the record is NOT the cancellation — the world
   * has to be told separately, which is what `cancel.issued` tracks — but leaving it pending would
   * make a resumed run try to recover work the scope already decided to abandon.
   */
  async consumeScope(scopeKeyString: string, endedAt: number): Promise<readonly string[]> {
    const prefix = `${scopeKeyString}/b:`;
    const touched: string[] = [];
    for (const k of this.order) {
      if (!k.startsWith(prefix)) continue;
      this.consumed.add(k);
      touched.push(k);
      const entry = this.byKey.get(k);
      if (entry === undefined || entry.state !== "pending") continue;
      const cancelled: JournalEntry = { ...entry, state: "settled", status: "cancelled", endedAt };
      await this.persist(k, cancelled);
      this.byKey.set(k, cancelled);
    }
    return touched;
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
