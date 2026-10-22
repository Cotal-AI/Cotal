import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type { InlineDeliveryBatch, InlineDeliveryPayload } from "@cotal-ai/connector-core";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
export const INLINE_FRAME_LIMIT = 4_096;
export interface NativeInlineFrame {
  id: string;
  inline: InlineDeliveryPayload & { v: 1; receipt: string; session: string };
  route: string;
}
interface Offer {
  frame: NativeInlineFrame;
  reader: Socket;
  batch: InlineDeliveryBatch;
  claimed: boolean;
  timer: ReturnType<typeof setTimeout>;
  onSettled(delivered: boolean): void;
  retry(): void;
}

/** Validate a private helper frame before any of its text can enter a native conversation. */
export function isNativeInlineFrame(value: unknown): value is NativeInlineFrame {
  if (!value || typeof value !== "object") return false;
  const frame = value as NativeInlineFrame;
  const item = frame.inline;
  return typeof frame.id === "string" && ID.test(frame.id) && typeof frame.route === "string" &&
    !!item && item.v === 1 && typeof item.receipt === "string" && ID.test(item.receipt) &&
    typeof item.session === "string" && ID.test(item.session) && typeof item.text === "string" &&
    item.text.startsWith(`Cotal: inline messages for connection_id ${frame.id}.\n`) &&
    Number.isInteger(item.count) && item.count > 0 && item.count <= 8 &&
    Number.isInteger(item.remaining) && item.remaining >= 0 && JSON.stringify(frame).length <= INLINE_FRAME_LIMIT;
}

/** Transient native handoffs hold existing inbox entries, not a second message or ACK store. */
export class NativeDeliveries {
  private offers = new Map<string, Offer>();
  private sessions = new Set<string>();
  private settled = new Map<string, { id: string; session: string; delivered: boolean; retry?: () => void }>();

  constructor(private readonly route: string, private readonly timeoutMs = 30_000) {}

  fits(id: string, session: string, payload: InlineDeliveryPayload): boolean {
    return isNativeInlineFrame({ id, inline: { ...payload, v: 1, receipt: "0".repeat(36), session }, route: this.route });
  }

  send(reader: Socket, id: string, session: string, batch: InlineDeliveryBatch, onSettled: (delivered: boolean) => void, retry: () => void): boolean {
    if (this.sessions.has(session) || !this.fits(id, session, batch.payload)) return false;
    const receipt = randomUUID();
    const frame: NativeInlineFrame = { id, inline: { ...batch.payload, v: 1, receipt, session }, route: this.route };
    const timer = setTimeout(() => this.finish(receipt, false), this.timeoutMs);
    timer.unref?.();
    this.offers.set(receipt, { frame, reader, batch, timer, claimed: false, onSettled, retry });
    this.sessions.add(session);
    try { reader.write(`${JSON.stringify(frame)}\n`); }
    catch { this.finish(receipt, false); return false; }
    return true;
  }

  request(value: Record<string, unknown>): Record<string, unknown> {
    const { receipt, session, id, action } = value;
    if (typeof receipt !== "string" || typeof session !== "string" || typeof id !== "string") return { ok: false };
    const offer = this.offers.get(receipt);
    const prior = this.settled.get(receipt);
    if (action === "retry") {
      if (!prior || prior.id !== id || prior.session !== session) return { ok: false };
      const retry = prior.retry;
      prior.retry = undefined;
      retry?.();
      return { ok: true };
    }
    if (!offer) return { ok: action === "commit" && prior?.delivered === true && prior.id === id && prior.session === session };
    if (offer.frame.id !== id || offer.frame.inline.session !== session) return { ok: false };
    if (action === "claim") {
      if (!offer.batch.current() || offer.reader.destroyed) { this.finish(receipt, false); return { ok: false }; }
      offer.claimed = true;
      return { ok: true, frame: offer.frame };
    }
    if (action === "reject") { this.finish(receipt, false); return { ok: true }; }
    if (action === "commit" && offer.claimed && typeof value.uuid === "string" && ID.test(value.uuid)) {
      return { ok: this.finish(receipt, true) };
    }
    return { ok: false };
  }

  private finish(receipt: string, delivered: boolean): boolean {
    const offer = this.offers.get(receipt);
    if (!offer) return false;
    this.offers.delete(receipt);
    this.sessions.delete(offer.frame.inline.session);
    clearTimeout(offer.timer);
    let committed = delivered;
    try { offer.batch.settle(delivered); }
    catch { committed = false; }
    this.settled.set(receipt, { id: offer.frame.id, session: offer.frame.inline.session, delivered: committed, retry: offer.retry });
    while (this.settled.size > 128) this.settled.delete(this.settled.keys().next().value!);
    offer.onSettled(committed);
    return committed;
  }

  dropReader(reader: Socket): void {
    for (const [receipt, offer] of this.offers) if (offer.reader === reader) this.finish(receipt, false);
  }

  close(): void {
    for (const receipt of this.offers.keys()) this.finish(receipt, false);
    this.settled.clear();
  }
}
