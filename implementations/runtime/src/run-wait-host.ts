import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import { chatStream, chatSubject, subjectMatches, waitConsumerConfig, waitConsumerName } from "@cotal-ai/core";
import { RunScopeAuthority, RunScopeDenied, WaitReceipts, type WaitReceipt } from "./run-scope-authority.js";

export interface RunWaitMessage {
  readonly sequence: number;
  readonly data: Uint8Array;
  readonly receipt: WaitReceipt;
}

/** Only these operations cross from a driver into the trusted wait host. Broker objects,
 *  consumer names and ACK subjects remain inside the closure. */
export interface RunWaitHost {
  open(requestId: string, channel: string): Promise<void>;
  fetch(requestId: string): Promise<readonly RunWaitMessage[]>;
  ack(requestId: string, receipt: WaitReceipt): Promise<void>;
  close(requestId: string): Promise<void>;
  messageAt(requestId: string, sequence: number): Promise<Uint8Array>;
}

export function createRunWaitHost(
  broker: { js: JetStreamClient; jsm: JetStreamManager; space: string },
  authority: RunScopeAuthority,
): RunWaitHost {
  const stream = chatStream(broker.space);
  const receipts = new WaitReceipts();
  return Object.freeze({
    async open(requestId: string, channel: string): Promise<void> {
      const entry = await authority.wait(requestId, "open");
      if (entry.external?.waitChannel !== channel)
        throw new RunScopeDenied(entry.run, channel, "open unrecorded wait channel");
      await broker.jsm.consumers.add(stream, waitConsumerConfig(broker.space, requestId, channel));
    },
    async fetch(requestId: string): Promise<readonly RunWaitMessage[]> {
      const entry = await authority.wait(requestId, "fetch");
      const channel = entry.external?.waitChannel;
      if (typeof channel !== "string") throw new RunScopeDenied(entry.run, requestId, "fetch unrecorded wait channel");
      const consumer = await broker.js.consumers.get(stream, waitConsumerName(requestId));
      const info = await consumer.info();
      const expected = chatSubject(broker.space, "*", "*", channel);
      if (info.config.filter_subject !== expected || (info.config.filter_subjects?.length ?? 0) !== 0)
        throw new RunScopeDenied(entry.run, requestId, "fetch changed wait filter");
      const messages: RunWaitMessage[] = [];
      const batch = await consumer.fetch({ max_messages: 16, expires: 2_000 });
      try {
        for await (const message of batch) {
          if (!subjectMatches(expected, message.subject))
            throw new RunScopeDenied(entry.run, message.subject, "receive outside wait channel");
          messages.push(Object.freeze({
            sequence: message.seq,
            data: message.data.slice(),
            receipt: receipts.issue(requestId, () => message.ack()),
          }));
        }
      } finally {
        batch.stop();
      }
      return messages;
    },
    async ack(requestId: string, receipt: WaitReceipt): Promise<void> {
      await authority.wait(requestId, "ack");
      await receipts.ack(requestId, receipt);
    },
    async close(requestId: string): Promise<void> {
      await authority.wait(requestId, "close");
      try {
        await broker.jsm.consumers.delete(stream, waitConsumerName(requestId));
      } catch (error) {
        if ((error as { code?: unknown })?.code !== 10014) throw error;
      }
      receipts.close(requestId);
    },
    async messageAt(requestId: string, sequence: number): Promise<Uint8Array> {
      const entry = await authority.matchedMessage(requestId, sequence);
      const channel = entry.external?.waitChannel;
      if (typeof channel !== "string") throw new RunScopeDenied(entry.run, requestId, "read unrecorded wait channel");
      const message = await broker.jsm.streams.getMessage(stream, { seq: sequence });
      if (message === null || message === undefined)
        throw new Error(`wait ${requestId}'s recorded message ${sequence} no longer exists`);
      if (!subjectMatches(chatSubject(broker.space, "*", "*", channel), message.subject))
        throw new RunScopeDenied(entry.run, requestId, "read outside wait channel");
      return message.data.slice();
    },
  });
}
