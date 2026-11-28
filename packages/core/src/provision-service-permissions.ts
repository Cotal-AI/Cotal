// The service-account and daemon permission builders `permissionsFor` composes: the purger,
// provisioner, issuer, registry reader, run admitter, lifecycle executor, goal writer, session,
// endpoint-serve executor, deprovisioner, delivery, membership and connection-evictor profiles.
// provision-permission-builders.ts re-exports each of them, so import paths are unchanged.
import { eventPayloadStream } from "./event-payloads.js";
import { artifactIndexStreamNames } from "./artifact-index-stores.js";
import { TTL_RECONCILE_CANARY_KEY, ttlBuckets } from "./streams.js";
import { BROKER_USER_INFO_SUBJECT } from "./broker-identity.js";
import { spacePrefix, principalKey, deprovisionTargetPrincipal, unicastSubject, artifactBucket, objectStoreStream, chatStream, dmStream, taskStream, dlvStream, inboxStream, dmDurable, dlvDurable, presenceBucket, channelBucket, membersBucket, aclBucket, aclKey, memberKey, assertLifecycleToken, type DeprovisionTarget, membershipBucket, deliveryBucket, managerBucket, connzRequestSubject, accountConnectSubject, accountDisconnectSubject, MEMBERSHIP_INBOX_PREFIX, INBOX_READER_DURABLE, livenessServeFilter, livenessReplyGrant, takeServeFilter, takeReplyGrant, anycastBucket } from "./subjects.js";
import { goalWriterGrants, sessionLedgerGrants, epAuthBucket, epcStreamName, endpointPlaneStreamNames, eptReqStreamName, eptStreamName, hardenedAuthorityStreamNames, timerWriterDurable, timerWriterGrants } from "./endpoint-binding.js";
import { epsSubject } from "./endpoint-subjects.js";
import { acceptedBucket, issuedBucket } from "./issued-authority.js";
import { admissionBucket, admissionKey, revocationKey } from "./run-admission.js";
import { runSubmissionKey } from "./run-submission.js";
import { recordsBucket, recordSpecKey, recordStatusKey, recordAtomicKey, RECORD_KINDS, GOVERN_HEAD } from "./endpoint-records.js";
import { lifecycleHeadKey, uidReservationKey, issuanceGateKey, staticSlotKey, STATIC_SLOT_PREFIX, epgateKey, epcredFamilyPrefix, eprepairKey } from "./lifecycle-state.js";
import type { MintOpts, MintPrincipal } from "./provision-jwt.js";

/** The ephemeral PURGER permission set — minted per-purge inside the daemon's
 *  `opPurge` and `cotal history clear`. Isolates the DESTRUCTIVE history-purge grant
 *  (`STREAM.PURGE.CHAT` + `STREAM.PURGE.DM`) off the always-on supervisor: `--dms` purges the DM stream,
 *  exactly the grant the supervisor must not hold. It PURGES but never READS — no DM/chat consumer, no
 *  `MSG.GET` — so a leaked purger can drop history but cannot read a body. Short-lived (one purge call). */
export function purgerPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  const CHAT = chatStream(space), DM = dmStream(space);
  return {
    pub: {
      allow: [
        "$JS.API.INFO", // jetstreamManager bootstrap; STREAM.PURGE needs no prior STREAM.INFO
        `$JS.API.STREAM.PURGE.${CHAT}`, // clearSpaceHistory chat purge
        `$JS.API.STREAM.PURGE.${DM}`, // clearSpaceHistory includeDms — the isolated DM-purge grant
      ],
      // NOTE: this profile does NOT cover `clearChannel` (web/`down -f` channel-delete) — that also does a
      // `$KV.<channelBucket>.<ch>` registry delete this cred lacks, which `channel-purger` and `teardown` hold.
    },
    sub: { allow: [`_INBOX_${pr.connId}.>`] },
  };
}

/** The ephemeral PROVISIONER permission set — the onboarding authority,
 *  carved off the long-lived manager. Minted short-lived for per-spawn provisioning (pre-create each
 *  agent's bind-only DM/DLV/TASK durables + record its read ACL via `commitAcl`) — the daemon opens it per
 *  spawn (`manager.ts withProvisioner`). It is ALSO the cred that creates the space's streams + KV buckets
 *  and seeds the channel registry via `setupSpaceStreams` (exercised by the manager-split smoke) — and
 *  `cotal up`'s ephemeral setup cred (`up.ts authSetup`) now mints THIS profile, not the broad `manager`.
 *  NEVER minted for an agent — `cotal mint` whitelists
 *  agent/observer/admin only, like `manager`/`delivery`.
 *
 *  This profile HOLDS the DM/DLV `CONSUMER.CREATE` push-consumer surface — the irreducible onboarding
 *  power (the create-time `deliver_subject` of a push consumer is not ACL-constrained, so whoever can
 *  create a DM/DLV consumer can stream the bodies). That is exactly why it is split OFF the always-on
 *  supervisor and made EPHEMERAL: the daemon opens a provisioner connection per spawn and drains it
 *  immediately, so the surface exists only for the provisioning window, not as a standing target. The
 *  cred is MEMORY-ONLY (never written to `.cotal`) and carries a short profile-default `exp`.
 *
 *  `$JS` is an ENUMERATED allow-list, never `$JS.>`: STREAM.CREATE + INFO for the space streams/buckets,
 *  DM/DLV/TASK consumer CREATE/DURABLE.CREATE/INFO — and deliberately NO `MSG.NEXT`/`MSG.GET`/`ACK` on
 *  DM/DLV (it creates the bind-only mailbox but never reads it), and NO STREAM.DELETE/PURGE/MSG.DELETE
 *  (it provisions, it does not tear down). STREAM.UPDATE is held on EXACTLY thirteen streams and no others:
 *  the three TTL'd KV buckets (presence + the two leases, #286: an existing bucket's `max_age` cannot be
 *  fixed by `kvm.create`, so reconciling a pre-TTL deployment requires updating it), the four hardened
 *  authority stores (records, issued, accepted, admission), each updated once at creation, and the
 *  membership KV and artifact Object Store, whose legacy `max_bytes` values setup reconciles to -1 (the
 *  reservation a positive cap holds against the broker's `max_file_store` is what stopped a tenth space
 *  from being provisioned; `Objm.create` cannot fix an existing bucket's cap either), and the CHAT,
 *  INBOX, DLV and DM streams, whose history limits `cotal history limit` writes (`setHistoryLimit`).
 *  Stated positively on purpose: this docblock previously read "NO …/UPDATE", which was already untrue of
 *  the records stream and became untrue of the buckets, and a comment that denies a credential's real
 *  power is worse than none — it is the document a reader trusts instead of checking. KV value-writes are
 *  scoped to exactly the two
 *  registries provisioning touches: the read-ACL bucket (`commitAcl`) and the channel registry (seed). */
export function provisionerPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  const CHAT = chatStream(space), DM = dmStream(space), TASK = taskStream(space);
  const INBOX = inboxStream(space), DLV = dlvStream(space);
  // Every non-endpoint KV backing stream the provisioner pre-creates. Endpoint control streams and
  // their records/auth/session buckets come from endpointPlaneStreamNames below, the same downstream
  // ownership list consumed by inventory and teardown. The provisioner holds create-or-verify only on
  // those authority stores; lifecycle/session writes ride their narrower executor credentials.
  const buckets = [
    presenceBucket, channelBucket, membersBucket, aclBucket, membershipBucket, anycastBucket, deliveryBucket, managerBucket,
  ].map((b) => `KV_${b(space)}`);
  // STREAM.CREATE + INFO for each (idempotent setup at `cotal up`; CREATE is create-if-matching, INFO covers
  // the client's existence checks). NO DELETE/PURGE — provisioning never tears a stream down.
  // The §13.7 CONTRACT store (EPC) joins the list for the static manager's start-time
  // `ensureContractStore`: create-or-verify only — the provisioner holds no
  // artifact-publish grant on it (publication rides the scoped endpoint-serve executor).
  // The seven §13.12 ENDPOINT streams join the list: spawn-as-action makes the manager
  // the first EPF (goal facts) + EPE (progress) writer, and nothing provisioned the endpoint streams
  // before (no manager code wrote to them), so `createEndpointStreams` now runs at the manager's
  // start-time ensure over this provisioner. Create-or-verify only (idempotent, fail-loud on drift);
  // the provisioner holds no value-write on any of them (goal facts ride the scoped goal-writer cred).
  // WFJ and the EPC/records/auth/session stores join them through endpointPlaneStreamNames because
  // createEndpointStreams owns all twelve resources. Create-or-verify only; the provisioner appends
  // nothing (writes ride the narrower runtime and authority credentials).
  // The artifact Object Store joins the list: `setupSpaceStreams` creates it, and under auth mode the
  // provisioner is the cred doing that creating. Its backing stream is `OBJ_<bucket>` - named
  // explicitly, because `$O.<bucket>.>` is outside the `cotal.<space>.>` grammar and no space-prefix
  // grant reaches it. CREATE + INFO here, plus the ONE STREAM.UPDATE below (the legacy-cap reconcile):
  // the provisioner never publishes an object, never creates a consumer on it, and never deletes it.
  // That confinement is load-bearing rather than tidy - the
  // object-store client reads by creating an ephemeral PUSH consumer with a caller-chosen
  // `deliver_subject`, so a CONSUMER.CREATE here would be an exporter of every artifact in the space.
  const OBJ = objectStoreStream(artifactBucket(space));
  // The three artifact index buckets: create-or-verify only, exactly like the object store above. The
  // provisioner holds no value write and no read on them; the artifacts service is their only writer.
  const streamSetup = [CHAT, DM, TASK, INBOX, DLV, eventPayloadStream(space), OBJ, ...artifactIndexStreamNames(space), ...endpointPlaneStreamNames(space), ...buckets].flatMap((s) => [
    `$JS.API.STREAM.CREATE.${s}`,
    `$JS.API.STREAM.INFO.${s}`,
  ]);
  // #286: STREAM.UPDATE on EXACTLY the three TTL'd KV streams (presence + the two leases). `kvm.create`
  // never updates an existing bucket's config, so a bucket created by a cotal that predates the `max_age`
  // TTL keeps NO expiry forever — dead presence records (and stale leases) never age out. `setupSpaceStreams`
  // reconciles their `max_age` via STREAM.UPDATE at every `cotal up`, which needs this grant. Scoped to these
  // three streams here. The durable task stream and the channel/members/acl registries are never
  // updated (the history limits of the four message streams are the exception, below), and there is
  // still NO DELETE/PURGE. The supervisor profile keeps its full UPDATE
  // denial; this widening is provisioning-only.
  // Derived from the SAME inventory that creates and reconciles them, not a third hand-kept copy.
  // Review found this list was the last independent one: a fourth TTL'd bucket added to `ttlBuckets`
  // would be created and reconciled correctly and then die on a permissions violation here, because
  // the grant never learned about it. Same defect one seam out — a bucket the code knows to maintain
  // and the credential is not allowed to.
  const ttlStreams = ttlBuckets(space).map(([bucket]) => `KV_${bucket}`);
  // ...plus the membership KV and artifact Object Store. Both create at `max_bytes: -1` so they
  // reserve nothing against the broker's `max_file_store`, and both reconcile only their own stock
  // legacy caps so an EXISTING mesh releases those reservations too. The create clients never update
  // an existing bucket's config, so each reconcile is a STREAM.UPDATE and needs this grant — without
  // it the provisioner dies on a permissions violation on the first `cotal up` after the upgrade.
  // Still CREATE/INFO/UPDATE only:
  // no publish, no CONSUMER.CREATE (a push consumer's caller-chosen `deliver_subject` would export
  // every artifact in the space), no DELETE/PURGE.
  // ...plus the CHAT, INBOX, DLV and DM streams: `cotal history limit` sets their history limits
  // (SPEC §8). STREAM.UPDATE is a whole-config write, so the grant reaches every setting of them;
  // `setHistoryLimit` changes only `max_age` and `max_msgs_per_subject` and refuses a read back that is
  // not canonical apart from those two. TASK stays create-only.
  const streamReconcile = [...ttlStreams, `KV_${membershipBucket(space)}`, OBJ, CHAT, INBOX, DLV, DM]
    .map((s) => `$JS.API.STREAM.UPDATE.${s}`);
  // #404: one EXACT reserved key on each TTL bucket is the post-update enforcement canary. The
  // provisioner still cannot write presence identities or lease keys; it can only write this fixed
  // maintenance key, which expires through the policy the reconcile is proving.
  const ttlCanaries = ttlBuckets(space).map(([bucket]) => `$KV.${bucket}.${TTL_RECONCILE_CANARY_KEY}`);
  // DM/DLV/TASK durable pre-create (bind-only mailboxes): both the new-API CREATE and legacy DURABLE.CREATE
  // forms (the client's consumer-add path varies by version), plus INFO (the add returns ConsumerInfo).
  // NO MSG.NEXT/MSG.GET/ACK — the provisioner creates the consumer but MUST NOT read its body.
  const consumerCreate = [DM, DLV, TASK].flatMap((s) => [
    `$JS.API.CONSUMER.CREATE.${s}.>`,
    `$JS.API.CONSUMER.DURABLE.CREATE.${s}.>`,
    `$JS.API.CONSUMER.INFO.${s}.>`,
  ]);
  return {
    pub: {
      allow: [
        "$JS.API.INFO",
        // Current-connection identity only; the broker maps the account and requesting user.
        // No subject containing another account/user and no system credential is granted.
        BROKER_USER_INFO_SUBJECT,
        ...streamSetup,
        ...streamReconcile,
        ...ttlCanaries,
        ...consumerCreate,
        // KV value-writes — exactly the two registries provisioning writes: the agent read-ACL registry
        // (`commitAcl` at provision) and the channel registry (seed defaults at `cotal up`, channel admin).
        // NO presence/members/membership/delivery writes (the agent's own key, the delivery cred, and the
        // membership-rw cred own those).
        `$KV.${aclBucket(space)}.>`,
        `$KV.${channelBucket(space)}.>`,
        // ...and READ both: commitAcl read-before-writes the ACL (`kvm.open`, direct=false ⇒ STREAM.MSG.GET);
        // the channel seed read-before-writes defaults (`kvm.create`, direct=true ⇒ DIRECT.GET). Grant both
        // read verbs on both buckets to cover the open/create-path variance — reads of registries it already
        // writes, no escalation. Without these the read-before-write rejects and provisioning/seed throws.
        `$JS.API.STREAM.MSG.GET.KV_${aclBucket(space)}`,
        `$JS.API.DIRECT.GET.KV_${aclBucket(space)}.>`, // keyed get: `.>` (the key rides the subject)
        `$JS.API.STREAM.MSG.GET.KV_${channelBucket(space)}`,
        `$JS.API.DIRECT.GET.KV_${channelBucket(space)}.>`, // keyed get: `.>` (the key rides the subject)
        // The static-manager start path: `ensureAuthorityStores` UPDATEs the records store's
        // deny-flags exactly once at fresh creation (create → update → verify), and the boot
        // reconciliation sweep enumerates the manager's slot rows (`keys()` → an ordered consumer)
        // then reads each slot BODY (phase/uid/actor) to plan resume — the reads ride the
        // stream-scoped MSG.GET residual named below (records lifecycle metadata, no secrets).
        // The issued, accepted and admission stores (SPEC 13.15, 14.8) take the same one-time
        // hardening UPDATE at fresh creation as the records store: their rows are create-only and
        // their markers permanent, and a holder's own key row would otherwise replace them as a
        // value write. One list in core names the hardened stores for every seam that creates them.
        ...hardenedAuthorityStreamNames(space).map((s) => `$JS.API.STREAM.UPDATE.${s}`),
        `$JS.API.CONSUMER.CREATE.KV_${recordsBucket(space)}.>`,
        `$JS.API.CONSUMER.INFO.KV_${recordsBucket(space)}.>`,
        `$JS.API.CONSUMER.DELETE.KV_${recordsBucket(space)}.>`,
        // ...and reads the slot-mapping rows so the sweep can plan resume actions. The KV client
        // reads a lazily-bound bucket via leader-served `STREAM.MSG.GET` — stream-scoped, NOT
        // key-scoped (the requested key rides the PAYLOAD). NAMED RESIDUAL: for its one-shot
        // lifetime the provisioner can READ (never write) any records-store row — lifecycle
        // metadata, no secrets. The keyed Direct Get grant stays for direct-aware read paths.
        `$JS.API.STREAM.MSG.GET.KV_${recordsBucket(space)}`,
        `$JS.API.DIRECT.GET.KV_${recordsBucket(space)}.$KV.${recordsBucket(space)}.${STATIC_SLOT_PREFIX}.>`,
      ],
    },
    // Replies only: every stream/consumer/KV-create PubAck and JS API response lands on the per-id inbox.
    // NO chat/inst/dlv/ctl subscription — the provisioner never serves control nor reads any feed.
    sub: { allow: [`_INBOX_${pr.connId}.>`] },
  };
}

/** The ISSUER permission set (SPEC 13.15): value-writes on the evidence store (evidence, attempt,
 *  source index: create-only and CAS rows, keyed by generation) and on the accepted-row store
 *  (create-only, keyed by the client's token); `STREAM.INFO` on both, the bind-time shape check;
 *  the leader-served point read on the evidence store; and the ordered `keys()` walk a source
 *  retirement enumerates the reverse index with.
 *  NAMED RESIDUAL (the contract's section 8): this profile holds a write and a raw read on ONE
 *  stream, the pairing no peer-held profile may hold, so it is never issuable to a peer. */
export function issuerPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  const ISSUED = `KV_${issuedBucket(space)}`;
  return {
    pub: {
      allow: [
        "$JS.API.INFO",
        `$KV.${issuedBucket(space)}.>`,
        `$KV.${acceptedBucket(space)}.>`,
        // A user-auth connection's renewal finds the accepted row its nonce names (SPEC 13.15).
        `$JS.API.DIRECT.GET.KV_${acceptedBucket(space)}.$KV.${acceptedBucket(space)}.>`,
        `$JS.API.STREAM.INFO.${ISSUED}`,
        `$JS.API.STREAM.INFO.KV_${acceptedBucket(space)}`,
        `$JS.API.STREAM.MSG.GET.${ISSUED}`,
        // Source liveness: the leader-served point read of a static incarnation's issuance gate on
        // the auth store (body-selected, stream-wide: the same named residual every records
        // reader accepts). No auth-store WRITE of any shape.
        `$JS.API.STREAM.MSG.GET.KV_${epAuthBucket(space)}`,
        `$JS.API.CONSUMER.CREATE.${ISSUED}.>`,
        `$JS.API.CONSUMER.INFO.${ISSUED}.>`,
        `$JS.API.CONSUMER.DELETE.${ISSUED}.>`,
        "$JS.FC.>",
      ],
    },
    sub: { allow: [`_INBOX_${pr.connId}.>`] },
  };
}

/** The REGISTRY READER permission set (SPEC 13.20). The evidence store's `STREAM.MSG.GET` is
 *  stream-scoped because the key rides the request body: NAMED RESIDUAL, the holder can read every
 *  recorded ceiling in the space, so this credential is never a peer's. The records reads are the
 *  key list and the per-key `svc` spec/status Direct Get, no stream-wide read; contract artifacts
 *  ride the agent's subject-scoped fetch row. No write of any shape. */
export function registryReaderPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  const ISSUED = `KV_${issuedBucket(space)}`;
  const REC = recordsBucket(space);
  return {
    pub: {
      allow: [
        `$JS.API.STREAM.INFO.${ISSUED}`,
        `$JS.API.STREAM.MSG.GET.${ISSUED}`,
        `$JS.API.STREAM.INFO.KV_${REC}`,
        `$JS.API.DIRECT.GET.KV_${REC}.$KV.${REC}.svc.*.*.spec`,
        `$JS.API.DIRECT.GET.KV_${REC}.$KV.${REC}.svc.*.*.status`,
        `$JS.API.DIRECT.GET.${epcStreamName(space)}.${spacePrefix(space)}.epc.>`,
      ],
    },
    sub: { allow: [`_INBOX_${pr.connId}.>`] },
  };
}

/** The RUN ADMITTER permission set (SPEC 14.8): exactly ONE run's admission record and
 *  revocation marker on the admission store (both create-only), plus the leader-served read the
 *  create-before-read and the marker's own re-read ride. No other run's keys, no other store. */
export function runAdmitterPermissions(space: string, pr: MintPrincipal, pin: NonNullable<MintOpts["runAdmitter"]>): Record<string, unknown> {
  const bucket = admissionBucket(space);
  return {
    pub: {
      allow: [
        "$JS.API.INFO",
        `$KV.${bucket}.${admissionKey(pin.endpoint, pin.runId)}`,
        `$KV.${bucket}.${revocationKey(pin.endpoint, pin.runId)}`,
        ...(pin.submission ? [`$KV.${bucket}.${runSubmissionKey(pin.endpoint, pin.submission.caller, pin.submission.id)}`] : []),
        `$JS.API.STREAM.MSG.GET.KV_${bucket}`,
      ],
    },
    sub: { allow: [`_INBOX_${pr.connId}.>`] },
  };
}

/** The ephemeral, LIFECYCLE-PINNED §13.1 state-write permission set for the STATIC manager's
 *  lifecycle executor. One credential per lifecycle OPERATION (activation, terminal,
 *  renewal ledger append): every grant names exactly ONE incarnation's keys — the alias head,
 *  the uid reservation, the manager slot row, the issuance gate, and the `cred.<uid>.>` ledger
 *  family — so a leaked executor cred can move one incarnation's state machine and nothing else.
 *
 *  Reads: records reads ride the keyed Direct Get form (the key is ON the subject, so the read
 *  grant stays key-pinned); the auth store is leader-served (`allow_direct=false`), so its reads
 *  are body-selected `STREAM.MSG.GET` — stream-scoped, NOT key-scoped (the requested key rides
 *  the PAYLOAD, which a subject grant cannot see). NAMED RESIDUAL: for its one-shot lifetime the
 *  executor can READ (never write) other rows in the auth store. */
export function lifecycleExecutorPermissions(
  space: string,
  pr: MintPrincipal,
  pin: { owner: string; actor: string; lifecycleUid: string; alias: string },
): Record<string, unknown> {
  const REC = recordsBucket(space), AUTH = epAuthBucket(space);
  // ALL keys DERIVED here from the pin coordinates — the slot key is `staticSlotKey(owner, alias)`,
  // NOT a caller-supplied literal, so a mis-constructed pin can only ever name ONE coherent
  // incarnation's rows (guard the core: the profile enforces the "one incarnation" promise, it
  // does not merely assert it). The builders throw on any non-KV-safe segment.
  const recordKeys = [
    lifecycleHeadKey(pin.owner, pin.actor), uidReservationKey(pin.lifecycleUid), staticSlotKey(pin.owner, pin.alias),
    recordSpecKey(RECORD_KINDS.lifecycle, [pin.owner, pin.actor, pin.lifecycleUid]),
  ];
  return {
    pub: {
      allow: [
        "$JS.API.INFO",
        // Records-store CAS writes — the value-publish carries the key on the subject, so each
        // grant names exactly one of this incarnation's keys.
        ...recordKeys.map((k) => `$KV.${REC}.${k}`),
        // Auth-store CAS writes — this incarnation's gate + its cred-ledger family (renewals
        // append rows here; the terminal's revoke CASes them).
        `$KV.${AUTH}.${issuanceGateKey(pin.lifecycleUid)}`,
        `$KV.${AUTH}.cred.${pin.lifecycleUid}.>`,
        // Keyed Direct Get reads of the same records keys (key-pinned) for direct-aware read
        // paths, PLUS the leader-served `STREAM.MSG.GET` the lazily-bound KV client actually
        // uses — stream-scoped, NOT key-scoped (the requested key rides the PAYLOAD, which a
        // subject grant cannot see). NAMED RESIDUAL: for its one-shot lifetime the executor can
        // READ (never write) other rows in BOTH authority stores — lifecycle metadata, no
        // secrets; every WRITE stays key-pinned above.
        ...recordKeys.map((k) => `$JS.API.DIRECT.GET.KV_${REC}.$KV.${REC}.${k}`),
        `$JS.API.STREAM.MSG.GET.KV_${REC}`,
        `$JS.API.STREAM.MSG.GET.KV_${AUTH}`,
      ],
    },
    sub: { allow: [`_INBOX_${pr.connId}.>`] },
  };
}

/** The SELF-MEDIATED goal-writer profile (spawn-as-action): exactly
 *  {@link goalWriterGrants} for ITS endpoint — the goal bind + terminal facts, the goal-record KV
 *  writes, and the leader-served fencing reads — plus the connection-scoped reply inbox. Disjoint
 *  from the endpoint's serve credential: a serve connection carries none of these rows, so it
 *  is broker-denied every goal write. */
export function goalWriterPermissions(space: string, pr: MintPrincipal, pin: { endpoint: string }): Record<string, unknown> {
  const g = goalWriterGrants(space, pin.endpoint, pr.connId);
  return { pub: { allow: g.publish }, sub: { allow: g.subscribe } };
}

/** The console/CLI per-session CALLER rows: RAILS-ONLY for ONE §13.6 session — pub the
 *  session's epoch-pinned `in` rail, sub its `out` rail plus the caller's own reply inbox, and
 *  NOTHING else. Deliberately NO KV, NO JetStream API, NO store: the caller drives the terminal over
 *  the two core-only eps subjects and never reads the session ledger, so there is no subject-blind
 *  store read to widen (SPEC §13.9). The endpoint+sessionId+epoch pin the EXACT pair, so a cred for
 *  session A authorizes nothing of session B (no wildcard). `epsSubject` validates every token, so a
 *  malformed coordinate refuses at the mint rather than emitting a broadened subject. */
export function sessionCallerPermissions(space: string, pr: MintPrincipal, pin: { endpoint: string; sessionId: string; epoch: number } | undefined): Record<string, unknown> {
  if (!pin) throw new Error('permissionsFor: "session-caller" requires opts.sessionCaller ({endpoint, sessionId, epoch}) - the ONE session\'s rails this cred may use');
  return {
    pub: { allow: [epsSubject(space, pin.endpoint, pin.sessionId, pin.epoch, "in")] },
    sub: { allow: [epsSubject(space, pin.endpoint, pin.sessionId, pin.epoch, "out"), `_INBOX_${pr.connId}.>`] },
  };
}

/** The own-DM reader rows (#4189): CONSUMER.INFO and MSG.NEXT on the principal's own
 *  lifecycle-keyed `dm_` durable, its `$JS.ACK` subtree, and the connection inbox. Nothing else:
 *  no publish of any message, no CONSUMER.CREATE (the durable is provisioned, never created), no
 *  `$JS.API.INFO`, no STREAM.INFO, no presence, channel, CHAT or `dlv_` row. It is exactly what
 *  `EndpointOptions.dmOnly` sends. */
export function dmReaderPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  if (!pr.lifecycleUid)
    throw new Error('permissionsFor(dm-reader): a lifecycleUid is required - the dm_ durable name is lifecycle-keyed (SPEC 13.1)');
  const DM = dmStream(space), dmD = dmDurable(pr.owner, pr.actor, assertLifecycleToken(pr.lifecycleUid));
  return {
    pub: { allow: [`$JS.API.CONSUMER.INFO.${DM}.${dmD}`, `$JS.API.CONSUMER.MSG.NEXT.${DM}.${dmD}`, `$JS.ACK.${DM}.${dmD}.>`] },
    sub: { allow: [`_INBOX_${pr.connId}.>`] },
  };
}

/** The manager's per-session SERVING rows: the EXACT mirror of
 *  {@link sessionCallerPermissions} with the directions swapped — sub the ONE session's epoch-pinned
 *  `in` rail (caller→serving), pub its `out` rail (serving→caller), plus the connection-scoped reply
 *  inbox, and NOTHING else. Same asymmetry §13.6 states: "the caller publishes `in` and subscribes
 *  `out`; the serving instance the reverse".
 *
 *  Deliberately NO KV and NO JetStream API — not even the session ledger. The serving side drives
 *  bytes; the ledger is the standing `session-ledger` credential's, on a different connection. That
 *  separation is what lets this credential be one-shot and die with its session while the durable
 *  revocation authority outlives it (§13.6).
 *
 *  This REPLACES a standing writer that held `eps.<endpoint>.*.<epoch>.{in,out}` and so could read
 *  and write every live session's bytes at its epoch. The pin makes a credential for session A
 *  authorize nothing of session B, and `epsSubject` validates every token, so a malformed
 *  coordinate refuses at the mint rather than emitting a broadened subject. */
export function sessionServingPermissions(space: string, pr: MintPrincipal, pin: { endpoint: string; sessionId: string; epoch: number } | undefined): Record<string, unknown> {
  if (!pin) throw new Error('permissionsFor: "session-serving" requires opts.sessionServing ({endpoint, sessionId, epoch}) - the ONE session\'s rails this cred may serve');
  return {
    pub: { allow: [epsSubject(space, pin.endpoint, pin.sessionId, pin.epoch, "out")] },
    sub: { allow: [epsSubject(space, pin.endpoint, pin.sessionId, pin.epoch, "in"), `_INBOX_${pr.connId}.>`] },
  };
}

/** The manager's SESSION-LEDGER rows: the DEDICATED sessions-bucket rows and nothing
 *  else — no session rail of any shape. Needs no pin: the grant carries no endpoint, epoch, or
 *  session component, because §13.6's durable revocation authority is per-space, not per-session
 *  (it must still be able to resolve and revoke a row after the endpoint that served it is gone).
 *  {@link sessionLedgerGrants} carries the row rationale, the §13.9 subject-blindness confinement,
 *  and the named `session.*` breadth residual. */
export function sessionLedgerPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  const g = sessionLedgerGrants(space, pr.connId);
  return { pub: { allow: g.publish }, sub: { allow: g.subscribe } };
}

/** The ephemeral, ENDPOINT-INSTANCE-PINNED endpoint-serve executor permission set:
 *  the manager mints this per registration/serve-mint op and drives the endpoint
 *  registration barrier's `epgate` CAS + the mint fence's `epcred` stage/revoke THROUGH it — never
 *  its standing seed/supervisor connection. Every
 *  WRITE is key-pinned to exactly ONE (endpoint, instanceId): the gate `epgate.<ep>.<iid>`, its
 *  serving ledger family `epcred.<ep>.<iid>.>`, and the registration's two records keys (the
 *  instance's `svc` spec + the endpoint's governance head — `registerServiceInstance` drives the
 *  slot-take/promote over this same connection). A leaked/mis-constructed executor can move exactly
 *  one endpoint instance's serve state and nothing else. The auth store is `allow_direct=false`, so
 *  reads are leader-served `STREAM.MSG.GET` (stream-scoped, NOT key-scoped — the key rides the
 *  payload); enumeration of the epcred family rides an ordered `keys()` consumer. NAMED RESIDUAL:
 *  for its one-shot lifetime the executor can READ (never write) other auth rows — endpoint/
 *  credential metadata, no bearer bytes; every WRITE stays key-pinned. */
export function endpointServeExecutorPermissions(
  space: string,
  pr: MintPrincipal,
  pin: { endpoint: string; instanceId: string },
): Record<string, unknown> {
  const AUTH = epAuthBucket(space), REC = recordsBucket(space);
  // DERIVED from (endpoint, instanceId) via the core builders — never a caller literal.
  const gateKey = epgateKey(pin.endpoint, pin.instanceId);
  const credPrefix = epcredFamilyPrefix(pin.endpoint, pin.instanceId);
  const repairKey = eprepairKey(pin.endpoint, pin.instanceId);
  // The registration writes this ONE instance's spec key plus the endpoint's governance head
  // (`registerServiceInstance` PHASE 1/3b: the slot-take + promote ride the SAME executor), and this
  // instance's own svc STATUS key (the manager writes its CONVERGED `ready` status so it
  // is a §13.5 scatter member — `freezeExpectedSet` requires a status caught up to the current
  // registration; the write is epoch-fenced by `writeServiceStatus`).
  const recordKeys = [
    recordSpecKey(RECORD_KINDS.svc, [pin.endpoint, assertLifecycleToken(pin.instanceId, "instanceId")]),
    recordStatusKey(RECORD_KINDS.svc, [pin.endpoint, assertLifecycleToken(pin.instanceId, "instanceId")]),
    recordAtomicKey(GOVERN_HEAD, [pin.endpoint]),
  ];
  return {
    pub: {
      allow: [
        "$JS.API.INFO",
        // The key-pinned WRITE grants: the gate (provision create + barrier freeze/reopen CAS),
        // the serving ledger family (mint-fence stage + barrier revoke), and the registration's
        // two records-store keys (spec CAS + governance slot/promote). The value-publish carries
        // the key on the subject, so each grant names exactly this instance's keys.
        `$KV.${AUTH}.${gateKey}`,
        `$KV.${AUTH}.${repairKey}`,
        `$KV.${AUTH}.${credPrefix}.>`,
        ...recordKeys.map((k) => `$KV.${REC}.${k}`),
        // §13.7 contract-artifact publication: the registration publishes the
        // endpoint's cluster document, closure manifests, and schema roots to the EPC store so
        // callers can fetch-verify-compile the registered digests. A digest subject is a SINGLE
        // hex token (`epc.<64hex>`), so the grant is the single-token `epc.*` form (matching
        // `contractPublisherGrants`), never the multi-token `epc.>`. Digest subjects cannot be
        // key-pinned pre-mint; the store's SHAPE is the defense (ensureContractStore): a digest
        // subject holds exactly one broker-immutable message (max_msgs_per_subject:1 +
        // discard-new-per-subject REJECTS a second publish regardless of the create-only header, so
        // a grant-holder CANNOT append a shadow over a published artifact), deny_delete/deny_purge
        // keep that message, and content addressing (verify-on-read, create-only-winner fallback)
        // makes a wrong-subject write unservable. NAMED RESIDUAL: for its one-shot lifetime the
        // executor can publish NEW digest-addressed artifacts at previously-unused subjects (a
        // bounded storage flood; unreferenced artifacts carry no authority) — it can NOT overwrite,
        // shadow, or replace an existing one.
        `${spacePrefix(space)}.epc.*`,
        // The lost-CAS verify-read `publishContractArtifact` runs when a re-publish (every re-up /
        // restart against an existing store) loses the create-only CAS: it fetches the recorded
        // artifact to confirm the idempotent no-op. BOTH Direct Get forms — the subject-scoped
        // `last_by_subj` (the fast path) and the bare stream form (the create-only-winner
        // `next_by_subj` fallback) — so the publish path never dies on a broker denial regardless
        // of stream config. Without this the manager exits on its SECOND boot (the tester's
        // upgrade-path regression). Reads public content-addressed artifacts only.
        `$JS.API.DIRECT.GET.${epcStreamName(space)}.${spacePrefix(space)}.epc.>`,
        `$JS.API.DIRECT.GET.${epcStreamName(space)}`,
        // Leader-served reads (the auth store is allow_direct=false): stream-scoped MSG.GET (the
        // barrier/fence read the gate + each epcred row), plus the ordered consumer the epcred
        // `keys()` enumeration binds. The records store IS direct-servable, so its reads add the
        // key-pinned DIRECT.GET forms beside the leader-served fallback. NAMED RESIDUAL: reads
        // any row in both stores for its one-shot lifetime (metadata, no bearer bytes).
        `$JS.API.STREAM.MSG.GET.KV_${AUTH}`,
        `$JS.API.CONSUMER.CREATE.KV_${AUTH}.>`,
        `$JS.API.CONSUMER.INFO.KV_${AUTH}.>`,
        `$JS.API.CONSUMER.DELETE.KV_${AUTH}.>`,
        // Ordered value scans acknowledge flow control only for this authorized auth stream.
        `$JS.FC.KV_${AUTH}.>`,
        ...recordKeys.map((k) => `$JS.API.DIRECT.GET.KV_${REC}.$KV.${REC}.${k}`),
        `$JS.API.STREAM.MSG.GET.KV_${REC}`,
      ],
    },
    sub: { allow: [`_INBOX_${pr.connId}.>`] },
  };
}

/** The ephemeral, TARGET-PINNED DEPROVISIONER permission set — the teardown counterpart
 *  to {@link provisionerPermissions}, minted per departed agent inside the manager's `deprovision` tail
 *  (`withProvisioner`-style: a fresh scoped cred per teardown is cheap). It deletes exactly the
 *  dev/static principal footprint the provisioner created for ONE agent: that agent's two bind-only
 *  durables (`dm_local-<actor>`, `dlv_local-<actor>`) and its read-ACL row — pinned BY NAME to the target
 *  actor under {@link DEV_OWNER}, so a leaked deprovisioner cred can tear down that one already-dead
 *  agent and NOTHING else.
 *
 *  Deliberately NOT granted (least-privilege / correctness): the role-SHARED `svc_<role>` TASK durable
 *  (one consumer for ALL agents of a role — deleting it on one agent's exit would break its siblings; it
 *  lives until space teardown), any peer's `dm_`/`dlv_`/ACL (the grants are target-name-pinned, never
 *  `.>`), any MSG.NEXT/MSG.GET/ACK (it deletes mailboxes, never reads a body), and any STREAM
 *  DELETE/PURGE (it removes per-agent consumers, never a stream). The `chathist_<id>` history consumers
 *  need no grant here — they are ephemeral (`mem_storage`, 30s inactive threshold) and agent-deleted
 *  after each read, so they self-clean on the agent's disconnect.
 *
 *  Blast radius of a leaked cred (minted for target T): it can delete T's `dm_local-<T>`/`dlv_local-<T>`
 *  durables + purge T's ACL row — a denial-of-DELIVERY for T (broken DM/DLV bind + the reader DEFERs on
 *  the absent ACL) if fired while T is still alive. It CANNOT read T's bodies, impersonate T, reach any peer, or
 *  delete a stream — and it is ephemeral (one per-exit teardown, minted then dropped). Contained and
 *  recoverable (re-provision T). */
export function deprovisionerPermissions(space: string, pr: MintPrincipal, deprovisionTarget: DeprovisionTarget): Record<string, unknown> {
  const DM = dmStream(space), DLV = dlvStream(space);
  const t = deprovisionTargetPrincipal(deprovisionTarget);
  const target = principalKey(t.owner, t.actor);
  return {
    pub: {
      allow: [
        "$JS.API.INFO", // jetstreamManager bootstrap
        // Delete the target LIFECYCLE's two bind-only durables BY EXACT NAME — no `.>`, no cross-agent
        // reach, and no reach into a same-alias successor: its names carry a different uid, so a
        // replayed teardown is broker-DENIED there (SPEC 13.1 / Appendix "deprovisioner").
        `$JS.API.CONSUMER.DELETE.${DM}.${dmDurable(t.owner, t.actor, t.lifecycleUid)}`,
        `$JS.API.CONSUMER.DELETE.${DLV}.${dlvDurable(t.owner, t.actor, t.lifecycleUid)}`,
        `$JS.API.CONSUMER.INFO.${DM}.${dmDurable(t.owner, t.actor, t.lifecycleUid)}`,
        `$JS.API.CONSUMER.INFO.${DLV}.${dlvDurable(t.owner, t.actor, t.lifecycleUid)}`,
        // Purge the target lifecycle's read-ACL row (own-target exact key only — the reader then treats
        // it as an unknown owner). `kvm.open` binds the pre-created bucket; the purge rides
        // `$KV.<aclBucket>.<key>`.
        `$JS.API.STREAM.INFO.KV_${aclBucket(space)}`,
        `$JS.API.DIRECT.GET.KV_${aclBucket(space)}.$KV.${aclBucket(space)}.${aclKey(target.key, t.lifecycleUid)}`,
        `$KV.${aclBucket(space)}.${aclKey(target.key, t.lifecycleUid)}`,
        // Purge the target lifecycle's durable membership rows, one exact key per named concrete
        // channel or family (a family's `>` is `=` in the key, so no grant here is a wildcard). The key
        // embeds the uid, so a successor's row is unreachable by name.
        ...(t.memberChannels.length > 0 ? [`$JS.API.STREAM.INFO.KV_${membersBucket(space)}`] : []),
        ...t.memberChannels.map((ch) => `$JS.API.DIRECT.GET.KV_${membersBucket(space)}.$KV.${membersBucket(space)}.${memberKey(ch, target.key, t.lifecycleUid)}`),
        ...t.memberChannels.map((ch) => `$KV.${membersBucket(space)}.${memberKey(ch, target.key, t.lifecycleUid)}`),
      ],
    },
    // Replies only: the CONSUMER.DELETE PubAcks + KV purge ack land on the per-connection inbox. NO chat/DM/ctl
    // subscription — the deprovisioner serves nothing and reads no feed.
    sub: { allow: [`_INBOX_${pr.connId}.>`] },
  };
}

/** The scoped `delivery` daemon permission set (server-side Plane-3 infra; NEVER allow-all, never
 *  minted for an agent — `cotal mint` excludes it, like `manager`). Least-privilege: exactly what the
 *  fan-out writer + trusted reader + activation catch-up + membership/ACL reads + members-KV writes +
 *  the lease + the `ctl.delivery` control service touch. `sub.allow` is the per-identity inbox (all JS
 *  pull delivery / KV-watch / request replies land there) PLUS the `ctl.delivery` control subtree it
 *  serves; ALL stream/KV reads ride the JS API (publishes), so there is NO native `chat`/`dinbox`/`dlv`
 *  subscription — a leaked cred can't natively sniff the mixed pre-auth store. Honest blast radius
 *  (delivery-daemon.mdx): it can write any owner's `dlv` (the post-auth store agents trust); the future
 *  fan-out/reader cred split bounds that. */
export function deliveryPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  const p = spacePrefix(space);
  const CHAT = chatStream(space), INBOX = inboxStream(space), DLV = dlvStream(space);
  const PKV = `KV_${presenceBucket(space)}`, CHKV = `KV_${channelBucket(space)}`;
  const MKV = `KV_${membersBucket(space)}`, AKV = `KV_${aclBucket(space)}`, DKV = `KV_${deliveryBucket(space)}`;
  const TASK = taskStream(space), AKVR = `KV_${anycastBucket(space)}`;
  const kvRead = (bucket: string) => [
    `$JS.API.STREAM.INFO.${bucket}`,
    `$JS.API.STREAM.MSG.GET.${bucket}`, // kv.get
    `$JS.API.CONSUMER.CREATE.${bucket}.>`, // kv.watch ordered consumer
    `$JS.API.CONSUMER.INFO.${bucket}.>`,
    `$JS.API.CONSUMER.DELETE.${bucket}.>`,
  ];
  const pub = [
    "$JS.API.INFO",
    `$JS.API.STREAM.INFO.${CHAT}`, `$JS.API.STREAM.INFO.${INBOX}`, `$JS.API.STREAM.INFO.${DLV}`,
    // Fan-out durable + activation-catch-up ephemerals live on CHAT — the daemon legitimately reads ALL
    // chat (the fan-out consumes the whole stream), so a stream-wide CHAT consumer grant is no
    // escalation. The catch-up ephemeral names (`cu_<owner>_<gen>`) are dynamic, so they can't be
    // name-pinned; CHAT-wide is correct here.
    //
    // BOTH forms, and the bare one is not redundant: a create carrying `filter_subjects` cannot encode
    // its filter in the subject, so the client publishes to the BARE `…CREATE.<CHAT>` while a named
    // consumer goes to the `.>` form. The mediated history read (`readHistory`) builds exactly that
    // multi-filter ephemeral, and with only the `.>` grant it fails with a Permissions Violation on the
    // bare subject — measured, not predicted. The observer profile already carries both for the same
    // reason. Grants the daemon nothing new in substance: it may already create any named consumer on
    // this stream and already reads all of it.
    `$JS.API.CONSUMER.CREATE.${CHAT}`,
    `$JS.API.CONSUMER.CREATE.${CHAT}.>`,
    // `confirm-attach` (A1, S3) reads the ONE chat entry the caller names by its acknowledged sequence,
    // to check the caller published the artifact reference it confirms. A strict subset of the consume
    // power above: the daemon already reads every chat entry through the fan-out. It sits behind one
    // sealed helper in the delivery daemon that returns the subject and parts only.
    `$JS.API.STREAM.MSG.GET.${CHAT}`,
    `$JS.API.CONSUMER.DURABLE.CREATE.${CHAT}.>`,
    `$JS.API.CONSUMER.INFO.${CHAT}.>`,
    `$JS.API.CONSUMER.MSG.NEXT.${CHAT}.>`,
    `$JS.API.CONSUMER.DELETE.${CHAT}.>`,
    `$JS.ACK.${CHAT}.>`,
    // Trusted reader on INBOX — NAME-PINNED to the single `reader` durable (the meaningful confinement:
    // no arbitrary INBOX consumer create against the mixed pre-auth store).
    `$JS.API.CONSUMER.CREATE.${INBOX}.${INBOX_READER_DURABLE}.>`,
    `$JS.API.CONSUMER.DURABLE.CREATE.${INBOX}.${INBOX_READER_DURABLE}`,
    `$JS.API.CONSUMER.INFO.${INBOX}.${INBOX_READER_DURABLE}`,
    `$JS.API.CONSUMER.MSG.NEXT.${INBOX}.${INBOX_READER_DURABLE}`,
    `$JS.API.CONSUMER.DELETE.${INBOX}.${INBOX_READER_DURABLE}`,
    `$JS.ACK.${INBOX}.${INBOX_READER_DURABLE}.>`,
    // The reader removes an entry addressed to a retired lifecycle (its ACL row is tombstoned), so the
    // store does not keep what no reader can ever deliver. Nothing new in substance: the reader can
    // already ack any INBOX entry away.
    `$JS.API.STREAM.MSG.DELETE.${INBOX}`,
    "$JS.FC.>", // ordered-consumer flow control
    // Reads: presence (@mention resolve) + channel registry (delivery class) + members + ACL (re-auth).
    ...kvRead(PKV), ...kvRead(CHKV), ...kvRead(MKV), ...kvRead(AKV),
    // Members-KV WRITE — the daemon is the durable-membership authority (join/leave/activate/catch-up).
    `$KV.${membersBucket(space)}.>`,
    // Delivery lease/readiness KV: read the bucket (renew CAS) + write ONLY lease keys. The
    // CONSUMER.* rows are kv.watch's ordered consumer for the lease-loss watch (#1596) — the same
    // read axis the other kvRead buckets carry, on the bucket this cred already reads point-wise:
    // a watch is a READ of the row's changes, never a write. CONSUMER.DELETE rides with it for the
    // same reason it does on every watched bucket: an ordered consumer rebuilds by deleting its
    // predecessor, and a refused delete strands consumers on every rebuild (measured on the
    // presence bucket; the comment there carries the full story).
    `$JS.API.STREAM.INFO.${DKV}`, `$JS.API.STREAM.MSG.GET.${DKV}`,
    `$JS.API.CONSUMER.CREATE.${DKV}.>`,
    `$JS.API.CONSUMER.INFO.${DKV}.>`,
    `$JS.API.CONSUMER.DELETE.${DKV}.>`,
    `$KV.${deliveryBucket(space)}.lease.*`,
    // The timer writer (SPEC 13.2): the daemon hosts the pump that turns `.schedule` requests into
    // the authoritative `.armed` publishes — without it no workflow pause on the space ever
    // expires. Its consumer rows are the shared timer-writer grant set; both create forms for the
    // same reason CHAT carries both (the client picks by whether the create embeds a filter). The
    // arm itself needs the fence's two leader reads — the `.armed` head on EPT and the checkpoint
    // status on the records KV — and exactly ONE publish: the `.armed` subject. Never `.fire`
    // (the broker's own schedule delivery) and never `.schedule` (it consumes those).
    ...timerWriterGrants(space),
    `$JS.API.CONSUMER.DURABLE.CREATE.${eptReqStreamName(space)}.${timerWriterDurable(space)}`,
    `$JS.API.STREAM.INFO.${eptReqStreamName(space)}`,
    `$JS.API.STREAM.INFO.${eptStreamName(space)}`,
    `$JS.API.STREAM.MSG.GET.${eptStreamName(space)}`,
    `$JS.API.STREAM.INFO.KV_${recordsBucket(space)}`,
    `$JS.API.STREAM.MSG.GET.KV_${recordsBucket(space)}`,
    // A delivery-served endpoint's bind (the `artifacts` service): before it serves on a credential
    // the daemon re-proves the instance's issuance gate with two leader-served point reads of the
    // `epgate` key. Read-only and body-selected: the same named residual the auth profile accepts for
    // its gate read above. No auth-store write of any shape.
    `$JS.API.STREAM.INFO.KV_${epAuthBucket(space)}`,
    `$JS.API.STREAM.MSG.GET.KV_${epAuthBucket(space)}`,
    `${p}.ept.*.*.*.*.armed`,
    // Plane-3 data writes: dinbox (fan-out target) + dlv (post-auth handoff) for ANY lifecycle — the
    // identity slots widen to `.*.*.*` (owner+actor+lifecycleUid: dinbox/dlv are per-LIFECYCLE now,
    // SPEC 13.1; NATS subject arity is exact, so the old two-token form is broker-denied on every
    // three-token write).
    `${p}.dinbox.*.*.*`, `${p}.dlv.*.*.*`,
    // ctl.delivery control REPLIES ONLY (requests arrive on the sub below; the daemon only ever
    // m.respond()s to a requester's reply subject `ctl.delivery.<owner>.<actor>.reply.<n>`). Scoped to
    // the `.reply.>` leaf so the daemon can't publish to the request subjects themselves — tighter than a
    // blanket `ctl.delivery.>` (fact-check precision, review panel). The caller slots widened to `.*.*`.
    `${p}.ctl.delivery.*.*.reply.>`,
    // The privileged delivery-admin rail: same replies-only shape. Requests reach the
    // daemon on the sub below; only the supervisor cred can PUBLISH them (nats-server is the boundary).
    `${p}.ctl.delivery-admin.*.*.reply.>`,
    // LIVENESS REPLIES for the DELIVERY plane (#1577) — same replies-only shape as the two control
    // rails above. The daemon is the only process that can grade its own responder honestly: it
    // knows its own incarnation, so a predecessor's `ready:true` corpse in the lease classifies as
    // stale rather than as its own health. Bounded to the `.reply.` leaf, so it cannot publish to
    // the request subjects and forge a probe from a peer.
    livenessReplyGrant(space, "delivery"),
    // Anycast request status (SPEC §8.1). The daemon reads a request at the seq a take, status or
    // cancel names, and deletes one its sender cancelled while it waited: a read of every request
    // body in the space and a delete of any of them, both bounded by the take record. It owns the
    // records bucket, creating it on a mesh that predates it, and lists it for the maintenance pass.
    // It DMs a request's sender from its own principal only, and answers takes on their bounded
    // reply leaf.
    `$JS.API.STREAM.INFO.${TASK}`,
    `$JS.API.STREAM.MSG.GET.${TASK}`,
    `$JS.API.STREAM.MSG.DELETE.${TASK}`,
    `$JS.API.STREAM.CREATE.${AKVR}`,
    ...kvRead(AKVR),
    `$JS.API.DIRECT.GET.${AKVR}.>`,
    `$KV.${anycastBucket(space)}.>`,
    unicastSubject(space, "*", "*", pr.owner, pr.actor), // inst.*.*.<o>.<a>: a notice to a sender, as itself
    takeReplyGrant(space),
  ];
  const sub = [
    `_INBOX_${pr.connId}.>`,
    takeServeFilter(space), // serve anycast takes (queue-grouped; role + owner+actor caller slots)
    `${p}.ctl.delivery.*.*`, // serve the delivery control service (queue-grouped; owner+actor caller slots)
    `${p}.ctl.delivery-admin.*.*`, // serve the privileged admin rail (reloadCreds; eviction executor next)
    // Serve the delivery plane's liveness probe (#1577), queue-grouped. Presence-only: the handler
    // reduces the lease row to one enum before replying, so this subscription lets the daemon ANSWER
    // a peer without any peer gaining a read of the lease.
    livenessServeFilter(space, "delivery"),
  ];
  return { pub: { allow: pub }, sub: { allow: sub } };
}

/** The scoped DATA-account `membership-rw` permission set (the graph feed's conn B; NEVER allow-all,
 *  never minted for an agent — `cotal mint` excludes it, like `manager`/`delivery`). Least-privilege:
 *  READ the members registry (the durable arm of the merge) + READ/WRITE the one derived membership
 *  bucket, and nothing else. It holds NO chat/DM/anycast/ctl grant and never touches `$SYS` (account
 *  isolation keeps the system-account CONNZ read on the SEPARATE conn-A cred). A leaked conn-B cred can
 *  read durable-membership records and forge the feed — bounded to "dashboard integrity" by the
 *  display-only invariant; it reads no message bodies and admins nothing. */
export function membershipRwPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  const MKV = `KV_${membersBucket(space)}`; // durable arm — read
  const MEMKV = `KV_${membershipBucket(space)}`; // derived feed — read (diff/prune) + write
  const kvRead = (bucket: string) => [
    `$JS.API.STREAM.INFO.${bucket}`,
    `$JS.API.STREAM.MSG.GET.${bucket}`, // kv.get
    `$JS.API.CONSUMER.CREATE.${bucket}.>`, // kv.keys()/kv.watch ordered consumer
    `$JS.API.CONSUMER.INFO.${bucket}.>`,
    `$JS.API.CONSUMER.DELETE.${bucket}.>`,
  ];
  const pub = [
    "$JS.API.INFO",
    ...kvRead(MKV),
    ...kvRead(MEMKV),
    `$KV.${membershipBucket(space)}.>`, // write derived feed (kv.put + kv.delete)
    "$JS.FC.>", // ordered-consumer flow control
  ];
  return { pub: { allow: pub }, sub: { allow: [`_INBOX_${pr.connId}.>`] } };
}

/** The scoped SYSTEM-account `membership-observer` permission set (the graph feed's conn A). An EXPLICIT
 *  block is MANDATORY: a system-account user with NO permissions block defaults to ALLOW-ALL = full
 *  `$SYS` = broker admin (verified — pre-flight spike + docs). Least-privilege allowlist:
 *   - **pub:** the account-scoped CONNZ request subject ONLY (not server-wide `PING.CONNZ`, not
 *     `REQ.SERVER.*`/`REQ.CLAIMS.*`).
 *   - **sub:** the scoped reply inbox (`<MEMBERSHIP_INBOX_PREFIX>.>`) + this ONE account's
 *     CONNECT/DISCONNECT events (re-poll triggers) — never `$SYS.ACCOUNT.*.…` (cross-tenant) nor
 *     `$SYS.ACCOUNT.<id>.>` (pulls in SUBSZ/JSZ/purge).
 *  No `$SYS.>` deny that would shadow the allows (deny-beats-allow). A leaked conn-A cred enumerates THIS
 *  account's connections (silent readers + nkeys) and can forge the feed; it reads no bodies, touches no
 *  other account, and admins no server. */
export function membershipObserverPermissions(accountId: string): Record<string, unknown> {
  return {
    pub: { allow: [connzRequestSubject(accountId)] },
    sub: {
      allow: [
        `${MEMBERSHIP_INBOX_PREFIX}.>`,
        accountConnectSubject(accountId),
        accountDisconnectSubject(accountId),
      ],
    },
  };
}

/** The KICK-ONLY connection-evictor permission set — a SYSTEM-account user that can do
 *  exactly ONE thing: `$SYS.REQ.SERVER.*.KICK` (disconnect a live client by cid). It CANNOT read
 *  CONNZ (discovery stays on the separate observer cred — never one broad sys user that both
 *  enumerates and kills), touch any other `$SYS` verb, or reach another account's data. A leaked
 *  evictor cred can DoS live connections on this broker (KICK is not account-scoped — the honest
 *  blast radius), which is why it is a HIGH-POWER standing credential: minted only at `up`,
 *  rate-limited + audited by its one caller (the delivery daemon), and its cid/server-id inputs come
 *  only from the observer's own CONNZ scan, never a user-facing API. Wildcard `*` over server id
 *  because a cluster's server ids aren't known at mint time; the scan pins the exact id per KICK. */
export function connectionEvictorPermissions(): Record<string, unknown> {
  return {
    pub: { allow: ["$SYS.REQ.SERVER.*.KICK"] },
    // Request/reply KICK replies land on the client's default inbox; no other subscription — it
    // serves nothing and reads no feed.
    sub: { allow: ["_INBOX.>"] },
  };
}
