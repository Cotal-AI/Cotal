import { spaceQuiescenceReaderGrants } from "./space-quiescence-resources.js";
import { eventPayloadReadSubjects, eventPayloadStream, eventPayloadSubject } from "./event-payloads.js";
import { EVENT_CHANNEL_PREFIX } from "./event-channel.js";
import { spacePrefix, chatSubject, assertValidChannel, principalKey, assertInboxConnId, unicastSubject, anycastSubject, controlServiceSubject, CONTROL_DELIVERY, CONTROL_DELIVERY_ADMIN, chatStream, dmStream, taskStream, dlvStream, chatHistDurable, historyReaderConsumer, HISTORY_READERS, dmDurable, taskDurable, dlvDurable, presenceBucket, presenceKeySubject, channelBucket, assertLifecycleToken, membershipBucket, deliveryBucket, livenessSubject, takeSubject } from "./subjects.js";
import { LIVENESS_PLANES } from "./liveness.js";
import { epCallerGrantRows, epBaselineGrantRows, spawnCallerCapabilities, runCallerCapabilities, epRequestGrantRows, epPrincipalServeGrantRows, epPrincipalOwnerGrantRows, operatorInstrumentCapabilities, epDescribeAllGrantRow } from "./endpoint-grants.js";
import { epcStreamName } from "./endpoint-binding.js";
import { epCallerReplyFilter, AUTH_ENDPOINT, EP_CMD_RETIRE_LIFECYCLE, type EpCaller } from "./endpoint-subjects.js";
import { acceptedReadGrant } from "./issued-authority.js";
import { REGISTRY_ENDPOINTS_GRANT } from "./registry-contract.js";
import { runDriverGrants, runMediatorGrants, runOperatorGrants } from "./run-driver-grants.js";
import { transferReaderGrants, transferWriterGrants } from "./transfer.js";
import { environmentManagerPermissions, isEnvironmentManagerProfile } from "./environment-manager-grants.js";
import { backupProfilePermissions, restoreProfilePermissions } from "./backup.js";
import type { MintOpts, MintPrincipal } from "./provision-jwt.js";
import { managerCallerPermissions, supervisorPermissions, remoteManagerPermissions, operatorPermissions, probePermissions, channelWriterPermissions, channelPurgerPermissions, teardownPermissions, membershipStoreRecreatePermissions, issuedStoreRecreatePermissions, controlCallerPermissions, issuedCallerFor, listingGrantRows, deployerPermissions, purgerPermissions, provisionerPermissions, issuerPermissions, registryReaderPermissions, runAdmitterPermissions, lifecycleExecutorPermissions, goalWriterPermissions, sessionCallerPermissions, dmReaderPermissions, sessionServingPermissions, sessionLedgerPermissions, endpointServeExecutorPermissions, deprovisionerPermissions, deliveryPermissions, membershipRwPermissions } from "./provision-permission-builders.js";


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
    if (profile !== "agent" && profile !== "manager-caller")
      throw new Error(`permissionsFor: ledgerKind marks an agent or manager-caller mint of a ledger row, not "${profile}" (SPEC 13.21)`);
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
  const payloadReaders = Array.from({ length: HISTORY_READERS }, (_, i) => historyReaderConsumer(pr.readerId ?? pr.connId, i));
  pubAllow.push(
    `$JS.API.STREAM.INFO.${PAYLOAD}`,
    ...payloadReaders.flatMap(name => [
      ...payloadReads.map(subject => `$JS.API.CONSUMER.CREATE.${PAYLOAD}.${name}.${subject}`),
      `$JS.API.CONSUMER.INFO.${PAYLOAD}.${name}`,
      `$JS.API.CONSUMER.MSG.NEXT.${PAYLOAD}.${name}`,
      `$JS.API.CONSUMER.DELETE.${PAYLOAD}.${name}`,
    ]),
  );
  // A person reads the event channels of every agent under their own owner (SPEC 13.21), keyed on
  // the ledger row's kind: live, and from history through this lifecycle's own `chathist_` reader,
  // whose info, fetch and delete rows are above. Only an agent publishes on its own event channel,
  // so the sender's owner is pinned to the person's too. Their payloads already ride the own-owner
  // read above.
  if (opts.ledgerKind === "interactive") {
    const ownEvents = chatSubject(space, pr.owner, "*", `${EVENT_CHANNEL_PREFIX}${pr.owner}.*`);
    subChat.push(ownEvents);
    pubAllow.push(`$JS.API.CONSUMER.CREATE.${CHAT}.${chatHistD}.${ownEvents}`);
  }
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

export { INSTRUMENT_PROFILES };
export { connectionEvictorPermissions, endpointServePermissions, membershipObserverPermissions, listingGrantRows } from "./provision-permission-builders.js";
