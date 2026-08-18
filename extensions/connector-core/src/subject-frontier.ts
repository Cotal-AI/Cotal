/**
 * The SUBJECT frontier, scoped to the PRINCIPAL rather than to one thread.
 *
 * **WHY THIS FILE EXISTS.** The write-ahead log is keyed per thread, so a new native session opens
 * `virgin` with `lastSubjectSeq: 0` and publishes that value as its expectation. The subject is
 * keyed per PRINCIPAL: `eventChannelForSession` returns `eventChannel(ep.principal)`, so every
 * thread of one agent shares `events.<owner>.<actor>`. A virgin frontier therefore expected an
 * empty subject that the agent's own previous session had already filled, the broker refused the
 * publish, and the emitter halted permanently. Measured before this file was written: thread 1
 * published, threads 2 and 3 halted identically. Two correct components with a false assumption
 * between them.
 *
 * **WHAT IT IS NOT.** It is not a cache of something readable. Agent credentials hold neither read
 * shape for the stream, so the tip cannot be looked up, and guessing it is the failure this
 * replaces. It is writable without any read capability for one reason: the writer learns the
 * assigned sequence from its OWN ack, so it only ever records what it was told about a publish it
 * made.
 *
 * **MONOTONE, AND A DECREASE IS REFUSED RATHER THAN ACCEPTED.** The tip only advances. A recorded
 * value lower than the one on disk means either a stale writer or a corrupted file, and writing it
 * would produce an expectation the broker rejects forever with no indication of why. The one thing
 * that legitimately moves the tip backwards is a filtered channel purge, which is an abandonment
 * for every thread on the channel and is therefore an explicit {@link reset}, never an implicit
 * decrease.
 *
 * Durability discipline is the write-ahead log's, deliberately: atomic temp-and-rename, fsync of
 * the file and its directory, fatal UTF-8 decode, 0600, and corruption that refuses rather than
 * guesses.
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The document on disk. Versioned, because a shape change must be refused rather than misread. */
const SUBJECT_FRONTIER_VERSION = 1;

interface SubjectDoc {
  v: number;
  space: string;
  principal: string;
  /** The last sequence the broker assigned to a frame this principal published on its subject. */
  tip: number;
}

/** Every refusal is one of these, so a caller never mistakes it for an I/O blip. */
export class SubjectFrontierCorruptError extends Error {
  constructor(readonly path: string, readonly invariant: string, detail: string) {
    super(`subject frontier ${path}: expected ${invariant} — ${detail}`);
    this.name = "SubjectFrontierCorruptError";
  }
}

/**
 * What the emitter needs from a subject frontier.
 *
 * An INTERFACE rather than only a class, so a suite whose subject is something else can pass a
 * double without a test seam having to exist in shipped code. The one shipped implementation is
 * {@link FileSubjectFrontier}.
 */
export interface SubjectFrontier {
  /** The last sequence assigned on this principal's subject, or 0 if it has never published. */
  readonly tip: number;
  /** Record a newly assigned sequence. Refuses a value that does not advance the tip. */
  advance(seq: number): Promise<void>;
  /** Abandonment: the subject tip genuinely returned to 0, so the record must too. */
  reset(): Promise<void>;
}

const isSafeNonNegInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** The durable implementation, one file per principal beside that principal's thread directories. */
export class FileSubjectFrontier implements SubjectFrontier {
  private constructor(
    private readonly path: string,
    private doc: SubjectDoc,
  ) {}

  get tip(): number {
    return this.doc.tip;
  }

  /**
   * Open, or create a virgin record.
   *
   * A MISSING file is virgin and legal: this principal has never published, which is the ordinary
   * state on a first run and after a fresh install. A ZERO-BYTE file is NOT, for the same reason
   * the write-ahead log refuses one: an atomic temp-and-rename never produces it, so it is a
   * filesystem that lost the tail, and reading it as "never published" is the guess this whole
   * mechanism exists to remove.
   */
  static async open(path: string, opts: { space: string; principal: string }): Promise<FileSubjectFrontier> {
    let bytes: Buffer | undefined;
    try {
      bytes = await readFile(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (bytes === undefined) {
      // ABSENT, so this record has never existed. Before calling the principal virgin, look at the
      // thread logs that already sit beside it. See {@link recoverTipFromThreadLogs}.
      const recovered = await FileSubjectFrontier.recoverTipFromThreadLogs(dirname(path), opts.principal);
      const fresh = new FileSubjectFrontier(path, { v: SUBJECT_FRONTIER_VERSION, space: opts.space, principal: opts.principal, tip: 0 });
      if (recovered > 0) await fresh.write({ ...fresh.doc, tip: recovered });
      return fresh;
    }

    let raw: string;
    try {
      // FATAL decode, never `readFile(path, "utf8")`: Node's default substitutes U+FFFD for invalid
      // bytes, so a corrupted file arrives as a changed-but-parseable document. For a record whose
      // whole posture is that an unreadable state fails loud, "quietly altered and accepted" is the
      // one outcome it must not produce.
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new SubjectFrontierCorruptError(path, "valid UTF-8", "invalid UTF-8 bytes; refusing rather than substituting U+FFFD");
    }
    if (raw.length === 0)
      throw new SubjectFrontierCorruptError(path, "a non-empty file", "the file is zero bytes — distinct from missing, and never treated as virgin");

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new SubjectFrontierCorruptError(path, "parseable JSON", (e as Error).message);
    }
    const d = parsed as Partial<SubjectDoc>;
    if (d?.v !== SUBJECT_FRONTIER_VERSION) throw new SubjectFrontierCorruptError(path, `v === ${SUBJECT_FRONTIER_VERSION}`, String(d?.v));
    if (d.space !== opts.space) throw new SubjectFrontierCorruptError(path, "space matches", `file=${String(d.space)} caller=${opts.space}`);
    // The principal is the whole key of this record: a file belonging to another identity would
    // hand this writer another principal's tip, which is a fabricated frontier of exactly the kind
    // the write-ahead log refuses for the same reason.
    if (d.principal !== opts.principal)
      throw new SubjectFrontierCorruptError(path, "principal matches", `file=${String(d.principal)} caller=${opts.principal}`);
    if (!isSafeNonNegInt(d.tip)) throw new SubjectFrontierCorruptError(path, "tip is a safe non-negative integer", String(d.tip));
    return new FileSubjectFrontier(path, { v: d.v, space: d.space, principal: d.principal, tip: d.tip });
  }

  async advance(seq: number): Promise<void> {
    if (!isSafeNonNegInt(seq)) throw new Error(`subject frontier ${this.path}: seq must be a safe non-negative integer, got ${String(seq)}`);
    // VALIDATE BEFORE THE DURABLE WRITE. A bad value written first bricks the record permanently
    // while the call that wrote it reports success, and the next open refuses a file nothing can
    // repair. Fail-closed has to happen before the write, not on the boot after it.
    if (seq <= this.doc.tip)
      throw new Error(`subject frontier ${this.path}: seq=${seq} does not advance the tip ${this.doc.tip}`);
    await this.write({ ...this.doc, tip: seq });
  }

  /**
   * Recover the tip from the THREAD LOGS beside this record, for an installation upgrading from a
   * release where this record did not exist.
   *
   * **THIS IS THE WHOLE UPGRADE PATH AND LEAVING IT OUT MAKES THE FIX APPLY TO NOBODY WHO ALREADY
   * RAN THE BROKEN VERSION.** My first attempt seeded from the log of the thread being opened, which
   * is empty in the case that matters: upgrading restarts the seat, so the first session after the
   * upgrade is a NEW thread with a virgin log, while the sequence it needs sits in the PREVIOUS
   * thread's log. A cell in `smoke:agui-multi-session` failed on exactly that and is the reason this
   * function exists rather than the reasoning that produced the first version.
   *
   * **ONLY WHEN THE RECORD IS ABSENT, NEVER WHEN IT READS ZERO.** A record holding zero is what
   * abandonment writes after a filtered purge, and re-seeding it from a thread log would silently
   * undo the abandonment and restore an expectation the subject no longer has. Missing and zero are
   * different states and this is the second place in this plane where conflating them is the bug.
   *
   * A sibling that cannot be read or does not parse is FATAL rather than skipped. Skipping it
   * under-counts the tip, which produces a permanent halt later with a message about a moved tip,
   * pointing at everything except the file that was quietly ignored here.
   */
  private static async recoverTipFromThreadLogs(principalDir: string, principal: string): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(principalDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw e;
    }
    let best = 0;
    for (const name of entries) {
      const walPath = join(principalDir, name, "wal.json");
      let raw: Buffer;
      try {
        raw = await readFile(walPath);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") continue; // not a thread directory
        throw e;
      }
      let doc: { principal?: unknown; frontier?: { lastSubjectSeq?: unknown } };
      try {
        doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as typeof doc;
      } catch (e) {
        throw new SubjectFrontierCorruptError(walPath, "a readable thread log while recovering the subject tip", (e as Error).message);
      }
      // A log under another principal's directory is not ours to read a tip from. It cannot happen
      // in the shipped layout, which is why it is checked: a recovery component must refuse the
      // states its own writer cannot produce.
      if (doc.principal !== principal)
        throw new SubjectFrontierCorruptError(walPath, `a thread log for principal ${principal}`, `found ${String(doc.principal)}`);
      const seq = doc.frontier?.lastSubjectSeq;
      if (!isSafeNonNegInt(seq))
        throw new SubjectFrontierCorruptError(walPath, "frontier.lastSubjectSeq is a safe non-negative integer", String(seq));
      if (seq > best) best = seq;
    }
    return best;
  }

  /**
   * Seed a virgin record from a thread that already published before this record existed.
   *
   * **THIS IS THE UPGRADE PATH AND IT IS NOT OPTIONAL.** An installation running the release before
   * this file existed has thread logs holding a real `lastSubjectSeq` and no principal record at
   * all. Opening one virgin would publish an expectation of 0 against a subject that thread already
   * filled, which is the very defect this fixes, reintroduced at the upgrade boundary. Seeding is
   * therefore allowed exactly once, only while the record is virgin, and only from a value a thread
   * log actually holds.
   */
  async seedFromThread(seq: number): Promise<void> {
    if (this.doc.tip !== 0) throw new Error(`subject frontier ${this.path}: refusing to seed a record that already holds tip ${this.doc.tip}`);
    if (!isSafeNonNegInt(seq)) throw new Error(`subject frontier ${this.path}: seed must be a safe non-negative integer, got ${String(seq)}`);
    if (seq === 0) return; // nothing to carry forward
    await this.write({ ...this.doc, tip: seq });
  }

  async reset(): Promise<void> {
    await this.write({ ...this.doc, tip: 0 });
  }

  /** Atomic replace: sibling temp, fsync, rename, fsync the directory. */
  private async write(next: SubjectDoc): Promise<void> {
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      await fh.writeFile(JSON.stringify(next));
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await rename(tmp, this.path);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
    // The rename itself must be durable, or a crash can lose the new name and leave the old file:
    // the record would silently go backwards, which is the one direction `advance` refuses.
    const dh = await open(dirname(this.path), constants.O_RDONLY);
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
    this.doc = next;
  }
}
