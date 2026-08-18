/**
 * The principal-scoped subject frontier: the states it refuses, and the two it must never conflate.
 *
 * **MISSING IS NOT ZERO, AND THAT DISTINCTION IS THE FILE.** An ABSENT record means this principal
 * has never published, and the tip may then be recovered from the thread logs beside it, which is
 * the upgrade path for an installation that already ran the broken release. A record that READS
 * ZERO is what abandonment writes after a filtered purge, and recovering a tip into it would
 * silently undo the abandonment and restore an expectation the subject no longer has. The same
 * conflation, missing versus zero, is already a named hazard one layer down in the write-ahead log.
 *
 * **AND A SIBLING THAT CANNOT BE READ IS FATAL RATHER THAN SKIPPED.** Skipping it under-counts the
 * tip, which does not fail here: it fails later, permanently, with a message about a moved subject
 * tip that points at everything except the file that was quietly ignored.
 *
 * **AND THE RECORD IS THE FILE, NOT A VIEW OF IT.** This object's own `tip` grades the caller; the
 * bytes on disk grade the write. Two views of one record used to take the tip BACKWARDS with no
 * error at all, because `advance` compared against memory while the header of the implementation
 * said it compared against disk. Not reachable through a publish, measured rather than assumed: a
 * stale view publishes a stale expectation and JetStream's compare-and-set refuses it before any
 * ack exists to record. It is guarded anyway, because "no shipped path reaches it, recorded in
 * prose" is the exact argument the released defect shipped on.
 *
 * Run: pnpm smoke:subject-frontier
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSubjectFrontier, SubjectFrontierCorruptError, SubjectFrontierMovedError } from "../src/subject-frontier.js";

let ok = 0,
  fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) ok++;
  else {
    fail++;
    console.log("  x FAIL:", n, extra ?? "");
  }
};
const threw = async (n: string, fn: () => Promise<unknown>, wants: RegExp) => {
  try {
    await fn();
    c(n, false, "did not throw");
  } catch (e) {
    c(n, wants.test((e as Error).message), (e as Error).message);
  }
};

const root = mkdtempSync(join(tmpdir(), "subj-frontier-"));
const SPACE = "sp";
const P = "local.aaa";
let n = 0;
const dir = () => {
  const d = join(root, `d${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const walFor = (principalDir: string, thread: string, lastSubjectSeq: number, principal = P) => {
  const td = join(principalDir, thread);
  mkdirSync(td, { recursive: true });
  writeFileSync(join(td, "wal.json"), JSON.stringify({
    v: 2, gen: 1, space: SPACE, epoch: "e", threadId: thread, principal,
    frontier: { seq: lastSubjectSeq > 0 ? 1 : 0, lastSubjectSeq, sourceCursor: lastSubjectSeq > 0 ? "cur" : undefined },
    pending: null, brackets: { run: undefined, text: [], reasoning: [], tools: [] },
  }));
};

try {
  // ---------------------------------------------------------------- virgin
  {
    const d = dir();
    const f = await FileSubjectFrontier.open(join(d, "subject.json"), { space: SPACE, principal: P });
    c("virgin:a-principal-that-never-published-reads-zero", f.tip === 0, f.tip);
    c("virgin:opening-a-virgin-record-writes-NO-file", (() => { try { readFileSync(join(d, "subject.json")); return false; } catch { return true; } })());
  }

  // ---------------------------------------------------------------- advance
  {
    const d = dir();
    const p = join(d, "subject.json");
    const f = await FileSubjectFrontier.open(p, { space: SPACE, principal: P });
    await f.advance(7);
    c("advance:the-tip-moves", f.tip === 7, f.tip);
    const reopened = await FileSubjectFrontier.open(p, { space: SPACE, principal: P });
    c("advance:the-tip-is-DURABLE-across-a-reopen", reopened.tip === 7, reopened.tip);
    await threw("advance:a-value-that-does-not-move-the-tip-is-REFUSED", () => f.advance(7), /does not advance the tip/);
    await threw("advance:a-value-BELOW-the-tip-is-refused", () => f.advance(3), /does not advance the tip/);
    await threw("advance:a-non-integer-is-refused-BEFORE-the-write", () => f.advance(1.5), /safe non-negative integer/);
    const still = await FileSubjectFrontier.open(p, { space: SPACE, principal: P });
    c("advance:a-refused-value-did-not-reach-the-DISK", still.tip === 7, still.tip);
  }

  // ---------------------------------------------------------------- reset (abandonment)
  {
    const d = dir();
    const p = join(d, "subject.json");
    const f = await FileSubjectFrontier.open(p, { space: SPACE, principal: P });
    await f.advance(9);
    await f.reset();
    c("reset:abandonment-returns-the-tip-to-zero", f.tip === 0, f.tip);
    // THE CONFLATION CELL. A reset record is a FILE holding zero, and a thread log beside it still
    // holds the old sequence. Re-opening must NOT recover that sequence, or abandonment is undone.
    walFor(d, "thread_a", 9);
    const reopened = await FileSubjectFrontier.open(p, { space: SPACE, principal: P });
    c("reset:a-record-that-READS-zero-is-not-re-seeded-from-a-thread-log", reopened.tip === 0, reopened.tip);
  }

  // ---------------------------------------------------------------- recovery from thread logs
  {
    const d = dir();
    walFor(d, "thread_a", 4);
    walFor(d, "thread_b", 11);
    walFor(d, "thread_c", 2);
    const f = await FileSubjectFrontier.open(join(d, "subject.json"), { space: SPACE, principal: P });
    c("recover:an-ABSENT-record-takes-the-HIGHEST-tip-any-thread-log-holds", f.tip === 11, f.tip);
    const again = await FileSubjectFrontier.open(join(d, "subject.json"), { space: SPACE, principal: P });
    c("recover:the-recovered-tip-was-PERSISTED-not-only-returned", again.tip === 11, again.tip);
  }
  {
    const d = dir();
    // A directory with no thread logs at all is virgin, not an error.
    mkdirSync(join(d, "not-a-thread"), { recursive: true });
    writeFileSync(join(d, "stray.txt"), "x");
    const f = await FileSubjectFrontier.open(join(d, "subject.json"), { space: SPACE, principal: P });
    c("recover:a-directory-holding-no-thread-log-is-virgin", f.tip === 0, f.tip);
  }
  {
    const d = dir();
    walFor(d, "thread_a", 5);
    const td = join(d, "thread_bad");
    mkdirSync(td, { recursive: true });
    writeFileSync(join(td, "wal.json"), "{not json");
    await threw("recover:an-UNREADABLE-sibling-log-is-fatal-not-skipped",
      () => FileSubjectFrontier.open(join(d, "subject.json"), { space: SPACE, principal: P }), /a readable thread log/);
  }
  {
    const d = dir();
    walFor(d, "thread_a", 5, "local.someone-else");
    await threw("recover:a-sibling-log-under-ANOTHER-principal-is-refused",
      () => FileSubjectFrontier.open(join(d, "subject.json"), { space: SPACE, principal: P }), /a thread log for principal/);
  }

  // ---------------------------------------------------------------- corruption
  {
    const d = dir();
    const p = join(d, "subject.json");
    writeFileSync(p, "");
    await threw("corrupt:a-ZERO-BYTE-record-is-corruption-and-never-virgin",
      () => FileSubjectFrontier.open(p, { space: SPACE, principal: P }), /zero bytes/);
  }
  {
    const d = dir();
    const p = join(d, "subject.json");
    writeFileSync(p, JSON.stringify({ v: 1, space: SPACE, principal: "local.bbb", tip: 3 }));
    await threw("corrupt:a-record-belonging-to-ANOTHER-principal-is-refused",
      () => FileSubjectFrontier.open(p, { space: SPACE, principal: P }), /principal matches/);
  }
  {
    const d = dir();
    const p = join(d, "subject.json");
    writeFileSync(p, JSON.stringify({ v: 1, space: "other", principal: P, tip: 3 }));
    await threw("corrupt:a-record-from-another-SPACE-is-refused",
      () => FileSubjectFrontier.open(p, { space: SPACE, principal: P }), /space matches/);
  }
  {
    const d = dir();
    const p = join(d, "subject.json");
    writeFileSync(p, JSON.stringify({ v: 99, space: SPACE, principal: P, tip: 3 }));
    await threw("corrupt:an-unknown-version-is-refused-rather-than-guessed",
      () => FileSubjectFrontier.open(p, { space: SPACE, principal: P }), /v === 1/);
  }
  {
    const d = dir();
    const p = join(d, "subject.json");
    writeFileSync(p, JSON.stringify({ v: 1, space: SPACE, principal: P, tip: -1 }));
    await threw("corrupt:a-negative-tip-is-refused",
      () => FileSubjectFrontier.open(p, { space: SPACE, principal: P }), /tip is a safe non-negative integer/);
  }
  {
    const d = dir();
    const p = join(d, "subject.json");
    writeFileSync(p, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]));
    await threw("corrupt:invalid-UTF-8-is-refused-rather-than-substituted",
      () => FileSubjectFrontier.open(p, { space: SPACE, principal: P }), /valid UTF-8/);
    c("corrupt:the-refusal-is-a-typed-error-a-caller-can-branch-on",
      await (async () => { try { await FileSubjectFrontier.open(p, { space: SPACE, principal: P }); return false; } catch (e) { return e instanceof SubjectFrontierCorruptError; } })());
  }
  // ---------------------------------------------------------------- the scan may not be walked out
  //
  // The CREATE path refuses a symlinked component (`ensureDirNoSymlink`), so a symlink under the
  // principal directory is a state this writer cannot produce. The recovery path reads the same
  // tree and used not to check, which meant a planted link took the scan to a log in another tree
  // and the guard was only on the half nobody attacks. Both halves have to agree.
  {
    const d = dir();
    const outside = join(root, `elsewhere-${Math.random().toString(36).slice(2)}`);
    mkdirSync(outside, { recursive: true });
    // SAME principal on purpose: the principal check already refuses a foreign one, so a foreign
    // log would red this cell for the wrong reason and prove nothing about following the link.
    writeFileSync(join(outside, "wal.json"), JSON.stringify({ principal: P, frontier: { lastSubjectSeq: 4242 } }));
    symlinkSync(outside, join(d, "t-linked"));
    await threw("recover:a-SYMLINKED-thread-directory-is-refused-not-followed",
      () => FileSubjectFrontier.open(join(d, "subject.json"), { space: SPACE, principal: P }), /never a symlink/);
  }
  {
    const d = dir();
    const outside = join(root, `elsewhere2-${Math.random().toString(36).slice(2)}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "wal.json"), JSON.stringify({ principal: P, frontier: { lastSubjectSeq: 5353 } }));
    // A REAL thread directory holding a symlinked log: the entry check above clears the directory
    // and stops there, so without O_NOFOLLOW this reaches the same foreign log by one more hop.
    const td = join(d, "t-real");
    mkdirSync(td, { recursive: true });
    symlinkSync(join(outside, "wal.json"), join(td, "wal.json"));
    // THE CELL PINS WHICH LAYER REFUSED, and that is not pedantry. Two layers stand here, an
    // `lstat` and `O_NOFOLLOW`, and on a platform that has the flag either one alone produces a
    // refusal matching `/never a symlink/`. A cell that only asked for a refusal could not tell
    // them apart, and the pre-registered mutation on the lstat SURVIVED against exactly that
    // wording. Since the claim being made is that the PORTABLE layer decides, the portable layer's
    // own detail is what gets asserted; the flag behind it has no cell because no cell can drive
    // the check-to-open race it exists for.
    await threw("recover:a-SYMLINKED-log-inside-a-real-thread-directory-is-refused",
      () => FileSubjectFrontier.open(join(d, "subject.json"), { space: SPACE, principal: P }), /never a symlink/);
    await threw("recover:the-symlinked-log-refusal-comes-from-the-PORTABLE-check-not-the-flag",
      () => FileSubjectFrontier.open(join(d, "subject.json"), { space: SPACE, principal: P }), /writer never wrote/);
  }
  {
    const d = dir();
    const outside = join(root, `elsewhere3-${Math.random().toString(36).slice(2)}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "wal.json"), JSON.stringify({ principal: P, frontier: { lastSubjectSeq: 6464 } }));
    const td = join(d, "t-hard");
    mkdirSync(td, { recursive: true });
    // A HARD link, which is the hop neither `isSymbolicLink` nor `O_NOFOLLOW` can see: the entry is
    // a real directory and the file is a real file, and it is the SAME file as one outside.
    linkSync(join(outside, "wal.json"), join(td, "wal.json"));
    await threw("recover:a-HARDLINKED-log-is-refused-because-a-log-this-writer-made-has-one-name",
      () => FileSubjectFrontier.open(join(d, "subject.json"), { space: SPACE, principal: P }), /exactly one name/);
  }
  // ---------------------------------------------------------------- the acked-but-unfolded log
  //
  // THE CRASH WINDOW THE `acked` STATE EXISTS FOR, MET ON THE UPGRADE PATH. A log that took an ack
  // and died before folding holds the assigned sequence in `pending.ackSeq`, strictly ahead of the
  // frontier it has not folded into. Reading the frontier alone recovers the OLDER number and
  // persists it, and the session that could fold it never runs again because upgrading forks the
  // session id. That is this file's own defect reintroduced at the one boundary it exists for.
  {
    const d = dir();
    const td = join(d, "t-acked");
    mkdirSync(td, { recursive: true });
    writeFileSync(join(td, "wal.json"), JSON.stringify({ principal: P, frontier: { lastSubjectSeq: 5 }, pending: { state: "acked", ackSeq: 12 } }));
    const f = await FileSubjectFrontier.open(join(d, "subject.json"), { space: SPACE, principal: P });
    c("recover:an-ACKED-but-unfolded-log-carries-its-ackSeq-not-its-stale-frontier", f.tip === 12, f.tip);
    const again = await FileSubjectFrontier.open(join(d, "subject.json"), { space: SPACE, principal: P });
    c("recover:the-acked-sequence-was-PERSISTED-so-the-under-count-cannot-be-frozen-in", again.tip === 12, again.tip);
  }
  {
    // Two siblings, and the higher number is in the one that did not fold. Taking the max of the
    // frontiers alone picks the folded 10 and loses the 15 the broker actually assigned.
    const d = dir();
    mkdirSync(join(d, "t-folded"), { recursive: true });
    writeFileSync(join(d, "t-folded", "wal.json"), JSON.stringify({ principal: P, frontier: { lastSubjectSeq: 10 }, pending: null }));
    mkdirSync(join(d, "t-unfolded"), { recursive: true });
    writeFileSync(join(d, "t-unfolded", "wal.json"), JSON.stringify({ principal: P, frontier: { lastSubjectSeq: 3 }, pending: { state: "acked", ackSeq: 15 } }));
    const f = await FileSubjectFrontier.open(join(d, "subject.json"), { space: SPACE, principal: P });
    c("recover:the-max-spans-BOTH-the-frontiers-and-the-acked-pendings", f.tip === 15, f.tip);
  }
  {
    // A sent-but-unacked pending carries no assigned sequence, and `EventWal` refuses an `ackSeq`
    // on it. Recovery must not invent one from a frame the broker never answered.
    const d = dir();
    const td = join(d, "t-sent");
    mkdirSync(td, { recursive: true });
    writeFileSync(join(td, "wal.json"), JSON.stringify({ principal: P, frontier: { lastSubjectSeq: 7 }, pending: { state: "sent_unacked", seq: 3 } }));
    const f = await FileSubjectFrontier.open(join(d, "subject.json"), { space: SPACE, principal: P });
    c("recover:a-SENT-but-unacked-pending-adds-nothing-because-nothing-was-assigned", f.tip === 7, f.tip);
  }
  {
    // An acked pending that is NOT ahead of its own frontier contradicts the invariant `EventWal`
    // enforces when it writes one, so it is a document from another vintage and is refused rather
    // than quietly ignored.
    const d = dir();
    const td = join(d, "t-bad");
    mkdirSync(td, { recursive: true });
    writeFileSync(join(td, "wal.json"), JSON.stringify({ principal: P, frontier: { lastSubjectSeq: 9 }, pending: { state: "acked", ackSeq: 9 } }));
    await threw("recover:an-acked-pending-BEHIND-its-own-frontier-is-refused-not-ignored",
      () => FileSubjectFrontier.open(join(d, "subject.json"), { space: SPACE, principal: P }), /ahead of the frontier/);
  }

// ─────────────────────────────────────────── the record moved under the writer
//
// KILL SET for this section, predicted as NAMES before the run:
//   S20 `advance` compares the new seq against MEMORY only, dropping the disk re-read
//       -> `moved:a-SECOND-view-of-one-record-is-REFUSED-rather-than-taking-the-tip-backwards`
//          and its durability cell.
//   S21 an ABSENT record on the re-read is read as zero instead of as its own state
//       -> `moved:a-view-whose-record-was-DELETED-underneath-it-is-refused-too` ONLY. The virgin
//          cell must survive it, which is what says the guard did not simply refuse everything.
//   S22 the re-read takes `JSON.parse(...).tip` without the document's own shape checks
//       -> `moved:a-record-that-went-CORRUPT-under-a-live-writer-is-refused-BEFORE-the-write`.
//   S23 `advance` is not serialized on the instance
//       -> `moved:concurrent-advances-on-ONE-view-cannot-both-pass-a-check-neither-still-satisfies`.
{
  // THE REPRODUCTION, and it is where this section came from. Before the re-read: `A.advance(10)`
  // then `B.advance(6)` left 6 on disk and returned normally from both.
  const d = dir();
  const path = join(d, "subject.json");
  const A = await FileSubjectFrontier.open(path, { space: SPACE, principal: P });
  const B = await FileSubjectFrontier.open(path, { space: SPACE, principal: P });
  await A.advance(10);
  let err: Error | undefined;
  try {
    await B.advance(6);
  } catch (e) {
    err = e as Error;
  }
  c("moved:a-SECOND-view-of-one-record-is-REFUSED-rather-than-taking-the-tip-backwards",
    err instanceof SubjectFrontierMovedError, err ? `${err.name}: ${err.message}` : "did NOT throw");
  c("moved:...and-the-file-still-holds-the-number-the-FIRST-view-wrote",
    JSON.parse(readFileSync(path, "utf8")).tip === 10, readFileSync(path, "utf8"));
  // An operator holding this message has to be able to tell WHICH side is behind, or the only
  // action it supports is deleting the record, which is the one thing that loses the tip.
  c("moved:the-refusal-NAMES-both-numbers-so-an-operator-can-tell-which-writer-is-behind",
    /this view holds 0/.test(err?.message ?? "") && /the file holds 10/.test(err?.message ?? ""), err?.message);
}
{
  // THE LEGAL ABSENT CASE, and the control on the one above. A virgin view writes the very first
  // record while the file does not exist, so a guard that treated absent as a disagreement would
  // refuse every principal's first publish and every cell above it would still pass.
  const d = dir();
  const path = join(d, "subject.json");
  const f = await FileSubjectFrontier.open(path, { space: SPACE, principal: P });
  await f.advance(1);
  c("moved:a-VIRGIN-view-writes-the-FIRST-record-even-though-the-file-is-absent",
    f.tip === 1 && JSON.parse(readFileSync(path, "utf8")).tip === 1, f.tip);
}
{
  // ABSENT IS NOT ZERO ON THE WRITE SIDE EITHER. A view holding a tip whose file has gone is a
  // record something removed underneath a live writer; re-creating it would resurrect a frontier
  // that was cleared, which is the same conflation this whole file exists to refuse, seen from the
  // other direction.
  const d = dir();
  const path = join(d, "subject.json");
  const f = await FileSubjectFrontier.open(path, { space: SPACE, principal: P });
  await f.advance(4);
  rmSync(path);
  await threw("moved:a-view-whose-record-was-DELETED-underneath-it-is-refused-too",
    () => f.advance(5), /no record at all/);
}
{
  // A record that goes bad under a LIVE writer meets the same wall as one that was bad at boot.
  // Validating only on the way in would let a writer that opened a good file overwrite a corrupt
  // one, destroying the evidence of whatever produced it.
  const d = dir();
  const path = join(d, "subject.json");
  const f = await FileSubjectFrontier.open(path, { space: SPACE, principal: P });
  await f.advance(2);
  writeFileSync(path, "{not json");
  await threw("moved:a-record-that-went-CORRUPT-under-a-live-writer-is-refused-BEFORE-the-write",
    () => f.advance(3), /parseable JSON/);
  c("moved:...and-the-corrupt-bytes-are-still-there-for-whoever-has-to-diagnose-them",
    readFileSync(path, "utf8") === "{not json", readFileSync(path, "utf8"));
}
{
  // The re-read is a read-modify-write, so two callers that interleave between the read and the
  // rename would BOTH pass a check neither still satisfies. One frontier is legitimately bound to
  // several logs, so this is an ordinary state rather than a misuse.
  const d = dir();
  const path = join(d, "subject.json");
  const f = await FileSubjectFrontier.open(path, { space: SPACE, principal: P });
  // THREE CALLERS, ONE NUMBER, ON PURPOSE. Ordered, exactly one can advance a tip of 0 to 5 and the
  // other two are refused for not advancing it. Unordered, all three read 0 before any of them
  // writes, so all three pass a check none of them still satisfies and all three report success.
  // The count is what discriminates; an increasing trio would succeed three times either way.
  const results = await Promise.allSettled([f.advance(5), f.advance(5), f.advance(5)]);
  const won = results.filter((r) => r.status === "fulfilled").length;
  const onDisk = JSON.parse(readFileSync(path, "utf8")).tip;
  c("moved:concurrent-advances-on-ONE-view-cannot-both-pass-a-check-neither-still-satisfies",
    won === 1 && onDisk === 5 && f.tip === 5, { won, onDisk, tip: f.tip });
}
{
  // RESET IS NOT BLOCKED BY A MOVED RECORD. Abandonment is the one thing that legitimately takes
  // the tip backwards, so making it re-read and refuse would leave a purged channel with no way
  // back at all: the halt the record exists to prevent, arriving through the repair.
  const d = dir();
  const path = join(d, "subject.json");
  const A = await FileSubjectFrontier.open(path, { space: SPACE, principal: P });
  const B = await FileSubjectFrontier.open(path, { space: SPACE, principal: P });
  await A.advance(9);
  await B.reset();
  c("moved:reset-is-NOT-blocked-by-a-moved-record-because-abandonment-is-what-legitimately-clears-it",
    JSON.parse(readFileSync(path, "utf8")).tip === 0, readFileSync(path, "utf8"));
}

} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`subject-frontier smoke: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
