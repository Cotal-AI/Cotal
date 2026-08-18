/**
 * MANY SESSIONS, ONE PRINCIPAL, ONE SUBJECT: the case that was broken in a released version.
 *
 * **THE DEFECT THIS FILE EXISTS FOR.** The write-ahead log is keyed per thread and the subject is
 * keyed per principal, so an agent's SECOND session opened `virgin`, published an expectation of 0
 * against a subject its own first session had already filled, and the emitter halted for good.
 * Measured before the fix on this exact harness: thread 1 published, threads 2 and 3 halted
 * identically, so it was not self-healing either. On a user-auth mesh the manager pins `actor` to
 * the agent name and a seat restart forks the session id, so the first restart of any managed seat
 * was enough to take an agent's event stream dark permanently.
 *
 * **THE BROKER IS REAL AND THAT IS NOT NEGOTIABLE HERE.** The whole mechanism is what JetStream does
 * with `Nats-Expected-Last-Subject-Sequence`, and a recorder that returns a shaped value cannot
 * testify about it: an instrument that models the thing under test agrees with whatever the model
 * says. Everything below runs against a real `nats-server`.
 *
 * **THE CONTROL IS THE POINT OF THE FILE, NOT THE HAPPY PATH.** Making session two publish is easy
 * and one wrong way to do it is to stop expecting anything at all, which would pass every cell above
 * the control while removing the guarantee the expectation exists for. So a genuine foreign writer
 * takes the subject, and our next publish MUST still halt. A fix that turns a permanent halt into a
 * permanent silence is not a fix.
 *
 * KILL SET, predicted as NAMES before the run:
 *   S1  `expectedTip` returns this thread's `frontier.lastSubjectSeq` instead of the subject record
 *       -> `session-2:a-NEW-thread-of-the-SAME-principal-publishes` and
 *          `session-3:...and-a-THIRD-one-does-too`, and NOT the control, which is the point.
 *   S2  `recordAck` does not advance the shared record
 *       -> the same two, one publish later.
 *   S3  an absent record is taken as virgin without scanning the sibling logs
 *       -> `upgrade:a-log-from-before-the-shared-record-carries-its-tip-across` ONLY.
 *   S4  `abandon` leaves the shared record standing
 *       -> `abandon:resets-the-shared-record-with-the-log` and its durability cell.
 *   S5  recover a tip into a record that READS zero, not only into an absent one
 *       -> `reset:a-record-that-READS-zero-is-not-re-seeded-from-a-thread-log`, in
 *          `smoke:subject-frontier`. Named here because it is the same rule seen from the log side.
 *   S6  drop the runtime requirement and keep only the type
 *       -> `guard:start-REFUSES-without-a-subject-frontier-at-RUNTIME`.
 *   S8  the halt claims the per-principal lock PREVENTS a concurrent emitter
 *       -> `control:the-halt-states-the-LIMIT-of-the-lock-rather-than-claiming-it-prevents-this`.
 *          The lock is real, but its file is per WORKSPACE ROOT on one HOST, so it cannot prevent
 *          the case this halt fires on. A guard named without its boundary sends an operator
 *          hunting a writer that the guard supposedly made impossible.
 *   S9  the halt points at the thread's own wal path instead of the principal directory
 *       -> `control:the-halt-LOCATES-the-state-to-remove`. `abandon()` has no shipped caller, so
 *          the directory IS the remedy and half of it is a mixed state the next start refuses.
 *
 * Run: pnpm smoke:agui-multi-session   (needs nats-server on PATH; starts its own broker)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable, mintLifecycleUid, principalKey } from "@cotal-ai/core";
import { AguiEmitter, runFinished, runStarted } from "../src/agui.js";
import { JsonlFileSource } from "../src/durable-source.js";
import { EventWal } from "../src/event-wal.js";
import { FileSubjectFrontier } from "../src/subject-frontier.js";
import { eventWalLocation } from "../src/agui-wal-path.js";
import { teardownOnSignal } from "@cotal-ai/smoke-kit";

let ok = 0,
  fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) ok++;
  else {
    fail++;
    console.log("  x FAIL:", n, extra ?? "");
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const root = mkdtempSync(join(tmpdir(), "agui-multi-"));
const procs: ChildProcess[] = [];
const releases: (() => void)[] = [];

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
    s.on("error", rej);
  });

const OWNER = "local";
const ACTOR = `A${randomUUID().replace(/-/g, "").toUpperCase().slice(0, 40)}`;
const PRINCIPAL = principalKey(OWNER, ACTOR).key;
const SPACE = `p${randomUUID().slice(0, 8).replace(/-/g, "")}`;
/**
 * THE SHIPPED RESOLVER, NOT A LOCAL RECONSTRUCTION OF IT. Every path this file touches comes from
 * the same function `ensureEventWalDir` calls, so the fixture moves when the layout moves. The
 * previous version hand-built `join(principalDir, "subject.json")` under a comment asserting it was
 * the shipped layout; that comment was true about the layout and false about the fixture, and the
 * mutant that resolves `subjectPath` under the THREAD dir survived every cell in five suites while
 * reproducing the released defect live.
 */
const locFor = (threadId: string, actor = ACTOR) =>
  eventWalLocation({ workspaceRoot: root, space: SPACE, principal: principalKey(OWNER, actor).key, threadId });
const PRINCIPAL_DIR = locFor("any-thread").principalDir;

try {
  const port = await freePort();
  const conf = join(root, "b.conf");
  writeFileSync(conf, [`port: ${port}`, `server_name: multi`, `jetstream { store_dir: "${join(root, "js")}" }`].join("\n"));
  const broker = spawn("nats-server", ["-c", conf], { stdio: "ignore" });
  procs.push(broker);
  releases.push(teardownOnSignal(broker));
  const url = `nats://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 200 && !up; i++) {
    if (await isReachable(url)) up = true;
    else await wait(100);
  }
  if (!up) throw new Error("broker never became reachable");

  const endpoint = (actor = ACTOR) => {
    const ep = new CotalEndpoint({
      space: SPACE,
      servers: [url],
      card: { name: "multi-agent", kind: "agent", owner: OWNER, actor, id: actor },
      lifecycleUid: mintLifecycleUid(),
    });
    ep.on("error", () => {});
    return ep;
  };

  /** One whole session: its own thread id, its own log, the SHARED subject record. */
  const session = async (
    threadId: string,
    opts?: { actor?: string; frontier?: FileSubjectFrontier },
  ) => {
    const actor = opts?.actor ?? ACTOR;
    const principal = principalKey(OWNER, actor).key;
    // Isolation between blocks comes from a distinct ACTOR, which the resolver turns into a
    // distinct principal directory. Nothing here chooses a directory by hand.
    const loc = locFor(threadId, actor);
    mkdirSync(loc.threadDir, { recursive: true });
    const walPath = loc.walPath;
    const srcPath = join(loc.threadDir, "session.jsonl");
    writeFileSync(srcPath, "");
    const ep = endpoint(actor);
    await ep.start();
    try {
      const wal = await EventWal.open(walPath, { space: SPACE, threadId, principal, subjectMayExist: false });
      // Opened here unless the caller supplies one. A caller that supplies a record it opened
      // EARLIER is handing this session a view that may have gone stale, which is the only way to
      // drive the fence below from inside a real emitter.
      const frontier = opts?.frontier ?? (await FileSubjectFrontier.open(loc.subjectPath, { space: SPACE, principal }));
      const em = await AguiEmitter.start<{ t?: string }>({
        endpoint: ep as never,
        wal,
        subjectFrontier: frontier,
        source: new JsonlFileSource<{ t?: string }>(srcPath),
        map: (r) =>
          r.t === "go"
            ? {
                runId: "r1",
                events: [runStarted({ threadId, runId: "r1", timestamp: 1 }), runFinished({ threadId, runId: "r1", timestamp: 2 })],
              }
            : null,
      });
      await em.pump(); // adopt
      appendFileSync(srcPath, JSON.stringify({ t: "go" }) + "\n");
      const res = await em.pump();
      return { published: res.frames, tip: frontier.tip, err: undefined as string | undefined };
    } catch (e) {
      return { published: 0, tip: -1, err: (e as Error).message };
    } finally {
      await ep.stop().catch(() => {});
    }
  };

  // ------------------------------------------------------------------ the layout this file assumes
  //
  // CALLING THE RESOLVER MAKES THIS SUITE FOLLOW THE CODE WHEREVER IT GOES, which is what the
  // previous hand-built paths failed to do, but it also means the suite would follow the code
  // somewhere WRONG without noticing. So one cell pins the promise itself: the shared record sits
  // directly in the principal directory, beside the thread directories rather than inside one.
  // Every cell below depends on that and none of them would say so if it moved.
  {
    const a = locFor("ses_one");
    const b = locFor("ses_two");
    c("layout:the-resolved-subject-record-sits-DIRECTLY-in-the-principal-dir",
      a.subjectPath === join(a.principalDir, "subject.json") && !a.subjectPath.startsWith(a.threadDir + "/"),
      { subject: a.subjectPath, principal: a.principalDir, thread: a.threadDir });
    c("layout:two-threads-of-one-principal-RESOLVE-TO-THE-SAME-record", a.subjectPath === b.subjectPath,
      { one: a.subjectPath, two: b.subjectPath });
  }

  // ------------------------------------------------------------------ the regression
  const s1 = await session("ses_one");
  c("session-1:publishes-on-a-virgin-subject", s1.published === 1 && s1.err === undefined, s1);
  c("session-1:the-shared-record-holds-the-assigned-sequence", s1.tip > 0, s1.tip);

  const s2 = await session("ses_two");
  c("session-2:a-NEW-thread-of-the-SAME-principal-publishes", s2.published === 1 && s2.err === undefined, s2);
  c("session-2:the-shared-record-ADVANCED-past-session-1", s2.tip > s1.tip, { one: s1.tip, two: s2.tip });

  // A third, because two sessions cannot distinguish "fixed" from "the second one happened to work".
  const s3 = await session("ses_three");
  c("session-3:...and-a-THIRD-one-does-too", s3.published === 1 && s3.err === undefined, s3);

  // ------------------------------------------------------------------ THE CONTROL
  //
  // A genuine second writer takes the subject behind our back. The expectation must still refuse
  // it. Without this cell, "stop expecting anything" passes every cell above.
  //
  // WHAT "FOREIGN" MEANS HERE, STATED SO A LATER READER CANNOT OVER-READ IT: the writer below is a
  // SECOND ENDPOINT UNDER THE SAME PRINCIPAL on a broker with no authentication. It grades
  // SEQUENCING, that a tip moved without our ack still refuses our next publish. It does NOT grade
  // authorization and cannot: no credential here is narrower than any other. Whether a DIFFERENT
  // principal is denied this subject is decided by the grant the manager mints and is proved in
  // `implementations/manager/smoke/events-grant-acl.smoke.ts`, not in this file.
  {
    const foreign = endpoint();
    await foreign.start();
    await foreign.multicastExpecting({
      channel: `events.${PRINCIPAL}`,
      parts: [{ kind: "text", text: "a body this emitter did not write" }],
      id: randomUUID(),
      expectedLastSubjectSeq: s3.tip,
    });
    await foreign.stop().catch(() => {});

    const s4 = await session("ses_four");
    c("control:a-FOREIGN-writer-on-our-subject-still-HALTS", s4.err !== undefined && /subject tip is no longer/.test(s4.err ?? ""), s4);
    c("control:the-halt-names-a-CONCURRENT-emitter-under-this-principal", /CONCURRENT emitter/.test(s4.err ?? ""), s4.err);
    c("control:the-halt-also-names-a-DISAGREEING-record-which-is-the-new-cause", /frontier record that disagrees/.test(s4.err ?? ""), s4.err);

    // The message may not assert a guard that does not hold, and it may not invent holes in one
    // that does. A per-principal lock DOES exist (`acquirePrincipalLock`, taken by
    // `ensureEventWalDir` on the shipped connector path), so naming it is honest; claiming it
    // PREVENTS this is not, because its FILE lives under a workspace root, so a second emitter
    // started against a different root, or by a path that never takes the lock, meets no lock at
    // all. Another host and a stale pid are NOT holes: `reclaimIfOwnerIsGone` refuses both, so the
    // second emitter never starts. This comment said otherwise in an earlier version, which is why
    // it is spelled out here rather than left to the reader.
    //
    // Three requirements, and the third is the one a later edit is most likely to break: the
    // message may not claim the lock PREVENTS this, and it may not name a case that in fact
    // REFUSES THE START. Another host and a stale pid are refusals, not ways past the lock, and a
    // cause list that includes them sends an operator to look at machines instead of at roots.
    c("control:the-halt-states-the-LIMIT-of-the-lock-rather-than-claiming-it-prevents-this",
      /lock refuses a second one/.test(s4.err ?? "") && /workspace root/.test(s4.err ?? "") &&
      !/lock is meant to prevent/.test(s4.err ?? "") && !/two hosts/.test(s4.err ?? ""), s4.err);

    // A named remedy has to exist where it is named. Nothing in shipped code calls `abandon()`, so
    // the halt cannot send an operator looking for a command; it has to hand them the directory.
    // `includes(PRINCIPAL_DIR)` alone does NOT discriminate, and S9 proved it: a message naming
    // `<PRINCIPAL_DIR>/<thread>/wal.json` contains the principal directory as a prefix and passes.
    // Requiring the following word is better and still a prefix test, which a reviewer caught: a
    // path ending `...principal wholeheartedly` satisfies it too. So the cell EXTRACTS the path the
    // message names and compares it whole. A prefix test cannot decide where a path ends.
    // Two things this pattern has to survive, both found by lenses rather than by me. `whole` alone
    // is satisfied by a path ending `... wholeheartedly` or `... wholesale`, so the pattern pins the
    // whole clause that follows rather than one word of it. And `\S+` drops any real workspace path
    // containing a space, which would red this cell on a perfectly correct message; `.+?` with a
    // pinned suffix takes the path as it is.
    // ANCHORED ON THE REMEDY CLAUSE, not on the first `removing` in the message. An earlier version
    // of this extractor keyed on `removing (.+?) whole`, and the moment the message gained a second
    // `removing` ahead of the remedy ("so removing this state does not clear the halt") it captured
    // from there and swept a sentence of prose into the path. A parser that assumes a word appears
    // once is a parser the next edit to the message breaks, and the edit that broke it was the fix
    // to the very sentence this cell exists to grade.
    const located = /by hand it means removing (.+?) whole, and removing less/.exec(s4.err ?? "")?.[1];
    c("control:the-halt-LOCATES-the-state-to-remove", located === PRINCIPAL_DIR, { located, dir: PRINCIPAL_DIR, err: s4.err });

    // A LOCATED REMEDY IS NOT A VALID ONE. The cell above proves the message points where it says;
    // it cannot tell you that following the instruction helps, and a cross-vendor lens executed it
    // and found it does not. Removal abandons LOCAL state; it cannot move the broker's tip. So it
    // clears the halt only when the subject is genuinely back to 0, which of the causes listed is
    // true of the filtered purge alone. On any other cause the operator destroys the sibling logs a
    // tip can be rebuilt from and gets the same halt back, which then recommends the same remedy.
    c("control:the-halt-states-the-PRECONDITION-for-its-own-remedy",
      /VALID ONLY ONCE THE SUBJECT IS ACTUALLY EMPTY/.test(s4.err ?? "") &&
      /FILTERED PURGE alone/.test(s4.err ?? "") && /Purge the channel first/.test(s4.err ?? ""), s4.err);
  }

  // ------------------------------------------------------------------ THE REMEDY, EXECUTED
  //
  // The precondition above is graded as a STRING by the cell in the block before this one, and a
  // string cell cannot tell you the advice is good. This block performs the remedy against a real
  // broker and grades what happens.
  //
  // WHAT IS GRADED HERE: the NECESSITY of the precondition. Removing the principal directory while
  // the subject tip is non-zero leaves the next session halted, which is exactly the state the
  // operator was trying to leave.
  //
  // WHAT IS NOT GRADED HERE, STATED SO IT IS NOT MISTAKEN FOR COVERED: the SUFFICIENCY direction,
  // that after a real filtered purge the same removal lets the next session publish. Purging a
  // JetStream subject needs a management client, and `@nats-io/jetstream` is not in this package's
  // dependency graph; the `nats` CLI exists on some developer machines and not on CI, so a cell
  // built on it would be permanently UNOBSERVED in the only environment that gates. Grading the
  // half that runs everywhere and naming the half that does not is the honest split.
  {
    const rActor = `A${randomUUID().replace(/-/g, "").toUpperCase().slice(0, 40)}`;
    const first = await session("ses_remedy_one", { actor: rActor });
    c("remedy:CONTROL-the-first-session-published-so-the-subject-tip-is-NON-ZERO",
      first.published === 1 && first.tip > 0, first);

    // Exactly what the message instructs, on exactly the directory it names.
    rmSync(locFor("ses_remedy_one", rActor).principalDir, { recursive: true, force: true });

    const after = await session("ses_remedy_two", { actor: rActor });
    c("remedy:removal-on-a-NON-EMPTY-subject-does-NOT-clear-the-halt", after.published === 0 && after.err !== undefined, after);
    c("remedy:...and-the-halt-it-returns-is-the-SAME-cas-loss-on-the-tip-that-was-already-there",
      /the subject tip is no longer 0/.test(after.err ?? ""), after.err);
  }

  // ------------------------------------------------------------------ the upgrade path
  //
  // An installation from the release before the shared record existed: a log holding a real
  // `lastSubjectSeq`, and no shared record at all. Opening it virgin would republish an expectation
  // of 0 against a subject that very thread filled, which is this defect reappearing exactly once
  // per install, at the upgrade boundary.
  //
  // IT NEEDS ITS OWN PRINCIPAL, and getting that wrong is how the first version of this block
  // failed: a subject is per principal, so reusing the one above meant starting a "virgin" record
  // against a subject that already carried four messages. That halt was the code being right and
  // the fixture being wrong.
  {
    const upActor = `A${randomUUID().replace(/-/g, "").toUpperCase().slice(0, 40)}`;
    const upPrincipal = principalKey(OWNER, upActor).key;
    const subjectPath = locFor("ses_upgrade", upActor).subjectPath;

    const first = await session("ses_upgrade", { actor: upActor });
    c("upgrade:the-first-session-under-a-fresh-principal-published", first.published === 1 && first.err === undefined, first);
    const carried = await FileSubjectFrontier.open(subjectPath, { space: SPACE, principal: upPrincipal });
    c("upgrade:CONTROL-the-record-really-held-a-tip-before-it-was-removed", carried.tip > 0, carried.tip);

    // Delete the shared record, leaving EXACTLY the pre-fix on-disk state: thread logs, no record.
    rmSync(subjectPath, { force: true });
    const after = await session("ses_upgrade_two", { actor: upActor });
    c("upgrade:a-log-from-before-the-shared-record-carries-its-tip-across", after.err === undefined && after.published === 1, after);
    c("upgrade:...and-the-rebuilt-record-is-ahead-of-the-tip-it-was-seeded-from", after.tip > carried.tip, { seeded: carried.tip, now: after.tip });
  }

  // ------------------------------------------------------------- the upgrade path, MID-ACK
  //
  // THE SAME BOUNDARY, MET BY A LOG THAT DIED IN THE ONE WINDOW THE `acked` STATE EXISTS FOR. A
  // session that took an acknowledgement and died before folding it keeps the assigned sequence in
  // `pending.ackSeq` and NOT in its frontier. Reading the frontier alone recovers an older number,
  // persists it, and the next publish is refused by the broker for the rest of the principal's
  // life. The session that could have folded it never runs again, because upgrading forks the
  // session id.
  //
  // THIS RUNS AGAINST THE REAL BROKER ON PURPOSE, and that is the difference between it and the
  // unit cells in `smoke:subject-frontier`. Those build a log by hand and prove the scan reads the
  // right field. Only the broker can say whether the number the scan produced is the number the
  // SUBJECT actually holds, which is the claim that matters: a recovered tip that is merely
  // self-consistent still halts.
  {
    const mActor = `A${randomUUID().replace(/-/g, "").toUpperCase().slice(0, 40)}`;
    const mPrincipal = principalKey(OWNER, mActor).key;
    const subjectPath = locFor("ses_midack", mActor).subjectPath;

    const first = await session("ses_midack", { actor: mActor });
    c("midack:CONTROL-the-first-session-published-and-the-subject-really-moved", first.published === 1 && first.tip > 0, first);
    const assigned = first.tip;

    // Rewrite the log into the state a death between the ack and the fold leaves, and remove the
    // record. After this the assigned sequence exists in exactly ONE place on disk: `pending.ackSeq`.
    const walPath = locFor("ses_midack", mActor).walPath;
    const doc = JSON.parse(readFileSync(walPath, "utf8")) as { frontier: { lastSubjectSeq: number; seq: number; sourceCursor: string }; pending: unknown };
    doc.pending = { state: "acked", ackSeq: assigned, seq: doc.frontier.seq, sourceCursor: doc.frontier.sourceCursor };
    doc.frontier = { ...doc.frontier, lastSubjectSeq: 0 };
    writeFileSync(walPath, JSON.stringify(doc));
    rmSync(subjectPath, { force: true });
    c("midack:CONTROL-the-frontier-really-lost-the-number-so-only-the-pending-holds-it",
      JSON.parse(readFileSync(walPath, "utf8")).frontier.lastSubjectSeq === 0, readFileSync(walPath, "utf8"));

    const after = await session("ses_midack_two", { actor: mActor });
    c("midack:a-log-that-died-between-the-ACK-and-the-FOLD-still-carries-its-sequence-across",
      after.err === undefined && after.published === 1, after);
    c("midack:...and-the-broker-AGREED-with-the-recovered-number", after.tip > assigned, { assigned, now: after.tip });
  }

  // ------------------------------------------------------------------ abandonment is TOTAL
  //
  // A filtered purge returns the subject tip to 0 for EVERY thread on the channel, so abandoning a
  // log must clear the shared record with it. Leaving the record standing is this defect's mirror
  // image: the next session expects a tip the subject no longer has, and halts just as permanently
  // from the other side.
  {
    const abActor = `A${randomUUID().replace(/-/g, "").toUpperCase().slice(0, 40)}`;
    const abPrincipal = principalKey(OWNER, abActor).key;
    const first = await session("ses_abandon", { actor: abActor });
    c("abandon:CONTROL-the-record-held-a-tip-before-the-abandonment", first.published === 1 && first.tip > 0, first);

    const wal = await EventWal.open(locFor("ses_abandon", abActor).walPath, {
      space: SPACE, threadId: "ses_abandon", principal: abPrincipal, subjectMayExist: false,
    });
    const frontier = await FileSubjectFrontier.open(locFor("ses_abandon", abActor).subjectPath, { space: SPACE, principal: abPrincipal });
    await wal.bindSubjectFrontier(frontier);
    await wal.abandon();
    c("abandon:resets-the-shared-record-with-the-log", frontier.tip === 0, frontier.tip);
    const onDisk = await FileSubjectFrontier.open(locFor("ses_abandon", abActor).subjectPath, { space: SPACE, principal: abPrincipal });
    c("abandon:...and-the-reset-is-DURABLE-not-only-in-memory", onDisk.tip === 0, onDisk.tip);
  }

  // ------------------------------------------------------------------ THE FENCE, EXECUTED
  //
  // A CLAIM THIS BRANCH MAKES IN PROSE, MOVED INTO THE TREE. `FileSubjectFrontier.advance` refuses
  // a record that moved under the view, and the natural question is whether a shipped path could
  // ever reach the regression that refusal prevents. The answer is no, and the reason is that `E`
  // IS the view's own tip: a view that has gone stale publishes a stale expectation, so the
  // broker's compare-and-set refuses it before any ack exists to record and `advance` is never
  // called at all. That was measured on a real broker and written into the pull request as a
  // transcript, and a review pointed out that a transcript is not a cell. So it is a cell.
  //
  // ITS OWN PRINCIPAL, for the same reason the abandonment block has one: it deliberately leaves a
  // halted emitter and a subject nobody may publish to again, and the sessions above share a
  // subject whose tip later cells still depend on.
  //
  // THESE CELLS ARE UNMUTATED, AND SAYING SO IS THE POINT. The first version of this comment claimed
  // the mechanism was already graded from two other angles, S1 and the foreign-writer control, and a
  // review EXECUTED that claim and refuted it. S1 sets `E` to the log's own `lastSubjectSeq`; the
  // late session's log is virgin, so `E` is 0, the subject is already past it, and the fence still
  // halts, leaving every cell here green. The foreign-writer control runs a CURRENT view against a
  // tip somebody else moved, while this block runs a STALE view against a tip WE moved: a different
  // assumption, not the same one from another side.
  //
  // So the honest label is unmutated rather than already-covered. What would red these cells is an
  // expectation sourced from the FILE instead of from the bound view, which would let the late
  // session publish; that is not a one-line break in any shipped file, so it is named here instead
  // of registered as a mutant nobody can apply. A coverage claim asserted rather than executed is
  // the same defect this whole change is about, and it survived one round of review by being
  // repeated back to me before a second one ran it.
  {
    const fActor = `A${randomUUID().replace(/-/g, "").toUpperCase().slice(0, 40)}`;
    const fPrincipal = principalKey(OWNER, fActor).key;
    const subjectPath = locFor("ses_fence_one", fActor).subjectPath;
    const openRecord = () => FileSubjectFrontier.open(subjectPath, { space: SPACE, principal: fPrincipal });

    const first = await session("ses_fence_one", { actor: fActor });
    c("fence:CONTROL-the-first-session-published-and-the-record-moved", first.published === 1 && first.tip > 0, first);

    // OPENED HERE, one session too early. From the next line on this view is behind the file, which
    // is exactly the state `advance` refuses and the state an emitter must never get to use.
    const stale = await openRecord();
    const staleView = stale.tip;

    const mid = await session("ses_fence_mid", { actor: fActor });
    c("fence:CONTROL-a-session-with-a-CURRENT-view-publishes-and-moves-the-record-past-it",
      mid.published === 1 && mid.tip > staleView, { staleView, mid: mid.tip });

    const late = await session("ses_fence_late", { actor: fActor, frontier: stale });
    c("fence:a-session-carrying-a-STALE-view-HALTS-at-the-broker-rather-than-publishing",
      late.published === 0 && /subject tip is no longer/.test(late.err ?? ""), late);
    c("fence:...and-the-broker-names-the-sequence-the-subject-actually-holds",
      new RegExp(`wrong last sequence: ${mid.tip}`).test(late.err ?? ""), late.err);

    // THE POINT OF THE BLOCK. The stale view never took an ack, so it never advanced the shared
    // record, so the durable tip cannot be walked backwards by this route.
    const onDisk = await openRecord();
    c("fence:...and-the-DURABLE-record-still-holds-the-number-the-CURRENT-session-wrote",
      onDisk.tip === mid.tip && onDisk.tip > staleView, { onDisk: onDisk.tip, mid: mid.tip, staleView });
    c("fence:...and-the-stale-view-itself-never-moved-either",
      stale.tip === staleView, { was: staleView, now: stale.tip });
  }

  // ------------------------------------------------------------------ the runtime requirement
  {
    const dir = join(root, "noguard");
    mkdirSync(dir, { recursive: true });
    const srcPath = join(dir, "s.jsonl");
    writeFileSync(srcPath, "");
    const ep = endpoint();
    await ep.start();
    const wal = await EventWal.open(join(dir, "wal.json"), { space: SPACE, threadId: "ses_guard", principal: PRINCIPAL, subjectMayExist: false });
    let err: string | undefined;
    try {
      // Smoke files are not typechecked, so the type alone would not have stopped this call.
      await AguiEmitter.start({ endpoint: ep as never, wal, source: new JsonlFileSource(srcPath), map: () => null } as never);
    } catch (e) {
      err = (e as Error).message;
    }
    c("guard:start-REFUSES-without-a-subject-frontier-at-RUNTIME", /subject frontier is required/.test(err ?? ""), err ?? "no throw");
    await ep.stop().catch(() => {});
  }
} finally {
  for (const r of releases) r();
  for (const p of procs) p.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
}

console.log(`agui-multi-session smoke: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
