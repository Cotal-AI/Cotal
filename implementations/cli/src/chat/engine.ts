/**
 * The minimal client-side participant engine for ONE admitted chat session: the three behaviours
 * the native `CotalEndpoint` does not provide on its own (handoff r5 §Engine seam):
 *
 *   1. per-session attention and per-channel quiet/mute buffering (the session's own inbox);
 *   2. bounded coalescing of the live and durable copies of one message, keyed by the
 *      subject-verified sender principal plus message id;
 *   3. reply resolution for senders that have no roster row, from authenticated senders only.
 *
 * It holds no authority, opens nothing, publishes nothing. It consumes exactly what the native
 * `"message"` event hands a listener: `(CotalMessage, Delivery, MessageMeta)`. Every decision reads
 * subject-derived data only: `MessageMeta.kind` (from the delivering subject) and `msg.from.id`
 * (verified by the endpoint against the subject sender before the event fires, core
 * `endpoint.ts:6203-6213`, `:6293`). Payload names, mentions and routing fields never authorize.
 *
 * Acknowledgement is deferred: the native durable `Delivery.ack` is `JsMsg.ack()` and is not called
 * before the listener runs (`endpoint.ts:7192-7199`, `:6232`, `:5962`). Live copies (`durable:false`)
 * and history backfill have no-op acks; nothing redelivers them. The engine acks a durable copy only
 * when the caller reports it surfaced, or when it drops it on purpose (mute), never on receipt.
 */
import type { AttentionMode, ChannelMode, CotalMessage, Delivery, MessageMeta } from "@cotal-ai/core";
import { partsToText } from "@cotal-ai/core";
import type { SessionMessage } from "./session.js";

/** Bound on buffered items. Provisional; set at review. */
export const MAX_BUFFER = 500;
/** Bound on remembered handled ids for cross-path coalescing (two rotating windows of this size). */
export const MAX_HANDLED_IDS = 4096;
/** Bound on remembered unrostered senders for reply resolution. */
export const MAX_SENDERS = 256;

/** What the engine tells its caller to do with an accepted message. */
export type Disposition =
  /** Show it now, then call {@link ParticipantEngine.surfaced} with its key. */
  | { readonly kind: "surface"; readonly message: SessionMessage }
  /** Held in the session inbox (quiet channel or focus/dnd). Read with peek/drain. */
  | { readonly kind: "buffered"; readonly message: SessionMessage }
  /** Dropped on purpose (muted channel, or an already handled copy). Already acked when durable. */
  | { readonly kind: "dropped"; readonly reason: "muted" | "duplicate-handled" }
  /** A later copy of a message still pending here; the stored ack handle may have been upgraded. */
  | { readonly kind: "coalesced" };

interface Pending {
  readonly message: SessionMessage;
  ack: Delivery["ack"];
  durable: boolean;
  buffered: boolean;
}

/** The overflow report: what was let go and how, so the UI can show it instead of hiding it. */
export interface Overflow {
  /** Channel items released to make room. Durable ones were acked (dropped for good). */
  readonly channelDropped: number;
  /** Directed items (DM/anycast) left unacked so the broker redelivers them later. */
  readonly directedDeferred: number;
}

export class ParticipantEngine {
  private attention: AttentionMode = "open";
  private readonly modes = new Map<string, ChannelMode>();
  /** Pending by delivery key, in arrival order. Includes surfaced-not-yet-acked and buffered. */
  private readonly pending = new Map<string, Pending>();
  /** Sender+id coalescing key -> delivery key; only non-empty ids. */
  private readonly byId = new Map<string, string>();
  private handled = new Set<string>();
  private handledPrev = new Set<string>();
  /** Authenticated senders seen on DM/anycast: principal -> last display name. Insertion-ordered LRU. */
  private readonly senders = new Map<string, string>();
  private seq = 0;
  private overflow: Overflow = { channelDropped: 0, directedDeferred: 0 };

  constructor(private readonly selfPrincipal: string) {}

  setAttention(mode: AttentionMode): void {
    this.attention = mode;
  }

  setChannelMode(channel: string, mode: ChannelMode | "normal"): void {
    if (mode === "normal") this.modes.delete(channel);
    else this.modes.set(channel, mode);
  }

  channelModes(): Record<string, ChannelMode> {
    return Object.fromEntries(this.modes);
  }

  /** Feed one native `"message"` event. `mentionsMe` is advisory display only (payload-derived). */
  accept(msg: CotalMessage, delivery: Delivery, meta: MessageMeta | undefined, mentionsMe: boolean): Disposition {
    // The native endpoint always passes meta on the message paths; without it the class is unknown,
    // so it is never surfaced as directed. Treat it as a channel item with no channel.
    const kind = meta?.kind ?? "channel";
    // Identity of one logical message: the subject-verified sender principal plus its message id. The
    // id alone is sender-chosen, so two senders reusing one id must never collapse into one entry.
    const idKey = msg.id === "" ? undefined : `${msg.from.id}\u0000${msg.id}`; // an empty id is never a dedup key
    if (idKey !== undefined && (this.handled.has(idKey) || this.handledPrev.has(idKey))) {
      if (delivery.durable) delivery.ack();
      return { kind: "dropped", reason: "duplicate-handled" };
    }
    if (idKey !== undefined) {
      const key = this.byId.get(idKey);
      const existing = key === undefined ? undefined : this.pending.get(key);
      if (existing) {
        // Keep one entry. Only a durable copy may replace the ack handle; a live no-op never
        // downgrades a durable one (same rule as the connector, agent.ts:1019-1037).
        if (delivery.durable) {
          existing.ack = delivery.ack;
          existing.durable = true;
        }
        return { kind: "coalesced" };
      }
    }
    if (kind !== "channel") this.rememberSender(msg.from.id, msg.from.name);
    const channel = kind === "channel" ? msg.channel : undefined;
    const mode = channel === undefined ? undefined : this.modes.get(channel);
    if (kind === "channel" && mode === "muted") {
      if (delivery.durable) delivery.ack();
      if (idKey !== undefined) this.markHandled(idKey);
      return { kind: "dropped", reason: "muted" };
    }
    const message = this.toMessage(msg, kind, meta?.historical === true, mentionsMe, delivery);
    // Directed traffic (DM/anycast) is never held by attention: it is the reply route. Channel
    // traffic is held when the channel is quiet, or when attention is not open, unless it mentions us
    // in `open`/`dnd` (a mention is advisory and payload-forgeable, so it only changes visibility,
    // never authority). Historical backfill is held: context, not a live turn.
    const hold = kind === "channel" && (
      mode === "quiet" ||
      message.historical ||
      this.attention === "focus" ||
      (this.attention === "dnd" && !mentionsMe)
    );
    this.pending.set(message.deliveryKey, { message, ack: delivery.ack, durable: delivery.durable, buffered: hold });
    if (idKey !== undefined) this.byId.set(idKey, message.deliveryKey);
    this.enforceBound();
    return hold ? { kind: "buffered", message } : { kind: "surface", message };
  }

  /** Buffered items in arrival order, left buffered (peek). */
  inbox(): readonly SessionMessage[] {
    return [...this.pending.values()].filter((p) => p.buffered).map((p) => p.message);
  }

  /** Take buffered items out of the buffer for showing. They stay pending (unacked) until the caller
   *  reports them with {@link surfaced}; if it never does, durable copies redeliver. */
  drain(): readonly SessionMessage[] {
    const out: SessionMessage[] = [];
    for (const [key, p] of this.pending) {
      if (!p.buffered) continue;
      this.pending.set(key, { ...p, buffered: false });
      out.push(p.message);
    }
    return out;
  }

  bufferedCount(): number {
    let n = 0;
    for (const p of this.pending.values()) if (p.buffered) n++;
    return n;
  }

  /** Commit after the caller has shown these deliveries. Unknown keys are ignored (already acked). */
  surfaced(keys: readonly string[]): void {
    for (const key of keys) {
      const p = this.pending.get(key);
      if (!p) continue;
      this.pending.delete(key);
      const k = this.keyOf(p.message);
      if (k !== undefined) {
        this.byId.delete(k);
        this.markHandled(k);
      }
      p.ack();
    }
  }

  private keyOf(m: SessionMessage): string | undefined {
    return m.id === "" ? undefined : `${m.from.id}\u0000${m.id}`;
  }

  /** Overflow since the last call, then reset. A UI shows it as a gap, never silently. */
  takeOverflow(): Overflow {
    const o = this.overflow;
    this.overflow = { channelDropped: 0, directedDeferred: 0 };
    return o;
  }

  /**
   * Resolve a DM target that the roster resolver did not find. Only exact authenticated principals
   * this session received a DM or anycast from are eligible (their id came from the subject sender).
   * A display name is accepted only when exactly one such unrostered sender carried it. Returns
   * `ambiguous` instead of picking.
   */
  resolveUnrostered(target: string, rosteredIds: ReadonlySet<string>): { id: string; name: string } | "ambiguous" | undefined {
    const byId = this.senders.get(target);
    if (byId !== undefined) return { id: target, name: byId };
    const want = target.trim().toLowerCase();
    if (!want) return undefined;
    const matches = [...this.senders].filter(([id, n]) => !rosteredIds.has(id) && n.toLowerCase() === want);
    if (matches.length > 1) return "ambiguous";
    const m = matches[0];
    return m ? { id: m[0], name: m[1] } : undefined;
  }

  /** Release everything on close without acking: undelivered durable copies redeliver to the
   *  next reader of this lifecycle's durable, which, after retirement, is nobody. */
  clear(): void {
    this.pending.clear();
    this.byId.clear();
  }

  private toMessage(msg: CotalMessage, kind: SessionMessage["kind"], historical: boolean, mentionsMe: boolean, d: Delivery): SessionMessage {
    return {
      deliveryKey: `${++this.seq}`,
      id: msg.id,
      ts: msg.ts,
      kind,
      from: { id: msg.from.id, name: msg.from.name, ...(msg.from.role ? { role: msg.from.role } : {}) },
      ...(kind === "channel" && msg.channel !== undefined ? { channel: msg.channel } : {}),
      ...(kind === "anycast" && msg.toService !== undefined ? { service: msg.toService } : {}),
      text: partsToText(msg.parts),
      ...(msg.replyTo !== undefined ? { replyTo: msg.replyTo } : {}),
      mentionsMe,
      historical,
      ...(d.redelivery ? { deliveryCount: d.redelivery.deliveryCount } : {}),
    };
  }

  private rememberSender(id: string, name: string): void {
    if (id === this.selfPrincipal) return;
    this.senders.delete(id);
    this.senders.set(id, name);
    if (this.senders.size > MAX_SENDERS) this.senders.delete(this.senders.keys().next().value!);
  }

  private markHandled(id: string): void {
    this.handled.add(id);
    if (this.handled.size >= MAX_HANDLED_IDS) {
      this.handledPrev = this.handled;
      this.handled = new Set();
    }
  }

  /** Keep the buffer bounded. Channel items go first (acked if durable: an explicit, reported drop);
   *  directed items are never acked on overflow, only forgotten locally so the broker redelivers. */
  private enforceBound(): void {
    while (this.pending.size > MAX_BUFFER) {
      let victim: [string, Pending] | undefined;
      for (const e of this.pending) if (e[1].buffered && e[1].message.kind === "channel") { victim = e; break; }
      if (!victim) for (const e of this.pending) if (e[1].message.kind === "channel") { victim = e; break; }
      if (!victim) victim = this.pending.entries().next().value as [string, Pending];
      const [key, p] = victim;
      this.pending.delete(key);
      const k = this.keyOf(p.message);
      if (k !== undefined) this.byId.delete(k);
      if (p.message.kind === "channel") {
        if (p.durable) p.ack();
        this.overflow = { ...this.overflow, channelDropped: this.overflow.channelDropped + 1 };
      } else {
        this.overflow = { ...this.overflow, directedDeferred: this.overflow.directedDeferred + 1 };
      }
    }
  }
}
