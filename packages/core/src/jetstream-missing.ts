import { JetStreamApiCodes, JetStreamApiError } from "@nats-io/jetstream";

/** True only for the structured JetStream API absence codes named by the caller. A status 404 or
 * message regex is too broad here: the catch sites use absence to produce a successful empty/fresh
 * result, so a permission denial, timeout, or protocol failure must never pass as "not found". */
export function isJetStreamMissing(e: unknown, ...codes: number[]): boolean {
  return e instanceof JetStreamApiError && codes.includes(e.code);
}

/** One rule for every catch site that treats a missing consumer as success, so no site accepts an
 *  error shape another refuses. */
export function isConsumerNotFound(e: unknown): boolean {
  return isJetStreamMissing(e, JetStreamApiCodes.ConsumerNotFound);
}
