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
  chatWildcard,
  isConcreteChannel,
  dmStream,
  dmDurable,
  unicastSubject,
  taskStream,
  taskDurable,
  anycastSubject,
  presenceBucket,
  channelBucket,
  membersBucket,
  aclBucket,
  membershipBucket,
  deliveryBucket,
  inboxStream,
  dlvStream,
  dlvSubject,
  dlvDurable,
  fanoutDurable,
  readerDurable,
} from "./subjects.js";

/** Default presence-bucket entry TTL (ms) — matches the endpoint's default liveness window. */
const PRESENCE_TTL_MS = 6_000;

/** Per-(sender,channel)-subject retention cap on the chat stream — the bound past which the
 *  oldest message on a subject is discarded (`DiscardPolicy.Old`). Also the horizon of focus
 *  recall: only the last {@link MAX_MSGS_PER_SUBJECT} per sender-subject are recallable. */
export const MAX_MSGS_PER_SUBJECT = 1000;

/** JetStream message-dedup window on the Plane-3 streams: a `Nats-Msg-Id`
 *  (`<msgId>:<owner>:<generation>`) repeated within this window is collapsed. Sized generous (2h) so
 *  an activation-catch-up copy and a racing fan-out copy of the same message dedup even for a slow/
 *  backlogged owner. **This window IS the cross-path exactly-once correctness horizon** — two writes
 *  of the same logical copy separated by more than it (e.g. a manager crash after a DLV publish, the
 *  dinbox ack lost, the window expiring, then a re-transfer after restart) are NOT collapsed at the
 *  stream. The connector's commit-aware id-cache (`MeshAgent.ingest`) coalesces live↔durable and
 *  redelivery duplicates within a SESSION, but it is in-memory and reset on agent restart, so it is
 *  NOT a cross-restart guarantee. A persistent per-owner delivery ledger would lift the bound; not
 *  built (the 2h horizon covers the realistic crash/redelivery lag). Keep the window ≥ worst-case lag. */
export const PLANE3_DEDUP_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Bound on the trusted reader's in-flight (un-acked) entries per owner — an offline owner with a large
 *  backlog can't stall the reader's own redelivery by pinning unbounded pending. */
export const DINBOX_MAX_ACK_PENDING = 1000;

/** Delivery-daemon single-flight lease TTL (ms) — the bucket-level `max_age` on `cotal_delivery_<space>`.
 *  A live holder renews at ~half this; a crashed holder stops renewing and the bucket TTL expires its
 *  lease key, freeing it for a fresh daemon's CAS create. Sized well above the renew interval so a brief
 *  GC/scheduling pause never self-evicts a healthy holder, yet short enough that a crash frees the shard
 *  promptly. (The bucket holds ONLY lease keys, so a bucket TTL is exact here; per-key TTL is also
 *  available on this stack — a deliberate simplicity choice, not a capability gap. See {@link deliveryBucket}.) */
export const LEASE_TTL_MS = 30_000;

/** Manager singleton-lease TTL (ms) — the bucket-level `max_age` on `cotal_manager_<space>`. Shorter
 *  than the delivery lease so a crashed manager frees the space for a replacement promptly; the holder
 *  renews at ~half it, leaving a 2× margin so a brief GC/scheduling pause never self-evicts a healthy
 *  manager. Tune here (independent of the delivery lease above). */
export const MANAGER_LEASE_TTL_MS = 10_000;

/** Bucket-level `max_bytes` cap on the derived membership feed (`cotal_membership_<space>`). The
 *  per-agent keying keeps each value tiny (a handful of channel patterns), so 64 MiB bounds the footprint
 *  far above any realistic readership while keeping the bucket from growing unbounded. A deliberate cap,
 *  not a guess at scale — the design is cap-safe by construction (per-agent, store-patterns-not-expanded). */
export const MEMBERSHIP_MAX_BYTES = 64 * 1024 * 1024;

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
  // Plane-3 (SPEC §8). INBOX = the mixed pre-auth store (fan-out target; agents hold no grant — see
  // permissionsFor). DLV = the per-member post-auth handoff the agent binds + acks. Both per-owner
  // (one subject per owner), capped per-owner backlog (DiscardPolicy.Old; an evicted entry is a
  // delivery miss, surfaced, never a satisfied durable guarantee — SPEC §7). `duplicate_window`
  // collapses a catch-up/fan-out double of the same Nats-Msg-Id. No Direct Get on either.
  await jsm.streams.add({
    name: inboxStream(space),
    subjects: [`${p}.dinbox.>`],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_msgs_per_subject: MAX_MSGS_PER_SUBJECT,
    discard: DiscardPolicy.Old,
    duplicate_window: nanos(PLANE3_DEDUP_WINDOW_MS),
  });
  await jsm.streams.add({
    name: dlvStream(space),
    subjects: [`${p}.dlv.>`],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_msgs_per_subject: MAX_MSGS_PER_SUBJECT,
    discard: DiscardPolicy.Old,
    duplicate_window: nanos(PLANE3_DEDUP_WINDOW_MS),
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

// ---- Plane-3 consumers (SPEC §8) ----

/** The single privileged trusted-reader consumer over the WHOLE INBOX (mixed pre-auth) store
 *  (`dinbox.>`, all owners) — created + bound only by the manager. Explicit ack: the reader holds an
 *  entry un-acked until it has transferred the re-authorized copy to DLV (a crash before transfer
 *  redelivers). `max_ack_pending` bounds the reader's in-flight set. The per-message owner is
 *  recovered from the subject (`parseDinboxOwner`). */
export function inboxReaderConfig(
  space: string,
  opts: { ackWaitMs?: number; shard?: number; shards?: number } = {},
): Partial<ConsumerConfig> {
  return {
    durable_name: readerDurable(opts.shard, opts.shards),
    filter_subject: `${spacePrefix(space)}.dinbox.>`,
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(opts.ackWaitMs ?? 60_000),
    deliver_policy: DeliverPolicy.All,
    max_ack_pending: DINBOX_MAX_ACK_PENDING,
  };
}

/** An agent's bind-only per-member DELIVER consumer (mirrors {@link dmDurableConfig}): the provisioner
 *  pre-creates it filtered to `dlv.<owner>`; the agent BINDS it (denied CREATE on DLV) and acks via
 *  native JetStream — the §8 "equivalent per-member at-least-once mechanism with the same ack
 *  semantics". `inactive_threshold` only for an open-mode self-create (none today; Plane-3 is
 *  auth-only). */
export function dlvDurableConfig(
  space: string,
  owner: string,
  opts: { ackWaitMs?: number; inactiveThresholdMs?: number } = {},
): Partial<ConsumerConfig> {
  const cfg: Partial<ConsumerConfig> = {
    durable_name: dlvDurable(owner),
    filter_subject: dlvSubject(space, owner),
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(opts.ackWaitMs ?? 60_000),
    deliver_policy: DeliverPolicy.All,
  };
  if (opts.inactiveThresholdMs) cfg.inactive_threshold = nanos(opts.inactiveThresholdMs);
  return cfg;
}

/** The single privileged fan-out consumer on CHAT (manager-pumped; routing, not auth).
 *  `DeliverPolicy.New` at creation (pre-existing backlog is pre-membership); a DURABLE, so on a
 *  manager restart it resumes from its ack cursor and fans out the gap, idempotent via `Nats-Msg-Id`. */
export function fanoutDurableConfig(
  space: string,
  opts: { ackWaitMs?: number; shard?: number; shards?: number } = {},
): Partial<ConsumerConfig> {
  return {
    durable_name: fanoutDurable(opts.shard, opts.shards),
    filter_subject: chatWildcard(space),
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(opts.ackWaitMs ?? 60_000),
    deliver_policy: DeliverPolicy.New,
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
    // Durable-membership registry (Plane-3): privileged-write, no TTL (durable config, like the
    // channel registry). Pre-created so the delivery daemon (and open-mode self) can OPEN it; agents
    // hold no grant. Idempotent.
    await kvm.create(membersBucket(opts.space));
    // Durable read-ACL registry (Plane-3 keystone): privileged-write, no TTL. The manager records an
    // agent's read ACL here at mint; the delivery daemon re-auths every durable entry against it.
    await kvm.create(aclBucket(opts.space));
    // Derived channel-membership feed (broker CONNZ ∪ members registry): privileged-write (the
    // `membership-rw` cred), admin/observer-read, no TTL (the daemon prunes departed agents). `history:1`
    // (only the latest record per agent matters) + a `max_bytes` cap (footprint bound). Pre-created so the
    // scoped writer holds no STREAM.CREATE. Idempotent.
    await kvm.create(membershipBucket(opts.space), { history: 1, max_bytes: MEMBERSHIP_MAX_BYTES });
    // Delivery-daemon single-flight lease + readiness bucket: bucket-level TTL (`max_age`) so a crashed
    // holder's lease auto-expires and a fresh daemon can re-acquire. Holds ONLY lease keys, writable
    // only by the `delivery` cred, world-readable (the non-gating delivery-health surface). Idempotent.
    await kvm.create(deliveryBucket(opts.space), { ttl: LEASE_TTL_MS });
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
