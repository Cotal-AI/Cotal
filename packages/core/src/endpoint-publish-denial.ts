/**
 * A broker publish violation arrives on the CONNECTION, asynchronously, while
 * `nc.publish` itself returns normally. Watching `nc.status()` for OUR subject
 * is how a caller tells a missing GRANT from a missing RESPONDER: the two need
 * opposite responses, and a deadline that reads as "that endpoint isn't there"
 * is the wrong one.
 *
 * REGISTER THE WATCH BEFORE THE PUBLISH IT IS WATCHING. `nc.status()` registers
 * its listener at CALL time, so one created after `nc.publish` cannot see a
 * violation dispatched in between, and that dropped event is indistinguishable
 * from the silence this watch exists to eliminate.
 *
 * RELEASE IS `stop()`, NOT `return()`. The stream is a `QueuedIterator` parked
 * on an internal signal await, so a queued `return()` does not run until the
 * NEXT status event — which on a healthy connection may never come, leaking one
 * listener per call. `status()` is typed as a bare `AsyncIterable`, so `stop`
 * is reached structurally and its absence fails loud HERE rather than leaking
 * quietly.
 *
 * Watch only for OUR subject. The connection is shared, and another component's
 * denial or an unrelated transport error must not fail this call.
 */
import { PermissionViolationError, type NatsConnection } from "@nats-io/transport-node";
import { EpEnvelopeError } from "./endpoint-envelope.js";

export type StatusStream = {
  [Symbol.asyncIterator](): AsyncIterator<{ type: string; error?: unknown }>;
  stop(err?: Error): void;
};

export function openPublishDenialWatch(
  nc: NatsConnection,
  subject: string,
  refusal: (err: PermissionViolationError) => Error,
  what: string,
): { denied: Promise<never>; release(): void } {
  const statusStream = nc.status() as StatusStream;
  if (typeof statusStream?.stop !== "function")
    throw new EpEnvelopeError("unavailable", `the NATS connection's status() stream does not expose stop(); the ${what} permission watch cannot be released and would leak a listener per call`);
  const statusIter = statusStream[Symbol.asyncIterator]();
  const denied = new Promise<never>((_, reject) => {
    void (async () => {
      // Driven by hand rather than `for await` so `release` can CLOSE it: `nc.status()`
      // is connection-lived, and a `for await` parks on the next event and outlives the
      // call, leaking one listener per request.
      for (;;) {
        const { value: s, done } = await statusIter.next();
        if (done === true || s === undefined) return;
        if (s.type !== "error") continue;
        if (s.error instanceof PermissionViolationError && s.error.subject === subject) {
          reject(refusal(s.error));
          return;
        }
      }
    })().catch(() => { /* the status stream ending is not this call's failure; the deadline still governs */ });
  });
  return {
    denied,
    release() {
      statusStream.stop();
      void statusIter.return?.(undefined);
    },
  };
}
