// Who answered an anycast message. The wire carries no claim event for one, so the only evidence is a
// later message whose replyTo names it.
import type { CotalMessage } from "../api/types.js";

/** Who answered an anycast message: the sender of the first later message whose replyTo is
 *  `anycastId`. `id` is the authenticated `senderId` when the reply carries one, and then `verified`
 *  is true. A reply read from history has no senderId, so the payload's `from.id` answers and
 *  `verified` is false: the claimer is only what the reply says about itself. A blank `anycastId`
 *  claims nothing, and neither does a list with no such reply: the result is then undefined. `id` is
 *  never a display name: the caller resolves names through the roster. */
export function claimedBy(anycastId: string, later: { msg: CotalMessage; senderId?: string }[]): { id: string; verified: boolean } | undefined {
  if (!anycastId) return undefined; // a blank id would match every message that has no replyTo
  for (const { msg, senderId } of later) {
    if (msg.replyTo === anycastId) return senderId !== undefined ? { id: senderId, verified: true } : { id: msg.from.id, verified: false };
  }
  return undefined;
}
