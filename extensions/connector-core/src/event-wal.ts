/**
 * The event emitter's write-ahead log: ONE file per thread, read once at boot.
 *
 * The emitter publishes to a per-principal, per-thread subject under an OPTIMISTIC-CONCURRENCY
 * expectation, so it must know the tip it expects (`E`) and the dedup id it froze — and it must
 * know them across a crash. That is all this file is: the durable half of the state machine in
 * §5.4 of the design, with the transitions kept honest by construction rather than by comment.
 *
 * THE ORDERING RULE THE WHOLE DESIGN RESTS ON. Transition 1 records `sent_unacked` and only THEN
 * publishes; transition 2 records `acked` on a NON-duplicate ack, durably, BEFORE the frontier
 * moves; transition 3 folds the frontier and clears pending. The `acked` state looks redundant
 * until you remove it: an earlier draft committed the cursor and then unlinked pending, on the
 * reasoning that a crash between them would "re-publish, and CAS or in-window dedupe absorbs it".
 * That is false under these same rules. Pending still holds the PRE-STORE `E`, the tip has moved to
 * `E+1`, so recovery takes a CAS loss — which is fail-loud — and the emitter wedges FOREVER on a
 * frame that already landed. Making success durable before the frontier moves is what stops a
 * completed store re-entering the fail-loud path.
 *
 * NOTHING HERE IS EVER REPAIRED. Every unreadable, mixed-vintage or impossible state fails loud.
 * Discarding a WAL is indistinguishable from the case where the frame DID land, so a "recovery"
 * heuristic here is a silent-loss path wearing a helpful face.
 */
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Bump ONLY with a migration. An unknown version fails loud; it is never coerced. */
export const EVENT_WAL_VERSION = 1;

export interface WalFrontier {
  /** The `seq` of the last frame FOLDED into the frontier. 0 before the first frame lands. */
  seq: number;
  /** The subject sequence the next publish must expect (`E`). 0 on a virgin thread. */
  lastSubjectSeq: number;
  /** The durable source position everything up to `seq` was derived from. */
  sourceCursor: string | undefined;
}

export interface WalPending {
  state: "sent_unacked" | "acked";
  /** Frozen at transition 1 and NEVER re-minted — a retry must carry the same id. */
  id: string;
  /** The expectation frozen at transition 1, likewise never recomputed on retry. */
  E: number;
  seq: number;
  sourceCursor: string;
  /** Present iff `state === "acked"`: the sequence the server assigned. */
  ackSeq?: number;
}

export interface WalDoc {
  v: number;
  epoch: string;
  threadId: string;
  principal: string;
  frontier: WalFrontier;
  pending: WalPending | null;
}

/** Every refusal in this file is one of these, so a caller can never mistake it for an I/O blip. */
export class WalCorruptError extends Error {
  constructor(readonly path: string, readonly invariant: string, detail: string) {
    super(`event WAL at ${path} is unusable (${invariant}): ${detail}`);
    this.name = "WalCorruptError";
  }
}

const isSafeNonNegInt = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

/**
 * The boot invariant for an `acked` pending, checked in ONE place and stated positively.
 *
 * A WAL whose frontier is NEWER than its acked pending is a file of MIXED VINTAGE, and the reason
 * that must fail loud rather than "already folded, drop it and continue" is not fussiness. If the
 * frontier came from a later copy than the pending, its `sourceCursor` may ALREADY have advanced
 * past events whose frames were never published — so resuming from it drops those events with no
 * gap anywhere for a consumer to notice. Nothing inside the WAL distinguishes "genuinely folded
 * already" from "this frontier is from a foreign vintage", which puts it in the same class as a
 * corrupt or tuple-mismatched document.
 *
 * Three named relations rather than one compound boolean: an operator who cannot see WHICH relation
 * broke cannot act on it, and a single fused check gives a mutation only one cell to kill.
 */
function assertAckedVintage(path: string, p: WalPending, f: WalFrontier): void {
  if (p.state !== "acked") return;
  if (!isSafeNonNegInt(p.ackSeq))
    throw new WalCorruptError(path, "acked.ackSeq present", `state is "acked" but ackSeq is ${String(p.ackSeq)}`);
  if (!(p.ackSeq > f.lastSubjectSeq))
    throw new WalCorruptError(
      path,
      "acked.ackSeq > frontier.lastSubjectSeq",
      `ackSeq=${p.ackSeq} frontier.lastSubjectSeq=${f.lastSubjectSeq} — the frontier is of a later ` +
        `vintage than the acked frame, so its sourceCursor may already have passed events that were ` +
        `never published; resuming would drop them with no gap for a consumer to see`,
    );
  if (p.seq !== f.seq + 1)
    throw new WalCorruptError(
      path,
      "acked.seq === frontier.seq + 1",
      `pending.seq=${p.seq} frontier.seq=${f.seq} — an acked frame must be exactly the frontier's successor`,
    );
  if (f.sourceCursor !== undefined && p.sourceCursor < f.sourceCursor)
    throw new WalCorruptError(
      path,
      "acked.sourceCursor >= frontier.sourceCursor",
      `pending.sourceCursor=${p.sourceCursor} frontier.sourceCursor=${f.sourceCursor} — the acked ` +
        `frame was derived from source position BEHIND the frontier, which no single vintage produces`,
    );
}

function parseDoc(path: string, raw: string, threadId: string, principal: string): WalDoc {
  let d: unknown;
  try {
    d = JSON.parse(raw);
  } catch (e) {
    throw new WalCorruptError(path, "parseable JSON", (e as Error).message);
  }
  if (typeof d !== "object" || d === null) throw new WalCorruptError(path, "document is an object", typeof d);
  const doc = d as Partial<WalDoc>;

  // Version FIRST: on an unknown version every field below is a guess about a foreign schema.
  if (doc.v !== EVENT_WAL_VERSION)
    throw new WalCorruptError(path, `v === ${EVENT_WAL_VERSION}`, `found v=${String(doc.v)}; a WAL is migrated, never coerced`);

  // The tuple: a WAL that belongs to a different thread or principal is not ours to resume from.
  if (doc.threadId !== threadId)
    throw new WalCorruptError(path, "threadId matches", `WAL threadId=${String(doc.threadId)} caller=${threadId}`);
  if (doc.principal !== principal)
    throw new WalCorruptError(path, "principal matches", `WAL principal=${String(doc.principal)} caller=${principal}`);
  if (typeof doc.epoch !== "string" || doc.epoch.length === 0)
    throw new WalCorruptError(path, "epoch is a non-empty string", String(doc.epoch));

  const f = doc.frontier as Partial<WalFrontier> | undefined;
  if (!f || !isSafeNonNegInt(f.seq) || !isSafeNonNegInt(f.lastSubjectSeq))
    throw new WalCorruptError(path, "frontier is well-formed", JSON.stringify(doc.frontier));
  if (f.sourceCursor !== undefined && typeof f.sourceCursor !== "string")
    throw new WalCorruptError(path, "frontier.sourceCursor is a string or absent", typeof f.sourceCursor);

  let pending: WalPending | null = null;
  if (doc.pending !== null && doc.pending !== undefined) {
    const p = doc.pending as Partial<WalPending>;
    if (p.state !== "sent_unacked" && p.state !== "acked")
      throw new WalCorruptError(path, "pending.state is a known tag", String(p.state));
    if (typeof p.id !== "string" || p.id.length === 0)
      throw new WalCorruptError(path, "pending.id is a non-empty string", String(p.id));
    if (!isSafeNonNegInt(p.E) || !isSafeNonNegInt(p.seq))
      throw new WalCorruptError(path, "pending E/seq are safe non-negative integers", JSON.stringify(p));
    if (typeof p.sourceCursor !== "string")
      throw new WalCorruptError(path, "pending.sourceCursor is a string", typeof p.sourceCursor);
    pending = p as WalPending;
    assertAckedVintage(path, pending, f as WalFrontier);
  }

  return { v: doc.v, epoch: doc.epoch, threadId, principal, frontier: f as WalFrontier, pending };
}

export class EventWal {
  private constructor(
    readonly path: string,
    private doc: WalDoc,
  ) {}

  get epoch(): string { return this.doc.epoch; }
  get frontier(): WalFrontier { return { ...this.doc.frontier }; }
  get pending(): WalPending | null { return this.doc.pending ? { ...this.doc.pending } : null; }

  /**
   * Load an existing WAL, or start a virgin one.
   *
   * `subjectMayExist` is the caller's honest statement about whether this principal+thread could
   * already have published. It is NOT a convenience flag: with it true, a missing or empty WAL is a
   * refusal, because the tip cannot be inferred — agent creds hold no read shape over the subject,
   * and guessing `E := 0` either CAS-halts forever or appends under a stale expectation. Recovery
   * from that state is an explicit operator act, never a startup heuristic.
   */
  static async open(
    path: string,
    opts: { threadId: string; principal: string; subjectMayExist: boolean },
  ): Promise<EventWal> {
    let raw: string | undefined;
    try {
      raw = await readFile(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }

    if (raw === undefined) {
      if (opts.subjectMayExist)
        throw new WalCorruptError(path, "WAL exists when the subject may", "no WAL file, but this thread may already have published");
      return new EventWal(path, EventWal.virgin(opts.threadId, opts.principal));
    }

    // A ZERO-BYTE file is its own case, and the trap this design is shaped to fall into: it reads
    // as "no content, therefore fresh thread, therefore E := 0" — the exact guess the missing-WAL
    // rule already forbids by another route. An atomic temp+rename never produces one; a filesystem
    // that lost the tail does. It is NEVER virgin.
    if (raw.length === 0)
      throw new WalCorruptError(path, "WAL is non-empty", "the file is zero bytes — distinct from missing and never treated as a virgin thread");

    return new EventWal(path, parseDoc(path, raw, opts.threadId, opts.principal));
  }

  private static virgin(threadId: string, principal: string): WalDoc {
    return {
      v: EVENT_WAL_VERSION,
      epoch: randomUUID(),
      threadId,
      principal,
      frontier: { seq: 0, lastSubjectSeq: 0, sourceCursor: undefined },
      pending: null,
    };
  }

  /** Transition 1 — record the frame, with `id` and `E` frozen, BEFORE any publish. */
  async beginSend(frame: { id: string; E: number; seq: number; sourceCursor: string }): Promise<void> {
    if (this.doc.pending) throw new Error(`event WAL ${this.path}: a frame is already pending; one emit unit is one pending frame`);
    await this.write({ ...this.doc, pending: { state: "sent_unacked", ...frame } });
  }

  /**
   * Transition 2 — a NON-duplicate ack becomes durable before the frontier moves.
   * A duplicate ack must never reach here; the caller fails loud on one.
   */
  async recordAck(ackSeq: number): Promise<void> {
    const p = this.doc.pending;
    if (!p || p.state !== "sent_unacked") throw new Error(`event WAL ${this.path}: no sent_unacked frame to ack`);
    await this.write({ ...this.doc, pending: { ...p, state: "acked", ackSeq } });
  }

  /** Transition 3 — fold the acked frame into the frontier and clear pending. */
  async fold(): Promise<void> {
    const p = this.doc.pending;
    if (!p || p.state !== "acked" || p.ackSeq === undefined) throw new Error(`event WAL ${this.path}: no acked frame to fold`);
    await this.write({
      ...this.doc,
      frontier: { seq: p.seq, lastSubjectSeq: p.ackSeq, sourceCursor: p.sourceCursor },
      pending: null,
    });
  }

  /**
   * Transition 4 — a bounded source range that mapped to NOTHING.
   *
   * `[P7]`: a mapper SUCCESS returning zero events advances the cursor atomically and alone — no
   * `seq` consumed, no pending written, no publish. A mapper ERROR never advances it. Empty and
   * failed must not share a path: conflating them turns a parser bug into silently skipped history.
   */
  async advanceCursorOnly(rangeEnd: string): Promise<void> {
    if (this.doc.pending) throw new Error(`event WAL ${this.path}: cannot advance the cursor while a frame is pending`);
    await this.write({ ...this.doc, frontier: { ...this.doc.frontier, sourceCursor: rangeEnd } });
  }

  /**
   * Abandonment — explicit, destructive and TOTAL. Mints a new epoch AND resets `seq`,
   * `lastSubjectSeq` and `sourceCursor` together, reusing the same subject; the new epoch is what
   * tells a consumer the chain broke. Partial abandonment is not a state: either all four move or
   * the emitter stays halted. Required after a filtered channel purge, which returns the subject
   * tip to 0 while the WAL still holds a non-zero `E`, permanently CAS-failing every later publish.
   */
  async abandon(): Promise<void> {
    await this.write({
      ...this.doc,
      epoch: randomUUID(),
      frontier: { seq: 0, lastSubjectSeq: 0, sourceCursor: undefined },
      pending: null,
    });
  }

  /**
   * Durable replace: write a sibling temp file, fsync it, then rename over the target. The rename
   * is what makes a reader see either the whole old document or the whole new one and never a torn
   * prefix — which is precisely why a zero-byte WAL is treated as corruption rather than as virgin.
   *
   * **MODE 0600, AND THE REASON IS NOT TIDINESS: `pending.id` IS A PRE-PUBLICATION SECRET.**
   * The dedup cache the frozen id is checked against is STREAM-WIDE, so anyone who learns an id
   * BEFORE its frame is published can pre-seed it and make the real publish come back
   * `duplicate: true`. The design attributes the safety of that entirely to `randomUUID()` entropy —
   * which holds only while the id is unguessable AND unread. An id already on the wire is harmless
   * (that message has landed); the only window where it is dangerous is exactly the window this
   * file holds it in, between transition 1 and the ack.
   *
   * So the residual a reviewer raised as "gated on a local disk read rather than mesh access" is
   * gated on a read OF THIS FILE. A world-readable WAL would convert a property the design credits
   * to entropy into one credited to filesystem luck. Under our own rules the attack yields a LOUD
   * halt rather than silent loss — a duplicate ack on a retry fails loud with the frontier and
   * cursor unmoved — so this is denial of service, not corruption. Closing it by construction is
   * cheap enough that naming it as an accepted residual would be the worse trade.
   */
  private async write(next: WalDoc): Promise<void> {
    const tmp = join(dirname(this.path), `.${createHash("sha256").update(this.path).digest("hex").slice(0, 12)}.${process.pid}.wal.tmp`);
    const body = JSON.stringify(next);
    const fh = await open(tmp, "w", 0o600);
    try {
      await fh.writeFile(body, "utf8");
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
    this.doc = next;
  }
}
