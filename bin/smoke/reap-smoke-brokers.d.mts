/**
 * Types for `reap-smoke-brokers.mjs`.
 *
 * The reaper stays plain `.mjs` on purpose: it runs from the CI runner before any workspace build,
 * so it must not depend on a built package or on a TypeScript loader. That leaves its consumers
 * untyped, which is how six implicit `any` parameters and an untyped import sat in a suite nothing
 * typechecked.
 *
 * Stated hazard, because a declaration file beside an implementation is a SECOND source of truth:
 * nothing here is checked against the module's actual shape, so a change to the reaper that this
 * file does not follow is a silent lie in the direction of a green typecheck. The one value that is
 * guarded is `SMOKE_BROKER_PREFIX`, which `reaper.smoke.ts` asserts equals the kit's own constant.
 * Keep the two in step by hand, and prefer widening a type here to narrowing one.
 */

/** The stable half of the token minted by `@cotal-ai/smoke-kit`. */
export declare const SMOKE_BROKER_PREFIX: string;

/** One live `nats-server` process, as `ps` reports it. */
export interface NatsServerRow {
  pid: number;
  args: string;
}

/** A broker this reaper claimed, with the dead owner whose pid the store dir carried. */
export interface ReapedBroker extends NatsServerRow {
  owner: number;
}

/** What one reap pass did, and what it deliberately made no claim on. */
export interface ReapReport {
  inspected: number;
  reaped: ReapedBroker[];
  ownedLive: number;
  unparseable: number;
  unclaimable: number;
  /** False on a platform where the enumerator cannot look, so a caller can tell "nothing leaked"
   *  from "nothing was looked at". */
  supported: boolean;
}

/** Every live `nats-server`, or `undefined` where this platform cannot be enumerated. */
export declare function listNatsServers(): NatsServerRow[] | undefined;

/** Kill every tokened broker whose owner is gone. `dryRun` returns the same claim unacted on. */
export declare function reapSmokeBrokers(opts?: { dryRun?: boolean }): ReapReport;

/** Print one pass's result, including the platform-not-supported case. */
export declare function reportReaped(label: string, result: ReapReport): void;
