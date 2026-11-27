// The per-profile permission builders `permissionsFor` composes, moved verbatim from
// provision-permissions.ts. Each returns one profile's NATS permission object. provision-permissions.ts
// re-exports the ones other modules import, so their import paths are unchanged.
import { spaceDeletionStreams } from "./space-deletion-targets.js";
import { BROKER_USER_INFO_SUBJECT } from "./broker-identity.js";
import { spacePrefix, chatSubject, principalKey, unicastSubject, anycastSubject, controlServiceSubject, CONTROL_DELIVERY_ADMIN, chatStream, presenceBucket, channelBucket, assertLifecycleToken, membershipBucket, deliveryBucket, managerBucket, MANAGER_LEASE_KEY, MANAGER_RENEWAL_LEASE_KEY, livenessServeFilter, livenessReplyGrant, isTransferStream } from "./subjects.js";
import { epCallerGrantRows, epServeGrantRows, baselineCallerCapabilities, spawnCallerCapabilities, runCallerCapabilities, epRequestGrantRows, operatorInstrumentCapabilities, personSeatCapabilities, instanceOnlyManagerCapabilities, epDescribeAllGrantRow, epPrincipalOwnerGrantRows, BASELINE_LIFECYCLE_ENDPOINT, MANAGER_VITALS_COMMAND, MANAGER_VITALS_SCOPE, type EpCapability } from "./endpoint-grants.js";
import { assertServeGrantMintable } from "./endpoint-service.js";
import { effectsBindGrants, poolOwnerBindGrants, epAuthBucket, epcStreamName } from "./endpoint-binding.js";
import { epCallerReplyFilter, assertGeneration, isIssuedCaller, type EpCaller, type IssuedCaller } from "./endpoint-subjects.js";
import { acceptedReadGrant, issuedStoreStreamNames, type ListingBinding } from "./issued-authority.js";
import { REGISTRY_ENDPOINTS_GRANT } from "./registry-contract.js";
import { recordsBucket, recordSpecKey, recordStatusKey, recordAtomicKey, RECORD_KINDS, GOVERN_HEAD } from "./endpoint-records.js";
import { epgateKey, epcredFamilyPrefix, eprepairKey } from "./lifecycle-state.js";
import { snapshotAckGrant } from "./backup.js";
import type { MintOpts, MintPrincipal } from "./provision-jwt.js";

/** The launch commands a spawn-scoped manager-caller view carries on its one pinned instance. A
 * launch reads `status` (execution mode and connectors), `models` (their catalogs), `resolve-cwd`
 * (canonical directory), `list-dir` (directory navigation) and `harness-commands` (what a harness
 * offers in that directory), and makes the folder it starts in with `make-dir` or `clone`. `ps`
 * lists the caller's own agents: the Manager bounds it to the caller's owner unless the caller
 * holds admin. The standing spawn set carries none of them, because it reaches every manager in
 * the space through the class rail. */
const SPAWN_VIEW_COMMANDS = Object.freeze(["status", "models", "resolve-cwd", "list-dir", "harness-commands", "make-dir", "clone", "ps"] as const);

/** The reads a person's own manager view carries whatever their scope (SPEC 13.21): `inspect`
 * resolves a seat's name before every seat command, and `ps` lists their agents. The Manager bounds
 * both to the caller's owner unless the caller holds admin. */
const PERSON_VIEW_READS = Object.freeze(["inspect", "ps"] as const);

/** The person's caller of their agents' `agent` endpoints on a static space (SPEC 13.21): its inbox,
 *  the `owner` row for each command the agent cluster admits with that word, and the reply read. It
 *  holds no presence, channel or serve row. No agent mint carries these rows, and the auth callout
 *  never mints this profile: a signed-in person holds them from an interactive ledger row. */
export function agentCallerPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  if (pr.readerId !== undefined)
    throw new Error("permissionsFor(agent-caller): only a static mint makes it; a signed-in person calls their agents from an interactive ledger row (SPEC 13.21)");
  if (!pr.lifecycleUid)
    throw new Error("permissionsFor(agent-caller): a lifecycleUid is required: the caller rows name it (SPEC 13.21)");
  const own = epPrincipalOwnerGrantRows(space, { owner: pr.owner, actor: pr.actor, uid: assertLifecycleToken(pr.lifecycleUid) });
  return { pub: { allow: own.pub }, sub: { allow: [`_INBOX_${pr.connId}.>`, ...own.sub] } };
}

/** One seat's manager control view. It carries no agent messaging or delivery surface, and every
 * manager request, including describe, is pinned to one exact registered instance. */
export function managerCallerPermissions(space: string, pr: MintPrincipal, opts: MintOpts): Record<string, unknown> {
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
    ...(caps.includes("spawn") ? SPAWN_VIEW_COMMANDS.map((command) => ({ endpoint: BASELINE_LIFECYCLE_ENDPOINT, command })) : []),
    ...(caps.includes(MANAGER_VITALS_SCOPE) ? [{ endpoint: BASELINE_LIFECYCLE_ENDPOINT, command: MANAGER_VITALS_COMMAND }] : []),
    ...(caps.includes("run") ? runCallerCapabilities(pr.owner) : []),
    ...(caps.includes("admin") ? operatorInstrumentCapabilities("admin", pr.owner) : []),
    // A person controls the agents under their own owner (SPEC 13.21), keyed on the ledger row's
    // kind.
    ...(opts.ledgerKind === "interactive"
      ? [...personSeatCapabilities(pr.owner), ...PERSON_VIEW_READS.map((command) => ({ endpoint: BASELINE_LIFECYCLE_ENDPOINT, command }))]
      : []),
  ];
  const caller = issuedCallerFor({ owner: pr.owner, actor: pr.actor, uid: assertLifecycleToken(pr.lifecycleUid) }, opts);
  // The sets overlap on one instance (a person's rows and the spawn set, admin and spawn), and a
  // subject is minted once.
  const rows = epCallerGrantRows(space, instanceOnlyManagerCapabilities(ordinary, instanceId), caller);
  rows.pub = [...new Set(rows.pub)];
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
export function supervisorPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
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
export function remoteManagerPermissions(
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
export function operatorPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
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
export function probePermissions(pr: MintPrincipal): Record<string, unknown> {
  return { pub: { deny: [">"] }, sub: { allow: [`_INBOX_${pr.connId}.>`] } };
}

/** CHANNEL-WRITER — edits the channel registry ONLY: `cotal channels set/default` and the
 *  `spawn -f` new-channel seed (`seedChannelRegistry`). It VALUE-writes `$KV.<channelBucket>` (a channel's
 *  config key) and read-before-writes it. NO stream data, NO other bucket, NO chat/DM — a leaked
 *  channel-writer can only rewrite channel config, never post, read a body, or tear a stream down. */
export function channelWriterPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
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
export function channelPurgerPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
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
export function teardownPermissions(space: string, pr: MintPrincipal, transferStreams: string[]): Record<string, unknown> {
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
export function membershipStoreRecreatePermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
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
export function issuedStoreRecreatePermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
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
export function controlCallerPermissions(space: string, pr: MintPrincipal, epTier: "privileged" | "admin", opts: MintOpts = {}): Record<string, unknown> {
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
export function issuedCallerFor(triple: EpCaller, opts: MintOpts): EpCaller {
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
export function endpointServePermissions(space: string, pr: MintPrincipal, opts: MintOpts): Record<string, unknown> {
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
export function deployerPermissions(space: string, pr: MintPrincipal, epTier: "privileged" | "admin" = "admin", opts: MintOpts = {}): Record<string, unknown> {
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

export {
  purgerPermissions,
  provisionerPermissions,
  issuerPermissions,
  registryReaderPermissions,
  runAdmitterPermissions,
  lifecycleExecutorPermissions,
  goalWriterPermissions,
  sessionCallerPermissions,
  dmReaderPermissions,
  sessionServingPermissions,
  sessionLedgerPermissions,
  endpointServeExecutorPermissions,
  deprovisionerPermissions,
  deliveryPermissions,
  membershipRwPermissions,
  membershipObserverPermissions,
  connectionEvictorPermissions,
} from "./provision-service-permissions.js";
