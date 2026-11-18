import { DiscardPolicy, type ConsumerInfo, type JetStreamManager, type StreamInfo } from "@nats-io/jetstream";
import { anycastStoreDefinition, assertAuthStoreConfig, assertRecordsStoreConfig, endpointDataStreamConfigs, endpointNameOf, eptReqStreamName,
  eptSubject, epwStreamName, parseEpSubject, poolConsumerConfig, spaceQuiescenceResources, streamReadPolicyBaseline,
  subjectMatches, timerWriterConsumerConfig, validateCanonicalBackupStreamConfig, validatePersistentConsumer,
  validatePullConsumerReadConfig, validateStreamReadConfig } from "@cotal-ai/core";
import { controlConsumerWork } from "./quiescence-control-consumers.js";

export interface QueueObservationReason {
  source: string;
  state: "active" | "unknown";
  count?: number;
}

export interface QueueQuiescenceObservation {
  state: "clear" | "busy" | "unknown";
  reasons: QueueObservationReason[];
  streams: Map<string, StreamInfo>;
  consumers: Map<string, ConsumerInfo>;
  consumersRead: number;
  armedTimers: number;
}

const uint = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Internal queue-only observation. A clear result says nothing about credentials, workflows,
 * retirement, ingress fencing or account identity; the host observer must establish those too. */
export async function observeQueueQuiescence(jsm: JetStreamManager, space: string): Promise<QueueQuiescenceObservation> {
  const resources = spaceQuiescenceResources(space);
  const endpointStreams = new Map(endpointDataStreamConfigs(space).map(config => [config.name, config]));
  const reasons: QueueObservationReason[] = [];
  const streams = new Map<string, StreamInfo>();
  const consumers = new Map<string, ConsumerInfo>();
  let consumersRead = 0;
  let armedTimers = 0;
  const unknown = (source: string) => { reasons.push({ source, state: "unknown" }); };
  const active = (source: string, count: number) => { if (count > 0) reasons.push({ source, state: "active", count }); };
  const consumer = (stream: string, info: ConsumerInfo, expectedName?: string) => {
    if (info.stream_name !== stream || (expectedName !== undefined && info.name !== expectedName) ||
        typeof info.created !== "string" || !info.created ||
        !uint(info.num_pending) || !uint(info.num_ack_pending)) throw new Error("invalid consumer observation");
    let work = true;
    if (resources.controlStreams.includes(stream)) {
      work = controlConsumerWork(space, stream, info);
    } else if (stream === eptReqStreamName(space)) {
      validatePullConsumerReadConfig(stream, info, timerWriterConsumerConfig(space), { allowStartSequence: true });
    } else if (stream === epwStreamName(space)) {
      const split = info.name.lastIndexOf("_");
      if (!info.name.startsWith("pool_") || split <= 5) throw new Error("unsupported pool consumer");
      validatePullConsumerReadConfig(stream, info, poolConsumerConfig(space, endpointNameOf(info.name.slice(5, split)), info.name.slice(split + 1)));
    } else validatePersistentConsumer(space, stream, info);
    consumersRead++;
    consumers.set(`${stream}/${info.name}`, info);
    if (work) active(`${stream}/${info.name}`, info.num_pending + info.num_ack_pending);
  };
  for (const stream of resources.streams) {
    try {
      const info = await jsm.streams.info(stream, stream === resources.armedStream || resources.ingressStreams.includes(stream) ? { subjects_filter: ">" } : undefined);
      if (info.config.name !== stream || typeof info.created !== "string" || !info.created ||
          !uint(info.state.messages) || !uint(info.state.first_seq) || !uint(info.state.last_seq) ||
          !uint(info.state.consumer_count) || info.state.lost !== undefined) throw new Error("invalid stream observation");
      const declared = endpointStreams.get(stream);
      if (stream === `KV_${resources.auth}`) assertAuthStoreConfig(info.config, space);
      else if (stream === `KV_${resources.records}`) assertRecordsStoreConfig(info.config, space);
      else if (stream === `KV_${resources.anycast}`) {
        const definition = anycastStoreDefinition(space);
        validateStreamReadConfig(stream, info.config as unknown as Record<string, unknown>, {
          ...streamReadPolicyBaseline(stream, [`$KV.${definition.bucket}.>`]),
          max_msgs_per_subject: definition.createOptions.history,
          max_bytes: definition.createOptions.max_bytes,
          max_msg_size: definition.createOptions.maxValueSize,
          discard: DiscardPolicy.New,
          allow_direct: true,
          allow_rollup_hdrs: true,
        });
      }
      else if (declared) validateStreamReadConfig(stream, info.config as unknown as Record<string, unknown>,
        { ...streamReadPolicyBaseline(stream, declared.subjects!), ...declared });
      else validateCanonicalBackupStreamConfig(space, stream, info.config as unknown as Record<string, unknown>);
      streams.set(stream, info);
      if (resources.workQueues.includes(stream)) active(stream, info.state.messages);
      if (stream === resources.armedStream) {
        // NATS 2.15.1 purges the one-shot .armed message when its fire is published. Retained
        // .fire messages alone do not keep a native timer scheduled. Read all subjects so the
        // server's total subject/message counts can prove that no page was silently omitted.
        const subjects = Object.entries(info.state.subjects ?? {});
        const total = info.state.num_subjects ?? (info.state.messages === 0 ? 0 : undefined);
        if (!uint(total) || subjects.length !== total) throw new Error("incomplete timer subject observation");
        let messages = 0;
        for (const [subject, count] of subjects) {
          const parsed = parseEpSubject(subject);
          if (!uint(count) || count === 0 || parsed?.plane !== "timer" ||
              (parsed.phase !== "armed" && parsed.phase !== "fire") ||
              eptSubject(space, parsed.endpoint, parsed.instanceId, parsed.epoch, parsed.timerId, parsed.phase) !== subject)
            throw new Error("invalid timer subject observation");
          messages += count;
          if (parsed.phase === "armed") armedTimers += count;
        }
        if (messages !== info.state.messages) throw new Error("incomplete timer message observation");
        active(stream, armedTimers);
      }
    } catch { unknown(stream); }
  }
  for (const { stream, name } of resources.requiredConsumers) {
    try { consumer(stream, await jsm.consumers.info(stream, name), name); }
    catch { unknown(`${stream}/${name}`); }
  }
  for (const stream of resources.consumerStreams) {
    const expected = streams.get(stream)?.state.consumer_count;
    if (expected === undefined) continue; // The stream read already made this observation unknown.
    try {
      const seen = new Set<string>();
      for await (const info of jsm.consumers.list(stream)) {
        if (seen.has(info.name) || seen.size >= expected) throw new Error("consumer inventory changed");
        seen.add(info.name);
        consumer(stream, info);
      }
      if (seen.size !== expected) throw new Error("incomplete consumer inventory");
    } catch { unknown(`${stream}/consumers`); }
  }
  for (const stream of resources.ingressStreams) {
    const info = streams.get(stream);
    if (!info) continue;
    try {
      const subjects = Object.entries(info.state.subjects ?? {});
      const total = info.state.num_subjects ?? (info.state.messages === 0 ? 0 : undefined);
      if (!uint(total) || subjects.length !== total) throw new Error("incomplete ingress subject inventory");
      const filters = [...consumers.values()].filter(row => row.stream_name === stream).map(row => row.config.filter_subject!);
      let messages = 0;
      for (const [subject, count] of subjects) {
        if (!uint(count) || count === 0 || !filters.some(filter => subjectMatches(filter, subject)))
          throw new Error("ingress has no canonical consumer");
        messages += count;
      }
      if (messages !== info.state.messages) throw new Error("incomplete ingress message inventory");
    } catch { unknown(`${stream}/coverage`); }
  }
  return { state: reasons.some(reason => reason.state === "unknown") ? "unknown" : reasons.length ? "busy" : "clear",
    reasons, streams, consumers, consumersRead, armedTimers };
}
