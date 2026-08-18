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
import { lstat, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { fsyncDir } from "./agui-wal-path.js";

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
 * The record on disk is not the one this view was opened from, so this writer's number is not the
 * one to write.
 *
 * DISTINCT FROM CORRUPTION: the file is perfectly well formed, it just belongs to a later state
 * than this object remembers. Both are refusals rather than repairs, and telling them apart is what
 * lets an operator know whether to look at the filesystem or at a second writer.
 */
export class SubjectFrontierMovedError extends Error {
  constructor(readonly path: string, readonly viewTip: number, readonly diskTip: number | undefined) {
    super(
      `subject frontier ${path}: the record moved under this writer (this view holds ${viewTip}, ` +
        `the file holds ${diskTip === undefined ? "no record at all" : diskTip}). The tip is shared by ` +
        `every thread of the principal, so writing this view's number would take the record backwards ` +
        `to a sequence the broker has already passed, and every later publish would expect a tip the ` +
        `subject no longer has.`,
    );
    this.name = "SubjectFrontierMovedError";
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

    return new FileSubjectFrontier(path, FileSubjectFrontier.parse(path, bytes, opts));
  }

  /**
   * Bytes to a validated document, or a refusal.
   *
   * SHARED BY `open` AND BY THE RE-READ IN {@link advance} on purpose. A record that went corrupt
   * underneath a live writer has to meet the same wall as one that was corrupt at boot; validating
   * only on the way in would let a writer that opened a good file overwrite a bad one, which
   * destroys the evidence of whatever produced it.
   */
  private static parse(path: string, bytes: Buffer, opts: { space: string; principal: string }): SubjectDoc {
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
    return { v: d.v, space: d.space, principal: d.principal, tip: d.tip };
  }

  async advance(seq: number): Promise<void> {
    return this.serialize(async () => {
      if (!isSafeNonNegInt(seq)) throw new Error(`subject frontier ${this.path}: seq must be a safe non-negative integer, got ${String(seq)}`);
      // VALIDATE BEFORE THE DURABLE WRITE. A bad value written first bricks the record permanently
      // while the call that wrote it reports success, and the next open refuses a file nothing can
      // repair. Fail-closed has to happen before the write, not on the boot after it.
      if (seq <= this.doc.tip)
        throw new Error(`subject frontier ${this.path}: seq=${seq} does not advance the tip ${this.doc.tip}`);
      // THE FILE IS THE FRONTIER; THIS OBJECT IS ONLY A VIEW OF IT, AND THE CHECK ABOVE GRADES THE
      // VIEW. The header of this file says a decrease is refused because it is lower than the one
      // ON DISK, and until this line the comparison was against memory, so two views of one record
      // took it backwards with no error at all: `A.advance(10)` then `B.advance(6)` left 6 on disk.
      //
      // NOT REACHABLE THROUGH A PUBLISH TODAY, AND THAT IS EXACTLY WHY IT IS GUARDED. A view that
      // has gone stale publishes a stale `E`, and the broker's compare-and-set refuses it before
      // any ack exists to record, so JetStream is what holds this file monotone right now.
      // Measured, not assumed: two emitters on one principal, the second opened early, halted on
      // `wrong last sequence` with the record still holding the first one's number. That is the
      // same shape the released defect shipped on, two correct components with an assumption
      // standing where a guard belongs, so the assumption becomes a guard here too.
      const disk = await this.readDiskTip();
      // ABSENT IS NOT ZERO, and this is the third place in this plane where conflating them is the
      // bug. A missing record is legal only for a view that has not written one either; a view
      // holding a tip whose file has gone is a record something removed underneath a live writer,
      // and re-creating it would resurrect a frontier that was deliberately or accidentally cleared.
      if (disk === undefined ? this.doc.tip !== 0 : disk !== this.doc.tip)
        throw new SubjectFrontierMovedError(this.path, this.doc.tip, disk);
      await this.write({ ...this.doc, tip: seq });
    });
  }

  /**
   * The tip the FILE holds, or `undefined` when no record exists yet.
   *
   * Fully validated, not a bare `JSON.parse().tip`: the disagreement this feeds is decided on a
   * number, and a number taken from a document that failed its own shape checks is not evidence.
   */
  private async readDiskTip(): Promise<number | undefined> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
    return FileSubjectFrontier.parse(this.path, bytes, { space: this.doc.space, principal: this.doc.principal }).tip;
  }

  /**
   * One mutation at a time on THIS instance.
   *
   * The re-read above is a read-modify-write, so two callers that interleave between the read and
   * the rename would both pass a check neither still satisfies. One frontier is legitimately bound
   * to SEVERAL logs (the pinning runs the other way: a log may not change which record it
   * publishes onto), so concurrent callers on one instance are an ordinary state, not a misuse.
   *
   * It serializes this instance and nothing else. Two instances have two chains, which is the case
   * the re-read exists for.
   */
  private chain: Promise<unknown> = Promise.resolve();
  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const next = this.chain.then(op, op);
    // Keep the chain alive after a rejection so one refused write cannot wedge every later one.
    this.chain = next.catch(() => undefined);
    return next;
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
    let entries: Dirent[];
    try {
      entries = await readdir(principalDir, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw e;
    }
    let best = 0;
    for (const ent of entries) {
      // THE SCAN MAY NOT BE WALKED OUTSIDE THE PRINCIPAL DIRECTORY. The writer that creates these
      // directories refuses a symlinked component (`ensureDirNoSymlink`), so a symlink here is a
      // state it cannot produce, and following one would take a tip from a log belonging to some
      // other tree. The create path and the recovery path have to agree about that or the guard is
      // only on the half nobody attacks.
      if (ent.isSymbolicLink())
        throw new SubjectFrontierCorruptError(join(principalDir, ent.name), "a real directory beside the record, never a symlink", "following it would carry this scan outside the principal directory, and the writer that creates these directories refuses a symlinked component for the same reason");
      if (!ent.isDirectory()) continue; // the record itself, the lock, anything else that is not a thread
      const walPath = join(principalDir, ent.name, "wal.json");
      // The entry check above clears the DIRECTORY and stops there, so a real thread directory
      // holding a symlinked `wal.json` reaches the same foreign log by one more hop. Two layers,
      // and they are not redundant:
      //
      //  - `lstat` is the GRADED guard and the portable one. It decides the refusal on every
      //    platform, which matters because `O_NOFOLLOW` does not exist on Windows and a guard that
      //    silently evaporates there is worse than one that was never claimed.
      //  - `O_NOFOLLOW` narrows the window between the `lstat` and the `open`, where the file could
      //    be replaced by a link. It applies to the FINAL COMPONENT ONLY, so a thread directory
      //    swapped for a link in that same window is still followed; closing that would take an
      //    `openat` walk per component, which this scan does not do. NO CELL CAN GRADE EITHER
      //    WINDOW, and the mutation config says so rather than registering a mutant that would
      //    survive and be explained away.
      let st;
      try {
        st = await lstat(walPath);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") continue; // not a thread directory
        throw e;
      }
      if (st.isSymbolicLink())
        throw new SubjectFrontierCorruptError(walPath, "a real thread log, never a symlink", "following it would read a log this principal's writer never wrote");
      // A HARD link is not a symlink and neither check above sees one, so a log hardlinked into
      // this directory from elsewhere reads as an ordinary file and hands over its tip. The writer
      // creates each log fresh, so more than one name for it is a state it cannot produce, which
      // is the same reason the symlink is refused rather than resolved.
      if (st.nlink > 1)
        throw new SubjectFrontierCorruptError(walPath, "a thread log with exactly one name", `it has ${st.nlink}, so the same file is reachable from outside this principal's directory and its tip is not this principal's to read`);
      let raw: Buffer;
      try {
        const fh = await open(walPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          raw = await fh.readFile();
        } finally {
          await fh.close();
        }
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") continue;
        if (code === "ELOOP")
          throw new SubjectFrontierCorruptError(walPath, "a real thread log, never a symlink", "the file became a symlink between the check and the open");
        throw e;
      }
      let doc: { principal?: unknown; frontier?: { lastSubjectSeq?: unknown }; pending?: { state?: unknown; ackSeq?: unknown } | null };
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
      // AN ACKED PENDING HOLDS A SEQUENCE THE BROKER ASSIGNED AND THE FRONTIER DOES NOT.
      //
      // A log that took an ack and died before folding keeps the assigned sequence in
      // `pending.ackSeq`, which `EventWal` requires to be strictly AHEAD of
      // `frontier.lastSubjectSeq` (that is the crash window the acked state exists to survive).
      // Reading the frontier alone recovers the older number, persists it, and hands the next
      // publish an expectation the subject passed some time ago. The session that could fold it
      // will never run again, because upgrading forks the session id, so this log is the only
      // place that sequence survives. Under-counting here is the same defect this file fixes,
      // reintroduced at the one boundary the file exists for.
      const pending = doc.pending;
      if (pending && pending.state === "acked") {
        const acked = pending.ackSeq;
        if (!isSafeNonNegInt(acked))
          throw new SubjectFrontierCorruptError(walPath, "an acked pending carries a safe non-negative ackSeq", String(acked));
        if (!(acked > seq))
          throw new SubjectFrontierCorruptError(walPath, "an acked pending is ahead of the frontier it will fold into", `ackSeq=${acked} frontier.lastSubjectSeq=${seq}`);
        if (acked > best) best = acked;
      }
      // A `sent_unacked` PENDING IS PASSED OVER DELIBERATELY, AND NOT BECAUSE NOTHING WAS ASSIGNED.
      //
      // An earlier description of this scan said the broker assigned nothing to such a frame. That
      // is the one thing the state does not know: the frame went out and the acknowledgement was
      // never observed, so the subject may or may not have taken it. What is certain is structural
      // and about the log rather than the broker: `sent_unacked` carries no `ackSeq` at all, and a
      // document that pairs the two is refused as contradicting its own tag. There is therefore no
      // sequence in it to fold, and inventing one, `frontier.lastSubjectSeq + 1` for instance, would
      // assert an assignment nobody saw.
      //
      // The residue is real and is left standing on purpose. If the broker did assign a sequence to
      // that frame, this scan recovers a number one short of the tip, and the next publish halts on
      // a moved tip rather than publishing into a gap or overwriting anything. That is the safe
      // direction of the two, it is the halt this file's message now explains, and its remedy is the
      // one the message names. The owning session would have republished the frozen id and let the
      // broker deduplicate, but that session is exactly what an upgrade forks away from, which is
      // why the case reaches here at all.
    }
    return best;
  }

  // `seedFromThread` used to live here, and it is GONE rather than kept for a caller that might
  // want it. Recovery moved into `open`, which is the only place that can see every sibling log,
  // and what was left behind was a public method that writes a tip into a record whose only
  // precondition is that the record reads 0. A record reading 0 is exactly what abandonment writes
  // after a channel purge, so the leftover was a supported route back into the state this file
  // exists to prevent, with no shipped caller to justify it.

  async reset(): Promise<void> {
    // UNCONDITIONAL, and deliberately not re-read. Abandonment is the one thing that legitimately
    // takes the tip backwards, so a record that moved under this writer is not an obstacle to it:
    // clearing is correct whatever the file currently holds.
    return this.serialize(async () => {
      await this.write({ ...this.doc, tip: 0 });
    });
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
    //
    // THE SHARED HELPER, NOT A SECOND STRICTER COPY. This was an inline open/sync that let every
    // error propagate, and it sits on the ACK path: on a filesystem that refuses to fsync a
    // directory handle, or under a permission that refuses the open, the same conditions the
    // directory-creating path already tolerates would throw HERE, after the broker has acknowledged
    // the frame, leaving an ack with no durable record and a halt on the next start. Two paths over
    // the same operation disagreeing about which errors are fatal is a divergence, not a policy.
    await fsyncDir(dirname(this.path));
    this.doc = next;
  }
}
