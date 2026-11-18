import { spaceQuiescenceReaderGrants } from "./space-quiescence-resources.js";
import { eventPayloadReadSubjects, eventPayloadStream, eventPayloadSubject } from "./event-payloads.js";
import { TTL_RECONCILE_CANARY_KEY, ttlBuckets } from "./streams.js";
import { spaceDeletionStreams } from "./space-deletion-targets.js";
import { BROKER_USER_INFO_SUBJECT } from "./broker-identity.js";
import { spacePrefix, chatSubject, assertValidChannel, principalKey, deprovisionTargetPrincipal, assertInboxConnId, unicastSubject, anycastSubject, controlServiceSubject, CONTROL_DELIVERY, CONTROL_DELIVERY_ADMIN, artifactBucket, objectStoreStream, chatStream, dmStream, taskStream, dlvStream, inboxStream, chatHistDurable, historyReaderConsumer, HISTORY_READERS, dmDurable, taskDurable, dlvDurable, presenceBucket, presenceKeySubject, channelBucket, membersBucket, aclBucket, aclKey, memberKey, assertLifecycleToken, type DeprovisionTarget, membershipBucket, deliveryBucket, managerBucket, MANAGER_LEASE_KEY, MANAGER_RENEWAL_LEASE_KEY, connzRequestSubject, accountConnectSubject, accountDisconnectSubject, MEMBERSHIP_INBOX_PREFIX, INBOX_READER_DURABLE, livenessSubject, livenessServeFilter, livenessReplyGrant, isTransferStream, takeSubject, takeServeFilter, takeReplyGrant, anycastBucket } from "./subjects.js";
import { LIVENESS_PLANES } from "./liveness.js";
import { epCallerGrantRows, epServeGrantRows, epBaselineGrantRows, baselineCallerCapabilities, spawnCallerCapabilities, runCallerCapabilities, epRequestGrantRows, epPrincipalServeGrantRows, epPrincipalOwnerGrantRows, operatorInstrumentCapabilities, instanceOnlyManagerCapabilities, epDescribeAllGrantRow, BASELINE_LIFECYCLE_ENDPOINT, MANAGER_VITALS_COMMAND, MANAGER_VITALS_SCOPE, type EpCapability } from "./endpoint-grants.js";
import { assertServeGrantMintable } from "./endpoint-service.js";
import { effectsBindGrants, poolOwnerBindGrants, goalWriterGrants, sessionLedgerGrants, epAuthBucket, epcStreamName, endpointPlaneStreamNames, eptReqStreamName, eptStreamName, hardenedAuthorityStreamNames, timerWriterDurable, timerWriterGrants } from "./endpoint-binding.js";
import { epsSubject, epCallerReplyFilter, assertGeneration, isIssuedCaller, AUTH_ENDPOINT, EP_CMD_RETIRE_LIFECYCLE, type EpCaller, type IssuedCaller } from "./endpoint-subjects.js";
import { acceptedReadGrant, acceptedBucket, issuedBucket, issuedStoreStreamNames, type ListingBinding } from "./issued-authority.js";
import { REGISTRY_ENDPOINTS_GRANT } from "./registry-contract.js";
import { admissionBucket, admissionKey, revocationKey } from "./run-admission.js";
import { runSubmissionKey } from "./run-submission.js";
import { runDriverGrants, runMediatorGrants, runOperatorGrants } from "./run-driver-grants.js";
import { transferReaderGrants, transferWriterGrants } from "./transfer.js";
import { recordsBucket, recordSpecKey, recordStatusKey, recordAtomicKey, RECORD_KINDS, GOVERN_HEAD } from "./endpoint-records.js";
import { lifecycleHeadKey, uidReservationKey, issuanceGateKey, staticSlotKey, STATIC_SLOT_PREFIX, epgateKey, epcredFamilyPrefix, eprepairKey } from "./lifecycle-state.js";
import { environmentManagerPermissions, isEnvironmentManagerProfile } from "./environment-manager-grants.js";
import { backupProfilePermissions, restoreProfilePermissions, snapshotAckGrant } from "./backup.js";
import type { MintOpts, MintPrincipal } from "./provision-jwt.js";


/** Cred profiles. Each profile has an explicit permission arm and a lifetime classification. */
export type Profile =
  | "agent"
  | "manager-caller"
  | "observer"
  | "admin"
  | "supervisor"
  | "provisioner"
  | "deprovisioner" // ephemeral, TARGET-PINNED teardown of ONE departed agent's id-keyed footprint
  | "retirement-requester" // ephemeral request+reply on the auth-admin rail: asks the AUTH plane to retire a lifecycle; holds NO executing right
  | "lifecycle-executor" // ephemeral, LIFECYCLE-PINNED §13.1 state writes for the STATIC manager: exactly ONE incarnation's head/uid/gate/cred-row/slot keys
  | "endpoint-serve-executor" // ephemeral, ENDPOINT-INSTANCE-PINNED §13.1 endpoint-serve writes: exactly ONE (endpoint, instanceId)'s epgate + epcred family + eprepair cursor
  | "operator"
  | "purger"
  | "backup"
  | "restore"
  | "delivery"
  | "membership-rw"
  // The scoped CLI-surface profiles.
  | "space-quiescence-reader" // host-only one-shot idle-work census
  | "probe" // connect-only liveness/auth preflight
  | "channel-writer" // channel-registry value-writes (channels set/default, spawn -f seed)
  | "channel-purger" // channel-writer + STREAM.PURGE.CHAT (web channel-delete)
  | "teardown" // the space-wide STREAM.DELETE holder (down -f space teardown)
  // Explicit legacy derived-membership File -> Memory conversion. The only other membership
  // STREAM.DELETE holder, exact to that backing stream and never standing.
  | "membership-store-recreate"
  // Ephemeral, minted only by `up --recreate-issued-stores`: back up, then delete, the two
  // issued-authority stores of ONE space that predate bounded retention. The other STREAM.DELETE holder.
  | "issued-store-recreate"
  // Control callers — each holds its tier's `operatorInstrumentCapabilities` ep rows, and an any-mode
  // row IS cross-agent reach, so ps/start and stop/attach get SEPARATE, tier-scoped caller creds.
  | "control-caller-privileged" // ps/start → the privileged instrument set, no any-mode row (no cross-agent reach)
  | "control-caller-admin" // stop/attach → the admin instrument set, adding the any-mode rows + manager.admin (cross-agent power)
  | "deployer" // spawn -f deploy authority: reads + admin-control launch on one ephemeral cred
  // v0.4 control surface (SPEC §13.9): the per-instance endpoint serve credential — EXACTLY the
  // instance's registered rails + epoch-pinned egress, no agent baseline. Consumes only an
  // authorizeServeGrant-branded tuple; re-minted on takeover with the new epoch.
  | "endpoint-serve"
  // v0.4 action surface (spawn-as-action): the SELF-MEDIATED goal-writer for an endpoint
  // that accepts action goals inline on its ephemeral handler — EXACTLY that endpoint's goal
  // bind/terminal facts + goal-record writes ({@link goalWriterGrants}), a dedicated connection
  // disjoint from the serve credential. Standing, re-minted on renewal like the serve cred.
  | "goal-writer"
  // The console/CLI per-session CALLER credential: rails-only for ONE §13.6 session,
  // TTL-bound to it, never standing. Static = face-minted from the seed; user mode = the callout.
  | "session-caller"
  // A user's own-DM reader (#4189): bind, read and ack the ONE own `dm_` durable, and nothing
  // else. User mode mints it for the `dm-reader` exchange view, bound to the bearer's expiry.
  | "dm-reader"
  // The manager's SERVING per-session credential: the mirror of `session-caller` with
  // the directions swapped — sub the ONE session's `in` rail, pub its `out` rail, nothing else.
  // Minted at redemption, TTL-bound to the session, never renewed (SPEC 13.6: both sides hold only
  // redemption-minted per-session credentials; no standing EPS grant exists on either side).
  | "session-serving"
  // The manager's SESSION LEDGER: the standing connection owning the DEDICATED
  // sessions-bucket `session.<id>` rows — §13.6's "durable named authority that survives the
  // serving endpoint". Holds NO session rail of any shape; the rails are `session-serving`'s and
  // `session-caller`'s. Standing + re-minted for the SAME nkey on renewal (the goal-writer precedent).
  | "session-ledger"
  // Per-run journal/replay and own-record writes. Reads and effects live on the separate
  // trusted run-mediator connection. The manager renews both credentials for their own nkeys.
  | "run-driver"
  | "run-mediator" // trusted host effects and run-bound reads; never returned to the driver
  // The RUN OPERATOR (SPEC 14.3): the hosting manager's per-call credential for the run surface it
  // serves without driving: the `run-status` / `run-ps` reads (records walk, journal replay) and a
  // `run-answer` (the answer record, the checkpoint settle). Pinned to one endpoint; one-shot, and
  // never a standing connection, so the serve rails never hold a run's journal or records reach
  // ({@link runOperatorGrants}).
  | "run-operator"
  // v0.4 endpoint-registration eviction: the SCOPED delivery-admin caller a
  // registration barrier mints PER re-registration to verify-evict the SUPERSEDED serve family
  // before the epoch advances (SPEC 13.1 "old authority dies before new authority is visible").
  // EXACTLY the delivery-admin request+reply rail + $JS.API.INFO — no lease, presence, store read,
  // consumer, KV, or executing right; the daemon does the $SYS scan/KICK, the manager passes only
  // the predecessor's principal. Ephemeral (one re-registration's window), narrower than the
  // `supervisor` profile the auth barrier-evict reuses (its #30 residual, done here for the manager).
  | "endpoint-evictor"
  // The ISSUER (SPEC 13.15): the one-shot connection an issuing mint stages evidence over, writes
  // the accepted row with, and a lifecycle terminal retires issuances through. Writes the two
  // issued-authority stores and reads the evidence store leader-served; nothing else.
  | "issuer"
  // The REGISTRY READER (SPEC 13.20): the registry's reads and nothing else. The evidence store's
  // leader read, the records key list and `svc` spec/status rows, and contract artifacts by subject.
  | "registry-reader"
  // The RUN ADMITTER (SPEC 14.8): the one-shot connection a hosting manager admits a workflow run
  // over. Creates that ONE run's admission record and, later, its revocation marker. The driver
  // holds nothing on this store; the mediator reads it.
  | "run-admitter"
  // A carried resume's TRANSFER WRITER (docs/design/resume-transfer.md section 6): the operator's
  // per-call instrument for ONE object in ONE manager instance's transfer bucket, minted after the
  // CLI has hashed the transcript ({@link transferWriterGrants}).
  | "transfer-writer"
  // A manager instance's TRANSFER READER: one `transcript-receive` or sweep over its own transfer
  // bucket and no other ({@link transferReaderGrants}).
  | "transfer-reader"
  // Closed human-issued remote manager authority. Never exposed as a generic profile string: the
  // auth provider's typed manager-service protocol is the only mint door.
  | "remote-manager"
  // Fixed host-issued environment profiles, never exchange views or raw caller-selected grants.
  | "environment-bootstrap"
  | "environment-manager-supervisor"
  | "environment-manager-executor"
  | "environment-manager-goal-writer";

const ROLE_CAPABILITY = /^role:([A-Za-z0-9_-]+)$/;

/** The role a `role:<r>` capability token names, or `undefined` for any other token. */
export function capabilityRole(token: string): string | undefined {
  return ROLE_CAPABILITY.exec(token)?.[1];
}

/** The roles whose task queue an agent credential binds: its own role, and the role of each
 *  `role:<r>` token in its capabilities, which lets it hand that role on (SPEC 13.15). */
export function taskRoles(role: string | undefined, capabilities: readonly string[] | undefined): string[] {
  const roles = new Set<string>(role ? [role] : []);
  for (const token of capabilities ?? []) {
    const r = capabilityRole(token);
    if (r !== undefined) roles.add(r);
  }
  return [...roles];
}

/** The profiles whose credential carries caller rails, and can therefore be minted as an
 *  issuance (SPEC 13.15). Everything else is infrastructure or a one-shot with no rail to bind. */
const ISSUABLE_PROFILES: ReadonlySet<Profile> = new Set<Profile>(["agent", "control-caller-privileged", "control-caller-admin", "deployer", "manager-caller"]);
/** The operator instruments: the only profiles issued with no source and no presence key of their own. */
const INSTRUMENT_PROFILES: ReadonlySet<Profile> = new Set<Profile>(["control-caller-privileged", "control-caller-admin", "deployer"]);

/** Build the NATS user permission object for a profile: a default-deny allow-list scoped to
 *  exactly what each profile does. Every profile is now enumerated least-privilege — the former
 *  allow-all `manager` is gone (its roles split across supervisor/provisioner/operator/purger and the
 *  CLI-surface profiles). Subject/stream/durable names come from the shared builders so the ACLs
 *  can't drift from the wire layout.
 *
 *  PRINCIPAL-PARAMETERIZED + MODE-AGNOSTIC (owner+actor grammar): `pr` carries the owner+actor wire
 *  principal (chat/inst/svc/ctl subjects, per-agent durables, the presence key all scope to it) PLUS the
 *  connection nkey (`pr.connId`, which scopes the private reply inbox `_INBOX_<connId>`). Core does NOT
 *  fork on dev-vs-user — the composition root supplies the principal: the auth callout passes the derived
 *  owner + ledger actor + the per-connection ephemeral nkey; the static/dev mint passes
 *  `{owner:"local", actor:<id>, connId:<id>}` via {@link principalOf}. EXPORTED so the callout's injected
 *  `permissionsFor` hook can feed a validated principal straight into the same builder. */
export function permissionsFor(
  profile: Profile,
  space: string,
  pr: MintPrincipal,
  opts: MintOpts,
): Record<string, unknown> {
  // Guard the connId BEFORE any profile builds `_INBOX_<connId>.>`: in user mode connId is a client-
  // chosen nonce (untrusted), so a metacharacter here would escalate the inbox grant to every inbox.
  // Assert once, for all profiles (each early-returning profile builds its own inbox from pr.connId).
  assertInboxConnId(pr.connId);
  // Extraneous serve-artifact refusal, hoisted ABOVE the profile dispatch: every early-return
  // profile (delivery/supervisor/observer/...) must refuse it too, not just the agent tail, or a
  // misconfigured sensitive mint is silently masked (MintOpts: every other profile refuses it).
  // The "endpoint-serve" profile is excluded so its own arm below keeps the call-mintCreds redirect.
  if (opts.endpointServe && profile !== "endpoint-serve")
    throw new Error(`permissionsFor: endpointServe rides the dedicated "endpoint-serve" profile - a serve credential is per-instance authority (SPEC 13.9), never folded into a "${profile}" cred`);
  // An issuance binds CALLER rails (SPEC 13.15). A profile with no caller rail has nothing to bind
  // the generation to, so `issued` on it is a misconfiguration refused here, never dropped.
  if (opts.issued && !ISSUABLE_PROFILES.has(profile))
    throw new Error(`permissionsFor: opts.issued binds caller rails and "${profile}" holds none; only ${[...ISSUABLE_PROFILES].join(", ")} mint issued authority (SPEC 13.15)`);
  if (opts.listing && profile !== "agent" && profile !== "manager-caller")
    throw new Error(`permissionsFor: a listing generation rides the agent and manager-caller views only, not "${profile}" (SPEC 13.15)`);
  if (opts.listing && opts.issued)
    throw new Error("permissionsFor: an issued credential lists under its own generation; a listing generation beside it is refused (SPEC 13.15)");
  if (opts.ledgerKind !== undefined) {
    if (profile !== "agent")
      throw new Error(`permissionsFor: ledgerKind marks an agent-profile mint of a ledger row, not "${profile}" (SPEC 13.21)`);
    // Only the auth callout reads a row's kind from the ledger, and only the callout sets a
    // connection's reader id. A static mint, whose connection is its own nkey, carries no kind.
    if (pr.readerId === undefined)
      throw new Error("permissionsFor: a static mint carries no ledger kind; only the auth callout marks a mint with the kind of the ledger row it read (SPEC 13.21)");
    if (opts.ledgerKind !== "interactive" && opts.ledgerKind !== "managed-agent")
      throw new Error(`permissionsFor: ledgerKind ${JSON.stringify(opts.ledgerKind)} is not "interactive" or "managed-agent"`);
  }
  if (isEnvironmentManagerProfile(profile)) return environmentManagerPermissions(profile, space, pr, opts.environmentManager);
  if (opts.environmentManager) throw new Error(`permissionsFor: environmentManager pins cannot ride ${profile}`);
  if (profile === "delivery") return deliveryPermissions(space, pr); // scoped server-side Plane-3 infra
  if (profile === "manager-caller") return managerCallerPermissions(space, pr, opts);
  if (profile === "membership-rw") return membershipRwPermissions(space, pr); // scoped graph-feed reader/writer
  if (profile === "supervisor") return supervisorPermissions(space, pr); // always-on daemon
  if (profile === "provisioner") return provisionerPermissions(space, pr); // ephemeral onboarding authority
  if (profile === "deprovisioner") {
    // Ephemeral, TARGET-PINNED teardown — the counterpart to `provisioner`. The target is a
    // full principal dot-form for user-mode agents, or a bare static/dev actor id (keyed under
    // DEV_OWNER) — see {@link deprovisionTargetPrincipal}.
    if (!opts.deprovisionTarget)
      throw new Error("permissionsFor: deprovisioner requires opts.deprovisionTarget ({principal, lifecycleUid} of the departed incarnation)");
    return deprovisionerPermissions(space, pr, opts.deprovisionTarget);
  }
  if (profile === "retirement-requester") {
    // Ephemeral request+reply on the AUTH ENDPOINT rail:
    // publish EXACTLY this caller triple's own request subject for the ONE target it names +
    // subscribe its own reply-plane filter and inbox. No store reads, no barrier/scanner/plane
    // authority - the requester only asks; the auth plane holds every executing right and
    // re-checks the serve registration at serve time.
    // Validate the WHOLE shape, not just its presence. Each of these is a subject token: a missing
    // one would otherwise surface as a raw "cannot read properties of undefined" from deep inside
    // the subject builder, which tells the operator nothing about WHICH field it owes. The `target`
    // arrived with #350 (the handle triple moved into the subject), so a caller written against the
    // pre-#350 `{owner, actor}` shape lands here — and must be told exactly that.
    const rr = opts.retirementRequester;
    if (!rr)
      throw new Error("permissionsFor: retirement-requester requires opts.retirementRequester ({owner, actor, uid, target} of the requesting manager)");
    for (const [k, v] of [["owner", rr.owner], ["actor", rr.actor], ["uid", rr.uid]] as const)
      if (typeof v !== "string" || v.length === 0)
        throw new Error(`permissionsFor: retirement-requester requires opts.retirementRequester.${k} (the caller triple is <owner>.<actor>.<uid>; since #350 the rail carries the CALLER's uid, not a two-token alias)`);
    if (!rr.target || typeof rr.target.owner !== "string" || typeof rr.target.actor !== "string" || typeof rr.target.lifecycleUid !== "string")
      throw new Error("permissionsFor: retirement-requester requires opts.retirementRequester.target ({owner, actor, lifecycleUid} of the ONE incarnation this credential may retire) - since #350 the handle target rides the SUBJECT and is grant-pinned, so it can no longer be supplied in the request body");
    const { owner, actor, uid, target } = rr;
    const caller = { owner, actor, uid };
    // The row is minted in `exact` mode: a privileged, non-redemption mode where this profile
    // pins the arity-3 target triple directly from the manager's own coordinates under root
    // authority, rather than through `handle`'s issuer-signed redemption provenance. The target is
    // still confinement-pinned, so this credential can ask to retire the ONE incarnation it was
    // minted for and nothing else - the same confinement the pre-#350 grant got from naming an
    // exact `ctl` subject, now covering the TARGET as well as the caller. The nonce is the only
    // wildcard token (§13.9): a bounded per-request suffix, not an addressing widening.
    const rows = epRequestGrantRows(space, {
      endpoint: AUTH_ENDPOINT,
      command: EP_CMD_RETIRE_LIFECYCLE,
      target: { mode: "exact", tOwner: target.owner, tActor: target.actor, tUid: target.lifecycleUid },
    }, caller);
    return {
      pub: {
        allow: [
          ...rows,
          epDescribeAllGrantRow(space, caller),
          `$JS.API.DIRECT.GET.${epcStreamName(space)}.${spacePrefix(space)}.epc.>`,
        ],
      },
      sub: { allow: [epCallerReplyFilter(space, caller), `_INBOX_${pr.connId}.>`] },
    };
  }
  if (profile === "manager-service" as Profile)
    throw new Error('permissionsFor: "manager-service" is not a generic profile; use the typed remote manager authority protocol');
  if (profile === "remote-manager") {
    if (!opts.remoteManager)
      throw new Error('permissionsFor: "remote-manager" requires opts.remoteManager ({instanceId, owner} of the authorized manager lifecycle)');
    return remoteManagerPermissions(space, pr, opts.remoteManager);
  }
  if (profile === "space-quiescence-reader") return spaceQuiescenceReaderGrants(space, pr.connId);
  if (profile === "issuer") return issuerPermissions(space, pr);
  if (profile === "registry-reader") return registryReaderPermissions(space, pr);
  if (profile === "run-admitter") {
    if (!opts.runAdmitter) throw new Error("permissionsFor: run-admitter requires opts.runAdmitter ({endpoint, runId} of the ONE run it admits)");
    return runAdmitterPermissions(space, pr, opts.runAdmitter);
  }
  if (profile === "transfer-writer") {
    if (!opts.transferWriter) throw new Error("permissionsFor: transfer-writer requires opts.transferWriter ({instanceId, hex} of the ONE object it writes)");
    const g = transferWriterGrants(space, opts.transferWriter.instanceId, opts.transferWriter.hex, pr.connId);
    return { pub: { allow: g.publish }, sub: { allow: g.subscribe } };
  }
  if (profile === "transfer-reader") {
    if (!opts.transferReader) throw new Error("permissionsFor: transfer-reader requires opts.transferReader ({instanceId} whose own bucket it reads)");
    const g = transferReaderGrants(space, opts.transferReader.instanceId, pr.connId);
    return { pub: { allow: g.publish }, sub: { allow: g.subscribe } };
  }
  if (profile === "endpoint-evictor") {
    // A SCOPED delivery-admin caller for ONE re-registration's verify-evict.
    // Publish EXACTLY this credential's OWN delivery-admin control subject + $JS.API.INFO; subscribe
    // its own reply subtree + inbox. NO lease, presence, store read, consumer, KV, or executing
    // right — the daemon does the $SYS scan/KICK (subject-gated authority, like the supervisor evictor
    // it narrows) and the manager passes only the predecessor's principal. Narrower than the
    // `supervisor` profile the auth barrier-evict reuses (its #30 residual, done here for the manager).
    const req = controlServiceSubject(space, CONTROL_DELIVERY_ADMIN, pr.owner, pr.actor);
    return { pub: { allow: [req, "$JS.API.INFO"] }, sub: { allow: [`${req}.reply.>`, `_INBOX_${pr.connId}.>`] } };
  }
  if (profile === "lifecycle-executor") {
    if (!opts.lifecycleExecutor)
      throw new Error("permissionsFor: lifecycle-executor requires opts.lifecycleExecutor ({owner, actor, lifecycleUid, alias} of the ONE incarnation it may move)");
    return lifecycleExecutorPermissions(space, pr, opts.lifecycleExecutor);
  }
  if (profile === "endpoint-serve-executor") {
    if (!opts.endpointServeExecutor)
      throw new Error("permissionsFor: endpoint-serve-executor requires opts.endpointServeExecutor ({endpoint, instanceId} of the ONE endpoint instance it may register/serve-mint)");
    return endpointServeExecutorPermissions(space, pr, opts.endpointServeExecutor);
  }
  if (profile === "goal-writer") {
    if (!opts.goalWriter)
      throw new Error("permissionsFor: goal-writer requires opts.goalWriter ({endpoint} whose action goals this connection binds + commits)");
    return goalWriterPermissions(space, pr, opts.goalWriter);
  }
  if (profile === "purger") return purgerPermissions(space, pr); // ephemeral history-purge
  if (profile === "backup") {
    if (!opts.backup) throw new Error("permissionsFor: backup requires opts.backup");
    return backupProfilePermissions(space, pr.connId, opts.backup);
  }
  if (profile === "restore") {
    if (!opts.restore) throw new Error("permissionsFor: restore requires opts.restore");
    return restoreProfilePermissions(space, pr.connId, opts.restore);
  }
  if (profile === "operator") return operatorPermissions(space, pr); // human-CLI client (send/dm/ask)
  if (profile === "probe") return probePermissions(pr); // connect-only liveness/auth preflight
  if (profile === "channel-writer") return channelWriterPermissions(space, pr); // channel-registry writes
  if (profile === "channel-purger") return channelPurgerPermissions(space, pr); // channel-writer + CHAT purge
  if (profile === "teardown") return teardownPermissions(space, pr, opts.transferStreams ?? []); // space-wide STREAM.DELETE holder
  if (profile === "membership-store-recreate") return membershipStoreRecreatePermissions(space, pr);
  if (profile === "issued-store-recreate") return issuedStoreRecreatePermissions(space, pr); // the two issued-authority stores only
  if (profile === "control-caller-privileged") return controlCallerPermissions(space, pr, "privileged", opts); // ps/start reads
  if (profile === "control-caller-admin") return controlCallerPermissions(space, pr, "admin", opts); // any-mode stop/attach
  if (profile === "deployer") return deployerPermissions(space, pr, opts.controlTier ?? "admin", opts); // spawn -f deploy authority (user-mode view rides privileged)
  if (profile === "session-caller") return sessionCallerPermissions(space, pr, opts.sessionCaller); // one §13.6 session's caller rails
  if (profile === "dm-reader") return dmReaderPermissions(space, pr); // one own dm_ durable, bind-only
  if (profile === "session-serving") return sessionServingPermissions(space, pr, opts.sessionServing); // one §13.6 session's SERVING rails
  if (profile === "session-ledger") return sessionLedgerPermissions(space, pr); // the dedicated session ledger, no rails
  if (profile === "run-driver") {
    if (!opts.runDriver)
      throw new Error("permissionsFor: run-driver requires opts.runDriver ({endpoint, runId, takeoverId, instanceId, epoch} of the ONE run and attempt it drives)");
    const g = runDriverGrants(space, opts.runDriver, pr.connId);
    return { pub: { allow: g.publish }, sub: { allow: g.subscribe } };
  }
  if (profile === "run-mediator") {
    if (!opts.runMediator) throw new Error("permissionsFor: run-mediator requires opts.runMediator for one run and attempt");
    const g = runMediatorGrants(space, opts.runMediator, pr.connId);
    return { pub: { allow: g.publish }, sub: { allow: g.subscribe } };
  }
  if (profile === "run-operator") {
    if (!opts.runOperator)
      throw new Error("permissionsFor: run-operator requires opts.runOperator ({endpoint, takeoverId} of the ONE endpoint whose runs it reads and answers)");
    const g = runOperatorGrants(space, opts.runOperator, pr.connId);
    return { pub: { allow: g.publish }, sub: { allow: g.subscribe } };
  }
  if (profile === "endpoint-serve")
    // Serve rows are emitted ONLY by mintCreds behind the §13.1 issuance fence — never via this
    // exported builder, so a direct signer/callout can't obtain unfenced serve rows (SPEC 13.1/13.9).
    throw new Error("permissionsFor: endpoint-serve rows are emitted only by mintCreds behind the §13.1 issuance fence; call mintCreds");
  const CHAT = chatStream(space), DM = dmStream(space), TASK = taskStream(space);
  const PAYLOAD = eventPayloadStream(space);
  const KV = `KV_${presenceBucket(space)}`;
  const CHKV = `KV_${channelBucket(space)}`; // channel registry (read-only for everyone)
  const MEMKV = `KV_${membershipBucket(space)}`; // derived graph membership feed (read-only — dashboard)
  const DLVKV = `KV_${deliveryBucket(space)}`; // delivery lease/readiness (read-only — Component 6 health)
  // Validate both principal tokens; the reply inbox keys on the connection nkey (see MintPrincipal).
  principalKey(pr.owner, pr.actor);
  const inbox = `_INBOX_${pr.connId}.>`;

  if (profile === "observer" || profile === "admin") {
    // Read-only: live feed via tap, history + presence via ephemeral/ordered consumers it
    // creates on CHAT + the presence KV. No chat/inst/svc/ctl publish → can't post.
    //   observer — sub chat.> only; DM_<space>/svc never named → DMs + anycast structurally
    //     invisible (step-6 inbox scoping means it can't sniff deliveries either).
    //   admin — sub widened to the MESSAGING plane, enumerated (SPEC 13.9/13.11): the
    //     dashboard's tap also sees DMs (inst.>) and anycast (svc.>) live, PLUS DM-stream read
    //     verbs so it can backfill DM history. A deliberate god-view over messaging only: a
    //     space-wide `>` would additionally plain-subscribe every v0.4 endpoint request rail
    //     (collecting the reply nonces the queue-qualified-only rule protects) and every
    //     core-only session frame, so the ep/epe/epf/epj/ept/epr/epw/eps/epc planes are
    //     deliberately excluded. DMs are plaintext + ACL-gated, so mint this only for a
    //     trusted audit dashboard. CONSUMER.CREATE on DM_<space> is the DM-confidentiality
    //     surface — granted here ONLY for this elevated read-only profile, never to agents.
    const sub = [
      ...eventPayloadReadSubjects(space, pr.owner, [], profile === "admin"),
      ...(profile === "admin"
        ? [`${spacePrefix(space)}.chat.>`, `${spacePrefix(space)}.inst.>`, `${spacePrefix(space)}.svc.>`, inbox]
        : [`${spacePrefix(space)}.chat.>`, inbox]),
    ];
    // History readers (channelHistory, multiChannelHistory, dmHistory) are named consumers keyed on
    // this connection's reader id (see MintPrincipal.readerId). The profile may delete exactly those
    // names and no other consumer (#4123): each read deletes its readers when it ends, so polling no
    // longer fills the stream's consumer limit.
    const readerId = pr.readerId ?? pr.connId;
    const readerDeletes = (stream: string) =>
      Array.from({ length: HISTORY_READERS }, (_, i) => `$JS.API.CONSUMER.DELETE.${stream}.${historyReaderConsumer(readerId, i)}`);
    const allow = [
      `$JS.API.STREAM.INFO.${PAYLOAD}`,
      ...eventPayloadReadSubjects(space, pr.owner, [], profile === "admin").flatMap(subject =>
        Array.from({ length: HISTORY_READERS }, (_, i) => `$JS.API.CONSUMER.CREATE.${PAYLOAD}.${historyReaderConsumer(readerId, i)}.${subject}`)),
      ...Array.from({ length: HISTORY_READERS }, (_, i) => [
        `$JS.API.CONSUMER.INFO.${PAYLOAD}.${historyReaderConsumer(readerId, i)}`,
        `$JS.API.CONSUMER.MSG.NEXT.${PAYLOAD}.${historyReaderConsumer(readerId, i)}`,
      ]).flat(),
      ...readerDeletes(PAYLOAD),
      "$JS.API.INFO",
      `$JS.API.STREAM.INFO.${CHAT}`,
      `$JS.API.STREAM.INFO.${KV}`,
      // NO stream-wide CONSUMER.DELETE on any stream this profile reads (#691). Its watch consumers
      // are client-named ordered consumers (`oc_<nuid>_<serial>`, the serial bumped on every
      // rebuild), so the only expressible grant for them is stream-wide, and stream-wide let one
      // observer delete another principal's live watch cursors and the delivery daemon's fan-out
      // durable. The broker reaps those consumers at their inactive threshold instead, and the
      // client treats a refused delete of its own watch consumer as that designed outcome.
      //
      // history reader consumer: a multi-filter create can't encode its filter in the subject → bare
      // form; the .> form covers the single-filter named create.
      `$JS.API.CONSUMER.CREATE.${CHAT}`,
      `$JS.API.CONSUMER.CREATE.${CHAT}.>`,
      `$JS.API.CONSUMER.INFO.${CHAT}.>`,
      `$JS.API.CONSUMER.MSG.NEXT.${CHAT}.>`,
      ...readerDeletes(CHAT),
      `$JS.ACK.${CHAT}.>`,
      `$JS.API.CONSUMER.CREATE.${KV}.>`, // kv.watch ordered consumer (roster is public)
      `$JS.API.CONSUMER.INFO.${KV}.>`,
      // Channel registry read (watch + direct kv.get + enriched listChannels) — config is
      // world-readable. STREAM.MSG.GET is the verb kv.get() rides (the bucket has no allow_direct).
      `$JS.API.STREAM.INFO.${CHKV}`,
      `$JS.API.STREAM.MSG.GET.${CHKV}`,
      `$JS.API.CONSUMER.CREATE.${CHKV}.>`,
      `$JS.API.CONSUMER.INFO.${CHKV}.>`,
      // Derived graph-membership feed (broker-sourced who-is-subscribed) — watch + direct kv.get. The
      // silent-reader set is sensitive, so read is admin/observer-only (this elevated profile), never an
      // agent. Read-only: no `$KV.${membershipBucket}` publish — only the `membership-rw` cred writes it.
      `$JS.API.STREAM.INFO.${MEMKV}`,
      `$JS.API.STREAM.MSG.GET.${MEMKV}`,
      // The snapshot read (`readMembership`) is paged batched Direct Gets whose request subject is the
      // bare stream, binding no consumer (#4123): this profile may not delete a scan's consumer, so a
      // consumer per read stayed to the inactive threshold and each refused delete was a broker log
      // line. The reply subject is caller-chosen, the same vector the consumer create below already
      // grants on this bucket, so the read reaches no byte the watch could not.
      `$JS.API.DIRECT.GET.${MEMKV}`,
      `$JS.API.CONSUMER.CREATE.${MEMKV}.>`,
      `$JS.API.CONSUMER.INFO.${MEMKV}.>`,
      // Delivery lease/readiness: READ-ONLY (STREAM.INFO + kv.get), the same pair the `agent` arm
      // below already carries for its non-gating `cotal_channels` health surface. A read-only
      // DIAGNOSTIC profile needs this axis for the same reason an agent does, and more: without it
      // an operator-facing surface can only report the daemon's PROCESS, which is green while the
      // responder is unbound (#1576). No `$KV.${deliveryBucket(space)}` publish — the lease has
      // exactly one writer, the `delivery` cred, and that is unchanged here.
      `$JS.API.STREAM.INFO.${DLVKV}`,
      `$JS.API.STREAM.MSG.GET.${DLVKV}`,
      "$JS.FC.>", // ordered-consumer flow control
    ];
    if (profile === "admin") {
      // DM history backfill (dmHistory): same bare-form gotcha as CHAT — filter_subjects is
      // plural so the create lands on the bare subject; the .> form covers named consumers.
      allow.push(
        `$JS.API.STREAM.INFO.${DM}`,
        `$JS.API.CONSUMER.CREATE.${DM}`,
        `$JS.API.CONSUMER.CREATE.${DM}.>`,
        `$JS.API.CONSUMER.INFO.${DM}.>`,
        `$JS.API.CONSUMER.MSG.NEXT.${DM}.>`,
        ...readerDeletes(DM),
        `$JS.ACK.${DM}.>`,
      );
    }
    return { sub: { allow: sub }, pub: { allow } };
  }

  // ---- agent ----
  // No silent fallthrough: every non-agent profile is handled above, so anything else reaching here is a
  // stale/unwired profile string (e.g. a JS caller bypassing the closed `Profile` union). Fail loud rather
  // than mint it agent perms by accident (the no-fallbacks rule; matches the deleted `manager`'s intent).
  if (profile !== "agent")
    throw new Error(`permissionsFor: unhandled profile "${profile}" - add an explicit arm, do not fall through to agent`);
  const allowPublish = opts.allowPublish ?? []; // post ACL — DEFAULT-DENY (publish must be declared)
  // Read ACL — DEFAULT-DENY for channels, exactly like allowPublish above. Omitted or empty mints
  // NO channel row: no per-channel history-consumer create grant and no `chat.*.<ch>` sub.allow.
  // The DM/presence/anycast/control rows below are unconditional, so a channel-less agent is still
  // a full mesh participant, reachable by DM and visible on the roster.
  const allowSubscribe = opts.allowSubscribe ?? [];
  // Re-assert at the mint chokepoint (covers mint/spawn paths that bypass the file loader): a policy
  // channel must equal its wire token, or the minted grant would alias the logical ACL.
  for (const ch of [...allowSubscribe, ...allowPublish]) assertValidChannel(ch);
  if (!pr.lifecycleUid)
    throw new Error("permissionsFor(agent): a lifecycleUid is required - the agent's dm/dlv/chathist grants are lifecycle-keyed exact names (SPEC 13.1)");
  const uid = assertLifecycleToken(pr.lifecycleUid);
  const chatHistD = chatHistDurable(pr.owner, pr.actor, uid), dmD = dmDurable(pr.owner, pr.actor, uid);
  const DLV = dlvStream(space), dlvD = dlvDurable(pr.owner, pr.actor, uid); // Plane-3 per-member delivery (bind-only when channel-readable)
  const roles = taskRoles(opts.role, opts.capabilities);
  const pubAllow = [
    // peer publish — owner+actor identity + channel scope, built from the real builders. Default-deny:
    // ONLY the declared allowPublish channels (none by default) get a chat-publish grant.
    ...allowPublish.map((ch) => chatSubject(space, pr.owner, pr.actor, ch)),
    unicastSubject(space, "*", "*", pr.owner, pr.actor), // inst.*.*.<o>.<a> — DM any instance, as me
    anycastSubject(space, "*", pr.owner, pr.actor), //  svc.*.<o>.<a>   — anycast any role, as me
    // Self stop/despawn rides the v0.4 ep baseline (`stop` self-mode) — the manager `ctl` rail is
    // deleted. The delivery-daemon rail below is a separate service (Plane-3), kept.
    // ctl.delivery.<o>.<a> — request a durable backstop join/leave/list from the SERVER-SIDE delivery
    // daemon (NOT the manager). The reply rides this same subtree (`ctl.delivery.<o>.<a>.reply.<n>`, in
    // sub.allow below) so the daemon can answer without broad inbox-publish — see CONTROL_DELIVERY.
    controlServiceSubject(space, CONTROL_DELIVERY, pr.owner, pr.actor),
    // THE PEER-READABLE LIVENESS PROBE (#1577) — one publish row per plane, each pinned to THIS
    // agent's own principal slots, so a peer asks as itself and can never forge a probe from
    // another. This is the row that makes liveness askable by a NON-OWNER: without it, the only
    // hypothesis a peer could form for any failure was "my credentials are wrong", because the
    // subjects that answer "is the manager alive" were owner-only.
    //
    // WHAT THIS DOES NOT GRANT, which is the half that keeps it from being a back door. It is
    // PUBLISH ON A REQUEST SUBJECT, not a read of anything. The agent gains NO grant on the manager
    // bucket (still absent by deliberate omission, below) and NO new read of the delivery bucket.
    // The answer it can obtain is one enum per plane, because the responder reduces the lease row
    // before replying and the row never crosses the wire. It cannot subscribe the SERVE filter
    // either: `live.<plane>.*.*` is not in `sub.allow`, so an agent cannot impersonate a responder
    // and answer a peer's probe with a comforting lie.
    ...LIVENESS_PLANES.map((plane) => livenessSubject(space, plane, pr.owner, pr.actor)),
    // JetStream control plane — scoped to this agent's own streams/durables.
    "$JS.API.INFO",
    // STREAM.INFO: CHAT (join watermark, recall drop-marker, channel-list counts — a documented
    // metadata surface, see SPEC §9) + the world-readable presence/registry KVs. NOT DM/DLV/EPC:
    // an agent reaches each of those by name — its own pre-created dm_<id>/dlv_<id> durable, or a
    // subject-scoped DIRECT.GET on EPC — so it never needs a stream-level read, and `subjects_filter`
    // is a REQUEST-BODY field no ACL can narrow, so INFO there would enumerate DM and delivery
    // subject metadata across peers (who DMed whom) for no functional gain. TASK's INFO row is
    // role-gated with the rest of its TASK grants, below.
    `$JS.API.STREAM.INFO.${CHAT}`, `$JS.API.STREAM.INFO.${KV}`, `$JS.API.STREAM.INFO.${CHKV}`,
    // Live channel delivery is the agent's own native core subscription (sub.allow over chat.*.<ch>,
    // below) — there is NO per-instance chat live-tail durable to bind. The durable backstop is
    // Plane-3 (the bind-only dlv_<id> durable below). So no CHAT consumer bind/ack grants here.
    // CHAT history reads (join-backfill, focus-recall, drop-marker) — single-filter EPHEMERAL
    // consumers named chathist_<id>. The create rides the extended subject
    // CONSUMER.CREATE.<CHAT>.<chathist_id>.<filter>, whose trailing filter token nats-server pins to
    // the request body (JSConsumerCreateFilterSubjectMismatchErr, code 10131) — so one create grant
    // per allowSubscribe channel makes history reads broker-bounded to the read ACL. Replaces the
    // old unfiltered DIRECT.GET.<CHAT> (which could fetch ANY message regardless of channel). The
    // name is the agent's own, so info/fetch/delete can't reach a peer's consumer. NO broad
    // CONSUMER.CREATE.<CHAT> / .> deny here: NATS deny beats allow, which would also kill these.
    ...allowSubscribe.map((ch) => `$JS.API.CONSUMER.CREATE.${CHAT}.${chatHistD}.${chatSubject(space, "*", "*", ch)}`),
    `$JS.API.CONSUMER.INFO.${CHAT}.${chatHistD}`,
    `$JS.API.CONSUMER.MSG.NEXT.${CHAT}.${chatHistD}`,
    `$JS.API.CONSUMER.DELETE.${CHAT}.${chatHistD}`,
    // DM consumer: BIND ONLY — info/fetch/ack its own pre-created durable, never create.
    `$JS.API.CONSUMER.INFO.${DM}.${dmD}`,
    `$JS.API.CONSUMER.MSG.NEXT.${DM}.${dmD}`,
    `$JS.ACK.${DM}.${dmD}.>`,
    // Plane-3 DELIVER consumer (SPEC §8): when this credential can read at least one channel, BIND
    // ONLY its own pre-created dlv_<id> — info/fetch/ack, never create. A channel-less credential has
    // no DLV durable and no fetch or ack row. It can still ask CONSUMER.INFO for its own durable
    // name. A client older than 0.163.0 does that during start, and a permitted read answers that
    // the consumer is absent, which that client treats as nothing to bind. A refused publish fails
    // the start. It gets NO grant on the INBOX (mixed pre-auth) stream either.
    ...(allowSubscribe.length > 0 ? [
      `$JS.API.CONSUMER.INFO.${DLV}.${dlvD}`,
      `$JS.API.CONSUMER.MSG.NEXT.${DLV}.${dlvD}`,
      `$JS.ACK.${DLV}.${dlvD}.>`,
    ] : [`$JS.API.CONSUMER.INFO.${DLV}.${dlvD}`]),
    // Presence: on-demand read + watch (read, public roster) + flow control + PUT OWN KEY ONLY.
    // The read is a batched Direct Get of the bucket (SPEC §6): a seat reads the roster when it acts
    // instead of receiving every member's heartbeat. Its reply subject is caller-chosen, the same
    // vector the consumer create below already grants on the same world-readable bucket, so it
    // reaches no byte the watch could not. The watch rows stay for seats built before the read.
    `$JS.API.DIRECT.GET.${KV}`,
    `$JS.API.CONSUMER.CREATE.${KV}.>`,
    `$JS.API.CONSUMER.INFO.${KV}.>`,
    // No CONSUMER.DELETE here or on the registry below: the watch's `oc_<nuid>_<serial>` name
    // cannot be pinned, and a stream-wide delete reaches every peer's watch cursor (#691). A
    // rebuild's predecessor delete is not published under these claims (#4123), and the consumer
    // stays until the broker's inactive threshold.
    "$JS.FC.>",
    presenceKeySubject(space, pr.owner, pr.actor), // own presence key (owner+actor) only — can't spoof peers
    // Channel registry: read-only (watch + direct kv.get for the join-time replay decision).
    // No `$KV.${channelBucket(space)}.*` publish — privileged-write, default-deny gives that free.
    `$JS.API.STREAM.MSG.GET.${CHKV}`,
    // A seat reads the registry on demand, and the one-shot CLI reads it once, each with a batched
    // Direct Get whose request subject is the bare stream (SPEC §7, #4091). On a user-auth mesh the
    // CLI connects on the user's bearer, which the auth service mints with these rows, so the row is
    // what lets it leave no watch consumer behind. The same reply-subject reasoning as the presence
    // read above: the consumer create below already grants that vector on this world-readable bucket.
    `$JS.API.DIRECT.GET.${CHKV}`,
    `$JS.API.CONSUMER.CREATE.${CHKV}.>`,
    `$JS.API.CONSUMER.INFO.${CHKV}.>`,
    // Delivery lease/readiness: READ-ONLY (kv.get) for the non-gating `cotal_channels` delivery-health
    // surface (Component 6). The lease key is daemon-availability info, like the world-readable roster;
    // NO write grant — only the `delivery` cred writes it.
    `$JS.API.STREAM.INFO.${DLVKV}`,
    `$JS.API.STREAM.MSG.GET.${DLVKV}`,
    // Manager lease bucket (`cotal_manager_<space>`): NO grant at all. An agent must never read,
    // write, or delete it. The bucket holds one `lease.<instanceId>` key per manager instance and
    // the per-space `renewal` key. The `supervisor` credential writes `lease.*` and `renewal`; a
    // `remote-manager` credential writes only its own `lease.<instanceId>`. An agent that could
    // mutate a lease key could DoS that holder (evict it, or pre-create the key to block a fresh
    // one). Safety is by OMISSION (default-deny on the un-granted `KV_cotal_manager_*` stream and
    // `$KV.cotal_manager_*.>`), so do NOT add a broad `KV_*` or `$KV.<space>.>` grant that would
    // silently re-open it.
  ];
  if (roles.length > 0) {
    // TASK consumer: BIND ONLY the pre-created durable (svc_<role>) of its own role and of each
    // `role:<r>` token it holds. Like DM, the create-time filter_subject isn't reliably
    // ACL-constrainable, so no create path is allowed — the privileged provisioner pre-creates
    // svc_<role> filtered to svc.<role>.>. STREAM.INFO rides the SAME role gate as the bind rows: a
    // role-less agent holds no TASK grant at all, so it can neither read the task stream's state
    // nor enumerate its subjects.
    pubAllow.push(`$JS.API.STREAM.INFO.${TASK}`);
    for (const role of roles) {
      const svcD = taskDurable(role);
      pubAllow.push(
        `$JS.API.CONSUMER.INFO.${TASK}.${svcD}`,
        `$JS.API.CONSUMER.MSG.NEXT.${TASK}.${svcD}`,
        `$JS.ACK.${TASK}.${svcD}.>`,
        // The take of one delivered request (SPEC §8.1), pinned to this role and this principal, so a
        // credential takes only for a role whose queue it binds. Its reply rides the sub row below.
        takeSubject(space, role, pr.owner, pr.actor),
      );
    }
  }
  // Spawn / admin capability control reach rides the v0.4 ep rows below (the manager `ctl` rail is
  // deleted) — the spawn set (owner-mode manager lifecycle) and the admin instrument set
  // (any-mode + manager.admin family) are added to the ep caller rows, not a ctl subject.
  // v0.4 endpoint rails (SPEC §13.9 caller rows). EVERY agent gets the Appendix-B BASELINE set
  // (wildcard describe + delivery join/leave/list + self-mode lifecycle + the reply rail), keyed
  // on the SAME lifecycle uid as the agent's durables; the spawn capability adds the owner-mode
  // manager lifecycle set. Beyond the baseline stays default-deny: only minted capabilities
  // produce rows, each pinning the full caller triple (§13.1 lifecycle UID included; the nonce
  // is the only wildcard token).
  // ONE lifecycle uid keys the whole caller rail (§13.1/§13.2 forge-lock: one credential names one
  // incarnation). `uid` is the already-asserted pr.lifecycleUid; the baseline, the spawn set, AND
  // the explicit capabilities ALL build their caller triple from it. opts.lifecycleUid is a public
  // seam (the IdP-adapter path) that must AGREE, never a second source of truth for the triple: a
  // divergent value would mint two reply rails on one credential, so it fails loud here.
  const epCaller: EpCaller = issuedCallerFor({ owner: pr.owner, actor: pr.actor, uid }, opts);
  const baseline = epBaselineGrantRows(space, epCaller);
  pubAllow.push(...baseline.pub);
  if (opts.issued) pubAllow.push(acceptedReadGrant(space, opts.issued.acceptedToken));
  const epSub: string[] = [...baseline.sub];
  // The registry's listing question rides the issued rail (SPEC 13.20): under the credential's own
  // generation when its issuance carries it, else under a listing generation.
  if (opts.issued?.listing) pubAllow.push(...epRequestGrantRows(space, REGISTRY_ENDPOINTS_GRANT, epCaller));
  if (opts.listing) {
    const rows = listingGrantRows(space, epCaller, opts.listing);
    pubAllow.push(...rows.pub);
    epSub.push(...rows.sub);
  }
  // BOTH HALVES OF THE ROLLUP, NOT JUST `pub`. `epCallerGrantRows` returns `{pub, sub}` and its
  // `sub` is the per-goal progress row its own docblock promises: "a goal-bearing capability
  // (spawn/launch) adds ONE per-endpoint epGoalProgressGrantRow - the caller may follow its OWN
  // goal to terminal". Taking `.pub` alone minted a credential that may SUBMIT a goal and may not
  // HEAR it, so the broker refused the follow and the caller reported a timeout about a goal whose
  // terminal had already been committed (#610). `spawn` is goal-bearing, so this `sub` is never
  // empty here - the row was computed correctly and discarded one property access short of the
  // credential.
  if (opts.capabilities?.includes("spawn")) {
    const rows = epCallerGrantRows(space, spawnCallerCapabilities(pr.owner), epCaller);
    pubAllow.push(...rows.pub);
    for (const s of rows.sub) if (!epSub.includes(s)) epSub.push(s);
  }
  // The `run` capability (SPEC 14.3): the manager-hosted workflow-run rows PLUS the spawn set a
  // program's own spawns need. Rows already minted by `spawn` above are exact duplicates and the
  // dedupe below folds them; the `sub` half carries the same goal-follow row for the same reason
  // the spawn branch keeps it.
  if (opts.capabilities?.includes("run")) {
    const rows = epCallerGrantRows(space, runCallerCapabilities(pr.owner), epCaller);
    for (const p of rows.pub) if (!pubAllow.includes(p)) pubAllow.push(p);
    for (const s of rows.sub) if (!epSub.includes(s)) epSub.push(s);
  }
  if (opts.capabilities?.includes("admin"))
    // The admin capability grants the admin instrument set on the ep rails, the set a
    // `control-caller-admin` holds — the any-mode rows + the `manager.admin` family + the reads. In
    // user mode this is the ledger `admin` scope arriving via the callout, the broker-enforced
    // half of the tier; the manager's ledger-derived per-op admin flag stays on top of it.
    {
      // Same `{pub, sub}` contract as the spawn branch above: an admin instrument's set carries the
      // goal-bearing lifecycle commands, so it earns the same follow row.
      const rows = epCallerGrantRows(space, operatorInstrumentCapabilities("admin", pr.owner), epCaller);
      pubAllow.push(...rows.pub);
      for (const s of rows.sub) if (!epSub.includes(s)) epSub.push(s);
    }
  // THE PRINCIPAL ROUTE (SPEC 13.21), for a ledger row of either kind: serve its own `agent`
  // endpoint under its own principal and lifecycle, the runtime spanned. An interactive row also
  // calls its owner's agents with the `owner` word. The rows carry the caller triple alone: the
  // route has no versioned form, whatever rail the rest of the credential rides.
  if (opts.ledgerKind !== undefined) {
    const self: EpCaller = { owner: pr.owner, actor: pr.actor, uid };
    const serve = epPrincipalServeGrantRows(space, self);
    pubAllow.push(...serve.pub);
    epSub.push(...serve.sub);
    if (opts.ledgerKind === "interactive") {
      const own = epPrincipalOwnerGrantRows(space, self);
      pubAllow.push(...own.pub);
      epSub.push(...own.sub);
    }
  }
  if (opts.endpointCapabilities?.length) {
    if (opts.lifecycleUid !== undefined && assertLifecycleToken(opts.lifecycleUid) !== uid)
      throw new Error(`permissionsFor: opts.lifecycleUid "${opts.lifecycleUid}" disagrees with the principal's lifecycleUid "${uid}" - one credential names ONE incarnation on the caller rail (SPEC 13.1/13.2)`);
    const rows = epCallerGrantRows(space, opts.endpointCapabilities, epCaller);
    pubAllow.push(...rows.pub);
    for (const s of rows.sub) if (!epSub.includes(s)) epSub.push(s);
  }
  // Explicit create-deny (defense-in-depth over default-deny) on the two streams whose
  // create-time filter_subject is the attack surface — DM (private content) and TASK
  // (cross-role work-stealing). Covers the bare ephemeral form (no trailing token), the
  // named/new-API form, and the old durable form. No create path on either stream.
  const pubDeny = [
    `$JS.API.CONSUMER.CREATE.${DM}`,
    `$JS.API.CONSUMER.CREATE.${DM}.>`,
    `$JS.API.CONSUMER.DURABLE.CREATE.${DM}.>`,
    `$JS.API.CONSUMER.CREATE.${TASK}`,
    `$JS.API.CONSUMER.CREATE.${TASK}.>`,
    `$JS.API.CONSUMER.DURABLE.CREATE.${TASK}.>`,
    // Plane-3 DELIVER: bind-only, like DM — the create-time filter_subject is the attack surface, so
    // no create path (the provisioner pre-creates dlv_<id> filtered to dlv.<id>).
    `$JS.API.CONSUMER.CREATE.${DLV}`,
    `$JS.API.CONSUMER.CREATE.${DLV}.>`,
    `$JS.API.CONSUMER.DURABLE.CREATE.${DLV}.>`,
  ];
  // CHAT live read boundary (SPEC v0.3 §9 / Appendix B): mint the read ACL as a native `sub.allow`
  // over cotal.<space>.chat.*.<channel> — one per allowSubscribe channel, wildcards passed through
  // (e.g. chat.*.review.>, chat.*.>). This is what lets an agent self-serve a live channel subscribe
  // with NO manager: join = nc.subscribe, broker-enforced per-subscribe, no consumer name to confine,
  // so an open ACL needs no enumeration. This sub.allow grant IS the live read path — there is no
  // per-instance chat durable; the durable backstop is Plane-3 (delivery-daemon fan-out → per-member DELIVER).
  const subChat = allowSubscribe.map((ch) => chatSubject(space, "*", "*", ch));
  const payloadReads = eventPayloadReadSubjects(space, pr.owner, allowSubscribe);
  if (opts.eventPayloads !== false) pubAllow.push(eventPayloadSubject(space, pr.owner, pr.actor));
  pubAllow.push(
    `$JS.API.STREAM.INFO.${PAYLOAD}`,
    ...payloadReads.map(subject => `$JS.API.CONSUMER.CREATE.${PAYLOAD}.${chatHistD}.${subject}`),
    `$JS.API.CONSUMER.INFO.${PAYLOAD}.${chatHistD}`,
    `$JS.API.CONSUMER.MSG.NEXT.${PAYLOAD}.${chatHistD}`,
    `$JS.API.CONSUMER.DELETE.${PAYLOAD}.${chatHistD}`,
  );
  // Replies to this agent's durable join/leave/list requests ride `ctl.delivery.<o>.<a>.>` (NOT the
  // per-id _INBOX), so the scoped delivery daemon can answer without broad inbox-publish.
  const deliveryReplies = `${controlServiceSubject(space, CONTROL_DELIVERY, pr.owner, pr.actor)}.>`;
  // Liveness answers (#1577) ride the probe's OWN request subtree, exactly like the delivery
  // control replies above and for the same reason: the responder answers without needing broad
  // inbox-publish. One row per plane, pinned to this agent's principal, so it can hear answers to
  // ITS OWN probes and nothing else — it cannot subscribe a peer's reply lane and harvest answers
  // addressed elsewhere.
  const livenessReplies = LIVENESS_PLANES.map((plane) => `${livenessSubject(space, plane, pr.owner, pr.actor)}.>`);
  // Manager control replies ride the v0.4 ep reply rail (in `epSub`, keyed on the caller triple) —
  // the `ctl.<tier>.<id>.reply.>` subtrees are gone with the ctl rail.
  // A take's reply rides the take's own request subtree, like the delivery control replies.
  const takeReplies = roles.map((role) => `${takeSubject(space, role, pr.owner, pr.actor)}.>`);
  return { pub: { allow: pubAllow, deny: pubDeny }, sub: { allow: [inbox, deliveryReplies, ...takeReplies, ...livenessReplies, ...subChat, ...payloadReads, ...epSub] } };
}

/** The reads a spawn-scoped manager-caller view carries on its one pinned instance. A launch uses
 * `status` (execution mode and connectors), `models` (their catalogs), `resolve-cwd` (canonical
 * directory) and `list-dir` (directory navigation). The remaining read, `ps`,
 * lists the caller's own agents: the Manager bounds it to the caller's owner unless the caller
 * holds admin. The standing spawn set carries none of them, because it reaches every manager in
 * the space through the class rail. */
const SPAWN_VIEW_READS = Object.freeze(["status", "models", "resolve-cwd", "list-dir", "ps"] as const);

/** One seat's manager control view. It carries no agent messaging or delivery surface, and every
 * manager request, including describe, is pinned to one exact registered instance. */
function managerCallerPermissions(space: string, pr: MintPrincipal, opts: MintOpts): Record<string, unknown> {
  if (!pr.lifecycleUid)
    throw new Error("permissionsFor(manager-caller): a lifecycleUid is required");
  const instanceId = opts.managerInstanceId === undefined
    ? (() => { throw new Error("permissionsFor(manager-caller): managerInstanceId is required"); })()
    : assertLifecycleToken(opts.managerInstanceId, "managerInstanceId");
  const caps = opts.capabilities ?? [];
  const ordinary = [
    { endpoint: BASELINE_LIFECYCLE_ENDPOINT, command: "describe" },
    ...baselineCallerCapabilities().filter((cap) => cap.endpoint === BASELINE_LIFECYCLE_ENDPOINT),
    ...(caps.includes("spawn") ? spawnCallerCapabilities(pr.owner) : []),
    ...(caps.includes("spawn") ? SPAWN_VIEW_READS.map((command) => ({ endpoint: BASELINE_LIFECYCLE_ENDPOINT, command })) : []),
    ...(caps.includes(MANAGER_VITALS_SCOPE) ? [{ endpoint: BASELINE_LIFECYCLE_ENDPOINT, command: MANAGER_VITALS_COMMAND }] : []),
    ...(caps.includes("run") ? runCallerCapabilities(pr.owner) : []),
    ...(caps.includes("admin") ? operatorInstrumentCapabilities("admin", pr.owner) : []),
  ];
  const caller = issuedCallerFor({ owner: pr.owner, actor: pr.actor, uid: assertLifecycleToken(pr.lifecycleUid) }, opts);
  const rows = epCallerGrantRows(space, instanceOnlyManagerCapabilities(ordinary, instanceId), caller);
  const listing = opts.listing ? listingGrantRows(space, caller, opts.listing) : { pub: [], sub: [] };
  return {
    pub: {
      allow: [
        `$JS.API.DIRECT.GET.${epcStreamName(space)}.${spacePrefix(space)}.epc.>`,
        ...(opts.issued ? [acceptedReadGrant(space, opts.issued.acceptedToken)] : []),
        ...rows.pub,
        ...(opts.issued?.listing ? epRequestGrantRows(space, REGISTRY_ENDPOINTS_GRANT, caller) : []),
        ...listing.pub,
      ],
    },
    sub: { allow: [`_INBOX_${pr.connId}.>`, ...rows.sub, ...listing.sub] },
  };
}

/** The long-lived SUPERVISOR permission set — the always-on manager daemon
 *  (`manager.ts` `this.ep`), carved down from the former allow-all `manager`. Its breadth is
 *  STANDING, so tightening it removes the always-on DM/DLV body-read AND the stream-admin tamper
 *  from the one connection that never goes away. It holds the manager bucket's `lease.*` instance keys
 *  and the per-space renewal lease key, its own presence key + the roster watch, the ONE delivery-admin
 *  call (request + bounded reply subtree), the manager-plane liveness serve + reply rows, and a
 *  read-only point read of the delivery lease row — and nothing else. It serves no manager control:
 *  that is the v0.4 `service` endpoint, served on a SEPARATE connection under its own
 *  `endpoint-serve` credential. Provisioning (DM/DLV/TASK consumer-create + ACL
 *  writes) moves to the EPHEMERAL `provisioner` (opened per-spawn); destructive history-purge moves to the
 *  EPHEMERAL `purger`. So the supervisor holds NO chat/inst/svc publish (it never posts — only
 *  `setActivity`, a presence write), NO DM/DLV read of any kind (no consumer-create, no native sub), NO
 *  stream CREATE/DELETE/PURGE/UPDATE, NO channel-registry access (the daemon sets `watchChannels:false`).
 *  `$JS` is an ENUMERATED allow-list — exactly the presence-watch + lease-KV verbs — never `$JS.>`. A
 *  leaked supervisor cred can hold the lease and read the public roster; it cannot read a DM, forge an
 *  actor, provision, purge, or tamper with a stream. */
function supervisorPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  const PKV = `KV_${presenceBucket(space)}`, MKV = `KV_${managerBucket(space)}`;
  const SUP_DLVKV = `KV_${deliveryBucket(space)}`;
  return {
    pub: {
      allow: [
        "$JS.API.INFO",
        // Transcript startup checks read retained subject counts, never message bodies.
        `$JS.API.STREAM.INFO.${chatStream(space)}`,
        // Per-instance manager liveness lease (managerBucket, pre-created at `cotal up`): OPEN-ONLY bind +
        // CAS this instance's own `lease.<instanceId>` key (acquire/renew/release) + read the subtree. The
        // lease is per instance, so the write grant spans `lease.*` (every instance of this space
        // shares this one supervisor principal — the isolation between instances is the logical-id/CAS
        // boundary, not a cred boundary). NO STREAM.CREATE (pre-created), DELETE, or PURGE.
        `$JS.API.STREAM.INFO.${MKV}`,
        `$JS.API.STREAM.MSG.GET.${MKV}`, // readManagerLease (last_by_subj lease.*) + CAS-conflict kv.get
        `$KV.${managerBucket(space)}.${MANAGER_LEASE_KEY}.*`, // this instance's lease.<id> key (create/update/delete = $KV publishes)
        // #1634: the per-space daemon-credential renewal lease, the CAS that picks ONE renewal owner
        // when several managers share the daemon's store. Same bucket, its own key outside `lease.*`.
        `$KV.${managerBucket(space)}.${MANAGER_RENEWAL_LEASE_KEY}`,
        // Presence: publish OWN key + watch the roster. Own key only (no peer-key forge); no
        // presence-stream purge/delete (no force-offline tamper). No presence kv.get (roster is the in-memory
        // watch cache + sweep), so no STREAM.MSG.GET on presence.
        `$KV.${presenceBucket(space)}.${principalKey(pr.owner, pr.actor).key}`,
        `$JS.API.STREAM.INFO.${PKV}`,
        `$JS.API.CONSUMER.CREATE.${PKV}.>`, // kv.watch ordered consumer (roster)
        `$JS.API.CONSUMER.INFO.${PKV}.>`,
        "$JS.FC.>", // ordered-consumer flow control
        // The ONE control service the supervisor CALLS: the delivery daemon's privileged
        // admin rail — the manager is the daemon's renewal owner, and after re-signing the daemon creds
        // files it requests `reloadCreds` here so adoption is an explicit, auditable event. Self-scoped
        // request subject (its own owner+actor slots), bounded reply subtree in sub.allow below.
        controlServiceSubject(space, CONTROL_DELIVERY_ADMIN, pr.owner, pr.actor),
        // LIVENESS REPLIES for the MANAGER plane (#1577), bounded to the `.reply.` leaf under a
        // caller's own request subject. The supervisor is the natural responder for this plane: it
        // is the process that HOLDS the manager lease, so it is the one that can answer the
        // question honestly without anyone else being granted a read of the lease row.
        //
        // REPLIES ONLY, exactly like the delivery daemon's `ctl.delivery.*.*.reply.>`. The row stops
        // at the leaf, so the supervisor cannot publish to the liveness REQUEST subjects themselves
        // and therefore cannot forge a probe from a peer.
        livenessReplyGrant(space, "manager"),
        // #1694: a POINT READ of the delivery lease row, so the store-identity challenge can verify
        // that the process which answered the queue-grouped admin rail is the holder that actually
        // reloads the standing credentials. Without it the challenge can only report what some
        // responder sent, and a non-holder's store stands in for the reloading process's.
        //
        // READ ONLY, and that is the half that matters: a credential able to WRITE this row could
        // manufacture the very fact the challenge reads, which would put the determination back in
        // the hands of a participant. No `$KV.${deliveryBucket(space)}` publish, no watch consumer,
        // no STREAM.DELETE or PURGE.
        `$JS.API.STREAM.INFO.${SUP_DLVKV}`,
        `$JS.API.STREAM.MSG.GET.${SUP_DLVKV}`,
        `$JS.API.DIRECT.GET.${SUP_DLVKV}.>`,
      ],
    },
    sub: {
      // Own reply inbox + the delivery-admin reply subtree for its OWN requests. NO chat/inst/dlv
      // native sub (the supervisor reads no feed), NO manager control-tier serve (that is
      // the endpoint-serve credential's), NO broad `$JS.>`/`$KV.>`.
      //
      // PLUS the manager-plane liveness SERVE filter (#1577): `live.manager.*.*`, queue-grouped, so
      // any credentialed peer's presence probe reaches the lease holder. This is a serve
      // subscription on a presence-only rail, not a widening of what the supervisor may read: the
      // request body is empty and the subject carries only the caller's own principal.
      allow: [
        `_INBOX_${pr.connId}.>`,
        `${controlServiceSubject(space, CONTROL_DELIVERY_ADMIN, pr.owner, pr.actor)}.>`,
        livenessServeFilter(space, "manager"),
      ],
    },
  };
}

/** The long-lived REMOTE MANAGER base credential. This is intentionally smaller than the local
 * supervisor+provisioner union: it registers only its own manager presence, holds only its own
 * manager-instance lease key, and may provision only lifecycle-keyed resources under its derived
 * owner. Endpoint registration, contract publication and serving use separate instance-pinned
 * credentials returned by the same typed host protocol. Per-agent provisioning deliberately does
 * NOT ride this credential: NATS consumer names are single tokens, so a broker grant cannot safely
 * express a prefix wildcard inside `dm_<owner>-<actor>-<uid>`. That operation stays on the host's
 * authenticated provisioning protocol, where the requested descendant is fresh-validated before
 * an exact one-shot grant is used. */
function remoteManagerPermissions(
  space: string,
  pr: MintPrincipal,
  pin: { instanceId: string; owner: string; actor: string },
): Record<string, unknown> {
  if (pin.owner !== pr.owner)
    throw new Error(`permissionsFor: remote-manager owner ${JSON.stringify(pin.owner)} does not match the authenticated principal owner ${JSON.stringify(pr.owner)}`);
  const iid = assertLifecycleToken(pin.instanceId, "remote manager instanceId");
  const allowedActors = new Set([`manager_${iid}`, `manager_exec_${iid}`]);
  if (!allowedActors.has(pin.actor) || pr.actor !== pin.actor)
    throw new Error(`permissionsFor: remote-manager actor must be the server-selected manager_${iid} or manager_exec_${iid} for instance ${iid}`);
  const PKV = `KV_${presenceBucket(space)}`;
  const MKV = `KV_${managerBucket(space)}`;
  const AUTH = epAuthBucket(space);
  const REC = recordsBucket(space);
  const gateKey = epgateKey("manager", iid);
  const credPrefix = epcredFamilyPrefix("manager", iid);
  const repairKey = eprepairKey("manager", iid);
  // The SUPERVISOR actor of the pair, which is the one that runs `Manager.start()` and therefore
  // the only one that binds the manager plane's liveness responder (`service.ts` hands
  // `credentials.supervisor` to the manager; the executor gets the instance-scoped registration
  // surface). The liveness rows below are pinned to it so the executor does not carry authority to
  // answer a probe it never serves.
  const isSupervisorActor = pin.actor === `manager_${iid}`;
  const recordKeys = [
    recordSpecKey(RECORD_KINDS.svc, ["manager", iid]),
    recordStatusKey(RECORD_KINDS.svc, ["manager", iid]),
    recordAtomicKey(GOVERN_HEAD, ["manager"]),
  ];
  return {
    pub: {
      allow: [
        "$JS.API.INFO",
        // Only the supervisor allocates names against retained transcript counts. This metadata
        // grant carries no consumer or message-body read, just like the agent CHAT info grant.
        ...(isSupervisorActor ? [`$JS.API.STREAM.INFO.${chatStream(space)}`] : []),
        // Own manager-instance lease only. The local supervisor profile spans lease.* because one
        // host manages every local instance; a remote user grant must not.
        `$JS.API.STREAM.INFO.${MKV}`,
        `$JS.API.STREAM.MSG.GET.${MKV}`,
        `$KV.${managerBucket(space)}.${MANAGER_LEASE_KEY}.${iid}`,
        // Own presence key + roster watch.
        `$KV.${presenceBucket(space)}.${principalKey(pr.owner, pr.actor).key}`,
        `$JS.API.STREAM.INFO.${PKV}`,
        `$JS.API.CONSUMER.CREATE.${PKV}.>`,
        `$JS.API.CONSUMER.INFO.${PKV}.>`,
        "$JS.FC.>",
        // This instance's manager service registration + credential family only.
        `$KV.${AUTH}.${gateKey}`,
        `$KV.${AUTH}.${repairKey}`,
        `$KV.${AUTH}.${credPrefix}.>`,
        ...recordKeys.map((key) => `$KV.${REC}.${key}`),
        `${spacePrefix(space)}.epc.*`,
        `$JS.API.DIRECT.GET.${epcStreamName(space)}.${spacePrefix(space)}.epc.>`,
        `$JS.API.DIRECT.GET.${epcStreamName(space)}`,
        `$JS.API.STREAM.MSG.GET.KV_${AUTH}`,
        `$JS.API.CONSUMER.CREATE.KV_${AUTH}.>`,
        `$JS.API.CONSUMER.INFO.KV_${AUTH}.>`,
        `$JS.API.CONSUMER.DELETE.KV_${AUTH}.>`,
        ...recordKeys.map((key) => `$JS.API.DIRECT.GET.KV_${REC}.$KV.${REC}.${key}`),
        `$JS.API.STREAM.MSG.GET.KV_${REC}`,
        // LIVENESS REPLIES for the MANAGER plane (#1577), bounded to the `.reply.` leaf under a
        // caller's own request subject — the same row and the same bound as the local supervisor
        // profile holds.
        //
        // WHY THIS PROFILE NEEDS IT AT ALL. `Manager.start()` binds the manager plane's liveness
        // responder unconditionally, and a remote manager runs the same `start()` under this
        // credential. Without the serve subscription below the bind is denied, and a peer probing
        // the manager plane then gets the broker's own no-responders answer, which this surface
        // grades `unbound` — a definite verdict about the plane, produced by a gap in a credential,
        // while the remote manager is bound and serving. A surface that exists to stop a failure to
        // find out being rendered as a finding must not render its own missing grant as one.
        //
        // REPLIES ONLY. The row stops at the leaf, so a remote manager cannot publish to the
        // liveness REQUEST subjects and therefore cannot forge a probe that appears to come from a
        // peer, exactly as the supervisor row cannot.
        ...(isSupervisorActor ? [livenessReplyGrant(space, "manager")] : []),
      ],
    },
    sub: {
      allow: [
        `_INBOX_${pr.connId}.>`,
        // The manager-plane liveness SERVE filter (#1577): `live.manager.*.*`, queue-grouped, so a
        // credentialed peer's presence probe reaches this instance. A serve subscription on a
        // presence-only rail and not a widening of what a remote manager may read: the request body
        // is empty and the subject carries only the caller's own principal. The MANAGER plane only —
        // this credential cannot serve `delivery`, so each plane still answers for itself.
        ...(isSupervisorActor ? [livenessServeFilter(space, "manager")] : []),
      ],
    },
  };
}

/** The human-CLI OPERATOR permission set — the ephemeral key the headless
 *  client commands mint (`cotal send dm|msg|ask`, `cotal dm`, `personas list --running`, via
 *  `openTransient`). It does exactly what those do: POST as itself (chat/DM/anycast — self-scoped, can
 *  never forge another actor), and READ the public roster (presence) + the channel registry to resolve a
 *  name→id and a channel's delivery class. Much narrower than the old broad `manager`: NO serve-control,
 *  NO DM/DLV body read, NO chat-history read, NO stream CREATE/DELETE/PURGE, NO ACL write, NO lease, NO
 *  provisioning. A leaked operator cred can post as itself and read the roster — the same surface as the
 *  human who ran the command. (The interactive `cotal join` console — chat read + own-DM receive — is a
 *  separate, fuller surface, deferred: it needs the unprovisioned-console DM self-create fixed first.) */
function operatorPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  const PKV = `KV_${presenceBucket(space)}`, CHKV = `KV_${channelBucket(space)}`;
  return {
    pub: {
      allow: [
        // Post AS itself only — self-scoped (owner+actor), so a leaked operator cred can never forge a
        // message attributable to another principal.
        chatSubject(space, pr.owner, pr.actor, ">"), // chat.<o>.<a>.>  — multicast any channel as me
        unicastSubject(space, "*", "*", pr.owner, pr.actor), // inst.*.*.<o>.<a> — DM any peer as me
        anycastSubject(space, "*", pr.owner, pr.actor), // svc.*.<o>.<a>   — anycast any role as me
        `$KV.${presenceBucket(space)}.${principalKey(pr.owner, pr.actor).key}`, // own presence key only
        "$JS.API.INFO",
        // Presence read (name→id resolution + the roster). The transient endpoint reads the bucket once
        // with a batched Direct Get, whose request subject is the bare stream (#4091); the consumer rows
        // serve a watch. No STREAM.MSG.GET.
        `$JS.API.STREAM.INFO.${PKV}`,
        `$JS.API.DIRECT.GET.${PKV}`,
        `$JS.API.CONSUMER.CREATE.${PKV}.>`,
        `$JS.API.CONSUMER.INFO.${PKV}.>`,
        // Channel registry read — the transient endpoint reads it once (batched Direct Get), multicast
        // reads a channel's delivery class, and `channels list` scans it. Read-only (no `$KV.<channel>`
        // write — that's the provisioner).
        `$JS.API.STREAM.INFO.${CHKV}`,
        `$JS.API.DIRECT.GET.${CHKV}`,
        `$JS.API.STREAM.MSG.GET.${CHKV}`,
        // Keyed KV get rides `DIRECT.GET.<stream>.$KV.<bucket>.<key>` — the key is in the SUBJECT, so
        // the grant needs the trailing `.>` (unlike STREAM.MSG.GET, which carries it in the payload).
        `$JS.API.DIRECT.GET.${CHKV}.>`,
        `$JS.API.CONSUMER.CREATE.${CHKV}.>`,
        `$JS.API.CONSUMER.INFO.${CHKV}.>`,
        "$JS.FC.>", // ordered-consumer flow control
      ],
    },
    // Own reply inbox only (presence/channel watch ordered-consumer delivery + any request replies land
    // here). NO chat/inst/dlv native sub — the operator posts and reads the roster, it receives no feed.
    sub: { allow: [`_INBOX_${pr.connId}.>`] },
  };
}

/** Connect-only PROBE — the liveness/auth preflight (`preflight.ts preflightTarget`, minted on
 *  ~every CLI command that resolves a mesh). `probeConnect` opens a connection to prove the broker is up
 *  and the creds are accepted, then closes it — it performs NO pub/sub. So the tightest possible grant:
 *  deny ALL publish, subscribe only to the own reply inbox. A leaked probe cred can open a socket and do
 *  nothing else. (Was the broad `manager` cred — minted on nearly every command, the worst over-grant.) */
function probePermissions(pr: MintPrincipal): Record<string, unknown> {
  return { pub: { deny: [">"] }, sub: { allow: [`_INBOX_${pr.connId}.>`] } };
}

/** CHANNEL-WRITER — edits the channel registry ONLY: `cotal channels set/default` and the
 *  `spawn -f` new-channel seed (`seedChannelRegistry`). It VALUE-writes `$KV.<channelBucket>` (a channel's
 *  config key) and read-before-writes it. NO stream data, NO other bucket, NO chat/DM — a leaked
 *  channel-writer can only rewrite channel config, never post, read a body, or tear a stream down. */
function channelWriterPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  const CHKV = `KV_${channelBucket(space)}`;
  return {
    pub: {
      allow: [
        "$JS.API.INFO",
        `$KV.${channelBucket(space)}.>`, // create/update/delete a channel config key
        `$JS.API.STREAM.INFO.${CHKV}`, // kvm.open/create existence check
        `$JS.API.STREAM.CREATE.${CHKV}`, // kvm.create is create-if-matching (bucket already exists post-up)
        // read-before-write: kvm.open rides STREAM.MSG.GET; kvm.create (direct=true) rides keyed DIRECT.GET.
        `$JS.API.STREAM.MSG.GET.${CHKV}`,
        `$JS.API.DIRECT.GET.${CHKV}.>`,
      ],
    },
    sub: { allow: [`_INBOX_${pr.connId}.>`] },
  };
}

/** CHANNEL-PURGER — the `cotal web` dashboard's ONLY write path: delete a channel
 *  (`clearChannel` = filtered `STREAM.PURGE.CHAT` to drop the channel's messages + a `$KV.<channelBucket>`
 *  key delete). Pre-minted once by `web` so the account signing seed falls out of scope; the dashboard's
 *  READ side runs on the separate read-only `admin` cred. = channel-writer + the scoped CHAT purge. */
function channelPurgerPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  const CHKV = `KV_${channelBucket(space)}`;
  // `clearChannel` only kvm.OPENs the (already-created) bucket, key-deletes, and purges — it never
  // kvm.creates, so — unlike channel-writer's set/default back-compat path — this cred gets NO
  // `STREAM.CREATE`. Compose the shared channel-KV read + delete verbs + the scoped CHAT purge explicitly.
  return {
    pub: {
      allow: [
        "$JS.API.INFO",
        `$KV.${channelBucket(space)}.>`, // delete the channel's registry key
        `$JS.API.STREAM.INFO.${CHKV}`, // kvm.open existence check
        `$JS.API.STREAM.MSG.GET.${CHKV}`, // read-before-delete
        `$JS.API.DIRECT.GET.${CHKV}.>`,
        `$JS.API.STREAM.PURGE.${chatStream(space)}`, // drop the channel's chat messages
      ],
    },
    sub: { allow: [`_INBOX_${pr.connId}.>`] },
  };
}

/** TEARDOWN — `cotal down -f` space teardown. The space-wide cred that keeps `STREAM.DELETE` (the
 *  tamper verb). `down -f` is multi-step: `connectProbe` (presence-watch + channel-registry read)
 *  → invoke the manager's `ps` + any-mode `despawn` over the ep rails to politely stop the managed
 *  agents → `readMembership` (the membership-feed read that keeps an owned channel another member
 *  still uses) → `deleteChannels`
 *  (channel-registry key delete + CHAT purge) → `deleteSpace` (STREAM.DELETE every owned stream/bucket).
 *  So it reads state, CALLS admin control, deletes channels, and deletes streams — but NEVER reads a
 *  DM/DLV body, posts chat, or forges. Isolated here so no standing operator/provisioner/supervisor cred
 *  can delete a stream; a leaked teardown can wipe a space you own + stop its agents (that IS its job),
 *  nothing else. Minted ephemerally per teardown from the local trust material (same-checkout `down -f`). */
function teardownPermissions(space: string, pr: MintPrincipal, transferStreams: string[]): Record<string, unknown> {
  // The ep-rail mirror of the admin deploy tier: teardown reads `ps` and stops owned agents
  // it did not spawn (any-mode despawn) - the admin instrument set. Lifecycle-keyed, so a uid is
  // required at mint (fail-loud).
  const ep = instrumentEpRows(space, pr, "admin");
  const CHAT = chatStream(space);
  const PKV = `KV_${presenceBucket(space)}`, CHKV = `KV_${channelBucket(space)}`;
  const MSHIP = `KV_${membershipBucket(space)}`;
  const RECORDS = `KV_${recordsBucket(space)}`;
  // The deletion path and the exact per-stream grants use one target list. Reject any caller-
  // supplied transfer name that is not this space's transfer bucket before minting the grant.
  for (const name of transferStreams)
    if (!isTransferStream(space, name)) throw new Error(`permissionsFor: teardown transferStreams names ${JSON.stringify(name)}, not one of ${space}'s transfer streams`);
  const del = spaceDeletionStreams(space, transferStreams)
    .flatMap((s) => [`$JS.API.STREAM.INFO.${s}`, `$JS.API.STREAM.DELETE.${s}`]);
  return {
    pub: {
      allow: [
        "$JS.API.INFO",
        BROKER_USER_INFO_SUBJECT, // confirm the current teardown connection's account before native impact reads
        // deleteSpace() enumerates the transfer streams (one per manager instance that received a
        // carried resume) by name shape; their names are not derivable from the space alone.
        "$JS.API.STREAM.NAMES",
        // connectProbe read: presence watch (name→id + roster) + channel registry read.
        `$JS.API.CONSUMER.CREATE.${PKV}.>`,
        `$JS.API.CONSUMER.INFO.${PKV}.>`,
        `$JS.API.STREAM.MSG.GET.${CHKV}`,
        `$JS.API.DIRECT.GET.${CHKV}.>`,
        `$JS.API.CONSUMER.CREATE.${CHKV}.>`,
        `$JS.API.CONSUMER.INFO.${CHKV}.>`,
        // readMembership's one-pass scan of the feed (its STREAM.INFO is in `del`). No `$KV` publish:
        // only `membership-rw` writes the feed.
        // Batched snapshots read the same feed as the watch below, without a consumer.
        `$JS.API.DIRECT.GET.${MSHIP}`,
        `$JS.API.CONSUMER.CREATE.${MSHIP}.>`,
        `$JS.API.CONSUMER.INFO.${MSHIP}.>`,
        // Space deletion names the workflow runs it removes by their status records: a non-fencing
        // direct get confined to run status keys (§13.9), on a stream this grant may already delete.
        `$JS.API.DIRECT.GET.${RECORDS}.$KV.${recordsBucket(space)}.run.*.*.status`,
        "$JS.FC.>", // ordered-consumer flow control
        // Stop the managed agents over the v0.4 ep rails only (ps + any-mode despawn) — the admin
        // instrument set. The manager `ctl` rail is deleted.
        ...ep.pub,
        ...del,
        // deleteChannels/clearChannel: purge the channel's chat messages + delete its registry key.
        `$JS.API.STREAM.PURGE.${CHAT}`,
        `$KV.${channelBucket(space)}.>`,
      ],
    },
    // Own inbox (connectProbe presence-watch delivery + JS API responses) + the ep reply rail (the
    // ps + any-mode despawn calls reply there). The `ctl.admin.<id>.reply.>` subtree is gone.
    sub: { allow: [`_INBOX_${pr.connId}.>`, ...ep.sub] },
  };
}

/** MEMBERSHIP-STORE-RECREATE — explicit conversion of the derived membership feed from File to
 * Memory. The credential can inspect and delete exactly that one stream. It cannot create the
 * replacement, read membership values, or touch another stream; the ordinary short-lived
 * provisioner creates and verifies the empty Memory replacement after deletion. */
function membershipStoreRecreatePermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  const stream = `KV_${membershipBucket(space)}`;
  return {
    pub: {
      allow: [
        "$JS.API.INFO",
        `$JS.API.STREAM.INFO.${stream}`,
        `$JS.API.STREAM.DELETE.${stream}`,
      ],
    },
    sub: { allow: [`_INBOX_${pr.connId}.>`] },
  };
}

/** ISSUED-STORE-RECREATE — `cotal up --recreate-issued-stores`, and an embedder's call of
 *  `removeIssuedStoresBeforeRetention`: back up, then delete, the two issued-authority stores of ONE
 *  space that predate bounded retention. Exactly `STREAM.INFO`, `STREAM.SNAPSHOT` and
 *  `STREAM.DELETE` on those two streams, the snapshot's delivery inside its own inbox, and the
 *  snapshot ACK subjects of those two streams ({@link snapshotAckGrant}). Nothing reads a row,
 *  writes a store or reaches another stream. */
function issuedStoreRecreatePermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  return {
    pub: {
      allow: [
        "$JS.API.INFO",
        ...issuedStoreStreamNames(space).flatMap((s) => [`$JS.API.STREAM.INFO.${s}`, `$JS.API.STREAM.SNAPSHOT.${s}`, `$JS.API.STREAM.DELETE.${s}`, snapshotAckGrant(s)]),
      ],
    },
    sub: { allow: [`_INBOX_${pr.connId}.>`] },
  };
}

/** CONTROL-CALLER (ep rails only) — the operator's lifecycle commands
 *  (`cotal ps/start/stop/attach`, `manager/commands.ts`). It invokes the manager's v0.4 service
 *  endpoint and reads the bounded reply on the ep reply rail. That is ALL — no `$JS`, no `$KV`,
 *  no chat/DM: it forges nothing, reads no body.
 *
 *  The tiers stay SPLIT because the BROKER grant is load-bearing: an any-mode
 *  despawn/attach row *is* cross-agent reach — the manager maps mode `any` to its admin
 *  authorization path, so which ROWS an instrument holds is the tier boundary. Therefore:
 *   • `control-caller-privileged` (ps/start) holds the manager reads + untargeted `spawn` +
 *     `define-persona` — structurally barred from cross-agent ops (no any-mode row). This is the
 *     high-frequency path; it never needs admin reach.
 *   • `control-caller-admin` (stop/attach) adds the any-mode despawn/attach rows + the
 *     `manager.admin` family — it genuinely needs cross-agent reach. Its containment is the
 *     broker gating the any-mode rows + the cred being ephemeral (mint → one request →
 *     disconnect, from the local signing seed); on a user mesh the manager's serve-time ledger
 *     re-check sits on top. */
function controlCallerPermissions(space: string, pr: MintPrincipal, epTier: "privileged" | "admin", opts: MintOpts = {}): Record<string, unknown> {
  // The manager `ctl` rail is gone — an operator instrument holds ONLY its v0.4 ep rows (the
  // tier-matched request set, the reply rail, describe, the one epc fetch). The `epTier` selects
  // privileged (ps/start reads) vs admin (any-mode stop/attach) exactly as the ctl tier did.
  //
  // `--on <instanceId>`: these instruments are ONE-SHOT, minted per control call, and the
  // resolve that pins the instance happens BEFORE the mint. So the caller can hand the exact
  // instance id down and get the exact `ep.inst.<endpoint>.<iid>.<command>` row for THIS invocation
  // and nothing else — the least-privilege issuance, with no standing wildcard anywhere. The
  // `extra` seam is the same one the deployer's owner-equality `launch` row already rides, and the
  // emitter's `if (cap.instanceId)` branch validates the token, so a malformed id fails loud at
  // mint rather than widening a subject.
  const ep = instrumentEpRows(space, pr, epTier, opts.endpointCapabilities ?? [], opts);
  return {
    // The PRIVILEGED tier (the `cotal ps` instrument) also carries the SCOPED §13.9 records read the
    // class scatter's freeze rides: `freezeExpectedSet` enumerates `svc.<endpoint>.*.spec`
    // and LEADER-reads each frozen slot's svc spec/status before it scatters `ps` on the `all` rail.
    // The admin tier (stop/attach) never scatters, so it gets no records read.
    pub: { allow: epTier === "privileged" ? [...ep.pub, ...scatterFreezeReadRows(space)] : ep.pub },
    sub: { allow: [`_INBOX_${pr.connId}.>`, ...ep.sub] },
  };
}

/** The SCOPED §13.9 records-read rows the class-scatter freeze rides (`cotal ps`): the
 *  `svc.*` enumeration consumer + the leader-served per-slot spec/status read of the endpoint's
 *  `svc` registry — a READ of exactly the service-registration keys, no write, no other bucket.
 *  The keyed Direct Get is subject-PINNED to `svc.>`; the enumeration consumer
 *  and the leader `STREAM.MSG.GET` are STREAM-scoped because the requested key rides the PAYLOAD
 *  (which a subject grant cannot narrow) — the SAME NAMED RESIDUAL every records reader already
 *  accepts (the provisioner, the lifecycle/serve executors): for this EPHEMERAL one-shot instrument's
 *  lifetime it can READ (never write) any records-store row — registration metadata, no secrets. */
function scatterFreezeReadRows(space: string): string[] {
  const REC = recordsBucket(space);
  return [
    // The `svc.<e>.*.spec` enumeration is a `STREAM.INFO` carrying a `subjects_filter` — ONE
    // read-only metadata verb. It replaced a `kv.keys()` that rode an ordered ephemeral consumer and
    // therefore needed CONSUMER.CREATE/INFO/DELETE on this bucket: three consumer-lifecycle verbs to
    // list keys, on a credential that only ever wanted to read them.
    //
    // MEASURED, not assumed: with the enumeration converted and this row absent, the static/operator
    // `cotal ps` is refused on `$JS.API.STREAM.INFO.KV_<records>` — a path that works today. The
    // conversion and this row land TOGETHER or the operator path regresses.
    `$JS.API.STREAM.INFO.KV_${REC}`,
    // The per-slot spec/status reads (`freezeExpectedSet` + the registration reconcile) are
    // leader-served `STREAM.MSG.GET` — stream-scoped (NAMED RESIDUAL above), plus the subject-pinned
    // keyed Direct Get form for any direct-aware read path (scoped to the `svc.` registry prefix).
    `$JS.API.STREAM.MSG.GET.KV_${REC}`,
    `$JS.API.DIRECT.GET.KV_${REC}.$KV.${REC}.svc.>`,
  ];
}

/** The v0.4 ep-rail rows of an operator INSTRUMENT credential: the tier-matched
 *  {@link operatorInstrumentCapabilities} request rows + the caller's reply rail, the wildcard
 *  `describe` form, and the ONE subject-scoped §13.7 contract-store fetch row (the same shape the
 *  agent baseline holds). No ctl row exists, so these ARE the instrument. The caller triple pins the instrument's own mint-time lifecycle uid
 *  ({@link MintPrincipal.lifecycleUid}) — REQUIRED here: without it the reply rail cannot be pinned
 *  and the mint fails loud rather than emit a triple-less (unfenced) caller surface. `extra` lets a
 *  profile append its tier-refined additions (the user-mode deployer's owner-equality `launch`). */
function instrumentEpRows(
  space: string,
  pr: MintPrincipal,
  tier: "privileged" | "admin",
  extra: EpCapability[] = [],
  opts: MintOpts = {},
): { pub: string[]; sub: string[] } {
  if (!pr.lifecycleUid)
    throw new Error(`permissionsFor: an operator instrument's ep caller rows are lifecycle-keyed (SPEC 13.1/13.2) - mint with opts.lifecycleUid (mintLifecycleUid()) so the reply rail pins the instrument's own incarnation`);
  const epCaller: EpCaller = issuedCallerFor({ owner: pr.owner, actor: pr.actor, uid: pr.lifecycleUid }, opts);
  const rows = epCallerGrantRows(space, [...operatorInstrumentCapabilities(tier, pr.owner), ...extra], epCaller);
  return {
    pub: [
      epDescribeAllGrantRow(space, epCaller),
      `$JS.API.DIRECT.GET.${epcStreamName(space)}.${spacePrefix(space)}.epc.>`,
      ...(opts.issued ? [acceptedReadGrant(space, opts.issued.acceptedToken)] : []),
      ...rows.pub,
    ],
    sub: rows.sub,
  };
}

/** The ep caller a mint pins: the triple, plus the issued generation when the mint is an
 *  issuance (SPEC 13.15). One place decides the rail so a credential's request rows, its reply
 *  read, and its describe row all land on the same one. */
function issuedCallerFor(triple: EpCaller, opts: MintOpts): EpCaller {
  if (!opts.issued) return triple;
  assertGeneration(opts.issued.acceptedToken, "acceptedToken");
  return { ...triple, generation: assertGeneration(opts.issued.generation) } as IssuedCaller;
}

/** The rows a listing generation adds to a legacy-rail credential (SPEC 13.15, "Listing
 *  issuance"): the registry's `endpoints` request publish and its reply subscribe on `ep.v1`, and
 *  the per-key read of the generation's accepted row. Exactly these: one caller value emits one
 *  rail, so these are the only `ep.v1` rows such a credential holds. */
export function listingGrantRows(space: string, caller: EpCaller, listing: ListingBinding): { pub: string[]; sub: string[] } {
  if (isIssuedCaller(caller)) throw new Error("listingGrantRows: an issued caller lists under its own generation");
  assertGeneration(listing.acceptedToken, "acceptedToken");
  const issued = { owner: caller.owner, actor: caller.actor, uid: caller.uid, generation: assertGeneration(listing.generation) } as IssuedCaller;
  return {
    pub: [...epRequestGrantRows(space, REGISTRY_ENDPOINTS_GRANT, issued), acceptedReadGrant(space, listing.acceptedToken)],
    sub: [epCallerReplyFilter(space, issued)],
  };
}

/** ENDPOINT-SERVE (v0.4, SPEC §13.9 "Serve grants") — the per-instance serve credential:
 *  EXACTLY the instance's registered rails and nothing else. Subscribe: the queue-qualified
 *  class rail, the plain scatter rail, and the own-instance rail for the FULL registered
 *  command set plus the derived `describe`, and the own epoch-pinned timer-fire subjects;
 *  publish: the epoch-pinned egress (reply / `epe` events / `ept` schedule requests / `epr`
 *  record-write ingress) plus, from the branded snapshot only, the §13.9 bind rows: the shared
 *  `eff_<e>` effects bind iff the surface is journal-class and each owned `pool_<e>_<pool>`
 *  bind (bind-only + `$JS.API.INFO`; an ephemeral-only poolless endpoint emits none). No agent
 *  baseline of any kind — no chat/DM/anycast/presence/ctl, no broad `$JS.>`. The value MUST be the
 *  branded ARTIFACT `authorizeServeGrant` returned, and its mint context binds: same space, and
 *  the minted principal is the registered owner. This builds the ROWS; the RELEASE fence is the
 *  durable issuance-gate CAS `mintCreds` runs (SPEC §13.1) — a raw/copied/diverging value or a
 *  foreign space/principal refuses here, and a stale incarnation loses the gate CAS. */
function endpointServePermissions(space: string, pr: MintPrincipal, opts: MintOpts): Record<string, unknown> {
  if (!opts.endpointServe)
    throw new Error("permissionsFor: endpoint-serve requires opts.endpointServe (the authorized serve artifact)");
  // The fence is INSEPARABLE from serve-row emission: a serve credential's rows are only ever
  // valid when released behind the §13.1 issuance CAS, so this builder refuses to emit them
  // without the gate seam — closing the exported-permissionsFor bypass where a direct signer
  // could obtain unfenced serve rows past the brand/space/owner check. `mintCreds` runs the CAS.
  if (!opts.serveIssuance)
    throw new Error("permissionsFor: endpoint-serve requires opts.serveIssuance (serve rows are emitted only behind the §13.1 issuance fence; mintCreds runs its CAS before release)");
  const snap = assertServeGrantMintable(opts.endpointServe, { space, holderOwner: pr.owner });
  // Rail subscribe rows cover the EPHEMERAL commands only (journal commands ride epj, never the
  // request rails) + the derived describe; the descriptor surface stays full. The class comes
  // from the brand-verified artifact surface, not the caller.
  const ephemeralCommands = snap.commands.filter((cmd) => opts.endpointServe!.surface[cmd].class === "ephemeral");
  const rows = epServeGrantRows(space, {
    endpoint: snap.endpoint, instanceId: snap.instanceId, epoch: snap.epoch, ephemeralCommands,
  });
  // §13.9 bind rows, from the BRANDED snapshot only (journal class is registered truth,
  // pools are the authorizing provisioner's pre-created durables): a journal-class instance
  // binds the shared `eff_<e>` effects durable, a pool-owning one binds each owned
  // `pool_<e>_<pool>` — all bind-only (INFO/MSG.NEXT/ACK, never create/delete), plus the one
  // `$JS.API.INFO` a pull consumer needs. An ephemeral-only poolless endpoint emits NONE of
  // these rows (default-deny both directions).
  const bindRows: string[] = [];
  if (snap.journalClass) bindRows.push(...effectsBindGrants(space, snap.endpoint));
  for (const pool of snap.pools) bindRows.push(...poolOwnerBindGrants(space, snap.endpoint, pool));
  if (bindRows.length > 0) bindRows.push("$JS.API.INFO");
  return {
    pub: { allow: [...rows.pub, ...bindRows] },
    sub: { allow: [...rows.sub, `_INBOX_${pr.connId}.>`] },
  };
}

/** DEPLOYER — the `cotal spawn -f` manifest-deploy authority. `spawn -f` drives ONE
 *  `connectProbe` endpoint that both READS live state (roster/presence watch, channel registry,
 *  membership feed, manager-singleton lease) AND invokes the running manager's `launch` + `ps`
 *  readiness over the v0.4 ep rails. Those interleave on one connection, so a strict 3-connection
 *  split would only refactor `live.ts` for marginal gain; `deployer` is that one coherent,
 *  ephemeral deploy cred. It is the SOLE profile that combines reads + admin-control — NOT a template a
 *  4th command should reach for (revisit the connection split before adding a second such caller).
 *
 *  Boundaries (all enforced by omission / default-deny): NO self-post (`chat`/`inst`/`svc`), NO `$JS.>`,
 *  NO `STREAM.DELETE`/`PURGE`/`UPDATE`, NO DM/DLV/TASK `CONSUMER.CREATE` (no body-read surface), NO `$KV`
 *  writes (channel seeding rides a SEPARATE `channel-writer` cred). It holds the admin INSTRUMENT ep
 *  set (any-mode despawn/attach + the manager.admin family + reads) because manifest launch/ps
 *  genuinely need cross-agent reach — and that IS real power: the manager's any-mode authz is
 *  subject-gated (the any-mode ep row is mintable only under operator policy), so holding it lets it
 *  stop/attach/launch ANY agent. The BROKER gating that row is the boundary. Containment is therefore
 *  the LIFETIME, not a manager re-check: minted from LOCAL same-checkout auth for one `spawn -f`,
 *  memory-only, dropped after deploy. If it is ever persisted, handed to user-supplied `--creds`, or
 *  reused as a general "read + admin" cred, revisit. */
function deployerPermissions(space: string, pr: MintPrincipal, epTier: "privileged" | "admin" = "admin", opts: MintOpts = {}): Record<string, unknown> {
  // The v0.4 ep rows of the deploy authority: static (admin) deploys carry the admin instrument
  // set; the user-mode deployer VIEW (privileged) carries the privileged set PLUS an untargeted
  // `launch` row — its launch stays owner-equality-authorized (the manager's ledger-derived admin
  // flag is false for a spawn-scoped deployer), exactly the v0.3 user-mode privileged-tier launch.
  // `--on`: the per-invocation pin APPENDS to this profile's standing set, never replaces it -
  // the privileged deployer view keeps its owner-equality `launch` row and additionally gets the one
  // exact `ep.inst.<endpoint>.<iid>.<command>` row for the instance this deploy resolved.
  const pinned = opts.endpointCapabilities ?? [];
  const ep = epTier === "admin"
    ? instrumentEpRows(space, pr, "admin", pinned, opts)
    : instrumentEpRows(space, pr, "privileged", [{ endpoint: BASELINE_LIFECYCLE_ENDPOINT, command: "launch" }, ...pinned], opts);
  const PKV = `KV_${presenceBucket(space)}`, CHKV = `KV_${channelBucket(space)}`;
  const MSHIP = `KV_${membershipBucket(space)}`, MGRKV = `KV_${managerBucket(space)}`;
  const DLVKV = `KV_${deliveryBucket(space)}`;
  // Read verbs for a KV bucket SCANNED/WATCHED via an ordered consumer (presence, channel registry, and
  // the membership feed — `readMembership` enumerates keys via `kv.keys()`): existence + kv.get (both
  // STREAM.MSG.GET and keyed DIRECT.GET forms) + the ordered consumer. NO `$KV.<bucket>` publish → no write.
  const kvScan = (bucket: string) => [
    `$JS.API.STREAM.INFO.${bucket}`,
    `$JS.API.STREAM.MSG.GET.${bucket}`,
    `$JS.API.DIRECT.GET.${bucket}.>`,
    `$JS.API.CONSUMER.CREATE.${bucket}.>`,
    `$JS.API.CONSUMER.INFO.${bucket}.>`,
  ];
  // A KV bucket read by a KEYED point-get only (`readManagerLease` = kvm.open + `kv.get(LEASE_KEY)`, no
  // scan/watch): existence + kv.get, but NO ordered-consumer verbs (nothing enumerates or watches it).
  const kvPointRead = (bucket: string) => [
    `$JS.API.STREAM.INFO.${bucket}`,
    `$JS.API.STREAM.MSG.GET.${bucket}`,
    `$JS.API.DIRECT.GET.${bucket}.>`,
  ];
  return {
    pub: {
      allow: [
        "$JS.API.INFO",
        ...kvScan(PKV), // presence watch — roster + name→id
        ...kvScan(CHKV), // channel registry read (readChannelRegistry + classifyChannels)
        ...kvScan(MSHIP), // membership FEED read (readMembership → detectUnmanagedActors) — the membership_ bucket
        ...kvPointRead(MGRKV), // manager-singleton lease keyed read (waitManagerReady) — point-get, NO write, NO watch
        ...kvPointRead(DLVKV), // delivery-lease keyed read (preserve-state quiescence proof) — point-get, NO write, NO watch
        "$JS.FC.>", // ordered-consumer flow control
        // Launch + ps readiness ride the v0.4 ep rows only (the manager `ctl` rail is gone).
        // Static deploys carry the admin instrument set; the user-mode deployer VIEW carries the
        // privileged set + an owner-equality `launch` row (the manager's ledger-derived admin flag
        // is false for a spawn-scoped deployer, so its launch stays owner-equality-authorized).
        ...ep.pub,
      ],
    },
    // Own inbox (presence/registry watch delivery + JS API responses) + the ep reply rail.
    sub: { allow: [`_INBOX_${pr.connId}.>`, ...ep.sub] },
  };
}

/** The ephemeral PURGER permission set — minted per-purge inside the daemon's
 *  `opPurge` and `cotal history clear`. Isolates the DESTRUCTIVE history-purge grant
 *  (`STREAM.PURGE.CHAT` + `STREAM.PURGE.DM`) off the always-on supervisor: `--dms` purges the DM stream,
 *  exactly the grant the supervisor must not hold. It PURGES but never READS — no DM/chat consumer, no
 *  `MSG.GET` — so a leaked purger can drop history but cannot read a body. Short-lived (one purge call). */
function purgerPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
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
function provisionerPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
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
  const streamSetup = [CHAT, DM, TASK, INBOX, DLV, eventPayloadStream(space), OBJ, ...endpointPlaneStreamNames(space), ...buckets].flatMap((s) => [
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
function issuerPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
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
function registryReaderPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
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
function runAdmitterPermissions(space: string, pr: MintPrincipal, pin: NonNullable<MintOpts["runAdmitter"]>): Record<string, unknown> {
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
function lifecycleExecutorPermissions(
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
function goalWriterPermissions(space: string, pr: MintPrincipal, pin: { endpoint: string }): Record<string, unknown> {
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
function sessionCallerPermissions(space: string, pr: MintPrincipal, pin: { endpoint: string; sessionId: string; epoch: number } | undefined): Record<string, unknown> {
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
function dmReaderPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
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
function sessionServingPermissions(space: string, pr: MintPrincipal, pin: { endpoint: string; sessionId: string; epoch: number } | undefined): Record<string, unknown> {
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
function sessionLedgerPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
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
function endpointServeExecutorPermissions(
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
function deprovisionerPermissions(space: string, pr: MintPrincipal, deprovisionTarget: DeprovisionTarget): Record<string, unknown> {
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
function deliveryPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
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
function membershipRwPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
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
function membershipObserverPermissions(accountId: string): Record<string, unknown> {
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
function connectionEvictorPermissions(): Record<string, unknown> {
  return {
    pub: { allow: ["$SYS.REQ.SERVER.*.KICK"] },
    // Request/reply KICK replies land on the client's default inbox; no other subscription — it
    // serves nothing and reads no feed.
    sub: { allow: ["_INBOX.>"] },
  };
}

export { INSTRUMENT_PROFILES, connectionEvictorPermissions, endpointServePermissions, membershipObserverPermissions };
