import type { ConsumerInfo } from "@nats-io/jetstream";
import { canonConsumerConfig, decisionReaderConfig, effectsConsumerConfig, endpointNameOf, epfStreamName,
  epjStreamName, eprStreamName, goalReaderConfig, parseEpSubject, recordWriterConsumerConfig,
  recordWriterDurable, RECORD_KINDS, validatePullConsumerReadConfig } from "@cotal-ai/core";

/** Validate a stock control consumer and distinguish autonomous work from retained caller replies.
 * Tunable ACK waits and canonicalizer concurrency keep the values chosen by their stock builders. */
export function controlConsumerWork(space: string, stream: string, info: ConsumerInfo): boolean {
  const wait = info.config.ack_wait;
  if (typeof wait !== "number" || !Number.isSafeInteger(wait) || wait <= 0) throw new Error("invalid control ACK wait");
  const options = { ackWaitMs: wait / 1_000_000 };
  let expected;
  let work = true;
  if (stream === epjStreamName(space) && info.name.startsWith("canon_")) {
    const pending = info.config.max_ack_pending;
    if (typeof pending !== "number" || !Number.isSafeInteger(pending) || pending === 0 || pending < -1) throw new Error("invalid canonicalizer concurrency");
    expected = canonConsumerConfig(space, endpointNameOf(info.name.slice(6)), { ...options, maxAckPending: pending });
  } else if (stream === eprStreamName(space) && info.name.startsWith("recw_")) {
    const def = Object.values(RECORD_KINDS).find(def => recordWriterDurable(space, def.kind) === info.name);
    if (!def) throw new Error("unsupported record writer kind");
    expected = recordWriterConsumerConfig(space, def, options);
  } else if (stream === epfStreamName(space) && info.name.startsWith("eff_")) {
    const pending = info.config.max_ack_pending;
    if (typeof pending !== "number" || !Number.isSafeInteger(pending) || pending === 0 || pending < -1) throw new Error("invalid effects concurrency");
    expected = effectsConsumerConfig(space, endpointNameOf(info.name.slice(4)), { ...options, maxAckPending: pending });
  } else if (stream === epfStreamName(space)) {
    const parsed = parseEpSubject(info.config.filter_subject ?? "");
    if (parsed?.plane !== "fact" || parsed.topic.length !== 5 || parsed.topic[4] !== ">") throw new Error("unsupported fact consumer");
    const [kind, owner, actor, uid] = parsed.topic as [string, string, string, string, string];
    const caller = { owner, actor, uid };
    if (kind === "dec") expected = decisionReaderConfig(space, parsed.endpoint, caller, options);
    else if (kind === "goal") expected = goalReaderConfig(space, parsed.endpoint, caller, options);
    else throw new Error("unsupported fact reader");
    work = false;
  } else throw new Error("unsupported control consumer");
  validatePullConsumerReadConfig(stream, info, expected, { allowStartSequence: true });
  return work;
}
