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
 * MUTATION LEDGER — predicted before the run; ACTUAL recorded after.
 *   M1  drop the zero-byte branch (fall through to parse)  -> predict kills [B1] zero-byte only
 *   M2  weaken acked vintage to `>=`                       -> predict kills the ackSeq cell only
 *   M3  drop the version check                             -> predict kills the wrong-v cell only
 *
 * Run: pnpm smoke:event-wal
 */
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventWal, WalCorruptError, EVENT_WAL_VERSION } from "../src/event-wal.js";

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
const T = { threadId: "th1", principal: "pr1", subjectMayExist: false };
const EXISTS = { ...T, subjectMayExist: true };
let n = 0;
const p = () => join(root, `w${++n}.json`);
const doc = (over: Record<string, unknown> = {}) => JSON.stringify({
  v: EVENT_WAL_VERSION, epoch: "ep1", threadId: "th1", principal: "pr1",
  frontier: { seq: 0, lastSubjectSeq: 0 }, pending: null, ...over,
});

try {
  // ── virgin, and the transitions in order ──
  const w1 = p();
  const wal = await EventWal.open(w1, T);
  c("virgin thread starts at seq 0 / E 0 with a fresh epoch",
    wal.frontier.seq === 0 && wal.frontier.lastSubjectSeq === 0 && wal.epoch.length > 0 && wal.pending === null);

  await wal.beginSend({ id: "id-1", E: 0, seq: 1, sourceCursor: "c1" });
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
          pending: { state: "acked", id: "i", E: 5, seq: 2, sourceCursor: "c2", ackSeq: 6, ...pend } });

  const okAcked = p(); writeFileSync(okAcked, ackedDoc({}, {}));
  const loaded = await EventWal.open(okAcked, EXISTS);
  c("CONTROL: a WELL-FORMED acked pending loads (so the refusals below are not vacuous)",
    loaded.pending?.state === "acked" && loaded.pending.ackSeq === 6);

  const staleAck = p(); writeFileSync(staleAck, ackedDoc({ ackSeq: 5 }, {}));
  await refuses("[B1] acked.ackSeq NOT ahead of the frontier is refused (mixed vintage)",
    "acked.ackSeq > frontier.lastSubjectSeq", () => EventWal.open(staleAck, EXISTS));

  const gapSeq = p(); writeFileSync(gapSeq, ackedDoc({ seq: 4 }, {}));
  await refuses("acked.seq must be exactly the frontier's successor",
    "acked.seq === frontier.seq + 1", () => EventWal.open(gapSeq, EXISTS));

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
    pending: { state: "acked", id: "i", E: 5, seq: 2, sourceCursor: "c2" },
  }));
  await refuses("an acked pending with no ackSeq is refused", "acked.ackSeq present", () => EventWal.open(noAckSeq, EXISTS));

  const badTag = p(); writeFileSync(badTag, doc({ pending: { state: "wat", id: "i", E: 0, seq: 1, sourceCursor: "c" } }));
  await refuses("an unknown pending tag is refused", "pending.state is a known tag", () => EventWal.open(badTag, EXISTS));

  // ── the WAL is 0600, because `pending.id` is a PRE-PUBLICATION SECRET ──
  //    The dedup cache is stream-wide, so an id learned BEFORE its frame is published can be
  //    pre-seeded to make the real publish return `duplicate: true`. The design credits that
  //    safety to randomUUID() entropy, which holds only while the id is unguessable AND unread —
  //    and the only window where it is readable is the one this file holds it in. Asserted on the
  //    file AFTER a rename, because the mode that matters is the surviving inode's, not the temp's.
  const secret = await EventWal.open(p(), T);
  await secret.beginSend({ id: "pre-publication-secret", E: 0, seq: 1, sourceCursor: "c1" });
  const mode = statSync(secret.path).mode & 0o777;
  c("the WAL is 0600 — group and other cannot read a frozen id before it is published", mode === 0o600, mode.toString(8));
  await secret.recordAck(1);
  c("and it is STILL 0600 after a rewrite (the rename must not restore a default mode)",
    (statSync(secret.path).mode & 0o777) === 0o600, (statSync(secret.path).mode & 0o777).toString(8));

  // ── one emit unit is ONE pending frame (`[P8]`) ──
  const single = await EventWal.open(p(), T);
  await single.beginSend({ id: "a", E: 0, seq: 1, sourceCursor: "c1" });
  let refusedSecond = false;
  try { await single.beginSend({ id: "b", E: 0, seq: 2, sourceCursor: "c2" }); } catch { refusedSecond = true; }
  c("[P8] a second pending frame is refused — one emit unit is one pending frame", refusedSecond);

  let refusedAdvance = false;
  try { await single.advanceCursorOnly("c5"); } catch { refusedAdvance = true; }
  c("the cursor cannot advance while a frame is pending", refusedAdvance);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`event-wal smoke: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
