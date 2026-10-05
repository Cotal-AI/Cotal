/**
 * The process mark that lets mutation-proof and mutation-reproof find what a timed-out command left
 * behind. A group kill cannot reach a descendant that left the group: anything spawned `detached`
 * calls setsid. Measured on a mutant that started a detached `node` and was cut by `--deadline`:
 * the group kill returned with that child still alive. The mark lives in `MUTATION_PROOF_RUN`,
 * which is not a `COTAL_` key: mutation-reproof strips those from every fixture suite. A process
 * that rebuilt its environment without the mark is out of reach; a seat custodian keeps only `PATH`
 * and `COTAL_RUN`.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";

/**
 * A token for this run, and the mark its children carry. An enclosing run's mark is kept in front of
 * the token, so that run's sweep still reaches this run's descendants.
 *
 * @param {string} name
 */
export function runMark(name) {
  const token = `${name}-${process.pid}-${randomUUID()}`;
  return { token, mark: [process.env.MUTATION_PROOF_RUN, token].filter(Boolean).join(" ") };
}

/**
 * Kill every process still carrying `token`, and say what was killed and what survived. Call it only
 * after a timed-out run, when none of the caller's children is legitimately running. Linux reads the
 * marks from `/proc`; elsewhere it says it could not look, never that nothing was left.
 *
 * @param {string} token
 * @param {(line: string) => void} say
 */
export function sweepMarked(token, say) {
  if (!existsSync("/proc/self/environ")) {
    say(`\x1b[33m  no /proc on ${process.platform}: processes that left the timed-out run's group were not looked for\x1b[0m`);
    return;
  }
  const marked = () => readdirSync("/proc").map(Number).filter((pid) => {
    if (!Number.isInteger(pid) || pid === process.pid) return false;
    let environ;
    try { environ = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0"); } catch { return false; }
    return environ.some((entry) =>
      entry.startsWith("MUTATION_PROOF_RUN=") && entry.slice("MUTATION_PROOF_RUN=".length).split(" ").includes(token));
  });
  const killed = new Set();
  let left = marked();
  // A marked process can fork between the scan and the kill, so scan again until none is left.
  for (let round = 0; left.length > 0 && round < 40; round++) {
    for (const pid of left) {
      try { process.kill(pid, "SIGKILL"); killed.add(pid); } catch { /* already gone */ }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    left = marked();
  }
  if (killed.size) say(`\x1b[33m  swept ${killed.size} process(es) that had left the timed-out run's group: ${[...killed].join(", ")}\x1b[0m`);
  if (left.length) say(`\x1b[31m  ${left.length} marked process(es) survived SIGKILL: ${left.join(", ")}\x1b[0m`);
}
