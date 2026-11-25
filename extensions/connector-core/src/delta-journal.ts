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
 * text that was never journaled reaches the stream when the saved message does. A connector can also
 * journal records of its own, for what its harness reports and never saves.
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
  /** Keys whose streams the harness abandoned: no saved record will close them. */
  ends?: string[];
  /** Records the connector defines, in the order it wrote them. The journal does not read them. */
  records?: unknown[];
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
  const ends = r?.ends === undefined || (Array.isArray(r.ends) && r.ends.length > 0 && r.ends.every((k) => typeof k === "string" && k.length > 0));
  const records = r?.records === undefined || (Array.isArray(r.records) && r.records.length > 0);
  const ok = typeof r === "object" && r !== null && typeof r.anchor === "string" && Number.isSafeInteger(r.ts) &&
    Array.isArray(r.deltas) && r.deltas.length + (r.ends?.length ?? 0) + (r.records?.length ?? 0) > 0 && ends && records &&
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

  /**
   * End the streams under `keys` that no saved record will close, as a reply the harness failed to
   * save leaves. The line is written at once, with the deltas still pending, so a run the caller
   * closes next finds it in the journal. A reader ignores a key a saved record already closed.
   */
  abandon(keys: readonly string[]): void {
    if (this.fd === undefined) throw new Error(`delta journal: ${this.opts.path} is closed`);
    if (keys.length === 0) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const deltas = this.pending;
    this.pending = [];
    this.writeLine(deltas, [...keys]);
  }

  /**
   * Write `value`, a record the connector defines, for something its harness reports and never
   * saves. The line is written at once, with the deltas still pending, so the merged source hands
   * the record back by the harness position it was written at.
   */
  record(value: unknown): void {
    if (this.fd === undefined) throw new Error(`delta journal: ${this.opts.path} is closed`);
    if (JSON.stringify(value) === undefined) throw new Error("delta journal: a record must be a JSON value");
    clearTimeout(this.timer);
    this.timer = undefined;
    const deltas = this.pending;
    this.pending = [];
    this.writeLine(deltas, undefined, [value]);
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
    if (deltas.length > 0) this.writeLine(deltas);
  }

  private writeLine(deltas: StreamDelta[], ends?: string[], records?: unknown[]): void {
    if (this.fd === undefined) return;
    try {
      this.lastWrite = performance.now();
      const record: Omit<DeltaRecord, "anchor" | "ts"> = { deltas, ...(ends ? { ends } : {}), ...(records ? { records } : {}) };
      const line = Buffer.from(`${JSON.stringify({ anchor: this.opts.anchor(), ts: Date.now(), ...record })}\n`);
      for (let at = 0; at < line.length; ) at += writeSync(this.fd, line, at);
    } catch (e) {
      this.opts.onError(e as Error);
      return;
    }
    this.opts.onWrite();
  }
}
