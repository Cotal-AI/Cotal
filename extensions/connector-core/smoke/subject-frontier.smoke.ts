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
 * Run: pnpm smoke:subject-frontier
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSubjectFrontier, SubjectFrontierCorruptError } from "../src/subject-frontier.js";

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
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`subject-frontier smoke: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
