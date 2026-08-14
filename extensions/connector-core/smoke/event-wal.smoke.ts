/**
 * `EventWal` — the emitter's durable state machine. No network; this is a file-format and
 * recovery suite.
 *
 * WHAT THIS SUITE IS ACTUALLY FOR. Every interesting case here is a state the WAL must REFUSE, and
 * a refusal suite is the easy place to pass for the wrong reason: a fixture that is malformed in
 * some way OTHER than the one under test still satisfies "must throw". So every refusal cell
 * asserts the NAMED INVARIANT that tripped, not merely that something threw — and each of the three
 * acked-vintage relations is its own cell, because a fused check gives a mutation one place to hide.
 *
 * THE B1 QUESTION, asked before the fixtures were written rather than after: what real input state
 * does no fixture build? B1 survived a full mutation sweep because every fixture happened to end on
 * a record boundary while the code read at physical EOF. The four answers here are the cells marked
 * [B1] — a document truncated MID-WRITE (not between writes), a ZERO-BYTE file (distinct from
 * missing and from `{}`), a frontier of a LATER vintage than its acked pending, and an acked frame
 * derived from a source position BEHIND the frontier. None of them arise from writing whole valid
 * documents, which is all a naive fixture ever does.
 *
 * MUTATION LEDGER — predicted before the run; ACTUAL recorded after. Kill sets name CELLS, never
 * counts: a count cannot tell a real kill from an unrelated early failure. M4-M9 were run through
 * `scratch/wal-mutate.mjs` with a COPY-ASIDE restore, because the tree was dirty and `git checkout`
 * on a mutated file that also holds uncommitted work destroys the work.
 *   M1  drop the zero-byte branch (fall through to parse)  -> predict kills [B1] zero-byte only
 *   M2  weaken acked vintage to `>=`                       -> predict kills the ackSeq cell only
 *   M3  drop the version check                             -> predict kills the wrong-v cell only
 *   M4  drop the nonzero-frontier-carries-its-cursor guard -> KILLED [F2] deleted-cursor, alone
 *   M5  drop the both-zero-or-both-nonzero frontier guard  -> KILLED [F2] mixed-pair, alone
 *   M6  drop the pending-shape guard                       -> KILLED both [F3] cells
 *   M7  drop the space tuple check                         -> KILLED both [F4] cells
 *   M8  drop the frozen-body load guard                    -> KILLED both [F1] refusal cells
 *   M9  stop freezing the body at T1 (writer side)         -> ABORTS the suite; see below
 *
 * M9 IS REPORTED, NOT COUNTED AS A KILL. Removing the body from transition 1 makes every
 * writer-produced fixture unloadable, so the run dies before the summary: it tells you something
 * broke, not WHICH property. That is a known limit of a shared-state refusal suite and is written
 * down rather than dressed up as a clean kill.
 *
 * M6 IS THE ONE WORTH READING. Its first version had TWO guards for the absent `pending` key — a
 * `hasOwnProperty` check and a `typeof` check — and deleting the first killed NOTHING, because an
 * absent key is `undefined` and the second refuses it under the same invariant. Defence in depth
 * defeated the cell: two mechanisms preventing one outcome mean a cell asserting that outcome
 * proves neither. The redundant guard was removed rather than the cell weakened.
 *
 * Run: pnpm smoke:event-wal
 */
import { writeFileSync, readFileSync, mkdtempSync, rmSync, statSync, symlinkSync, constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventWal, WalCorruptError, EVENT_WAL_VERSION, openExclusiveNoFollow } from "../src/event-wal.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) ok++; else { fail++; console.log("  x FAIL:", n, extra ?? ""); }
};

/** Assert a refusal happened AND names the invariant — never merely that something threw. */
async function refuses(what: string, invariant: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    c(what, false, "did NOT throw");
  } catch (e) {
    if (!(e instanceof WalCorruptError)) return c(what, false, `threw ${(e as Error).name}: ${(e as Error).message}`);
    c(what, e.invariant === invariant, `invariant was "${e.invariant}", expected "${invariant}"`);
  }
}

const root = mkdtempSync(join(tmpdir(), "event-wal-"));
const T = { space: "sp1", threadId: "th1", principal: "pr1", subjectMayExist: false };
const EXISTS = { ...T, subjectMayExist: true };
/** A minimal publishable body — the bar `multicastExpecting` sets: a non-empty array of parts. */
const BODY = [{ kind: "text", text: "frame" }] as const;
let n = 0;
const p = () => join(root, `w${++n}.json`);
const doc = (over: Record<string, unknown> = {}) => JSON.stringify({
  v: EVENT_WAL_VERSION, space: "sp1", epoch: "ep1", threadId: "th1", principal: "pr1",
  frontier: { seq: 0, lastSubjectSeq: 0 }, pending: null, ...over,
});

try {
  // ── virgin, and the transitions in order ──
  const w1 = p();
  const wal = await EventWal.open(w1, T);
  c("virgin thread starts at seq 0 / E 0 with a fresh epoch",
    wal.frontier.seq === 0 && wal.frontier.lastSubjectSeq === 0 && wal.epoch.length > 0 && wal.pending === null);

  await wal.beginSend({ id: "id-1", E: 0, seq: 1, sourceCursor: "c1", body: BODY });
  c("T1 records sent_unacked with id and E frozen",
    wal.pending?.state === "sent_unacked" && wal.pending.id === "id-1" && wal.pending.E === 0);
  c("T1 does NOT move the frontier (publish happens after this, never before)",
    wal.frontier.seq === 0 && wal.frontier.lastSubjectSeq === 0);

  await wal.recordAck(7);
  c("T2 makes success durable BEFORE the frontier moves",
    wal.pending?.state === "acked" && wal.pending.ackSeq === 7 && wal.frontier.seq === 0);

  await wal.fold();
  c("T3 folds seq/lastSubjectSeq/sourceCursor together and clears pending",
    wal.frontier.seq === 1 && wal.frontier.lastSubjectSeq === 7 && wal.frontier.sourceCursor === "c1" && wal.pending === null);

  // ── epoch is RECOVERED on restart, never re-minted: a re-emitted frame under a new epoch
  //    changes the consumer tuple and evades dedupe ──
  const epochBefore = wal.epoch;
  const reopened = await EventWal.open(w1, EXISTS);
  c("a restart RECOVERS the epoch rather than minting a new one", reopened.epoch === epochBefore, {
    before: epochBefore, after: reopened.epoch,
  });
  c("a restart recovers the frontier intact",
    reopened.frontier.seq === 1 && reopened.frontier.lastSubjectSeq === 7 && reopened.frontier.sourceCursor === "c1");

  // ── [P7] transition 4: cursor-only advance ──
  await reopened.advanceCursorOnly("c9");
  c("T4 advances the cursor ALONE — no seq consumed, no pending written",
    reopened.frontier.sourceCursor === "c9" && reopened.frontier.seq === 1 && reopened.pending === null);

  // ── abandonment is TOTAL: all four move together, or the emitter stays halted ──
  const epochPre = reopened.epoch;
  await reopened.abandon();
  c("abandonment mints a NEW epoch and resets seq, lastSubjectSeq and sourceCursor together",
    reopened.epoch !== epochPre && reopened.frontier.seq === 0 &&
    reopened.frontier.lastSubjectSeq === 0 && reopened.frontier.sourceCursor === undefined);

  // ── the missing-WAL split: virgin only when the caller can honestly say the subject is new ──
  const fresh = await EventWal.open(p(), T);
  c("a missing WAL on a genuinely new thread is virgin", fresh.frontier.lastSubjectSeq === 0);
  await refuses(
    "a missing WAL on a subject that MAY exist is REFUSED (the tip cannot be inferred)",
    "WAL exists when the subject may",
    () => EventWal.open(p(), EXISTS),
  );

  // ── [B1] ZERO BYTES — distinct from missing, and distinct from `{}`. Only one of those is the
  //    trap: an empty file reads as "no content, therefore fresh thread, therefore E := 0". ──
  const zero = p();
  writeFileSync(zero, "");
  await refuses("[B1] a ZERO-BYTE WAL is refused, never treated as virgin", "WAL is non-empty", () => EventWal.open(zero, T));
  const braces = p();
  writeFileSync(braces, "{}");
  await refuses("[B1] `{}` is a DIFFERENT input from zero bytes and fails on version, not emptiness",
    `v === ${EVENT_WAL_VERSION}`, () => EventWal.open(braces, T));

  // ── [B1] truncated MID-WRITE, not between writes. An atomic temp+rename should never produce
  //    this; a filesystem that lost the tail does. The guarantee is belt (atomicity) AND braces
  //    (a torn document is refused rather than parsed as a prefix). No fixture that writes whole
  //    valid documents ever exercises the braces. ──
  const torn = p();
  const whole = doc({ frontier: { seq: 3, lastSubjectSeq: 9, sourceCursor: "c3" } });
  writeFileSync(torn, whole.slice(0, Math.floor(whole.length * 0.6)));
  await refuses("[B1] a document truncated MID-WRITE is refused, never parsed as a prefix",
    "parseable JSON", () => EventWal.open(torn, T));

  // ── the tuple: a WAL belonging to another thread or principal is not ours to resume ──
  const otherThread = p(); writeFileSync(otherThread, doc({ threadId: "th2" }));
  await refuses("a WAL for a different threadId is refused", "threadId matches", () => EventWal.open(otherThread, T));
  const otherPrincipal = p(); writeFileSync(otherPrincipal, doc({ principal: "pr2" }));
  await refuses("a WAL for a different principal is refused", "principal matches", () => EventWal.open(otherPrincipal, T));

  const badV = p(); writeFileSync(badV, doc({ v: 99 }));
  await refuses("an unknown version is refused, never coerced", `v === ${EVENT_WAL_VERSION}`, () => EventWal.open(badV, T));

  // ── the three ACKED-VINTAGE relations, each its own cell ──
  //    A frontier NEWER than its acked pending is a file of mixed vintage: the frontier's cursor
  //    may already have passed events whose frames were never published, so resuming drops them
  //    with no gap for a consumer to notice. Nothing in the WAL distinguishes that from "already
  //    folded", which is why it joins the corrupt class instead of being repaired.
  const ackedDoc = (pend: Record<string, unknown>, front: Record<string, unknown>) =>
    doc({ frontier: { seq: 1, lastSubjectSeq: 5, sourceCursor: "c1", ...front },
          pending: { state: "acked", id: "i", E: 5, seq: 2, sourceCursor: "c2", body: BODY, ackSeq: 6, ...pend } });

  const okAcked = p(); writeFileSync(okAcked, ackedDoc({}, {}));
  const loaded = await EventWal.open(okAcked, EXISTS);
  c("CONTROL: a WELL-FORMED acked pending loads (so the refusals below are not vacuous)",
    loaded.pending?.state === "acked" && loaded.pending.ackSeq === 6);

  const staleAck = p(); writeFileSync(staleAck, ackedDoc({ ackSeq: 5 }, {}));
  await refuses("[B1] acked.ackSeq NOT ahead of the frontier is refused (mixed vintage)",
    "acked.ackSeq > frontier.lastSubjectSeq", () => EventWal.open(staleAck, EXISTS));

  const gapSeq = p(); writeFileSync(gapSeq, ackedDoc({ seq: 4 }, {}));
  await refuses("a pending frame must be exactly the frontier's successor",
    "pending.seq === frontier.seq + 1", () => EventWal.open(gapSeq, EXISTS));

  // ── THE sent_unacked PATH, WHICH USED TO BE ALMOST UNGUARDED ──
  //    Every relation above ran only for `acked`. `sent_unacked` — the crash window transition 1
  //    exists to survive — loaded with an `E` that disagreed with the frontier, a `seq` that was not
  //    its successor, or an `ackSeq` contradicting its own tag. Recovery would then retry a frozen
  //    expectation that cannot be this frontier's honest successor: permanent CAS halt, or a publish
  //    at the wrong position, with no loud corrupt at open. I wrote three named relations for the
  //    path that had already succeeded and almost none for the one still in flight.
  const sentDoc = (over: Record<string, unknown>) => doc({
    frontier: { seq: 1, lastSubjectSeq: 5, sourceCursor: "c1" },
    pending: { state: "sent_unacked", id: "ok", E: 5, seq: 2, sourceCursor: "c2", body: BODY, ...over },
  });
  const sentOk = p(); writeFileSync(sentOk, sentDoc({}));
  const sentLoaded = await EventWal.open(sentOk, EXISTS);
  c("CONTROL: a well-formed sent_unacked pending loads (so the refusals below are not vacuous)",
    sentLoaded.pending?.state === "sent_unacked");

  const sentAck = p(); writeFileSync(sentAck, sentDoc({ ackSeq: 99 }));
  await refuses("a sent_unacked pending carrying an ackSeq contradicts its own tag",
    "sent_unacked has no ackSeq", () => EventWal.open(sentAck, EXISTS));

  const sentE = p(); writeFileSync(sentE, sentDoc({ E: 0 }));
  await refuses("a frozen E that is not the frontier's tip is refused",
    "pending.E === frontier.lastSubjectSeq", () => EventWal.open(sentE, EXISTS));

  const sentSeq = p(); writeFileSync(sentSeq, sentDoc({ seq: 9 }));
  await refuses("a sent_unacked seq that is not the frontier's successor is refused",
    "pending.seq === frontier.seq + 1", () => EventWal.open(sentSeq, EXISTS));

  // ── THE FOUR STATES A REVIEW FOUND ACCEPTED, EACH DRIVEN FROM A DOCUMENT THE WRITER PRODUCED ──
  //
  //    Every fixture below is written by the SHIPPED writer and then changed in EXACTLY ONE
  //    respect. That is not ceremony: a hand-built document can refuse for a reason unrelated to
  //    the predicate, which is how an absent defect gets recorded as a present one — and the cells
  //    above, all hand-built, are why these four states went unnoticed while this suite was green.
  //
  //    Each acceptance-turned-refusal carries a CONTROL that is the INVERSE of the predicate under
  //    test, because a guard that refuses because it is correct and one that refuses because it is
  //    broken are identical from the refusing side.
  {
    /** Drive the real writer; `folded` runs T1-T2-T3, `pending` stops after T1. */
    const real = async (stage: "pending" | "folded"): Promise<string> => {
      const path = p();
      const w = await EventWal.open(path, T);
      await w.beginSend({ id: "frame-one", E: 0, seq: 1, sourceCursor: "cur-1", body: BODY });
      if (stage === "folded") { await w.recordAck(7); await w.fold(); }
      return path;
    };
    /** Re-write the writer's own document with one field changed. */
    const bend = (src: string, edit: (d: Record<string, unknown>) => void): string => {
      const d = JSON.parse(readFileSync(src, "utf8")) as Record<string, unknown>;
      edit(d);
      const dst = p();
      writeFileSync(dst, JSON.stringify(d));
      return dst;
    };

    // [F1] the frozen body — a WAL that cannot re-publish the frame it froze is not a write-ahead
    //      log. `[P2]` requires it; `WalPending` carried the id and the expectation and no payload.
    const withBody = await real("pending");
    const recovered = await EventWal.open(withBody, EXISTS);
    c("[F1] a restart RECOVERS the frozen body, so the same frame can be re-published",
      JSON.stringify(recovered.pending?.body) === JSON.stringify(BODY), recovered.pending);
    await refuses("[F1] a pending with NO body is refused (it names a frame it cannot reproduce)",
      "pending.body is a non-empty array of parts",
      () => EventWal.open(bend(withBody, (d) => { delete (d.pending as Record<string, unknown>).body; }), EXISTS));
    await refuses("[F1] a pending with an EMPTY body is refused — the wire would reject it too",
      "pending.body is a non-empty array of parts",
      () => EventWal.open(bend(withBody, (d) => { (d.pending as Record<string, unknown>).body = []; }), EXISTS));
    {
      let threw = false;
      const api = await EventWal.open(p(), T);
      try { await api.beginSend({ id: "ok-id", E: 0, seq: 1, sourceCursor: "c", body: [] }); } catch { threw = true; }
      c("[F1] beginSend refuses an empty body BEFORE freezing it, not on the retry after a crash", threw);
    }

    // [F2] a nonzero frontier without the position it was derived from. Accepting it is silent
    //      loss: `read(undefined)` adopts at the current end rather than resuming, so every unread
    //      record is skipped and transition 4 commits the new end with no frame and no seq gap.
    const folded = await real("folded");
    await refuses("[F2] a NONZERO frontier with its sourceCursor deleted is refused",
      "a nonzero frontier carries its sourceCursor",
      () => EventWal.open(bend(folded, (d) => { delete (d.frontier as Record<string, unknown>).sourceCursor; }), EXISTS));
    c("[F2] CONTROL: the same document UNCHANGED still loads (the refusal is the deletion, not the file)",
      (await EventWal.open(folded, EXISTS)).frontier.sourceCursor === "cur-1");
    // [F2] CONTROL, and the inverse of the predicate: a cursor at a ZERO frontier is LEGAL. This is
    //      [P7]'s cursor-only advance over a source range that mapped to no events, and a guard
    //      written as "cursor iff nonzero" would refuse it — breaking a shipped transition to close
    //      a corruption hole. The asymmetry is the point, so it is asserted, not assumed.
    {
      const virgin = await EventWal.open(p(), T);
      await virgin.advanceCursorOnly("cur-only");
      const back = await EventWal.open(virgin.path, EXISTS);
      c("[F2] CONTROL: [P7] a cursor at a ZERO frontier LOADS — cursor-only advance is not corruption",
        back.frontier.sourceCursor === "cur-only" && back.frontier.seq === 0 && back.frontier.lastSubjectSeq === 0);
    }
    await refuses("[F2] a MIXED frontier pair (seq 0, lastSubjectSeq 7) is impossible and refused",
      "frontier.seq and lastSubjectSeq are both zero or both nonzero",
      () => EventWal.open(bend(folded, (d) => { (d.frontier as Record<string, unknown>).seq = 0; }), EXISTS));

    // [F3] absent is not null. `null` is the writer stating nothing is outstanding; an absent key is
    //      a document that never said, and adopting it downgrades "we may have published and do not
    //      know" to "we have nothing in flight" on the WAL's own authority.
    await refuses("[F3] a document whose `pending` KEY IS ABSENT is refused, not read as null",
      "pending is present (null or an object)",
      () => EventWal.open(bend(withBody, (d) => { delete d.pending; }), EXISTS));
    await refuses("[F3] a `pending` that is neither null nor an object is refused",
      "pending is present (null or an object)",
      () => EventWal.open(bend(withBody, (d) => { d.pending = 5; }), EXISTS));
    c("[F3] CONTROL: an EXPLICIT null loads and is the only way to say 'nothing outstanding'",
      (await EventWal.open(bend(withBody, (d) => { d.pending = null; }), EXISTS)).pending === null);

    // [F4] `space` is a hashed path component, and a path component is not a trusted input. The
    //      design stores the unhashed tuple inside the file so a mis-resolved or collided directory
    //      is loud; two of the three members were verified and the third was not.
    await refuses("[F4] a WAL opened under a DIFFERENT space is refused",
      "space matches",
      () => EventWal.open(folded, { ...EXISTS, space: "sp2" }));
    c("[F4] CONTROL: the same file under its OWN space loads (the refusal is the space, not the file)",
      (await EventWal.open(folded, EXISTS)).frontier.seq === 1);
    await refuses("[F4] a document with NO stored space is refused rather than assumed to be ours",
      "space matches",
      () => EventWal.open(bend(folded, (d) => { delete d.space; }), EXISTS));
  }

  // ── THE TRANSITION API REFUSES BEFORE THE DURABLE WRITE, not on the boot after it ──
  {
    const api = await EventWal.open(p(), T);
    for (const bad of [" ", "bad\nid", "a".repeat(65), "has.dots", ""]) {
      let threw = false;
      try { await api.beginSend({ id: bad, E: 0, seq: 1, sourceCursor: "c", body: BODY }); } catch { threw = true; }
      c(`beginSend refuses an id the WIRE would reject: ${JSON.stringify(bad).slice(0, 12)}`, threw);
    }
    let succession = false;
    try { await api.beginSend({ id: "ok-id", E: 3, seq: 1, sourceCursor: "c", body: BODY }); } catch { succession = true; }
    c("beginSend refuses an E that is not the frontier's tip", succession);

    // recordAck(-1) previously ACCEPTED, fold() then persisted lastSubjectSeq = -1, and the NEXT
    // open refused the file — one bad ack durably bricked the WAL while every call reported success.
    await api.beginSend({ id: "ok-id", E: 0, seq: 1, sourceCursor: "c1", body: BODY });
    let ackThrew = false;
    try { await api.recordAck(-1); } catch { ackThrew = true; }
    c("recordAck refuses a negative ackSeq BEFORE the durable write", ackThrew);
    let staleAckThrew = false;
    try { await api.recordAck(0); } catch { staleAckThrew = true; }
    c("recordAck refuses an ackSeq that is not ahead of the frontier's tip", staleAckThrew);
    c("and the WAL is still openable afterwards — a refused ack cannot brick it",
      (await EventWal.open(api.path, EXISTS)).pending?.state === "sent_unacked");
  }

  // ── [B1] REAL CURSORS, ACROSS A DIGIT BOUNDARY. ──
  //
  // The fixtures above use "c0"/"c1"/"c2", which happen to sort lexicographically — and that
  // accident hid a defect in BOTH directions. A real `JsonlFileSource` cursor is
  // `dev:ino:offset:seal`, and string order is not offset order once the digit width changes:
  //
  //   frontier offset 8,   acked pending offset 45  → a healthy WAL was REFUSED  ("45" < "8")
  //   frontier offset 170, acked pending offset 98  → a mixed-vintage one LOADED ("98" > "170")
  //
  // The first wedged recovery on ordinary source growth, on the exact crash window the `acked`
  // state exists to survive. Found by two reviewers independently. The cursor is OPAQUE, so the
  // relation was removed rather than repaired — ordering it needs parsing, and parsing binds this
  // WAL to one source's format. These cells pin that the WAL does NOT order cursors: both load,
  // and the seq relations still do the vintage work.
  //
  // This is the B1 question answered against reality rather than against the fixtures: toy cursors
  // never leave the happy order, so no amount of mutation on the old suite could have found it.
  const realCur = (off: number) => `66309:7734287:${off}:0123456789abcdef`;

  /** Open, converting an UNEXPECTED refusal into a cell failure instead of aborting the suite.
   *  Without this a re-added comparison throws here and the run dies before printing which cell
   *  died — and an illegible kill set is indistinguishable from no mutation testing. */
  const loads = async (what: string, path: string, wantCursor: string) => {
    try {
      const w = await EventWal.open(path, EXISTS);
      c(what, w.pending?.state === "acked" && w.pending.sourceCursor === wantCursor, w.pending);
    } catch (e) {
      c(what, false, `REFUSED: ${(e as { invariant?: string }).invariant ?? (e as Error).message}`);
    }
  };

  const digitCross = p();
  writeFileSync(digitCross, ackedDoc({ sourceCursor: realCur(45) }, { sourceCursor: realCur(8) }));
  await loads("[B1] a real cursor pair across a DIGIT BOUNDARY loads — recovery is not wedged by string order",
    digitCross, realCur(45));

  const lexInverted = p();
  writeFileSync(lexInverted, ackedDoc({ sourceCursor: realCur(98) }, { sourceCursor: realCur(170) }));
  await loads("[B1] and the inverse lexicographic pair also loads — the WAL does not order opaque cursors at all",
    lexInverted, realCur(98));

  const noAckSeq = p(); writeFileSync(noAckSeq, doc({
    frontier: { seq: 1, lastSubjectSeq: 5, sourceCursor: "c1" },
    pending: { state: "acked", id: "i", E: 5, seq: 2, sourceCursor: "c2", body: BODY },
  }));
  await refuses("an acked pending with no ackSeq is refused", "acked.ackSeq present", () => EventWal.open(noAckSeq, EXISTS));

  const badTag = p(); writeFileSync(badTag, doc({ pending: { state: "wat", id: "i", E: 0, seq: 1, sourceCursor: "c", body: BODY } }));
  await refuses("an unknown pending tag is refused", "pending.state is a known tag", () => EventWal.open(badTag, EXISTS));

  // ── the WAL is 0600, because `pending.id` is a PRE-PUBLICATION SECRET ──
  //    The dedup cache is stream-wide, so an id learned BEFORE its frame is published can be
  //    pre-seeded to make the real publish return `duplicate: true`. The design credits that
  //    safety to randomUUID() entropy, which holds only while the id is unguessable AND unread —
  //    and the only window where it is readable is the one this file holds it in. Asserted on the
  //    file AFTER a rename, because the mode that matters is the surviving inode's, not the temp's.
  const secret = await EventWal.open(p(), T);
  await secret.beginSend({ id: "pre-publication-secret", E: 0, seq: 1, sourceCursor: "c1", body: BODY });
  const mode = statSync(secret.path).mode & 0o777;
  c("the WAL is 0600 — group and other cannot read a frozen id before it is published", mode === 0o600, mode.toString(8));
  await secret.recordAck(1);
  c("and it is STILL 0600 after a rewrite (the rename must not restore a default mode)",
    (statSync(secret.path).mode & 0o777) === 0o600, (statSync(secret.path).mode & 0o777).toString(8));

  // ── THE WRITE PATH UNDER A CONTESTED TEMP ──
  //
  // The old write used a temp name derived from `path` + `pid` (predictable) and `open(tmp, "w",
  // 0o600)`. Both halves were exploitable and both were reproduced by reviewers and then here:
  //   - `"w"` does not re-chmod an EXISTING inode, so a planted 0644 temp survived as the WAL's
  //     mode and the file holding `pending.id` — a pre-publication secret by this class's own
  //     argument — ended up world-readable under a comment claiming 0600;
  //   - `"w"` follows symlinks, so a symlink planted at the predicted name made the next transition
  //     truncate an arbitrary file.
  //
  // TWO DEFENCES, AND THE CELLS PROVE THEM SEPARATELY, because a random name makes a plant MISS
  // while the flags make it REFUSE — and only the second is a guarantee. Testing just the outcome
  // would let the flags rot silently behind the randomisation.
  {
    const wd = mkdtempSync(join(tmpdir(), "wal-contested-"));
    try {
      // (a) OUTCOME: a plant at the OLD predictable name no longer captures the WAL's mode.
      const target = join(wd, "w.json");
      const oldStyle = join(wd, `.${createHash("sha256").update(target).digest("hex").slice(0, 12)}.${process.pid}.wal.tmp`);
      writeFileSync(oldStyle, "", { mode: 0o644 });
      const contested = await EventWal.open(target, T);
      await contested.beginSend({ id: "pre-publication-secret", E: 0, seq: 1, sourceCursor: "c1", body: BODY });
      c("a planted 0644 temp does NOT become the WAL's mode — it is 0600 on the surviving inode",
        (statSync(target).mode & 0o777) === 0o600, (statSync(target).mode & 0o777).toString(8));

      // (b) OUTCOME: a symlink planted at the old predictable name does not get written through.
      const victim = join(wd, "victim");
      writeFileSync(victim, "DO_NOT_CLOBBER");
      const t2 = join(wd, "w2.json");
      symlinkSync(victim, join(wd, `.${createHash("sha256").update(t2).digest("hex").slice(0, 12)}.${process.pid}.wal.tmp`));
      const other = await EventWal.open(t2, T);
      await other.beginSend({ id: "x", E: 0, seq: 1, sourceCursor: "c1", body: BODY });
      c("a planted symlink at the old temp name does not get clobbered through",
        readFileSync(victim, "utf8") === "DO_NOT_CLOBBER", readFileSync(victim, "utf8"));

      // (c) THE FLAGS THEMSELVES, tested directly — the guarantee that survives if the name ever
      //     becomes predictable again. O_EXCL must refuse an existing file; O_NOFOLLOW must refuse
      //     a symlink. Without this the randomisation alone would be carrying the whole defence.
      const existing = join(wd, "already-there");
      writeFileSync(existing, "x");
      // Drives the SHIPPED helper, not a locally-composed flag set. The first version of these two
      // cells rebuilt the flags in the test and a mutation reverting the real open to `"w"` left the
      // suite fully green — a cell testing a copy of the rule. Caught by running the mutation.
      let exclCode = "";
      try { const fh = await openExclusiveNoFollow(existing); await fh.close(); } catch (e) { exclCode = String((e as NodeJS.ErrnoException).code); }
      c("the write flags REFUSE an existing file (O_EXCL), not adopt it", exclCode === "EEXIST", exclCode || "did not throw");

      const link = join(wd, "a-symlink");
      symlinkSync(victim, link);
      let followCode = "";
      try { const fh = await openExclusiveNoFollow(link); await fh.close(); } catch (e) { followCode = String((e as NodeJS.ErrnoException).code); }
      c("the write flags REFUSE a symlink (O_NOFOLLOW/O_EXCL), never follow it",
        followCode === "ELOOP" || followCode === "EEXIST", followCode || "did not throw");
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  }

  // ── MUTATIONS ARE SERIALIZED: memory and disk cannot disagree ──
  //    Two concurrent `beginSend` calls both read `this.doc.pending === null` before either durable
  //    replace finished — the guard is an in-memory read, not atomic with the write across its
  //    `await` points. Reviewers reproduced the split (memory "A", disk "B"), which breaks the one
  //    guarantee this file exists for: that `id` and `E` are frozen AND agreed. Note this cell is
  //    inherently racy to observe — my own first reproduction happened to land both on the same
  //    value — so it asserts the INVARIANT (memory === disk, exactly one winner) rather than a
  //    particular winner.
  {
    const rd = mkdtempSync(join(tmpdir(), "wal-concurrent-"));
    try {
      const rp = join(rd, "r.json");
      const w = await EventWal.open(rp, T);
      const settled = await Promise.allSettled([
        w.beginSend({ id: "A", E: 0, seq: 1, sourceCursor: "c1", body: BODY }),
        w.beginSend({ id: "B", E: 0, seq: 2, sourceCursor: "c2", body: BODY }),
      ]);
      const won = settled.filter((r) => r.status === "fulfilled").length;
      c("exactly ONE concurrent beginSend wins; the other is refused cleanly", won === 1, settled.map((r) => r.status));
      const onDisk = JSON.parse(readFileSync(rp, "utf8")).pending?.id;
      c("memory and disk agree on the frozen id after a concurrent race", w.pending?.id === onDisk,
        { memory: w.pending?.id, disk: onDisk });
    } finally {
      rmSync(rd, { recursive: true, force: true });
    }
  }

  // ── one emit unit is ONE pending frame (`[P8]`) ──
  const single = await EventWal.open(p(), T);
  await single.beginSend({ id: "a", E: 0, seq: 1, sourceCursor: "c1", body: BODY });
  let refusedSecond = false;
  try { await single.beginSend({ id: "b", E: 0, seq: 2, sourceCursor: "c2", body: BODY }); } catch { refusedSecond = true; }
  c("[P8] a second pending frame is refused — one emit unit is one pending frame", refusedSecond);

  let refusedAdvance = false;
  try { await single.advanceCursorOnly("c5"); } catch { refusedAdvance = true; }
  c("the cursor cannot advance while a frame is pending", refusedAdvance);
// ── CORRUPTION THIS SUITE'S FIXTURES NEVER BUILT ─────────────────────────────────────────────
//    Every fixture above is written by the shipped code or hand-built as well-formed JSON, so two
//    whole classes of real disk state had no representative here at all: BYTES that are not valid
//    UTF-8, and a persisted field that is the right TYPE but violates the WIRE grammar. Both were
//    accepted on reload by a file whose stated posture is that every unreadable state fails loud.
//    Found by fmae-rev-test with real byte fixtures; confirmed by fmae-rev-eng and fmae-rev-wal.
//
//    Both fixtures below are derived from a document the SHIPPED code wrote and are then changed in
//    exactly ONE respect — otherwise a refusal here could be some other malformation firing a
//    different check, which is what happened on the first two attempts at reproducing this.
{
  const base = p();
  const w = await EventWal.open(base, T);
  await w.beginSend({ id: "id-c1", E: 0, seq: 1, sourceCursor: "cur-1", body: BODY });
  const canonical = readFileSync(base, "utf8");

  // POSITIVE CONTROL: the unmodified document loads. Without it, both refusals below could be the
  // fixture being wrong rather than the guard working.
  await EventWal.open(base, EXISTS);
  c("[control] the unmodified shipped-shape WAL still loads (so the refusals below mean something)", true);

  // 1. ONE byte flipped to 0xff inside the epoch string. Node's default utf8 decoder substitutes
  //    U+FFFD, which turns a corrupted file into a changed-but-parseable one — the identity bytes
  //    recovery trusts would be the decoder's invention.
  const bad = p();
  const buf = Buffer.from(canonical, "utf8");
  const epochAt = buf.indexOf(Buffer.from(String(JSON.parse(canonical).epoch).slice(0, 6)));
  if (epochAt < 0) { c("[fixture] the epoch bytes were locatable for corruption", false, "not found"); }
  else {
    buf[epochAt] = 0xff;
    writeFileSync(bad, buf);
    await refuses("invalid UTF-8 bytes are REFUSED, never silently substituted with U+FFFD",
      "the file is valid UTF-8", () => EventWal.open(bad, EXISTS));
  }

  // 2. The pending id changed to one the wire rejects — the same grammar `beginSend` enforces on
  //    write. Adopting it at recovery would wedge every republish through `multicastExpecting`
  //    forever: disk corruption converted into a permanent runtime failure instead of a refusal.
  for (const badId of ["has.dots", "has space", "a".repeat(65), "has\nnewline"]) {
    const f = p();
    const doc = JSON.parse(canonical);
    doc.pending.id = badId;
    writeFileSync(f, JSON.stringify(doc));
    await refuses(`a persisted pending.id the WIRE rejects is refused at open (${JSON.stringify(badId)})`,
      "pending.id satisfies the wire id grammar", () => EventWal.open(f, EXISTS));
  }

  // CONTROL for the id rule: a VALID id in the same position must still load, or the cells above
  // would pass for a guard that refuses every pending document.
  const okFile = p();
  const okDoc = JSON.parse(canonical);
  okDoc.pending.id = "a-perfectly-valid_ID9";
  writeFileSync(okFile, JSON.stringify(okDoc));
  await EventWal.open(okFile, EXISTS);
  c("[control] a WIRE-VALID pending.id still loads (the rule refuses bad ids, not all ids)", true);
}

} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`event-wal smoke: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
