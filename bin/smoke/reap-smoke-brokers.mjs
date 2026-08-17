/**
 * Find `nats-server` processes that a smoke suite started and then failed to kill, and report them.
 *
 * WHY A SEPARATE REAPER EXISTS AT ALL. The teardown helper in `@cotal-ai/smoke-kit` owns a broker by
 * holding the child handle it spawned, which is the right discriminator and covers every case except
 * one: SIGKILL on the suite is uncatchable, so the handle dies with its owner and the broker is
 * orphaned with nothing holding it. That case leaves exactly one piece of evidence behind, the store
 * dir minted through `SMOKE_BROKER_TOKEN`, and matching it is all this file does.
 *
 * WHAT IT REFUSES TO DO, each for a measured reason rather than caution.
 *
 *   It never matches a bare `nats-server`. Argv fails in BOTH directions on a real box. It
 *   under-matches: of 151 `spawn("nats-server"` sites, 38 pass a store dir and no config at all, and
 *   one passes a prebuilt args variable. It over-matches: a `server-open.conf` rule covers 8
 *   processes on this machine of which only some are ever a real mesh. A matcher that is wrong in
 *   both directions cannot be made safe by tuning it, so the token is the only claim made here.
 *
 *   It never validates a candidate by stat-ing the path in its argv. An argv marker outlives the file
 *   it names: measured across 15 orphans on one long-lived box, 4 named a config that no longer
 *   existed, deleted by the very cleanup that failed to kill the process. Stat-validation would have
 *   refused to reap exactly those 4, which are the ones that most needed reaping.
 *
 *   It never counts silence as cleanliness. A run that reaps nothing prints the population it
 *   considered and how much of it it could not claim, because "0 reaped" is what both a clean box and
 *   a completely unmigrated one look like. This reaper is only ever as complete as the migration that
 *   mints the token, and it says so out loud rather than letting a green line imply otherwise.
 *
 * These orphans are not inert. Every one of the 15 measured held a loopback port, and 13 sat inside
 * the OS ephemeral range 32768-60999, which is the same range a suite draws from when it asks for a
 * free port. Left alone they are a live cause of port flake, not just clutter.
 */
import { execFileSync } from "node:child_process";

/** The token minted by `@cotal-ai/smoke-kit`. Duplicated as a literal on purpose: this file runs from
 *  the CI runner before any workspace build, so it must not depend on a built package. The smoke
 *  suite for this reaper asserts the two are equal, so the duplication cannot drift unnoticed. */
export const SMOKE_BROKER_TOKEN = "cotal-smoke-broker-";

/**
 * Every live `nats-server`, as `{ pid, args }`. POSIX only, via `ps`.
 *
 * On Windows this returns an empty list and `reapSmokeBrokers` says so in its report rather than
 * printing a clean bill of health it did not earn. That is a stated platform limit, not a silent
 * degradation: the Windows shards run the same suites, and a reader of that output must be able to
 * tell "nothing leaked" from "nothing was looked at".
 */
export function listNatsServers() {
  if (process.platform === "win32") return undefined;
  let out;
  try {
    out = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return undefined; // no ps: same honesty rule as Windows, reported rather than assumed empty
  }
  const rows = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pid, args] = m;
    // The executable may be bare or an absolute path, and must not match a `pnpm` line that merely
    // MENTIONS nats-server, so anchor on the command word itself.
    if (!/(^|\/)nats-server(\s|$)/.test(args)) continue;
    rows.push({ pid: Number(pid), args });
  }
  return rows;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists, not ours to signal
  }
};

/**
 * Kill every `nats-server` whose argv carries the smoke token, and report what was seen.
 *
 * Returns `{ inspected, reaped, unclaimable, supported }`. `reaped` names the pids actually killed;
 * `unclaimable` counts the live brokers this reaper deliberately made no claim on, which is the
 * number that keeps a quiet run honest.
 *
 * `dryRun` returns the exact same set without signalling anything, so the claim a reaper makes can be
 * read before it is acted on. It is the honest way to answer "what would this kill on my machine",
 * and the answer is worth having: on one developer box, of 15 live brokers it claimed 1.
 */
export function reapSmokeBrokers({ dryRun = false } = {}) {
  const rows = listNatsServers();
  if (rows === undefined) return { inspected: 0, reaped: [], unclaimable: 0, supported: false };

  const mine = rows.filter((r) => r.args.includes(SMOKE_BROKER_TOKEN));
  const reaped = [];
  for (const { pid, args } of mine) {
    if (!alive(pid)) continue;
    if (dryRun) { reaped.push({ pid, args }); continue; } // reports the exact set it WOULD kill
    try {
      // SIGKILL, not SIGTERM. There is no tree to remove here, so nothing is racing a graceful
      // flush, and a broker that already ignored its owner's teardown has earned the uncatchable one.
      process.kill(pid, "SIGKILL");
      reaped.push({ pid, args });
    } catch (e) {
      console.error(`smoke broker reaper: could not kill pid ${pid}: ${e.message}`);
    }
  }
  return { inspected: rows.length, reaped, unclaimable: rows.length - mine.length, supported: true };
}

/** One line when there is nothing to say, a named list when there is. */
export function reportReaped(label, result) {
  if (!result.supported) {
    console.log(`  [reaper] not run on ${process.platform}: leaked smoke brokers are NOT checked here`);
    return;
  }
  if (result.reaped.length === 0) {
    console.log(`  [reaper] no leaked smoke brokers after ${label} (${result.inspected} nats-server live, ${result.unclaimable} not claimable by token)`);
    return;
  }
  console.log(`  [reaper] ✗ ${label} LEAKED ${result.reaped.length} broker(s) it had already been asked to own:`);
  for (const { pid, args } of result.reaped) console.log(`  [reaper]   killed pid ${pid}: ${args.slice(0, 120)}`);
}
