import { AckPolicy, DeliverPolicy, ReplayPolicy, type ConsumerConfig, type ConsumerInfo } from "@nats-io/jetstream";
import { dlvDurableConfig, dmDurableConfig, fanoutDurableConfig, inboxReaderConfig, taskDurableConfig } from "./streams.js";
import { FANOUT_DURABLE, INBOX_READER_DURABLE, chatStream, dlvStream, dmStream, inboxStream, taskStream } from "./subjects.js";

function principalFromDurable(name: string, prefix: string): { owner: string; actor: string; lifecycleUid: string } | undefined {
  if (!name.startsWith(prefix)) return undefined;
  // Lifecycle-keyed durables (SPEC §13.1): dm_/dlv_ names carry the uid — `<owner>-<actor>-<lifecycleUid>`
  // (owner/actor are `[A-Za-z0-9_]`, the uid is `[a-z0-9]`, so exactly three dash-separated tokens).
  const match = /^([A-Za-z0-9_]+)-([A-Za-z0-9_]+)-([a-z0-9]+)$/.exec(name.slice(prefix.length));
  return match ? { owner: match[1], actor: match[2], lifecycleUid: match[3] } : undefined;
}

export function expectedConsumerConfig(space: string, stream: string, name: string): Partial<ConsumerConfig> {
  if (stream === chatStream(space) && name === FANOUT_DURABLE) return fanoutDurableConfig(space);
  if (stream === inboxStream(space) && name === INBOX_READER_DURABLE) return inboxReaderConfig(space);
  if (stream === dmStream(space)) {
    const principal = principalFromDurable(name, "dm_");
    if (principal) return dmDurableConfig(space, principal.owner, principal.actor, principal.lifecycleUid);
  }
  if (stream === dlvStream(space)) {
    const principal = principalFromDurable(name, "dlv_");
    if (principal) return dlvDurableConfig(space, principal.owner, principal.actor, principal.lifecycleUid);
  }
  if (stream === taskStream(space) && /^svc_[A-Za-z0-9_-]+$/.test(name))
    return { ...taskDurableConfig(space, name.slice("svc_".length)), deliver_policy: DeliverPolicy.All };
  throw new Error(`unsupported persistent consumer ${stream}/${name}`);
}

const CONSUMER_KEYS = new Set([
  "ack_policy", "ack_wait", "backoff", "deliver_group", "deliver_policy", "deliver_subject",
  "description", "durable_name", "filter_subject", "filter_subjects", "flow_control", "headers_only",
  "idle_heartbeat", "inactive_threshold", "max_ack_pending", "max_batch", "max_bytes", "max_deliver",
  "max_expires", "max_waiting", "mem_storage", "metadata", "name", "num_replicas", "opt_start_seq",
  "opt_start_time", "pause_until", "priority_groups", "priority_policy", "priority_timeout",
  "rate_limit_bps", "replay_policy", "sample_freq",
]);

/** Validate one recognized Cotal pull durable. Limits-retention consumers accept the checkpoint
 * migration shape; TASK remains canonical WorkQueue DeliverAll. */
export function validatePersistentConsumer(space: string, stream: string, info: ConsumerInfo): void {
  const expected = expectedConsumerConfig(space, stream, info.name);
  const config = info.config as ConsumerConfig & Record<string, unknown>;
  const unknown = Object.keys(config).filter((key) => !CONSUMER_KEYS.has(key));
  if (unknown.length) throw new Error(`${stream}/${info.name} has unsupported consumer fields: ${unknown.sort().join(", ")}`);
  if (config.name !== undefined && config.name !== info.name) throw new Error(`${stream}/${info.name} has a mismatched name`);
  if (config.durable_name !== info.name) throw new Error(`${stream}/${info.name} is not a canonical durable`);
  if (config.deliver_subject || config.deliver_group) throw new Error(`${stream}/${info.name} is a push consumer`);
  if (config.filter_subject !== expected.filter_subject || (config.filter_subjects?.length ?? 0) !== 0)
    throw new Error(`${stream}/${info.name} has a noncanonical filter`);
  if (config.ack_policy !== AckPolicy.Explicit || config.ack_wait !== expected.ack_wait)
    throw new Error(`${stream}/${info.name} has noncanonical ACK settings`);

  const task = stream === taskStream(space);
  const migrated = !task && config.deliver_policy === DeliverPolicy.StartSequence;
  const implicitTaskAll = task && config.deliver_policy === undefined;
  if (config.deliver_policy !== expected.deliver_policy && !migrated && !implicitTaskAll)
    throw new Error(`${stream}/${info.name} has a noncanonical delivery policy`);
  if (migrated) {
    if (!Number.isSafeInteger(config.opt_start_seq) || (config.opt_start_seq ?? 0) < 1)
      throw new Error(`${stream}/${info.name} has an invalid creation lower bound`);
  } else if (config.opt_start_seq !== undefined || config.opt_start_time !== undefined) {
    throw new Error(`${stream}/${info.name} has an unexpected start bound`);
  }

  const expectedMaxAck = expected.max_ack_pending ?? 1000;
  if ((config.max_ack_pending ?? 1000) !== expectedMaxAck) throw new Error(`${stream}/${info.name} has noncanonical max_ack_pending`);
  if ((config.max_deliver ?? -1) !== -1 || (config.max_waiting ?? 512) !== 512)
    throw new Error(`${stream}/${info.name} has noncanonical delivery limits`);
  if ((config.replay_policy ?? ReplayPolicy.Instant) !== ReplayPolicy.Instant || (config.num_replicas ?? 0) !== 0)
    throw new Error(`${stream}/${info.name} has noncanonical replay/replica settings`);
  for (const key of [
    "backoff", "description", "flow_control", "headers_only", "idle_heartbeat", "inactive_threshold",
    "max_batch", "max_bytes", "max_expires", "mem_storage", "metadata", "pause_until", "priority_groups",
    "priority_policy", "priority_timeout", "rate_limit_bps", "sample_freq",
  ]) {
    const value = config[key];
    if (
      key === "metadata" && value && typeof value === "object" && !Array.isArray(value) &&
      Object.entries(value as Record<string, unknown>)
        .every(([metadataKey, metadataValue]) => metadataKey.startsWith("_nats.") && typeof metadataValue === "string")
    ) continue;
    if (value !== undefined && value !== false && value !== 0 && value !== "" &&
      !(Array.isArray(value) && value.length === 0) &&
      !(typeof value === "object" && value !== null && Object.keys(value).length === 0))
      throw new Error(`${stream}/${info.name} has active unsupported setting ${key}`);
  }
}

/** True when `info` is the durable `wanted` describes, in the start-bounded shape a full restore
 *  recreates it in ({@link consumerConfigFromCheckpoint}). A create of the canonical config meets
 *  that durable as "consumer already exists"; any other difference stays a conflict. */
export function isRestoredConsumer(space: string, stream: string, info: ConsumerInfo, wanted: Partial<ConsumerConfig>): boolean {
  if (info.name !== wanted.durable_name || info.config.deliver_policy !== DeliverPolicy.StartSequence || info.config.ack_wait !== wanted.ack_wait) return false;
  try { validatePersistentConsumer(space, stream, info); }
  catch { return false; }
  return true;
}

