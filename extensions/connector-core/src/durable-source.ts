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

import { open, type FileHandle } from "node:fs/promises";

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

  /**
   * A cursor is `<dev>:<ino>:<offset>` — canonical, and BOUND TO THE FILE'S IDENTITY.
   *
   * The offset alone is not enough: a source replaced by an unrelated file of the same size or
   * larger reads as an ordinary append, and the reader resumes at a byte offset inside a document
   * it has never seen. Carrying `dev`/`ino` makes replacement DETECTABLE, which is the only thing
   * that lets it fail loud instead of returning fabricated records.
   *
   * Parsed strictly: `Number()` coerces `" "` to 0 — replaying all history — and accepts `"1e0"`,
   * `"01"`, `"+1"`. A cursor is persisted state handed back to us later, so a non-canonical one
   * means something upstream is wrong, not something to guess at.
   */
  private static parseCursor(cursor: string): { dev: string; ino: string; offset: number } {
    const m = /^(\d+):(\d+):(0|[1-9]\d*)$/.exec(cursor);
    if (!m) throw new Error(`JsonlFileSource: malformed cursor ${JSON.stringify(cursor)} (want <dev>:<ino>:<offset>)`);
    const offset = Number(m[3]);
    if (!Number.isSafeInteger(offset)) throw new Error(`JsonlFileSource: cursor offset out of range in ${JSON.stringify(cursor)}`);
    return { dev: m[1], ino: m[2], offset };
  }

  /** Offset just past the last COMPLETE line at or before `limit` — a safe boundary to resume at. */
  private static async lastCompleteBoundary(fh: FileHandle, limit: number): Promise<number> {
    if (limit === 0) return 0;
    const window = 64 * 1024;
    let searched = 0;
    while (searched < limit) {
      const len = Math.min(window, limit - searched);
      const at = limit - searched - len;
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, at);
      const idx = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (idx !== -1) return at + idx + 1;
      searched += len;
    }
    return 0; // no newline anywhere: nothing in the file is a complete record yet
  }

  async read(cursor: string | undefined): Promise<SourceRead<T>> {
    const fh = await open(this.path, "r");
    try {
      const st = await fh.stat();
      const size = st.size;
      const dev = String(st.dev), ino = String(st.ino);
      const here = (offset: number): string => `${dev}:${ino}:${offset}`;

      // A fresh adopt starts at the last COMPLETE record boundary, NEVER at the physical end.
      // Adopting mid-line makes the next read parse only the SUFFIX of a record the writer was
      // still appending: adopt at byte 1 of `{"i":1`, let the writer finish `2}\n`, and the source
      // emits `2}` while the real record is `{"i":12}`. That is the truncated-record corruption the
      // partial-line rule exists to prevent, reached through the adopt path instead of the read one.
      if (cursor === undefined)
        return { records: [], cursor: here(await JsonlFileSource.lastCompleteBoundary(fh, size)) };

      const from = JsonlFileSource.parseCursor(cursor);

      // Replacement is DETECTED by identity, not inferred from size — a replacement that is the
      // same size or larger looks exactly like an append, and resuming at the old offset emits
      // fragments of a document this reader has never seen. Re-adopting silently loses records and
      // restarting resends them, so neither is guessed here: the caller decides.
      if (from.dev !== dev || from.ino !== ino)
        throw new Error(
          `JsonlFileSource: ${this.path} is not the file this cursor came from ` +
            `(cursor ${from.dev}:${from.ino}, now ${dev}:${ino}) — it was replaced or rotated`,
        );
      if (from.offset > size)
        throw new Error(
          `JsonlFileSource: cursor offset ${from.offset} is past end ${size} for ${this.path} — the file was truncated`,
        );
      if (from.offset === size) return { records: [], cursor: here(from.offset) };

      const len = size - from.offset;
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, from.offset);
      const chunk = buf.subarray(0, bytesRead);

      // Consume only up to the last newline; anything after it is a line still being written.
      const lastNl = chunk.lastIndexOf(0x0a);
      if (lastNl === -1) return { records: [], cursor: here(from.offset) };

      // FATAL decode. `Buffer.toString("utf8")` substitutes U+FFFD for invalid bytes, so a
      // malformed byte inside an otherwise valid JSON string survives `JSON.parse` as CHANGED DATA
      // and would publish as if it were what the agent did. Silently rewriting a record is the same
      // class of harm as consuming a truncated one.
      let complete: string;
      try {
        complete = new TextDecoder("utf-8", { fatal: true }).decode(chunk.subarray(0, lastNl));
      } catch (e) {
        throw new Error(
          `JsonlFileSource: invalid UTF-8 at offset ~${from.offset} in ${this.path}: ${(e as Error).message}`,
        );
      }

      const records: T[] = [];
      for (const line of complete.split("\n")) {
        if (line.trim() === "") continue; // blank separators are not records
        try {
          records.push(JSON.parse(line) as T);
        } catch (e) {
          throw new Error(
            `JsonlFileSource: unparseable complete line at offset ~${from.offset} in ${this.path}: ${(e as Error).message}`,
          );
        }
      }
      return { records, cursor: here(from.offset + lastNl + 1) };
    } finally {
      await fh.close();
    }
  }
}
