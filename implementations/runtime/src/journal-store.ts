/**
 * The step journal's durable half: a `JournalStore` over the run journal's activation barrier.
 *
 * `packages/lang` decides WHAT is recorded and WHEN, and hands whole entries to a store that owns
 * only durability. This is that store for a run hosted on the mesh, and it is deliberately thin —
 * every hard property it has (one authoritative writer, a serial pump, a head that advances only
 * from a PubAck) belongs to `RunJournalAppender` and is not re-implemented here.
 *
 * What this file DOES own is the translation between two vocabularies that must not be confused:
 *
 *   - The language's `append` contract is "resolve only once the entry is somewhere a resume on
 *     another host will find it". The appender's resolution is a PubAck, which is exactly that, so
 *     the awaits line up with no buffering in between.
 *   - The language reads a store's refusal as `L5010 JournalAppendRejected` — "the log said no",
 *     the run losing its ability to record, never an effect result. Every terminal state of the
 *     barrier is that: superseded, stalled, or refused. So this store throws for all of them, and
 *     lets the journal wrap them, rather than inventing an outcome for a step whose effect already
 *     ran.
 *
 * A store that could return to the interpreter after a barrier failure would be worse than one that
 * throws: the interpreter would carry on driving a run this process no longer speaks for.
 */
import type { JournalEntry, JournalStore } from "@cotal-ai/lang";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import {
  RunJournalAppender,
  RunSuperseded,
  RunJournalStalled,
  RunJournalReplayRaced,
  replayRunJournal,
  type RunJournalReplay,
} from "@cotal-ai/core";

/**
 * How many replays a drive makes of its own journal before a lost round fails the read. It is the
 * takeover's bound: `activateRun` tries three rounds by default, and the driver hands that loop no
 * `beforeRetry`, so a lost round there is replayed at once with no pause in between.
 */
export const OWN_REPLAY_ATTEMPTS = 3;

/**
 * Replay a run's journal under the drive's own takeover id, replaying again after a lost round.
 *
 * `RunJournalReplayRaced` says another reader held the replay durable. Nothing is missing from the
 * journal and the run is not lost, which is why `activateRun` replays again on it. A drive reads
 * the same durable at every effect and at every poll of a parked pause, so its reads get the same
 * bounded retry, and a lost round is not handed to the program as the step's own `L4000`. Any other
 * failure, and the race on the last attempt, is raised unchanged.
 */
export async function replayOwnJournal(
  js: JetStreamClient,
  jsm: JetStreamManager,
  space: string,
  runId: string,
  takeoverId: string,
): Promise<RunJournalReplay> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await replayRunJournal(js, jsm, space, runId, takeoverId);
    } catch (e) {
      if (!(e instanceof RunJournalReplayRaced) || attempt >= OWN_REPLAY_ATTEMPTS) throw e;
    }
  }
}

/**
 * A run whose journal writer is finished, offered to the interpreter as a durability failure.
 *
 * The distinction the barrier draws — someone else took the run, versus this appender lost its head
 * — is preserved in `cause` for the driver, and flattened for the language, which has exactly one
 * correct response to both: stop, and record nothing else.
 */
export class RunJournalUnavailable extends Error {
  /**
   * True when it is NOT known whether the entry landed.
   *
   * A refusal is determinate: the stream said no, and nothing was written. A stalled append is not —
   * the publish may already be on disk — and the language's L5010 text says which, because "the
   * entry was not recorded" is a claim, and making it about an ambiguous append would be the
   * durability layer telling the run the more comfortable of two possibilities.
   */
  readonly indeterminate: boolean;

  constructor(
    readonly run: string,
    override readonly cause: unknown,
  ) {
    super(`run ${run} can no longer record: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.indeterminate = cause instanceof RunJournalStalled;
    this.name = "RunJournalUnavailable";
  }
}

export class RunJournalStore implements JournalStore {
  constructor(private readonly appender: RunJournalAppender) {}

  /** True once the underlying appender is finished. A driver polls this to stop early rather than
   *  discovering it on the next entry — the interpreter has no such concept and does not need one. */
  get isFinished(): boolean {
    return this.appender.isFinished;
  }

  async append(entry: JournalEntry): Promise<void> {
    // A run's journal takes only that run's entries. The language checks this where a journal is
    // SEEDED; this is the other end, where an entry is made durable — a PubAck on one run's subject
    // must never be what makes another run's journal report an entry as recorded.
    if (entry.run !== this.appender.run) {
      throw new Error(
        `entry belongs to run ${entry.run}, but this store appends to run ${this.appender.run}; a journal entry is durable on its own run's subject or not at all`,
      );
    }
    try {
      // The stamp is the entry's own clock — its end when it has one, its start while it is pending
      // — carried so a record is readable on its own. It is NOT the journal's ordering: the PubAck
      // sequence is that, and nothing downstream sorts by this.
      await this.appender.append(entry, entry.endedAt ?? entry.startedAt);
    } catch (e) {
      if (e instanceof RunSuperseded || e instanceof RunJournalStalled) {
        throw new RunJournalUnavailable(this.appender.run, e);
      }
      throw e;
    }
  }
}
