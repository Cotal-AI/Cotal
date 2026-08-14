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
import { possessionBucket, attachmentBucket } from "./artifact-index.js";
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
/** #286: reconcile a TTL'd KV bucket's `max_age` to `ttlMs`. `kvm.create` NEVER updates an existing
 *  bucket's config, so a presence/lease bucket created by a cotal that predated the TTL (or created
 *  without it) keeps NO expiry forever — dead presence records and stale leases never age out, and a
 *  raw-KV reader (a dashboard) shows a crashed agent as live indefinitely. Run at every `cotal up`, this
 *  `STREAM.UPDATE`s the backing stream when its `max_age` has drifted. Lowering `max_age` immediately
 *  ages out already-expired messages (the intended liveness effect; active leases are younger than their
 *  TTL and survive, a stale one dies and its holder self-fences on its next failed renewal). NATS requires
 *  `duplicate_window <= max_age`; an old unlimited bucket's 120s window would otherwise reject the update,
 *  so the window is lowered in the SAME update. Idempotent (a matching bucket is skipped). The `provisioner`
 *  cred holds `STREAM.UPDATE` on exactly these three streams (see provision.ts).
 *
 *  WHAT THE READ-BACK PROVES, AND WHAT IT CANNOT. It verifies exactly two things: **`max_age` came back
 *  EXACTLY as intended**, and **`duplicate_window` does not violate the NATS constraint** (it is not
 *  above `max_age`). A no-op update, a `max_age` that came back other than intended, or a server that
 *  answers OK without changing anything is caught here and throws.
 *
 *  Note what that does NOT include: the update sends a computed `dupNs`, but the read-back never checks
 *  the window came back as sent — omitted, zeroed, or clamped smaller all pass. Deliberate: any window
 *  `<= max_age` is legal and harmless for a liveness bucket, and demanding equality would turn a
 *  legitimate server-side clamp into a failed `cotal up`. (Confirmed by probe: the real function accepts
 *  a read-back with exact `max_age` and the window OMITTED.) It does NOT prove that file-store expiry is
 *  in force either, and the distinction is
 *  not theoretical — on the supported floor (nats-server 2.12.1) the effect is applied in two places and
 *  only one of them is visible to us:
 *    - `stream.go` assigns the new in-memory `mset.cfg`, then calls `mset.store.UpdateConfig(cfg)` and
 *      IGNORES its returned error;
 *    - `filestore.go`'s `UpdateConfig` restores the previous config and returns early when
 *      `writeStreamMeta()` fails — BEFORE `expireMsgs()`/age enforcement is ever started;
 *    - `STREAM.INFO` is answered from `mset.config()`, i.e. the in-memory copy.
 *  So a metadata-write fault (EACCES, ENOSPC) yields UPDATE OK, a read-back showing the intended
 *  `max_age`, and a backing store still running unlimited with no expiry timer. **This check cannot see
 *  that**, because both fields it reads come from the config that DID get updated.
 *
 *  It is NOT, however, invisible everywhere — an earlier version of this comment said no check at this
 *  seam could see it, and that was false. `$JS.API.STREAM.SNAPSHOT` splits the useful way: the snapshot
 *  INITIATION response copies `mset.config()` and false-greens like INFO, but the STREAMED archive's
 *  first `meta.inf` entry marshals `fs.cfg` — the file store's own, rolled-back config. Reproduced live
 *  against an EACCES split: INFO and the initiation response both reported the requested TTL while the
 *  streamed `meta.inf` reported the old one. So a store-side detector EXISTS in the protocol, and this
 *  codebase has `downloadStreamSnapshot` plus a per-stream-scoped snapshot grant MODEL (`backup.ts`).
 *
 *  **It is NOT available under current authority, and that — not the cost — is what blocks it.**
 *  `assertBackupStream` runs every scope through `canonicalBackupStreamConfig`, which accepts only the
 *  durable registries (channel / acl / members) among KV buckets and THROWS for presence, delivery and
 *  manager. So wiring this in needs a NEW EXACT SCOPE, or a widening of the reconcile credential to
 *  whole-body snapshot authority over liveness data — an unsettled authority question on the credential
 *  this change otherwise keeps to three `STREAM.UPDATE` subjects. The cost is real too (it scales with
 *  bucket size, and a snapshot carries the bucket's records), but quoting only the cost would read as
 *  "available but expensive", which is the wrong summary. See the tracking issue for the full spec.
 *
 *  Stated here rather than left implied: this guard is a drift detector, not proof of enforcement — and
 *  "cannot be detected here" is the stronger claim it does NOT license.
 *
 *  CONSEQUENCE OF READING FIRST, which follows from the same split and is worth naming because the
 *  skip is deliberate: once `STREAM.INFO` reports the intended `max_age`, later reconciles see no
 *  drift and issue no update, so a bucket left unenforced by a metadata-write fault is not retried
 *  for as long as that server process lives.
 *
 *  WHERE THAT GOES depends on WHEN the write failed, and an earlier version of this comment got it
 *  wrong by generalising from one case. `writeStreamMeta` performs TWO writes — `meta.inf`, then
 *  `meta.sum` — and `UpdateConfig` rolls `fs.cfg` back if either fails:
 *    - **Failure BEFORE the first write commits** (the original EACCES reproduction): persisted state
 *      is coherent and old, so a restart makes `INFO` report the old value again and the next
 *      reconcile repairs it. Here the skip DEFERS a repair.
 *    - **Failure BETWEEN the two** (reproduced live by pointing `meta.sum.tmp` at `/dev/full`):
 *      `meta.inf` commits NEW while `meta.sum` stays OLD — a torn pair. On restart the server logs
 *      `checksums do not match` and recovery `continue`s past the stream, so it is SKIPPED: `INFO`
 *      returns **stream not found**, and the reconcile cannot repair it because its own first `INFO`
 *      gets not-found. **That case does not defer a repair, it loses the stream until an operator
 *      intervenes.**
 *  So "the persisted metadata is ground truth, restart repairs it" is TRUE ONLY of the
 *  before-first-atomic case, and "defers, never loses" is false in general. The read-first skip is
 *  still right — it keeps a healthy repeat `cotal up` to reads and no writes — but its worst case is
 *  worse than a deferred repair. Both branches reproduced live against 2.12.1 during review; see the
 *  tracking issue. */
export async function reconcileBucketTtl(jsm: JetStreamManager, streamName: string, ttlMs: number): Promise<TtlReconciled | undefined> {
  const wantNs = nanos(ttlMs);
  const info = await jsm.streams.info(streamName);
  if (info.config.max_age === wantNs) return undefined; // already at the intended TTL — no update
  const fromNs = info.config.max_age;
  const dupNs = Math.min(info.config.duplicate_window ?? wantNs, wantNs); // NATS constraint: duplicate_window <= max_age
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
export function ttlBuckets(space: string): ReadonlyArray<readonly [string, number]> {
  return [
    // Presence (liveness): dead agents' records must age out, or the roster reports a despawned
    // agent as live. Pre-created so agents, denied KV stream-create, can open it.
    [presenceBucket(space), PRESENCE_TTL_MS],
    // Delivery-daemon single-flight lease + readiness: bucket-level TTL so a crashed holder's lease
    // auto-expires and a fresh daemon can re-acquire. Lease keys only, `delivery`-cred write,
    // world-readable (the non-gating delivery-health surface).
    [deliveryBucket(space), LEASE_TTL_MS],
    // Manager singleton lease, same shape as the delivery lease. Pre-created so the long-lived
    // supervisor can lease-bind OPEN-ONLY (closure (ii), residual 2) — it holds no STREAM.CREATE.
    // Config matches `managerLeaseRegistry()`'s create-first exactly, so that path stays idempotent.
    [managerBucket(space), MANAGER_LEASE_TTL_MS],
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
    const jsm = await jetstreamManager(nc);
    const changed: TtlReconciled[] = [];
    for (const [bucket, ttl] of ttlBuckets(opts.space)) {
      const done = await reconcileBucketTtl(jsm, `KV_${bucket}`, ttl);
      if (done) changed.push(done);
    }
    return changed;
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
/**
 * Create the artifact INDEX stores — possession rows and attachment rows.
 *
 * ONE HELPER, CALLED BY BOTH SPACE SETUP AND RESTORE, AND THAT IS THE ENTIRE POINT.
 *
 * A space resource has to appear in five lists — create, delete, grants, backup inventory, restore —
 * and being in four of them is the failure that reads as correct. This lane shipped four-of-five
 * TWICE in one slice: once on the create list, and once on RESTORE, under a changeset asserting the
 * opposite. Both times the cause was the same — the create list and the restore list were two
 * independent bodies of code that happened to agree, so keeping them in agreement was a thing a
 * person had to remember.
 *
 * Extracting the creation into one function does not merely fix the omission, it removes the class:
 * the two paths can no longer disagree about what an artifact index store is, because there is only
 * one place that says. The remaining four excluded stores are still duplicated between the two paths;
 * they are another surface's to collapse, and this comment is where the next person doing it should
 * start.
 *
 * NO TTL, and it is load-bearing: possession must OUTLIVE the lifecycle that earned it so a delayed
 * message can still attach after its publisher retires. A ttl here would reap the rows on a timer and
 * re-fire the exact branch the `confirmAttach` design exists to close, with no adversary involved.
 */
export async function ensureArtifactIndexStores(kvm: Kvm, space: string): Promise<void> {
  await kvm.create(possessionBucket(space), { history: 1 });
  await kvm.create(attachmentBucket(space), { history: 1 });
}

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
  // The message-count and size limits must stay unbounded, because THE CAP IS SUPPOSED TO BE THE
  // OPERATIVE BOUND. Reproduced: max_msgs=2 accepts setup, the first 1-byte object succeeds (chunk +
  // meta = 2 messages), and the second fails "maximum messages exceeded" with 4 GiB still free. A
  // hidden limit that overrides the advertised capacity makes the number this code reports a lie -
  // loud rather than silent, but still a bound nobody configured deliberately.
  for (const [field, value] of [["max_msgs", config.max_msgs], ["max_msgs_per_subject", config.max_msgs_per_subject],
                                ["max_msg_size", config.max_msg_size]] as const)
    if (value !== -1) drift.push(`${field} is ${value}, expected -1 (max_bytes is the only bound this store advertises)`);
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
    const jsm = await jetstreamManager(nc);
    await createSpaceStreams(jsm, opts.space);
    // KV buckets are streams too — pre-create them so agents (denied KV stream-create) can open
    // them. Idempotent. The TTL'd ones come from `ttlBuckets` and ONLY from there, so a new one
    // cannot be created on this path without also being reconciled on the upgrade path; the
    // channel/members/acl registries below are durable config and carry no TTL.
    const kvm = new Kvm(nc);
    for (const [bucket, ttl] of ttlBuckets(opts.space)) await kvm.create(bucket, { ttl });
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
    await ensureArtifactIndexStores(kvm, opts.space);
    await ensureAuthorityStores(jsm, kvm, opts.space);
    // #286: `kvm.create` above is a no-op on an ALREADY-EXISTING bucket, so a bucket from a cotal that
    // predated these TTLs keeps its old (often unlimited) `max_age` and never expires dead presence /
    // stale leases. Reconcile the three TTL'd buckets' `max_age` here (STREAM.UPDATE), idempotently.
    // Same list as `reconcileSpaceTtls`, from one source: two copies would let a fourth TTL'd bucket
    // be added to the create path and silently miss the upgrade path, which is this defect exactly.
    for (const [bucket, ttl] of ttlBuckets(opts.space)) await reconcileBucketTtl(jsm, `KV_${bucket}`, ttl);
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
export async function deprovisionAgent(opts: {
  servers: string;
  space: string;
  targetId: string;
  lifecycleUid: string;
  creds?: string;
}): Promise<void> {
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
