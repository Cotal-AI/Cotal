/**
 * The provisioner — the signer capability for a space.
 *
 * A space is one NATS *account*; every agent is a *user* in it. This module mints the
 * decentralized-JWT trust chain (operator → account → user) programmatically with
 * `@nats-io/jwt`, so there is no dependency on the external `nsc` CLI and the signing
 * key stays in one place (whoever holds {@link SpaceAuth.account.signingSeed}).
 *
 * Demo-1 stage: out-of-band mint. `cotal up` creates the space's trust material
 * once and writes a `nats-server` config (operator + system account + MEMORY resolver);
 * `cotal mint` and the manager load that material and mint per-agent creds files. There
 * is no connect-time token exchange yet (that's the later auth-callout stage).
 *
 * NOT yet provided (our job, not nsc's): credential revocation and an issuance audit
 * trail. Revocation is deferred past Demo 1; minted creds currently have no TTL.
 */
import { join } from "node:path";
import {
  encodeOperator,
  encodeAccount,
  encodeUser,
  fmtCreds,
} from "@nats-io/jwt";
import { createOperator, createAccount, fromPublic, fromSeed } from "@nats-io/nkeys";
import {
  token,
  spacePrefix,
  chatSubject,
  assertValidChannel,
  channelInAllow,
  unicastSubject,
  anycastSubject,
  controlServiceSubject,
  CONTROL_PRIVILEGED,
  CONTROL_SELF_SERVICE,
  CONTROL_ADMIN,
  CONTROL_DELIVERY,
  chatStream,
  dmStream,
  taskStream,
  dlvStream,
  inboxStream,
  chatHistDurable,
  dmDurable,
  taskDurable,
  dlvDurable,
  presenceBucket,
  channelBucket,
  membersBucket,
  aclBucket,
  membershipBucket,
  deliveryBucket,
  managerBucket,
  MANAGER_LEASE_KEY,
  connzRequestSubject,
  accountConnectSubject,
  accountDisconnectSubject,
  MEMBERSHIP_INBOX_PREFIX,
  FANOUT_DURABLE,
  INBOX_READER_DURABLE,
} from "./subjects.js";
import type { Identity } from "./identity.js";

/** Cred profiles (per the plan's class table). Demo-1 mints all permissively; steps 5–7
 *  scope each one — at which point the manager MUST already hold its own privileged
 *  profile (broad: pre-create others' DM durables, serve ctl), not "agent", or it
 *  silently loses those powers the moment "agent" is tightened. */
export type Profile =
  | "agent"
  | "observer"
  | "admin"
  | "manager"
  | "supervisor"
  | "provisioner"
  | "operator"
  | "purger"
  | "delivery"
  | "membership-rw";

/** A space's persisted trust material. The `signingSeed` is the sensitive provisioner
 *  secret; everything else is public (JWTs) or recoverable. The system-account `signingSeed` is the ONE
 *  field {@link saveSpaceAuth} never writes to disk — it lives only in memory, just long enough at `cotal
 *  up` to mint the scoped membership-observer cred (see {@link mintMembershipObserverCreds}). */
export interface SpaceAuth {
  space: string;
  operator: { seed: string; jwt: string };
  account: { pub: string; seed: string; jwt: string; signingSeed: string; signingPub: string };
  /** `signingSeed` is in-memory only (a fresh {@link createSpaceAuth}); NEVER persisted — minting a
   *  system-account user is broker-admin capability, so no standing `$SYS` seed is left on disk. */
  sys: { pub: string; jwt: string; signingSeed?: string };
}

// Unlimited account limits — without explicit limits a JWT account defaults to 0 conns
// (every connect denied). JetStream needs storage on the data account but MUST stay off
// the system account (the server refuses to start otherwise).
const BASE_LIMITS = {
  subs: -1, conn: -1, leaf: -1, imports: -1, exports: -1,
  data: -1, payload: -1, wildcards: true,
} as const;
const DATA_LIMITS = { ...BASE_LIMITS, mem_storage: -1, disk_storage: -1 };
const SYS_LIMITS = { ...BASE_LIMITS, mem_storage: 0, disk_storage: 0 };

/** Reduce a {@link SpaceAuth} to just the material a *minting* host needs: `space`,
 *  `account.pub`, and `account.signingSeed` (the only fields {@link mintCreds} reads).
 *  The operator root-of-trust, system account, and the account's own seed are blanked.
 *
 *  This is the file you hand a manager that should mint per-agent creds but must never
 *  hold the operator key — e.g. a containerized team. A leaked stripped file only lets
 *  someone mint *users within this one account*, which the account boundary already
 *  contains; it cannot mint new accounts or touch the system account. */
export function stripSpaceAuth(auth: SpaceAuth): SpaceAuth {
  return {
    space: auth.space,
    operator: { seed: "", jwt: "" },
    account: {
      pub: auth.account.pub,
      seed: "",
      jwt: "",
      signingSeed: auth.account.signingSeed,
      signingPub: "",
    },
    sys: { pub: "", jwt: "" },
  };
}

/** Generate a fresh operator → account(+signing key) → system-account chain for a space. */
export async function createSpaceAuth(space: string): Promise<SpaceAuth> {
  const okp = createOperator();
  const akp = createAccount();
  const askp = createAccount(); // account signing key — what mints users
  const syskp = createAccount();
  const sysPub = syskp.getPublicKey();

  const operatorJwt = await encodeOperator(`cotal-${token(space)}`, okp, { system_account: sysPub });
  const accountJwt = await encodeAccount(
    token(space),
    akp,
    { signing_keys: [askp.getPublicKey()], limits: DATA_LIMITS },
    { signer: okp },
  );
  const sysJwt = await encodeAccount("SYS", syskp, { limits: SYS_LIMITS }, { signer: okp });

  const dec = (u: Uint8Array) => new TextDecoder().decode(u);
  return {
    space,
    operator: { seed: dec(okp.getSeed()), jwt: operatorJwt },
    account: {
      pub: akp.getPublicKey(),
      seed: dec(akp.getSeed()),
      jwt: accountJwt,
      signingSeed: dec(askp.getSeed()),
      signingPub: askp.getPublicKey(),
    },
    // `signingSeed` carried in-memory ONLY (stripped by saveSpaceAuth) — the single window in which the
    // scoped membership-observer system-account user can be minted (see mintMembershipObserverCreds).
    sys: { pub: sysPub, jwt: sysJwt, signingSeed: dec(syskp.getSeed()) },
  };
}

/** Options shaping a minted user's permissions. */
export interface MintOpts {
  /** Read ACL — channels an "agent" MAY read (the agent file's `allowSubscribe`, already resolved
   *  by the caller). Minted as per-channel single-filter history-consumer create grants
   *  (`CONSUMER.CREATE.<CHAT>.<chathist_id>.<chat.*.ch>`) — the broker boundary on chat **history**
   *  reads (join-backfill / focus-recall). Each is run through the chat-subject builder so a
   *  wildcard subtree `team.>` becomes `chat.*.team.>`. Defaults to `["general"]`. The live read is the
   *  agent's own native `sub.allow` over `chat.*.<channel>` (also minted from this list, below). */
  allowSubscribe?: string[];
  /** Post ACL — channels an "agent" may publish to (the agent file's `allowPublish`, already
   *  resolved by the caller). Each becomes a `chat.<id>.<ch>` publish grant. **Default-deny**:
   *  omitted/empty ⇒ no chat publish grant at all — publishing must be declared. */
  allowPublish?: string[];
  /** The agent's role — scopes its TASK-queue consumer to svc_<role>. */
  role?: string;
  /** Control service the agent may address. Defaults to `"manager"`. */
  manager?: string;
  /** Capabilities declared in the agent file (e.g. `"spawn"`). A capability gates the
   *  privileged control-subject grant in {@link permissionsFor}: `spawn` → the agent may
   *  publish to the privileged control subject (start/purge/definePersona/named stop).
   *  Default-deny when absent — nats-server rejects the publish, no handler involved. */
  capabilities?: string[];
  /** Delivery-daemon shard seam (`delivery` profile only). N=1 is the only operating mode; these do
   *  not change permissions in this build (the daemon owns the whole space at N=1). Present so the
   *  N>1 follow-up is a small diff. Default `{0,1}`. */
  shard?: number;
  shards?: number;
}

/** Options for {@link provisionAgent} — {@link MintOpts} plus the active read set. */
export interface ProvisionOpts extends MintOpts {
  /** The active read set: the channels the agent subscribes to (live core-sub) at boot, and whose
   *  `durable`-class ones the agent self-joins for a Plane-3 backstop at connect (via the delivery
   *  daemon). Must be ⊆ `allowSubscribe`. Defaults to `["general"]`. */
  subscribe?: string[];
  /** Record this agent's read ACL so it can participate in durable delivery (default true). A durable
   *  backstop needs the agent's read ACL in the registry — the server-side delivery daemon re-authorizes
   *  every durable entry against it — written here at provision. Set FALSE for a LIVE-ONLY launcher
   *  (e.g. a direct foreground `cotal spawn` with no durable intent): no ACL row is written, so the daemon
   *  refuses to authorize a durable backstop and the agent stays live-only. Boot durable MEMBERSHIP itself
   *  is not written here — the agent self-joins its durable channels via the daemon's `ctl.delivery` op at
   *  connect. */
  durableMembership?: boolean;
}

/** The privileged onboarding ops a launcher needs at spawn — implemented by a connected, permissive
 *  endpoint (the manager at `cotal start`/`cotal up`, or a short-lived provisioner that `cotal spawn`
 *  opens). It pre-creates the agent's own mailboxes and records its read ACL; it does NOT host Plane-3
 *  delivery (that is the server-side delivery daemon). */
export interface DurableProvisioner {
  provisionDmInbox(id: string): Promise<void>;
  /** Pre-create the agent's bind-only Plane-3 DELIVER durable (`dlv_<id>`, filtered to `dlv.<id>`) so
   *  it can BIND its per-member durable handoff without holding CONSUMER.CREATE on the DLV stream. */
  provisionDlvInbox(id: string): Promise<void>;
  /** Record the agent's read ACL (`allowSubscribe`) in the durable ACL registry — the same act as
   *  baking it into the JWT, persisted so the **server-side delivery daemon** can re-authorize the
   *  agent's durable entries and validate its runtime durable-joins (it holds no in-memory ledger).
   *  Replaces the old manager-written boot membership: boot durable membership is now the agent
   *  SELF-JOINING its durable channels via the daemon's `ctl.delivery` op at connect. */
  commitAcl(id: string, allowSubscribe: string[]): Promise<void>;
  provisionTaskQueue(role: string): Promise<void>;
}

/** Onboard an agent for launch (auth mode): pre-create its bind-only DM (+ Plane-3 DELIVER + role
 *  TASK) durables, RECORD its read ACL in the durable registry (unless `durableMembership:false`), and
 *  mint its scoped creds. Live delivery is the agent's own core subscription — there is no per-instance
 *  chat durable. Boot durable MEMBERSHIP is not written here: the agent self-joins its durable channels
 *  via the server-side delivery daemon's `ctl.delivery` op at connect. A live-only launcher
 *  (`durableMembership:false`, e.g. direct `cotal spawn`) gets no ACL row and stays live-only. */
export async function provisionAgent(
  provisioner: DurableProvisioner,
  auth: SpaceAuth,
  identity: Identity,
  opts: ProvisionOpts = {},
): Promise<string> {
  const subscribe = opts.subscribe?.length ? opts.subscribe : ["general"];
  const allowSubscribe = opts.allowSubscribe?.length ? opts.allowSubscribe : subscribe;
  // Reject channel names the wire layer would rewrite (the pre-created filter rides token() too).
  for (const ch of [...subscribe, ...allowSubscribe]) assertValidChannel(ch);
  // Re-assert the load-time invariant at the trust boundary (defense in depth): the pre-created
  // live filter (subscribe) must sit within the read ACL (allowSubscribe), or the provisioner
  // would hand the agent live delivery it isn't permitted to read.
  for (const ch of subscribe)
    if (!channelInAllow(allowSubscribe, ch))
      throw new Error(
        `provisionAgent: subscribe "${ch}" is not within allowSubscribe [${allowSubscribe.join(", ")}]`,
      );
  await provisioner.provisionDmInbox(identity.id);
  await provisioner.provisionDlvInbox(identity.id);
  // Record the agent's read ACL in the durable registry (the same act as baking it into the JWT) so the
  // server-side delivery daemon can re-authorize this agent's durable entries + validate its runtime
  // durable-joins — it holds no in-memory ledger. The agent SELF-JOINS its durable boot channels via the
  // daemon at connect (no manager-written boot membership). `durableMembership:false` (a live-only
  // launcher, e.g. direct `cotal spawn` with no daemon) opts out of the ACL row → the daemon never
  // authorizes a durable backstop for it, so it stays live-only.
  if (opts.durableMembership !== false) await provisioner.commitAcl(identity.id, allowSubscribe);
  if (opts.role) await provisioner.provisionTaskQueue(opts.role);
  return mintCreds(auth, identity, "agent", { ...opts, allowSubscribe });
}

/** Mint a user creds file for an agent {@link Identity} (its stable id+seed from
 *  {@link newIdentity}). The account signing key signs over ONLY the public key
 *  (`fromPublic`) — the agent seed is never part of the signature, it's only folded into
 *  the resulting creds file. The "agent" profile is scoped to publish only as itself and only to
 *  its declared `allowPublish` channels (post ACL, default-deny), and to read only within
 *  `allowSubscribe` (live tail bind-only + per-channel history grants); "manager" and "observer"
 *  stay permissive here and are scoped in steps 6–7. */
export async function mintCreds(
  auth: SpaceAuth,
  identity: Identity,
  profile: Profile,
  opts: MintOpts = {},
): Promise<string> {
  const signer = fromSeed(new TextEncoder().encode(auth.account.signingSeed));
  const perms = permissionsFor(profile, auth.space, identity.id, opts);
  const userJwt = await encodeUser(
    profile,
    fromPublic(identity.id),
    fromPublic(auth.account.pub),
    perms,
    { signer },
  );
  const creds = fmtCreds(userJwt, fromSeed(new TextEncoder().encode(identity.seed)));
  return new TextDecoder().decode(creds);
}

/** Build the NATS user permission object for a profile: a default-deny allow-list scoped to
 *  exactly what each profile does. "manager" stays permissive (the privileged provisioner
 *  host). Subject/stream/durable names come from the shared builders so the ACLs can't drift
 *  from the wire layout. */
function permissionsFor(
  profile: Profile,
  space: string,
  id: string,
  opts: MintOpts,
): Record<string, unknown> {
  if (profile === "delivery") return deliveryPermissions(space, id); // scoped server-side Plane-3 infra
  if (profile === "membership-rw") return membershipRwPermissions(space, id); // scoped graph-feed reader/writer
  if (profile === "supervisor") return supervisorPermissions(space, id); // always-on daemon (closure (ii) gate)
  if (profile === "provisioner") return provisionerPermissions(space, id); // ephemeral onboarding authority (closure (ii))
  if (profile === "purger") return purgerPermissions(space, id); // ephemeral history-purge (closure (ii))
  if (profile === "operator") return operatorPermissions(space, id); // human-CLI client (send/dm/ask) (closure (ii))
  if (profile === "manager") return managerPermissions(space, id); // scoped operator (closure (i); CLI surfaces, residual 2 follow-up)
  const CHAT = chatStream(space), DM = dmStream(space), TASK = taskStream(space);
  const KV = `KV_${presenceBucket(space)}`;
  const CHKV = `KV_${channelBucket(space)}`; // channel registry (read-only for everyone)
  const MEMKV = `KV_${membershipBucket(space)}`; // derived graph membership feed (read-only — dashboard)
  const DLVKV = `KV_${deliveryBucket(space)}`; // delivery lease/readiness (read-only — Component 6 health)
  const inbox = `_INBOX_${id}.>`;

  if (profile === "observer" || profile === "admin") {
    // Read-only: live feed via tap, history + presence via ephemeral/ordered consumers it
    // creates on CHAT + the presence KV. No chat/inst/svc/ctl publish → can't post.
    //   observer — sub chat.> only; DM_<space>/svc never named → DMs + anycast structurally
    //     invisible (step-6 inbox scoping means it can't sniff deliveries either).
    //   admin — sub widened to the whole space so the dashboard's tap also sees DMs (inst.>)
    //     and anycast (svc.>) live, PLUS DM-stream read verbs so it can backfill DM history.
    //     A deliberate god-view: DMs are plaintext + ACL-gated, so mint this only for a trusted
    //     audit dashboard. CONSUMER.CREATE on DM_<space> is the DM-confidentiality surface —
    //     granted here ONLY for this elevated read-only profile, never to agents.
    const sub =
      profile === "admin"
        ? [`${spacePrefix(space)}.>`, inbox]
        : [`${spacePrefix(space)}.chat.>`, inbox];
    const allow = [
      "$JS.API.INFO",
      `$JS.API.STREAM.INFO.${CHAT}`,
      `$JS.API.STREAM.INFO.${KV}`,
      // ephemeral backlog consumer (channelHistory): a multi-filter create can't encode its
      // filter in the subject → bare form; the .> form covers named consumers.
      `$JS.API.CONSUMER.CREATE.${CHAT}`,
      `$JS.API.CONSUMER.CREATE.${CHAT}.>`,
      `$JS.API.CONSUMER.INFO.${CHAT}.>`,
      `$JS.API.CONSUMER.MSG.NEXT.${CHAT}.>`,
      `$JS.API.CONSUMER.DELETE.${CHAT}.>`,
      `$JS.ACK.${CHAT}.>`,
      `$JS.API.CONSUMER.CREATE.${KV}.>`, // kv.watch ordered consumer (roster is public)
      `$JS.API.CONSUMER.INFO.${KV}.>`,
      // Channel registry read (watch + direct kv.get + enriched listChannels) — config is
      // world-readable. STREAM.MSG.GET is the verb kv.get() rides (the bucket has no allow_direct).
      `$JS.API.STREAM.INFO.${CHKV}`,
      `$JS.API.STREAM.MSG.GET.${CHKV}`,
      `$JS.API.CONSUMER.CREATE.${CHKV}.>`,
      `$JS.API.CONSUMER.INFO.${CHKV}.>`,
      `$JS.API.CONSUMER.DELETE.${CHKV}.>`,  // ephemeral consumer cleanup
      // Derived graph-membership feed (broker-sourced who-is-subscribed) — watch + direct kv.get. The
      // silent-reader set is sensitive, so read is admin/observer-only (this elevated profile), never an
      // agent. Read-only: no `$KV.${membershipBucket}` publish — only the `membership-rw` cred writes it.
      `$JS.API.STREAM.INFO.${MEMKV}`,
      `$JS.API.STREAM.MSG.GET.${MEMKV}`,
      `$JS.API.CONSUMER.CREATE.${MEMKV}.>`,
      `$JS.API.CONSUMER.INFO.${MEMKV}.>`,
      `$JS.API.CONSUMER.DELETE.${MEMKV}.>`,
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
        `$JS.API.CONSUMER.DELETE.${DM}.>`,
        `$JS.ACK.${DM}.>`,
      );
    }
    return { sub: { allow: sub }, pub: { allow } };
  }

  // ---- agent ----
  const allowPublish = opts.allowPublish ?? []; // post ACL — DEFAULT-DENY (publish must be declared)
  const allowSubscribe = opts.allowSubscribe?.length ? opts.allowSubscribe : ["general"]; // read ACL
  // Re-assert at the mint chokepoint (covers mint/spawn paths that bypass the file loader): a policy
  // channel must equal its wire token, or the minted grant would alias the logical ACL.
  for (const ch of [...allowSubscribe, ...allowPublish]) assertValidChannel(ch);
  const manager = opts.manager ?? CONTROL_PRIVILEGED;
  const chatHistD = chatHistDurable(id), dmD = dmDurable(id);
  const DLV = dlvStream(space), dlvD = dlvDurable(id); // Plane-3 per-member delivery (bind-only)
  const svcD = opts.role ? taskDurable(opts.role) : undefined;
  const pubAllow = [
    // peer publish — identity + channel scope, built from the real builders. Default-deny: ONLY the
    // declared allowPublish channels (none by default) get a chat-publish grant.
    ...allowPublish.map((ch) => chatSubject(space, id, ch)),
    unicastSubject(space, "*", id), //  inst.*.<id>   — DM any instance, as me
    anycastSubject(space, "*", id), //  svc.*.<id>    — anycast any role, as me
    controlServiceSubject(space, CONTROL_SELF_SERVICE, id), // ctl.self.<id> — self stop/despawn, granted to all
    // ctl.delivery.<id> — request a durable backstop join/leave/list from the SERVER-SIDE delivery
    // daemon (NOT the manager). The reply rides this same subtree (`ctl.delivery.<id>.reply.<n>`, in
    // sub.allow below) so the daemon can answer without broad inbox-publish — see CONTROL_DELIVERY.
    controlServiceSubject(space, CONTROL_DELIVERY, id),
    // JetStream control plane — scoped to this agent's own streams/durables.
    "$JS.API.INFO",
    // STREAM.INFO: CHAT (join watermark, recall drop-marker, channel-list counts — a documented
    // metadata surface, see SPEC §9) + the world-readable presence/registry KVs. NOT DM/TASK: agents
    // bind their dm_<id>/svc_<role> by name and never inspect those streams, so granting INFO there
    // would only leak DM-inbox / task subject metadata across peers for no functional gain.
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
    ...allowSubscribe.map((ch) => `$JS.API.CONSUMER.CREATE.${CHAT}.${chatHistD}.${chatSubject(space, "*", ch)}`),
    `$JS.API.CONSUMER.INFO.${CHAT}.${chatHistD}`,
    `$JS.API.CONSUMER.MSG.NEXT.${CHAT}.${chatHistD}`,
    `$JS.API.CONSUMER.DELETE.${CHAT}.${chatHistD}`,
    // DM consumer: BIND ONLY — info/fetch/ack its own pre-created durable, never create.
    `$JS.API.CONSUMER.INFO.${DM}.${dmD}`,
    `$JS.API.CONSUMER.MSG.NEXT.${DM}.${dmD}`,
    `$JS.ACK.${DM}.${dmD}.>`,
    // Plane-3 DELIVER consumer (SPEC §8): BIND ONLY its own pre-created dlv_<id> — info/fetch/ack,
    // never create (the provisioner pre-creates it filtered to dlv.<id>). The agent acks this via
    // native JetStream — the re-authorized per-member handoff. It gets NO grant on the INBOX (mixed
    // pre-auth) stream at all: default-deny keeps the fan-out target unreadable by the agent.
    `$JS.API.CONSUMER.INFO.${DLV}.${dlvD}`,
    `$JS.API.CONSUMER.MSG.NEXT.${DLV}.${dlvD}`,
    `$JS.ACK.${DLV}.${dlvD}.>`,
    // Presence: watch (read, public roster) + flow control + PUT OWN KEY ONLY.
    `$JS.API.CONSUMER.CREATE.${KV}.>`,
    `$JS.API.CONSUMER.INFO.${KV}.>`,
    "$JS.FC.>",
    `$KV.${presenceBucket(space)}.${id}`, // own presence key only — can't spoof peers
    // Channel registry: read-only (watch + direct kv.get for the join-time replay decision).
    // No `$KV.${channelBucket(space)}.*` publish — privileged-write, default-deny gives that free.
    `$JS.API.STREAM.MSG.GET.${CHKV}`,
    `$JS.API.CONSUMER.CREATE.${CHKV}.>`,
    `$JS.API.CONSUMER.INFO.${CHKV}.>`,
    // Delivery lease/readiness: READ-ONLY (kv.get) for the non-gating `cotal_channels` delivery-health
    // surface (Component 6). The lease key is daemon-availability info, like the world-readable roster;
    // NO write grant — only the `delivery` cred writes it.
    `$JS.API.STREAM.INFO.${DLVKV}`,
    `$JS.API.STREAM.MSG.GET.${DLVKV}`,
    // Manager singleton lease (`cotal_manager_<space>`): NO grant at all — an agent must never read,
    // write, or delete it. The manager (allow-all) is its only writer; an agent that could mutate the
    // lease key could DoS the supervisor (evict it / pre-create the key to block a fresh one). Safety is
    // by OMISSION (default-deny on the un-granted `KV_cotal_manager_*` stream + `$KV.cotal_manager_*.>`),
    // so do NOT add a broad `KV_*` / `$KV.<space>.>` grant that would silently re-open it.
  ];
  if (svcD) {
    // TASK consumer: BIND ONLY its own role's pre-created durable (svc_<role>). Like DM, the
    // create-time filter_subject isn't reliably ACL-constrainable, so no create path is
    // allowed — the privileged provisioner pre-creates svc_<role> filtered to svc.<role>.*.
    pubAllow.push(
      `$JS.API.CONSUMER.INFO.${TASK}.${svcD}`,
      `$JS.API.CONSUMER.MSG.NEXT.${TASK}.${svcD}`,
      `$JS.ACK.${TASK}.${svcD}.>`,
    );
  }
  if (opts.capabilities?.includes("spawn")) {
    // Spawn capability → grant the PRIVILEGED control subject (start / purge / definePersona /
    // named stop-despawn). Default-deny otherwise: the subject is simply absent from this
    // allow-list, so nats-server rejects the publish — no handler check, no deny-entry (a
    // blanket `ctl.<mgr>.>` deny would override this grant too, since NATS deny beats allow).
    // The self-service subject above is granted to all regardless of capability.
    pubAllow.push(controlServiceSubject(space, manager, id));
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
  const subChat = allowSubscribe.map((ch) => chatSubject(space, "*", ch));
  // Replies to this agent's durable join/leave/list requests ride `ctl.delivery.<id>.>` (NOT the
  // per-id _INBOX), so the scoped delivery daemon can answer without broad inbox-publish.
  const deliveryReplies = `${controlServiceSubject(space, CONTROL_DELIVERY, id)}.>`;
  // Bounded control replies (closure (i)): the manager's lifecycle tiers now reply on
  // `ctl.<tier>.<id>.reply.>` (not the per-id `_INBOX`), so each agent must subscribe the reply subtree
  // for the tiers it may call. Every agent can self-stop ⇒ always grant the self tier; the privileged
  // tier's reply is granted only with the spawn capability (which also grants the request publish above).
  // Admin is manager-only — agents never call it, so no admin reply sub.
  const controlReplies = [`${controlServiceSubject(space, CONTROL_SELF_SERVICE, id)}.reply.>`];
  if (opts.capabilities?.includes("spawn"))
    controlReplies.push(`${controlServiceSubject(space, CONTROL_PRIVILEGED, id)}.reply.>`);
  return { pub: { allow: pubAllow, deny: pubDeny }, sub: { allow: [inbox, deliveryReplies, ...controlReplies, ...subChat] } };
}

/** The long-lived SUPERVISOR permission set (closure (ii), residual 2) — the always-on manager daemon
 *  (`manager.ts` `this.ep`), carved down from the former allow-all `manager`. THIS is the cred whose
 *  STANDING breadth was the residual-2 gate: tightening it removes the always-on DM/DLV body-read AND the
 *  stream-admin tamper from the one connection that never goes away. It does exactly three things — serve
 *  the three lifecycle control tiers (bounded replies), hold the singleton manager lease, and publish +
 *  watch presence (the roster) — and nothing else. Provisioning (DM/DLV/TASK consumer-create + ACL
 *  writes) moves to the EPHEMERAL `provisioner` (opened per-spawn); destructive history-purge moves to the
 *  EPHEMERAL `purger`. So the supervisor holds NO chat/inst/svc publish (it never posts — only
 *  `setActivity`, a presence write), NO DM/DLV read of any kind (no consumer-create, no native sub), NO
 *  stream CREATE/DELETE/PURGE/UPDATE, NO channel-registry access (the daemon sets `watchChannels:false`).
 *  `$JS` is an ENUMERATED allow-list — exactly the presence-watch + lease-KV verbs — never `$JS.>`. A
 *  leaked supervisor cred can hold/serve control and read the public roster; it cannot read a DM, forge an
 *  actor, provision, purge, or tamper with a stream. */
function supervisorPermissions(space: string, id: string): Record<string, unknown> {
  const PKV = `KV_${presenceBucket(space)}`, MKV = `KV_${managerBucket(space)}`;
  // The three SERVED lifecycle tiers (manager.ts serveControl): subscribe `ctl.<tier>.*` (queue-grouped)
  // and reply on the bounded `ctl.<tier>.<caller>.reply.<uuid>` subtree. Plain NATS request/reply — no
  // `$JS.ACK` for control replies (panel blocker #6).
  const tiers = [CONTROL_PRIVILEGED, CONTROL_SELF_SERVICE, CONTROL_ADMIN];
  const ctlServe = tiers.map((t) => controlServiceSubject(space, t, "*")); // ctl.<tier>.*
  const ctlReplies = tiers.map((t) => `${controlServiceSubject(space, t, "*")}.reply.>`);
  return {
    pub: {
      allow: [
        "$JS.API.INFO",
        // Singleton manager lease (managerBucket, pre-created at `cotal up`): OPEN-ONLY bind + CAS the one
        // lease key (acquire/renew/release) + read it. NO STREAM.CREATE (pre-created), DELETE, or PURGE.
        `$JS.API.STREAM.INFO.${MKV}`,
        `$JS.API.STREAM.MSG.GET.${MKV}`, // readManagerLease + CAS-conflict kv.get (auth-mode kvm.open ⇒ MSG.GET)
        `$KV.${managerBucket(space)}.${MANAGER_LEASE_KEY}`, // the SINGLE lease key (create/update/delete = $KV publishes)
        // Presence: publish OWN key + watch the roster. Own key only (no peer-key forge — residual 3); no
        // presence-stream purge/delete (no force-offline tamper). No presence kv.get (roster is the in-memory
        // watch cache + sweep), so no STREAM.MSG.GET on presence.
        `$KV.${presenceBucket(space)}.${id}`,
        `$JS.API.STREAM.INFO.${PKV}`,
        `$JS.API.CONSUMER.CREATE.${PKV}.>`, // kv.watch ordered consumer (roster)
        `$JS.API.CONSUMER.INFO.${PKV}.>`,
        "$JS.FC.>", // ordered-consumer flow control
        // Control: reply to any caller on each SERVED tier (bounded). It SERVES (does not call), so no
        // request-publish grant and no position-1 wildcard.
        ...ctlReplies,
      ],
    },
    sub: {
      // Own reply inbox + the three served control tiers (queue-grouped). NO chat/inst/dlv native sub (the
      // supervisor reads no feed), NO broad `$JS.>`/`$KV.>` (the residual-2 read/admin path is gone).
      allow: [`_INBOX_${id}.>`, ...ctlServe],
    },
  };
}

/** The human-CLI OPERATOR permission set (closure (ii), residual 2) — the ephemeral key the headless
 *  client commands mint (`cotal send dm|msg|ask`, `cotal dm`, `personas list --running`, via
 *  `openTransient`). It does exactly what those do: POST as itself (chat/DM/anycast — self-scoped, can
 *  never forge another actor), and READ the public roster (presence) + the channel registry to resolve a
 *  name→id and a channel's delivery class. Much narrower than the old broad `manager`: NO serve-control,
 *  NO DM/DLV body read, NO chat-history read, NO stream CREATE/DELETE/PURGE, NO ACL write, NO lease, NO
 *  provisioning. A leaked operator cred can post as itself and read the roster — the same surface as the
 *  human who ran the command. (The interactive `cotal join` console — chat read + own-DM receive — is a
 *  separate, fuller surface, deferred: it needs the unprovisioned-console DM self-create fixed first.) */
function operatorPermissions(space: string, id: string): Record<string, unknown> {
  const PKV = `KV_${presenceBucket(space)}`, CHKV = `KV_${channelBucket(space)}`;
  return {
    pub: {
      allow: [
        // Post AS itself only — self-scoped, so a leaked operator cred can never forge a message
        // attributable to another actor.
        chatSubject(space, id, ">"), // chat.<id>.>  — multicast any channel as me
        unicastSubject(space, "*", id), // inst.*.<id>  — DM any peer as me
        anycastSubject(space, "*", id), // svc.*.<id>   — anycast any role as me
        `$KV.${presenceBucket(space)}.${id}`, // own presence key (when a caller registers; own key only)
        "$JS.API.INFO",
        // Presence watch (name→id resolution + the live roster) — read-only ordered consumer. No
        // STREAM.MSG.GET (the roster is the in-memory watch cache).
        `$JS.API.STREAM.INFO.${PKV}`,
        `$JS.API.CONSUMER.CREATE.${PKV}.>`,
        `$JS.API.CONSUMER.INFO.${PKV}.>`,
        // Channel registry read — the transient endpoint opens+watches it, and multicast reads a
        // channel's delivery class. Read-only (no `$KV.<channel>` write — that's the provisioner).
        `$JS.API.STREAM.INFO.${CHKV}`,
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
    sub: { allow: [`_INBOX_${id}.>`] },
  };
}

/** The ephemeral PURGER permission set (closure (ii), residual 2) — minted per-purge inside the daemon's
 *  `opPurge` and `cotal history clear`. Isolates the DESTRUCTIVE history-purge grant
 *  (`STREAM.PURGE.CHAT` + `STREAM.PURGE.DM`) off the always-on supervisor: `--dms` purges the DM stream,
 *  exactly the grant the supervisor must not hold. It PURGES but never READS — no DM/chat consumer, no
 *  `MSG.GET` — so a leaked purger can drop history but cannot read a body. Short-lived (one purge call). */
function purgerPermissions(space: string, id: string): Record<string, unknown> {
  const CHAT = chatStream(space), DM = dmStream(space);
  return {
    pub: {
      allow: [
        "$JS.API.INFO", // jetstreamManager bootstrap; STREAM.PURGE needs no prior STREAM.INFO
        `$JS.API.STREAM.PURGE.${CHAT}`, // clearSpaceHistory chat purge
        `$JS.API.STREAM.PURGE.${DM}`, // clearSpaceHistory includeDms — the isolated DM-purge grant
      ],
      // NOTE: this profile does NOT cover `clearChannel` (web/`down -f` channel-delete) — that also does a
      // `$KV.<channelBucket>.<ch>` registry delete this cred lacks; it stays on the broad operator/CLI cred.
    },
    sub: { allow: [`_INBOX_${id}.>`] },
  };
}

/** The ephemeral PROVISIONER permission set (closure (ii), residual 2) — the onboarding authority,
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
 *  cred is MEMORY-ONLY (never written to `.cotal`); short-`exp`/revocation is the auth-callout follow-up.
 *
 *  `$JS` is an ENUMERATED allow-list, never `$JS.>`: STREAM.CREATE + INFO for the space streams/buckets,
 *  DM/DLV/TASK consumer CREATE/DURABLE.CREATE/INFO — and deliberately NO `MSG.NEXT`/`MSG.GET`/`ACK` on
 *  DM/DLV (it creates the bind-only mailbox but never reads it), NO STREAM.DELETE/PURGE/UPDATE/MSG.DELETE
 *  (it provisions, it does not tear down or tamper). KV value-writes are scoped to exactly the two
 *  registries provisioning touches: the read-ACL bucket (`commitAcl`) and the channel registry (seed). */
function provisionerPermissions(space: string, id: string): Record<string, unknown> {
  const CHAT = chatStream(space), DM = dmStream(space), TASK = taskStream(space);
  const INBOX = inboxStream(space), DLV = dlvStream(space);
  // Every backing stream the provisioner pre-creates — the 5 message streams + the KV buckets (a bucket's
  // backing stream is `KV_<bucket>`). `managerBucket` is now pre-created here too (so the supervisor binds
  // its lease open-only); members/membership/delivery are written by other creds but created at setup here.
  const buckets = [
    presenceBucket, channelBucket, membersBucket, aclBucket, membershipBucket, deliveryBucket, managerBucket,
  ].map((b) => `KV_${b(space)}`);
  // STREAM.CREATE + INFO for each (idempotent setup at `cotal up`; CREATE is create-if-matching, INFO covers
  // the client's existence checks). NO DELETE/PURGE/UPDATE — provisioning never tears a stream down.
  const streamSetup = [CHAT, DM, TASK, INBOX, DLV, ...buckets].flatMap((s) => [
    `$JS.API.STREAM.CREATE.${s}`,
    `$JS.API.STREAM.INFO.${s}`,
  ]);
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
        ...streamSetup,
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
      ],
    },
    // Replies only: every stream/consumer/KV-create PubAck and JS API response lands on the per-id inbox.
    // NO chat/inst/dlv/ctl subscription — the provisioner never serves control nor reads any feed.
    sub: { allow: [`_INBOX_${id}.>`] },
  };
}

/** The privileged OPERATOR permission set (`manager` profile) — formerly allow-all (`{}`). The
 *  `manager` cred is the space's privileged operator, minted with a FRESH identity at ~12 sites:
 *  `cotal up` (create the streams + KV buckets, write channel defaults), `cotal spawn` and the
 *  supervisor (pre-create each agent's DM/DLV/TASK durables, record its read ACL, run lifecycle),
 *  `cotal history`/`web` (read + purge), the operator-facing senders `cotal send` / the `cotal join`
 *  console / `demo` / `feedback` (which post chat/inst/svc AS the operator), and the long-lived manager
 *  (serve the three control tiers + hold the singleton lease + publish presence). `CotalEndpoint` pins
 *  `card.id` to the cred's own identity (it throws on a mismatch), so "as the operator" always means as
 *  THIS `id`. Plane-3 is NOT the manager's job (manager.ts) — the server-side `delivery` daemon hosts it.
 *
 *  closure (i) — peer-MESSAGE actor-forgery and presence-VALUE forgery are CLOSED here; the dead Plane-3
 *  inject grants are removed. The STREAM-ADMIN tamper class and DM/DLV body-read are NOT closed — both
 *  ride the broad `$JS.>` (+ broad `sub`) left below, folded into the single residual stated after:
 *   • PUB is an enumerated, SELF-SCOPED list — it may post chat/inst/svc only as `id`, never as another
 *     actor (proven by a cross-owner forge-deny smoke). Expressible after migrating the three control
 *     tiers to BOUNDED replies (`ctl.<tier>.<caller>.reply.>` via `boundReply`), which removed the
 *     per-id-`_INBOX` reply target that had forced a position-1 publish wildcard.
 *   • `$KV.>` is SCOPED to exactly the buckets the operator VALUE-writes — own presence key ONLY (no peer
 *     roster spoof), the manager lease, the agent read-ACL registry, the channel registry. A peer's
 *     presence VALUE can't be forged (key-pinned) nor key-deleted (`kv.delete/purge(peerkey)` is a
 *     `$KV.<presence>.<peerkey>` publish — denied), and a `deny` blocks whole-stream PURGE / per-message
 *     MSG.DELETE of the presence stream. The read-side `applyPresence` guard additionally drops a record
 *     whose KV key != `card.id` — defense-in-depth (corrupt/mis-keyed rejection), NOT the spoof boundary
 *     (the write-scope is). (Was: blanket `$KV.>` ⇒ forge any agent's presence value.)
 *   • The legacy Plane-3 FALLBACK grants (`${p}.dinbox.*` / `${p}.dlv.*` / `ctl.delivery.*.reply.>`) are
 *     REMOVED — they were a true sender-FORGE (the `dlv.<recipient>` subject names the receiver, so the
 *     body's `from` can't be subject-checked) kept only for a manager-hosted Plane-3 that no longer
 *     exists; the `delivery` cred owns those writes + serves `ctl.delivery` (deliveryPermissions).
 *
 *  THE residual gate before the human-owner cutover is the broad `$JS.>` + broad `sub` below — ONE
 *  over-grant with TWO faces (mesh-panel review of 062ef58/9261076 caught face (b)):
 *   (a) DM/DLV body READ. The `CONSUMER.MSG.NEXT` / `STREAM.MSG.GET` denies shut the JS pull/direct-get
 *       path, but the broad `sub` `${p}.>` natively reads every `inst.*`/`dlv.*` LIVE, and `$JS.>` leaves
 *       a `CONSUMER.CREATE` push-consumer bypass on DM/DLV.
 *   (b) STREAM-ADMIN tamper. `$JS.>` still allows `STREAM.DELETE` / `STREAM.UPDATE` (and snapshot/restore)
 *       on EVERY KV stream — `KV_<presence>` (delete the bucket ⇒ wipe the roster, an availability tamper
 *       the value-scope + purge/msg-delete deny + `applyPresence` do NOT catch), and likewise
 *       `KV_<acl>`/`KV_<channel>`/`KV_<members>`. It can't be closed by more targeted denies, because
 *       `cotal down` (deleteSpace) legitimately STREAM.DELETEs those buckets through this SAME profile.
 *   Both close the same way: the provisioner role-split (move DM/DLV durable pre-creation + the ACL writes
 *   off the long-lived manager) + REPLACE broad `$JS.>` with an enumerated per-stream JS-API allow-list +
 *   tighten `sub` to {own inbox + served control}. That forces splitting the chat-reading operator
 *   surfaces (`cotal join`/`send`/`history`) and the teardown surface (`cotal down`, which keeps
 *   STREAM.DELETE) onto their own profiles — the next slice. A leaked long-lived manager can also still
 *   rewrite any actor's read-ACL (`$KV.<aclBucket>.>`); that ACL-write moves to the provisioner too. */
function managerPermissions(space: string, id: string): Record<string, unknown> {
  const p = spacePrefix(space);
  const DM = dmStream(space), DLV = dlvStream(space);
  // Reply-publish grants for every control tier the manager SERVES (bounded replies ride
  // `ctl.<tier>.<caller>.reply.>`): exactly the three lifecycle tiers (manager.ts serveControl). The
  // manager does NOT serve `ctl.delivery` — that is the delivery daemon (endpoint.ts) — so no grant here.
  const ctlReplies = [CONTROL_PRIVILEGED, CONTROL_SELF_SERVICE, CONTROL_ADMIN].map(
    (tier) => `${controlServiceSubject(space, tier, "*")}.reply.>`,
  );
  return {
    pub: {
      allow: [
        // Post AS the operator ONLY — self-scoped, so a leaked/compromised manager cred can never forge
        // a chat/DM/anycast message attributable to another actor (the closure-(i) gate).
        chatSubject(space, id, ">"), //  chat.<id>.>   — any channel, as me
        unicastSubject(space, "*", id), //  inst.*.<id>   — DM any instance, as me
        anycastSubject(space, "*", id), //  svc.*.<id>    — anycast any role, as me
        // Account-scoped JetStream administration: create/consume/ack/purge streams + consumers, create
        // KV buckets, manage durables. DM/DLV body reads are carved back out in `deny`. (Residual (2):
        // `$JS.>` still grants DM/DLV CONSUMER.CREATE — the push-consumer read bypass — closed by the next
        // slice's provisioner role-split, not here.)
        "$JS.>",
        // KV DATA writes — SCOPED to exactly the buckets the operator writes (was a blanket `$KV.>`):
        //   • own presence key ONLY — can't spoof a peer's roster identity (closure (i) residual (3));
        //   • the singleton manager lease + the agent read-ACL registry (commitAcl at provision);
        //   • the channel registry (seeded at `cotal up`, edited by channel admin / `down -f`).
        // It writes NO members/membership/delivery bucket — those are the delivery + membership-rw creds.
        `$KV.${presenceBucket(space)}.${id}`,
        `$KV.${managerBucket(space)}.>`,
        `$KV.${aclBucket(space)}.>`,
        `$KV.${channelBucket(space)}.>`,
        // Control: CALL any lifecycle tier as self (the request subject), plus reply to any requester on
        // every SERVED tier (bounded `.reply.>`). No position-1 wildcard needed.
        controlServiceSubject(space, CONTROL_PRIVILEGED, id),
        controlServiceSubject(space, CONTROL_SELF_SERVICE, id),
        controlServiceSubject(space, CONTROL_ADMIN, id),
        ...ctlReplies,
      ],
      deny: [
        // No DM/DLV body reads via the JS pull path. CONSUMER.CREATE on these stays allowed (the operator
        // pre-creates the bind-only durables) — but it must never consume or fetch their bodies. The
        // trusted reader reads INBOX/`dinbox`, never DM/DLV, so denying these breaks no operator role.
        `$JS.API.CONSUMER.MSG.NEXT.${DM}.>`,
        `$JS.API.CONSUMER.MSG.NEXT.${DLV}.>`,
        `$JS.API.STREAM.MSG.GET.${DM}`,
        `$JS.API.STREAM.MSG.GET.${DLV}`,
        // No force-offline tamper of a peer's presence. The write-scoping above stops a value FORGE, but
        // `$JS.>` would still let the operator PURGE / MSG.DELETE the presence KV stream — and a resulting
        // DEL/PURGE drives every watcher's `markOffline`, dropping the peer from all rosters (the read-side
        // `applyPresence` guard never sees a delete). The manager never purges individual presence keys
        // (its own offline is a `$KV` publish; `cotal down` rides STREAM.DELETE; ACL/member purges are
        // `$KV`-level, not stream purges), so denying these closes the tamper with no operator-role cost.
        `$JS.API.STREAM.PURGE.KV_${presenceBucket(space)}`,
        `$JS.API.STREAM.MSG.DELETE.KV_${presenceBucket(space)}`,
      ],
    },
    sub: {
      // Account-scoped observe (operator/observer + the JS/KV-write arrival fixtures) plus its reply
      // inboxes. Broad by design FOR NOW — narrowing `sub` to {own inbox + served control subjects} lands
      // together with the provisioner role-split (residual (2)), since the broad `sub` is itself a DM/DLV
      // read path.
      allow: [`${p}.>`, "$JS.>", "$KV.>", "_INBOX.>", `_INBOX_${id}.>`],
    },
  };
}

/** The scoped `delivery` daemon permission set (server-side Plane-3 infra; NEVER allow-all, never
 *  minted for an agent — `cotal mint` excludes it, like `manager`). Least-privilege: exactly what the
 *  fan-out writer + trusted reader + activation catch-up + membership/ACL reads + members-KV writes +
 *  the lease + the `ctl.delivery` control service touch. `sub.allow` is the per-identity inbox (all JS
 *  pull delivery / KV-watch / request replies land there) PLUS the `ctl.delivery` control subtree it
 *  serves; ALL stream/KV reads ride the JS API (publishes), so there is NO native `chat`/`dinbox`/`dlv`
 *  subscription — a leaked cred can't natively sniff the mixed pre-auth store. Honest blast radius
 *  (delivery-daemon.md): it can write any owner's `dlv` (the post-auth store agents trust); the future
 *  fan-out/reader cred split bounds that. */
function deliveryPermissions(space: string, id: string): Record<string, unknown> {
  const p = spacePrefix(space);
  const CHAT = chatStream(space), INBOX = inboxStream(space), DLV = dlvStream(space);
  const PKV = `KV_${presenceBucket(space)}`, CHKV = `KV_${channelBucket(space)}`;
  const MKV = `KV_${membersBucket(space)}`, AKV = `KV_${aclBucket(space)}`, DKV = `KV_${deliveryBucket(space)}`;
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
    "$JS.FC.>", // ordered-consumer flow control
    // Reads: presence (@mention resolve) + channel registry (delivery class) + members + ACL (re-auth).
    ...kvRead(PKV), ...kvRead(CHKV), ...kvRead(MKV), ...kvRead(AKV),
    // Members-KV WRITE — the daemon is the durable-membership authority (join/leave/activate/catch-up).
    `$KV.${membersBucket(space)}.>`,
    // Delivery lease/readiness KV: read the bucket (renew CAS) + write ONLY lease keys.
    `$JS.API.STREAM.INFO.${DKV}`, `$JS.API.STREAM.MSG.GET.${DKV}`,
    `$KV.${deliveryBucket(space)}.lease.*`,
    // Plane-3 data writes: dinbox (fan-out target) + dlv (post-auth handoff) for ANY owner.
    `${p}.dinbox.*`, `${p}.dlv.*`,
    // ctl.delivery control REPLIES ONLY (requests arrive on the sub below; the daemon only ever
    // m.respond()s to a requester's reply subject `ctl.delivery.<id>.reply.<n>`). Scoped to the
    // `.reply.>` leaf so the daemon can't publish to the request subjects themselves — tighter than a
    // blanket `ctl.delivery.>` (fact-check precision, review panel).
    `${p}.ctl.delivery.*.reply.>`,
  ];
  const sub = [
    `_INBOX_${id}.>`,
    `${p}.ctl.delivery.*`, // serve the delivery control service (queue-grouped durable join/leave/list)
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
function membershipRwPermissions(space: string, id: string): Record<string, unknown> {
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
  return { pub: { allow: pub }, sub: { allow: [`_INBOX_${id}.>`] } };
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

/** Mint the scoped `membership-observer` creds — a SYSTEM-account user (conn A of the graph feed),
 *  signed with the in-memory `auth.sys.signingSeed` from a fresh {@link createSpaceAuth}. THROWS if that
 *  seed is absent (a re-`up` of an already-provisioned space, whose `$SYS` seed was discarded at its
 *  original `up`): the observer can only be minted at the (re-)provision that creates the account — a
 *  documented migration property, not a silent no-op. The CONNZ/event subjects pin the DATA account id
 *  (`auth.account.pub`). Mirrors {@link mintCreds} but issues into the system account. */
export async function mintMembershipObserverCreds(auth: SpaceAuth, identity: Identity): Promise<string> {
  if (!auth.sys.signingSeed)
    throw new Error(
      "mintMembershipObserverCreds: no in-memory system-account signing seed — the observer can only be minted at the `up` that provisions the account (the $SYS seed is never persisted). Re-provision (down/up) to enable broker-sourced membership.",
    );
  const signer = fromSeed(new TextEncoder().encode(auth.sys.signingSeed));
  const perms = membershipObserverPermissions(auth.account.pub);
  const userJwt = await encodeUser(
    "membership-observer",
    fromPublic(identity.id),
    fromPublic(auth.sys.pub),
    perms,
    { signer },
  );
  const creds = fmtCreds(userJwt, fromSeed(new TextEncoder().encode(identity.seed)));
  return new TextDecoder().decode(creds);
}

/** Render the `nats-server` config that trusts this space's operator and serves its
 *  accounts via the in-config MEMORY resolver. */
export function serverConfig(auth: SpaceAuth, opts: { port?: number; host?: string; storeDir: string }): string {
  const port = opts.port ?? 4222;
  const host = opts.host ?? "127.0.0.1";
  // A minted "agent" carries its full permission allow-list inline in its user JWT, which the
  // client sends in the CONNECT protocol line. With per-channel + JetStream-API grants that JWT
  // exceeds the 4 KB default max_control_line at ~2 channels, and the server then silently drops
  // the connection (the client retries forever — a connect that "hangs"). Raise it to fit a rich
  // agent JWT — but right-sized, not generous: the CONNECT line is parsed BEFORE auth, so the cap
  // is a per-connection pre-auth allocation under connection flooding. 64 KB clears a many-channel
  // agent JWT (~4–8 KB) with wide margin while keeping the pre-auth surface ~16× tighter than 1 MB.
  return `# Generated by \`cotal up\` — do not edit by hand.
host: ${host}
port: ${port}
max_control_line: 65536
jetstream { store_dir: ${JSON.stringify(opts.storeDir)} }
operator: ${auth.operator.jwt}
system_account: ${auth.sys.pub}
resolver: MEMORY
resolver_preload: {
  ${auth.account.pub}: ${auth.account.jwt}
  ${auth.sys.pub}: ${auth.sys.jwt}
}
`;
}
