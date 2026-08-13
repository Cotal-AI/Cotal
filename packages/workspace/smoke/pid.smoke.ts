/**
 * PID-ATTRIBUTION CONTRACT smoke (no broker, no child processes).
 *
 * The property that matters and that nothing exercised before: asking the kernel about a process
 * has THREE answers, not two. It is there, it is gone, or it is there but not ours to signal
 * (`EPERM`). A two-state probe folds the third into "gone", and every caller then treats a running
 * process as dead: `managerUp()` says no and a second manager is launched onto a live one, `cotal
 * down` reports a clean stop it never made, `ext` calls a live pidfile stale and invites you to
 * delete it, and the auth CLI tells you to restart a service that is already up.
 *
 * Half the private copies in this repo got this right on their own and half did not, which is why
 * the contract is one module rather than a convention.
 *
 * Run: pnpm smoke:pid-contract
 */
import { strict as assert } from "node:assert";
import { parsePid, probeLiveness } from "../src/pid.js";

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

// ── probeLiveness: three answers ──────────────────────────────────────────────────────────────
check("our own pid is alive", probeLiveness(process.pid) === "alive");

// A pid that cannot be running: allocate one by watching a child exit. Reusing a hardcoded high
// number would be a guess, and a guess that happened to be live would invert this cell silently.
const { spawnSync, spawn } = await import("node:child_process");
const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
await new Promise<void>((r) => dead.once("exit", () => r()));
const deadPid = dead.pid!;
check("a just-exited child reads dead (ESRCH is the only thing that proves gone)", probeLiveness(deadPid) === "dead", deadPid);

// EPERM: pid 1 belongs to root, so an unprivileged probe throws EPERM rather than ESRCH. Assert
// this ONLY when the fixture actually produces EPERM: running as root it succeeds instead, and a
// cell that cannot fail is indistinguishable from one that passed.
let eperm = false;
try {
  process.kill(1, 0);
} catch (e) {
  eperm = (e as NodeJS.ErrnoException).code === "EPERM";
}
if (eperm) {
  check("EPERM reads ALIVE, not dead: it exists, it is just not ours to signal", probeLiveness(1) === "alive");
  // The regression this replaces, stated as executable code rather than as a comment.
  const twoState = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  check("the two-state probe this replaces calls that same live process DEAD", twoState(1) === false);
} else {
  const who = spawnSync("id", ["-u"], { encoding: "utf8" }).stdout.trim();
  console.log(`  · EPERM cell skipped: probing pid 1 did not raise EPERM (uid ${who || "unknown"}); CI is the oracle`);
}

console.log(`\nPID CONTRACT TESTS PASSED ✅  (${pass} checks${eperm ? ", incl. the EPERM pair" : ", EPERM cell skipped"})`);
process.exit(0);
