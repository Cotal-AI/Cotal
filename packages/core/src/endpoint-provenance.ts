import type { Msg } from "@nats-io/transport-node";

/** Stored-message delivery is not a caller publication on this subject (§13.3). Native provenance
 *  is dropped before parsing, authorization or replies: there is no authenticated caller to answer.
 *  Header names are matched, not values; an empty marker is still a marker. */
export function carriesStoredProvenance(msg: Pick<Msg, "headers">): boolean {
  return hasHeader(msg, /^Nats-(Stream|Subject|Sequence|Time-Stamp)$/i);
}

/** A stored message on a caller's reply read (§13.21): a JetStream read, such as a Direct Get,
 *  delivers one on any subject its requester names, the sentinel included, with `Nats-Stream`,
 *  `Nats-Sequence` and `Nats-Time-Stamp`. `Nats-Subject` alone is no marker here, because the
 *  broker's own no-responders status carries it, naming the request subject. */
export function carriesStoredReplyProvenance(msg: Pick<Msg, "headers">): boolean {
  return hasHeader(msg, /^Nats-(Stream|Sequence|Time-Stamp)$/i);
}

function hasHeader(msg: Pick<Msg, "headers">, name: RegExp): boolean {
  for (const [key] of msg.headers ?? []) if (name.test(key)) return true;
  return false;
}
