/**
 * Formats the suites a shard's break-on-first-failure left unexecuted.
 *
 * `shard.mjs` already prints its own plan ("N of M smokes") at startup and a banner for each
 * smoke it starts. Both are true and neither says how many of the plan never got a banner: a
 * reader has to diff the two lists by hand to find out, across however many suites the plan
 * held. This computes that diff at the point the shard already knows it - the moment it breaks -
 * so "never ran" is something the shard states, not something a reader reconstructs later from
 * two other statements.
 */

/**
 * @param {string[]} mine - the shard's full partition, in execution order (as printed at startup).
 * @param {number} failedIndex - index into `mine` of the smoke that just failed.
 * @returns {string} empty if the failure was the partition's last entry, else a report block.
 */
export function neverRanBlock(mine, failedIndex) {
  const rest = mine.slice(failedIndex + 1);
  if (rest.length === 0) return "";
  return [
    "",
    `NEVER RAN — ${rest.length} of ${mine.length} planned smoke(s) in this shard's partition did not start, because the shard stopped at the failure above:`,
    ...rest.map((cmd) => `  ${cmd}`),
  ].join("\n");
}
