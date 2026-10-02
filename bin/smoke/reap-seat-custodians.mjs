// @ts-check
/**
 * Find seat custodians that a smoke suite started and then failed to reap, and kill them.
 *
 * WHY THIS IS SEPARATE FROM THE BROKER REAPER. A leaked `nats-server` is recognized by the store dir
 * its owner minted; a leaked custodian has no such artifact, because the custody record it writes is
 * the FIRST thing a settle removes, and an orphan is precisely the case where no settle ran. What it
 * does carry is the run marker `@cotal-ai/seat` puts on its argv, which is what this file matches
 * (#1648).
 *
 * WHY ARGV HERE, WHERE THE BROKER REAPER REFUSES IT. The broker reaper refuses a bare `nats-server`
 * match because argv there is incidental: it is whatever 151 spawn sites happened to pass, wrong in
 * both directions. The marker here is the opposite: it is minted by one function, for this purpose,
 * and it names the run rather than describing the process. `--cotal-run <marker>` is not a heuristic
 * over somebody else's command line.
 *
 * WHAT IT REFUSES TO DO.
 *
 *   It never kills a custodian that carries no marker. One started before this change, or by an
 *   installed manager rather than a suite, is not this runner's to claim. The report says how many
 *   it saw and could not attribute, so "0 reaped" is never read as "the box is clean".
 *
 *   It never kills a custodian belonging to ANOTHER run. Two lanes run smokes on one box constantly,
 *   and a marker-blind sweep would SIGKILL a live seat mid-suite and redden that lane with a
 *   diagnosis pointing at its own code. Only the marker this runner minted is claimed.
 *
 * WHAT IT CANNOT DO. A custodian that never reached `listen` has no argv marker yet in the sense
 * that matters: it does, but it has not written its record, so nothing else can find it either. That
 * window is bounded by the custodian's own unattended timer, which is the durable answer; this
 * reaper is the prompt one.
 */
import { readFileSync, readdirSync } from "node:fs";

/** The flag `@cotal-ai/seat` puts on every custodian's argv. Duplicated as a literal on purpose:
 *  this file runs from the CI runner before any workspace build, so it must not import a built
 *  package. `seat-run-marker.smoke.ts` asserts the two are equal, so the duplication cannot drift. */
export const RUN_MARKER_FLAG = "--cotal-run";

/**
 * One live custodian.
 * @typedef {{ pid: number, run: string | undefined }} CustodianRow
 */

/**
 * What one pass did. `supported` is false where `/proc` cannot be read, so a caller can tell
 * "nothing leaked" from "nothing was looked at".
 * @typedef {{ inspected: number, reaped: CustodianRow[], unattributed: number, otherRuns: number, supported: boolean }} CustodianReapReport
 */

/**
 * Every live seat custodian, as `{ pid, run }`. Linux only: the custody transport is.
 * @returns {CustodianRow[] | undefined}
 */
export function listCustodians() {
  if (process.platform !== "linux") return undefined;
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch {
    return undefined;
  }
  const rows = [];
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    const pid = Number(e);
    let cmdline;
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue; // exited between the readdir and the read, or not ours to read
    }
    const argv = cmdline.split("\0").filter((s) => s.length > 0);
    if (!argv.some((a) => a.endsWith("/dist/custodian.js"))) continue;
    const at = argv.indexOf(RUN_MARKER_FLAG);
    rows.push({ pid, run: at < 0 ? undefined : argv[at + 1] });
  }
  return rows;
}

/**
 * Kill every custodian carrying `run`, and report what was left alone.
 * @param {string} run
 * @returns {CustodianReapReport}
 */
export function reapRunCustodians(run) {
  const rows = listCustodians();
  if (rows === undefined) return { inspected: 0, reaped: [], unattributed: 0, otherRuns: 0, supported: false };
  const reaped = [];
  let unattributed = 0;
  let otherRuns = 0;
  for (const row of rows) {
    if (row.run === undefined) {
      unattributed++;
      continue;
    }
    if (row.run !== run) {
      otherRuns++;
      continue;
    }
    try {
      // The custodian is a session leader, so its child and that child's descendants share the
      // child's group; killing the custodian alone would leave those behind. SIGKILL the custodian
      // and let its child's group go with the process group the custodian spawned it into.
      process.kill(row.pid, "SIGKILL");
      reaped.push(row);
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ESRCH") throw e;
    }
  }
  return { inspected: rows.length, reaped, unattributed, otherRuns, supported: true };
}

/**
 * Print what a pass found, naming what it could not claim so silence is never read as cleanliness.
 * @param {string} cmd
 * @param {CustodianReapReport} report
 */
export function reportCustodians(cmd, report) {
  if (!report.supported) {
    console.log(`[seat-reaper] ${cmd}: /proc unavailable on ${process.platform}; no custodian census taken`);
    return;
  }
  if (report.reaped.length > 0) {
    console.error(`[seat-reaper] ${cmd} LEAKED ${report.reaped.length} custodian(s); killed:`);
    for (const { pid, run } of report.reaped) console.error(`[seat-reaper]   killed pid ${pid} (run ${run})`);
  }
  if (report.unattributed > 0) {
    console.log(
      `[seat-reaper] ${cmd}: ${report.unattributed} custodian(s) carry no run marker and were NOT claimed (another manager's, or started before run markers)`,
    );
  }
}
