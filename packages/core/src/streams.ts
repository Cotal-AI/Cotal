import {
  jetstreamManager,
  AckPolicy,
  DeliverPolicy,
  RetentionPolicy,
  DiscardPolicy,
  StorageType,
  type ConsumerConfig,
  type JetStreamManager,
} from "@nats-io/jetstream";
import { connect, credsAuthenticator, nanos } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  spacePrefix,
  chatStream,
  chatSubject,
  chatDurable,
  collapseFilterSubjects,
  isConcreteChannel,
  dmStream,
  dmDurable,
  unicastSubject,
  taskStream,
  taskDurable,
  anycastSubject,
  presenceBucket,
  channelBucket,
} from "./subjects.js";

/** Default presence-bucket entry TTL (ms) — matches the endpoint's default liveness window. */
const PRESENCE_TTL_MS = 6_000;

/** Per-(sender,channel)-subject retention cap on the chat stream — the bound past which the
 *  oldest message on a subject is discarded (`DiscardPolicy.Old`). Also the horizon of focus
 *  recall: only the last {@link MAX_MSGS_PER_SUBJECT} per sender-subject are recallable. */
export const MAX_MSGS_PER_SUBJECT = 1000;

export interface ClearSpaceHistoryResult {
  chat: number;
  dm?: number;
}

/**
 * Create (idempotently) the three backing streams for a space — CHAT (multicast backlog +
 * history), DM (per-instance inboxes), TASK (anycast work queue).
 *
 * This is **privileged**: under auth mode `STREAM.CREATE` is denied to regular agents
 * (streams are space infrastructure, not per-agent), so it runs once at setup
 * (`cotal up`) or from a permissive endpoint. The single source of the stream
 * definitions, shared by the endpoint and the setup path so they can't diverge.
 */
export async function createSpaceStreams(
  jsm: JetStreamManager,
  space: string,
): Promise<void> {
  const p = spacePrefix(space);
  await jsm.streams.add({
    name: chatStream(space),
    subjects: [`${p}.chat.>`],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_msgs_per_subject: MAX_MSGS_PER_SUBJECT, // capped per-channel backlog (buffer + history)
    discard: DiscardPolicy.Old,
    // Direct Get API stays enabled on CHAT (harmless: agents hold no DIRECT.GET grant). Per-channel
    // history reads no longer use it — they go through contained single-filter ephemeral consumers
    // (endpoint `collectHistory`) so the read ACL bounds them. NEVER set on DM/TASK: direct-get
    // would bypass the consumer-create deny that is DM's confidentiality boundary.
    allow_direct: true,
  });
  await jsm.streams.add({
    name: dmStream(space),
    subjects: [`${p}.inst.>`],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
  });
  await jsm.streams.add({
    name: taskStream(space),
    subjects: [`${p}.svc.>`],
    retention: RetentionPolicy.Workqueue,
    storage: StorageType.File,
  });
}

/**
 * The DM inbox durable for an instance — ONE definition, used both by the privileged
 * pre-create (manager/provisioner, auth mode) and the endpoint's open-mode self-create, so
 * an idempotent re-add can never error on a config delta. The `filter_subject` binds the
 * durable to inst.<id>.* — only the privileged creator sets it, which is the whole point:
 * an agent can't create a durable filtered to someone else's inbox.
 *
 * `inactive_threshold` is set ONLY when the caller passes one — i.e. the open-mode
 * self-create, where the agent owns the durable and a threshold cleanly retires its inbox
 * after it departs. The privileged auth pre-create OMITS it: the agent BINDS-only and is
 * denied CONSUMER.CREATE, so a threshold would retire the durable before a late/relaunched
 * agent binds it, and the bind would then fail permanently ("consumer not found"). Persisting
 * it is the price of bind-only; explicit cleanup on agent-stop is a follow-up.
 */
export function dmDurableConfig(
  space: string,
  id: string,
  opts: { ackWaitMs?: number; inactiveThresholdMs?: number } = {},
): Partial<ConsumerConfig> {
  const cfg: Partial<ConsumerConfig> = {
    durable_name: dmDurable(id),
    filter_subject: unicastSubject(space, id, "*"),
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(opts.ackWaitMs ?? 60_000),
    deliver_policy: DeliverPolicy.All,
  };
  if (opts.inactiveThresholdMs) cfg.inactive_threshold = nanos(opts.inactiveThresholdMs);
  return cfg;
}

/**
 * The chat live-tail durable for an instance — ONE definition, used both by the privileged
 * pre-create (manager/provisioner, auth mode) and the endpoint's open-mode self-create, so an
 * idempotent re-add can't error on a config delta. `filter_subjects` binds it to the instance's
 * subscribe set (`chat.*.<ch>` per channel); only the privileged creator sets it under auth, which
 * is the whole point — the agent BINDS-only (denied CONSUMER.CREATE/UPDATE on CHAT) and so can
 * never widen its own read past `allowSubscribe`. `DeliverPolicy.New` (a tail): history is the
 * explicit per-channel backfill on join, the only shape that can honor per-channel replay policy
 * given `deliver_policy` is consumer-wide.
 *
 * Multi-channel ⇒ plural `filter_subjects`, which the client sends on the filter-less create
 * subject (`CONSUMER.CREATE.<stream>.<name>`) — so this durable's filter is NOT ACL-pinnable by
 * subject; bind-only + a trusted creator is the enforcement, exactly as for DM/TASK.
 *
 * `inactive_threshold` is set ONLY when the caller passes one — the open-mode self-create, where
 * the agent owns the durable. The privileged auth pre-create OMITS it (same bind-only reasoning as
 * {@link dmDurableConfig}): a threshold would retire the durable before a late/relaunched agent
 * binds it, and bind would then fail permanently.
 */
export function chatDurableConfig(
  space: string,
  id: string,
  channels: string[],
  opts: { ackWaitMs?: number; inactiveThresholdMs?: number } = {},
): Partial<ConsumerConfig> {
  const cfg: Partial<ConsumerConfig> = {
    durable_name: chatDurable(id),
    filter_subjects: collapseFilterSubjects(channels.map((ch) => chatSubject(space, "*", ch))),
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(opts.ackWaitMs ?? 60_000),
    deliver_policy: DeliverPolicy.New,
  };
  if (opts.inactiveThresholdMs) cfg.inactive_threshold = nanos(opts.inactiveThresholdMs);
  return cfg;
}

/**
 * The TASK work-queue durable for a role — ONE definition, shared by the privileged
 * pre-create (auth mode) and the endpoint's open-mode self-create. The durable is shared
 * across all instances of a role (queue group); the privileged creator sets the
 * filter_subject to svc.<role>.* so an agent can't bind a consumer filtered to another
 * role's queue (the same create-time-filter attack surface as DM). Idempotent per role.
 */
export function taskDurableConfig(
  space: string,
  role: string,
  opts: { ackWaitMs?: number } = {},
): Partial<ConsumerConfig> {
  return {
    durable_name: taskDurable(role),
    filter_subject: anycastSubject(space, role, "*"),
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(opts.ackWaitMs ?? 60_000),
  };
}

/** Connect with the given (privileged) creds, create the space's streams, and disconnect.
 *  Used by `cotal up` to pre-create streams once at setup. */
export async function setupSpaceStreams(opts: {
  servers: string;
  space: string;
  /** Privileged creds for an authed mesh; omit on an open mesh (a bare connection has the rights). */
  creds?: string;
}): Promise<void> {
  const nc = await connect({
    servers: opts.servers,
    ...(opts.creds ? { authenticator: credsAuthenticator(new TextEncoder().encode(opts.creds)) } : {}),
  });
  try {
    await createSpaceStreams(await jetstreamManager(nc), opts.space);
    // The presence + channels KV buckets are streams too — pre-create them so agents (denied
    // KV stream-create) can open them. Idempotent. Presence is TTL'd (liveness); the channel
    // registry is durable config, so no TTL.
    const kvm = new Kvm(nc);
    await kvm.create(presenceBucket(opts.space), { ttl: PRESENCE_TTL_MS });
    await kvm.create(channelBucket(opts.space));
  } finally {
    await nc.drain();
  }
}

/** Purge retained message history for a running space. This intentionally leaves TASK alone:
 *  anycast is queued work, not replay history. */
export async function clearSpaceHistory(opts: {
  servers: string;
  space: string;
  creds?: string;
  includeDms?: boolean;
}): Promise<ClearSpaceHistoryResult> {
  const nc = await connect({
    servers: opts.servers,
    ...(opts.creds ? { authenticator: credsAuthenticator(new TextEncoder().encode(opts.creds)) } : {}),
  });
  try {
    const jsm = await jetstreamManager(nc);
    const chat = (await jsm.streams.purge(chatStream(opts.space))).purged;
    if (!opts.includeDms) return { chat };
    const dm = (await jsm.streams.purge(dmStream(opts.space))).purged;
    return { chat, dm };
  } finally {
    await nc.drain();
  }
}

/** Delete one channel and its content: purge every retained message on the channel (across
 *  all senders, via the `*` sender slot) from the chat stream, then drop the channel's
 *  registry config so it stops surfacing as an empty channel. Needs PURGE rights — pass
 *  privileged creds (e.g. `manager`); a bare connection (open mode) has them by default.
 *  Throws on a wildcard channel (a subtree is not a deletable channel). A missing channel
 *  registry bucket/key is a no-op — the purge alone already emptied the channel. */
export async function clearChannel(opts: {
  servers: string;
  space: string;
  channel: string;
  creds?: string;
}): Promise<{ channel: string; purged: number }> {
  if (!isConcreteChannel(opts.channel))
    throw new Error(`"${opts.channel}" is a wildcard, not a deletable channel`);
  const nc = await connect({
    servers: opts.servers,
    ...(opts.creds ? { authenticator: credsAuthenticator(new TextEncoder().encode(opts.creds)) } : {}),
  });
  try {
    const jsm = await jetstreamManager(nc);
    const { purged } = await jsm.streams.purge(chatStream(opts.space), {
      filter: chatSubject(opts.space, "*", opts.channel),
    });
    try {
      const registry = await new Kvm(nc).open(channelBucket(opts.space));
      await registry.delete(opts.channel);
    } catch {
      /* no channel registry bucket or no config for this channel — purge already emptied it */
    }
    return { channel: opts.channel, purged };
  } finally {
    await nc.drain();
  }
}
