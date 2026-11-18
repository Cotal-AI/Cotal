import type { MsgHdrs } from "@nats-io/transport-node";

const STORED_ORIGIN_HEADER = /^Nats-(Stream|Subject|Sequence|Time-Stamp)$/i;

/** True when a message carries a header the broker writes on a stored message it serves:
 *  `Nats-Stream`, `Nats-Subject`, `Nats-Sequence` or `Nats-Time-Stamp`. A Direct Get answer carries
 *  them, and a stream that captures such an answer stores them with it. A message that arrives on a
 *  messaging subject, or that a consumer delivers from a messaging stream, with one of them was not
 *  published on that subject by the principal it names, so every messaging receive path drops it
 *  (SPEC §5). Names match without regard to case, and an empty value still counts.
 *
 *  A client's own Direct Get answer carries these headers legitimately. This predicate is for what
 *  arrives on a subscription or a consumer delivery, never for the answer to a read the client sent. */
export function hasStoredOrigin(headers: MsgHdrs | undefined): boolean {
  for (const [name] of headers ?? []) if (STORED_ORIGIN_HEADER.test(name)) return true;
  return false;
}
