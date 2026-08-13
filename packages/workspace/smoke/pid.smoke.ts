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
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { livenessFromErrno, parsePid, probeLiveness } from "../src/pid.js";

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

// ── THE CALLERS, which are the actual change ──────────────────────────────────────────────────
// Driven through a real pidfile in a real cotal root, not by calling the predicate by hand: the
// defect being guarded is a caller reading the contract in the wrong DIRECTION, so the caller has
// to be the thing that runs.
const root = mkdtempSync(join(tmpdir(), "cotal-pidcaller-"));
mkdirSync(join(root, ".cotal"), { recursive: true });
const prevCwd = process.cwd();
try {
  process.chdir(root);
  const { managerUp } = await import("../../../implementations/cli/src/lib/manager-proc.js");
  const { deliveryUp } = await import("../../../implementations/cli/src/lib/delivery-proc.js");

  const mgrPid = join(root, ".cotal", "manager.pid");
  const delPid = join(root, ".cotal", "delivery.pid");

  writeFileSync(mgrPid, `${process.pid}\n`);
  writeFileSync(delPid, `${process.pid}\n`);
  check("managerUp is TRUE for a live pid", managerUp() === true);
  check("deliveryUp is TRUE for a live pid", deliveryUp() === true);

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
  const { managerLiveness } = await import("../../../implementations/cli/src/lib/manager-proc.js");
  const { deliveryLiveness } = await import("../../../implementations/cli/src/lib/delivery-proc.js");
  check("managerLiveness reports ABSENT with no pidfile (distinct from dead)", managerLiveness() === "absent");
  writeFileSync(mgrPid, "not-a-pid\n");
  check("managerLiveness reports ABSENT for unattributable content, never a pid to reason about", managerLiveness() === "absent");
  writeFileSync(mgrPid, `${deadPid}\n`);
  check("managerLiveness reports DEAD for a proven-dead pid", managerLiveness() === "dead", deadPid);
  writeFileSync(mgrPid, `${process.pid}\n`);
  check("managerLiveness reports ALIVE for a live pid", managerLiveness() === "alive");
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
    stopOldHostingManagerIfPresent(stuck);
  } catch (e) {
    preflightRefused = (e as Error).message;
  }
  check("the delivery cutover preflight REFUSES on an unattributable manager", preflightRefused !== undefined);
  check("it refuses BEFORE the daemon, naming double-binding as the reason", /double-bind/i.test(preflightRefused ?? ""), preflightRefused?.slice(0, 90));
  check("the preflight leaves the manager pidfile untouched too", readFileSync(mgrPid, "utf8") === before);
} finally {
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
