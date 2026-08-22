// @ts-check
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

/**
 * One live `nats-server` process, as `ps` reports it.
 * @typedef {{ pid: number, args: string }} NatsServerRow
 */

/**
 * A broker this reaper claimed, with the dead owner whose pid the store dir carried.
 * @typedef {NatsServerRow & { owner: number }} ReapedBroker
 */

/**
 * What one reap pass did, and what it deliberately made no claim on. `supported` is false on a
 * platform where the enumerator cannot look, so a caller can tell "nothing leaked" from "nothing was
 * looked at".
 * @typedef {{ inspected: number, reaped: ReapedBroker[], ownedLive: number, unparseable: number, unclaimable: number, supported: boolean }} ReapReport
 */

/** The stable half of the token minted by `@cotal-ai/smoke-kit`. Duplicated as a literal on purpose:
 *  this file runs from the CI runner before any workspace build, so it must not depend on a built
 *  package. The smoke suite asserts the two are equal, so the duplication cannot drift unnoticed. */
export const SMOKE_BROKER_PREFIX = "cotal-smoke-broker-";

/** The owner's pid, as the kit stamps it into the store dir: `cotal-smoke-broker-<pid>-<random>`. */
const OWNER_RE = /cotal-smoke-broker-(\d+)-/;

/**
 * Every live `nats-server`, as `{ pid, args }`. POSIX only, via `ps`.
 *
 * On Windows this returns an empty list and `reapSmokeBrokers` says so in its report rather than
 * printing a clean bill of health it did not earn. That is a stated platform limit, not a silent
 * degradation: the Windows shards run the same suites, and a reader of that output must be able to
 * tell "nothing leaked" from "nothing was looked at".
 *
 * @returns {NatsServerRow[] | undefined}
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

/** @param {number} pid */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM"; // exists, not ours to signal
  }
};

/**
 * Kill every `nats-server` whose argv carries the smoke token, and report what was seen.
 *
 * A TOKENED BROKER IS NOT A LEAKED ONE. The token says which suite minted the tree; it does not say
 * that suite is finished with it. Two lanes run smokes on a shared box constantly, so a reaper that
 * matched the prefix alone would claim every migrated suite's broker, live owner included.
 * Reproduced before this guard existed: a second lane holding its broker with the owner still alive
 * was listed for the kill, which would have SIGKILLed a live broker mid-run and reddened that lane
 * with a diagnosis pointing at its own code. The untokened negative control could never have caught
 * it, because the victim is tokened. So the owner's liveness, not the token, decides.
 *
 * PID REUSE IS THE LIMIT AND IT FAILS SAFE. If the owner's pid has been recycled by an unrelated
 * process, this reads the owner as alive and declines to reap, so a genuine orphan waits for a later
 * sweep. The error is a delayed cleanup, never a wrong kill, which is the direction this has to fail.
 *
 * A tokened broker in the OLD format (no pid segment) is reported and NOT killed: its owner cannot be
 * established, and an unknown owner is not the same as a dead one.
 *
 * Returns `{ inspected, reaped, ownedLive, unparseable, unclaimable, supported }`. `reaped` names the
 * pids actually killed; `ownedLive` counts tokened brokers whose owner is still running; `unclaimable`
 * counts every live broker this reaper deliberately made no claim on, which is the number that keeps
 * a quiet run honest.
 *
 * `dryRun` returns the exact same set without signalling anything, so the claim a reaper makes can be
 * read before it is acted on. It is the honest way to answer "what would this kill on my machine",
 * and the answer is worth having: on one developer box, of 15 live brokers it claimed 1.
 *
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {ReapReport}
 */
export function reapSmokeBrokers({ dryRun = false } = {}) {
  const rows = listNatsServers();
  if (rows === undefined) {
    return { inspected: 0, reaped: [], ownedLive: 0, unparseable: 0, unclaimable: 0, supported: false };
  }

  const tokened = rows.filter((r) => r.args.includes(SMOKE_BROKER_PREFIX));
  /** @type {ReapedBroker[]} */
  const reaped = [];
  let ownedLive = 0, unparseable = 0;
  for (const { pid, args } of tokened) {
    const owner = OWNER_RE.exec(args);
    if (!owner) { unparseable++; continue; } // pre-fix format: owner unknown, which is not owner dead
    if (alive(Number(owner[1]))) { ownedLive++; continue; } // someone is still using it
    if (!alive(pid)) continue;
    if (dryRun) { reaped.push({ pid, args, owner: Number(owner[1]) }); continue; }
    try {
      // SIGKILL, not SIGTERM. There is no tree to remove here, so nothing is racing a graceful
      // flush, and a broker that already ignored its owner's teardown has earned the uncatchable one.
      process.kill(pid, "SIGKILL");
      reaped.push({ pid, args, owner: Number(owner[1]) });
    } catch (e) {
      console.error(`smoke broker reaper: could not kill pid ${pid}: ${/** @type {Error} */ (e).message}`);
    }
  }
  return {
    inspected: rows.length,
    reaped,
    ownedLive,
    unparseable,
    unclaimable: rows.length - reaped.length,
    supported: true,
  };
}

/**
 * One line when there is nothing to say, a named list when there is.
 *
 * @param {string} label
 * @param {ReapReport} result
 * @returns {void}
 */
export function reportReaped(label, result) {
  if (!result.supported) {
    console.log(`  [reaper] not run on ${process.platform}: leaked smoke brokers are NOT checked here`);
    return;
  }
  if (result.reaped.length === 0) {
    const owned = result.ownedLive > 0 ? `, ${result.ownedLive} owned by a live process` : "";
    const old = result.unparseable > 0 ? `, ${result.unparseable} tokened with no owner recorded` : "";
    console.log(`  [reaper] no leaked smoke brokers after ${label} (${result.inspected} nats-server live, ${result.unclaimable} not claimed${owned}${old})`);
    return;
  }
  console.log(`  [reaper] ✗ ${label} LEAKED ${result.reaped.length} broker(s) it had already been asked to own:`);
  for (const { pid, args } of result.reaped) console.log(`  [reaper]   killed pid ${pid}: ${args.slice(0, 120)}`);
}
