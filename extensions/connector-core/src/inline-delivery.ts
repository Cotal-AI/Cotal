import type { InboxItem, MeshAgent } from "./agent.js";
import { formatInjection } from "./control.js";
import { fmtDeliveryItem } from "./framing.js";

/** Whole messages for a host that can confirm native admission. No receive keys cross the host API. */
export interface InlineDeliveryPayload {
  text: string;
  count: number;
  remaining: number;
}

export interface InlineDeliveryBatch {
  payload: InlineDeliveryPayload;
  /** Recheck before admission: an explicit inbox read or attention change may have superseded it. */
  current(): boolean;
  /** Release every hold; only a successful native admission commits the exact offered deliveries. */
  settle(delivered: boolean): void;
}

type Source = Pick<MeshAgent, "peekInbox" | "isInFlight" | "holdInFlight" | "releaseInFlight" | "drainInboxDeliveries" | "stopping">;

/** Select and format complete automatic messages without consuming a preview or truncating a body.
 * The adapter measures its final transport envelope, including any escaping and receipt metadata. */
export function prepareInlineDelivery(agent: Source, options: {
  connectionId: string;
  fits(payload: InlineDeliveryPayload): boolean;
  maxItemCodePoints?: number;
  maxItems?: number;
}): InlineDeliveryBatch | undefined {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.connectionId)) throw new Error("invalid inline connection identity");
  const maxItem = options.maxItemCodePoints ?? 1_024;
  const maxItems = options.maxItems ?? 8;
  if (!Number.isInteger(maxItem) || maxItem < 1 || !Number.isInteger(maxItems) || maxItems < 1)
    throw new Error("inline delivery limits must be positive whole numbers");
  const pending = agent.peekInbox("automatic");
  const selected: InboxItem[] = [];
  const render = (items: InboxItem[]): InlineDeliveryPayload => {
    const remaining = pending.length - items.length;
    return {
      text: `Cotal: inline messages for connection_id ${options.connectionId}.\n` +
        formatInjection(items, { metadata: true }) +
        "\nThese complete messages were delivered inline; do not fetch them again with cotal_inbox." +
        " Native delivery can repeat after an unconfirmed handoff; use message_id to avoid repeating work." +
        (remaining ? ` ${remaining} other message${remaining === 1 ? " remains" : "s remain"} pending; use cotal_inbox to read those.` : ""),
      count: items.length,
      remaining,
    };
  };
  for (const item of pending) {
    if (selected.length >= maxItems) break;
    if (agent.isInFlight(item.recvKey) || Array.from(fmtDeliveryItem(item)).length > maxItem) continue;
    const candidate = [...selected, { ...item }];
    if (options.fits(render(candidate))) selected.push(candidate[candidate.length - 1]!);
  }
  if (!selected.length) return undefined;
  const keys = selected.map((item) => item.recvKey);
  if (!agent.holdInFlight(keys)) return undefined;
  let settled = false;
  return {
    payload: render(selected),
    current() {
      const live = new Set(agent.peekInbox("automatic").map((item) => item.recvKey));
      return !settled && !agent.stopping && keys.every((key) => live.has(key));
    },
    settle(delivered) {
      if (settled) return;
      settled = true;
      agent.releaseInFlight(keys);
      if (delivered) agent.drainInboxDeliveries(keys);
    },
  };
}
