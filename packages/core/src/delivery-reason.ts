/**
 * The trusted Plane-3 reader's per-copy headers on a member's DELIVER store (SPEC 8), shared by the
 * reader that writes them and by every consumer that reads them: the member's own endpoint and a
 * consented recipient.
 *
 * The reason names the native delivery path the reader re-authorized for this copy:
 * `durable-channel` (a durable channel member's backstop copy) or `live-mention` (an `@mention`
 * copy on a `live` channel to a target whose read ACL covers it). It is not the sender's intent, and
 * payload `mentions`, text and the roster never set it. The reader builds fresh headers for every
 * copy from its own entry, so a publisher's same-named header never reaches DLV, and only the
 * delivery daemon's credential may publish there.
 *
 * A copy without the frame header, without exactly one reason value, or with a value this build does
 * not recognize carries no reason. No reason means unknown, never "not a mention".
 */
import { headers, type MsgHdrs } from "@nats-io/nats-core";
import type { Plane3Entry } from "./types.js";

/** Minted only by the trusted DLV writer: this copy is a version-1 frame. */
export const PLANE3_FRAME_HEADER = "Cotal-Delivery-Frame";
/** Set by the trusted reader beside the frame header: why it delivered this copy. A header, not a
 *  frame key, so a recipient that predates it still accepts the version-1 frame unchanged. */
export const PLANE3_REASON_HEADER = "Cotal-Delivery-Reason";

/** Why the trusted reader delivered one DLV copy. */
export type DeliveryReason = Plane3Entry["reason"];

export const isDeliveryReason = (value: unknown): value is DeliveryReason => value === "durable-channel" || value === "live-mention";

/** The headers the reader writes on one DLV copy: fresh, from its own entry's reason and nothing else. */
export function dlvCopyHeaders(reason: unknown): MsgHdrs {
  const h = headers();
  h.set(PLANE3_FRAME_HEADER, "1");
  if (isDeliveryReason(reason)) h.set(PLANE3_REASON_HEADER, reason);
  return h;
}

/** The headers of one delivered copy, as a consumer reads them. */
export interface DeliveredHeaders {
  get(name: string): string;
  values(name: string): string[];
}

/** The reader's reason on one DLV copy: present only with the frame header and exactly one
 *  recognized value. `unrecognized` is a value this build does not know, for the caller to report. */
export function dlvCopyReason(h: DeliveredHeaders | undefined): { reason?: DeliveryReason; unrecognized?: string } {
  if (h?.get(PLANE3_FRAME_HEADER) !== "1") return {};
  const values = h.values(PLANE3_REASON_HEADER);
  if (values.length === 0 || (values.length === 1 && values[0] === "")) return {};
  if (values.length === 1 && isDeliveryReason(values[0])) return { reason: values[0] };
  return { unrecognized: values.join(",").slice(0, 64) };
}
