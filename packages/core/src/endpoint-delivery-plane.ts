// The plane-3 delivery region of CotalEndpoint, as an internal component. Moved verbatim from
// endpoint.ts; the endpoint keeps the public methods and forwards to it. Not re-exported by the index.
import { aclRetired, readAcl } from "./acls.js";
import { ANYCAST_CANCEL_OP, ANYCAST_STATUS_OP, ANYCAST_TAKES_OP } from "./anycast-requests.js";
import { ARTIFACT_PART_KIND, isArtifactPart } from "./artifact.js";
import { DELIVERY_LIMIT_HEADER, HISTORY_NO_COUNT } from "./backup-config.js";
import { isRestoredConsumer } from "./backup.js";
import { ackWaitOf, authenticatedChannelMessage, durableDelivery, isRecord } from "./endpoint-inbound.js";
import { deliveryLimitOf, fitHistoryPage, isFromSubjectSender, type CotalEndpoint, type HistoryPage } from "./endpoint.js";
import { EVICT_PRINCIPALS_MAX } from "./evict.js";
import { issuedPermitsSubject, type IssuedSubjectPermission } from "./issued-authority.js";
import { isConsumerAlreadyExists, isJetStreamMissing } from "./jetstream-missing.js";
import { deleteMember, durableEligible, listLifecycleMemberChannels, listMembers, readMember } from "./members.js";
import { parseSecretStoreIdentity, type SecretStoreIdentity } from "./secret-store.js";
import { fanoutDurableConfig, inboxReaderConfig } from "./streams.js";
import { CONTROL_DELIVERY, CONTROL_DELIVERY_ADMIN, FANOUT_DURABLE, INBOX_READER_DURABLE, assertLifecycleToken, assertValidChannel, channelInAllow, chatStream, dlvDurable, dlvStream, dlvSubject, familiesCovering, inboxStream, isChannelFamily, isConcreteChannel, membershipInAllow, parseDinboxPrincipal, parsePrincipalKey, parseSubject } from "./subjects.js";
import type { AgentCard, ControlReply, ControlRequest, CotalMessage, MessageMeta, Plane3Entry } from "./types.js";
import { JetStreamApiCodes, type ConsumerConfig, type ConsumerMessages, type JetStreamClient, type JetStreamManager, type JetStreamPublishOptions, type JsMsg } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import { headers, type NatsConnection, type Subscription } from "@nats-io/transport-node";

const PLANE3_FRAME_HEADER = "Cotal-Delivery-Frame";

/** The `ctl.delivery` ops a sender calls about one of its own anycast requests (SPEC §8.1). */
const ANYCAST_CONTROL_OPS: ReadonlySet<string> = new Set([ANYCAST_STATUS_OP, ANYCAST_CANCEL_OP, ANYCAST_TAKES_OP]);

/** How long the trusted writer reuses its read of the DLV count before reading it again. */
const DELIVERY_LIMIT_READ_MS = 5_000;

interface Plane3DeliveryFrame {
  version: 1;
  channel: string;
  msg: CotalMessage;
}

/** Plane-3 trusted-reader redelivery ceiling: a dinbox entry that keeps failing re-auth-defer
 *  (unknown owner) or DELIVER transfer is `term()`d + surfaced after this many redeliveries, so one
 *  stuck/poison entry can't head-of-line the single shared reader forever. */
const READER_MAX_REDELIVERIES = 10;

/** A value or a promise of it — the Plane-3 `aclFor` reads the durable ACL registry FRESH per entry
 *  (async), so the reader/fan-out call sites await it. */
export type MaybePromise<T> = T | Promise<T>;

/** Page size for the mediated history read when the caller names none — matches `channelHistory`'s
 *  own default, since the mediated read exists to be a drop-in for it. */
const READ_HISTORY_DEFAULT_LIMIT = 100;

/** Hard server-side ceiling on one mediated page. The caller PROPOSES a limit and the mediator
 *  decides: the reader is pooled and privileged, so an unbounded caller-chosen limit would let one
 *  request pull a channel's whole retained set through it. Clamped, not refused — a UI asking for
 *  more than a page should get a page, and `complete: false` already tells it more remains. */
const READ_HISTORY_MAX_LIMIT = 200;

function isPlane3DeliveryFrame(value: unknown): value is Plane3DeliveryFrame {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.includes("version") || !keys.includes("channel") || !keys.includes("msg")) return false;
  if (value.version !== 1 || typeof value.channel !== "string" || !isConcreteChannel(value.channel)) return false;
  return isCotalMessage(value.msg) && value.msg.channel === value.channel;
}

function isCotalMessage(value: unknown): value is CotalMessage {
  if (!isRecord(value)) return false;
  const routes = ["channel", "to", "toService"].filter((key) => key in value);
  if (routes.length !== 1 || typeof value[routes[0]!] !== "string") return false;
  if (typeof value.id !== "string" || typeof value.ts !== "number" || !Number.isFinite(value.ts) ||
      typeof value.space !== "string" || !isEndpointRef(value.from) || !Array.isArray(value.parts) ||
      !value.parts.every(isMessagePart)) return false;
  if (value.mentions !== undefined && (!Array.isArray(value.mentions) || !value.mentions.every((name) => typeof name === "string"))) return false;
  if (value.replyTo !== undefined && typeof value.replyTo !== "string") return false;
  if (value.contextId !== undefined && typeof value.contextId !== "string") return false;
  return true;
}

function isEndpointRef(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" && typeof value.name === "string" &&
    (value.role === undefined || typeof value.role === "string");
}

/** A conformant message part: the three CORE kinds, or a reverse-DNS extension kind (SPEC §5).
 *
 *  Reached from {@link isCotalMessage}, which gates the Plane-3 delivery frame — so a core kind
 *  missing an arm here is not a schema nicety: the durable backstop DROPS every message carrying
 *  it, silently, and the drop surfaces nowhere near the feature that added the part. `artifact`
 *  was exactly that case before it was added (a bare kind has no dot, so it fell through to the
 *  extension regex and failed). */
function isMessagePart(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "text") return typeof value.text === "string";
  if (value.kind === "data") return Object.prototype.hasOwnProperty.call(value, "data");
  if (value.kind === ARTIFACT_PART_KIND) return isArtifactPart(value);
  return /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value.kind);
}

/** What the delivery plane reads from its endpoint. State is read when it is used, never copied, and
 *  every method is looked up on the endpoint at call time. */
export interface EndpointDeliveryPlaneDeps {
  ackWaitMs: () => number;
  actor: () => string;
  owner: () => string;
  allowSubscribe: () => string[] | undefined;
  anycastUnavailable: () => string | undefined;
  card: () => AgentCard;
  js: () => JetStreamClient | undefined;
  jsm: () => JetStreamManager | undefined;
  nc: () => NatsConnection | undefined;
  ownLifecycleUid: () => string | undefined;
  residentSwap: () => Promise<void> | undefined;
  space: () => string;
  stopped: () => boolean;
  streamMsgs: () => ConsumerMessages[];
  subs: () => Subscription[];
  userMode: () => boolean;
  watchDeletePermissions: () => WeakMap<object, () => IssuedSubjectPermission | undefined>;
  maxPayload: () => number;
  aclForAlias: CotalEndpoint["aclForAlias"];
  channelHistory: CotalEndpoint["channelHistory"];
  deliveryClassFresh: CotalEndpoint["deliveryClassFresh"];
  durableJoinFor: CotalEndpoint["durableJoinFor"];
  durableLeaveFor: CotalEndpoint["durableLeaveFor"];
  ownerMemberships: CotalEndpoint["ownerMemberships"];
  ownsDeliveryLease: CotalEndpoint["ownsDeliveryLease"];
  readDeliveryLease: CotalEndpoint["readDeliveryLease"];
  readDeliveryLeaseEntry: CotalEndpoint["readDeliveryLeaseEntry"];
  reloadCreds: CotalEndpoint["reloadCreds"];
  serveControl: CotalEndpoint["serveControl"];
  aclRegistry: () => Promise<KV>;
  membersRegistry: () => Promise<KV>;
  armAnycastRequests: () => Promise<void>;
  deliveryAnycast: (op: string, caller: string, args: Record<string, unknown>) => Promise<ControlReply>;
  dropAnycastRequests: () => void;
  manager: () => Promise<JetStreamManager>;
  notLiveMsg: () => string;
  plane3MsgId: (entry: Plane3Entry, keySuffix: string) => Partial<JetStreamPublishOptions>;
  publishDinbox: (principal: string, lifecycleUid: string, entry: Plane3Entry) => Promise<void>;
  resolveOwnerByName: (name: string) => string | undefined;
  scheduleResidentSwap: () => void;
  sendMentionNotice: (msg: CotalMessage, channel: string, seq: number, names: readonly string[]) => Promise<void>;
  emit: (event: string, ...args: unknown[]) => boolean;
}

/** The plane-3 delivery daemon's side of one endpoint: the fan-out writer, the trusted reader, the
 *  `ctl.delivery` and `ctl.delivery-admin` responders and the quiesce fence around them, plus the agent's
 *  own DELIVER durable pump. Internal: `CotalEndpoint` keeps the public methods and forwards to it. */
export class EndpointDeliveryPlane {
  /** The live `ctl.delivery` serve subscription (delivery daemon) — re-created on every (re)connect by
   *  {@link armDeliveryControl}; tracked so the stale one is dropped on reconnect. */
  deliveryServeSub?: import("@nats-io/transport-node").Subscription;
  deliveryAdminServeSub?: import("@nats-io/transport-node").Subscription;
  /** The lifecycles whose membership inventory this daemon has been asked for, as principal to uids
   *  (#4965). A durable join or leave bound to one of them is refused, so no row of a retiring lifecycle
   *  is written after its inventory read starts. An entry goes when a later inventory for the same
   *  principal finds its ACL row retired; an alias that never retires again keeps its one entry until
   *  the daemon restarts. This is the second layer of the fence: it covers a manager that does not
   *  narrow the ACL row before the inventory, on this daemon process only. The first is the ACL row
   *  each join re-reads around its write (`durableJoinFor`'s `aclFence`), which holds across daemons. */
  private readonly retiringLifecycles = new Map<string, Set<string>>();
  /** The durable joins and leaves running now, by `<principal>/<lifecycleUid>`: the writes an
   *  inventory of that lifecycle waits for before it reads. */
  private readonly membershipWrites = new Map<string, Set<Promise<unknown>>>();
  /** True once {@link quiescePlane3} has stopped serving this shard pending an ownership answer.
   *  Guards {@link armPlane3} so a RECONNECT cannot silently resume serving mid-question. */
  private plane3Quiesced = false;
  /** When set, this endpoint hosts the Plane-3 fan-out writer + trusted reader (the server-side delivery
   *  daemon). `aclFor` maps an owner id to its current read ACL (`allowSubscribe`) for the reader's
   *  re-authorization — read FRESH per entry from the durable ACL registry KV, hence async. */
  plane3?: {
    aclFor: (owner: string, lifecycleUid: string) => MaybePromise<string[] | undefined>;
    /** Composition-root hook: reload+reconnect the membership feed's rw connection as part of an
     *  explicit `reloadCreds` (the feed owns its own connections, outside this endpoint). `expected`
     *  is the renewal owner's generation token for the rw cred (see {@link reloadCreds}). */
    reloadMembershipCreds?: (expected?: string) => Promise<unknown>;
    /** Composition-root hook: notified when delivery credentials have been successfully proved and adopted. */
    onDeliveryCredsAdopted?: () => void;
    /** Composition-root hook: the live-eviction executor — scan→KICK→verify a denied
     *  principal's connections via the daemon's $SYS observer/evictor creds (opened per call). */
    evictPrincipal?: (principal: string) => Promise<unknown>;
    /** Composition-root hook: {@link evictPrincipal} for a SET of denied principals in one shared
     *  scan→KICK→verify sweep, one result per principal in request order. */
    evictPrincipals?: (principals: string[]) => Promise<unknown>;
    /** Composition-root hook: the plane-claim liveness oracle (#29 HIGH 3) — answer whether the
     *  two claimed sealed-scanner connections are live/gone/unknown via the daemon's $SYS observer
     *  cred (opened per call; read-only, never the evictor). */
    planeConnLiveness?: (query: unknown) => Promise<unknown>;
    /** Composition-root hook: the freeze-holder liveness probe (#391) — answer whether ONE
     *  principal still holds any live connection, via the daemon's $SYS observer cred (opened per
     *  call). The READ half of {@link evictPrincipal}: read-only by construction, so a repair path
     *  can refuse on a live holder's behalf instead of killing it to find out. */
    principalLiveness?: (principal: string) => Promise<unknown>;
    /** Composition-root hook: name the SecretStore this daemon reloads standing creds from.
     *  The manager challenges it at start and before every remint so a two-root composition
     *  is refused rather than twelve hours later on a fingerprint mismatch. */
    reloadStoreIdentity?: () => SecretStoreIdentity;
    /** Composition-root hook: has the daemon finished starting? While it answers `false`,
     *  `reloadCreds` is refused with nothing adopted (#2304). The responder is bound and the lease
     *  reads ready before the rest of start-up is up, and an adoption accepted in that window
     *  schedules a resident reconnect underneath start-up awaits that are still pending on this
     *  connection. Absent means the composition has no such phase. */
    startupComplete?: () => boolean;
  };
  private deliveryLimitRead?: { at: number; stamp: string };

  private readonly aclForAlias: EndpointDeliveryPlaneDeps["aclForAlias"];
  private readonly channelHistory: EndpointDeliveryPlaneDeps["channelHistory"];
  private readonly deliveryClassFresh: EndpointDeliveryPlaneDeps["deliveryClassFresh"];
  private readonly durableJoinFor: EndpointDeliveryPlaneDeps["durableJoinFor"];
  private readonly durableLeaveFor: EndpointDeliveryPlaneDeps["durableLeaveFor"];
  private readonly ownerMemberships: EndpointDeliveryPlaneDeps["ownerMemberships"];
  private readonly ownsDeliveryLease: EndpointDeliveryPlaneDeps["ownsDeliveryLease"];
  private readonly readDeliveryLease: EndpointDeliveryPlaneDeps["readDeliveryLease"];
  private readonly readDeliveryLeaseEntry: EndpointDeliveryPlaneDeps["readDeliveryLeaseEntry"];
  private readonly reloadCreds: EndpointDeliveryPlaneDeps["reloadCreds"];
  private readonly serveControl: EndpointDeliveryPlaneDeps["serveControl"];
  private readonly aclRegistry: EndpointDeliveryPlaneDeps["aclRegistry"];
  private readonly membersRegistry: EndpointDeliveryPlaneDeps["membersRegistry"];
  private readonly armAnycastRequests: EndpointDeliveryPlaneDeps["armAnycastRequests"];
  private readonly deliveryAnycast: EndpointDeliveryPlaneDeps["deliveryAnycast"];
  private readonly dropAnycastRequests: EndpointDeliveryPlaneDeps["dropAnycastRequests"];
  private readonly manager: EndpointDeliveryPlaneDeps["manager"];
  private readonly notLiveMsg: EndpointDeliveryPlaneDeps["notLiveMsg"];
  private readonly plane3MsgId: EndpointDeliveryPlaneDeps["plane3MsgId"];
  private readonly publishDinbox: EndpointDeliveryPlaneDeps["publishDinbox"];
  private readonly resolveOwnerByName: EndpointDeliveryPlaneDeps["resolveOwnerByName"];
  private readonly scheduleResidentSwap: EndpointDeliveryPlaneDeps["scheduleResidentSwap"];
  private readonly sendMentionNotice: EndpointDeliveryPlaneDeps["sendMentionNotice"];
  private readonly emit: EndpointDeliveryPlaneDeps["emit"];

  constructor(private readonly deps: EndpointDeliveryPlaneDeps) {
    this.aclForAlias = deps.aclForAlias;
    this.channelHistory = deps.channelHistory;
    this.deliveryClassFresh = deps.deliveryClassFresh;
    this.durableJoinFor = deps.durableJoinFor;
    this.durableLeaveFor = deps.durableLeaveFor;
    this.ownerMemberships = deps.ownerMemberships;
    this.ownsDeliveryLease = deps.ownsDeliveryLease;
    this.readDeliveryLease = deps.readDeliveryLease;
    this.readDeliveryLeaseEntry = deps.readDeliveryLeaseEntry;
    this.reloadCreds = deps.reloadCreds;
    this.serveControl = deps.serveControl;
    this.aclRegistry = deps.aclRegistry;
    this.membersRegistry = deps.membersRegistry;
    this.armAnycastRequests = deps.armAnycastRequests;
    this.deliveryAnycast = deps.deliveryAnycast;
    this.dropAnycastRequests = deps.dropAnycastRequests;
    this.manager = deps.manager;
    this.notLiveMsg = deps.notLiveMsg;
    this.plane3MsgId = deps.plane3MsgId;
    this.publishDinbox = deps.publishDinbox;
    this.resolveOwnerByName = deps.resolveOwnerByName;
    this.scheduleResidentSwap = deps.scheduleResidentSwap;
    this.sendMentionNotice = deps.sendMentionNotice;
    this.emit = deps.emit;
  }

  private get ackWaitMs() { return this.deps.ackWaitMs(); }
  private get actor() { return this.deps.actor(); }
  private get owner() { return this.deps.owner(); }
  private get allowSubscribe() { return this.deps.allowSubscribe(); }
  private get anycastUnavailable() { return this.deps.anycastUnavailable(); }
  private get card() { return this.deps.card(); }
  private get js() { return this.deps.js(); }
  private get jsm() { return this.deps.jsm(); }
  private get nc() { return this.deps.nc(); }
  private get ownLifecycleUid() { return this.deps.ownLifecycleUid(); }
  private get residentSwap() { return this.deps.residentSwap(); }
  private get space() { return this.deps.space(); }
  private get stopped() { return this.deps.stopped(); }
  private get streamMsgs() { return this.deps.streamMsgs(); }
  private get subs() { return this.deps.subs(); }
  private get userMode() { return this.deps.userMode(); }
  private get watchDeletePermissions() { return this.deps.watchDeletePermissions(); }
  private get maxPayload() { return this.deps.maxPayload(); }

  /** Start the Plane-3 fan-out writer + trusted reader on THIS (privileged, server-side delivery-daemon)
   *  endpoint, AND serve the `ctl.delivery` control service (runtime durable join/leave/list). `aclFor`
   *  maps an owner id to its current read ACL for the reader's re-authorization — read FRESH per entry
   *  from the durable ACL registry (async). Call once after connect; idempotent durable creation lets it
   *  resume on a daemon restart. Both the JS loops AND the `ctl.delivery` subscription are (re)bound by
   *  {@link armPlane3} on EVERY (re)connect — a reconnect drains the old connection, so re-binding both
   *  is required, not optional (the responder would otherwise be lost on a broker blip). */
  async startPlane3(
    aclFor: (owner: string, lifecycleUid: string) => MaybePromise<string[] | undefined>,
    opts: { reloadMembershipCreds?: (expected?: string) => Promise<unknown>; evictPrincipal?: (principal: string) => Promise<unknown>; evictPrincipals?: (principals: string[]) => Promise<unknown>; planeConnLiveness?: (query: unknown) => Promise<unknown>; principalLiveness?: (principal: string) => Promise<unknown>; reloadStoreIdentity?: () => SecretStoreIdentity; onDeliveryCredsAdopted?: () => void; startupComplete?: () => boolean } = {},
  ): Promise<void> {
    if (!this.js) throw new Error(this.notLiveMsg());
    this.plane3 = { aclFor, reloadMembershipCreds: opts.reloadMembershipCreds, evictPrincipal: opts.evictPrincipal, evictPrincipals: opts.evictPrincipals, planeConnLiveness: opts.planeConnLiveness, principalLiveness: opts.principalLiveness, reloadStoreIdentity: opts.reloadStoreIdentity, onDeliveryCredsAdopted: opts.onDeliveryCredsAdopted, startupComplete: opts.startupComplete };
    await this.armPlane3();
  }

  /** Whether an ALREADY-DISPATCHED unit of Plane-3 work may still take effect.
   *
   *  Unsubscribing stops NEW work; it cannot recall work already in flight. A handler that entered
   *  before {@link quiescePlane3} and awaited broker I/O inside it resumes AFTER the freeze, and a
   *  reviewer traced the ordering that makes that a split rather than a latency blip: the loser
   *  accepts a unit and awaits, the loser is descheduled, the successor acquires the shard and flips
   *  its lease READY, then the loser resumes and answers or acks for a shard it no longer holds.
   *  Subscription counts and parked-pull readings cannot see it, because the effect is the reply and
   *  the ack rather than the binding.
   *
   *  So each work path re-asks HERE, at the point of effect, after its awaits and before it acts.
   *  The lease keeps one ROW, not one SERVER; this is the half that keeps one server. An unacked
   *  message is not lost by refusing: a stopped consumer redelivers it to whoever holds the shard
   *  next, which is the same property quiescing already relies on. */
  plane3MayAct(): boolean {
    return !this.plane3Quiesced;
  }

  /** Serve one runtime durable-membership control request (the server-side delivery daemon). The caller
   *  id is the authenticated subject sender ({@link serveControl} fail-closes on a mismatch). Validation
   *  is against the durable ACL registry — the SAME KV the reader re-auths against (single source of
   *  truth, no in-memory ledger to drift). */
  private async handleDeliveryControl(req: ControlRequest): Promise<ControlReply> {
    // FENCE: entered before a quiesce, resuming after it. Answering now would put a second server on
    // this shard's control rail while the winner is already READY.
    if (!this.plane3MayAct()) return { ok: false, error: "delivery: this daemon is not serving this shard (it is re-checking ownership); retry" };
    const caller = req.from.id;
    const args = req.args ?? {};
    if (req.op === "durableJoin") return this.deliveryJoin(caller, args);
    if (req.op === "durableLeave") return this.deliveryLeave(caller, args);
    if (req.op === "readHistory") return this.deliveryReadHistory(caller, args);
    if (req.op === ANYCAST_TAKES_OP)
      return this.anycastUnavailable ? { ok: false, error: `delivery: ${this.anycastUnavailable}` } : { ok: true, data: { takes: true } };
    if (req.op === ANYCAST_STATUS_OP || req.op === ANYCAST_CANCEL_OP) return this.deliveryAnycast(req.op, caller, args);
    if (req.op === "listMemberships") {
      if (typeof args.lifecycleUid !== "string")
        return { ok: false, error: "listMemberships: the caller's lifecycleUid is required (membership rows are lifecycle-keyed, SPEC 13.1)" };
      let uid: string;
      try { uid = assertLifecycleToken(args.lifecycleUid); }
      catch (e) { return { ok: false, error: (e as Error).message }; }
      let memberships;
      if (args.channel !== undefined) {
        const channel = this.checkDurableChannelArg(args, "listMemberships", { family: true });
        if (typeof channel !== "string") return channel;
        memberships = (await listMembers(await this.membersRegistry(), { owner: caller }))
          .filter((r) => r.channel === channel && r.leaveCursor === undefined)
          .map((r) => ({ channel: r.channel, generation: r.generation, activated: r.activated === true, lifecycleUid: r.lifecycleUid }));
      } else {
        memberships = await this.ownerMemberships(caller, uid);
      }
      // FENCE AFTER THE AWAIT, which is the one that matters. The entry check above cannot catch the
      // case this exists for: a request admitted WHILE SERVING, then descheduled inside its broker
      // read, resuming after a successor has taken the shard and reached READY. Re-ask at the point
      // of effect, so the answer is never served by a daemon that has stood down.
      if (!this.plane3MayAct()) return { ok: false, error: "delivery: this daemon stopped serving this shard while the request was in flight; retry" };
      return { ok: true, data: { memberships } };
    }
    return { ok: false, error: `op "${req.op}" not supported on the delivery control service` };
  }

  /** Validate the channel ARG shape only: non-blank, valid, concrete (NO ACL check, that is op-specific).
   *  `family` also admits a channel family such as `review.>` (a membership join or leave, #5404).
   *  Returns the channel on success or a ControlReply error to short-circuit. */
  private checkDurableChannelArg(args: Record<string, unknown>, op: string, opts: { family?: boolean } = {}): string | ControlReply {
    const channel = typeof args.channel === "string" ? args.channel.trim() : "";
    if (!channel) return { ok: false, error: `${op}: channel must be a non-blank string` };
    try { assertValidChannel(channel); } catch (e) { return { ok: false, error: (e as Error).message }; }
    if (opts.family && isChannelFamily(channel)) return channel;
    if (!isConcreteChannel(channel))
      return {
        ok: false,
        error: opts.family
          ? `${op}: "${channel}" stays live only: a durable membership takes a concrete channel or a family such as review.>, never the root > or a pattern with *`
          : `${op}: "${channel}" must be a concrete channel (durable membership is per-concrete-channel, not wildcard)`,
      };
    return channel;
  }

  /** JOIN requires the channel be within the caller's CURRENT read ACL (you can't durable-subscribe a
   *  channel you may not read). A family must lie inside one ACL entry, so every channel under it is
   *  readable. */
  private async deliveryJoin(caller: string, args: Record<string, unknown>): Promise<ControlReply> {
    const channel = this.checkDurableChannelArg(args, "durableJoin", { family: true });
    if (typeof channel !== "string") return channel; // a ControlReply error
    // The caller arrives as an ALIAS (the control subject carries owner+actor, never a uid): resolve
    // its single live lifecycle-keyed ACL row SERVER-SIDE — the trusted registry, never a caller
    // assertion, decides which lifecycle joins. Two live rows (a reservation breach / unfinished
    // teardown) refuse loudly rather than binding a membership to a guessed lifecycle.
    let acl: { allowSubscribe: string[]; lifecycleUid: string } | undefined;
    try { acl = await this.aclForAlias(caller); }
    catch (e) { return { ok: false, error: (e as Error).message }; }
    if (acl === undefined)
      return { ok: false, error: `durableJoin: no read ACL on record for ${caller} (not provisioned for durable delivery)` };
    if (!membershipInAllow(acl.allowSubscribe, channel))
      return { ok: false, error: `channel "${channel}" is not within your read ACL [${acl.allowSubscribe.join(", ")}]` };
    const uid = acl.lifecycleUid;
    // The lookup above may be stale by the time the row is written (a retirement can fence and purge
    // this lifecycle meanwhile), so the write re-checks the exact ACL row itself (`aclFence`).
    try { return { ok: true, data: await this.membershipWrite(caller, uid, () => this.durableJoinFor(caller, channel, uid, { aclFence: true })) }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  }

  /** Whether `lifecycleUid`'s exact ACL row still allows reads, so an inventory of it came from a
   *  caller that did not fence. A row narrowed to no reads, or retired or absent, is fenced. A read
   *  that fails answers true: the caller keeps its in-memory mark, which only ever refuses. */
  private async lifecycleAclUnfenced(principal: string, lifecycleUid: string): Promise<boolean> {
    try {
      const row = await readAcl(await this.aclRegistry(), principal, lifecycleUid);
      return row !== undefined && row.record.allowSubscribe.length > 0;
    } catch {
      return true;
    }
  }

  /** Run one durable join or leave that writes `principal`'s rows of `lifecycleUid`, refused once that
   *  lifecycle's inventory has been asked for ({@link retiringLifecycles}). The check and the
   *  registration have no await between them, so an inventory either finds this write running and
   *  waits for it, or this write finds the inventory's mark and is refused. */
  private async membershipWrite<T>(principal: string, lifecycleUid: string, write: () => Promise<T>): Promise<T> {
    if (this.retiringLifecycles.get(principal)?.has(lifecycleUid))
      throw new Error(`lifecycle ${lifecycleUid} of ${principal} is retiring: its membership inventory was requested, so its durable memberships no longer change`);
    const key = `${principal}/${lifecycleUid}`;
    const running = write();
    let writes = this.membershipWrites.get(key);
    if (writes === undefined) this.membershipWrites.set(key, (writes = new Set()));
    writes.add(running);
    try {
      return await running;
    } finally {
      writes.delete(running);
      if (writes.size === 0) this.membershipWrites.delete(key);
    }
  }

  /** LEAVE must NOT require current-ACL coverage. Leave fires precisely when the ACL was narrowed/revoked
   *  (a refused live sub → {@link closeRefusedMembership}); gating the tombstone on the current ACL would
   *  loop forever and leave the SPEC §7 boundary open (the membership could resume if the ACL is later
   *  restored). The guards are: authenticated caller (serveControl), concrete channel, a finite generation
   *  (the join epoch — without it a stale/replayed leave could tombstone a newer rejoin), and an EXISTING
   *  own membership; `durableLeaveFor` → `tombstoneMember` then enforces the generation match. */
  private async deliveryLeave(caller: string, args: Record<string, unknown>): Promise<ControlReply> {
    const channel = this.checkDurableChannelArg(args, "durableLeave", { family: true });
    if (typeof channel !== "string") return channel; // a ControlReply error
    if (typeof args.generation !== "number" || !Number.isFinite(args.generation))
      return { ok: false, error: "durableLeave: a finite generation is required (fail-closed stale-leave guard)" };
    // The LEAVE carries the leaver's own lifecycleUid: leave must work precisely when the ACL row was
    // narrowed or already purged (see the method doc), so the alias→row resolution join uses is not
    // available here. The uid is caller-asserted but harmless to lie about: the member key it selects
    // is confined to the AUTHENTICATED caller's own alias (`<channel>/<caller>.<uid>`), so the worst a
    // false uid reaches is the caller's own retired incarnation's row — legitimate cleanup — and the
    // generation guard still applies.
    if (typeof args.lifecycleUid !== "string")
      return { ok: false, error: "durableLeave: the leaving incarnation's lifecycleUid is required (membership rows are lifecycle-keyed, SPEC 13.1)" };
    let uid: string;
    try { uid = assertLifecycleToken(args.lifecycleUid); }
    catch (e) { return { ok: false, error: (e as Error).message }; }
    const existing = await readMember(await this.membersRegistry(), channel, caller, uid);
    if (!existing) return { ok: true, data: { channel, alreadyLeft: true } }; // nothing to tombstone — idempotent
    const generation = args.generation;
    try { await this.membershipWrite(caller, uid, () => this.durableLeaveFor(caller, channel, uid, generation)); }
    catch (e) { return { ok: false, error: (e as Error).message }; }
    return { ok: true, data: { channel } };
  }

  /** Serve one MEDIATED HISTORY READ (`readHistory`, the client side is {@link readHistory}). The daemon
   *  holds the consumer so the caller does not have to: this is a privilege reduction, not a new
   *  capability, and it is the shape SPEC's "Mediated reads (normative)" rule asks for.
   *
   *  THE ONE INVARIANT THIS METHOD EXISTS FOR: authorization is read FRESH on every call and never
   *  cached across calls. A consumer pins its authorization when it is created, so a revoked caller
   *  keeps being served by a consumer it already holds; re-reading here is what makes a revocation
   *  stop the very NEXT read. Cache this and the verb loses its only advantage over the raw consumer
   *  path.
   *
   *  AUTHORITY (SPEC §9.6): "current read ACL" is the effective broker-accepted credential. The
   *  durable registry is a live mirror of that credential, not a second grant source. History
   *  authorizes against `allowSubscribe ∩ issuedAllowSubscribe` — the live row (so revocation via
   *  plain commitAcl still stops the next read) intersected with the mint-time ceiling (so a
   *  registry widen without a remint cannot grant what the JWT does not). Raising the ceiling is
   *  {@link reissueAcl}, which is what provision does when it bakes the list into the JWT.
   *
   *  The caller arrives as an alias (the control subject carries owner+actor, never a uid) and is the
   *  AUTHENTICATED subject sender — `serveControl` has already fail-closed on any payload that names a
   *  different principal, so `caller` cannot be self-asserted. */
  private async deliveryReadHistory(caller: string, args: Record<string, unknown>): Promise<ControlReply> {
    const channel = this.checkDurableChannelArg(args, "readHistory");
    if (typeof channel !== "string") return channel; // a ControlReply error

    // The caller PROPOSES a limit; the mediator decides. Reject a nonsense limit loudly rather than
    // silently substituting a default — a caller asking for -1 has a bug and should hear about it.
    const asked = args.limit === undefined ? READ_HISTORY_DEFAULT_LIMIT : args.limit;
    if (typeof asked !== "number" || !Number.isInteger(asked) || asked < 1)
      return { ok: false, error: `readHistory: limit must be a positive integer (got ${JSON.stringify(args.limit)})` };
    const limit = Math.min(asked, READ_HISTORY_MAX_LIMIT);

    // FRESH per call — see the method doc. Same registry, same alias resolution, and the same loud
    // refusal on two live rows that `durableJoin` uses: a stale lifecycle must never authorize its
    // successor's read.
    //
    // SPEC §9.6: "current read ACL" is the effective broker-accepted credential. The registry row is
    // a live mirror and can be rewritten by plain commitAcl without a remint. Authorizing history
    // from the row ALONE let a widen grant reads channelHistory still broker-denies — a new
    // capability wearing a privilege-reduction label (panel BLOCKING at 914fd7b0). History therefore
    // requires the channel in BOTH the live row AND the mint-time ceiling (`issuedAllowSubscribe`).
    // Revocation still works: narrowing allowSubscribe stops the next read. Raising the ceiling
    // requires reissueAcl (provision/remint), which is the same act that bakes the list into the JWT.
    let acl: { allowSubscribe: string[]; issuedAllowSubscribe: string[]; lifecycleUid: string } | undefined;
    try { acl = await this.aclForAlias(caller); }
    catch (e) { return { ok: false, error: (e as Error).message }; }
    if (acl === undefined)
      return { ok: false, error: `readHistory: no read ACL on record for ${caller} - not permitted` };
    const inLive = channelInAllow(acl.allowSubscribe, channel);
    const inIssued = channelInAllow(acl.issuedAllowSubscribe, channel);
    if (!inLive || !inIssued) {
      // Name the live list in the error — that is what operators edit and what revocation clears.
      // A ceiling miss (registry widened past the credential) is the same refusal shape as a live
      // miss so a caller cannot probe which half failed.
      return {
        ok: false,
        error: `readHistory: channel "${channel}" is not within your read ACL [${acl.allowSubscribe.join(", ")}] - refused`,
      };
    }

    // One message MORE than the page is the completeness probe: if the backlog hands back limit+1,
    // something older exists behind the page and `complete` is false. Cheaper and more honest than a
    // separate count, which could race the page it describes.
    let page: CotalMessage[];
    try { page = await this.channelHistory(channel, { limit: limit + 1 }); }
    catch (e) {
      // Surface the read failure. `streamHistory` deliberately raises rather than returning empty on a
      // denial or a cut-short window, and that distinction must survive the rail: an error here would
      // otherwise reach the caller as an empty page and render as "no history".
      return { ok: false, error: `readHistory: ${(e as Error).message}` };
    }
    const reachedStart = page.length <= limit;
    const wanted = reachedStart ? page : page.slice(-limit);

    // A page that cannot be SENT is not a page. The reply rides one NATS message, so `limit` alone is
    // the wrong bound: 200 large messages serialize past `max_payload`, and `serveControl` can then only
    // answer with a refusal in place of the page.
    //
    // So bound by BYTES too, keeping the NEWEST that fit — which needs no new vocabulary, because
    // `complete: false` already means "older history remains behind this page". Trimming here is the
    // documented truncation signal doing its job, not a silent degradation.
    const fitted = fitHistoryPage(wanted, this.maxPayload);
    // `wanted.length > 0` is load-bearing, not defensive: an EMPTY channel also fits nothing, and
    // without this guard a channel nobody has posted to was refused with "the newest message exceeds
    // the payload budget" — a confident, entirely wrong explanation for a legitimately empty result.
    // Genuine emptiness is `{ items: [], complete: true }`; only a message too large to ever send is
    // the error.
    if (wanted.length > 0 && fitted.length === 0)
      return { ok: false, error: `readHistory: the newest message on "${channel}" alone exceeds the broker payload budget (${this.maxPayload} bytes) - refused loudly rather than served as an empty page` };
    return { ok: true, data: { items: fitted, complete: reachedStart && fitted.length === wanted.length } satisfies HistoryPage };
  }

  /** Stop serving Plane-3 WITHOUT tearing down the connection, so a daemon that has just learned its
   *  lease may no longer be its own can stop acting on the shard while it finds out for certain.
   *
   *  A COMPARE-AND-SWAP KEEPS ONE LEASE ROW; IT DOES NOT KEEP ONE SERVER. That distinction is the
   *  reason this exists, and it was a review finding. When a renew fails, the daemon re-reads the
   *  key and may then re-acquire it, and across that read-then-create it was still consuming the
   *  fan-out durable, still running the inbox reader, and still answering ctl.delivery. If a
   *  replacement acquired the shard in that window, both processes served the same durables until
   *  the loser's create was refused and its teardown finished. The old code did not have this
   *  window, because it began shutting down on the first renew failure; treating that failure as a
   *  question instead of a verdict is right, but asking the question while still serving is not.
   *
   *  So the daemon goes quiet FIRST and re-arms only once it has proof: `held` on a re-read, or a
   *  won atomic create. `unknown` stays quiet, the whole point is that not being able to ask is not
   *  permission to keep acting. Quiescing costs delivery latency for a few seconds; the alternative
   *  costs a SPLIT durable, which is a correctness failure rather than an availability one.
   *
   *  Deliberately not `stop()`: the connection, the lease KV handles and the control rails must stay
   *  up, because the daemon still has to ask the broker who owns the shard. */
  async quiescePlane3(): Promise<void> {
    this.plane3Quiesced = true;
    if (this.deliveryServeSub) {
      try { this.deliveryServeSub.unsubscribe(); } catch { /* already dead */ }
      this.deliveryServeSub = undefined;
    }
    if (this.deliveryAdminServeSub) {
      try { this.deliveryAdminServeSub.unsubscribe(); } catch { /* already dead */ }
      this.deliveryAdminServeSub = undefined;
    }
    this.dropAnycastRequests();
    // Stopping the consumers ends the `for await` loops that drive fan-out and the reader. In-flight
    // messages are NOT acked by a stopped consumer, so they redeliver to whoever holds the shard
    // next: quiescing loses no message, it only stops this process from claiming them.
    for (const msgs of this.streamMsgs.splice(0)) {
      try { msgs.stop(); } catch { /* already draining */ }
    }
  }

  /** Whether Plane-3 is currently quiesced: unbound, and refusing to re-bind until ownership is proven.
   *  Read-only. The flag is the daemon's own answer to "am I serving this shard", so a cell that asserts
   *  a recovery worked can check the endpoint's state rather than inferring it from a log line. */
  plane3IsQuiesced(): boolean {
    return this.plane3Quiesced;
  }

  /** Resume serving Plane-3 after {@link quiescePlane3}, once ownership has been re-established.
   *  Idempotent, and a no-op when the daemon was never quiesced.
   *
   *  The flag is cleared ONLY after every binding is up, and restored if any of them throws. Clearing
   *  it first looks equivalent and is not: `armPlane3` binds in four stages (`manager`, the two control
   *  responders, the fan-out consumer, the reader), so a failure at any one leaves the endpoint recorded
   *  as un-quiesced while some of those are missing. From there every later `rearmPlane3` returns at the
   *  `!plane3Quiesced` guard WITHOUT attempting to bind, and the caller goes on to flip the lease READY.
   *  That is a readiness lie surviving a transient broker error, the daemon claims a responder it does
   *  not have, which is the #1318 outage wearing the readiness flag instead of the exit path. */
  async rearmPlane3(): Promise<void> {
    if (!this.plane3Quiesced) return;
    // `armPlane3` refuses while quiesced (a reconnect must not resume mid-question), so the flag is
    // lowered for the attempt and RAISED AGAIN on failure. A partial bind leaves the endpoint quiesced,
    // which is the honest state: not serving, and a later retry will attempt the whole sequence again.
    this.plane3Quiesced = false;
    try {
      await this.armPlane3();
    } catch (e) {
      this.plane3Quiesced = true;
      // Drop whatever DID bind. Leaving half-bound responders up would answer control requests for a
      // shard this process has just declared itself not to be serving.
      this.quiescePlane3();
      throw e;
    }
  }

  /** (Re)bind the Plane-3 fan-out writer + trusted reader. Idempotent — the durables resume from their
   *  cursor. Called by {@link startPlane3} once AND by {@link connectAndBind} on every (re)connect, so
   *  the delivery daemon's reconnect RE-ARMS the backstop + the ctl.delivery responder. Without this, a broker blip would silently kill
   *  the loops while `durableJoinFor` kept reporting `durable:true` (the impl-review's BLOCKER-1). No-op
   *  unless this endpoint hosts Plane-3 (`this.plane3` set). */
  async armPlane3(): Promise<void> {
    if (!this.plane3 || !this.js) return;
    // A quiesced endpoint must not be re-armed by a RECONNECT: the reconnect path calls this too,
    // and silently resuming there would restore exactly the double-serving this guards against
    // while the ownership question is still open.
    if (this.plane3Quiesced) return;
    await this.manager(); // the manager runs consume:false, so this.jsm is lazy — ensure it
    this.armDeliveryControl();
    await this.armAnycastRequests();
    await this.runFanout();
    await this.runReader();
  }

  /** (Re)register the `ctl.delivery` control responder on the CURRENT connection. A reconnect drains the
   *  old connection (the old sub is dead and `clearConnectionScoped` leaves caller-owned subs alone), so
   *  this MUST run on every arm — otherwise durable join/leave/list silently lose their responder after a
   *  broker blip. The stale sub is dropped (unsubscribed + removed from `this.subs`) before re-creating.
   *  `boundReply` is essential here: the daemon holds a wildcard reply-publish grant, so the serve path
   *  must reject any reply target outside the authenticated sender's own subtree (confused-deputy fix). */
  private armDeliveryControl(): void {
    if (this.deliveryServeSub) {
      try { this.deliveryServeSub.unsubscribe(); } catch { /* dead with the old connection */ }
      const i = this.subs.indexOf(this.deliveryServeSub);
      if (i >= 0) this.subs.splice(i, 1);
    }
    // A request's status and cancel touch only the TASK queue and the anycast records, so they do
    // not wait behind a channel join on the in-order chain.
    this.deliveryServeSub = this.serveControl(CONTROL_DELIVERY, (req) => this.handleDeliveryControl(req), {
      boundReply: true,
      concurrent: (req) => ANYCAST_CONTROL_OPS.has(req.op),
    });
    if (this.deliveryAdminServeSub) {
      try { this.deliveryAdminServeSub.unsubscribe(); } catch { /* dead with the old connection */ }
      const i = this.subs.indexOf(this.deliveryAdminServeSub);
      if (i >= 0) this.subs.splice(i, 1);
    }
    // The membership inventory is read-only and shares nothing with the other admin commands, so it
    // does not queue behind them. In a mass stop each retirement's inventory followed every other
    // seat's `evictPrincipal` on this rail and missed its 5 s deadline (#4965).
    this.deliveryAdminServeSub = this.serveControl(CONTROL_DELIVERY_ADMIN, (req) => this.handleDeliveryAdmin(req), {
      boundReply: true,
      concurrent: (req) => req.op === "lifecycleMemberships",
    });
  }

  /** Serve one PRIVILEGED delivery-admin request (the D5 rail-split). The cred layer is the caller
   *  boundary — only the supervisor profile can publish here — and `serveControl`'s sender check +
   *  bounded reply still apply on top. `reloadCreds` is the class-2 renewal ADOPTION step: re-read
   *  the renewal-owner-re-signed creds file, pin, swap the live connection, reconnect the membership
   *  feed's rw connection, and reply with proof (identities + the adopted JWT windows) — or a
   *  structured failure (e.g. the file was never re-signed), never a silent partial. */
  private async handleDeliveryAdmin(req: ControlRequest): Promise<ControlReply> {
    // A reload's resident swap reconnects the connection every reply here rides. A caller's next
    // request, such as a manager's eviction right after its reload, is answered once that
    // connection is back, not while it is down.
    await this.residentSwap;
    // FENCE: same reason as the runtime rail above.
    if (!this.plane3MayAct()) return { ok: false, error: "delivery: this daemon is not serving this shard (it is re-checking ownership); retry" };
    if (req.op === "reloadCreds") {
      // NOT BEFORE START-UP IS DONE (#2304). Both halves below would run: the delivery half commits
      // and schedules `nc.reconnect()`, which lands underneath start-up awaits still in flight on
      // this connection (the lease watch's consumer create times out and the daemon exits). Refuse
      // before either half acts, so nothing is adopted and the renewal owner records why.
      if (this.plane3?.startupComplete?.() === false)
        return { ok: false, error: "delivery: this daemon has not finished starting; nothing adopted - the next renewal pass or the daemon's 75% re-read adopts the re-signed creds" };
      // The renewal owner's EXPECTED-generation tokens (SHA-256 of each JWT it re-signed), per
      // component. A missing entry means "no expectation" (the passive backstop still adopts).
      const expected = (req.args?.expected ?? {}) as { delivery?: string; membership?: string };
      // Prove BOTH components INDEPENDENTLY (non-short-circuit): one failing must neither hide the
      // other's outcome nor be masked by it. Top-level `ok` is false if EITHER proof failed, so the
      // manager can never record a green adoption while a component was refused.
      // Each component's outcome claims only what is PROVEN: `brokerAccepted` (the preflight) carries
      // the accepted generation's window; `residentSwap` records that the wire swap is best-effort and
      // self-healing, NOT witnessed. Neither claims verified resident reauth (that would need a
      // generation-tied reconnect witness on both connections).
      const [delivery, membership] = await Promise.all([
        this.reloadCreds(expected.delivery).then(
          (brokerAccepted) => ({ ok: true as const, brokerAccepted, residentSwap: "scheduled" as const }),
          (e) => ({ ok: false as const, error: (e as Error).message }),
        ),
        this.plane3?.reloadMembershipCreds
          ? this.plane3.reloadMembershipCreds(expected.membership).then(
              (result) => ({ ok: true as const, ...(result as object) }),
              (e) => ({ ok: false as const, error: (e as Error).message }),
            )
          : Promise.resolve({ ok: true as const, skipped: "no-membership-hook" }),
      ]);
      const failures = [
        delivery.ok ? undefined : `delivery: ${delivery.error}`,
        membership.ok ? undefined : `membership: ${membership.error}`,
      ].filter((m): m is string => m !== undefined);
      // Arm the resident wire swap ONLY now — after BOTH proofs settled, right before the reply is
      // returned+responded — so a slow membership proof can never let the delivery reconnect strand
      // this reply. Only when delivery actually adopted a new candidate (currentCreds was updated).
      if (delivery.ok) {
        this.plane3?.onDeliveryCredsAdopted?.();
        this.scheduleResidentSwap();
      }
      return failures.length
        ? { ok: false, error: failures.join("; "), data: { delivery, membership } }
        : { ok: true, data: { delivery, membership } };
    }
    if (req.op === "evictPrincipal") {
      // The LIVE-EVICTION executor: force-drop a denied principal's connections.
      // Composition-root hook because the $SYS observer/evictor creds live outside this endpoint's
      // trust boundary; absent hook = a daemon build without the executor, refused loudly.
      if (!this.plane3?.evictPrincipal)
        return { ok: false, error: "evictPrincipal: no eviction executor wired on this daemon" };
      const principal = typeof req.args?.principal === "string" ? req.args.principal.trim() : "";
      if (!principal) return { ok: false, error: "evictPrincipal: a principal (owner.actor dot-form) is required" };
      try {
        return { ok: true, data: await this.plane3.evictPrincipal(principal) };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
    if (req.op === "evictPrincipals") {
      // The same executor over a SET: one shared sweep instead of one request and one scan per
      // principal. The set is bounded so one request stays inside one sweep's work.
      if (!this.plane3?.evictPrincipals)
        return { ok: false, error: "evictPrincipals: no batch eviction executor wired on this daemon" };
      const raw: unknown = req.args?.principals;
      const principals = Array.isArray(raw) ? raw.map((p) => (typeof p === "string" ? p.trim() : "")) : [];
      if (principals.length === 0 || principals.some((p) => !p))
        return { ok: false, error: "evictPrincipals: principals must be a non-empty array of owner.actor dot-form principals" };
      if (principals.length > EVICT_PRINCIPALS_MAX || new Set(principals).size !== principals.length)
        return { ok: false, error: `evictPrincipals: principals must be distinct and at most ${EVICT_PRINCIPALS_MAX}` };
      try {
        return { ok: true, data: await this.plane3.evictPrincipals(principals) };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
    if (req.op === "planeConnLiveness") {
      // The plane-claim liveness oracle (#29 HIGH 3): a CLOSED read-only verb — two claimed
      // scanner tuples in, two bound verdicts + sweep completeness out. The executor hook owns
      // the closed query validation (it holds the $SYS observer cred outside this trust boundary);
      // absent hook = a daemon build without the oracle, refused loudly (the auth plane treats
      // that refusal as UNKNOWN and never reclaims over it).
      if (!this.plane3?.planeConnLiveness)
        return { ok: false, error: "planeConnLiveness: no plane-liveness oracle wired on this daemon" };
      try {
        return { ok: true, data: await this.plane3.planeConnLiveness(req.args?.query) };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
    if (req.op === "lifecycleMemberships") {
      // The terminal teardown's membership INVENTORY: a complete, read-only, lifecycle-exact listing
      // of one principal's durable membership rows (tombstones included) from the trusted daemon that
      // owns the members bucket. The caller deletes only the exact keys it gets back, through its
      // target-pinned deprovisioner grant; this verb deletes nothing and returns no other lifecycle.
      const principal = typeof req.args?.principal === "string" ? req.args.principal.trim() : "";
      const uid = typeof req.args?.lifecycleUid === "string" ? req.args.lifecycleUid : "";
      if (!parsePrincipalKey(principal)) return { ok: false, error: "lifecycleMemberships: a principal (owner.actor dot-form) is required" };
      try { assertLifecycleToken(uid); } catch (e) { return { ok: false, error: `lifecycleMemberships: ${(e as Error).message}` }; }
      // A retirement fences the lifecycle's ACL row before it asks (fenceLifecycleAcl), and every join
      // re-reads that row around the row it creates, so a row written after this read begins removes
      // itself, on whichever daemon wrote it. For a manager that does not fence, this daemon's own
      // memberships of the lifecycle stop changing here (#4965): a join or leave bound to it is refused
      // from now on, and the read starts after the ones already running have finished.
      let marked = this.retiringLifecycles.get(principal);
      if (marked === undefined) this.retiringLifecycles.set(principal, (marked = new Set()));
      // An earlier lifecycle of this principal whose ACL row is retired can bind no join or leave any
      // more, so its mark goes. A failed read keeps the mark, which only ever refuses.
      for (const earlier of [...marked])
        if (earlier !== uid && await aclRetired(await this.aclRegistry(), principal, earlier).catch(() => false)) marked.delete(earlier);
      // A mark is kept only for an inventory whose caller did not fence (#4996): a lifecycle whose ACL
      // row is narrowed to no reads, or already retired, needs none, since every join re-reads that
      // row around its write. A read that fails proves nothing, so the mark is kept, which only refuses.
      if (await this.lifecycleAclUnfenced(principal, uid)) marked.add(uid);
      else if (marked.size === 0) this.retiringLifecycles.delete(principal);
      await Promise.allSettled(this.membershipWrites.get(`${principal}/${uid}`) ?? []);
      try {
        const channels = await listLifecycleMemberChannels(await this.membersRegistry(), principal, uid);
        return { ok: true, data: { complete: true, channels } };
      } catch (e) {
        return { ok: false, error: `lifecycleMemberships: the inventory read did not complete (${(e as Error).message})` };
      }
    }
    if (req.op === "principalLiveness") {
      // The freeze-holder liveness probe (#391): the READ-ONLY half of `evictPrincipal`. A repair
      // that must REFUSE while the holder is alive cannot use eviction as its own precheck — that
      // kills the holder before anything can refuse on its behalf. Same executor-hook shape as the
      // verbs above (the $SYS observer cred lives outside this trust boundary); absent hook =
      // refused loudly, and the caller maps a refusal to UNKNOWN and never repairs over it.
      if (!this.plane3?.principalLiveness)
        return { ok: false, error: "principalLiveness: no liveness oracle wired on this daemon" };
      const principal = typeof req.args?.principal === "string" ? req.args.principal.trim() : "";
      if (!principal) return { ok: false, error: "principalLiveness: a principal (owner.actor dot-form) is required" };
      try {
        return { ok: true, data: await this.plane3.principalLiveness(principal) };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
    if (req.op === "reloadStoreIdentity") {
      // Proof that this daemon reloads standing creds from ONE named store. The manager
      // compares it to its remint store before every renewal pass. Absent hook
      // is a daemon that cannot name its store, which is itself a divergent composition.
      if (!this.plane3?.reloadStoreIdentity)
        return { ok: false, error: "reloadStoreIdentity: this daemon did not name the SecretStore it reloads from" };
      try {
        const identity = this.plane3.reloadStoreIdentity();
        // WHO IS ANSWERING is part of the answer. This rail is queue-grouped, so the broker hands
        // the request to any bound responder, and every process with a `delivery` credential for
        // the space can bind it, while only the DELIVERY LEASE HOLDER actually reloads the standing
        // credentials. A bare store identity therefore lets a second responder's store stand in for
        // the reloading process's, and the manager's remint decision is then made about a process
        // that reloads nothing. So the reply carries this responder's wire identity and whether it
        // holds the lease, and the caller requires the binding (#1694).
        //
        // The lease read is the LIVE row, not a cached claim: a holder that lost the shard must not
        // keep asserting it. A read that fails is reported as `false` rather than thrown, because
        // "I cannot prove I hold the shard" is what a non-holder's answer says, and it sends the
        // caller down the same fail-closed path rather than inventing an authority.
        let holdsDeliveryLease = false;
        try {
          const own = await this.readDeliveryLeaseEntry(0);
          holdsDeliveryLease = own !== undefined && this.ownsDeliveryLease(own.info);
        } catch {
          holdsDeliveryLease = false;
        }
        // Round-trip through the closed parser so a hook cannot smuggle extra fields onto the rail.
        return { ok: true, data: { identity: parseSecretStoreIdentity(identity), responder: this.card.id, holdsDeliveryLease } };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
    return { ok: false, error: `op "${req.op}" not supported on the delivery admin service` };
  }

  /** Create one of the daemon's Plane-3 durables. A named create is idempotent for the same config,
   *  and a denial is never taken for existence. The one conflict accepted is this durable as a full
   *  restore recreated it, starting after its recorded ACK floor ({@link isRestoredConsumer}); every
   *  other failure propagates. */
  private async addPlane3Durable(stream: string, config: Partial<ConsumerConfig>): Promise<void> {
    try { await this.jsm!.consumers.add(stream, config); }
    catch (e) {
      if (!isConsumerAlreadyExists(e) || !isRestoredConsumer(this.space, stream, await this.jsm!.consumers.info(stream, config.durable_name!), config)) throw e;
    }
  }

  /** Fan-out loop: bind the privileged `fanout` durable on CHAT and route each message (routing only —
   *  the trusted reader is the auth gate). */
  private async runFanout(): Promise<void> {
    if (!this.js || !this.jsm) return;
    await this.addPlane3Durable(chatStream(this.space), fanoutDurableConfig(this.space, { ackWaitMs: this.ackWaitMs }));
    const consumer = await this.js.consumers.get(chatStream(this.space), FANOUT_DURABLE);
    const msgs = await consumer.consume();
    this.streamMsgs.push(msgs);
    void (async () => {
      for await (const m of msgs) {
        try { await this.fanOutMessage(m); }
        catch (e) { if (!this.stopped) this.emit("error", e as Error); try { m.nak(); } catch { /* draining */ } }
      }
    })().catch((e) => { if (!this.stopped) this.emit("error", e as Error); });
  }

  /** Route ONE chat message to eligible owners' mixed inboxes. `durable` channel → its `durable-active`
   *  members within interval; `live` channel → `@mention` targets authorized to read it (ACL only).
   *  On either class, a mention of an agent whose read ACL excludes the channel is reported to the
   *  sender with a mention notice. Members KV is scanned FRESH per message (no cache — red-team
   *  BLOCKER-1 catch-up correctness). */
  private async fanOutMessage(m: JsMsg): Promise<void> {
    // FENCE, and NOT followed by an ack: this unit was dispatched before the quiesce and is resuming
    // after it, so writing the fan-out now would put entries in member inboxes on behalf of a shard
    // this daemon no longer serves. Returning WITHOUT acking is the whole point - a stopped consumer
    // redelivers to whoever holds the shard next, so refusing here loses no message, while acking it
    // would consume the successor's work.
    if (!this.plane3MayAct()) return;
    const parsed = parseSubject(m.subject);
    if (!parsed || parsed.kind !== "chat") { m.ack(); return; }
    const channel = parsed.rest;
    let msg: CotalMessage;
    try { msg = m.json<CotalMessage>(); } catch { m.ack(); return; }
    if (!isFromSubjectSender(msg, parsed)) { m.ack(); return; } // authenticity (SPEC §5)
    const seq = m.seq;
    const normalizedMsg = authenticatedChannelMessage(msg, channel);
    // SECOND FENCE, AT THE COMMIT POINT. The entry check above cannot cover this unit's own awaits:
    // the class read and the member scan below both hit the broker, and a daemon descheduled inside
    // them can resume after a successor owns the shard. Re-ask immediately before the first WRITE,
    // and again return without acking so the entry redelivers rather than being consumed here.
    if (!this.plane3MayAct()) return;
    const durable = (await this.deliveryClassFresh(channel)) === "durable";
    // Each mention is resolved once. A live channel delivers to the agents among them that may read
    // it, and on either class a mention of an agent that may not read the channel is reported to the
    // sender below, so a post never claims a reader it cannot have.
    const mentioned: Array<{ name: string; owner: string; row: { allowSubscribe: string[]; lifecycleUid: string } }> = [];
    for (const name of msg.mentions ?? []) {
      const owner = this.resolveOwnerByName(name);
      if (!owner || owner === msg.from.id) continue;
      // A mention arrives as an ALIAS (the roster names no lifecycle): resolve its single live ACL
      // row for BOTH the read-authorization and the lifecycle to address. Ambiguity (two live rows)
      // refuses THIS copy loudly rather than guessing a lifecycle.
      let row: { allowSubscribe: string[]; lifecycleUid: string } | undefined;
      try { row = await this.aclForAlias(owner); }
      catch (e) { this.emit("error", e as Error); continue; }
      if (row) mentioned.push({ name, owner, row });
    }
    if (durable) {
      // The channel's own rows and every family row above it (`review.>`). A lifecycle holding two of
      // them gets two publishes and keeps one copy: the dedupe id is per message and lifecycle (#5404).
      for (const rec of await listMembers(await this.membersRegistry(), { covering: channel })) {
        if (rec.owner === msg.from.id) continue;      // never backstop the sender's own post
        if (!durableEligible(rec, seq)) continue;     // routing fast-filter (reader re-checks)
        // Address the member row's RECORDED lifecycle: a retired row (tombstone pending) routes to the
        // retired lifecycle's inbox, never the alias's new occupant (SPEC 13.1 cross-plane scoping).
        // Store the AUTHENTICATED-channel copy (main's normalization): the durable frame validates
        // msg.channel === frame.channel, and payload to/toService are stripped.
        // Per-copy, because the scan above and every publish below is a broker round trip: a fan-out
        // to fifty members can straddle a quiesce in its middle. Stopping part-way is safe where
        // stopping late is not - the entry is never acked here, so the successor redelivers it and
        // re-sends the whole set; publishDinbox is idempotent per (owner, lifecycle, msgID).
        if (!this.plane3MayAct()) return;
        await this.publishDinbox(rec.owner, rec.lifecycleUid, {
          msg: normalizedMsg, channel, seq, reason: "durable-channel", generation: rec.generation,
          ...(rec.channel !== channel ? { row: rec.channel } : {}),
        });
      }
    } else {
      for (const { owner, row } of mentioned) {
        if (!channelInAllow(row.allowSubscribe, channel)) continue; // @mention can't bypass the read ACL
        if (!this.plane3MayAct()) return;   // same rule on the live-mention path
        await this.publishDinbox(owner, row.lifecycleUid, { msg: normalizedMsg, channel, seq, reason: "live-mention", generation: 0 });
      }
    }
    const unreadable = mentioned.filter(({ row }) => !channelInAllow(row.allowSubscribe, channel)).map(({ name }) => name);
    if (unreadable.length) {
      if (!this.plane3MayAct()) return;
      await this.sendMentionNotice(msg, channel, seq, unreadable);
    }
    // FINAL FENCE, BEFORE THE ACK ITSELF, which is the real commit: acking tells the stream this
    // shard's work is done. A daemon that stopped serving mid-fan-out must not make that claim, or
    // the successor never sees the entry and the message is lost outright rather than duplicated.
    if (!this.plane3MayAct()) return;
    m.ack();
  }

  /** The DLV count the trusted writer stamps on a copy (SPEC §8): the stream's `max_msgs_per_subject`,
   *  read at most {@link DELIVERY_LIMIT_READ_MS} before the write, as a whole number or `none`. */
  private async deliveryLimitStamp(): Promise<string> {
    const at = Date.now();
    if (this.deliveryLimitRead && at - this.deliveryLimitRead.at < DELIVERY_LIMIT_READ_MS) return this.deliveryLimitRead.stamp;
    const count = (await this.jsm!.streams.info(dlvStream(this.space))).config.max_msgs_per_subject;
    const stamp = count === HISTORY_NO_COUNT || count < 1 ? "none" : String(count);
    this.deliveryLimitRead = { at, stamp };
    return stamp;
  }

  /** Trusted-reader loop: bind the single privileged `reader` durable over `dinbox.>` and re-authorize
   *  + transfer each entry. */
  private async runReader(): Promise<void> {
    if (!this.js || !this.jsm) return;
    await this.addPlane3Durable(inboxStream(this.space), inboxReaderConfig(this.space, { ackWaitMs: this.ackWaitMs }));
    const consumer = await this.js.consumers.get(inboxStream(this.space), INBOX_READER_DURABLE);
    const msgs = await consumer.consume();
    this.streamMsgs.push(msgs);
    void (async () => {
      for await (const m of msgs) {
        try { await this.readerHandle(m); }
        catch (e) { if (!this.stopped) this.emit("error", e as Error); try { m.nak(); } catch { /* draining */ } }
      }
    })().catch((e) => { if (!this.stopped) this.emit("error", e as Error); });
  }

  /** Whether one of the lifecycle's rows covering concrete `channel`, the channel's own or a family
   *  above it, is eligible for the post at `seq`. One exact read per row, the channel's own first. */
  private async lifecycleCoversPost(owner: string, lifecycleUid: string, channel: string, seq: number): Promise<boolean> {
    const kv = await this.membersRegistry();
    for (const row of [channel, ...familiesCovering(channel).reverse()]) {
      const rec = await readMember(kv, row, owner, lifecycleUid);
      if (rec && durableEligible(rec.record, seq)) return true;
    }
    return false;
  }

  /** Remove a retired lifecycle's member row for `channel`, when one exists. Best effort: the row
   *  authorizes nothing (its ACL row is retired), and the next entry fan-out writes against it
   *  brings the reader back here. */
  private async removeRetiredMemberRow(channel: string, owner: string, lifecycleUid: string): Promise<void> {
    try {
      const kv = await this.membersRegistry();
      if (await readMember(kv, channel, owner, lifecycleUid) === undefined) return;
      await deleteMember(kv, channel, owner, lifecycleUid);
    } catch (e) {
      this.emit("warning", new Error(`plane-3 reader: could not remove retired lifecycle ${owner}.${lifecycleUid}'s "${channel}" member row: ${(e as Error).message}`));
    }
  }

  /** Re-authorize ONE mixed-inbox entry and transfer it to the owner's DELIVER store. Deny (drop) on a
   *  revoked/narrowed ACL or out-of-interval seq; on transfer success, ack the mixed entry (durability
   *  has moved to DLV — an §8 equivalent per-member at-least-once mechanism). The agent acks DLV. */
  private async readerHandle(m: JsMsg): Promise<void> {
    // FENCE, same rule as the fan-out writer: no effect and no ack once this daemon has stopped
    // serving the shard. The entry redelivers to the holder rather than being consumed here.
    if (!this.plane3MayAct()) return;
    const pr = parseDinboxPrincipal(m.subject);
    if (!pr) { m.ack(); return; } // unparseable subject (incl. a pre-cut 5-segment form) — not a real entry
    const owner = `${pr.owner}.${pr.actor}`; // the member principal dot-form (acl/member keys, msgID)
    let entry: Plane3Entry;
    try { entry = m.json<Plane3Entry>(); } catch { m.ack(); return; } // undecodable — drop
    if (!isRecord(entry)) { m.ack(); return; } // non-object envelope — permanently invalid
    const redeliveries = m.info?.deliveryCount ?? 1; // JsMsg delivery attempts (1 on first delivery)
    // Lifecycle-exact ACL re-auth (SPEC 13.1): the entry was addressed to pr.lifecycleUid's inbox, so
    // the row read is that lifecycle's exact key — a retired lifecycle's purged row reads as unknown
    // and its residual entries are removed below, never authorized against the successor's row.
    const acl = await this.plane3?.aclFor(owner, pr.lifecycleUid);
    if (acl === undefined) {
      // RETIRED lifecycle: its exact ACL key carries retirement's tombstone, so no attempt can ever
      // deliver this entry. Drop it AND remove it from the store. Deferring it to the ceiling and
      // keeping it would make every reader that starts from a fresh cursor pay the same sweep again.
      // An ACL row that is merely absent proves nothing and still defers below.
      if (await aclRetired(await this.aclRegistry(), owner, pr.lifecycleUid)) {
        if (!this.plane3MayAct()) return;
        // Remove BEFORE the ack. The ack ends the reader's work on this entry, so acking first and
        // then failing the delete would keep the entry with nothing left to remove it. A failed delete
        // stays pending and retries, bounded by the same ceiling; an entry the stream no longer holds
        // is already removed (the broker answers a delete of a missing sequence with 10043).
        let failure: Error | undefined;
        try { await this.jsm!.streams.deleteMessage(inboxStream(this.space), m.seq, false); }
        catch (e) { if (!isJetStreamMissing(e, 10043)) failure = e instanceof Error ? e : new Error(String(e)); }
        // FENCE AFTER THE DELETE, which is broker I/O. A daemon that stopped serving while it was in
        // flight leaves the entry to the holder: a term here would move the shared durable past an entry
        // the failed delete left stored, so the holder would never retry it.
        if (!this.plane3MayAct()) return;
        if (failure) {
          if (redeliveries >= READER_MAX_REDELIVERIES) {
            m.term();
            this.emit("error", new Error(`plane-3 reader: gave up removing entry ${m.seq} for retired lifecycle ${owner}.${pr.lifecycleUid} after ${redeliveries} redeliveries: ${failure.message}`));
            return;
          }
          m.nak(2000);
          return;
        }
        // The member row that addressed this entry is one a daemon left behind when it died between
        // its create and its post-write ACL read (#4994). It authorizes nothing, but fan-out copies
        // every later message on the channel into this inbox until it goes, and this reader then
        // removes each copy. Remove the row where that cost is paid, by its exact key, only when it
        // exists: a purge of an absent key would write a marker per dropped entry.
        if (entry.reason === "durable-channel") await this.removeRetiredMemberRow(entry.row ?? entry.channel, owner, pr.lifecycleUid);
        if (!this.plane3MayAct()) return;
        m.ack();
        return;
      }
      // UNKNOWN owner — the manager has not (re)hydrated this owner's ACL yet (e.g. right after a
      // manager PROCESS restart). This is NOT a revocation: DEFER (redeliver), never drop — an ack here
      // would lose at-least-once on restart (impl-review BLOCKER-2). A delayed nak + a redelivery
      // ceiling stops one perma-unknown owner from head-of-lining the shared reader.
      // (Follow-up: the manager does not yet rehydrate its managed set across a process restart — until
      // it does, a long-unknown owner's entries term after the ceiling; tracked, not a silent ack-drop.)
      if (redeliveries >= READER_MAX_REDELIVERIES) {
        m.term();
        this.emit("error", new Error(`plane-3 reader: gave up on entry for unknown owner ${owner} after ${redeliveries} redeliveries`));
        return;
      }
      m.nak(2000);
      return;
    }
    // KNOWN owner whose CURRENT ACL no longer covers the channel — a revocation/narrowing. Drop: the
    // entry is no longer authorized (SPEC §7 current-ACL gate before surfacing).
    if (!channelInAllow(acl, entry.channel)) { m.ack(); return; }
    // INTERVAL re-auth (not a current-member boolean): a pre-leave entry (seq ≤ leaveCursor) stays
    // deliverable; seq > leaveCursor (or after a rejoin's newer joinCursor) is the hard cut. Any of the
    // lifecycle's rows that cover the channel may hold the post, whichever row addressed the copy.
    if (entry.reason === "durable-channel" && !(await this.lifecycleCoversPost(owner, pr.lifecycleUid, entry.channel, entry.seq))) { m.ack(); return; }
    // COMMIT-POINT FENCE. Everything above this line is broker I/O - the ACL read and the member
    // re-read - so the entry check at the top of the handler is stale by now if this unit was
    // descheduled inside either. The transfer below is the effect that must not happen on behalf of
    // a shard we no longer serve; returning without acking leaves it for the holder.
    if (!this.plane3MayAct()) return;
    try {
      // DLV has no original chat subject, so preserve the channel the trusted fan-out reader derived
      // from CHAT. Never let the publisher-controlled payload label choose connector attention.
      const frame: Plane3DeliveryFrame = {
        version: 1,
        channel: entry.channel,
        msg: authenticatedChannelMessage(entry.msg, entry.channel),
      };
      const frameHeaders = headers();
      frameHeaders.set(PLANE3_FRAME_HEADER, "1");
      // The count read may be broker I/O, so the fence is asked again before the write.
      frameHeaders.set(DELIVERY_LIMIT_HEADER, await this.deliveryLimitStamp());
      if (!this.plane3MayAct()) return;
      // Lifecycle-keyed subject + msgID (ours): the DLV consumer filters on the lifecycle-scoped
      // subject (streams.ts filter_subject), and a predecessor's transferred copy must never suppress
      // a successor's under the same alias (disjoint lifecycles, stream-wide dedupe).
      await this.js!.publish(dlvSubject(this.space, pr.owner, pr.actor, pr.lifecycleUid), JSON.stringify(frame), {
        ...this.plane3MsgId(entry, `${owner}:${pr.lifecycleUid}`),
        headers: frameHeaders,
      });
    } catch {
      // EVERY transfer failure is deliberately a retry, never a successful result. Keep the entry
      // pending (redeliver), bounded by the same ceiling so a poison
      // entry can't head-of-line the shared reader forever.
      if (redeliveries >= READER_MAX_REDELIVERIES) {
        m.term();
        this.emit("error", new Error(`plane-3 reader: gave up transferring ${entry.msg.id} for ${owner} after ${redeliveries} redeliveries`));
        return;
      }
      m.nak(2000);
      return;
    }
    // The ack is the last commit: the transfer above already happened, so the only question left is
    // whether THIS daemon may retire the source entry. If it stopped serving mid-transfer, leave the
    // entry pending - the successor re-transfers and stream-wide dedupe on the msgID collapses the
    // duplicate, which is the recoverable direction. Acking here is the unrecoverable one.
    if (!this.plane3MayAct()) return;
    m.ack();
  }

  /** Agent-side: bind + pump our pre-created Plane-3 DELIVER durable (`dlv_<id>`). Every message here is
   *  delivery-daemon-written (DLV is delivery-write-only, broker-enforced) and is a CHANNEL message by contract
   *  (the backstop never carries DMs), so `kind=channel` is path-derived (SPEC §4) and the body is
   *  trusted (no spoof-guard). `durable:true` — real JetStream ack, coalesced with the core-sub live
   *  copy by `MeshAgent.ingest`. No-op when the durable isn't present (open mode / not provisioned). A read
   *  list declared on a credential that cannot fetch the durable refuses. */
  async pumpDlv(): Promise<void> {
    if (!this.js) return;
    if (!this.ownLifecycleUid) return; // no lifecycle uid — never provisioned for Plane-3 (its durable is lifecycle-keyed)
    if (this.allowSubscribe?.length === 0) return; // known channel-less grant: no DLV durable or bind rows exist
    const durable = dlvDurable(this.owner, this.actor, this.ownLifecycleUid);
    if (this.allowSubscribe === undefined && !this.userMode && this.nc) {
      // Native credential-only clients have no separate ACL option. Use the publish permissions
      // captured when THIS connection authenticated; a callout sentinel does not carry the grant.
      const permission = this.watchDeletePermissions.get(this.nc)?.();
      // Only an absent allow selects no binding. A declared bind with a deny still reaches the
      // broker and fails, so a refusal cannot masquerade as a channel-less credential.
      if (permission && !issuedPermitsSubject({ ...permission, deny: [] }, `$JS.API.CONSUMER.INFO.${dlvStream(this.space)}.${durable}`)) return;
    }
    let consumer;
    try { consumer = await this.js.consumers.get(dlvStream(this.space), durable); }
    catch (e) {
      if (isJetStreamMissing(e, JetStreamApiCodes.ConsumerNotFound)) {
        // A channel-less credential may ask about its durable but holds no fetch row for it. A read
        // list declared on such a credential disagrees with the grant, so the start refuses.
        const issued = this.nc && this.watchDeletePermissions.get(this.nc)?.();
        if ((this.allowSubscribe?.length ?? 0) > 0 && issued
          && !issuedPermitsSubject({ ...issued, deny: [] }, `$JS.API.CONSUMER.MSG.NEXT.${dlvStream(this.space)}.${durable}`))
          throw new Error(`this connection declared a read list, but its credential cannot fetch delivery durable "${durable}" for space "${this.space}"; the read list and the credential disagree`);
        return;
      }
      throw e; // a denied bind is not evidence that the read ACL is empty or the durable is absent
    }
    const lease = await this.readDeliveryLease(0);
    const liveDeliveryPlane = lease?.ready === true;
    if (!liveDeliveryPlane) this.emit("warning", new Error(
      `delivery durable "${durable}" for space "${this.space}" bound while the plane this connection reaches has no ready delivery lease, so the durable delivers nothing until a delivery daemon serves this plane. If a daemon serves this space on another plane, reconnect against it, which re-binds the durable there.`,
    ));
    const ackWaitMs = await ackWaitOf(consumer);
    const msgs = await consumer.consume();
    this.streamMsgs.push(msgs);
    void (async () => {
      for await (const m of msgs) {
        // A copy with a full store behind it means the store held its count, so older copies may have
        // been discarded unread (#5404); NATS gives no notice of the discard itself. The count is the
        // one the trusted writer stamped on this copy. Checked on every delivery, ahead of the checks
        // below and the connector's id dedupe, so a copy the agent also got live cannot hide it. The
        // connector folds repeats into one notice.
        let limit: number | null;
        try { limit = deliveryLimitOf(m.headers?.get(DELIVERY_LIMIT_HEADER)); }
        catch (e) { this.emit("error", e as Error); limit = null; }
        if (limit !== null && m.info.pending >= limit - 1) this.emit("stored-copies-full", { limit });
        // The header is minted only by the trusted DLV writer. A body-only discriminator is
        // insufficient because old Cotal envelopes permit unknown fields and could imitate it.
        if (m.headers?.get(PLANE3_FRAME_HEADER) !== "1") {
          this.emit("error", new Error("plane-3 delivery: unauthenticated or unversioned DLV entry terminated"));
          try { m.term(); } catch { /* draining */ }
          continue;
        }
        let raw: unknown;
        try { raw = m.json<unknown>(); } catch (e) { this.emit("error", e as Error); try { m.term(); } catch { /* draining */ } continue; }
        if (!isPlane3DeliveryFrame(raw)) {
          this.emit("error", new Error("plane-3 delivery: malformed versioned DLV entry terminated"));
          try { m.term(); } catch { /* draining */ }
          continue;
        }
        const msg = authenticatedChannelMessage(raw.msg, raw.channel);
        if (msg.from?.id === this.card.id) { m.ack(); continue; } // own echo (defensive)
        this.emit("message", msg, durableDelivery(m, ackWaitMs), { historical: false, kind: "channel" } satisfies MessageMeta);
      }
    })().catch((e) => { if (!this.stopped) this.emit("error", e as Error); });
  }
}

/** The deps of one endpoint's {@link EndpointDeliveryPlane}. Every value is read from `ep` when it is used, so a field
 *  assigned after construction is seen, and a member a caller replaced on the endpoint is the one that runs. */
export function endpointDeliveryPlaneDeps(ep: CotalEndpoint): EndpointDeliveryPlaneDeps {
  return {
    ackWaitMs: () => ep["ackWaitMs"],
    actor: () => ep["actor"],
    owner: () => ep["owner"],
    allowSubscribe: () => ep["allowSubscribe"],
    anycastUnavailable: () => ep["anycastUnavailable"],
    card: () => ep["card"],
    js: () => ep["js"],
    jsm: () => ep["jsm"],
    nc: () => ep["nc"],
    ownLifecycleUid: () => ep["ownLifecycleUid"],
    residentSwap: () => ep["residentSwap"],
    space: () => ep["space"],
    stopped: () => ep["stopped"],
    streamMsgs: () => ep["streamMsgs"],
    subs: () => ep["subs"],
    userMode: () => ep["userMode"],
    watchDeletePermissions: () => ep["watchDeletePermissions"],
    maxPayload: () => ep["maxPayload"],
    aclForAlias: (...args) => ep["aclForAlias"](...args),
    channelHistory: (...args) => ep["channelHistory"](...args),
    deliveryClassFresh: (...args) => ep["deliveryClassFresh"](...args),
    durableJoinFor: (...args) => ep["durableJoinFor"](...args),
    durableLeaveFor: (...args) => ep["durableLeaveFor"](...args),
    ownerMemberships: (...args) => ep["ownerMemberships"](...args),
    ownsDeliveryLease: (...args) => ep["ownsDeliveryLease"](...args),
    readDeliveryLease: (...args) => ep["readDeliveryLease"](...args),
    readDeliveryLeaseEntry: (...args) => ep["readDeliveryLeaseEntry"](...args),
    reloadCreds: (...args) => ep["reloadCreds"](...args),
    serveControl: (...args) => ep["serveControl"](...args),
    aclRegistry: (...args) => ep["aclRegistry"](...args),
    membersRegistry: (...args) => ep["membersRegistry"](...args),
    armAnycastRequests: (...args) => ep["armAnycastRequests"](...args),
    deliveryAnycast: (...args) => ep["deliveryAnycast"](...args),
    dropAnycastRequests: (...args) => ep["dropAnycastRequests"](...args),
    manager: (...args) => ep["manager"](...args),
    notLiveMsg: (...args) => ep["notLiveMsg"](...args),
    plane3MsgId: (...args) => ep["plane3MsgId"](...args),
    publishDinbox: (...args) => ep["publishDinbox"](...args),
    resolveOwnerByName: (...args) => ep["resolveOwnerByName"](...args),
    scheduleResidentSwap: (...args) => ep["scheduleResidentSwap"](...args),
    sendMentionNotice: (...args) => ep["sendMentionNotice"](...args),
    emit: (event, ...args) => ep["emit"](event, ...args),
  };
}
