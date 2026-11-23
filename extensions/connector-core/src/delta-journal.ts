/**
 * The per-session DELTA JOURNAL: the text a harness streams before it saves the message.
 *
 * The event plane publishes only what a durable record carries, and most harnesses save a message
 * only once it is complete. So a connector that wants a reply to stream journals the deltas here
 * first, and {@link DeltaMergedSource} reads them in among the harness's own records. Each line is
 * anchored to the harness position at which it was written, which is what lets a restart rebuild
 * the same order.
 *
 * The journal holds granularity, never the text of record: the saved message stays the truth, and
 * text that was never journaled reaches the stream when the saved message does.
 */
import { closeSync, constants, fstatSync, openSync, writeSync } from "node:fs";

/** One piece of streamed text for one part of one message. */
export interface StreamDelta {
  /**
   * The harness's own name for the message part, stable from its first delta to its saved record.
   * The mapper publishes the streamed message under it, so it must not equal the id the connector
   * gives a message it maps without streaming.
   */
  key: string;
  kind: "text" | "reasoning";
  /** The text appended since the previous delta of this key. */
  text: string;
}

/** One journal line: the deltas coalesced since the previous line, and where the harness stood. */
export interface DeltaRecord {
  /** The harness source's cursor when the line was written. */
  anchor: string;
  /** Milliseconds since the epoch, when the line was written. */
  ts: number;
  deltas: StreamDelta[];
}

/** The least time between two lines of one journal. */
export const DELTA_JOURNAL_INTERVAL_MS = 250;

export interface DeltaJournalOptions {
  path: string;
  /** The harness source's position now, read synchronously: the cursor its `end` would give. */
  anchor: () => string;
  /** A line was written: wake the emitter. */
  onWrite: () => void;
  /** A line could not be written. The text stays with the saved message. */
  onError: (error: Error) => void;
}

/** Throws unless `value` is a {@link DeltaRecord}; `where` names it in the error. */
export function assertDeltaRecord(value: unknown, where: string): asserts value is DeltaRecord {
  const r = value as Partial<DeltaRecord> | null;
  const ok = typeof r === "object" && r !== null && typeof r.anchor === "string" && Number.isSafeInteger(r.ts) &&
    Array.isArray(r.deltas) && r.deltas.length > 0 &&
    r.deltas.every((d) => typeof d?.key === "string" && d.key.length > 0 && (d.kind === "text" || d.kind === "reasoning") &&
      typeof d.text === "string" && d.text.length > 0);
  if (!ok) throw new Error(`delta journal: ${where} is not a delta record`);
}

/**
 * The writer. A connector appends every delta it is told of; the journal coalesces them per key and
 * writes at most one line per {@link DELTA_JOURNAL_INTERVAL_MS}.
 *
 * **A line takes its anchor and is appended in one synchronous step.** A harness that writes in the
 * same thread then cannot save a record between the two, so a reader that reads the harness before
 * the journal never meets a line anchored before a record it already passed.
 */
export class DeltaJournal {
  private pending: StreamDelta[] = [];
  private timer: NodeJS.Timeout | undefined;
  private lastWrite = -Infinity;

  private constructor(
    private fd: number | undefined,
    private readonly opts: DeltaJournalOptions,
  ) {}

  /**
   * Open or create the journal, mode 0600, at the `deltaJournalPath` that `ensureEventWalDir`
   * created the directory for. It lives and dies with the thread's `wal.json`: whatever removes
   * that removes this. A symlink, a file that is not regular, one another user owns and one others
   * can read are refused. Only the seat process writes it.
   */
  static open(opts: DeltaJournalOptions): DeltaJournal {
    const fd = openSync(opts.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o077) !== 0 || (process.getuid !== undefined && st.uid !== process.getuid())) {
      closeSync(fd);
      throw new Error(`delta journal: ${opts.path} must be a regular file this user owns and only it can read`);
    }
    return new DeltaJournal(fd, opts);
  }

  /** Queue a delta. Empty text is ignored. */
  append(delta: StreamDelta): void {
    if (this.fd === undefined) throw new Error(`delta journal: ${this.opts.path} is closed`);
    if (delta.text.length === 0) return;
    const same = this.pending.find((d) => d.key === delta.key);
    if (same && same.kind !== delta.kind)
      throw new Error(`delta journal: key ${delta.key} streamed as ${same.kind} and then as ${delta.kind}`);
    if (same) same.text += delta.text;
    else this.pending.push({ key: delta.key, kind: delta.kind, text: delta.text });
    this.timer ??= setTimeout(() => this.write(), Math.max(0, this.lastWrite + DELTA_JOURNAL_INTERVAL_MS - performance.now()));
  }

  /** Drop the text not yet written: the harness is about to save the message that carries it. */
  settle(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
  }

  /** Drop what is pending and release the file. */
  close(): void {
    this.settle();
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
  }

  private write(): void {
    // A timer can fire a millisecond early, so the interval is checked against the clock here.
    const wait = this.lastWrite + DELTA_JOURNAL_INTERVAL_MS - performance.now();
    if (wait > 0) {
      this.timer = setTimeout(() => this.write(), Math.ceil(wait));
      return;
    }
    this.timer = undefined;
    const deltas = this.pending;
    this.pending = [];
    if (deltas.length === 0 || this.fd === undefined) return;
    try {
      this.lastWrite = performance.now();
      const line = Buffer.from(`${JSON.stringify({ anchor: this.opts.anchor(), ts: Date.now(), deltas })}\n`);
      for (let at = 0; at < line.length; ) at += writeSync(this.fd, line, at);
    } catch (e) {
      this.opts.onError(e as Error);
      return;
    }
    this.opts.onWrite();
  }
}
