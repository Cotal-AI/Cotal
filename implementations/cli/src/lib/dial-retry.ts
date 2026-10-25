import { setTimeout as delay } from "node:timers/promises";
import { TimeoutError } from "@nats-io/transport-node";
import { isAuthRejection } from "@cotal-ai/core";
import { ConnectRefusal } from "@cotal-ai/workspace";

/** Attempts a refused or timed-out connect gets, the first included. Nothing is published on a
 *  connection that never opened, so trying it again repeats nothing. */
export const DIAL_ATTEMPTS = 4;
/** The fixed wait between those attempts, in milliseconds. */
export const DIAL_RETRY_WAIT_MS = 1_000;
/** How long one connect may take, in milliseconds. A connect that is admitted finishes well inside
 *  it; a broker waiting on an auth service that does not answer would otherwise hold it for the
 *  transport's 20 seconds. */
export const DIAL_TIMEOUT_MS = 5_000;

/** How a connect that never opened ended: the broker refused the credential, or the connection did
 *  not open in time. */
export type DialStage = "refused" | "timeout";

/** The stage a failed connect ended at, or undefined for any other failure, which is not retried. */
export function dialStage(e: unknown): DialStage | undefined {
  if (isAuthRejection(e)) return "refused";
  if (e instanceof TimeoutError) return "timeout";
  return undefined;
}

/** Every attempt at a connect ended at the same boundary, so nothing was sent on any of them. */
export class DialNotAdmitted extends Error {
  constructor(readonly stage: DialStage, readonly attempts: number, readonly last: unknown) {
    super(last instanceof Error ? last.message : String(last), { cause: last });
    this.name = "DialNotAdmitted";
  }
}

/** Run `dial` until it opens, trying again after a refused or timed-out attempt, up to
 *  {@link DIAL_ATTEMPTS}. Throws {@link DialNotAdmitted} when every attempt ended that way, and any
 *  other failure at once. `dial` builds its connection afresh each time. */
export async function dialWithRetry<T>(dial: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await dial();
    } catch (e) {
      const stage = dialStage(e);
      if (!stage) throw e;
      if (attempt >= DIAL_ATTEMPTS) throw new DialNotAdmitted(stage, attempt, e);
      await delay(DIAL_RETRY_WAIT_MS);
    }
  }
}

/** A connection the broker did not admit on any attempt, as a refusal at the connect stage: `to` is
 *  what the command connects to and `unsent` what it therefore did not send. It says how the
 *  attempts ended in plain words; the broker's own words stay in the native detail. On a user-auth
 *  mesh the auth service decides admission at connect, as the view exchange decides it before; a
 *  refused view is transient there, so this refusal is transient too. */
export function notAdmittedRefusal(e: DialNotAdmitted, to: string, unsent: string, target: Record<string, unknown>, userAuth: boolean): ConnectRefusal {
  const how = e.stage === "refused" ? `the broker refused all ${e.attempts} attempts` : `none of ${e.attempts} attempts opened within ${DIAL_TIMEOUT_MS / 1000} seconds`;
  const message = `could not connect to ${to}: ${how}, so ${unsent}`;
  const remedy = e.stage === "refused"
    ? userAuth ? "the space's auth service logs why it refused this connection" : undefined
    : "nothing was sent, so the command can be run again once the broker admits connections";
  return new ConnectRefusal(remedy ? `✗ ${message} - ${remedy}` : `✗ ${message}`, undefined, {
    cause: e, kind: "transient", code: e.stage === "refused" ? "PERMISSION_DENIED" : "TARGET_UNAVAILABLE",
    ...(remedy ? { parts: { message, remedy } } : {}), target,
    native: { code: `connect-${e.stage}`, detail: { stage: "connect", attempts: e.attempts, reason: e.message } },
  });
}
