// Who answered an anycast message. The wire carries no claim event for one, so the only evidence is a
// later message whose replyTo names it.
import type { CotalMessage } from "../api/types.js";

/** The id of whoever answered an anycast message: the sender of the first later message whose replyTo
 *  is `anycastId`. `senderId` is the authenticated sender; the payload's `from.id` answers only when it
 *  is absent. A blank `anycastId` claims nothing, and neither does a list with no such reply: the result
 *  is then undefined. It is an id, never a display name: the caller resolves names through the roster. */
export function claimedBy(anycastId: string, later: { msg: CotalMessage; senderId?: string }[]): string | undefined {
  if (!anycastId) return undefined; // a blank id would match every message that has no replyTo
  for (const { msg, senderId } of later) {
    if (msg.replyTo === anycastId) return senderId ?? msg.from.id;
  }
  return undefined;
}
