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
import { assertIdToken, type Part } from "@cotal-ai/core";
import type { BracketState } from "./agui.js";

/**
 * Bump ONLY with a migration. An OLDER document is migrated forward; a NEWER one fails loud.
 *
 * **v2 added `brackets`** — the AG-UI bracket machine's state, persisted so a mid-run restart can
 * continue instead of refusing the first event it re-reads.
 *
 * **THE MIGRATION IS FORWARD-ONLY, AND THAT MAKES THE STATE OUTLIVE A CODE ROLLBACK.** Once a
 * process writes v2, reverting the code does NOT revert the state: the older build refuses the
 * document it now finds. That is the right trade — fail-loud beats silently reading a schema you do
 * not understand — but it converts "revert the commit" into "revert the commit and hand-migrate the
 * state", and the person doing the reverting will otherwise discover that at the worst moment. So
 * the refusal below distinguishes NEWER-than-this-code from unknown, and says which migration.
 * There is deliberately no downgrade path: a lossy downgrade is worse than a halt.
 */
export const EVENT_WAL_VERSION = 2;

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
  /**
   * The frame's parts, FROZEN at transition 1 beside the id and `E` that identify them.
   *
   * Without this the WAL froze what NAMES a frame and not the frame: a restart holding
   * `sent_unacked` recovered the id and the expectation and had nothing to re-publish, so
   * "retry the same frame after a crash" — the one thing this file exists to make possible —
   * could not be performed from the document. `[P2]` requires it and it was absent.
   *
   * It is the parts and not a rendered message because `multicastExpecting` builds the envelope
   * (`ts`, `from`, `space`) at publish time; storing that too would freeze a second copy of fields
   * the publisher owns, and a retry would then carry a stale `ts` under a frozen id.
   */
  body: Part[];
  /** Present iff `state === "acked"`: the sequence the server assigned. */
  ackSeq?: number;
  /**
   * The bracket machine's state AFTER this frame's events (v2).
   *
   * Frozen with the frame rather than derived on fold, for the same reason the body is: the state
   * that belongs to a frame is decided when the frame is decided. Transition 3 promotes it to the
   * document's own `brackets`, so what is persisted always describes exactly the events that have
   * been published AND folded — never a batch that was validated and not yet sent.
   */
  brackets: BracketState;
}

export interface WalDoc {
  v: number;
  /**
   * The space this WAL belongs to — stored because it is a PATH COMPONENT and a path component is
   * not a trusted input (`agui-events.md:683-692`). `principal` and `threadId` were verified on
   * load and `space` was not, so a WAL copied or mis-resolved between two space directories under
   * the same principal and thread LOADED, and one space's frontier was adopted as another's. Two
   * thirds of a three-part guard is not the guard.
   */
  space: string;
  epoch: string;
  threadId: string;
  principal: string;
  frontier: WalFrontier;
  pending: WalPending | null;
  /**
   * The bracket machine at the FOLDED position, or `null` for **unknown** (v2).
   *
   * `null` and an explicitly empty state are different facts and the difference is load-bearing.
   * An empty state is this writer saying "nothing is open"; `null` is a document that cannot say —
   * a WAL migrated from v1, which recorded no bracket state at all. A restart on `null` therefore
   * still takes the lost-state path and still says so, while a restart on a recorded state simply
   * continues. Collapsing the two would make a migrated document silently claim a clean boundary it
   * never observed, which is the same class as treating a zero-byte file as a virgin thread.
   */
  brackets: BracketState | null;
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

/**
 * Validate a persisted bracket state, or refuse it.
 *
 * `nullable` distinguishes the document-level field (which may legitimately be `null` for unknown)
 * from a pending frame's (which never may — a frame that was decided has a state that was decided
 * with it). Passing the same shape check over both is what keeps the two from drifting.
 *
 * The arrays are checked ELEMENT BY ELEMENT rather than by `Array.isArray` alone. A JSON array is a
 * shape a foreign or hand-edited producer can satisfy while carrying numbers or objects, and this
 * value is loaded straight into a `Set` that decides whether an event is refused.
 */
function parseBrackets(path: string, field: string, v: unknown, nullable: boolean): BracketState | null {
  if (v === null && nullable) return null;
  if (typeof v !== "object" || v === null)
    throw new WalCorruptError(path, `${field} is an object${nullable ? " or null" : ""}`, JSON.stringify(v));
  const b = v as Partial<BracketState>;
  if (b.run !== undefined && typeof b.run !== "string")
    throw new WalCorruptError(path, `${field}.run is a string or absent`, JSON.stringify(b.run));
  const lists: Record<string, unknown> = { text: b.text, reasoning: b.reasoning, tools: b.tools };
  for (const [k, list] of Object.entries(lists)) {
    if (!Array.isArray(list) || list.some((x) => typeof x !== "string"))
      throw new WalCorruptError(path, `${field}.${k} is an array of strings`, JSON.stringify(list));
  }
  // A closed run with open messages is not a state any transition can produce: `RUN_FINISHED` is
  // refused while anything it opened is still open. Refusing it here keeps a hand-edited document
  // from restoring a machine into a state the machine itself would never enter.
  if (b.run === undefined && (b.text as string[]).concat(b.reasoning as string[], b.tools as string[]).length > 0)
    throw new WalCorruptError(
      path,
      `${field} has no open run while messages or tool calls are open`,
      JSON.stringify(b),
    );
  return { run: b.run, text: b.text as string[], reasoning: b.reasoning as string[], tools: b.tools as string[] };
}

function parseDoc(path: string, raw: string, space: string, threadId: string, principal: string): WalDoc {
  let d: unknown;
  try {
    d = JSON.parse(raw);
  } catch (e) {
    throw new WalCorruptError(path, "parseable JSON", (e as Error).message);
  }
  if (typeof d !== "object" || d === null) throw new WalCorruptError(path, "document is an object", typeof d);
  const doc = d as Partial<WalDoc>;

  // Version FIRST: on an unknown version every field below is a guess about a foreign schema.
  //
  // NEWER and OLDER are different situations and are answered differently. Older is MIGRATED below.
  // Newer is refused with a message that says the STATE IS NEWER THAN THE CODE and names what
  // introduced it — because "unknown version" sends an operator looking for corruption, and the
  // actual situation is a rollback that left state behind. There is no downgrade: a lossy one would
  // be worse than this halt.
  if (typeof doc.v !== "number" || !Number.isSafeInteger(doc.v) || doc.v < 1)
    throw new WalCorruptError(path, "v is a positive integer", `found v=${String(doc.v)}`);
  if (doc.v > EVENT_WAL_VERSION)
    throw new WalCorruptError(
      path,
      `v <= ${EVENT_WAL_VERSION}`,
      `this WAL is v${doc.v} and this build understands v${EVENT_WAL_VERSION} — THE STATE IS NEWER ` +
        `THAN THE CODE, which is what a code rollback across the v2 migration (persisted bracket ` +
        `state) leaves behind. The migration is forward-only by design: there is no downgrade, ` +
        `because a lossy one would silently discard state this file exists to preserve. Run the ` +
        `newer build, or move this WAL aside and accept that the thread restarts from a new epoch.`,
    );

  // The tuple: a WAL that belongs to a different space, thread or principal is not ours to resume
  // from. All THREE are checked, because all three are hashed path components and the design stores
  // the unhashed tuple inside the file precisely so a collided or mis-resolved directory is a loud
  // mismatch instead of silent cross-talk.
  if (doc.space !== space)
    throw new WalCorruptError(path, "space matches", `WAL space=${String(doc.space)} caller=${space}`);
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

  // A NONZERO FRONTIER MUST CARRY THE POSITION IT WAS DERIVED FROM.
  //
  // This guard was omitted on the reasoning that no shipped transition can produce a nonzero
  // frontier without a cursor — which is exactly backwards. A recovery component must refuse the
  // states its own writer CANNOT produce, because those are precisely the states corruption
  // produces. The happy path is not the input domain.
  //
  // The cost of accepting it is silent loss, and it is not theoretical: the emitter resumes by
  // reading forward from this cursor, and `read(undefined)` does not resume — it ADOPTS AT THE
  // CURRENT END (`durable-source.ts:155-156`). So an absent cursor makes every unread record
  // vanish, transition 4 durably commits the new end, and nothing is left to notice it: no frame
  // published, and therefore no gap in the consumer's `seq` either.
  //
  // A cursor at a ZERO frontier is legal and must stay so — `[P7]`'s cursor-only advance over a
  // source range that mapped to no events is exactly that state, and it is the ONLY asymmetry
  // here. `seq` and `lastSubjectSeq` move together in transition 3 and reset together in
  // abandonment, so a mixed pair is impossible by every shipped transition and refused for the
  // same reason as the missing cursor.
  if ((f.seq === 0) !== (f.lastSubjectSeq === 0))
    throw new WalCorruptError(path, "frontier.seq and lastSubjectSeq are both zero or both nonzero", JSON.stringify(f));
  if ((f.seq > 0 || f.lastSubjectSeq > 0) && typeof f.sourceCursor !== "string")
    throw new WalCorruptError(path, "a nonzero frontier carries its sourceCursor", JSON.stringify(f));

  // A MISSING `pending` KEY IS NOT AN EXPLICIT `null`, AND THE DIFFERENCE IS THE WHOLE POINT.
  // `null` is this writer stating that nothing is outstanding. An ABSENT key is a document that
  // never said — a truncated tail, a hand edit, a foreign producer — and accepting it silently
  // reclassifies "we may have published and do not know" as "we have nothing in flight", which is
  // the one downgrade a write-ahead log must never make on its own authority.
  //
  // ONE check, not two. The first version guarded the absent key with `hasOwnProperty` AND the
  // shape with a `typeof`, and the mutation proof caught the redundancy: deleting the
  // `hasOwnProperty` half killed nothing, because an absent key is `undefined` and the shape check
  // already refuses it with the same invariant. Two mechanisms preventing one outcome means a cell
  // asserting that outcome proves neither of them — so the belt came off and the cells now bite on
  // the one guard that does the work.
  if (doc.pending !== null && typeof doc.pending !== "object")
    throw new WalCorruptError(path, "pending is present (null or an object)",
      doc.pending === undefined ? "the key is absent, which is not the same as null" : typeof doc.pending);

  let pending: WalPending | null = null;
  if (doc.pending !== null) {
    const p = doc.pending as Partial<WalPending>;
    if (p.state !== "sent_unacked" && p.state !== "acked")
      throw new WalCorruptError(path, "pending.state is a known tag", String(p.state));
    if (typeof p.id !== "string" || p.id.length === 0)
      throw new WalCorruptError(path, "pending.id is a non-empty string", String(p.id));
    // ...and it must satisfy the WIRE grammar, not merely be a string. `beginSend` validates with
    // `assertIdToken` on the way IN; open accepted anything non-empty on the way OUT — so a corrupted
    // or hand-edited id (`"has.dots"`) was ADOPTED at recovery and then rejected by
    // `multicastExpecting` on every republish attempt. That turns disk corruption into a permanent
    // runtime wedge instead of a refusal at open, which inverts this file's posture. Validated with
    // the SHIPPED grammar rather than a second copy that could drift from it.
    try {
      assertIdToken(p.id, "event WAL pending.id");
    } catch (e) {
      throw new WalCorruptError(path, "pending.id satisfies the wire id grammar", (e as Error).message);
    }
    if (!isSafeNonNegInt(p.E) || !isSafeNonNegInt(p.seq))
      throw new WalCorruptError(path, "pending E/seq are safe non-negative integers", JSON.stringify(p));
    if (typeof p.sourceCursor !== "string")
      throw new WalCorruptError(path, "pending.sourceCursor is a string", typeof p.sourceCursor);
    // The frozen body must still be PUBLISHABLE, for the reason the id check above exists: a value
    // that the wire rejects, adopted at recovery, turns disk corruption into a permanent wedge
    // rather than a refusal at open.
    //
    // The bar is `multicastExpecting`'s OWN precondition — a non-empty array — and deliberately not
    // core's `isMessagePart`. That predicate is core's INBOUND validator; the publish path does not
    // apply it, so mirroring it here would refuse documents that would in fact publish, and would
    // make this file a second, drifting source of truth about what a part is.
    if (!Array.isArray(p.body) || p.body.length === 0)
      throw new WalCorruptError(path, "pending.body is a non-empty array of parts", JSON.stringify(p.body));
    // A v1 document with a frame IN FLIGHT cannot be migrated, and this is the one migration case
    // that must refuse rather than default. The frame's bracket state is not recoverable from
    // anything in the file, and inventing one would restore a machine into a state that never
    // existed — on the exact path (`sent_unacked` recovery) where a wrong answer republishes.
    // A v1 WAL at REST migrates cleanly; only one mid-flight does not.
    if (doc.v === 1)
      throw new WalCorruptError(
        path,
        "a v1 WAL has no frame in flight",
        `this v1 document holds a ${String((p as { state?: unknown }).state)} frame, and v2 requires the ` +
          `bracket state that belongs to it — which v1 never recorded and nothing here can reconstruct. ` +
          `Let the older build settle this frame first, then start the newer one.`,
      );
    (p as { brackets?: unknown }).brackets = parseBrackets(path, "pending.brackets", (p as { brackets?: unknown }).brackets, false);
    pending = p as WalPending;
    assertPendingVintage(path, pending, f as WalFrontier);
  }

  // v1 KNEW NOTHING ABOUT BRACKETS, so migrating one forward yields `null` — unknown — and NOT an
  // empty state. The document genuinely cannot say what was open when it was written, and saying
  // "nothing was open" on its behalf is inventing an observation it never made.
  const brackets = doc.v === 1 ? null : parseBrackets(path, "brackets", (doc as { brackets?: unknown }).brackets, true);

  return {
    v: EVENT_WAL_VERSION, // MIGRATED IN MEMORY; it reaches disk on the next durable write.
    space,
    epoch: doc.epoch,
    threadId,
    principal,
    frontier: f as WalFrontier,
    pending,
    brackets,
  };
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
  /** The principal this WAL was loaded FOR — exposed so a consumer can prove it is holding its own.
   *  `open()` already refuses a document whose stored principal disagrees, but that check protects
   *  the FILE, not the caller: an emitter handed the wrong WAL object entirely would sail past it. */
  get principal(): string { return this.doc.principal; }
  get threadId(): string { return this.doc.threadId; }
  /** The bracket machine at the folded position, or `null` when the document cannot say (migrated
   *  from v1). The two are different facts; see {@link WalDoc.brackets}. */
  get brackets(): BracketState | null { return this.doc.brackets; }
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
    opts: { space: string; threadId: string; principal: string; subjectMayExist: boolean },
  ): Promise<EventWal> {
    let raw: string | undefined;
    let bytes: Buffer | undefined;
    try {
      bytes = await readFile(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (bytes !== undefined) {
      // FATAL UTF-8 — never `readFile(path, "utf8")`. Node's default decoder SUBSTITUTES U+FFFD for
      // invalid bytes, so a corrupted file arrives as a changed-but-parseable document: a single raw
      // 0xff inside the epoch string loaded cleanly with `epoch` silently rewritten. For a file whose
      // whole posture is that every unreadable state fails loud, "quietly altered and accepted" is
      // the one outcome it must not produce — the identity bytes recovery depends on would be the
      // decoder's invention. `JsonlFileSource` in this same package already decodes fatally for
      // exactly this class; this is that rule applied where it was missing, not a new one.
      try {
        raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new WalCorruptError(path, "the file is valid UTF-8", "invalid UTF-8 bytes; refusing rather than substituting U+FFFD");
      }
    }

    if (raw === undefined) {
      if (opts.subjectMayExist)
        throw new WalCorruptError(path, "WAL exists when the subject may", "no WAL file, but this thread may already have published");
      return new EventWal(path, EventWal.virgin(opts.space, opts.threadId, opts.principal));
    }

    // A ZERO-BYTE file is its own case, and the trap this design is shaped to fall into: it reads
    // as "no content, therefore fresh thread, therefore E := 0" — the exact guess the missing-WAL
    // rule already forbids by another route. An atomic temp+rename never produces one; a filesystem
    // that lost the tail does. It is NEVER virgin.
    if (raw.length === 0)
      throw new WalCorruptError(path, "WAL is non-empty", "the file is zero bytes — distinct from missing and never treated as a virgin thread");

    return new EventWal(path, parseDoc(path, raw, opts.space, opts.threadId, opts.principal));
  }

  private static virgin(space: string, threadId: string, principal: string): WalDoc {
    return {
      v: EVENT_WAL_VERSION,
      space,
      epoch: randomUUID(),
      threadId,
      principal,
      frontier: { seq: 0, lastSubjectSeq: 0, sourceCursor: undefined },
      pending: null,
      // KNOWN empty, not unknown: a virgin thread has published nothing, so "nothing is open" is an
      // observation this writer can actually make.
      brackets: { run: undefined, text: [], reasoning: [], tools: [] },
    };
  }

  /** Transition 1 — record the frame, with `id` and `E` frozen, BEFORE any publish. */
  async beginSend(frame: {
    id: string;
    E: number;
    seq: number;
    sourceCursor: string;
    body: Part[];
    /** The bracket machine AFTER this frame's events — frozen with the frame, promoted on fold. */
    brackets: BracketState;
  }): Promise<void> {
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
    // Refuse an unpublishable body HERE rather than freezing it and discovering it on the retry
    // after a crash — the same reason the id is validated on the way in. Same bar as the load
    // guard and as `multicastExpecting`: non-empty array.
    if (!Array.isArray(frame.body) || frame.body.length === 0)
      throw new Error(`event WAL ${this.path}: a frame body must be a non-empty array of parts`);
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
      // The frame's frozen state becomes the document's, so `brackets` always describes exactly the
      // events that are PUBLISHED AND FOLDED — never a batch that was validated and not yet sent.
      brackets: p.brackets,
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
      // Abandonment is TOTAL, and the bracket machine is part of the total. A new epoch tells a
      // consumer the chain broke, so carrying the old chain's open runs into it would be a partial
      // abandonment — and partial abandonment is not a state.
      brackets: { run: undefined, text: [], reasoning: [], tools: [] },
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
    // reliable; and 0600 comes from the CREATE flags, which is the only place it can come from —
    // `rename` preserves the inode's mode, so there is no post-rename chmod here and this comment
    // does not claim one. The suite asserts the mode on the surviving file, which is where the
    // guarantee has to hold; the code's part is refusing to adopt an existing inode at all.
    // (An earlier version of this sentence said the mode was "asserted on the surviving inode" as
    // though the production path checked it. It does not — the SUITE does. Flagged independently by
    // two reviewers: a comment describing a check that lives somewhere else is the same overclaim
    // class this file's own header warns about.)
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
