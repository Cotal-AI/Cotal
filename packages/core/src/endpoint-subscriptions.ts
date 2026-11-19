// The dynamic subscription region of CotalEndpoint (join, leave, channel listing and the membership
// feed watches), as an internal component. Moved verbatim from endpoint.ts; the endpoint keeps the
// public methods and forwards to them. Not re-exported by the index.
import { ClosedConnectionError, TimeoutError, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager, JetStreamApiCodes, type ConsumerInfo, type JetStreamManager, type JsMsg, type PushConsumer } from "@nats-io/jetstream";
import { Kvm, type KV, type KvEntry } from "@nats-io/kv";
import { Bucket, KvWatchInclude } from "@nats-io/kv/internal";
import { effectiveDeliveryClass } from "./channels.js";
import { isPublishPermissionDenied } from "./endpoint.js";
import type { IssuedSubjectPermission } from "./issued-authority.js";
import { isJetStreamMissing } from "./jetstream-missing.js";
import { lastKvEntries } from "./kv-scan.js";
import { chatStream, dmStream, isChannelFamily, isConcreteChannel, isPrincipalOwnerToken, membershipBucket, MEMBERSHIP_FEED_KEY, parseSubject } from "./subjects.js";
import type { AgentCard, ChannelConfig, ChannelDefaults, ChannelMembership, MembershipChange, MembershipEntry, MembershipSnapshot } from "./types.js";

/** One feed entry, decoded the way {@link CotalEndpoint.readMembership} decodes it: the reserved
 *  heartbeat key carries `asOf`, every other key is one agent's record, and an undecodable record
 *  is a member change with no record (never a crash in the consumer callback). */
function membershipChange(e: KvEntry, update: boolean): MembershipChange {
  const operation = e.operation;
  if (e.key === MEMBERSHIP_FEED_KEY) {
    let asOf: number | undefined;
    if (operation === "PUT") { try { asOf = e.json<{ observedAt: number }>().observedAt; } catch { /* heartbeat garbled; leave undefined */ } }
    return { type: "heartbeat", revision: e.revision, update, asOf };
  }
  let member: MembershipEntry | undefined;
  if (operation === "PUT") {
    try {
      const rec = e.json<ChannelMembership>();
      member = { id: e.key, live: rec.live ?? [], durable: rec.durable ?? [], observedAt: rec.observedAt };
    } catch { /* undecodable: delivered as a change with no record */ }
  }
  return { type: "member", id: e.key, operation, revision: e.revision, update, member };
}
export type MembershipFeedWatch = {
  onChange: (change: MembershipChange) => void;
  onClosed?: (err: Error) => void;
  iter?: { stop(): void };
  consumer?: PushConsumer;
  consumerStream?: string;
  consumerName?: string;
  stopped: boolean;
  arm: Promise<void>;
  stopPromise?: Promise<void>;
  resolveStop?: () => void;
  rejectStop?: (err: unknown) => void;
};
/** What the subscriptions component reads from its endpoint. State is read when it is used, never
 *  copied, and every method is looked up on the endpoint at call time, so a test that replaces one
 *  of those methods on the endpoint is seen here. */
export interface EndpointSubscriptionsDeps {
  nc: () => NatsConnection | undefined;
  jsm: () => JetStreamManager | undefined;
  space: () => string;
  card: () => AgentCard;
  stopped: () => boolean;
  authed: () => boolean;
  channels: () => string[];
  channelConfigs: () => Map<string, ChannelConfig>;
  channelDefaults: () => ChannelDefaults;
  chatSubDenied: () => Set<string>;
  plane3Channels: () => Map<string, number>;
  readsChannelsOnDemand: () => boolean;
  membershipFeedKv: () => KV | undefined;
  setMembershipFeedKv: (kv: KV | undefined) => void;
  membershipFeedWatches: () => Set<MembershipFeedWatch>;
  watchDeletePermissions: () => WeakMap<object, () => IssuedSubjectPermission | undefined>;
  notLiveMsg: () => string;
  readChannels: () => Promise<void>;
  armJoin: (channels: string[]) => Promise<Map<string, number>>;
  backfillArmed: (frontiers: Map<string, number>, floorSeq?: number) => Promise<number>;
  subscribeChat: (channel: string) => void;
  unsubscribeChat: (channel: string) => void;
  confirmChatSub: () => Promise<void>;
  durableJoinChannel: (channel: string) => Promise<{ durable: boolean; reason?: string; generation?: number }>;
  durableLeaveChannel: (channel: string, generation?: number, lifecycleUid?: string) => Promise<void>;
  fetchMemberships: (channel?: string) => Promise<{ channel: string; generation: number; activated: boolean; lifecycleUid?: string }[] | undefined>;
  recordOwnWatchConsumer: (info: ConsumerInfo) => string;
  watchConsumerDeleteDenied: (stream: string, name: string, owner: object | undefined) => boolean;
  deleteMembershipConsumer: (jsm: JetStreamManager, stream: string, name: string) => Promise<boolean>;
  emit: (event: string, ...args: unknown[]) => boolean;
}

/** One endpoint's dynamic subscriptions: join and leave mid-session, the channel and retention
 *  listings, and the membership feed's snapshot read and watches with their consumer cleanup.
 *  Internal: `CotalEndpoint` keeps the public methods and forwards to it. */
export class EndpointSubscriptions {
  constructor(private readonly deps: EndpointSubscriptionsDeps) {}

  private get nc() { return this.deps.nc(); }
  private get jsm() { return this.deps.jsm(); }
  private get space() { return this.deps.space(); }
  private get card() { return this.deps.card(); }
  private get stopped() { return this.deps.stopped(); }
  private get authed() { return this.deps.authed(); }
  private get channels() { return this.deps.channels(); }
  private get channelConfigs() { return this.deps.channelConfigs(); }
  private get channelDefaults() { return this.deps.channelDefaults(); }
  private get chatSubDenied() { return this.deps.chatSubDenied(); }
  private get plane3Channels() { return this.deps.plane3Channels(); }
  private get readsChannelsOnDemand() { return this.deps.readsChannelsOnDemand(); }
  private get membershipFeedKv() { return this.deps.membershipFeedKv(); }
  private set membershipFeedKv(kv: KV | undefined) { this.deps.setMembershipFeedKv(kv); }
  private get membershipFeedWatches() { return this.deps.membershipFeedWatches(); }
  private get watchDeletePermissions() { return this.deps.watchDeletePermissions(); }
  private notLiveMsg() { return this.deps.notLiveMsg(); }
  private readChannels() { return this.deps.readChannels(); }
  private armJoin(channels: string[]) { return this.deps.armJoin(channels); }
  private backfillArmed(frontiers: Map<string, number>, floorSeq?: number) { return this.deps.backfillArmed(frontiers, floorSeq); }
  private subscribeChat(channel: string) { this.deps.subscribeChat(channel); }
  private unsubscribeChat(channel: string) { this.deps.unsubscribeChat(channel); }
  private confirmChatSub() { return this.deps.confirmChatSub(); }
  private durableJoinChannel(channel: string) { return this.deps.durableJoinChannel(channel); }
  private durableLeaveChannel(channel: string, generation?: number, lifecycleUid?: string) { return this.deps.durableLeaveChannel(channel, generation, lifecycleUid); }
  private fetchMemberships(channel?: string) { return this.deps.fetchMemberships(channel); }
  private recordOwnWatchConsumer(info: ConsumerInfo) { return this.deps.recordOwnWatchConsumer(info); }
  private watchConsumerDeleteDenied(stream: string, name: string, owner: object | undefined) { return this.deps.watchConsumerDeleteDenied(stream, name, owner); }
  private deleteMembershipConsumer(jsm: JetStreamManager, stream: string, name: string) { return this.deps.deleteMembershipConsumer(jsm, stream, name); }
  private emit(event: string, ...args: unknown[]) { return this.deps.emit(event, ...args); }

  /** The channels this endpoint is currently subscribed to (live — reflects join/leave). */
  joinedChannels(): string[] {
    return [...this.channels];
  }

  /**
   * Join a channel mid-session: open a native core subscription (manager-free live read, broker-
   * confirmed against `sub.allow`), capture the stream frontier as the join watermark, backfill its
   * history if replay is on, and — for a `durable`-class channel or a family such as `review.>` when a
   * delivery daemon is present — request a Plane-3 durable backstop (via `ctl.delivery`). Any other
   * pattern stays live only, with a `reason`. Idempotent: re-joining is a no-op (no
   * re-backfill). Returns the backfill count + whether the durable backstop is active (+ a `reason`
   * when a durable channel couldn't get one).
   */
  async joinChannel(
    channel: string,
  ): Promise<{ joined: boolean; backfilled: number; durable: boolean; reason?: string }> {
    if (!this.jsm) throw new Error(this.notLiveMsg());
    if (this.channels.includes(channel))
      return { joined: false, backfilled: 0, durable: this.plane3Channels.has(channel) };
    // The delivery class below comes from the cache, so a seat reads it current before joining.
    if (this.readsChannelsOnDemand) await this.readChannels();
    // Arm the watermark BEFORE going live: the backfill reads ≤ frontier and the core-sub only ever
    // delivers post-subscribe live messages (> frontier), so the two never overlap.
    const armed = await this.armJoin([channel]);
    // Live read (SPEC v0.3): open the native core subscription — MANAGER-FREE, broker-enforced by
    // sub.allow. This is what lets an agent join a channel's live feed on its own. The sub.allow
    // refusal is async — broker-confirm before committing local join state; the subscribe handler
    // ALSO drops a channel on ANY refusal (incl. a late one), so this is not a timing gamble (#13).
    this.subscribeChat(channel);
    try {
      await this.confirmChatSub();
    } catch (e) {
      // The confirm boundary (flush) failed — the connection drained/closed mid-join, so we have NO
      // confirmation the subscribe was accepted. Fail closed: undo the half-open join rather than
      // returning as if it were confirmed (a reconnect re-confirms from this.channels, which we never
      // pushed to). unsubscribeChat clears chatSubs.
      this.unsubscribeChat(channel);
      throw new Error(`cannot join "${channel}": live subscription could not be confirmed (${(e as Error).message})`);
    }
    if (this.chatSubDenied.has(channel)) {
      this.unsubscribeChat(channel);
      throw new Error(`cannot join "${channel}": not within this agent's read ACL (allowSubscribe)`);
    }
    this.channels.push(channel);
    // Durable backstop. The live core-sub above already delivers (manager-free). For a `durable`-class
    // channel, request a Plane-3 per-member backstop from the server-side delivery daemon (durableJoin via ctl.delivery) so a post reaches a
    // busy/offline turn — the core-sub stays as the live wake-hint, dedup-coalesced with the Plane-3
    // copy by id-dedup. No manager (open dev / manager-less) ⇒ joined LIVE only, surfaced via `reason`
    // (never silent). A `live`-class channel takes no backstop (joined live is the contract). A family
    // (`review.>`) always asks for its row: each channel under it decides its own class at fan-out
    // (#5404). Any other pattern has no backstop, and says so.
    let durable = false;
    let reason: string | undefined;
    const family = isChannelFamily(channel);
    if (!family && !isConcreteChannel(channel))
      reason = "a pattern with * or the root > has no stored copies; follow a concrete channel or a family such as review.>";
    else if (family || effectiveDeliveryClass(this.channelConfigs.get(channel), this.channelDefaults) === "durable") {
      try {
        const r = await this.durableJoinChannel(channel);
        if (r.durable) {
          this.plane3Channels.set(channel, r.generation ?? 0);
          durable = true;
        } else {
          reason = r.reason ?? "durable backstop unavailable";
        }
      } catch (e) {
        // No privileged writer (no delivery daemon) or the write was rejected — joined live, backstop
        // unavailable. NOT a join failure: the live subscription is up and authorized.
        reason = `durable backstop unavailable (${(e as Error).message})`;
      }
    }
    const backfilled = await this.backfillArmed(armed);
    return { joined: true, backfilled, durable, ...(reason !== undefined ? { reason } : {}) };
  }

  /** Leave a channel mid-session — MANAGER-FREE for the live read: close the core subscription. For a
   *  Plane-3 durable channel, the membership is tombstoned FIRST at the leave cursor (SPEC §7: leave is
   *  a hard read boundary for the backstop — a pre-leave entry stays deliverable, `seq > leaveCursor` is
   *  denied). FAIL-CLOSED: if the tombstone can't be confirmed the call throws and the leave is NOT
   *  applied (live sub stays up, local mirror intact) so the caller can retry — never close the live
   *  read while the backstop keeps delivering. `legacyDiscoveryMessage` lets the caller supply the
   *  remedy when membership discovery predates lifecycle support, without changing the refusal. */
  async leaveChannel(channel: string, legacyDiscoveryMessage?: string): Promise<{ left: boolean }> {
    if (!this.jsm) throw new Error(this.notLiveMsg());
    let left = this.channels.includes(channel);
    if (this.readsChannelsOnDemand) await this.readChannels();
    // Auth + durable-class ⇒ a Plane-3 membership may exist; tombstone it BEFORE touching local state.
    // Discover the channel's rows across this principal's lifecycles, including memberships absent
    // from the local mirror. Keep each row's generation guard. fetchMemberships throws on a
    // responder-present error, so a leave whose
    // tombstone can't be confirmed propagates (live sub stays up, mirror intact) for the caller to retry
    // — reporting `left` while the trusted reader keeps transferring to DLV is the fail-open leak. A
    // genuine no-responder (open / no delivery daemon, no Plane-3) means there is no membership to tombstone.
    if (this.authed && (isChannelFamily(channel) || effectiveDeliveryClass(this.channelConfigs.get(channel), this.channelDefaults) === "durable")) {
      const memberships = await this.fetchMemberships(channel);
      if (memberships === undefined && this.plane3Channels.has(channel))
        await this.durableLeaveChannel(channel, this.plane3Channels.get(channel));
      for (const member of memberships ?? []) {
        // A daemon before 0.166.0 answers with this lifecycle's rows and no lifecycleUid, so it cannot
        // show an earlier lifecycle's row. Refuse with the remedy rather than leave that row open.
        if (member.lifecycleUid === undefined)
          throw new Error(legacyDiscoveryMessage ?? "the delivery daemon predates lifecycle-aware membership discovery, so this durable leave was not applied and the channel stays joined; restart the daemon at this version (`cotal up` runs it)");
        await this.durableLeaveChannel(channel, member.generation, member.lifecycleUid);
        left = true;
      }
      if (memberships !== undefined) this.plane3Channels.delete(channel);
    }
    this.unsubscribeChat(channel);
    const i = this.channels.indexOf(channel);
    if (i >= 0) this.channels.splice(i, 1);
    return { left };
  }

  /**
   * What the chat stream still holds and what removes the rest. `perSender` is the stream's
   * per-subject cap: a subject is one sender on one channel, and past the cap that sender's oldest
   * message on the channel is discarded. `maxAgeMs` is the stream's age limit. Each is `null` when
   * the stream sets none. `senders` counts each sender's retained messages per channel, so a sender
   * at the cap marks a channel whose retained history has lost that sender's older messages while
   * other senders' messages from the same time remain. `stream` is false when the chat stream does
   * not exist, which holds nothing. `lastSeq` is the stream's newest sequence, 0 when it has none.
   */
  async chatRetention(): Promise<{ perSender: number | null; maxAgeMs: number | null; oldestAt: string | null; senders: { channel: string; sender: string; messages: number }[]; stream: boolean; lastSeq: number }> {
    if (!this.nc) throw new Error(this.notLiveMsg());
    const mgr = await jetstreamManager(this.nc);
    let info;
    try {
      info = await mgr.streams.info(chatStream(this.space), { subjects_filter: ">" });
    } catch (e) {
      // As in listChannels: an absent CHAT stream holds nothing yet; any other failure stays loud.
      if (!isJetStreamMissing(e, JetStreamApiCodes.StreamNotFound)) throw e;
      return { perSender: null, maxAgeMs: null, oldestAt: null, senders: [], stream: false, lastSeq: 0 };
    }
    const senders: { channel: string; sender: string; messages: number }[] = [];
    for (const [subject, messages] of Object.entries(info.state.subjects ?? {})) {
      const p = parseSubject(subject);
      if (p?.kind === "chat" && isPrincipalOwnerToken(p.owner)) senders.push({ channel: p.rest, sender: p.sender, messages });
    }
    const cap = info.config.max_msgs_per_subject;
    const age = info.config.max_age;
    return {
      perSender: typeof cap === "number" && cap > 0 ? cap : null,
      maxAgeMs: typeof age === "number" && age > 0 ? Math.round(age / 1_000_000) : null,
      // The stream's oldest post, of any channel; every post sent before it is gone.
      oldestAt: info.state.messages > 0 ? info.state.first_ts : null,
      senders: senders.sort((a, b) => a.channel.localeCompare(b.channel) || a.sender.localeCompare(b.sender)),
      stream: true,
      lastSeq: info.state.last_seq,
    };
  }

  /** Whether this space's direct-message stream is on its broker. A missing stream is false.
   *  Any other failure, including a permission denial, is raised. */
  async dmStreamPresent(): Promise<boolean> {
    if (!this.nc) throw new Error(this.notLiveMsg());
    try {
      await (await jetstreamManager(this.nc)).streams.info(dmStream(this.space));
      return true;
    } catch (e) {
      if (!isJetStreamMissing(e, JetStreamApiCodes.StreamNotFound)) throw e;
      return false;
    }
  }

  /** One coherent channel model for dashboards: every channel that has messages OR a registry
   *  entry (configured-but-empty), each tagged with its {@link ChannelConfig}. Works even on
   *  observer endpoints (no consumers needed). */
  async listChannels(): Promise<{ channel: string; messages: number; config?: ChannelConfig }[]> {
    if (!this.nc) throw new Error(this.notLiveMsg());
    if (this.readsChannelsOnDemand) await this.readChannels();
    const mgr = await jetstreamManager(this.nc);
    // Subjects carry the sender (chat.<sender>.<channel>), so collapse across senders: sum
    // each channel's counts regardless of who published.
    const counts = new Map<string, number>();
    try {
      const info = await mgr.streams.info(chatStream(this.space), { subjects_filter: ">" });
      if (info.state.subjects) {
        for (const [subject, count] of Object.entries(info.state.subjects)) {
          const p = parseSubject(subject);
          // Same surfacing-boundary defense as the message guards: parseSubject splits only, so an
          // old-shape alias (`chat.<nkey>.team.backend`) structurally parses with a raw-nkey owner and a
          // misattributed channel. Reject a non-principal owner token here too, or retained pre-flip
          // subjects would inflate this channel-count surface with phantom channels.
          if (p?.kind === "chat" && isPrincipalOwnerToken(p.owner)) counts.set(p.rest, (counts.get(p.rest) ?? 0) + count);
        }
      }
    } catch (e) {
      // A genuinely absent CHAT stream means there are no retained message counts yet. Every other
      // failure, especially a STREAM.INFO permission denial, means the count view could not be read
      // and must stay loud rather than returning a valid-looking registry-only subset.
      if (!isJetStreamMissing(e, JetStreamApiCodes.StreamNotFound)) throw e;
    }
    const channels = new Set<string>([...counts.keys(), ...this.channelConfigs.keys()]);
    return [...channels]
      .map((channel) => ({
        channel,
        messages: counts.get(channel) ?? 0,
        config: this.channelConfigs.get(channel),
      }))
      .sort((a, b) => a.channel.localeCompare(b.channel));
  }

  /** Lazily open the DERIVED membership FEED KV (`cotal_membership_<space>`; admin/observer read, the
   *  delivery daemon writes it) — the display-only who-is-subscribed view. Distinct from the authoritative
   *  {@link membersRegistry} (`cotal_members_<space>`, the Plane-3 durable-membership source of truth): the
   *  two names look alike, so this one is explicitly "feed". Read-only here; agents hold no grant. */
  private async membershipFeedRegistry(): Promise<KV> {
    if (!this.nc) throw new Error(this.notLiveMsg());
    this.membershipFeedKv ??= await new Kvm(this.nc).open(membershipBucket(this.space));
    return this.membershipFeedKv;
  }

  /**
   * Snapshot the broker-sourced channel-membership feed (admin/observer read): every agent's
   * `{live, durable}` record plus `asOf` — the feed's freshness heartbeat (epoch ms of the daemon's last
   * successful poll, from the reserved {@link MEMBERSHIP_FEED_KEY}). `live` patterns are kept as-is
   * (wildcards preserved); the consumer expands them against the channel registry. `asOf` is undefined
   * when the feed has never been written (no daemon → the dashboard degrades to traffic-only).
   */
  async readMembership(): Promise<MembershipSnapshot> {
    const kv = await this.membershipFeedRegistry();
    const members: MembershipEntry[] = [];
    let asOf: number | undefined;
    // Paged batched Direct Gets, as the on-demand presence read: a few round trips regardless of N,
    // a short page refused rather than reported as the whole feed, and no consumer bound. The scan
    // this replaced bound an ordered consumer per read whose delete the observer and admin profiles
    // may not send (#691), so every dashboard poll left a consumer to the broker's inactive threshold
    // and a refused `CONSUMER.DELETE` line in its log (#4123).
    let entries: KvEntry[];
    try {
      entries = await lastKvEntries(kv);
    } catch (e) {
      if (!isPublishPermissionDenied(e)) throw e;
      throw new Error(
        `membership read refused for ${this.card.id}: this credential may not publish $JS.API.DIRECT.GET.KV_${membershipBucket(this.space)}, the membership feed read (SPEC Appendix B). A credential minted by an older issuer can lack this grant even when newly minted; upgrade the manager or auth service that issues credentials, then mint a new credential. Reusing credentials or reconnecting does not add the grant.`,
        { cause: e },
      );
    }
    for (const e of entries) {
      if (e.key === MEMBERSHIP_FEED_KEY) {
        try { asOf = e.json<{ observedAt: number }>().observedAt; } catch { /* heartbeat garbled; leave undefined */ }
        continue;
      }
      try {
        const rec = e.json<ChannelMembership>();
        members.push({ id: e.key, live: rec.live ?? [], durable: rec.durable ?? [], observedAt: rec.observedAt });
      } catch { /* skip undecodable */ }
    }
    return { asOf, members };
  }

  /** Watch the membership feed for changes (admin/observer): `onChange` receives every KV entry as a
   *  {@link MembershipChange} — the decoded member record (or its deletion), or the feed heartbeat's
   *  `asOf` — so a caller keeps its snapshot current without re-reading the bucket; the entries replayed
   *  when the watch (re)arms carry `update: false` and end with a `replayed` change. The async stop
   *  handle disarms local delivery before resolving. It deletes the broker consumer when permitted;
   *  a known-ungranted delete leaves it to native inactivity reclamation. A feed the cred can't read
   *  (or absent) surfaces as an `error` event and the dashboard keeps its last snapshot. */
  async watchMembership(onChange: (change: MembershipChange) => void, onClosed?: (err: Error) => void): Promise<{ stop(): Promise<void> }> {
    if (this.stopped) throw new Error("endpoint stopped - cannot watch membership");
    const watch: MembershipFeedWatch = { onChange, onClosed, stopped: false, arm: Promise.resolve() };
    this.membershipFeedWatches.add(watch);
    watch.arm = watch.arm.catch(() => {}).then(() => this.armMembershipWatch(watch));
    try { await watch.arm; }
    catch (err) {
      watch.stopped = true;
      this.membershipFeedWatches.delete(watch);
      await this.disarmMembershipWatch(watch);
      throw err;
    }
    return { stop: async () => {
      if (watch.stopPromise) return watch.stopPromise;
      watch.stopped = true;
      watch.stopPromise = new Promise<void>((resolve, reject) => {
        watch.resolveStop = resolve;
        watch.rejectStop = reject;
      });
      watch.arm = watch.arm.catch(() => {}).then(async () => {
        await this.disarmMembershipWatch(watch);
        await this.deleteRetainedMembershipConsumer(watch);
        this.finishMembershipWatchStop(watch);
      }).catch((err) => {
        // A real authorization/server failure remains loud. A terminal close is retained rather than
        // rejected by the cleanup helpers, so its promise stays pending for fresh-epoch cleanup.
        watch.rejectStop?.(err);
      });
      return watch.stopPromise;
    } };
  }

  /** Bind one caller-owned membership-watch intent to the CURRENT connection. Arming is serialized
   *  per intent, so a public watch call cannot race a reconnect rearm into two consumers. */
  private async armMembershipWatch(watch: MembershipFeedWatch): Promise<void> {
    if (watch.stopped) return;
    const kv = await this.membershipFeedRegistry();
    await this.deleteRetainedMembershipConsumer(watch);
    if (!(kv instanceof Bucket)) throw new Error("membership watch needs the @nats-io/kv Bucket implementation");
    const cc = kv._buildCC(">", KvWatchInclude.LastValue, { headers_only: false });
    const consumer = await kv.js.consumers.getPushConsumer(kv.stream, cc);
    const info = await consumer.info(true);
    this.recordOwnWatchConsumer(info);
    // The broker resource exists now. Record its identity BEFORE consume() so a concurrent stop or
    // connection close always leaves enough state for strict cleanup or fresh-epoch retry.
    watch.consumer = consumer;
    const permission = this.nc && this.watchDeletePermissions.get(this.nc);
    if (permission) this.watchDeletePermissions.set(consumer, permission);
    watch.consumerStream = info.stream_name;
    watch.consumerName = info.name;
    // The replay is the bucket's last value per key, bound at `info`; it ends with the entry that
    // leaves nothing pending (the same rule as nats.js `watch()`'s `initializedFn`).
    let replaying = info.num_pending > 0;
    let iter: Awaited<ReturnType<PushConsumer["consume"]>>;
    try { iter = await consumer.consume({ callback: (jm: JsMsg) => {
      if (watch.stopped || watch.consumer !== consumer) return;
      const entry = kv.jmToWatchEntry(jm, !replaying);
      watch.onChange(membershipChange(entry, !replaying));
      if (replaying && jm.info.pending === 0) {
        replaying = false;
        watch.onChange({ type: "replayed", revision: entry.revision });
      }
    } }); }
    catch (err) {
      await this.disarmMembershipWatch(watch);
      throw err;
    }
    watch.iter = iter;
    if (watch.stopped) {
      await this.disarmMembershipWatch(watch);
      return;
    }
    if (!replaying) watch.onChange({ type: "replayed", revision: 0 }); // an empty feed replays nothing
    iter.closed().then(() => {
      if (watch.stopped || watch.consumer !== consumer) return;
      const err = new Error("membership watch closed");
      watch.onClosed?.(err);
      this.emit("error", err);
    }).catch(() => {});
  }

  /** Delete identity retained across a failed/closed-epoch consumer object using the CURRENT connection. */
  async deleteRetainedMembershipConsumer(watch: MembershipFeedWatch): Promise<void> {
    if (!watch.consumerStream || !watch.consumerName) return;
    // A terminal close is not deletion success and not a public-stop failure. Keep the identity
    // endpoint-owned; rearmMembershipWatches retries it through the next live JetStream manager.
    if (!this.nc || this.nc.isClosed()) return;
    if (this.watchConsumerDeleteDenied(watch.consumerStream, watch.consumerName, this.nc)) {
      watch.consumerStream = undefined; watch.consumerName = undefined;
      return;
    }
    const jsm = await jetstreamManager(this.nc);
    if (await this.deleteMembershipConsumer(jsm, watch.consumerStream, watch.consumerName)) {
      watch.consumerStream = undefined;
      watch.consumerName = undefined;
    }
  }

  private finishMembershipWatchStop(watch: MembershipFeedWatch): void {
    if (!watch.stopped || watch.consumer || watch.iter || watch.consumerStream || watch.consumerName) return;
    this.membershipFeedWatches.delete(watch);
    watch.resolveStop?.();
    watch.resolveStop = undefined;
    watch.rejectStop = undefined;
  }

  /** Stop the local iterator, then delete when permitted. A known-ungranted delete releases local
   *  cleanup custody without a request; the broker reclaims the consumer at its inactive threshold. */
  async disarmMembershipWatch(watch: MembershipFeedWatch): Promise<void> {
    const iter = watch.iter;
    const consumer = watch.consumer;
    watch.iter = undefined;
    watch.consumer = undefined;
    try { iter?.stop(); } catch { /* already closed */ }
    if (consumer) {
      if (watch.consumerStream && watch.consumerName && this.watchConsumerDeleteDenied(watch.consumerStream, watch.consumerName, consumer)) {
        watch.consumerStream = undefined; watch.consumerName = undefined;
        return;
      }
      try {
        const deleted = await consumer.delete();
        if (deleted) { watch.consumerStream = undefined; watch.consumerName = undefined; }
      } catch (err) {
        if (membershipConsumerReleased(err)) {
          watch.consumerStream = undefined;
          watch.consumerName = undefined;
        } else {
          const closedEpoch = err instanceof ClosedConnectionError;
          const timeout = err instanceof TimeoutError;
          // Cleanup of an ordered consumer: a delete timeout means the broker did not answer in time,
          // not that the endpoint is unusable. The broker reaps an idle/ephemeral consumer anyway.
          // Throwing here killed a live observer over a slow VPN (#1047). Catch, surface, continue.
          if (timeout || closedEpoch) {
            this.emit("error", err as Error);
          } else {
            throw err;
          }
        }
        // A terminal close leaves stream/name intact. The endpoint-owned stopped intent is retried
        // through the fresh JetStream manager before its public stop promise may resolve.
      }
    }
  }

  /** Rebind every live membership-watch intent after a connection rebuild. */
  async rearmMembershipWatches(): Promise<void> {
    await Promise.all([...this.membershipFeedWatches].map(async (watch) => {
      // clearConnectionScoped already resets a rejected prior arm before scheduling disarm. At this
      // point the queue is the completing cleanup promise; append fresh-epoch cleanup first.
      watch.arm = watch.arm.catch(() => {}).then(async () => {
        await this.disarmMembershipWatch(watch);
        await this.deleteRetainedMembershipConsumer(watch);
        if (!watch.stopped) await this.armMembershipWatch(watch);
      });
      try {
        await watch.arm;
        this.finishMembershipWatchStop(watch);
      } catch (err) { this.emit("error", err as Error); }
    }));
  }}

/** A membership-watch delete that leaves nothing to retry: the consumer or its stream is already
 *  gone, or the broker refused the delete because the reading profile holds no stream-wide
 *  CONSUMER.DELETE (#691) and reaps the consumer at its inactive threshold. */
export function membershipConsumerReleased(err: unknown): boolean {
  return (
    isJetStreamMissing(err, JetStreamApiCodes.ConsumerNotFound, JetStreamApiCodes.StreamNotFound)
    || isPublishPermissionDenied(err)
  );
}