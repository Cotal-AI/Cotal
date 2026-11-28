import { isConcreteChannel, PLUGIN_MENTION_POINTER_KEY, type CotalEndpoint, type CotalMessage, type Delivery, type MessageMeta, type PluginMentionPointer } from "@cotal-ai/core";
import { isPluginChannel } from "./agent-channels.js";

const MAX_PENDING = 64;
const WAIT_MS = 5_000;
const RETRY_MS = 200;

function pointerOf(message: CotalMessage): PluginMentionPointer | undefined {
  const [part] = message.parts;
  if (message.parts.length !== 1 || part?.kind !== "data" || !part.data || typeof part.data !== "object") return;
  const pointer: unknown = (part.data as Record<string, unknown>)[PLUGIN_MENTION_POINTER_KEY];
  if (!pointer || typeof pointer !== "object") return;
  const { channel, message: id, seq } = pointer as Record<string, unknown>;
  if (typeof channel !== "string" || !isConcreteChannel(channel) || !isPluginChannel(channel) ||
      typeof id !== "string" || !id || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return;
  return { channel, message: id, seq };
}

type Pending = { message: CotalMessage; meta: MessageMeta; pointer: PluginMentionPointer; delivery: Delivery; expires: number };

/** Quarantine reserved notice data until the admitted route and independent lease read agree. */
export class PluginMentionIntake {
  private readonly pending = new Map<string, Pending>();
  private timer?: ReturnType<typeof setTimeout>;
  private reading = false;
  private stopped = false;
  private wireEpoch = 0;
  private lost = 0;

  constructor(
    private readonly endpoint: () => CotalEndpoint,
    private readonly resolve: (pointer: PluginMentionPointer, delivery: Delivery) => Promise<void>,
    private readonly deliverLegacy: (message: CotalMessage, delivery: Delivery, meta: MessageMeta) => void,
  ) {}

  get dropped(): number { return this.lost; }

  clearDropped(seen: number): void { this.lost = Math.max(0, this.lost - seen); }

  /** In admitted legacy mode the reserved pointer has no meaning and DM behavior stays unchanged. */
  accept(message: CotalMessage, delivery: Delivery, meta: MessageMeta): boolean {
    const mode = this.endpoint().channelRoutingMode();
    if (mode === "legacy") return false;
    const pointer = pointerOf(message);
    if (!pointer) return false;
    if (this.stopped) return true;
    // Two ordinary DMs can carry identical data. Only a broker retry of the same message
    // replaces its pending delivery handle here. Resolved plugin posts deduplicate in the inbox.
    const key = JSON.stringify([message.from.id, message.id]);
    const old = this.pending.get(key);
    if (old) {
      if (delivery.durable) old.delivery = delivery;
    } else if (this.pending.size < MAX_PENDING) {
      this.pending.set(key, { message, meta, pointer, delivery, expires: performance.now() + WAIT_MS });
    } else if (mode === "isolated") {
      this.drop(delivery);
    }
    this.pump();
    return true;
  }

  onTransport(): void {
    this.wireEpoch++;
    this.pump();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.pending.clear();
  }

  private drop(delivery: Delivery): void {
    this.lost++;
    delivery.ack();
  }

  private pump(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const now = performance.now();
    const ep = this.endpoint();
    const mode = ep.channelRoutingMode();
    for (const [key, item] of this.pending) {
      if (mode === "legacy") {
        this.pending.delete(key);
        this.deliverLegacy(item.message, item.delivery, item.meta);
      } else if (item.expires <= now) {
        this.pending.delete(key);
        // While the mode is unknown this could still be ordinary mail. Its DM durable retains
        // the unacked copy for redelivery without holding it in memory or reporting a notice loss.
        if (mode === "isolated") this.drop(item.delivery);
      }
    }
    if (!this.pending.size) return;
    this.timer = setTimeout(() => this.pump(), RETRY_MS);
    this.timer.unref();
    if (mode !== "isolated" || this.reading) return;
    this.reading = true;
    void this.readLease(ep, this.wireEpoch);
  }

  private async readLease(ep: CotalEndpoint, epoch: number): Promise<void> {
    try {
      const lease = (await ep.readDeliveryLeaseEntry(0))?.info;
      if (this.stopped || this.wireEpoch !== epoch || ep.channelRoutingMode() !== "isolated" ||
          !lease?.ready || typeof lease.holder !== "string" || !lease.holder) return;
      const now = performance.now();
      for (const [key, item] of this.pending) {
        this.pending.delete(key);
        if (item.expires <= now || item.message.from.id !== lease.holder) this.drop(item.delivery);
        else void this.resolve(item.pointer, item.delivery);
      }
    } catch {
      // An unreadable lease is not evidence about the sender. The bounded timer retries it.
    } finally {
      this.reading = false;
    }
  }
}
