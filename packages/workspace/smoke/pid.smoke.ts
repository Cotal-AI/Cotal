/**
 * PID-ATTRIBUTION CONTRACT smoke (no broker, no fixture that can silently skip).
 *
 * The property: asking the kernel about a process has THREE answers, not two. It is there, it is
 * gone, or it is there but not ours to signal (`EPERM`). A two-state probe folds the third into
 * "gone" and callers then act on a running process as if it had died.
 *
 * TWO THINGS THIS SUITE LEARNED THE HARD WAY, both from review rather than from me:
 *
 * 1. The first version reached the EPERM rule only by probing pid 1 and hoping the process was
 *    unprivileged. As root, or in some containers, that cell SKIPPED and the suite still printed a
 *    passing banner: a deliberately broken implementation read GREEN. The errno-to-state mapping is
 *    now a pure function, so there is no fixture left to skip and no root/container variance.
 *
 * 2. The first version tested the PRIMITIVE and nothing else. A reviewer inverted all five converted
 *    call sites and this suite still printed PASSED: zero of five mutations killed. The change under
 *    test was the conversions, and they were entirely unprotected. The caller cells below exist for
 *    that, and their honest coverage limit is stated at the bottom rather than implied away.
 *
 * Run: pnpm smoke:pid-contract
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandIsCotalSupervisor, livenessFromErrno, parsePid, probeLiveness, readProcessCommand,
  type CommandReader,
} from "../src/pid.js";

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

// ── parsePid: only what `process.kill` will actually accept ───────────────────────────────────
check("parsePid takes a plain positive integer", parsePid("4321") === 4321);
check("parsePid tolerates surrounding whitespace (pidfiles carry a trailing newline)", parsePid(" 4321\n") === 4321);
for (const bad of ["0", "-1", "1.5", "", "   ", "abc", "12abc", "NaN", "Infinity", String(2 ** 31)])
  check(`parsePid rejects ${JSON.stringify(bad)} as unattributable`, parsePid(bad) === undefined, bad);
check("parsePid admits the largest pid process.kill accepts", parsePid(String(0x7fffffff)) === 0x7fffffff);

// ── the mapping, exhaustively, with NO environment in the loop ─────────────────────────────────
// This is the cell the old suite could only reach by luck. It cannot skip.
check("ESRCH is the ONLY thing that proves a process gone", livenessFromErrno("ESRCH") === "dead");
check("EPERM reads ALIVE: it exists, it is just not ours to signal", livenessFromErrno("EPERM") === "alive");
for (const code of ["ERR_INVALID_ARG_TYPE", "ERR_OUT_OF_RANGE", "EIO", "EINVAL", "ENOSYS", "", undefined])
  check(`an unfamiliar outcome (${JSON.stringify(code)}) is UNKNOWN, never dead`, livenessFromErrno(code) === "unknown", code);

// ── the real syscall agrees with the mapping ──────────────────────────────────────────────────
check("our own pid is alive", probeLiveness(process.pid) === "alive");
// A pid that cannot be running: allocate one by watching a child exit. Guessing a high number risks
// picking a live process and inverting this cell silently.
const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
await new Promise<void>((r) => dead.once("exit", () => r()));
const deadPid = dead.pid!;
check("a just-exited child reads dead", probeLiveness(deadPid) === "dead", deadPid);

// ── ATTRIBUTION: reading a live pid's command, and what may be concluded from it ───────────────
// The mirror of the liveness rule one question over. Liveness says the pid exists; attribution says
// whether what exists is OURS. Both fail toward the old behaviour on doubt, and the pure predicate
// is separated from the OS read for the same reason `livenessFromErrno` is: a fixture that cannot
// be produced on the test host must not be the only guard on a branch.
check("a supervise argv is recognised", commandIsCotalSupervisor("node /usr/local/bin/cotal supervise --space main"));
check("...at the end of the line too (no trailing flags)", commandIsCotalSupervisor("node bin/cotal.ts supervise"));
check("...and through a dev tsx invocation", commandIsCotalSupervisor("node --import tsx bin/cotal.ts supervise --runtime pty"));
for (const other of ["vim SPEC.md", "node server.js", "/usr/bin/supervised-thing --x", "cotal up", ""])
  check(`an unrelated command line is NOT a manager (${JSON.stringify(other)})`, !commandIsCotalSupervisor(other), other);
// SUBSTRING IS NOT ENOUGH, and this is the cell that says so: the token test is what keeps
// `supervised-thing` above from reading as a manager, so a rewrite to `includes("supervise")`
// resolves a stranger to ours and the attribution stops attributing.
// WHERE THERE IS AN ARGV SOURCE. win32 has none that this reads, so `readProcessCommand` answers
// `unreadable` there and the caller may conclude nothing — which is not a gap to hide behind a skip
// but a contract with its own cell below. Everything that needs a real command line is gated on it.
const ARGV_READABLE = process.platform !== "win32";
if (ARGV_READABLE)
  check("this very process is readable and is NOT a manager", (() => {
    const r = readProcessCommand(process.pid);
    return r.kind === "command" && !commandIsCotalSupervisor(r.command);
  })(), readProcessCommand(process.pid));
else
  check("on win32 a process's argv is UNREADABLE, and the reader says so rather than guessing",
    readProcessCommand(process.pid).kind === "unreadable", readProcessCommand(process.pid));
if (ARGV_READABLE)
  check("a pid with no process behind it reads GONE, never as a command", readProcessCommand(deadPid).kind === "gone", { deadPid, got: readProcessCommand(deadPid) });

// ── THE CALLERS, which are the actual change ──────────────────────────────────────────────────
// Driven through a real pidfile in a real cotal root, not by calling the predicate by hand: the
// defect being guarded is a caller reading the contract in the wrong DIRECTION, so the caller has
// to be the thing that runs.
const root = mkdtempSync(join(tmpdir(), "cotal-pidcaller-"));
mkdirSync(join(root, ".cotal"), { recursive: true });
const prevCwd = process.cwd();
/** Long-lived children this suite spawns as fixtures; killed in the finally, counted, never leaked. */
const strays: ReturnType<typeof spawn>[] = [];
try {
  process.chdir(root);
  const { managerUp, managerLiveness } = await import("../../../implementations/cli/src/lib/manager-proc.js");
  const { deliveryUp } = await import("../../../implementations/cli/src/lib/delivery-proc.js");

  const mgrPid = join(root, ".cotal", "manager.pid");
  const delPid = join(root, ".cotal", "delivery.pid");

  // A REAL live process that reads as a manager: `supervise` is in its argv, exactly as every route
  // to a running manager puts it there. It is a real process, not a stand-in, because the point of
  // attribution is that the caller looks at what is actually behind the pid — and this test runner
  // (whose argv is a smoke script) is then a genuine FOREIGN fixture, needing no mock either.
  const supervisorish = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)", "supervise"], { stdio: "ignore" });
  strays.push(supervisorish);
  await new Promise((r) => setTimeout(r, 300)); // let it exec, so `ps` sees the final argv
  const supervisorPid = supervisorish.pid as number;

  writeFileSync(mgrPid, `${supervisorPid}\n`);
  writeFileSync(delPid, `${process.pid}\n`);
  check("managerUp is TRUE for a live pid running a manager", managerUp() === true, supervisorPid);
  check("deliveryUp is TRUE for a live pid", deliveryUp() === true);

  // THE RECORD THAT OUTLIVED ITS PROCESS. `.cotal/manager.pid` held 1940925 on a box whose live
  // supervisor was 3883139: the recorded process had exited, and the number is eventually reused by
  // something unrelated. `kill(pid, 0)` says "alive" for that stranger forever, so every reader
  // reports a healthy manager that does not exist. This runner IS such a stranger: alive, recorded,
  // and provably not a manager.
  writeFileSync(mgrPid, `${process.pid}\n`);
  if (ARGV_READABLE) {
    check("a live pid that is NOT a manager reads as FOREIGN, not as a healthy manager", managerLiveness() === "foreign", process.pid);
    check("and managerUp is FALSE for it, so a start path is not blocked forever by a stranger", managerUp() === false);
  } else {
    // ATTRIBUTION MAY ONLY DOWNGRADE ON PROOF, and on win32 there is none to be had. The stranger is
    // therefore still trusted, which is exactly the pre-existing behaviour on every platform: this
    // change makes the recycled-pid record detectable where an argv source exists and changes
    // nothing where it does not. Asserted rather than skipped, so the blind spot is a stated fact.
    check("on win32 a live stranger stays ALIVE, because nothing was established about it",
      managerLiveness() === "alive", process.pid);
    check("...and managerUp is TRUE for it, unchanged from before attribution existed", managerUp() === true);
  }
  writeFileSync(mgrPid, `${supervisorPid}\n`);

  writeFileSync(mgrPid, `${deadPid}\n`);
  writeFileSync(delPid, `${deadPid}\n`);
  check("managerUp is FALSE for a proven-dead pid (else ensureManager never starts one)", managerUp() === false, deadPid);
  check("deliveryUp is FALSE for a proven-dead pid", deliveryUp() === false, deadPid);

  writeFileSync(mgrPid, "not-a-pid\n");
  check("managerUp is FALSE for an unattributable pidfile", managerUp() === false);
  rmSync(mgrPid);
  check("managerUp is FALSE with no pidfile at all", managerUp() === false);

  // The tri-state the boolean cannot express. `unknown` is deliberately absent here: no
  // parsePid-accepted input produces one on a real kernel, and the note at the end says so rather
  // than a cell pretending to cover it.
  const { deliveryLiveness } = await import("../../../implementations/cli/src/lib/delivery-proc.js");
  check("managerLiveness reports ABSENT with no pidfile (distinct from dead)", managerLiveness() === "absent");
  writeFileSync(mgrPid, "not-a-pid\n");
  // NOT absent. Folding corrupt content into "nothing recorded" let the ensure paths overwrite it
  // and launch a replacement over a record that may front a live process nobody can identify.
  check("managerLiveness reports UNATTRIBUTABLE for corrupt content, distinct from absent", managerLiveness() === "unattributable");
  writeFileSync(mgrPid, "");
  check("an EMPTY pidfile is ABSENT (a husk), not unattributable", managerLiveness() === "absent");
  writeFileSync(mgrPid, `${deadPid}\n`);
  check("managerLiveness reports DEAD for a proven-dead pid", managerLiveness() === "dead", deadPid);
  writeFileSync(mgrPid, `${supervisorPid}\n`);
  check("managerLiveness reports ALIVE for a live pid running a manager", managerLiveness() === "alive", supervisorPid);
  check("deliveryLiveness reports DEAD for a proven-dead pid", (writeFileSync(delPid, `${deadPid}\n`), deliveryLiveness()) === "dead", deadPid);

  // ── THE UNKNOWN BRANCH, driven deterministically ────────────────────────────────────────────
  // `unknown` is only producible by kernel policy (a seccomp SECCOMP_RET_ERRNO filter, an LSM
  // answering security_task_kill), so no input reaches it and until now it was guarded by nothing
  // executable. The probe is a dependency; injecting it drives the exact branch review reproduced
  // with a live seccomp filter, and does it on every platform in milliseconds.
  const { ensureManager } = await import("../../../implementations/cli/src/lib/manager-proc.js");
  const stuck = () => "unknown" as const;

  writeFileSync(mgrPid, `${process.pid}\n`); // a LIVE holder, the dual review proved was overwritten
  check("managerLiveness surfaces UNKNOWN rather than folding it to a boolean", managerLiveness(stuck) === "unknown");
  // An `unknown` liveness is never attributed: there is no process established to look at. This
  // pins that the command read is not what produces the verdict here — a reader that ran anyway
  // would resolve this record (a live pid, not a manager) to `foreign` and lose the refusal below.
  const before = readFileSync(mgrPid, "utf8");
  let refused: string | undefined;
  try {
    ensureManager({}, stuck);
  } catch (e) {
    refused = (e as Error).message;
  }
  check("ensureManager REFUSES on unknown instead of returning a healthy result", refused !== undefined);
  check("the refusal names the pid it could not attribute", refused?.includes(String(process.pid)) === true, refused?.slice(0, 80));
  check("the refusal names the cause an operator can act on (seccomp/LSM)", /seccomp|LSM/i.test(refused ?? ""));
  // The dual defect: the old shape overwrote a LIVE holder's pidfile with a replacement it could
  // then neither stop nor track. Refusing must leave the record exactly as it found it.
  check("the refusal does NOT overwrite the live holder's pidfile", readFileSync(mgrPid, "utf8") === before);

  // THE ORDERING BUG, which the refusal above did NOT cover and nothing caught. `ensureControlPlane`
  // runs preflight -> ensureDelivery -> ensureManager. The preflight read `managerUp()`, which folds
  // unknown to false, so an unattributable manager with no delivery-aware marker (exactly the old
  // Plane-3-hosting shape) read as "no old manager": the preflight skipped, a second daemon was
  // minted, written and started, and only THEN did ensureManager throw. A guard that runs after the
  // work is not a guard, so the preflight refuses first and this pins the position, not just the rule.
  const { stopOldHostingManagerIfPresent } = await import("../../../implementations/cli/src/lib/delivery-proc.js");
  rmSync(join(root, ".cotal", "manager.delivery-aware"), { force: true }); // no marker: the old shape
  let preflightRefused: string | undefined;
  try {
    await stopOldHostingManagerIfPresent(stuck);
  } catch (e) {
    preflightRefused = (e as Error).message;
  }
  check("the delivery cutover preflight REFUSES on an unattributable manager", preflightRefused !== undefined);
  check("it refuses BEFORE the daemon, naming double-binding as the reason", /double-bind/i.test(preflightRefused ?? ""), preflightRefused?.slice(0, 90));
  check("the preflight leaves the manager pidfile untouched too", readFileSync(mgrPid, "utf8") === before);

  // ── THE ORPHAN, which this PR's own EPERM fix made reachable ────────────────────────────────
  // Resolving EPERM to `alive` is the headline fix. It also means the cutover preflight now
  // RECOGNISES another user's live manager and tries to stop it. The old stopManager caught every
  // signal failure as "already gone" and deleted the pidfile and marker regardless, so a process it
  // was not permitted to signal was recorded as stopped while it kept running and kept its Plane-3
  // bindings. A correct fix upstream reaching a latent destructive bug downstream is the worst
  // shape available, and only a review with a kernel harness found it.
  const { stopManager } = await import("../../../implementations/cli/src/lib/manager-proc.js");
  const alive = () => "alive" as const;
  const refuseSignal = (): never => {
    const e = new Error("operation not permitted") as NodeJS.ErrnoException;
    e.code = "EPERM";
    throw e;
  };
  writeFileSync(mgrPid, `${process.pid}\n`);
  writeFileSync(join(root, ".cotal", "manager.delivery-aware"), `${process.pid}\n`);
  const beforeStop = readFileSync(mgrPid, "utf8");
  // The record names a MANAGER for these cells: the injected probe supplies the liveness and this
  // supplies the attribution, so the EPERM rule below is graded on the signal path and not on
  // whether the fixture pid happens to look like a manager.
  const asManager: CommandReader = () => ({ kind: "command", command: "node /usr/local/bin/cotal supervise --space main" });
  let stopRefused: string | undefined;
  try {
    await stopManager(alive, refuseSignal, asManager);
  } catch (e) {
    stopRefused = (e as Error).message;
  }
  check("stopManager REFUSES when the signal is rejected, rather than reporting a stop", stopRefused !== undefined);
  check("the refusal explains EPERM means another user's LIVE process", /another user/i.test(stopRefused ?? ""), stopRefused?.slice(0, 80));
  check("THE PIDFILE SURVIVES a refused stop (the orphan this prevents)", readFileSync(mgrPid, "utf8") === beforeStop);
  check("the delivery-aware marker survives it too", existsSync(join(root, ".cotal", "manager.delivery-aware")));

  // A signal that is ACCEPTED is still not a death. The record goes only on proven death.
  let outlived: string | undefined;
  try {
    await stopManager(alive, () => {}, asManager); // accepted, but the probe keeps saying alive
  } catch (e) {
    outlived = (e as Error).message;
  }
  check("stopManager REFUSES when the process outlives SIGTERM", outlived !== undefined);
  check("and still leaves the pidfile in place", readFileSync(mgrPid, "utf8") === beforeStop);
  check("a proven-dead manager IS cleared (the refusal is not blanket)", (writeFileSync(mgrPid, `${deadPid}\n`), await stopManager()) === "already-gone" && !existsSync(mgrPid), deadPid);

  // ── THE SIBLING, which is worse: it deleted the CREDENTIAL before even attempting the signal ──
  // A refused stop therefore left a LIVE daemon still connected and still serving, with its pidfile
  // and its renewal source both gone, and the function returned success. Ordering is the defect as
  // much as the catch: nothing may be removed before the process is proven gone.
  const { stopDelivery } = await import("../../../implementations/cli/src/lib/delivery-proc.js");
  writeFileSync(delPid, `${process.pid}\n`);
  const delBefore = readFileSync(delPid, "utf8");
  let delRefused: string | undefined;
  try {
    await stopDelivery(alive, refuseSignal);
  } catch (e) {
    delRefused = (e as Error).message;
  }
  check("stopDelivery REFUSES a signal it cannot send, rather than reporting success", delRefused !== undefined);
  check("THE DELIVERY PIDFILE SURVIVES it", readFileSync(delPid, "utf8") === delBefore);
  check("the refusal says the credential was preserved, which is the strand it prevents", /credential are LEFT IN PLACE|standing credential/i.test(delRefused ?? ""), delRefused?.slice(0, 90));

  // ── EMPTY vs MALFORMED, the inverse pair ────────────────────────────────────────────────────
  // My first version cleared BOTH, which contradicts this file's own top-level contract: content
  // parsePid rejects is unattributable and is never a record to delete against. An empty pidfile is
  // a pre-protocol husk with nothing behind it; a garbled one may front a live process nobody can
  // identify, and clearing it orphans that process under a clean-stop report.
  writeFileSync(mgrPid, "not-a-pid\n");
  writeFileSync(join(root, ".cotal", "manager.delivery-aware"), "not-a-pid\n");
  let malformed: string | undefined;
  try {
    await stopManager();
  } catch (e) {
    malformed = (e as Error).message;
  }
  check("stopManager REFUSES a malformed pidfile instead of clearing it", malformed !== undefined);
  check("the malformed pidfile SURVIVES", existsSync(mgrPid));
  check("and so does the marker beside it", existsSync(join(root, ".cotal", "manager.delivery-aware")));
  writeFileSync(mgrPid, "");
  check("an EMPTY pidfile IS cleared (a husk, not a claim)", (await stopManager()) === "already-gone" && !existsSync(mgrPid));

  writeFileSync(delPid, "garbled\n");
  let delMalformed: string | undefined;
  try {
    await stopDelivery();
  } catch (e) {
    delMalformed = (e as Error).message;
  }
  check("stopDelivery REFUSES a malformed pidfile too", delMalformed !== undefined);
  check("the malformed delivery pidfile SURVIVES", existsSync(delPid));

  // ── ensure paths must REFUSE corrupt content, not overwrite it ───────────────────────────────
  // Fixing only the stop helpers was insufficient: with corrupt content read as `absent`,
  // ensureManager cheerfully launched a replacement and rewrote the record.
  writeFileSync(mgrPid, "not-a-pid\n");
  const corruptBefore = readFileSync(mgrPid, "utf8");
  let ensureRefused: string | undefined;
  try {
    ensureManager({});
  } catch (e) {
    ensureRefused = (e as Error).message;
  }
  check("ensureManager REFUSES corrupt content instead of launching over it", ensureRefused !== undefined);
  check("and does NOT overwrite the record it could not read", readFileSync(mgrPid, "utf8") === corruptBefore);

  // ── the THIRD stop sibling: a signal accepted is not a death ────────────────────────────────
  // stopAuthService handled EPERM correctly and then deleted the record immediately after a
  // SUCCESSFUL SIGTERM, so a service that ignores it was reported stopped while still running. The
  // reviewer's mutation check survived 226 checks with the deletion removed: nothing asserted the
  // post-signal outcome anywhere.
  const { stopAuthService } = await import("../../../implementations/cli/src/lib/auth-proc.js");
  // The path is hex-encoded per space (readPidPath), so derive it rather than guessing: my first
  // version invented `auth-service.pid`, the helper found nothing, and the cell failed for the wrong
  // reason. A fixture that misses its subject proves nothing about the subject.
  const { PID_PATH: AUTH_PID_PATH } = await import("../../../implementations/cli/src/lib/auth-proc.js").then(
    async (m) => m as unknown as { PID_PATH?: (s: string) => string },
  ).catch(() => ({}) as { PID_PATH?: (s: string) => string });
  const authPid = AUTH_PID_PATH
    ? AUTH_PID_PATH("main")
    : join(root, ".cotal", `auth-service.${Buffer.from("main").toString("hex")}.pid`);
  writeFileSync(authPid, "not-a-pid\n");
  let authMalformed: string | undefined;
  try {
    await stopAuthService("main");
  } catch (e) {
    authMalformed = (e as Error).message;
  }
  check("stopAuthService REFUSES a malformed pidfile", authMalformed !== undefined);
  check("and that record SURVIVES", existsSync(authPid));

  // The gap the reviewer's mutation exposed: 226 checks survived with the final deletion removed,
  // so NOTHING asserted the post-signal outcome. A signal accepted is not a death.
  writeFileSync(authPid, `${process.pid}\n`);
  let authOutlived: string | undefined;
  try {
    await stopAuthService("main", alive, () => {}); // accepted, but never dies
  } catch (e) {
    authOutlived = (e as Error).message;
  }
  check("stopAuthService REFUSES when the service outlives SIGTERM", authOutlived !== undefined);
  check("and preserves its pidfile rather than recording a stop that did not happen", existsSync(authPid));

  // ── pid 0 and negatives must never reach kill ────────────────────────────────────────────────
  // `kill(0, sig)` is POSIX for "signal my own process group", so a pidfile of `0` reaching the raw
  // syscall would signal the caller. The shared parser exists to stop exactly this, and these pin
  // that the stop helpers route through it rather than `Number`.
  for (const hostile of ["0", "-1", "-99"]) {
    writeFileSync(delPid, `${hostile}\n`);
    let sent: number | undefined;
    let threw = false;
    try {
      await stopDelivery(alive, (pid) => { sent = pid; });
    } catch {
      threw = true;
    }
    check(`a delivery pidfile of ${JSON.stringify(hostile)} is refused and NEVER signalled`, threw && sent === undefined, { hostile, sent });
    check(`and its record survives (${JSON.stringify(hostile)})`, existsSync(delPid), hostile);
  }
} finally {
  for (const s of strays) { try { s.kill("SIGKILL"); } catch { /* already gone */ } }
  process.chdir(prevCwd);
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nPID CONTRACT TESTS PASSED ✅  (${pass} checks)`);
console.log(
  "  COVERAGE, precisely: the `unknown` branch IS exercised, via the injected probe seam, including\n" +
  "  that a refusal leaves a live holder's pidfile untouched. What the seam does NOT prove is that\n" +
  "  the real kernel ever produces `unknown` -- that is established outside this suite, by a seccomp\n" +
  "  BPF filter answering kill(pid,0) with an arbitrary errno without executing it (SECCOMP_RET_ERRNO,\n" +
  "  or an LSM through security_task_kill). Both halves are needed and neither substitutes for the\n" +
  "  other: the seam proves the code handles the state, the seccomp harness proves the state happens.",
);
process.exit(0);
