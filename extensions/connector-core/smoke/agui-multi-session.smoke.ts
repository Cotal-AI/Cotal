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
 *   S3  drop `seedFromThread` at bind
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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable, mintLifecycleUid, principalKey } from "@cotal-ai/core";
import { AguiEmitter, runFinished, runStarted } from "../src/agui.js";
import { JsonlFileSource } from "../src/durable-source.js";
import { EventWal } from "../src/event-wal.js";
import { FileSubjectFrontier } from "../src/subject-frontier.js";
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
const PRINCIPAL_DIR = join(root, "principal");

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
  const session = async (threadId: string, opts?: { principalDir?: string; actor?: string }) => {
    const actor = opts?.actor ?? ACTOR;
    const principal = principalKey(OWNER, actor).key;
    // THE SHIPPED LAYOUT, not a convenient one: `subject.json` sits in the principal directory
    // BESIDE the thread directories, which is what lets it recover a tip from a sibling log on
    // upgrade. A fixture that scattered them would pass while the real layout failed.
    const principalDir = opts?.principalDir ?? PRINCIPAL_DIR;
    const dir = join(principalDir, threadId);
    mkdirSync(dir, { recursive: true });
    const walPath = join(dir, "wal.json");
    const srcPath = join(dir, "session.jsonl");
    writeFileSync(srcPath, "");
    const ep = endpoint(actor);
    await ep.start();
    try {
      const wal = await EventWal.open(walPath, { space: SPACE, threadId, principal, subjectMayExist: false });
      const frontier = await FileSubjectFrontier.open(join(principalDir, "subject.json"), { space: SPACE, principal });
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

    // The message may not assert a guard that does not hold. A per-principal lock DOES exist
    // (`acquirePrincipalLock`, taken by `ensureEventWalDir` on the shipped connector path), so
    // naming it is honest; claiming it PREVENTS this is not, because its file lives under one
    // workspace root on one host. Two roots, two hosts, or a reclaim onto a reused pid walk past
    // it, and those are the situations an operator reading this halt is actually in.
    c("control:the-halt-states-the-LIMIT-of-the-lock-rather-than-claiming-it-prevents-this", /lock refuses only/.test(s4.err ?? "") && /workspace root/.test(s4.err ?? "") && !/lock is meant to prevent/.test(s4.err ?? ""), s4.err);

    // A named remedy has to exist where it is named. Nothing in shipped code calls `abandon()`, so
    // the halt cannot send an operator looking for a command; it has to hand them the directory.
    // `includes(PRINCIPAL_DIR)` alone does NOT discriminate, and S9 proved it: a message naming
    // `<PRINCIPAL_DIR>/<thread>/wal.json` contains the principal directory as a prefix and passes.
    // Requiring the following word is better and still a prefix test, which a reviewer caught: a
    // path ending `...principal wholeheartedly` satisfies it too. So the cell EXTRACTS the path the
    // message names and compares it whole. A prefix test cannot decide where a path ends.
    // `whole\b`, because `whole` alone is satisfied by a path ending `... wholeheartedly`, which
    // is the SAME prefix mistake in its third costume. A boundary is what pins the word.
    const located = /removing (\S+) whole\b/.exec(s4.err ?? "")?.[1];
    c("control:the-halt-LOCATES-the-state-to-remove", located === PRINCIPAL_DIR, { located, dir: PRINCIPAL_DIR, err: s4.err });
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
    const upDir = join(root, "upgrade-principal");
    mkdirSync(upDir, { recursive: true });
    const subjectPath = join(upDir, "subject.json");

    const first = await session("ses_upgrade", { principalDir: upDir, actor: upActor });
    c("upgrade:the-first-session-under-a-fresh-principal-published", first.published === 1 && first.err === undefined, first);
    const carried = await FileSubjectFrontier.open(subjectPath, { space: SPACE, principal: upPrincipal });
    c("upgrade:CONTROL-the-record-really-held-a-tip-before-it-was-removed", carried.tip > 0, carried.tip);

    // Delete the shared record, leaving EXACTLY the pre-fix on-disk state: thread logs, no record.
    rmSync(subjectPath, { force: true });
    const after = await session("ses_upgrade_two", { principalDir: upDir, actor: upActor });
    c("upgrade:a-log-from-before-the-shared-record-carries-its-tip-across", after.err === undefined && after.published === 1, after);
    c("upgrade:...and-the-rebuilt-record-is-ahead-of-the-tip-it-was-seeded-from", after.tip > carried.tip, { seeded: carried.tip, now: after.tip });
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
    const abDir = join(root, "abandon-principal");
    mkdirSync(abDir, { recursive: true });
    const first = await session("ses_abandon", { principalDir: abDir, actor: abActor });
    c("abandon:CONTROL-the-record-held-a-tip-before-the-abandonment", first.published === 1 && first.tip > 0, first);

    const wal = await EventWal.open(join(abDir, "ses_abandon", "wal.json"), {
      space: SPACE, threadId: "ses_abandon", principal: abPrincipal, subjectMayExist: false,
    });
    const frontier = await FileSubjectFrontier.open(join(abDir, "subject.json"), { space: SPACE, principal: abPrincipal });
    await wal.bindSubjectFrontier(frontier);
    await wal.abandon();
    c("abandon:resets-the-shared-record-with-the-log", frontier.tip === 0, frontier.tip);
    const onDisk = await FileSubjectFrontier.open(join(abDir, "subject.json"), { space: SPACE, principal: abPrincipal });
    c("abandon:...and-the-reset-is-DURABLE-not-only-in-memory", onDisk.tip === 0, onDisk.tip);
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
