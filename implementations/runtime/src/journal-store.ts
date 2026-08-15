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
import { RunJournalAppender, RunSuperseded, RunJournalStalled } from "@cotal-ai/core";

/**
 * A run whose journal writer is finished, offered to the interpreter as a durability failure.
 *
 * The distinction the barrier draws — someone else took the run, versus this appender lost its head
 * — is preserved in `cause` for the driver, and flattened for the language, which has exactly one
 * correct response to both: stop, and record nothing else.
 */
export class RunJournalUnavailable extends Error {
  constructor(
    readonly run: string,
    override readonly cause: unknown,
  ) {
    super(`run ${run} can no longer record: ${cause instanceof Error ? cause.message : String(cause)}`);
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
    try {
      // `entry.endedAt ?? entry.startedAt` is NOT the journal's ordering — the appender's PubAck
      // sequence is. This stamp is the entry's own clock, carried so the record is readable on its
      // own, and nothing downstream sorts by it.
      await this.appender.append(entry, entry.startedAt);
    } catch (e) {
      if (e instanceof RunSuperseded || e instanceof RunJournalStalled) {
        throw new RunJournalUnavailable(this.appender.run, e);
      }
      throw e;
    }
  }
}
