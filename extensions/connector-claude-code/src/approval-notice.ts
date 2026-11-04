/**
 * The one line that tells a native conversation what the person decided about its pending
 * `cotal_connect`. The host writes it as a feed frame, the wake reader prints it, and the native
 * hooks module admits only these exact shapes, so no other text reaches the model this way.
 */
import type { ApprovalNotice } from "./app-host.js";

export const APPROVAL_ID = /^[a-z2-7]{26}$/;
const STATUSES = new Set<ApprovalNotice["status"]>(["approved", "denied", "expired"]);

/** The frame the host writes to the feed for a decided request, or nothing for any other shape. */
export function approvalFrame(frame: unknown): ApprovalNotice | undefined {
  const approval = (frame as { approval?: unknown } | null)?.approval as Partial<ApprovalNotice> | undefined;
  if (!approval || typeof approval !== "object") return undefined;
  const { name, status, id } = approval;
  if (typeof name !== "string" || !name || name.length > 128 || /[\r\n]/.test(name) || name !== name.trim()) return undefined;
  if (typeof status !== "string" || !STATUSES.has(status as ApprovalNotice["status"])) return undefined;
  if (typeof id !== "string" || !APPROVAL_ID.test(id)) return undefined;
  return { name, status: status as ApprovalNotice["status"], id };
}

/** The line for a decision. Its shapes are fixed; the native module matches them exactly. */
export function approvalEvent(n: ApprovalNotice): string {
  const name = JSON.stringify(n.name);
  switch (n.status) {
    case "approved":
      return `Cotal: the person approved connection ${name}. Finish it: call cotal_connect with name ${name} and approval_id ${JSON.stringify(n.id)}.`;
    case "denied":
      return `Cotal: the person denied connection ${name}. Nothing was connected. Do not ask again unless the person asks you to.`;
    case "expired":
      return `Cotal: the approval for connection ${name} expired before the person decided. Nothing was connected. Call cotal_connect with name ${name} again to ask again.`;
  }
}
