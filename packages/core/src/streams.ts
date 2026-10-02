import {
  jetstream,
  jetstreamManager,
  AckPolicy,
  DeliverPolicy,
  StorageType,
  type ConsumerConfig,
  type JetStreamClient,
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
  aclKey,
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
  memberKey,
  deprovisionTargetPrincipal,
} from "./subjects.js";
import type { KV } from "@nats-io/kv";
import { idFromCreds } from "./identity.js";
import { requireBrokerFloor } from "./broker-floor.js";
import { createEndpointStreams } from "./endpoint-binding.js";
import { openAclRegistry, deleteAcl } from "./acls.js";
import { openMembersRegistry, deleteMember } from "./members.js";
import {
  BACKUP_MAX_MSGS_PER_SUBJECT,
  BACKUP_PLANE3_DEDUP_WINDOW_MS,
  canonicalBackupStreamConfig,
} from "./backup-config.js";

/** Default presence-bucket entry TTL (ms) — matches the endpoint's default liveness window. */
const PRESENCE_TTL_MS = 6_000;

/** #1356: the presence bucket is memory-backed. Its records are pure liveness that every endpoint
 *  rewrites every heartbeat and republishes after a broker restart, so durability buys nothing, while
 *  a file-backed store can latch a permanent write error that refuses every later write (and so every
 *  registering bind) until the broker restarts. Storage class is fixed at stream creation, so a bucket
 *  created file-backed by an older cotal stays file-backed until it is recreated. */
export const PRESENCE_STORAGE = StorageType.Memory;

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
 *  than the delivery lease so a crashed manager frees the space for a replacement promptly. Tune here
 *  (independent of the delivery lease above); the holder's pacing inside this window is
 *  {@link MANAGER_LEASE_RENEW_MS} / {@link MANAGER_LEASE_ATTEMPT_MS}. */
export const MANAGER_LEASE_TTL_MS = 10_000;

/** How often the holder refreshes its manager lease, and the deadline it gives each attempt.
 *
 *  THESE TWO NUMBERS ARE ONE BUDGET, and neither means anything alone. The TTL above is the whole
 *  window a holder has to prove it is still there. Renewing at TTL/2 with the request deadline left
 *  at the JetStream default (5s, which is also TTL/2) puts exactly ONE attempt inside the window and
 *  lets that attempt's own deadline consume the entire remainder — so a single slow round trip is
 *  terminal, by construction, on a holder that is otherwise healthy. At TTL/4 with a deadline under
 *  the period, no single attempt can spend the window and there is room to ask again.
 *
 *  HOW MUCH ROOM, EXACTLY, because "N attempts fit" is a claim about the composed path and not about
 *  these two numbers. A renew that times out is followed by a re-read with a deadline of its own, and
 *  the in-flight guard skips any tick that falls while the pair is running, so the unit to count is
 *  the pair and not the tick. On the path this budget exists for — the renew gets no answer and the
 *  re-read does — the pair costs about one deadline and three of them complete inside the TTL. Under a
 *  TOTAL blackout, where both halves spend their deadline, the pair costs two and one completes inside
 *  the TTL. Past the TTL the key expires at the broker; the holder keeps serving and, when the broker
 *  answers again, reads the key gone and puts it back. Nothing here ends the holder's process.
 *
 *  They are CLIENT-SIDE PACING ONLY. Unlike the TTL, which is written into the bucket at `cotal up`
 *  and so has to be reconciled on an existing mesh (see {@link ttlBuckets}), changing these two
 *  touches no stored config and needs no migration. */
export const MANAGER_LEASE_RENEW_MS = MANAGER_LEASE_TTL_MS / 4;
export const MANAGER_LEASE_ATTEMPT_MS = 2_000;

/** Bucket-level `max_bytes` cap on the derived membership feed (`cotal_membership_<space>`). The
 *  per-agent keying keeps each value tiny (a handful of channel patterns), so 64 MiB bounds the footprint
 *  far above any realistic readership while keeping the bucket from growing unbounded. A deliberate cap,
 *  not a guess at scale — the design is cap-safe by construction (per-agent, store-patterns-not-expanded). */
export const MEMBERSHIP_MAX_BYTES = 64 * 1024 * 1024;

/** Bucket-level `max_bytes` cap on the per-space artifact Object Store (`cotal_artifacts_<space>`).
/** The `max_bytes` a per-space artifact Object Store carried before the reservation was removed:
 *  4 GiB, the stock value every store created by that code holds. Kept for ONE purpose —
 *  {@link ensureArtifactStore} recognizes it and reconciles it to `-1`, releasing the reservation.
 *  It is not a cap this code sets on anything, and it is deliberately not exported: nothing outside
 *  the reconcile has a use for a number that is only ever a legacy value to be migrated away from. */
const LEGACY_ARTIFACT_STORE_MAX_BYTES = 4 * 1024 * 1024 * 1024;

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
  /** Whether this connection must REQUIRE TLS rather than merely tolerate it.
   *
   *  REQUIRED, and it is the point of the field. This helper is the STANDALONE connect path, and it
   *  was derived from the endpoint path's auth half without its transport half: `authOpts`,
   *  `probeConnect` and `RawAuth` all carry a TLS requirement, and this one did not. Every caller
   *  of it therefore built connect options that carried the credentials and dropped the thing that
   *  protects them in transit.
   *
   *  Made required rather than optional because the omitted case is the dangerous one. A client
   *  with no TLS requirement still connects to a TLS broker — it upgrades the same socket once it
   *  reads `tls_required` in the server's unauthenticated INFO — so nothing looks wrong until an
   *  on-path attacker forges an INFO without it and collects the credentials in the clear. An
   *  optional field would leave the seam LOOKING transport-aware while callers kept omitting it.
   *
   *  Note the honest limit of the compile error: smoke files are outside the tsconfigs, so the type
   *  forces every TYPECHECKED caller to state a transport, not every caller. That is why
   *  `standaloneConnectOpts` also throws at runtime — see there. */
  tls: boolean;
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
export function standaloneConnectOpts(auth: StandaloneAuth): Record<string, unknown> {
  // The `= {}` default is deliberately GONE. It was the omission hole: it let a caller build
  // connect options without ever naming a transport, and the result silently connected non-strict.
  //
  // The throw exists because the type alone does not reach far enough. Smoke files sit outside the
  // tsconfigs, so 16 of this seam's 28 call sites are never typechecked - the compile error covers
  // every TYPECHECKED caller, not every caller. Without this guard those would keep passing no
  // transport and degrade to non-strict in silence, which is precisely the defect being fixed.
  // Positioned BEFORE the options are built and before any connect: a guard only fences what comes
  // after it.
  if (auth?.tls === undefined)
    throw new Error(
      "standaloneConnectOpts requires an explicit `tls` boolean: pass `tls: true` to REQUIRE TLS, " +
      "or `tls: false` for a plaintext broker. It has no default, because defaulting it would " +
      "silently connect without the requirement that protects the credentials being passed.",
    );
  const tlsOpt = auth.tls ? { tls: {} } : {};
  if (auth.bearer !== undefined) {
    if (!auth.sentinelCreds)
      throw new Error("user-mode standalone connect requires sentinelCreds alongside the bearer");
    if (auth.creds) throw new Error("standalone connect takes creds OR bearer+sentinelCreds, never both");
    const nonce = `ibx${randomUUID().replace(/-/g, "")}`;
    return {
      name: nonce,
      inboxPrefix: `_INBOX_${nonce}`,
      authenticator: [credsAuthenticator(new TextEncoder().encode(auth.sentinelCreds)), tokenAuthenticator(auth.bearer)],
      ...tlsOpt,
    };
  }
  return auth.creds
    ? {
        authenticator: credsAuthenticator(new TextEncoder().encode(auth.creds)),
        inboxPrefix: `_INBOX_${idFromCreds(auth.creds)}`,
        ...tlsOpt,
      }
    : { ...tlsOpt };
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
  // (SPEC §8). `activationFrontier` = that captured `last_seq`; delivery begins at frontier+1.
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
export const TTL_RECONCILE_CANARY_KEY = "_cotal_ttl_reconcile";
const TTL_RECONCILE_POLL_MS = 100;
const TTL_RECONCILE_GRACE_MS = 2_000;

/** The server accepted and reported a TTL update, but its backing store did not enforce it. */
export class TtlPersistenceError extends Error {
  constructor(readonly stream: string, readonly ttlMs: number, readonly canarySubject: string) {
    super(
      `TTL reconcile persistence failed for ${stream}: the server accepted max_age=${ttlMs}ms, ` +
      "but the backing store did not persist or enforce it (the enforcement canary remained past max_age plus grace)",
    );
    this.name = "TtlPersistenceError";
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function ttlCanaryCount(
  jsm: JetStreamManager,
  streamName: string,
  canarySubject: string,
): Promise<number> {
  const info = await jsm.streams.info(streamName, { subjects_filter: canarySubject });
  return info.state.subjects?.[canarySubject] ?? 0;
}

async function awaitTtlCanaryExpiry(
  jsm: JetStreamManager,
  streamName: string,
  canarySubject: string,
  ttlMs: number,
): Promise<void> {
  const deadline = Date.now() + ttlMs + TTL_RECONCILE_GRACE_MS;
  while (Date.now() <= deadline) {
    if (await ttlCanaryCount(jsm, streamName, canarySubject) === 0) return;
    await sleep(Math.min(TTL_RECONCILE_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  throw new TtlPersistenceError(streamName, ttlMs, canarySubject);
}

/** #286/#404: reconcile a TTL'd KV bucket and prove the backing store enforces the result.
 *
 * `STREAM.INFO` alone is not evidence. nats-server updates the stream's in-memory config before asking
 * the backing store to persist it, ignores the store's `UpdateConfig` error, and serves INFO from the
 * in-memory copy. A file-store metadata fault can therefore report UPDATE success and the requested
 * `max_age` while the store rolls back and never starts age enforcement.
 *
 * Before an update, this writes a durable marker on a reserved KV subject so an interrupted or false-green
 * attempt cannot disappear behind a later matching INFO read. After the update, it writes the enforcement
 * canary on that same subject and waits for subject-filtered stream state to report it gone within
 * `max_age` plus fixed grace. The post-update write is the timed proof even when the prior TTL was shorter
 * and expired the marker during the update. A clean matching bucket has no canary and stays a fast read-only
 * no-op. The transition is proof of enforcement rather than config: the false-green store leaves the canary
 * present and causes a named {@link TtlPersistenceError}, which `cotal up` surfaces. Successful canaries
 * self-delete through the policy they verify. */
export async function reconcileBucketTtl(
  jsm: JetStreamManager,
  js: Pick<JetStreamClient, "publish">,
  streamName: string,
  bucket: string,
  ttlMs: number,
): Promise<TtlReconciled | undefined> {
  const wantNs = nanos(ttlMs);
  const canarySubject = `$KV.${bucket}.${TTL_RECONCILE_CANARY_KEY}`;
  const info = await jsm.streams.info(streamName);
  // A prior attempt may have left its durable canary behind. Reissue the desired config in case the
  // store recovered, then prove it. Never accept the matching in-memory config on its own.
  if (info.config.max_age === wantNs) {
    if (await ttlCanaryCount(jsm, streamName, canarySubject) === 0) return undefined;
    const dupNs = Math.min(info.config.duplicate_window ?? wantNs, wantNs);
    await jsm.streams.update(streamName, { max_age: wantNs, duplicate_window: dupNs });
    await js.publish(canarySubject, new TextEncoder().encode("cotal ttl enforcement canary"));
    await awaitTtlCanaryExpiry(jsm, streamName, canarySubject, ttlMs);
    return undefined;
  }
  const fromNs = info.config.max_age;
  const dupNs = Math.min(info.config.duplicate_window ?? wantNs, wantNs); // NATS constraint: duplicate_window <= max_age
  await js.publish(canarySubject, new TextEncoder().encode("cotal ttl enforcement canary"));
  await jsm.streams.update(streamName, { max_age: wantNs, duplicate_window: dupNs });
  const after = await jsm.streams.info(streamName);
  if (after.config.max_age !== wantNs)
    throw new Error(`TTL reconcile failed for ${streamName}: max_age is ${after.config.max_age}ns, expected ${wantNs}ns (the STREAM.UPDATE did not take)`);
  // Both fields are read back, not just the one we came for. On a CONFORMING server this cannot
  // fail: NATS validates the whole StreamConfig (including `duplicate_window <= max_age`) and then
  // applies it as ONE replacement — or one Raft stream assignment in cluster mode — so a partial
  // apply that took `max_age` and dropped the window is not a supported outcome. The check exists
  // because the read-back's whole purpose is to not depend on the server behaving as documented:
  // verifying only the field we set would leave the guarantee resting on the same assumption it was
  // written to remove. (Semantics confirmed at the NATS source rather than reasoned from our seam.)
  if ((after.config.duplicate_window ?? 0) > wantNs)
    throw new Error(`TTL reconcile left ${streamName} inconsistent: duplicate_window is ${after.config.duplicate_window}ns, which exceeds max_age ${wantNs}ns (a conforming server rejects this combination, so the update was applied partially)`);
  await js.publish(canarySubject, new TextEncoder().encode("cotal ttl enforcement canary"));
  await awaitTtlCanaryExpiry(jsm, streamName, canarySubject, ttlMs);
  return { stream: streamName, fromMs: fromNs / 1e6, toMs: wantNs / 1e6 };
}

/** The TTL'd buckets and their intended `max_age`, in ONE place — and the ONLY place any of them is
 *  created.
 *
 *  Creation is DRIVEN from this list, not merely checked against it. That distinction is the whole
 *  point: an earlier version had the reconcile paths read the list while `setupSpaceStreams` still
 *  named each `kvm.create(..., { ttl })` separately, and claimed in this comment that a bucket could
 *  therefore "never" be TTL'd on one path and forgotten on the other. It could — a fourth bucket
 *  added at a create site would have been created with a TTL and never reconciled, which is #286's
 *  shape exactly, recreated by the fix for it. (Caught in review; the claim was false when written.)
 *  Now a TTL'd bucket cannot be created without appearing here, so it cannot be missed on upgrade.
 *
 *  NOT mode-gated: an open mesh carries the same buckets and drifts identically. */
export function ttlBuckets(space: string): ReadonlyArray<readonly [string, number, StorageType]> {
  return [
    // Presence (liveness): dead agents' records must age out, or the roster reports a despawned
    // agent as live. Pre-created so agents, denied KV stream-create, can open it.
    [presenceBucket(space), PRESENCE_TTL_MS, PRESENCE_STORAGE],
    // Delivery-daemon single-flight lease + readiness: bucket-level TTL so a crashed holder's lease
    // auto-expires and a fresh daemon can re-acquire. Lease keys only, `delivery`-cred write,
    // world-readable (the non-gating delivery-health surface).
    [deliveryBucket(space), LEASE_TTL_MS, StorageType.File],
    // Manager singleton lease, same shape as the delivery lease. Pre-created so the long-lived
    // supervisor can lease-bind OPEN-ONLY (closure (ii), residual 2) — it holds no STREAM.CREATE.
    // Config matches `managerLeaseRegistry()`'s create-first exactly, so that path stays idempotent.
    [managerBucket(space), MANAGER_LEASE_TTL_MS, StorageType.File],
  ] as const;
}

/** What a reconcile actually CHANGED. Returned (rather than logged inside) so the caller can report
 *  it: a `cotal up` against a running mesh now performs a config write, and a write the operator
 *  cannot see is the kind of silent behaviour this change exists to remove. `undefined` means the
 *  bucket already carried the intended TTL and nothing was written. */
export type TtlReconciled = { stream: string; fromMs: number; toMs: number };

/** #286: reconcile all three TTL'd buckets for a space, over a connection of its own.
 *
 *  Exists because `setupSpaceStreams` is only reachable on the CREATE path (`cotal up` starting a
 *  mesh), while the drifted-bucket case this fixes is by definition a mesh that is ALREADY RUNNING —
 *  an old deployment being upgraded in place. That path starts nothing and so must not run the
 *  create-everything routine; it needs exactly the reconcile and nothing else.
 *
 *  Read-first by construction: each bucket is skipped when its `max_age` already matches, so a
 *  steady-state repeat `cotal up` issues three `STREAM.INFO` reads and ZERO writes. Returns only the
 *  buckets it actually changed. `creds` is omitted on an open mesh, exactly as `setupSpaceStreams`
 *  documents — the TTL'd buckets are NOT mode-gated, so an open mesh drifts identically. */
export async function reconcileSpaceTtls(opts: {
  servers: string;
  space: string;
  /** Privileged creds for an authed mesh; omit on an open mesh (a bare connection has the rights). */
  creds?: string;
}): Promise<TtlReconciled[]> {
  const nc = await connect({ servers: opts.servers, ...standaloneConnectOpts({ creds: opts.creds, tls: false }) });
  try {
    // SPEC §13.12: the control surface requires nats-server >= 2.12; this runs on every
    // fresh connection, including reconnects.
    requireBrokerFloor(nc);
    const jsm = await jetstreamManager(nc);
    const js = jetstream(nc);
    const reconciled = await Promise.all(
      ttlBuckets(opts.space).map(([bucket, ttl]) => reconcileBucketTtl(jsm, js, `KV_${bucket}`, bucket, ttl)),
    );
    return reconciled.filter((done): done is TtlReconciled => done !== undefined);
  } finally {
    await nc.drain();
  }
}

/**
 * Create the space's artifact Object Store, or VERIFY an existing one — never silently adopt it.
 *
 * `Objm.create(bucket, { max_bytes })` is create-if-MISSING. Measured on nats-server 2.14.4 with
 * `@nats-io/obj` 3.4.0: creating at `max_bytes: 1024`, then calling create again with `4096`, leaves
 * the stream at **1024** — it neither updates the config nor refuses. A bare `create()` with no
 * options does the same.
 *
 * That makes create-alone actively dangerous here, because {@link setupSpaceStreams} is idempotent
 * and re-runs on every `cotal up`: a store an operator shaped by hand would be adopted forever while
 * the code read as if it had configured it. So: create, then read the config back and refuse loudly
 * on drift. Same create-or-verify discipline `ensureAuthorityStores` already uses, and the same
 * reason: an idempotent setup path must either converge the resource or report that it cannot.
 *
 * THE STORE CARRIES NO BYTE CAP (`max_bytes: -1`), AND THAT IS THE POINT. A stream created with a
 * positive `max_bytes` has that whole number RESERVED against the server's `max_file_store` the
 * moment it is created, empty or not, and once the reservations would pass the cap nats-server
 * refuses the next stream with JetStream error 10047 (`insufficient storage resources available`).
 * Reproduced: under `max_file_store: 9 GiB`, two spaces provisioned, the third refused with 10047,
 * `reserved_storage` 8.19 GiB and 0 bytes actually stored. A per-space quota that reserves 4 GiB
 * therefore bounds how many SPACES a broker can hold rather than how many bytes a space can write.
 *
 * At `-1` the store reserves nothing and its writes are refused once the broker's REAL file-store
 * usage reaches `max_file_store` — which is how the space's chat, DM, inbox and delivery streams are
 * already bounded (`baseConfig` in `backup-config.ts` gives them `max_bytes: -1`). `discard: new`
 * still means reaching that bound REFUSES the put rather than evicting an artifact whose reference
 * is already published.
 *
 * A store at exactly the legacy stock 4 GiB is UPDATED to `-1` and read back, which is what releases
 * the reservation on an existing mesh. Any OTHER positive `max_bytes` is somebody's deliberate
 * decision and is still refused as drift: this path never silently widens a bound it did not set.
 */
export async function ensureArtifactStore(nc: NatsConnection, space: string): Promise<void> {
  const bucket = artifactBucket(space);
  const stream = objectStoreStream(bucket);
  const jsm = await jetstreamManager(nc);
  await new Objm(jetstream(nc)).create(bucket, { max_bytes: -1 });
  let { config } = await jsm.streams.info(stream);
  // LEGACY RECONCILE, and only the legacy value. A store created by the code that set a 4 GiB cap is
  // still holding 4 GiB of the broker's `max_file_store` reserved against it, so leaving it alone
  // would leave the defect in place on every existing mesh. Update it to -1 and READ IT BACK: an
  // update the broker accepts without applying is the failure this path must not report as success.
  if (config.max_bytes === LEGACY_ARTIFACT_STORE_MAX_BYTES) {
    await jsm.streams.update(stream, { ...config, max_bytes: -1 });
    ({ config } = await jsm.streams.info(stream));
    if (config.max_bytes !== -1)
      throw new Error(
        `artifact store ${stream} is still at the legacy ${LEGACY_ARTIFACT_STORE_MAX_BYTES}-byte cap after ` +
        `the reconcile (max_bytes read back as ${config.max_bytes}): the STREAM.UPDATE did not take, so the ` +
        `broker is still reserving that capacity against its file store`,
      );
  }
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
  // A positive cap that is NOT the legacy stock value was set deliberately by someone else, and the
  // reconcile above has already converged the one value this code is entitled to change. Refuse it
  // rather than widening it: a bound this code did not set is not a bound it may remove.
  if (config.max_bytes !== -1)
    drift.push(`max_bytes is ${config.max_bytes}, expected -1 (a deliberate cap is not widened by setup)`);
  // `discard: new` is what makes a full store REFUSE a put instead of evicting a live artifact whose
  // reference is already published. Drift here is silent data loss, not a capacity difference.
  if (String(config.discard) !== "new") drift.push(`discard is ${config.discard}, expected new`);
  // File storage: memory-backed artifacts vanish on a broker restart while every published reference
  // survives, which turns a restart into a wave of unresolvable references.
  if (String(config.storage) !== "file") drift.push(`storage is ${config.storage}, expected file`);
  // Limits retention: any interest/work-queue retention DELETES messages once consumed, so a fetch
  // would destroy the artifact it just read.
  if (String(config.retention) !== "limits") drift.push(`retention is ${config.retention}, expected limits`);
  // Rollup headers: WRITE-CRITICAL, and measured rather than assumed. With `allow_rollup_hdrs:false`
  // on an otherwise canonical store, `put` fails outright with "rollup not permitted" - the object
  // store uses a rollup to replace an object's metadata. So a store drifted here accepts setup and
  // then rejects every artifact, which is the worst shape: green provisioning, broken feature.
  //
  // `allow_direct` is deliberately NOT checked. Measured on the same probe: with it false, put and
  // get both still succeed, because this client's info path uses STREAM.MSG.GET rather than
  // DIRECT.GET. Asserting it would refuse a store that works.
  if (config.allow_rollup_hdrs !== true) drift.push("allow_rollup_hdrs is false, expected true (put fails without it)");
  // max_age: SILENT DATA LOSS, measured. With max_age 1s on an otherwise canonical store, a put
  // succeeds and the object is GONE 1.8s later (stream messages back to 0) - while every reference
  // already published to a channel survives forever. That is the dangling-reference wave this design
  // refuses everywhere else, arriving from a config field rather than from GC.
  if (config.max_age !== 0) drift.push(`max_age is ${config.max_age}, expected 0 (a non-zero age silently deletes stored artifacts)`);
  // sealed: cheap to check, and the mechanism is NOT the one it is usually described by. Measured:
  // the broker REFUSES to create a sealed stream at all ("stream configuration for create can not be
  // sealed"), so a sealed store cannot arrive through the create path - only by a later update. That
  // narrows it to a deliberate operator action, which is exactly the drift worth naming.
  if (config.sealed === true) drift.push("the stream is SEALED (writes permanently refused)");
  // The message-count and size limits must stay unbounded, because THE BROKER'S FILE STORE IS
  // SUPPOSED TO BE THE OPERATIVE BOUND. Reproduced: max_msgs=2 accepts setup, the first 1-byte object
  // succeeds (chunk + meta = 2 messages), and the second fails "maximum messages exceeded" with the
  // whole file store free. A hidden limit that refuses artifacts long before the broker is full is
  // loud rather than silent, but still a bound nobody configured deliberately.
  for (const [field, value] of [["max_msgs", config.max_msgs], ["max_msgs_per_subject", config.max_msgs_per_subject],
                                ["max_msg_size", config.max_msg_size]] as const)
    if (value !== -1) drift.push(`${field} is ${value}, expected -1 (the broker's file-store cap is this store's only bound)`);
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
  const nc = await connect({ servers: opts.servers, ...standaloneConnectOpts({ creds: opts.creds, /* not yet wired to a recorded transport - see broker-policy/MeshEntry work */ tls: false }) });
  try {
    // SPEC §13.12: the control surface requires nats-server >= 2.12; this runs on every
    // fresh connection, including reconnects.
    requireBrokerFloor(nc);
    const jsm = await jetstreamManager(nc);
    await createSpaceStreams(jsm, opts.space);
    // KV buckets are streams too — pre-create them so agents (denied KV stream-create) can open
    // them. Idempotent. The TTL'd ones come from `ttlBuckets` and ONLY from there, so a new one
    // cannot be created on this path without also being reconciled on the upgrade path; the
    // channel/members/acl registries below are durable config and carry no TTL.
    const kvm = new Kvm(nc);
    for (const [bucket, ttl, storage] of ttlBuckets(opts.space)) await kvm.create(bucket, { ttl, storage });
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
    // The two §13.12 AUTHORITY stores (records + auth): every auth-mode mesh now carries a
    // lifecycle registry — user mode's service re-ensures at its own boot, the STATIC manager's
    // start reconcile re-ensures for pre-existing spaces (Unit B) — and the up-time seed creates
    // them so neither daemon needs first-write stream creation. Create-or-verify, idempotent,
    // drift fails loud.
    await createEndpointStreams(jsm, kvm, opts.space);
    // #286: `kvm.create` above is a no-op on an ALREADY-EXISTING bucket, so a bucket from a cotal that
    // predated these TTLs keeps its old (often unlimited) `max_age` and never expires dead presence /
    // stale leases. Reconcile the three TTL'd buckets' `max_age` here (STREAM.UPDATE), idempotently.
    // Same list as `reconcileSpaceTtls`, from one source: two copies would let a fourth TTL'd bucket
    // be added to the create path and silently miss the upgrade path, which is this defect exactly.
    const js = jetstream(nc);
    await Promise.all(
      ttlBuckets(opts.space).map(([bucket, ttl]) => reconcileBucketTtl(jsm, js, `KV_${bucket}`, bucket, ttl)),
    );
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
  const nc = await connect({ servers: opts.servers, ...standaloneConnectOpts({ ...opts, /* not yet wired to a recorded transport - see broker-policy/MeshEntry work */ tls: false }) });
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
  const nc = await connect({ servers: opts.servers, ...standaloneConnectOpts({ ...opts, /* not yet wired to a recorded transport - see broker-policy/MeshEntry work */ tls: false }) });
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
/**
 * Bounded accounting for logical resources inspected, deleted, verified absent, or refused
 * during agent lifecycle deprovisioning.
 */
export interface DeprovisionResourceAccounting {
  /** Total count of distinct candidate resources examined across consumers, ACL and members. */
  examined: number;
  /** Uniquely attributable removals; null when a consumer disappeared without a native winner token. */
  deleted: number | null;
  /** Resources already absent at this attempt's first native observation of each resource. */
  absent: number;
  /** Number of resources that could not be deleted (broker errors). */
  refused: number;
  /** Native consumer DELETE success replies, not uniquely attributable removals. */
  acknowledged: number;
  /** Live resources observed gone without attributing removal to this call. */
  disappeared: number;
  /** Durable consumer accounting. */
  consumers: { examined: number; deleted: number | null; absent: number; refused: number; acknowledged: number; disappeared: number };
  /** Read-ACL entry accounting; disappeared means a competing purge won the native CAS. */
  acls: { examined: number; deleted: number; absent: number; refused: number; disappeared: number };
  /** Durable membership entry accounting; disappeared means a competing purge won the native CAS. */
  members: { examined: number; deleted: number; absent: number; refused: number; disappeared: number };
}

/** Error raised when deprovisioning encounters an unexpected failure, retaining partial deletion accounting. */
export class DeprovisionError extends Error {
  public readonly accounting: DeprovisionResourceAccounting;
  constructor(message: string, accounting: DeprovisionResourceAccounting, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "DeprovisionError";
    this.accounting = accounting;
  }
}

export async function deprovisionAgent(opts: {
  servers: string;
  space: string;
  targetId: string;
  lifecycleUid: string;
  /** Concrete channels whose membership rows to purge; must equal the cred's `memberChannels`. */
  memberChannels?: readonly string[];
  creds?: string;
}): Promise<DeprovisionResourceAccounting> {
  const nc = await connect({
    servers: opts.servers,
    ...standaloneConnectOpts({ creds: opts.creds, /* not yet wired to a recorded transport - see broker-policy/MeshEntry work */ tls: false }),
    // This is a detached, fire-and-forget teardown — it must FAIL FAST, never hang, so the caller's
    // fail-loud `.catch` is load-bearing: no reconnect loop (a wedged broker rejects promptly instead of
    // looping silently) and a bounded initial connect. Without this a broker-down deprovision would sit
    // pending forever and the footprint would survive with no log.
    maxReconnectAttempts: 0,
    timeout: 5_000,
  });

  const accounting: DeprovisionResourceAccounting = {
    examined: 0,
    deleted: 0,
    absent: 0,
    refused: 0,
    acknowledged: 0,
    disappeared: 0,
    consumers: { examined: 0, deleted: 0, absent: 0, refused: 0, acknowledged: 0, disappeared: 0 },
    acls: { examined: 0, deleted: 0, absent: 0, refused: 0, disappeared: 0 },
    members: { examined: 0, deleted: 0, absent: 0, refused: 0, disappeared: 0 },
  };

  try {
    // The target is a full principal dot-form (user-mode agent) or a bare static actor id under the
    // local owner, PLUS the exact lifecycle uid being torn down — the SAME resolution the
    // deprovisioner cred's permission pin used, so the delete names and the grant can't diverge.
    const t = deprovisionTargetPrincipal({ principal: opts.targetId, lifecycleUid: opts.lifecycleUid, memberChannels: opts.memberChannels });
    const jsm = await jetstreamManager(nc);
    const errors: Error[] = [];

    // 1. Read-ACL entry. This CAS fences only this key's transition, not the other resources.
    accounting.acls.examined++;
    accounting.examined++;
    let aclSafe = false;
    try {
      const aclsKv = await openAclRegistry(nc, opts.space);
      const aclKeyStr = aclKey(principalKey(t.owner, t.actor).key, t.lifecycleUid);
      const aclRes = await purgeKvKeyWithAccounting(jsm, aclsKv, aclBucket(opts.space), aclKeyStr);
      aclSafe = true;
      if (aclRes.outcome === "deleted") {
        accounting.acls.deleted++;
        if (accounting.deleted !== null) accounting.deleted++;
      } else if (aclRes.outcome === "disappeared") {
        accounting.acls.disappeared++;
        accounting.disappeared++;
      } else {
        accounting.acls.absent++;
        accounting.absent++;
      }
    } catch (e) {
      accounting.acls.refused++;
      accounting.refused++;
      errors.push(e as Error);
    }

    // 2. Consumers (dm + dlv)
    accounting.consumers.examined += 2;
    accounting.examined += 2;
    if (!aclSafe) {
      // The key may still be live. Do not erase its consumers or invent absence.
      accounting.consumers.refused += 2;
      accounting.refused += 2;
    } else for (const [stream, name] of [
      [dmStream(opts.space), dmDurable(t.owner, t.actor, t.lifecycleUid)],
      [dlvStream(opts.space), dlvDurable(t.owner, t.actor, t.lifecycleUid)],
    ]) {
      try {
        const outcome = await deleteConsumerIdempotent(jsm, stream, name, () => {
          accounting.consumers.acknowledged++;
          accounting.acknowledged++;
        });
        if (outcome === "absent") {
          accounting.consumers.absent++;
          accounting.absent++;
        } else if (outcome === "disappeared") {
          accounting.consumers.disappeared++;
          accounting.disappeared++;
          accounting.consumers.deleted = null;
          accounting.deleted = null;
        } else {
          throw new Error(`${stream}/${name} remains live after acknowledged DELETE`);
        }
      } catch (e) {
        accounting.consumers.refused++;
        accounting.refused++;
        errors.push(e as Error);
      }
    }

    // 3. Member rows
    if (t.memberChannels.length > 0) {
      if (!aclSafe) {
        accounting.members.examined += t.memberChannels.length;
        accounting.examined += t.memberChannels.length;
        accounting.members.refused += t.memberChannels.length;
        accounting.refused += t.memberChannels.length;
      } else {
        try {
          const membersKv = await openMembersRegistry(nc, opts.space);
          for (const ch of t.memberChannels) {
            accounting.members.examined++;
            accounting.examined++;
            try {
              const mKeyStr = memberKey(ch, principalKey(t.owner, t.actor).key, t.lifecycleUid);
              const mRes = await purgeKvKeyWithAccounting(jsm, membersKv, membersBucket(opts.space), mKeyStr);
              if (mRes.outcome === "deleted") {
                accounting.members.deleted++;
                if (accounting.deleted !== null) accounting.deleted++;
              } else if (mRes.outcome === "disappeared") {
                accounting.members.disappeared++;
                accounting.disappeared++;
              } else {
                accounting.members.absent++;
                accounting.absent++;
              }
            } catch (e) {
              accounting.members.refused++;
              accounting.refused++;
              errors.push(e as Error);
            }
          }
        } catch (e) {
          for (let i = accounting.members.examined; i < t.memberChannels.length; i++) {
            accounting.members.examined++;
            accounting.examined++;
            accounting.members.refused++;
            accounting.refused++;
          }
          errors.push(e as Error);
        }
      }
    }

    if (errors.length > 0) {
      throw new DeprovisionError(
        `deprovision refused on ${errors.length} resource(s): ${errors.map((e) => e.message).join("; ")}`,
        accounting,
        errors[0],
      );
    }

    return accounting;
  } finally {
    await nc.drain();
  }
}

/** Purge one exact KV key with native revision fencing. A lost CAS never proves absence. */
async function purgeKvKeyWithAccounting(
  jsm: JetStreamManager,
  kv: KV,
  bucket: string,
  key: string,
): Promise<{ outcome: "deleted" | "absent" | "disappeared"; status: "won" | "raced-loss" | "already-tombstoned" | "missing" }> {
  const stream = `KV_${bucket}`;
  const subject = `$KV.${bucket}.${key}`;
  const observe = async (): Promise<{ live: boolean; missing: boolean; seq?: number }> => {
    try {
      const msg = await jsm.direct.getMessage(stream, { last_by_subj: subject });
      if (msg === null) return { live: false, missing: true };
      const op = msg.header?.get("KV-Operation");
      return { live: op !== "PURGE" && op !== "DEL", missing: false, seq: msg.seq };
    } catch (e) {
      if ([404, 10037].includes((e as { code?: number }).code ?? -1)) return { live: false, missing: true };
      throw e;
    }
  };
  const before = await observe();
  if (before.missing) return { outcome: "absent", status: "missing" };
  try {
    await kv.purge(key, { previousSeq: before.seq });
    return before.live ? { outcome: "deleted", status: "won" } : { outcome: "absent", status: "already-tombstoned" };
  } catch (err: unknown) {
    const m = (err as Error)?.message ?? "";
    if ((err as { code?: number }).code === 10071 || m.includes("10071") || m.includes("wrong last sequence")) {
      const after = await observe();
      if (after.live) throw new Error(`CAS loss left a live ${bucket}/${key}`, { cause: err });
      return { outcome: before.live ? "disappeared" : "absent", status: "raced-loss" };
    }
    throw err;
  }
}

/** Observe the exact consumer before and after a native DELETE. The boolean is an acknowledgment,
 * not a unique-removal token; two simultaneous callers can both receive true. */
async function deleteConsumerIdempotent(jsm: JetStreamManager, stream: string, name: string, onAcknowledged: () => void): Promise<"disappeared" | "absent" | "still-live"> {
  const present = async (): Promise<boolean> => {
    try {
      await jsm.consumers.info(stream, name);
      return true;
    } catch (e) {
      if ((e as { code?: number }).code === 10014) return false;
      throw e;
    }
  };
  if (!(await present())) return "absent";
  let acknowledged: boolean;
  try {
    acknowledged = await jsm.consumers.delete(stream, name);
  } catch (e) {
    // An overlapping deletion can return not-found after our pre-read. Native post-state settles
    // disappearance, but cannot attribute that deletion or an acknowledgment to this caller.
    if ((e as { code?: number }).code !== 10014) throw e;
    if (!(await present())) return "disappeared";
    throw e;
  }
  if (!acknowledged) throw new Error(`native DELETE did not acknowledge ${stream}/${name}`);
  onAcknowledged();
  return (await present()) ? "still-live" : "disappeared";
}
