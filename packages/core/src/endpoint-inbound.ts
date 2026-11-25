// Helpers CotalEndpoint and its delivery plane both use to read an incoming message: the channel a
// channel message authenticates to, and the Delivery handle of a JetStream copy. Internal: the package
// index does not re-export this module.
import type { CotalMessage, Delivery } from "./types.js";
import type { Consumer, JsMsg } from "@nats-io/jetstream";
import { millis } from "@nats-io/transport-node";

export function authenticatedChannelMessage<M extends CotalMessage>(msg: M, channel: string): CotalMessage & M {
  if ((msg as CotalMessage).channel === channel && msg.to === undefined && msg.toService === undefined) return msg;
  const { to: _to, toService: _toService, ...base } = msg;
  return { ...base, channel } as CotalMessage & M;
}

/** The ack wait the broker reports for a bound consumer: how long a copy it delivers stays with
 *  its reader without an ack. */
export async function ackWaitOf(consumer: Consumer): Promise<number> {
  const { config } = await consumer.info(true);
  if (config.ack_wait === undefined) throw new Error(`consumer ${config.durable_name} reports no ack wait`);
  return millis(config.ack_wait);
}

/** A JetStream copy's {@link Delivery}, carrying the broker's own redelivery state for it. */
export function durableDelivery(m: JsMsg, ackWaitMs: number): Delivery {
  return {
    ack: () => m.ack(),
    nak: () => m.nak(),
    durable: true,
    redelivery: { deliveryCount: m.info.deliveryCount, ackWaitMs, working: () => m.working() },
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
