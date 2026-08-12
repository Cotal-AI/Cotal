/**
 * `[P6]` — the DURABLE SOURCE read.
 *
 * **The in-process bus is a WAKE SIGNAL, never the data path.** Every harness Cotal connects to
 * already persists an ordered, timestamped record of what the agent did: Claude Code writes a
 * session JSONL, Codex writes a rollout JSONL, OpenCode persists to its own store behind
 * `session.messages()`. A connector that instead reads the harness's in-memory event bus loses
 * everything observed since the last publish the moment the process dies — silently, and with no
 * gap visible to any consumer, because nothing was ever published to leave a hole in.
 *
 * So the contract is: the bus tells us *that* something changed; this reads *what* changed, from
 * the source of record, resuming at a cursor that survives a crash.
 *
 * The cursor is OPAQUE to the caller and defined by each source. A file source uses a byte offset;
 * a store-backed source uses whatever ordering key its own API exposes. The caller persists it and
 * hands it back — it never parses it.
 */

import { open } from "node:fs/promises";

/** One read: the records that became available, and the cursor to resume from AFTER them. */
export interface SourceRead<T> {
  records: T[];
  /** Pass to the next {@link DurableSource.read}. Advances ONLY past fully-consumed records. */
  cursor: string;
}

/** An append-only record of what a session did, re-readable after a crash. */
export interface DurableSource<T> {
  /** For diagnostics and for naming which adapter produced a frame. */
  readonly kind: string;
  /**
   * Read forward from `cursor` (or from the current end when it is `undefined` — a fresh adopt
   * must not rebroadcast a session's entire history).
   *
   * MUST NOT return a partially-written record, and MUST NOT advance the cursor past one.
   */
  read(cursor: string | undefined): Promise<SourceRead<T>>;
}

/**
 * A durable source over an append-only JSONL file — the shape both the Claude session transcript
 * and the Codex rollout log take.
 *
 * **The partial-line rule is the whole point of this class.** The writer is a separate process
 * appending concurrently, so a read can land mid-line. Parsing that yields either a throw or, far
 * worse, a truncated object that looks valid. So: only content up to the LAST newline is consumed,
 * and the cursor advances only that far. A trailing fragment is left for the next read, when the
 * writer has finished it.
 *
 * Unparseable COMPLETE lines are a different case and are NOT skipped silently — they surface, so a
 * format change is loud rather than a quiet hole in the record.
 */
export class JsonlFileSource<T = unknown> implements DurableSource<T> {
  readonly kind = "jsonl-file";

  constructor(private readonly path: string) {}

  /** Byte offset of the end of the last COMPLETE line consumed. */
  private static parseCursor(cursor: string | undefined): number | undefined {
    if (cursor === undefined) return undefined;
    const n = Number(cursor);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`JsonlFileSource: malformed cursor ${JSON.stringify(cursor)}`);
    return n;
  }

  async read(cursor: string | undefined): Promise<SourceRead<T>> {
    const fh = await open(this.path, "r");
    try {
      const size = (await fh.stat()).size;
      const from = JsonlFileSource.parseCursor(cursor);

      // A fresh adopt starts at the CURRENT end: a session that already ran must not be
      // rebroadcast wholesale the first time a connector attaches to it.
      if (from === undefined) return { records: [], cursor: String(size) };

      // The file shrank (rotated, truncated, replaced). Re-adopting at the new end silently loses
      // records; treating it as a fresh file re-sends them. Neither is safe to choose here, so it
      // fails loud and the caller decides.
      if (from > size)
        throw new Error(
          `JsonlFileSource: cursor ${from} is past end ${size} for ${this.path} — the file was truncated or replaced`,
        );
      if (from === size) return { records: [], cursor: String(size) };

      const len = size - from;
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, from);
      const chunk = buf.subarray(0, bytesRead);

      // Consume only up to the last newline; anything after it is a line still being written.
      const lastNl = chunk.lastIndexOf(0x0a);
      if (lastNl === -1) return { records: [], cursor: String(from) };

      const complete = chunk.subarray(0, lastNl).toString("utf8");
      const records: T[] = [];
      for (const line of complete.split("\n")) {
        if (line.trim() === "") continue; // blank separators are not records
        try {
          records.push(JSON.parse(line) as T);
        } catch (e) {
          throw new Error(
            `JsonlFileSource: unparseable complete line at offset ~${from} in ${this.path}: ${(e as Error).message}`,
          );
        }
      }
      return { records, cursor: String(from + lastNl + 1) };
    } finally {
      await fh.close();
    }
  }
}
