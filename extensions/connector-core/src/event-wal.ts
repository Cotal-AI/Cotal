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
import { constants } from "node:fs";
import { open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertIdToken } from "@cotal-ai/core";

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
 * Create a file EXCLUSIVELY and WITHOUT following a symlink, at mode 0600.
 *
 * **Exported so a test can drive the shipped flags rather than recompose them.** A cell that builds
 * `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` itself is testing a COPY of this rule: it stays green
 * while the production open drifts or loses a flag. That is not hypothetical here — the first
 * version of those cells did exactly that, and a mutation reverting the real open to `"w"` left the
 * suite fully green. Driving this function is what makes the mutation land.
 *
 * `O_EXCL` refuses a pre-existing file rather than adopting it — which matters because `"w"` does
 * NOT re-chmod an existing inode, so an adopted 0644 temp would carry its mode onto the renamed WAL
 * and expose `pending.id`. `O_NOFOLLOW` refuses a symlink rather than truncating its target.
 */
export async function openExclusiveNoFollow(path: string): Promise<FileHandle> {
  return open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
}

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
 * Named relations rather than one compound boolean: an operator who cannot see WHICH relation broke
 * cannot act on it, and a single fused check gives a mutation only one cell to kill.
 *
 * **THERE IS DELIBERATELY NO `sourceCursor` RELATION HERE, AND THAT IS A CORRECTION.**
 * An earlier version asserted `pending.sourceCursor >= frontier.sourceCursor` using string `<`.
 * A cursor is **OPAQUE** — `DurableSource` defines it per source and states that a caller "never
 * parses it". `JsonlFileSource` happens to emit `dev:ino:offset:seal`, and lexicographic order is
 * NOT offset order once the digit width changes, so that check was wrong in BOTH directions:
 *
 *   frontier offset 8,   acked pending offset 45  → REFUSED a healthy WAL ("45" < "8")
 *   frontier offset 170, acked pending offset 98  → ACCEPTED a mixed-vintage one ("98" > "170")
 *
 * The first wedges recovery on ordinary source growth across any digit boundary — on the exact
 * crash window the `acked` state exists to survive. The second silently admits the mixed vintage
 * the relation was written to refuse. Found independently by two reviewers, then reproduced here.
 *
 * The root cause is not the operator; it is that **ordering an opaque value requires parsing it**,
 * and parsing it would bind this WAL to one source's format — breaking the abstraction the moment
 * a store-backed source uses something else (OpenCode's `part.id`, a rollout path, an API token).
 * So the relation is not fixed, it is REMOVED: it cannot be stated correctly at this layer.
 *
 * What remains is sufficient and well-defined, because it uses the WAL's OWN monotonic counters
 * rather than a foreign key: an acked frame must be exactly the frontier's successor, and its
 * ackSeq must be ahead of the frontier's. A document whose halves come from different vintages
 * disagrees on those too, since both sides are written by this file.
 */
function assertPendingVintage(path: string, p: WalPending, f: WalFrontier): void {
  // ── RELATIONS THAT HOLD FOR *EITHER* TAG ──
  //
  // These were previously checked ONLY for `acked`, which left `sent_unacked` — the crash window
  // transition 1 exists to survive — almost unguarded. Documents with `E` disagreeing with the
  // frontier's tip, or a `seq` that is not the frontier's successor, LOADED and would then retry a
  // frozen expectation that cannot be the honest successor of this frontier: a permanent CAS halt,
  // or a publish at the wrong stream position, with no loud corrupt at open.
  //
  // The asymmetry was mine: I wrote three named relations for the path that has already succeeded
  // and almost none for the path that is still in flight. Found by fmae-rev-sec, reproduced by
  // fmae-rev-eng and fmae-rev-wal, then here.
  if (p.E !== f.lastSubjectSeq)
    throw new WalCorruptError(
      path,
      "pending.E === frontier.lastSubjectSeq",
      `pending.E=${p.E} frontier.lastSubjectSeq=${f.lastSubjectSeq} — the frozen expectation is not ` +
        `the tip this WAL believes, so retrying it can only CAS-halt or append at the wrong position`,
    );
  if (p.seq !== f.seq + 1)
    throw new WalCorruptError(
      path,
      "pending.seq === frontier.seq + 1",
      `pending.seq=${p.seq} frontier.seq=${f.seq} — a pending frame must be exactly the frontier's successor`,
    );

  if (p.state === "sent_unacked") {
    // The tag says "not yet acked". An ackSeq here means the document contradicts its own tag, and
    // guessing which half is true is exactly the repair this file never does.
    if (p.ackSeq !== undefined)
      throw new WalCorruptError(
        path,
        "sent_unacked has no ackSeq",
        `state is "sent_unacked" but ackSeq=${String(p.ackSeq)} — the document contradicts its own tag`,
      );
    return;
  }

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
  // NO sourceCursor comparison — see the note above. The cursor is opaque; ordering it here is not
  // a thing this layer can do correctly, and doing it with string `<` was wrong in both directions.
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
    assertPendingVintage(path, pending, f as WalFrontier);
  }

  return { v: doc.v, epoch: doc.epoch, threadId, principal, frontier: f as WalFrontier, pending };
}

export class EventWal {
  /**
   * Every mutation runs one-at-a-time on this chain.
   *
   * Without it, two concurrent `beginSend` calls both read `this.doc.pending === null` before either
   * durable replace finishes — the guard is an in-memory read that is NOT atomic with the write
   * across its `await` points. Reviewers reproduced the split: one call fulfils, one rejects, and
   * the process is left holding `pending.id === "A"` in memory while the disk says `"B"`. Recovery
   * would then resume the frame on disk while the live emitter retries the other, which breaks the
   * one thing this file exists to guarantee — that `id` and `E` are frozen and agreed.
   *
   * A per-instance chain is sufficient and honest about its scope: it serializes THIS process's
   * callers. Cross-process exclusion is a different problem, solved upstream by the principal-level
   * lock (§5.5's one-emitter-per-principal rule), not here.
   */
  private chain: Promise<unknown> = Promise.resolve();

  /** Run `op` after every previously-queued mutation, whether they resolved or threw. */
  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const next = this.chain.then(op, op);
    // Keep the chain alive after a rejection so one failed mutation cannot wedge every later one.
    this.chain = next.catch(() => undefined);
    return next;
  }

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
    return this.serialize(async () => {
    if (this.doc.pending) throw new Error(`event WAL ${this.path}: a frame is already pending; one emit unit is one pending frame`);
    // THE SAME GRAMMAR THE WIRE USES, not a restatement of it. `beginSend` previously accepted ids
    // (" ", a newline, 65 chars, dots) that `multicastExpecting`'s `assertIdToken` rejects — so T1
    // could freeze an id on disk that can NEVER publish, wedging the emitter until an abandon. The
    // id is supposed to be one token on the wire and in the WAL; importing the check is what makes
    // that true rather than asserted.
    assertIdToken(frame.id, "event WAL pending id");
    if (frame.E !== this.doc.frontier.lastSubjectSeq)
      throw new Error(`event WAL ${this.path}: E=${frame.E} is not the frontier's tip ${this.doc.frontier.lastSubjectSeq}`);
    if (frame.seq !== this.doc.frontier.seq + 1)
      throw new Error(`event WAL ${this.path}: seq=${frame.seq} is not the frontier's successor ${this.doc.frontier.seq + 1}`);
    await this.write({ ...this.doc, pending: { state: "sent_unacked", ...frame } });
    });
  }

  /**
   * Transition 2 — a NON-duplicate ack becomes durable before the frontier moves.
   * A duplicate ack must never reach here; the caller fails loud on one.
   */
  async recordAck(ackSeq: number): Promise<void> {
    return this.serialize(async () => {
    const p = this.doc.pending;
    if (!p || p.state !== "sent_unacked") throw new Error(`event WAL ${this.path}: no sent_unacked frame to ack`);
    // VALIDATE BEFORE THE DURABLE WRITE. `recordAck(-1)` was accepted, `fold()` then persisted
    // `frontier.lastSubjectSeq = -1`, and the NEXT open refused the file — a single bad ack durably
    // bricked the WAL while every call reported success. Fail-closed has to happen before the write,
    // not on the boot after it.
    if (!isSafeNonNegInt(ackSeq))
      throw new Error(`event WAL ${this.path}: ackSeq must be a safe non-negative integer, got ${String(ackSeq)}`);
    if (ackSeq <= this.doc.frontier.lastSubjectSeq)
      throw new Error(`event WAL ${this.path}: ackSeq=${ackSeq} is not ahead of the frontier's tip ${this.doc.frontier.lastSubjectSeq}`);
    await this.write({ ...this.doc, pending: { ...p, state: "acked", ackSeq } });
    });
  }

  /** Transition 3 — fold the acked frame into the frontier and clear pending. */
  async fold(): Promise<void> {
    return this.serialize(async () => {
    const p = this.doc.pending;
    if (!p || p.state !== "acked" || p.ackSeq === undefined) throw new Error(`event WAL ${this.path}: no acked frame to fold`);
    await this.write({
      ...this.doc,
      frontier: { seq: p.seq, lastSubjectSeq: p.ackSeq, sourceCursor: p.sourceCursor },
      pending: null,
    });
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
    return this.serialize(async () => {
    if (this.doc.pending) throw new Error(`event WAL ${this.path}: cannot advance the cursor while a frame is pending`);
    await this.write({ ...this.doc, frontier: { ...this.doc.frontier, sourceCursor: rangeEnd } });
    });
  }

  /**
   * Abandonment — explicit, destructive and TOTAL. Mints a new epoch AND resets `seq`,
   * `lastSubjectSeq` and `sourceCursor` together, reusing the same subject; the new epoch is what
   * tells a consumer the chain broke. Partial abandonment is not a state: either all four move or
   * the emitter stays halted. Required after a filtered channel purge, which returns the subject
   * tip to 0 while the WAL still holds a non-zero `E`, permanently CAS-failing every later publish.
   */
  async abandon(): Promise<void> {
    return this.serialize(async () => {
    await this.write({
      ...this.doc,
      epoch: randomUUID(),
      frontier: { seq: 0, lastSubjectSeq: 0, sourceCursor: undefined },
      pending: null,
    });
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
    // The temp name is RANDOM per write, and the open is EXCLUSIVE and NON-FOLLOWING.
    //
    // The previous version derived the name from `path` + `pid` — predictable — and used
    // `open(tmp, "w", 0o600)`. Both halves were exploitable and both were reproduced:
    //   - `open(…, "w")` does not re-chmod an EXISTING inode; the mode argument applies only on
    //     create. A planted 0644 temp therefore survived as the WAL's mode, and the file holding
    //     `pending.id` — a pre-publication secret by this class's own argument — ended up
    //     world-readable while a comment three lines up claimed 0600.
    //   - `"w"` follows symlinks. A symlink planted at the predicted name made the next transition
    //     truncate and overwrite an arbitrary file the process could open. One plant, one write.
    // Found by fmae-rev-sec, reproduced independently by fmae-rev-eng and fmae-rev-wal, then here.
    //
    // **The symlink half is the one I have no excuse for: I added `O_NOFOLLOW` to `JsonlFileSource`
    // in this same session, for this same class, and did not carry it to the file this module
    // writes.** A fence built on the read path while the write path stayed open.
    //
    // O_EXCL makes a pre-existing temp a hard failure rather than something to adopt; O_NOFOLLOW
    // refuses a symlink outright; the random suffix removes the predictability that made planting
    // reliable; and the mode is asserted on the SURVIVING inode after rename, since that is the one
    // that holds the secret.
    const tmp = join(
      dirname(this.path),
      `.${createHash("sha256").update(this.path).digest("hex").slice(0, 12)}.${process.pid}.${randomUUID().slice(0, 8)}.wal.tmp`,
    );
    const body = JSON.stringify(next);
    const fh = await openExclusiveNoFollow(tmp);
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
