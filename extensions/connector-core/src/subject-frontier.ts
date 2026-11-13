/**
 * The SUBJECT frontier, scoped to the PRINCIPAL rather than to one thread.
 *
 * **ONE TIP FOR EVERY THREAD.** The write-ahead log is keyed per thread, so a new native session
 * opens `virgin` with `lastSubjectSeq: 0`. The subject is keyed per PRINCIPAL:
 * `eventChannelForSession` returns `eventChannel(ep.principal)`, so every thread of one agent
 * shares `events.<owner>.<actor>`. Every publish therefore expects the tip this record holds, which
 * every thread of the principal advances. A thread's own log cannot stand in for it: a new thread
 * would expect an empty subject that the agent's previous sessions already filled, the broker would
 * refuse the publish, and the emitter would halt permanently.
 *
 * **WHAT IT IS NOT.** It is not a cache of something readable. Agent credentials hold neither read
 * shape for the stream, so the tip cannot be looked up, and guessing it is the halt described
 * above. It is writable without any read capability for one reason: the writer learns the
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
import { lstat, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  EVENT_SUBJECT_RECORD_VERSION, SubjectFrontierCorruptError,
  readEventSubjectRecord, recoverEventSubjectTip, recordedEventTip,
  type EventSubjectRecord,
} from "@cotal-ai/core";
export { SubjectFrontierCorruptError } from "@cotal-ai/core";
import { fsyncDir } from "./agui-wal-path.js";

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

// The one value in that family that is well formed and operationally fatal: `MAX_SAFE_INTEGER`
// makes the successor at event-wal.ts unrepresentable and the ack check unsatisfiable, so a
// frontier tip must stay strictly below it while every other safe non-negative integer is fine.
const isFrontierTip = (n: unknown): n is number => isSafeNonNegInt(n) && n < Number.MAX_SAFE_INTEGER;

/** The durable implementation, one file per principal beside that principal's thread directories. */
export class FileSubjectFrontier implements SubjectFrontier {
  private constructor(
    private readonly path: string,
    private doc: EventSubjectRecord,
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
    const record = await readEventSubjectRecord(path, opts);
    if (record === undefined) {
      // ABSENT, so this record has never existed. Before calling the principal virgin, look at the
      // thread logs that already sit beside it. Recovery is persisted only by this writer.
      const recovered = await recoverEventSubjectTip(dirname(path), opts.principal);
      const fresh = new FileSubjectFrontier(path, { v: EVENT_SUBJECT_RECORD_VERSION, space: opts.space, principal: opts.principal, tip: 0 });
      if (recovered > 0) await fresh.write({ ...fresh.doc, tip: recovered });
      return fresh;
    }

    return new FileSubjectFrontier(path, record);
  }

  /** Inspect acknowledged state without writing a recovered record or taking the emitter's lock. */
  static async recordedTip(path: string, opts: { space: string; principal: string }): Promise<number> {
    return recordedEventTip(path, opts);
  }

  async advance(seq: number): Promise<void> {
    return this.serialize(async () => {
      if (!isFrontierTip(seq)) throw new Error(`subject frontier ${this.path}: seq must be a safe non-negative integer below Number.MAX_SAFE_INTEGER, got ${String(seq)}`);
      // VALIDATE BEFORE THE DURABLE WRITE. A bad value written first bricks the record permanently
      // while the call that wrote it reports success, and the next open refuses a file nothing can
      // repair. Fail-closed has to happen before the write, not on the boot after it.
      if (seq <= this.doc.tip)
        throw new Error(`subject frontier ${this.path}: seq=${seq} does not advance the tip ${this.doc.tip}`);
      // THE FILE IS THE FRONTIER; THIS OBJECT IS ONLY A VIEW OF IT, AND THE CHECK ABOVE GRADES THE
      // VIEW. A decrease is refused against the value ON DISK, so the record is re-read here: two
      // views of one record compared only against memory would take it backwards with no error at
      // all, `A.advance(10)` then `B.advance(6)` leaving 6 on disk.
      //
      // A publish does not reach that state, because a stale view publishes a stale `E` and the
      // broker's compare-and-set refuses it before any ack exists to record. The re-read keeps the
      // record monotone without resting that on the broker.
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
    return (await readEventSubjectRecord(this.path, { space: this.doc.space, principal: this.doc.principal }))?.tip;
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

  async reset(): Promise<void> {
    // UNCONDITIONAL, and deliberately not re-read. Abandonment is the one thing that legitimately
    // takes the tip backwards, so a record that moved under this writer is not an obstacle to it:
    // clearing is correct whatever the file currently holds.
    return this.serialize(async () => {
      await this.write({ ...this.doc, tip: 0 });
    });
  }

  /** Atomic replace: sibling temp, fsync, rename, fsync the directory. */
  private async write(next: EventSubjectRecord): Promise<void> {
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      await fh.writeFile(JSON.stringify(next));
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      // A planted link at the record's name must never receive the rename: that would leave the
      // link's TARGET holding the stale document while this principal's own history moved on.
      // Absence is fine (creation stays legal); only a symlink is refused, the same class {@link
      // readEventSubjectRecord} throws on the read side, so the create and read paths agree about links here too.
      let st;
      try {
        st = await lstat(this.path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (st?.isSymbolicLink())
        throw new SubjectFrontierCorruptError(this.path, "a real subject record, never a symlink", "the writer never wrote a symlink");
      await rename(tmp, this.path);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
    // The rename itself must be durable, or a crash can lose the new name and leave the old file:
    // the record would silently go backwards, which is the one direction `advance` refuses.
    //
    // THE SHARED HELPER, NOT A SECOND STRICTER COPY. This sits on the ACK path: on a filesystem
    // that refuses to fsync a directory handle, or under a permission that refuses the open, a copy
    // that let every error propagate would throw HERE on the conditions the directory-creating path
    // already tolerates, after the broker has acknowledged the frame, leaving an ack with no
    // durable record and a halt on the next start. Two paths over the same operation disagreeing
    // about which errors are fatal is a divergence, not a policy.
    await fsyncDir(dirname(this.path));
    this.doc = next;
  }
}
