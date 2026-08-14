/**
 * The manager liveness snapshot must report THE PID IT PROBED, not the pid on disk now.
 *
 * WHY THIS IS BEHAVIOURAL AND NOT A GREP. The shell repair cells assert this structurally: they
 * extract `managerRow` from setup.ts and require that it contains no second read. That cell is real
 * but it is bounded by the function it scans — review demonstrated the point by moving the defect
 * ONE CALL DOWN, into `managerLivenessSnapshot` itself: probe the pid from the first read, then
 * re-read the file and return the second value for display. `managerRow` was untouched, so both
 * structural cells stayed green and `mutation-proof` reported SURVIVED against 32 marks while the
 * mutant demonstrably rendered a pid it had never probed.
 *
 * So this suite constructs the race instead of describing it. The probe IS the concurrent writer:
 * it rewrites the pidfile from inside the call, in the exact window between the read and the
 * return. Any second read introduced ANYWHERE below the caller — in the helper, in a callee of the
 * helper, in a future refactor that has not been written yet — returns the rewritten value and
 * reddens S5. That is the property; the grep was a proxy for it.
 *
 * WHAT IT DOES NOT CLAIM. It does not prove a real manager restart has ever been observed in this
 * window; nothing here schedules a real writer. It proves the reported pid and the reported state
 * come from the same bytes, which is the only claim the surface is entitled to make.
 *
 * IT MEASURES SOURCE, DELIBERATELY, and that is a limit worth naming rather than papering over.
 * `managerLivenessSnapshot` is not reachable through the package's `exports` map (only `"."` is
 * exposed), so a suite cannot get at it through the specifier that the shipped CLI resolves. This
 * therefore establishes the invariant in the tree and NOT in the built artifact. It does not call
 * the stale-build refusal, because this suite never loads `dist/` — a guard that cannot change the
 * answer would be decoration, and the end-to-end rendering is covered where the CLI is driven for
 * real.
 *
 * Run: pnpm exec tsx bin/smoke/liveness-snapshot.smoke.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCotalRoot } from "@cotal-ai/workspace";
import { managerLivenessSnapshot, managerLiveness, MANAGER_PID_PATH } from "../../implementations/cli/src/lib/manager-proc.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`); }
};

console.log("\nliveness-snapshot — the reported pid is the pid that was probed\n");

// ---- ANCHOR FIRST, with a negative control -----------------------------------------------------
// `findCotalRoot` walks UP from cwd, so an unanchored scratch resolves against whatever shared
// ancestor happens to carry a `.cotal` — on a box where several worktrees and a home directory are
// in play, that silently points this suite's writes at somebody else's manager record. The anchor
// is what stops it, and the control is what proves the anchor is doing the work rather than the
// walk happening to land in the right place.
const scratchRoot = mkdtempSync(join(tmpdir(), "cotal-liveness-"));
const unanchored = join(scratchRoot, "unanchored");
mkdirSync(unanchored, { recursive: true });
const anchored = join(scratchRoot, "anchored");
mkdirSync(join(anchored, ".cotal"), { recursive: true });

const unanchoredRoot = findCotalRoot(unanchored);
console.log(`  · an unanchored scratch resolves to: ${unanchoredRoot}`);
check("S1-anchor-control: an UNANCHORED dir does NOT resolve to the anchored scratch root",
  unanchoredRoot !== anchored);
// REPORTED, NOT ASSERTED, and the distinction is deliberate. If an ancestor of the temp dir carries
// a `.cotal`, an unanchored resolution walks INTO it. That is not hypothetical: on the box this was
// written on, `findCotalRoot` of a fresh unanchored scratch returned `/tmp`, because `/tmp/.cotal`
// exists there as a populated mesh root holding live credentials. An unanchored suite would have
// written its manager record into another lane's state and read that lane's answers back.
// It is printed rather than failed because it is a fact about the BOX, not about this code — a cell
// that reddens on the environment would be red forever here while this suite is in fact safe, and a
// permanently red cell teaches people to ignore the suite. What this code owes is S2a: its own
// writes land inside its own scratch. That is asserted.
if (unanchoredRoot !== unanchored)
  console.log(`  ⚠ ANCESTOR CAPTURE: an unanchored dir here resolves to ${unanchoredRoot} — a shared root.\n` +
              `    Any suite under this tmpdir that does not anchor itself writes into it.`);
check("S2-anchor: an anchored dir resolves to ITSELF, so every write below lands in the scratch",
  findCotalRoot(anchored) === anchored);

process.chdir(anchored);
const pidPath = MANAGER_PID_PATH();
check("S2a-anchor: the pid path resolves INSIDE the scratch, not into a real .cotal",
  pidPath.startsWith(anchored + "/"));

// ---- THE RACE: the probe is the concurrent writer ----------------------------------------------
writeFileSync(pidPath, "101\n");
let probedPid: number | undefined;
let probeCalls = 0;
const rewritingProbe = (pid: number): "alive" | "dead" | "unknown" => {
  probeCalls++;
  probedPid = pid;
  writeFileSync(pidPath, "202\n"); // the manager restarts mid-call: a new record, a different pid
  return "alive";
};
const snap = managerLivenessSnapshot(rewritingProbe);

// The control comes first: with no probe call, every assertion below is about nothing.
check("S3-control: the injected probe was actually called exactly once", probeCalls === 1);
check("S4: the probe received the pid that was on disk when the call began", probedPid === 101);
check("S5: the RETURNED pid is the pid that was probed, not the value written during the probe",
  snap.pid === 101);
check("S6: the returned raw bytes are the ones that were parsed, not a re-read", snap.raw === "101");
check("S7: the state is the probe's verdict for that same pid", snap.state === "alive");
// Without this, S5 could pass because the writer never ran and the file never moved — "unchanged"
// and "correctly ignored a change" would render identically.
check("S7-control: the concurrent write really did land (else S5 observed no race at all)",
  readFileSync(pidPath, "utf8").trim() === "202");
// The boolean-collapsing wrapper reads through the same call, so it must not reopen the window.
check("S8: managerLiveness (the collapsing wrapper) agrees with the snapshot's state",
  managerLiveness(rewritingProbe) === "alive");

// ---- INVERSE: it is not simply returning the first thing it ever saw ---------------------------
// Without this, an implementation that cached the pid from the run above would pass every cell.
writeFileSync(pidPath, "303\n");
const quiet = managerLivenessSnapshot((): "alive" => "alive");
check("S9-inverse: a later call reports the CURRENT file's pid, so S5 is not a stale cache",
  quiet.pid === 303 && quiet.raw === "303");

// ---- the states that carry no pid, so the surface cannot render one it never had ---------------
rmSync(pidPath, { force: true });
const gone = managerLivenessSnapshot(() => { throw new Error("probe must not run without a record"); });
check("S10: no pidfile is `absent` with NO pid, and the probe is never reached",
  gone.state === "absent" && gone.pid === undefined);
writeFileSync(pidPath, "not-a-pid\n");
const bad = managerLivenessSnapshot(() => { throw new Error("probe must not run on unattributable content"); });
check("S11: unattributable content keeps its raw bytes and yields NO pid",
  bad.state === "unattributable" && bad.pid === undefined && bad.raw === "not-a-pid");
check("S11a: unattributable is NOT collapsed into absent", bad.state !== "absent");

// PIN THE COUNT. A cell that stops running takes its own failure with it, and "13 passed" says
// nothing about how many were meant to run.
const EXPECTED_CELLS = 14;
if (pass + fail !== EXPECTED_CELLS) {
  fail++;
  console.log(`  ✗ FAIL: CELL COUNT: expected ${EXPECTED_CELLS} cells, ran ${pass + fail - 1}`);
}

process.chdir(tmpdir());
if (existsSync(scratchRoot)) rmSync(scratchRoot, { recursive: true, force: true });
console.log(`\nliveness-snapshot: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
