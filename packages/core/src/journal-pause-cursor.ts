import type { ConsumerInfo, JetStreamManager, JsMsg } from "@nats-io/jetstream";
import { isConsumerNotFound } from "./jetstream-missing.js";

/** An unacked tail is a witness for idle polls: its removal clears the pending ack and a
 *  later record adds pending delivery. Full replays may replace the durable between polls. */
export function journalPauseCursor(jsm: JetStreamManager, created: ConsumerInfo, anchor: JsMsg) {
  const { stream_name: stream, name, created: generation } = created;
  const { deliverySequence, streamSequence } = anchor.info;
  async function info(): Promise<ConsumerInfo | undefined> {
    try {
      const current = await jsm.consumers.info(stream, name);
      if (current.created === generation && current.config.filter_subject === created.config.filter_subject)
        return current;
    } catch (error) {
      if (!isConsumerNotFound(error)) throw error;
    }
    return undefined;
  }

  return {
    async unchanged(): Promise<boolean> {
      const current = await info();
      if (current === undefined || current.delivered.consumer_seq !== deliverySequence
        || current.delivered.stream_seq !== streamSequence || current.num_pending !== 0
        || current.num_ack_pending !== 1 || current.ack_floor.consumer_seq !== deliverySequence - 1) return false;
      // Progress keeps the unacked anchor and its consumer alive while this run polls.
      anchor.working();
      return true;
    },
    async close(): Promise<void> {
      if (await info() === undefined) return;
      try {
        await jsm.consumers.delete(stream, name);
      } catch (error) {
        if (!isConsumerNotFound(error)) throw error;
      }
    },
  };
}
