/**
 * The DURABLE SOURCE read.
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

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

/**
 * One record, WITH THE CURSOR THAT RESUMES AFTER IT — not just the value.
 *
 * **The per-record cursor is not a convenience; without it one-unit-one-frame is unimplementable.**
 * The emitter may turn one read into several frames, and each frame must be its own durable
 * pending/publish/ack cycle *with its own `sourceCursor`*. A read that offers only a single
 * end-of-batch cursor gives a frame covering records 0..i exactly one legal cursor value to store:
 * the one that says every record in the batch was consumed. Fold that frame, crash, and the frontier
 * has advanced past records the later frames were carrying — with no `seq` gap and nothing for a
 * consumer to notice. That is the silent loss this whole plane exists to make impossible, reached
 * through the resume path rather than the publish one.
 *
 * The alternative, one read being indivisibly one frame, is worse: a restart's read returns
 * everything appended since the cursor, so "a single unit that cannot fit FAILS LOUD"
 * would fire on ordinary catch-up traffic.
 */
export interface SourceRecord<T> {
  value: T;
  /** Pass to the next {@link DurableSource.read} to resume immediately after this record. */
  cursor: string;
}

/** One read: the records that became available, and the cursor to resume from AFTER them. */
export interface SourceRead<T> {
  records: SourceRecord<T>[];
  /**
   * Pass to the next {@link DurableSource.read}. Advances ONLY past fully-consumed records.
   *
   * Equal to the last record's cursor when the read is non-empty — an implementation MUST keep
   * those two agreeing, and {@link JsonlFileSource} asserts it rather than assuming it.
   * It is still carried separately because an EMPTY read has a cursor and no last record: a fresh
   * adopt and a no-new-data poll both need one, and the cursor-only advance is defined on it.
   */
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
  private static parseCursor(cursor: string): { dev: string; ino: string; offset: number; seal: string } {
    const m = /^(\d+):(\d+):(0|[1-9]\d*):([0-9a-f]{16})$/.exec(cursor);
    if (!m) throw new Error(`JsonlFileSource: malformed cursor ${JSON.stringify(cursor)} (want <dev>:<ino>:<offset>:<seal>)`);
    const offset = Number(m[3]);
    if (!Number.isSafeInteger(offset)) throw new Error(`JsonlFileSource: cursor offset out of range in ${JSON.stringify(cursor)}`);
    return { dev: m[1], ino: m[2], offset, seal: m[4] };
  }

  /**
   * A seal over **the last 512 bytes before the cursor** — a BOUNDED form of the invariant a
   * resumable offset wants: *the bytes immediately before my cursor are still the bytes that were
   * there when I stopped.*
   *
   * **THE BOUND IS PART OF THE GUARANTEE AND IS STATED HERE BECAUSE IT IS NOT THE WHOLE PREFIX.**
   * A rewrite confined to bytes EARLIER than `offset - 512` that preserves the sealed window, the
   * inode and the size is **not detected** — reproduced independently by three reviewers, including
   * with an ordinary same-length in-place PII scrub of earlier transcript lines. That is a real
   * limitation with known edges: a scrub via temp-file+rename changes the inode and IS caught; one
   * that changes length trips the offset/identity path and IS caught; one touching the sealed window
   * IS caught. Only same-inode, same-size, in-place, wholly-outside-the-window escapes.
   *
   * What that costs is bounded and worth naming precisely: the emit path stays correct, because the
   * cursor never moves backwards and forward records are read from bytes the rewrite did not touch.
   * What is lost is the ability to detect that already-consumed on-disk history drifted after we
   * read it. If whole-prefix integrity is ever required, this span must cover it — or the cursor has
   * to carry a rolling hash instead of a window.
   *
   * `dev`/`ino` catch unlink-and-recreate, but **not an in-place rewrite** (`writeFileSync` with no
   * unlink keeps the inode), and that case resumes at a byte offset inside a different document and
   * emits fragments of it as records (`fmae-rev-eng`, CONFIRMED). Size cannot catch it either when
   * the replacement is larger.
   *
   * Note what this deliberately does NOT flag: a rewrite that reproduces the same preceding bytes.
   * There the consumed prefix is genuinely unchanged, so resuming is correct — the seal states an
   * invariant rather than guessing at intent.
   */
  private static async sealAt(fh: FileHandle, offset: number): Promise<string> {
    const span = Math.min(offset, 512); // the WINDOW, not the whole prefix — see the bound above
    const buf = Buffer.allocUnsafe(span);
    if (span > 0) await fh.read(buf, 0, span, offset - span);
    return createHash("sha256").update(buf.subarray(0, span)).digest("hex").slice(0, 16);
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
    // O_NOFOLLOW: a symlinked source is REFUSED, not followed.
    //
    // No seam feeds this class a caller-controlled path today — each connector supplies its own
    // harness-native session file — so this is a fence built before the thing it fences exists.
    // That is deliberate and it is the cheap moment: once a caller-supplied path seam does exist,
    // adding this stops being a fix and becomes a compatibility argument with whoever is already
    // relying on the old behaviour. The same rule the maintenance reader already applies to its
    // resume document (`O_RDONLY | O_NOFOLLOW`), for the same reason.
    const fh = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const st = await fh.stat();
      const size = st.size;
      const dev = String(st.dev), ino = String(st.ino);
      const here = async (offset: number): Promise<string> =>
        `${dev}:${ino}:${offset}:${await JsonlFileSource.sealAt(fh, offset)}`;

      // A fresh adopt starts at the last COMPLETE record boundary, NEVER at the physical end.
      // Adopting mid-line makes the next read parse only the SUFFIX of a record the writer was
      // still appending: adopt at byte 1 of `{"i":1`, let the writer finish `2}\n`, and the source
      // emits `2}` while the real record is `{"i":12}`. That is the truncated-record corruption the
      // partial-line rule exists to prevent, reached through the adopt path instead of the read one.
      if (cursor === undefined)
        return { records: [], cursor: await here(await JsonlFileSource.lastCompleteBoundary(fh, size)) };

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
      // The last 512 bytes of the consumed prefix must still be the bytes we consumed. dev/ino catch
      // unlink-and-recreate; this catches an IN-PLACE rewrite, which keeps the inode and which size
      // cannot see when the replacement is larger. It is a WINDOW, not the whole prefix: a rewrite
      // confined to bytes before `offset - 512` passes here. See `sealAt` for the bound and its edges.
      const seal = await JsonlFileSource.sealAt(fh, from.offset);
      if (seal !== from.seal)
        throw new Error(
          `JsonlFileSource: the bytes before offset ${from.offset} in ${this.path} have changed ` +
            `(seal ${from.seal} -> ${seal}) — the file was rewritten in place, not appended to`,
        );

      if (from.offset === size) return { records: [], cursor: await here(from.offset) };

      const len = size - from.offset;
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, from.offset);
      const chunk = buf.subarray(0, bytesRead);

      // Consume only up to the last newline; anything after it is a line still being written.
      const lastNl = chunk.lastIndexOf(0x0a);
      if (lastNl === -1) return { records: [], cursor: await here(from.offset) };

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

      // PER-RECORD CURSORS, AND THE ARITHMETIC IS IN BYTES BECAUSE THE FILE IS.
      //
      // `complete` is a decoded STRING; the cursor is a BYTE offset. A record containing any
      // non-ASCII character makes `line.length` smaller than the bytes it occupies, so walking the
      // split with character lengths silently mis-places the cursor of every record after the first
      // multi-byte one — and the resume then lands mid-record, which is precisely the truncated-read
      // corruption the partial-line rule exists to prevent. The decode above was FATAL, so `line`
      // re-encodes to exactly the bytes it came from; `Buffer.byteLength` is that re-encoding.
      //
      // A blank line is not a record but it IS bytes, so it advances the offset like any other.
      const records: SourceRecord<T>[] = [];
      let at = from.offset;
      for (const line of complete.split("\n")) {
        at += Buffer.byteLength(line, "utf8") + 1; // + the newline that terminated it
        if (line.trim() === "") continue; // blank separators are not records
        let value: T;
        try {
          value = JSON.parse(line) as T;
        } catch (e) {
          throw new Error(
            `JsonlFileSource: unparseable complete line at offset ~${from.offset} in ${this.path}: ${(e as Error).message}`,
          );
        }
        // One seal per record, computed by the SAME function the batch cursor uses. It is a 512-byte
        // read each, which is the honest cost of not having a second sealing path here — and two
        // places that both compute a cursor would drift exactly the way two places that both compute
        // a size do.
        records.push({ value, cursor: await here(at) });
      }

      const end = from.offset + lastNl + 1;
      // The walk must land exactly on the batch boundary. It is arithmetic over the same bytes, so
      // a disagreement means one of the two is wrong about what was consumed — and the dangerous
      // direction is silent: a short walk hands back a cursor that re-reads records, a long one
      // hands back a cursor that skips them. Cheap to check, and it is checked in the code that
      // RUNS rather than asserted in a comment.
      if (at !== end)
        throw new Error(
          `JsonlFileSource: internal cursor walk ended at ${at} but the batch ends at ${end} in ${this.path}`,
        );
      return { records, cursor: await here(end) };
    } finally {
      await fh.close();
    }
  }
}
