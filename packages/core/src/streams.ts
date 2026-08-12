import {
  jetstream,
  jetstreamManager,
  AckPolicy,
  DeliverPolicy,
  type ConsumerConfig,
  type JetStreamManager,
} from "@nats-io/jetstream";
import { randomUUID } from "node:crypto";
import { connect, credsAuthenticator, tokenAuthenticator, nanos, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { Objm } from "@nats-io/obj";
import {
  spacePrefix,
  artifactBucket,
  objectStoreStream,
  chatStream,
  chatSubject,
  chatWildcard,
  isConcreteChannel,
  dmStream,
  dmDurable,
  unicastRecvFilter,
  taskStream,
  taskDurable,
  anycastServeFilter,
  presenceBucket,
  channelBucket,
  membersBucket,
  aclBucket,
  membershipBucket,
  deliveryBucket,
  managerBucket,
  inboxStream,
  dlvStream,
  dlvSubject,
  dlvDurable,
  fanoutDurable,
  readerDurable,
  DEV_OWNER,
  principalKey,
  deprovisionTargetPrincipal,
} from "./subjects.js";
import { idFromCreds } from "./identity.js";
import { ensureAuthorityStores } from "./endpoint-binding.js";
import { openAclRegistry, deleteAcl } from "./acls.js";
import {
  BACKUP_MAX_MSGS_PER_SUBJECT,
  BACKUP_PLANE3_DEDUP_WINDOW_MS,
  canonicalBackupStreamConfig,
} from "./backup-config.js";

/** Default presence-bucket entry TTL (ms) — matches the endpoint's default liveness window. */
const PRESENCE_TTL_MS = 6_000;

/** Per-(sender,channel)-subject retention cap on the chat stream — the bound past which the
 *  oldest message on a subject is discarded (`DiscardPolicy.Old`). Also the horizon of focus
 *  recall: only the last {@link MAX_MSGS_PER_SUBJECT} per sender-subject are recallable. */
export const MAX_MSGS_PER_SUBJECT = BACKUP_MAX_MSGS_PER_SUBJECT;

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
export const PLANE3_DEDUP_WINDOW_MS = BACKUP_PLANE3_DEDUP_WINDOW_MS;

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

/** Bucket-level `max_bytes` cap on the per-space artifact Object Store (`cotal_artifacts_<space>`).
 *
 *  THIS NUMBER IS THE ONLY THING BOUNDING ARTIFACT STORAGE, so it is a decision rather than a
 *  default. A fresh Object Store bucket ships `max_bytes: -1`, and the space account is provisioned
 *  `disk_storage: -1`, so nothing above it says no: without this cap an artifact flood grows until
 *  the disk does, starving the chat/DM/delivery streams that share it.
 *
 *  4 GiB is roughly sixteen artifacts at the 256 MiB per-artifact ceiling, which is generous for the
 *  transfer use case (screenshots, reports, build outputs) and small enough that filling it is a
 *  visible event rather than a silent disk exhaustion. `discard: new` on the bucket means hitting it
 *  REFUSES the write rather than evicting older artifacts — the loud failure, not the silent one
 *  where a reference published yesterday quietly stops resolving. */
export const ARTIFACT_STORE_MAX_BYTES = 4 * 1024 * 1024 * 1024;

export interface ClearSpaceHistoryResult {
  chat: number;
  dm?: number;
}

/** Auth material for a STANDALONE helper connection: a static/raw creds file, OR the user-mode
 *  pair (a view bearer + the deny-all sentinel creds) — exactly what the endpoint's user mode
 *  presents. Never both. Empty = open mode. */
export interface StandaloneAuth {
  creds?: string;
  bearer?: string;
  sentinelCreds?: string;
}

/** Connection options for a privileged STANDALONE helper (`setupSpaceStreams`, `clearSpaceHistory`,
 *  `clearChannel`, the channel-registry helpers): pin the reply inbox to the connection's own
 *  identity. A scoped cred (provisioner/purger/operator) subscribes only `_INBOX_<id>.>`, so without
 *  this its JS-API replies land on the default `_INBOX.<nuid>` — a subject the cred's sub rejects
 *  (Permissions Violation), hanging every `jetstreamManager`/`streams.*` request.
 *
 *  USER MODE (`bearer` + `sentinelCreds`) mirrors the endpoint's callout-shaped connect: the
 *  sentinel creds land the connection in the callout account, the bearer rides `auth_token`, and a
 *  client-chosen inbox NONCE goes out as the connect `name` — the callout scopes `_INBOX_<nonce>.>`
 *  from it (the client cannot know its nkey pre-connect). Open mode (no auth) connects bare. */
export function standaloneConnectOpts(auth: StandaloneAuth = {}): Record<string, unknown> {
  if (auth.bearer !== undefined) {
    if (!auth.sentinelCreds)
      throw new Error("user-mode standalone connect requires sentinelCreds alongside the bearer");
    if (auth.creds) throw new Error("standalone connect takes creds OR bearer+sentinelCreds, never both");
    const nonce = `ibx${randomUUID().replace(/-/g, "")}`;
    return {
      name: nonce,
      inboxPrefix: `_INBOX_${nonce}`,
      authenticator: [credsAuthenticator(new TextEncoder().encode(auth.sentinelCreds)), tokenAuthenticator(auth.bearer)],
    };
  }
  return auth.creds
    ? {
        authenticator: credsAuthenticator(new TextEncoder().encode(auth.creds)),
        inboxPrefix: `_INBOX_${idFromCreds(auth.creds)}`,
      }
    : {};
}

/**
 * Create (idempotently) the five message streams for a space.
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
  for (const stream of [chatStream(space), dmStream(space), taskStream(space), inboxStream(space), dlvStream(space)])
    await jsm.streams.add(canonicalBackupStreamConfig(space, stream));
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
  owner: string,
  actor: string,
  lifecycleUid: string,
  opts: { ackWaitMs?: number; inactiveThresholdMs?: number; activationFrontier?: number } = {},
): Partial<ConsumerConfig> {
  // The DM SUBJECTS (`inst.>`) keep the alias grammar (SPEC §13.1 cross-plane scoping), so the
  // lifecycle scoping lives in the consumer: the NAME carries the uid (exact-name deprovision) and
  // delivery starts at the ACTIVATION FRONTIER — the DM stream sequence captured when this lifecycle
  // was provisioned — so a same-alias successor inherits none of the predecessor's pending DMs
  // (SPEC :467). `activationFrontier` = that captured `last_seq`; delivery begins at frontier+1.
  // Callers that provision a genuinely fresh lifecycle pass the sequence they captured; 0 = from the
  // stream start (an explicit choice, e.g. a stream created after the lifecycle in tests).
  const frontier = opts.activationFrontier ?? 0;
  if (!Number.isInteger(frontier) || frontier < 0)
    throw new Error(`dmDurableConfig activationFrontier must be a non-negative integer, got ${String(frontier)}`);
  const cfg: Partial<ConsumerConfig> = {
    durable_name: dmDurable(owner, actor, lifecycleUid),
    filter_subject: unicastRecvFilter(space, owner, actor), // inst.<owner>.<actor>.> — every DM to me
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(opts.ackWaitMs ?? 60_000),
    ...(frontier > 0
      ? { deliver_policy: DeliverPolicy.StartSequence, opt_start_seq: frontier + 1 }
      : { deliver_policy: DeliverPolicy.All }),
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
    filter_subject: anycastServeFilter(space, role), // svc.<role>.> — every anycast to the role
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
  actor: string,
  lifecycleUid: string,
  opts: { ackWaitMs?: number; inactiveThresholdMs?: number } = {},
): Partial<ConsumerConfig> {
  const cfg: Partial<ConsumerConfig> = {
    durable_name: dlvDurable(owner, actor, lifecycleUid),
    // dlv subjects are lifecycle-scoped (SPEC §13.1/Appendix): the reader hands off to THIS
    // lifecycle's subject, so the filter itself confines the successor — no frontier needed here.
    filter_subject: dlvSubject(space, owner, actor, lifecycleUid),
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
/**
 * Create the space's artifact Object Store, or VERIFY an existing one — never silently adopt it.
 *
 * `Objm.create(bucket, { max_bytes })` is create-if-MISSING. Measured on nats-server 2.14.4 with
 * `@nats-io/obj` 3.4.0: creating at `max_bytes: 1024`, then calling create again with `4096`, leaves
 * the stream at **1024** — it neither updates the config nor refuses. A bare `create()` with no
 * options does the same.
 *
 * That makes create-alone actively dangerous here, because {@link setupSpaceStreams} is idempotent
 * and re-runs on every `cotal up`. A store that predates this cap, or that an operator widened by
 * hand, would be adopted forever: the code would look like it enforces a 4 GiB ceiling while the
 * broker enforced whatever was there first, and nothing would ever say so. The cap is the ONLY thing
 * bounding artifact storage (account disk is provisioned unlimited), so an unenforced cap is not a
 * smaller cap — it is no cap.
 *
 * So: create, then read the config back and refuse loudly on drift. Same create-or-verify discipline
 * `ensureAuthorityStores` already uses, and the same reason: an idempotent setup path must either
 * converge the resource or report that it cannot.
 */
export async function ensureArtifactStore(nc: NatsConnection, space: string): Promise<void> {
  const bucket = artifactBucket(space);
  const stream = objectStoreStream(bucket);
  await new Objm(jetstream(nc)).create(bucket, { max_bytes: ARTIFACT_STORE_MAX_BYTES });
  const { config } = await (await jetstreamManager(nc)).streams.info(stream);
  const drift: string[] = [];
  // SUBJECTS FIRST, because they decide whether this is an object store AT ALL. A stream created
  // under the right name with the right cap and the right discard, but bound to other subjects, is
  // adopted by a cap-only check while artifact puts can never land - and setup reports success.
  // (Measured: a stream named OBJ_<bucket> over `foreign.capture.>` survived setup untouched.)
  const want = [`$O.${bucket}.C.>`, `$O.${bucket}.M.>`];
  if (JSON.stringify(config.subjects ?? []) !== JSON.stringify(want))
    drift.push(`subjects are ${JSON.stringify(config.subjects ?? [])}, expected ${JSON.stringify(want)}`);
  // A MIRROR or SOURCE under this name makes the space's artifact store a view of someone else's
  // stream. Nothing about the cap would look wrong; the bytes would simply not be the space's own.
  if (config.mirror) drift.push("it is a MIRROR of another stream");
  if (config.sources?.length) drift.push(`it SOURCES ${config.sources.length} other stream(s)`);
  if (config.max_bytes !== ARTIFACT_STORE_MAX_BYTES)
    drift.push(`max_bytes is ${config.max_bytes}, expected ${ARTIFACT_STORE_MAX_BYTES}`);
  // `discard: new` is what makes a full store REFUSE a put instead of evicting a live artifact whose
  // reference is already published. Drift here is silent data loss, not a capacity difference.
  if (String(config.discard) !== "new") drift.push(`discard is ${config.discard}, expected new`);
  // File storage: memory-backed artifacts vanish on a broker restart while every published reference
  // survives, which turns a restart into a wave of unresolvable references.
  if (String(config.storage) !== "file") drift.push(`storage is ${config.storage}, expected file`);
  // Limits retention: any interest/work-queue retention DELETES messages once consumed, so a fetch
  // would destroy the artifact it just read.
  if (String(config.retention) !== "limits") drift.push(`retention is ${config.retention}, expected limits`);
  if (drift.length)
    throw new Error(
      `artifact store ${stream} has drifted: ${drift.join("; ")} - refusing to adopt a store whose ` +
      `bounds are not the ones this space enforces (delete it, or reconcile it deliberately)`,
    );
}

export async function setupSpaceStreams(opts: {
  servers: string;
  space: string;
  /** Privileged creds for an authed mesh; omit on an open mesh (a bare connection has the rights). */
  creds?: string;
}): Promise<void> {
  const nc = await connect({ servers: opts.servers, ...standaloneConnectOpts({ creds: opts.creds }) });
  try {
    const jsm = await jetstreamManager(nc);
    await createSpaceStreams(jsm, opts.space);
    // The presence + channels KV buckets are streams too — pre-create them so agents (denied
    // KV stream-create) can open them. Idempotent. Presence is TTL'd (liveness); the channel
    // registry is durable config, so no TTL.
    const kvm = new Kvm(nc);
    await kvm.create(presenceBucket(opts.space), { ttl: PRESENCE_TTL_MS });
    await jsm.streams.add(canonicalBackupStreamConfig(opts.space, `KV_${channelBucket(opts.space)}`));
    // Durable-membership registry (Plane-3): privileged-write, no TTL (durable config, like the
    // channel registry). Pre-created so the delivery daemon (and open-mode self) can OPEN it; agents
    // hold no grant. Idempotent.
    await jsm.streams.add(canonicalBackupStreamConfig(opts.space, `KV_${membersBucket(opts.space)}`));
    // Durable read-ACL registry (Plane-3 keystone): privileged-write, no TTL. The manager records an
    // agent's read ACL here at mint; the delivery daemon re-auths every durable entry against it.
    await jsm.streams.add(canonicalBackupStreamConfig(opts.space, `KV_${aclBucket(opts.space)}`));
    // Derived channel-membership feed (broker CONNZ ∪ members registry): privileged-write (the
    // `membership-rw` cred), admin/observer-read, no TTL (the daemon prunes departed agents). `history:1`
    // (only the latest record per agent matters) + a `max_bytes` cap (footprint bound). Pre-created so the
    // scoped writer holds no STREAM.CREATE. Idempotent.
    await kvm.create(membershipBucket(opts.space), { history: 1, max_bytes: MEMBERSHIP_MAX_BYTES });
    // Delivery-daemon single-flight lease + readiness bucket: bucket-level TTL (`max_age`) so a crashed
    // holder's lease auto-expires and a fresh daemon can re-acquire. Holds ONLY lease keys, writable
    // only by the `delivery` cred, world-readable (the non-gating delivery-health surface). Idempotent.
    await kvm.create(deliveryBucket(opts.space), { ttl: LEASE_TTL_MS });
    // Manager singleton-lease bucket (bucket-level TTL, like the delivery lease). PRE-CREATED here so the
    // long-lived supervisor can lease-bind OPEN-ONLY (closure (ii), residual 2) — it holds no STREAM.CREATE.
    // Config matches `managerLeaseRegistry()`'s create-first exactly, so that path stays idempotent until
    // the supervisor profile drops bucket-create. Idempotent.
    await kvm.create(managerBucket(opts.space), { ttl: MANAGER_LEASE_TTL_MS });
    // The two §13.12 AUTHORITY stores (records + auth): every auth-mode mesh now carries a
    // lifecycle registry — user mode's service re-ensures at its own boot, the STATIC manager's
    // start reconcile re-ensures for pre-existing spaces (Unit B) — and the up-time seed creates
    // them so neither daemon needs first-write stream creation. Create-or-verify, idempotent,
    // drift fails loud.
    await ensureAuthorityStores(jsm, kvm, opts.space);
    // Artifact Object Store (SPEC section 5): the bytes an `artifact` reference part points at.
    // Create-or-VERIFY, drift fails loud - see ensureArtifactStore for why create alone is not enough.
    await ensureArtifactStore(nc, opts.space);
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
  /** User mode: a `purger`-view bearer + the space's sentinel creds (instead of a creds file). */
  bearer?: string;
  sentinelCreds?: string;
  includeDms?: boolean;
}): Promise<ClearSpaceHistoryResult> {
  const nc = await connect({ servers: opts.servers, ...standaloneConnectOpts(opts) });
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
  /** User mode: a `channel-purger`-view bearer + the space's sentinel creds (instead of a creds file). */
  bearer?: string;
  sentinelCreds?: string;
}): Promise<{ channel: string; purged: number }> {
  if (!isConcreteChannel(opts.channel))
    throw new Error(`"${opts.channel}" is a wildcard, not a deletable channel`);
  const nc = await connect({ servers: opts.servers, ...standaloneConnectOpts(opts) });
  try {
    const jsm = await jetstreamManager(nc);
    const { purged } = await jsm.streams.purge(chatStream(opts.space), {
      filter: chatSubject(opts.space, "*", "*", opts.channel),
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

/** Delete a departed agent LIFECYCLE's provisioning footprint (#159 Part B) — the teardown counterpart
 *  to {@link provisionAgent}. Removes exactly what the provisioner minted for THIS incarnation: its two
 *  bind-only durables (`dm_<o>-<a>-<uid>`, `dlv_<o>-<a>-<uid>`) and its lifecycle-keyed read-ACL row.
 *  Idempotent — a missing consumer / absent ACL row is a no-op (the agent may have exited before a
 *  durable was created, or a re-run). LIFECYCLE-EXACT by construction (SPEC §13.1): every name this
 *  deletes embeds the target uid, so a stale/replayed teardown for a retired lifecycle names only
 *  retired resources — it structurally cannot touch a same-alias successor, and the deprovisioner
 *  cred's exact-name grants make a wrong-uid delete broker-DENIED, not just a no-op.
 *
 *  Does NOT touch the role-SHARED `svc_<role>` TASK durable (deleting it would break the role's other
 *  agents — it lives until space teardown), nor the ephemeral `chathist_…-<uid>` history consumers (they
 *  self-clean on the agent's disconnect). The creds FILE is removed by the caller (a manager-local
 *  filesystem concern, not a broker one). Pass a TARGET-PINNED `deprovisioner` cred (see
 *  {@link mintCreds}); a bare connection (open mode) never calls this — an open mesh mints nothing. */
export async function deprovisionAgent(opts: {
  servers: string;
  space: string;
  targetId: string;
  lifecycleUid: string;
  creds?: string;
}): Promise<void> {
  const nc = await connect({
    servers: opts.servers,
    ...standaloneConnectOpts({ creds: opts.creds }),
    // This is a detached, fire-and-forget teardown — it must FAIL FAST, never hang, so the caller's
    // fail-loud `.catch` is load-bearing: no reconnect loop (a wedged broker rejects promptly instead of
    // looping silently) and a bounded initial connect. Without this a broker-down deprovision would sit
    // pending forever and the footprint would survive with no log.
    maxReconnectAttempts: 0,
    timeout: 5_000,
  });
  try {
    // The target is a full principal dot-form (user-mode agent) or a bare static actor id under the
    // local owner, PLUS the exact lifecycle uid being torn down — the SAME resolution the
    // deprovisioner cred's permission pin used, so the delete names and the grant can't diverge.
    const t = deprovisionTargetPrincipal({ principal: opts.targetId, lifecycleUid: opts.lifecycleUid });
    const jsm = await jetstreamManager(nc);
    await deleteConsumerIdempotent(jsm, dmStream(opts.space), dmDurable(t.owner, t.actor, t.lifecycleUid));
    await deleteConsumerIdempotent(jsm, dlvStream(opts.space), dlvDurable(t.owner, t.actor, t.lifecycleUid));
    await deleteAcl(await openAclRegistry(nc, opts.space), principalKey(t.owner, t.actor).key, t.lifecycleUid);
  } finally {
    await nc.drain();
  }
}

/** Delete a consumer, tolerating "already gone" (a 404 / not-found) as a no-op so deprovision stays
 *  idempotent — but re-throwing anything else (e.g. a permissions violation) so a mis-scoped cred fails
 *  loud rather than silently leaving the durable behind. */
async function deleteConsumerIdempotent(jsm: JetStreamManager, stream: string, name: string): Promise<void> {
  try {
    await jsm.consumers.delete(stream, name);
  } catch (e) {
    // Swallow ONLY "already gone" — a 404 code (the real NATS JS-API signal) or a codeless
    // consumer/stream-not-found message. Anything else (a permissions violation, a broker error) is
    // re-thrown so a mis-scoped cred fails loud. The message match is deliberately narrow (not a bare
    // `/not found/i`) so an unrelated "…not found" error can't be mistaken for the idempotent case.
    if ((e as { code?: number }).code !== 404 && !/(consumer|stream) not found/i.test((e as Error).message)) throw e;
  }
}
