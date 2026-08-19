// Generated from reap-smoke-brokers.mjs by gen-reaper-dts.mts. Do not edit: run `pnpm gen:reaper-dts`.
// The module is the only source of truth for these types; `pnpm smoke:reaper` fails if they drift.

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
export function listNatsServers(): NatsServerRow[] | undefined;
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
export function reapSmokeBrokers({ dryRun }?: {
    dryRun?: boolean;
}): ReapReport;
/**
 * One line when there is nothing to say, a named list when there is.
 *
 * @param {string} label
 * @param {ReapReport} result
 * @returns {void}
 */
export function reportReaped(label: string, result: ReapReport): void;
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
export const SMOKE_BROKER_PREFIX: "cotal-smoke-broker-";
/**
 * One live `nats-server` process, as `ps` reports it.
 */
export type NatsServerRow = {
    pid: number;
    args: string;
};
/**
 * A broker this reaper claimed, with the dead owner whose pid the store dir carried.
 */
export type ReapedBroker = NatsServerRow & {
    owner: number;
};
/**
 * What one reap pass did, and what it deliberately made no claim on. `supported` is false on a
 * platform where the enumerator cannot look, so a caller can tell "nothing leaked" from "nothing was
 * looked at".
 */
export type ReapReport = {
    inspected: number;
    reaped: ReapedBroker[];
    ownedLive: number;
    unparseable: number;
    unclaimable: number;
    supported: boolean;
};
