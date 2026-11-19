import { randomUUID } from "node:crypto";
import { channelInAllow, isConcreteChannel, partsToText, type AnycastTakeOutcome, type AttentionMode, type ChannelMode, type CotalEndpoint, type CotalMessage, type Delivery, type MessageMeta } from "@cotal-ai/core";
import type { AgentConfig } from "./config.js";
import { CHANNEL_CATCHUP_AGE_MS, afterRecallMark, MAX_INBOX, TAKE_WAIT_MS, TAKE_RETRY_MS, MAX_IN_FLIGHT, MAX_AHEAD, CLASSIFICATION_CAP, FOCUS_EXCLUSION_CAP, IDLESS_READS, PROTECTED_DISPOSITION_CAP, handOver, idlessDigest, ingestDedupKey } from "./agent-inbox-model.js";
import type { AgentInboxDeps, InboxItem, InboxSnapshot, Pending, IdlessTally, IdlessCopy, RecallMark, InboxScope, ExactDrainResult, DeliveryNotice } from "./agent-inbox-model.js";
export { deliveryNoticeOf, afterRecallMark, MAX_INBOX } from "./agent-inbox-model.js";
export type { InboxItem, InboxSnapshot, InboxScope, ExactDrainResult, RecallMark, DeliveryNotice } from "./agent-inbox-model.js";

/** Session-local inbox, delivery ownership, attention policy and focus recall. */
export class AgentInbox {
  constructor(private readonly deps: AgentInboxDeps) {}
  private get ep(): CotalEndpoint { return this.deps.endpoint(); }
  private get config(): AgentConfig { return this.deps.config(); }
  private get _transportConnected(): boolean { return this.deps.transportConnected(); }
  private emit(event: "incoming" | "mention-wake", item: InboxItem): void { this.deps.emit(event, item); }
  private handleEndpointWarning(error: Error): void { this.deps.warning(error); }
  private noteDirected(item: InboxItem): void { this.deps.noteDirected(item); }
  private inOrder(write: () => Promise<void>): Promise<void> { return this.deps.inOrder(write); }
  private requireConnected(): Promise<void> { return this.deps.requireConnected(); }

  seedChannelModes(config: AgentConfig): void {
    for (const c of config.quiet ?? []) this.channelModes.set(c, "quiet");
    for (const c of config.muted ?? []) this.channelModes.set(c, "muted");
  }

  onTransport(connected: boolean): void {
    if (!connected) {
      this.transportDrops++;
      for (const p of this.inbox.filter((x) => x.take && !this.inFlightIds.has(x.item.recvKey))) this.regate(p);
    }
    if (connected && this.mayAskTakes()) {
      this.dropLapsedTakes();
      for (const p of this.gated) if (p.taking === undefined) this.emit("incoming", p.item);
    }
  }

  stop(): void {
    for (const key of [...this.renewals.keys()]) this.stopRenewal(key);
    clearTimeout(this.takeRetry);
    this.takeRetry = undefined;
  }


  private inbox: Pending[] = [];
  /** Role requests delivered on an auth mesh whose take is not recorded for the copy held (SPEC §8.1).
   *  They count toward a wake and are never shown: {@link takeChosen} asks the delivery daemon to
   *  record the take of each one a host chose to show, and a recorded one moves to {@link inbox}. */
  private gated: Pending[] = [];
  /** Counts arrivals, to number each entry's {@link Pending.arrival}. */
  private arrivals = 0;
  /** Why the last take could not be decided, when it could not, and when a held request may be
   *  asked about again. Reported by `cotal_inbox`. */
  private heldTake?: { reason: string; detail: string; retryAt: number };
  /** Re-announces the held role requests once {@link heldTake} lets them be asked about again. */
  private takeRetry?: ReturnType<typeof setTimeout>;
  /** Ids already SURFACED to the model (handled) — bounded, commit-aware dedup ACROSS a drain. The
   *  live↔durable transition window can deliver the two copies of one message far enough apart that the
   *  first is already drained (removed from {@link inbox}) when the second arrives; the pending-inbox
   *  check alone would then re-buffer and double-surface it. Recorded at HANDLE time ({@link drainInbox}),
   *  never at receive time — so a later durable duplicate of an already-handled id is safe to ack (the
   *  logical message was delivered), which is exactly what the removed endpoint-level `firstSeenChat`
   *  got wrong (it acked at receive time, before handling). Two rotating windows bound memory. */
  private handledIds = new Set<string>();
  private handledIdsPrev = new Set<string>();
  /** Receive-time classes for overflow-evicted, unhandled channel ambient. Capacity exhaustion
   *  permanently degrades unknown ambient to pull-only for this session rather than risk a late
   *  live/durable copy changing from quiet to automatic. */
  private evictedClassifications = new Map<string, { pullOnly: boolean; channel: string }>();
  /** Surfaced to the host but not yet committed or abandoned, counted per holding frame because
   *  frames overlap. See {@link holdInFlight}. */
  private inFlightIds = new Map<string, number>();
  /** Receive keys {@link lowerBuffered} passed over because a host was handing them over. A turn
   *  that carries one acks it; when the hand-over ends without an ack, it is lowered then. */
  private lowerOnRelease = new Set<string>();
  /** Ack-wait renewal timers of held durable deliveries, by receive key. See {@link keepOwned}. */
  private renewals = new Map<string, ReturnType<typeof setInterval>>();
  private classificationUnsafe = false;
  /** Terminal receive-time decisions that must survive the live→durable transition: successfully
   *  surfaced pull-only messages and hard drops under muted/focus. Capacity loss degrades the
   *  corresponding whole class fail-closed for the rest of the session. */
  private protectedPullOnlyIds = new Set<string>();
  private protectedDropIds = new Set<string>();
  private dropUnsafe = false;
  /** Wall-clock time of the latest inbox drain that actually committed at least one delivery.
   *  This is measured only after the backing acknowledgements succeed, never inferred from a read
   *  attempt or from an empty inbox. */
  private _lastInboxDrainedAt?: number;
  /** Wall-clock time of the latest drain that committed at least one AUTOMATIC delivery.
   *
   *  Deliberately separate from {@link _lastInboxDrainedAt}, and #1233 is why: on a host-mode
   *  connector the tool inbox and the connector-managed automatic queue are different queues, and
   *  the measured seat was draining the first every few minutes while the second had not moved in
   *  13.8 hours. A progress mark that counts a pull-only drain as progress would have reported that
   *  seat as making progress, which is the exact lie this field exists to refuse. */
  private _lastAutomaticDrainedAt?: number;
  /** The latest commit that took the OLDEST automatic delivery then queued (#1526).
   *
   *  Distinct from {@link _lastAutomaticDrainedAt}, and the distinction is the defect: any automatic
   *  commit used to count, so a seat that kept committing fresh arrivals over a head it could not
   *  deliver reset its own stall clock on every turn and reported `ready` indefinitely, while the
   *  entries at the front of its queue aged past two hours. A queue drains when its head moves; a
   *  queue that serves only its newest arrivals is not draining, it is skipping. */
  private _lastAutomaticHeadDrainedAt?: number;
  private _attention: AttentionMode = "open"; // F3: fail-open default; reset to open on SessionStart
  private _recallCursor: RecallMark = { ts: 0, id: "" };
  /** Recall items stamped ahead of this session's clock that it has already handed over. They are
   *  tracked by id rather than by {@link _recallCursor}, because a sender's clock must not be able to
   *  move this session's mark. Bounded by {@link MAX_AHEAD}. */
  private aheadDelivered = new Set<string>();
  /** Per-channel attention overrides — the AUTHORITATIVE runtime state (read by {@link ingest} on
   *  every message). Seeded from the agent-file default; mutated by {@link setChannelMode}; mirrored
   *  to presence for peers. An absent key ⇒ that channel follows the global {@link _attention}. Reset
   *  on restart (rebuilt from config; presence sweep clears the mirror). */
  private channelModes = new Map<string, ChannelMode>();
  /** Chat-stream frontier captured when this agent entered `focus` — recall surfaces ambient
   *  published after it ("since you entered focus"). Undefined unless in focus. */
  private focusSince?: number;
  private enteringFocus = false;
  /** The receive-key namespace secret (#624): a per-session random value minted at construction,
   *  never written to any wire or log. Minted receive keys are `${secret}.${seq}`, so they are
   *  DISJOINT from wire ids by construction: an attacker-chosen wire id cannot equal one, so one
   *  verdict can never select two entries through a forged collision. Recognition is FUNCTIONAL
   * (the key starts with the secret), so it cannot saturate the way a bounded set would: every
   * minted key stays recognizable for the session's life, with nothing to expire or overflow. */
  private readonly recvKeySecret = randomUUID().replace(/-/g, "");
  private recvKeySeq = 0;
  private focusExcludedIds = new Map<string, string>();
  /** #662: id-less channel deliveries settled this focus episode, per content digest. Live ingest has
   *  no stream sequence, so content is all an id-less delivery shares with its stream copy, and
   *  identical copies may each have had a different disposition. So recall binds each settled copy
   *  to a stream sequence and hands back only the copies no settled copy is bound to. Replaced, never
   *  cleared, per episode, so a hold from an earlier episode cannot un-count a later one. */
  private focusIdless = new Map<string, IdlessTally>();
  /** Unbound copies plus bound sequences in {@link focusIdless}, bounded by
   *  {@link FOCUS_EXCLUSION_CAP}. */
  private focusIdlessEntries = 0;
  /** Bumped as each channel's recall read starts: a copy settled before a read that the read could
   *  not bind is behind the focus frontier or out of retention, and no later read will see it. */
  private idlessEpoch = 0;
  /** Recall runs one at a time, so an older read can never settle over a newer one (#662). */
  private recallLock: Promise<unknown> = Promise.resolve();
  /** Bumped each time the transport goes down, so a settled copy's frontier read can tell whether
   *  the connection stayed up from the copy's arrival to the answer (#662). */
  private transportDrops = 0;
  private focusRecallUnsafeChannels = new Set<string>();

  /** The latest successful, non-empty inbox drain in this session. */
  get lastInboxDrainedAt(): number | undefined {
    return this._lastInboxDrainedAt;
  }

  /** The latest drain that committed at least one AUTOMATIC (connector-managed) delivery. */
  get lastAutomaticDrainedAt(): number | undefined {
    return this._lastAutomaticDrainedAt;
  }

  /** The latest drain that committed the automatic delivery that was then at the FRONT of the queue
   *  (#1526). This is the fact {@link automaticQueueStalledForMs} measures progress by; the looser
   *  {@link lastAutomaticDrainedAt} is still reported beside it, because the two disagreeing is
   *  precisely the shape of a wedged head being served around. */
  get lastAutomaticHeadDrainedAt(): number | undefined {
    return this._lastAutomaticHeadDrainedAt;
  }

  /** The receive key of the oldest still-queued automatic delivery: the queue's head, and the entry
   *  whose commit counts as progress. */
  private oldestAutomaticKey(): string | undefined {
    let head: Pending | undefined;
    for (const pending of this.inbox) {
      if (pending.pullOnly) continue;
      if (head === undefined || pending.receivedAt < head.receivedAt) head = pending;
    }
    return head?.item.recvKey;
  }

  /** Record head progress when this batch takes the current head of the automatic queue. Call
   *  BEFORE the batch leaves {@link inbox}, since the head is read from the live queue. */
  private noteAutomaticHeadProgress(selected: readonly Pending[]): void {
    const head = this.oldestAutomaticKey();
    if (head === undefined) return;
    if (selected.some((p) => !p.pullOnly && p.item.recvKey === head)) this._lastAutomaticHeadDrainedAt = Date.now();
  }

  /**
   * How long a non-empty automatic queue has been making no progress, or `undefined`.
   *
   * PROGRESS AT THE HEAD, not depth and not throughput. The queue is not stalled because it is deep;
   * it is stalled because the entries at the front of it are not coming off. The clock therefore
   * starts at the later of the arrival of the oldest still-queued delivery and the last commit that
   * took the queue's head, so a seat that is steadily draining keeps resetting it however busy it
   * is, and a seat that has not moved its head since that queue formed accrues from the moment it
   * formed.
   *
   * Keyed on the HEAD rather than on any automatic commit (#1526). The reported session held 96
   * deliveries with the oldest over two hours old and reported `ready` throughout: it was committing
   * fresh arrivals, and under a looser measure each of those reset the clock for the backlog behind
   * them. A seat that serves only its newest traffic is skipping its queue, not draining it, and the
   * messages that are actually undelivered are the ones the measure must speak for.
   *
   * Measured from the oldest ARRIVAL rather than from session start so a session that never drained
   * anything is still measurable — that is precisely the shape of a seat whose first soft interrupt
   * timed out.
   */
  automaticQueueStalledForMs(now = Date.now()): number | undefined {
    const oldest = this.oldestAutomaticReceivedAt();
    if (oldest === undefined) return undefined;
    const since = Math.max(oldest, this._lastAutomaticHeadDrainedAt ?? 0);
    const held = now - since;
    return held > 0 ? held : 0;
  }

  /** Session-local channel degradation, independent of transport liveness. */
  get channelDeliveryIssue(): string | undefined {
    return this.dropUnsafe
      ? "Channel drop tracking exhausted. Ambient channel traffic is suppressed until restart; non-historical mentions on unmuted channels wake to pull their buffered body. Focus recall may be incomplete."
      : undefined;
  }

  // ---- inbox ---------------------------------------------------------------

  /** A DM shaped as a delivery daemon's notice is one only when its authenticated sender holds the
   *  space's delivery lease. Any other sender's copy is an ordinary DM. */
  async ingestNotice(m: CotalMessage, delivery: Delivery, meta: MessageMeta, notice: DeliveryNotice): Promise<void> {
    const holder = await this.ep.deliveryLeaseHolder(0);
    this.ingest(m, delivery, meta, holder !== undefined && holder === m.from.id ? notice : undefined);
  }

  ingest(m: CotalMessage, delivery: Delivery, meta?: MessageMeta, notice?: DeliveryNotice): void {
    // #624: an EMPTY id is never a dedup key. The id-keyed coalescing below exists to collapse the
    // copies of ONE message across the live/durable paths, and identity is what makes that safe. A
    // message that carries an empty id asserts no identity (SPEC §5 requires a unique id; the sender
    // already violated it), so keying the coalescing on "" reads empty-equals-empty as a duplicate
    // and silently drops every empty-id message after the first: measured live, two distinct
    // empty-id messages arrived and only the first ever buffered. Treating an empty id as NO id
    // costs the coalescing for those messages only (a redelivered copy can surface twice), which is
    // the wire contract's at-least-once stance; collapsing distinct messages is not a stance at all.
    const key = ingestDedupKey(m.id);
    // Already SURFACED and drained? This is a post-handle cross-path duplicate (the transition window's
    // second copy, arriving after the first was handled). Don't surface it again; if it's the durable
    // copy, ack it so JetStream stops redelivering — safe because the logical message was already
    // handled (handledIds is recorded at drain time, never at receive time).
    if (key !== undefined && (this.handledIds.has(key) || this.handledIdsPrev.has(key))) {
      if (delivery.durable) delivery.ack();
      return;
    }
    if (key !== undefined && (this.protectedPullOnlyIds.has(key) || this.protectedDropIds.has(key))) {
      if (delivery.durable) delivery.ack();
      return;
    }
    // Duplicate id still PENDING — keep ONE entry. Take the freshest ack handle, but NEVER downgrade a
    // durable (committing) ack to a live no-op. Two cases produce a duplicate: same-path JetStream
    // redelivery (always durable → upgrade to the fresh handle), and the cross-path live/durable
    // transition window. There, if the DURABLE copy arrived first and a LIVE copy lands second,
    // overwriting with the live no-op would leave the durable copy uncommitted → JS redelivers it → it
    // double-surfaces. So only a durable delivery may replace the stored handle; a live duplicate is
    // dropped as-is. A durable duplicate also re-announces the still-pending item through the
    // ordinary `incoming` policy path. That turns JetStream redelivery into a timer-free retry for
    // a wake the host dropped, without bypassing quiet/attention or adapter in-flight guards.
    const existing = key === undefined ? undefined : this.inbox.find((p) => p.item.id === key) ?? this.gated.find((p) => p.item.id === key);
    if (existing) {
      if (delivery.durable) {
        existing.ack = delivery.ack;
        // A fresh copy is a fresh ownership: a hold that outlived the copy it renewed keeps this one.
        this.own(existing, delivery.redelivery);
        if (delivery.take) existing.take = delivery.take;
        if (this.inFlightIds.has(existing.item.recvKey)) this.keepOwned(existing.item.recvKey);
        // A role request taken for an earlier copy and not yet shown needs a take of this one: the
        // broker redelivered it, so the earlier take may have lost it to another holder.
        else if (existing.take && existing.takenCount !== existing.item.deliveryCount) this.regate(existing);
        this.emit("incoming", existing.item);
      }
      return;
    }
    if (!meta)
      throw new Error(`message ${m.id} delivered without MessageMeta — its class is unauthenticated`);
    // Only an aged durable channel copy is catch-up. Live copies and brief transport gaps must
    // still wake, even when the sender's clock is a few seconds behind. Already buffered copies
    // retain their classification through the dedupe above. DMs and role requests are unchanged.
    const historical = meta.historical || (meta.kind === "channel" && delivery.durable && Date.now() - m.ts > CHANNEL_CATCHUP_AGE_MS);
    const item = this.toInboxItem(m, meta.kind, historical);
    if (notice) item.notice = notice;
    // A notice asks for nothing and answers nothing. A role request awaiting its take is recorded
    // as asked of us only once it is taken, since a refused take drops it unseen.
    else if (!delivery.take) this.noteDirected(item);
    // Per-channel override is the FINAL word for a channel message (DMs/anycast are never channel-
    // scoped, so they bypass this entirely and always buffer). Evaluated BEFORE the global mode:
    //  - `muted` → hard drop, incl. @mention (a mention rides the channel; you can't keep it if you
    //    dropped the channel). Acking does NOT delete (Limits-retained) but it's not locally recallable.
    //  - `quiet` → buffer ambient as pull-only; an @mention remains automatic. Overrides global
    //    `focus` so "retain this channel, but only surface ambient on explicit pull" stays expressible.
    // Focus (global, only when NOT overridden): channel ambient AND @mentions are acked-and-dropped —
    // they stay recallable via cotal_inbox (recallAmbient), or if recall itself cannot vouch for the
    // channel (replay=off, or a wildcard join — #977), that is reported rather than left silent; an
    // @mention still *wakes* (mention-wake), body pulled (F4=B), never auto-injected (the mention
    // tag is payload-forgeable).
    if (item.kind === "channel") {
      const cm = this.channelModes.get(item.channel ?? "");
      // #662: an id-less delivery is counted, not excluded, since recall can only match it by content.
      // Content cannot tell a late copy of one recall handed back from a new identical message, so
      // every copy takes its own disposition, and a late copy surfaces again rather than a new one
      // losing its lane (#624: an empty id asserts no identity).
      const digest = item.id === "" && (this.enteringFocus || this._attention === "focus") ? idlessDigest(m) : undefined;
      const tally = digest === undefined ? undefined : this.reserveIdless(digest, item.channel ?? "");
      const copy = tally ? this.settleIdless(tally) : undefined;
      const idless = copy && { digest: digest as string, copy };
      // chatFrontier() is asynchronous. Channel traffic retained while entering focus must not also
      // appear in post-watermark recall if it lands after the server captured the frontier.
      if (this.enteringFocus) this.excludeFromFocus(item);
      if (this.dropUnsafe) {
        this.excludeFromFocus(item);
        if (cm !== "muted" && item.mentionsMe && !item.historical) {
          // Mentions are an untrusted wake hint, never authority to inject a channel body.
          // Keep the body in the bounded pull lane while normal ambient stays fail-closed.
          // After exhaustion an unknown late copy can surface once, disclosed by the warning.
          this.buffer(item, delivery, true, idless);
          this.emit("mention-wake", item);
        } else delivery.ack();
        return;
      }
      if (cm === "muted") {
        this.evictedClassifications.delete(item.id);
        this.excludeFromFocus(item);
        this.protectDisposition(item.id, "drop");
        delivery.ack();
        return;
      }
      const remembered = item.id === "" ? undefined : this.evictedClassifications.get(item.id); // #624: an empty id never carries a remembered classification
      if (remembered) this.evictedClassifications.delete(item.id);
      const snapshottedPullOnly = item.historical || (!item.mentionsMe && (remembered?.pullOnly ?? cm === "quiet"));
      if (cm === "quiet" || snapshottedPullOnly) this.excludeFromFocus(item);
      // An unsafe channel cannot recall even a fresh mention. Keep that body in the existing
      // bounded pull lane, never the automatic lane, including on quiet channels. Muted and
      // historical traffic retain their earlier gates. Exclude this id so recall cannot repeat it.
      if (this._attention === "focus" && item.mentionsMe && !item.historical && this.focusRecallUnsafeChannels.has(item.channel ?? "")) {
        this.excludeFromFocus(item);
        this.buffer(item, delivery, true, idless);
        this.emit("mention-wake", item);
        return;
      }
      // Current normal+focus remains the stronger hard gate unless this exact id was previously
      // received pull-only. classificationUnsafe must not turn focus-dropped traffic into a buffer.
      if (cm !== "quiet" && !snapshottedPullOnly && this._attention === "focus") {
        this.protectDisposition(item.id, "drop");
        delivery.ack();
        // #662: recall cannot pick this copy out from an identical one with another disposition, so
        // its body is held here, pull-only, and recall hands back only copies nothing is bound to.
        if (item.id === "") this.buffer(item, { ack: () => {} }, true, idless);
        if (item.mentionsMe) this.emit("mention-wake", item);
        return;
      }
      // Every historical channel message is pull-only, including mentions. Joining a channel must
      // not revive an old request as a fresh turn. This is decided before focus handling too, so
      // history stays recallable without emitting mention-wake.
      // A reply on a channel is pull-only too when the host answers every turn on the channel
      // (config.channelRepliesPullOnly): that answer replies to the message that started the turn,
      // so a turn on a peer's reply is a turn on its automatic output, and two such seats on one
      // channel would answer each other without end (#2395).
      const automaticReply = this.config.channelRepliesPullOnly === true && !!item.replyTo;
      const pullOnly =
        snapshottedPullOnly || (!item.mentionsMe && (automaticReply || this.classificationUnsafe));
      if (pullOnly) this.excludeFromFocus(item);
      this.buffer(item, delivery, pullOnly, idless);
      return;
    }
    this.buffer(item, delivery, false);
  }

  private buffer(
    item: InboxItem,
    delivery: Pick<Delivery, "ack" | "redelivery" | "take">,
    pullOnly: boolean,
    idless?: { digest: string; copy: IdlessCopy },
  ): void {
    const pending: Pending = { item, ack: delivery.ack, pullOnly, receivedAt: Date.now(), arrival: this.arrivals++ };
    this.own(pending, delivery.redelivery);
    if (idless) pending.idless = { tally: this.focusIdless, ...idless };
    if (delivery.take) {
      // Held until its take is recorded. A copy beyond the bound is left unacked, so the broker
      // redelivers it once there is room, as the overflow valve below does for directed mail.
      pending.take = delivery.take;
      this.gated.push(pending);
      if (this.gated.length > MAX_INBOX) this.gated.shift();
      this.emit("incoming", item);
      return;
    }
    this.admit(pending);
    this.emit("incoming", item);
  }

  /** Put one entry in the shown inbox at its arrival place, running the overflow valve. */
  private admit(pending: Pending): void {
    let at = this.inbox.length;
    while (at > 0 && this.inbox[at - 1]!.arrival > pending.arrival) at--;
    this.inbox.splice(at, 0, pending);
    if (this.inbox.length > MAX_INBOX) {
      // Prefer sacrificing pull-only backlog so it cannot crowd out DMs/mentions. Overflow is bounded
      // local loss for channel traffic only: an evicted channel item is acked without being marked
      // handled. An evicted directed item is never acked (below).
      let excess = this.inbox.length - MAX_INBOX;
      while (excess-- > 0) {
        // Eviction order, weakest claim first. The tiers below `pullOnly` also protect against live
        // mention floods: `mentionsMe` derives from the payload `mentions` field, forgeable by the
        // sender. A peer that stamps every flooded message with the victim's name
        // makes none of its traffic pull-only, so `findIndex` returned -1, the old code fell through
        // to index 0, and index 0 is the OLDEST entry: a directed message waiting to be handled. It
        // was spliced out and acked unhandled, which is unrecoverable (#791). Ambient channel chatter
        // at volume did the same thing with no forgery at all.
        //
        // So directedness decides who gets sacrificed, and directedness is read from `kind`, which is
        // derived from the delivering subject and broker-policed rather than from the payload.
        //
        // A held entry is never sacrificed: the host's verdict commits through its ack handle, and its
        // renewal is what keeps the broker from redelivering it meanwhile. Evicting one would drop
        // both, handing a long turn's role request to a second worker while the first still runs it
        // and leaving the first one's completion nothing to ack. Holds are capped at
        // {@link MAX_IN_FLIGHT}, so the buffer stays bounded.
        const evictable = (p: Pending) => !this.inFlightIds.has(p.item.recvKey);
        let index = this.inbox.findIndex((p) => p.pullOnly && evictable(p));
        // Channel traffic before anything addressed to us specifically, forged mentions included.
        if (index < 0) index = this.inbox.findIndex((p) => p.item.kind === "channel" && evictable(p));
        // Only when the whole buffer is directed mail does the oldest lose, and that case carries no
        // attacker advantage: a peer cannot force DMs it is not authorised to send.
        if (index < 0) index = this.inbox.findIndex(evictable);
        if (index < 0) break;
        const [evicted] = this.inbox.splice(index, 1);
        const sacrificingDirected = evicted.item.kind !== "channel";
        this.rememberEvicted(evicted);
        // #662: a held id-less message is no longer settled here, so recall may hand it back.
        if (evicted.idless?.tally === this.focusIdless) this.unsettleIdless(evicted.idless.digest, evicted.idless.copy);
        // A directed message is never acked on overflow: leaving it un-acked lets JetStream redeliver
        // it once we have room, which turns unrecoverable loss into a delay. Channel ambient is still
        // acked, because replaying it is what the history flood was (#775).
        //
        // The broker paces that delay, so nothing here has to end it. An un-acked message comes
        // back only after its durable's ack wait, so an inbox that stays full costs one redelivery
        // per parked message per ack wait, and the message stays pending until a redelivery finds
        // room: a DM on the recipient's own durable (`cotal deliver pending` counts it), a role
        // request on its role's shared queue (which that command does not read). Giving up on
        // it instead, as a per-id eviction count once did (#807), acked a message the sender had
        // seen stored and the live recipient never read, with one stderr line as the only trace:
        // a seat whose turn ran long lost its oldest DMs exactly that way (#2215).
        if (!sacrificingDirected) evicted.ack();
      }
    }
  }

  private rememberEvicted(p: Pending): void {
    if (p.item.kind !== "channel" || p.item.mentionsMe || !p.item.channel) return;
    if (p.item.id === "") return; // #624: an empty id is never a key; one delivery's classification must not inherit to another
    if (this.classificationUnsafe) return;
    if (!this.evictedClassifications.has(p.item.id) && this.evictedClassifications.size >= CLASSIFICATION_CAP) {
      this.classificationUnsafe = true;
      this.evictedClassifications.clear();
      return;
    }
    this.evictedClassifications.set(p.item.id, { pullOnly: p.pullOnly, channel: p.item.channel });
  }

  private excludeFromFocus(item: InboxItem): void {
    if ((!this.enteringFocus && this._attention !== "focus") || item.kind !== "channel" || !item.channel) return;
    if (item.id === "") return; // #662: an id-less delivery is counted in focusIdless instead
    if (!this.focusExcludedIds.has(item.id) && this.focusExcludedIds.size >= FOCUS_EXCLUSION_CAP) {
      const oldest = this.focusExcludedIds.entries().next().value as [string, string] | undefined;
      if (oldest) {
        this.focusExcludedIds.delete(oldest[0]);
        this.focusRecallUnsafeChannels.add(oldest[1]);
      }
    }
    this.focusExcludedIds.set(item.id, item.channel);
  }

  /** #662: the tally for one more settled or handed-back copy of an id-less message; the caller adds
   *  the copy. At the bound, the channel's recall is reported incomplete rather than risk handing
   *  back a copy it no longer counts. */
  private reserveIdless(digest: string, channel: string): IdlessTally | undefined {
    if (this.focusIdlessEntries >= FOCUS_EXCLUSION_CAP) {
      this.focusRecallUnsafeChannels.add(channel);
      return undefined;
    }
    let tally = this.focusIdless.get(digest);
    if (!tally) this.focusIdless.set(digest, (tally = { channel, unbound: [], bound: new Set() }));
    this.focusIdlessEntries++;
    return tally;
  }

  /** #662: add one settled copy, bounded by the chat frontier read after it arrived. If that read
   *  fails, or answers only after the transport dropped, nothing bounds the copy, so the channel's
   *  recall is reported incomplete instead. */
  private settleIdless(tally: IdlessTally): IdlessCopy {
    const episode = this.focusIdless;
    const drops = this.transportDrops;
    const unbounded = () => {
      if (episode === this.focusIdless) this.focusRecallUnsafeChannels.add(tally.channel);
    };
    const copy: IdlessCopy = { epoch: this.idlessEpoch, ready: Promise.resolve() };
    copy.ready = this.ep.chatFrontier().then((frontier) => {
      if (drops === this.transportDrops) copy.frontier = frontier;
      else unbounded();
    }, unbounded);
    tally.unbound.push(copy);
    return copy;
  }

  /** #662: forget a tally with nothing left in it, so the map is bounded by the entries it counts. */
  private dropEmptyIdless(digest: string, tally: IdlessTally): void {
    if (!tally.unbound.length && !tally.bound.size) this.focusIdless.delete(digest);
  }

  /** #662: one buffered copy of an id-less message left the inbox unhandled. Only that copy is
   *  un-counted, or the sequence it was bound to freed: an identical copy may have been muted. A copy
   *  no read has bound yet stays in arrival order, marked, so the read binds it to its own stream
   *  copy rather than letting an earlier identical copy take that one. */
  private unsettleIdless(digest: string, copy: IdlessCopy): void {
    const tally = this.focusIdless.get(digest);
    if (!tally) return;
    if (tally.unbound.includes(copy)) {
      copy.evicted = true;
      return;
    }
    if (copy.seq === undefined || !tally.bound.delete(copy.seq)) return;
    this.focusIdlessEntries--;
    this.dropEmptyIdless(digest, tally);
  }

  /** #662: after a complete read of `channel` that started at `epoch`, a copy settled before it that
   *  it could not bind will not be in a later read either, so it is dropped. The read is the
   *  channel's whole retained window, so a bound sequence it lacks aged out. */
  private settleIdlessRead(channel: string, epoch: number, retained: Set<number>): void {
    for (const [digest, tally] of this.focusIdless) {
      if (tally.channel !== channel) continue;
      const before = tally.unbound.length + tally.bound.size;
      tally.unbound = tally.unbound.filter((c) => c.epoch >= epoch);
      for (const seq of tally.bound) if (!retained.has(seq)) tally.bound.delete(seq);
      this.focusIdlessEntries -= before - tally.unbound.length - tally.bound.size;
      this.dropEmptyIdless(digest, tally);
    }
  }

  /** #662: the frontier reads of every copy of `channel` settled so far have answered. */
  private async idlessReady(tallies: Map<string, IdlessTally>, channel: string): Promise<void> {
    const reads: Promise<void>[] = [];
    for (const tally of tallies.values()) if (tally.channel === channel) for (const c of tally.unbound) reads.push(c.ready);
    await Promise.all(reads);
  }

  /** #662: bind the copies settled before the read that started at `epoch` to its unbound stream
   *  copies `free` (ascending). Identical copies share a sender subject, so they arrive in stream
   *  order, and a frontier, read after its copy arrived, bounds that copy and every copy before it.
   *  Frontier reads can answer out of order, so their sizes say nothing about arrival order. So the
   *  copies bind in arrival order, latest first, each to the latest free stream copy at or below the
   *  lowest frontier from it on, and a stream copy none of them takes (a reconnect gap) stays free.
   *  An evicted copy takes its own stream copy and leaves it free, so recall hands that one back. */
  private bindIdless(tally: IdlessTally, epoch: number, free: number[]): void {
    let bound = Infinity;
    for (let i = tally.unbound.length - 1; i >= 0; i--) {
      const copy = tally.unbound[i];
      if (copy.frontier === undefined) continue;
      bound = Math.min(bound, copy.frontier);
      if (copy.epoch >= epoch) continue;
      let at = free.length - 1;
      while (at >= 0 && free[at] > bound) at--;
      if (at < 0) continue;
      const [seq] = free.splice(at, 1);
      tally.unbound.splice(i, 1);
      if (copy.evicted) {
        this.focusIdlessEntries--;
        continue;
      }
      copy.seq = seq;
      tally.bound.add(seq);
    }
  }

  /** #662: a copy settled after the read that started at `epoch` began may or may not be in it, so it
   *  binds nothing there, and an unbound stream copy at `seq` it could be is neither free nor bound. */
  private idlessUnsure(tally: IdlessTally | undefined, epoch: number, seq: number): boolean {
    if (!tally || tally.bound.has(seq)) return false;
    return tally.unbound.some((c) => c.epoch >= epoch && c.frontier !== undefined && c.frontier >= seq);
  }

  private protectDisposition(id: string, disposition: "pull-only" | "drop"): void {
    if (id === "") return; // #624: an empty id is never a dedup key, so it is never recorded as one
    const ids = disposition === "drop" ? this.protectedDropIds : this.protectedPullOnlyIds;
    if ((disposition === "drop" ? this.dropUnsafe : this.classificationUnsafe) || ids.has(id)) return;
    if (ids.size >= PROTECTED_DISPOSITION_CAP) {
      if (disposition === "drop") this.dropUnsafe = true;
      else this.classificationUnsafe = true;
      // Keep known hard drops suppressed across later mode changes. The set stays bounded.
      if (disposition !== "drop") ids.clear();
      return;
    }
    ids.add(id);
  }

  /** Normalize a wire message into an {@link InboxItem}. `kind` is the **authenticated** class
   *  from {@link MessageMeta} (subject-derived), never the forgeable payload `to`/`toService`;
   *  core has already normalized `channel` and `toService` from the authenticated chat and svc
   *  subjects. Shared by live ingest and focus recall ({@link recallAmbient}). */
  private toInboxItem(m: CotalMessage, kind: InboxItem["kind"], historical: boolean): InboxItem {
    const text = partsToText(m.parts);
    return {
      id: m.id,
      // The wire id when there is one; a minted opaque key when the id is the empty string (#624:
      // an empty id is never a dedup key, so it is never an address either; but the delivery still
      // needs to be individually drainable/ackable, or it can never clear and never commit).
      recvKey: m.id !== "" ? m.id : `${this.recvKeySecret}.${++this.recvKeySeq}`,
      ts: m.ts,
      fromId: m.from.id,
      fromName: m.from.name,
      fromRole: m.from.role,
      kind,
      channel: m.channel,
      service: m.toService,
      mentions: m.mentions,
      mentionsMe: m.mentions?.includes(this.config.name.toLowerCase()) ?? false,
      historical,
      text,
      replyTo: m.replyTo,
      contextId: m.contextId,
    };
  }

  /** Return pending messages in stable receive order. Automatic delivery excludes quiet ambient;
   *  pull-only is the explicit cotal_inbox lane.
   *
   *  A role request whose take is not yet recorded is never returned (SPEC §8.1): a host shows one
   *  only through {@link takeChosen}. */
  peekInbox(scope: InboxScope = "all"): InboxItem[] {
    this.dropLapsedTakes();
    return this.inbox.filter((p) => this.inScope(p, scope)).map((p) => p.item);
  }

  /** Every pending message in scope as {@link peekInbox} will return it once the held role requests
   *  that may be asked about now are taken, in that order. It is for choosing what to show, never for
   *  showing: hand the choice to {@link takeChosen}. */
  inboxPreview(scope: InboxScope = "all"): InboxItem[] {
    this.dropLapsedTakes();
    const askable = scope === "pull-only" ? [] : this.gated.filter((p) => this.mayOffer(p));
    return [...this.inbox.filter((p) => this.inScope(p, scope)), ...askable].sort((a, b) => a.arrival - b.arrival).map((p) => p.item);
  }

  /** Choose what to show from {@link inboxPreview}, ask the delivery daemon to record the take of
   *  each held role request in the choice, wait up to `waitMs` for the answers, and return the chosen
   *  items that may be shown now, in the order chosen. A take is a claim that this session's agent is
   *  about to see the request, which ends its sender's chance to cancel it, so call this just before
   *  showing and choose only what will be shown. A request whose take is refused or not yet decided
   *  is left out. Never throws. */
  async takeChosen(
    scope: InboxScope,
    choose: (preview: InboxItem[]) => readonly InboxItem[],
    waitMs = TAKE_WAIT_MS,
  ): Promise<InboxItem[]> {
    const chosen = choose(this.inboxPreview(scope));
    const keys = new Set(chosen.map((i) => i.recvKey));
    const asked = scope === "pull-only" ? [] : this.gated
      .filter((p) => keys.has(p.item.recvKey) && this.mayOffer(p));
    for (const p of asked) p.awaited = (p.awaited ?? 0) + 1;
    const runs = asked.map((p) => (p.taking !== undefined && p.takingDrops === this.transportDrops ? p.taking : this.startTake(p)));
    if (runs.length) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); timer.unref?.(); });
      await Promise.race([Promise.allSettled(runs), waited]);
      clearTimeout(timer);
    }
    for (const p of asked) p.awaited = (p.awaited ?? 1) - 1;
    const showable = new Map(this.peekInbox(scope).map((i) => [i.recvKey, i]));
    const shown = chosen.flatMap((i) => showable.get(i.recvKey) ?? []);
    for (const i of shown) handOver(i);
    return shown;
  }

  /** How many role requests are held because their take is pending or could not be decided, and why. */
  heldTakes(): { count: number; detail?: string } {
    const count = this.gated.filter((p) => p.taking === undefined).length;
    const waiting = this.gated.filter((p) => p.taking !== undefined && p.takingDrops === this.transportDrops).length;
    if (waiting) return {
      count: waiting + (this.heldTake ? count : 0),
      detail: "the delivery daemon has not answered the take yet",
    };
    return count && this.heldTake ? { count, detail: this.heldTake.detail } : { count };
  }

  /** Whether a held role request may be asked about now: the link is up, and no take nobody could
   *  decide is being waited out ({@link heldTake}). */
  private mayAskTakes(): boolean {
    return this._transportConnected && (!this.heldTake || Date.now() >= this.heldTake.retryAt);
  }

  /** Whether a read may be offered a held role request now: the link is up and its take is out
   *  already, or a take may be asked ({@link mayAskTakes}). A take that is out when the link drops
   *  cannot admit the request until the link is back, so a read then is offered nothing of it. */
  private mayOffer(p: Pending): boolean {
    return (p.taking !== undefined && this._transportConnected) || this.mayAskTakes();
  }

  private startTake(p: Pending): Promise<void> {
    const run: Promise<void> = this.runTake(p).catch((e) => this.handleEndpointWarning(e as Error)).finally(() => {
      if (p.taking === run) p.taking = undefined;
    });
    p.taking = run;
    p.takingDrops = this.transportDrops;
    return run;
  }

  /** Take one held role request for the copy it holds, and admit it only if it still holds that copy
   *  once the take is recorded: the same delivery, its ack wait not run out, the link not dropped. */
  private async runTake(p: Pending): Promise<void> {
    const take = p.take;
    if (!take) return;
    // The copy is renewed before the take is asked for, so the take cannot outlive it. A copy whose
    // ack wait already ran out may be another holder's now: drop it unacked and let the broker redeliver.
    if (!this._transportConnected) return;
    if (!this.renewOwned(p)) {
      this.dropGated(p);
      return;
    }
    const count = p.item.deliveryCount;
    const drops = this.transportDrops;
    const outcome: AnycastTakeOutcome = await take();
    if (!this.gated.includes(p) || p.take !== take) return;
    // An answer that crossed a link drop is the old link's, so the request stays held and a read
    // waiting on this take shows nothing of it. Its host is told again once the link is up, so the
    // next read takes it on the new link. While the link is down a read could not take it, and the
    // read that waited on this take may still be running, so the reconnect announces it. A read
    // that asked again on the new link owns the request now, so this take says nothing.
    if (this.transportDrops !== drops) {
      if (p.takingDrops !== drops) return;
      if (this._transportConnected) this.emit("incoming", p.item);
      return;
    }
    if (outcome.taken) {
      this.heldTake = undefined;
      const current = p.item.deliveryCount === count && p.ownedUntil !== undefined && Date.now() < p.ownedUntil;
      if (!current) return; // a newer copy arrived meanwhile and needs its own take
      p.takenCount = count;
      p.takenOnce = true;
      this.gated.splice(this.gated.indexOf(p), 1);
      this.noteDirected(p.item);
      this.admit(p);
      // Its arrival was announced already. A read waiting on this take shows it next; one that
      // stopped waiting is told it may be shown now, as of a new arrival.
      if (!p.awaited) this.emit("incoming", p.item);
      return;
    }
    if (outcome.drop) {
      this.dropGated(p);
      return;
    }
    const first = this.heldTake?.reason !== outcome.reason;
    this.heldTake = { reason: outcome.reason, detail: outcome.detail, retryAt: Date.now() + TAKE_RETRY_MS };
    // Nothing asks about a held request on its own, so its host hears of it again when it may.
    this.takeRetry ??= setTimeout(() => {
      this.takeRetry = undefined;
      for (const held of this.gated) this.emit("incoming", held.item);
    }, TAKE_RETRY_MS);
    this.takeRetry.unref?.();
    if (first && outcome.reason !== "daemon-busy") this.handleEndpointWarning(new Error(outcome.detail));
  }

  /** Forget a role request whose take was refused or whose copy ran out. It is never acked: a
   *  cancelled one is gone already, and one another holder took must stay with that holder. */
  private dropGated(p: Pending): void {
    const i = this.gated.indexOf(p);
    if (i >= 0) this.gated.splice(i, 1);
  }

  /** Move a taken role request back to the held set when its copy changed before it was shown. */
  private regate(p: Pending): void {
    const i = this.inbox.indexOf(p);
    if (i < 0) return;
    this.inbox.splice(i, 1);
    p.takenCount = undefined;
    this.gated.push(p);
  }

  /** Drop every taken role request not yet shown whose copy ran out: the broker may have handed it
   *  to another holder, whose take of the later copy wins. One the host holds is renewed and kept. */
  private dropLapsedTakes(): void {
    const now = Date.now();
    this.inbox = this.inbox.filter((p) => !p.take || this.inFlightIds.has(p.item.recvKey) || (p.ownedUntil !== undefined && now < p.ownedUntil));
    this.gated = this.gated.filter((p) => p.taking !== undefined || p.ownedUntil === undefined || now < p.ownedUntil);
  }

  /** Mark a surfaced batch as mid-delivery, so the overflow valve will not evict it out from under
   *  the host. Pair with {@link releaseInFlight} on the delivery verdict, whichever way it goes.
   *
   *  **Counted, not a set.** Hook frames overlap, so the same id is routinely in two open batches at
   *  once; if a hold were a boolean, the first frame's verdict would unprotect ids the second is
   *  still delivering, and an arrival between the two verdicts would ack one — the very loss this
   *  guard exists to stop, reached through the concurrency the per-frame keying deliberately allows.
   *
   *  **All or nothing, and it says which.** At the {@link MAX_IN_FLIGHT} ceiling this refuses the
   *  whole batch and returns `false`; the caller must then NOT surface it. Protecting only part of a
   *  batch, or protecting none while the caller surfaces anyway, silently reopens exactly the loss
   *  this guard exists to close — the unprotected ids sit in the inbox for the whole handoff window
   *  with the overflow valve free to ack them. Declining to surface costs a deferral: the messages
   *  stay buffered and go out on a later frame, once a verdict releases capacity. */
  holdInFlight(ids: readonly string[]): boolean {
    // #624: the keys here are RECEIVE keys. An id-less delivery's wire id is "", so raw-id keying
    // merged the counts of DISTINCT empty-id deliveries, and the eviction valve's in-flight check
    // then deferred acking an evicted id-less item while any other id-less batch was held:
    // cross-delivery interference in the safe direction, but interference. Receive keys are unique
    // per delivery, so each is protected exactly for the frames holding it.
    let fresh = 0;
    for (const id of ids) if (!this.inFlightIds.has(id)) fresh++;
    if (this.inFlightIds.size + fresh > MAX_IN_FLIGHT) return false;
    for (const id of ids) {
      this.inFlightIds.set(id, (this.inFlightIds.get(id) ?? 0) + 1);
      this.keepOwned(id);
    }
    const held = new Set(ids);
    for (const p of this.inbox) if (held.has(p.item.recvKey)) handOver(p.item);
    return true;
  }

  /** Whether this id is currently protected from the overflow valve — i.e. some frame is mid-delivery
   *  holding it. Read-only observability for the property {@link holdInFlight} establishes. A caller
   *  that needs a batch to actually BE in flight before it acts must wait on this, never on a sleep:
   *  the handoff runs through a real relay process whose latency is not the caller's to predict. */
  isInFlight(id: string): boolean {
    return this.inFlightIds.has(id);
  }

  /** One frame's verdict is in (either way). The id is ordinary backlog again only once EVERY frame
   *  holding it has reported — a release from one must not speak for another still in flight. */
  releaseInFlight(ids: readonly string[]): void {
    for (const id of ids) {
      const held = this.inFlightIds.get(id);
      if (held === undefined) continue;
      if (held <= 1) {
        this.inFlightIds.delete(id);
        this.stopRenewal(id);
        if (!this.lowerOnRelease.delete(id)) continue;
        // A failed turn leaves the entry buffered; the change it missed applies now.
        const p = this.inbox.find((pending) => pending.item.recvKey === id);
        if (p && !p.pullOnly) {
          p.pullOnly = true;
          this.excludeFromFocus(p.item);
        }
      } else this.inFlightIds.set(id, held - 1);
    }
  }

  private own(p: Pending, redelivery: Delivery["redelivery"]): void {
    p.redelivery = redelivery;
    p.ownedUntil = redelivery && Date.now() + redelivery.ackWaitMs;
    p.item.deliveryCount = redelivery?.deliveryCount;
    p.item.firstDeliveryCount ??= redelivery?.deliveryCount ?? 1;
  }

  /** Keep a held durable delivery with this reader for as long as the hold lasts, by restarting its
   *  ack wait at half the wait. Only a HELD delivery is renewed: a queued one keeps the broker's
   *  timer, so a reader busy with other work does not sit on a role request another reader could
   *  take, and an abandoned one (released) runs out and redelivers. */
  private keepOwned(key: string): void {
    if (this.renewals.has(key)) return;
    const p = this.inbox.find((x) => x.item.recvKey === key);
    if (!p?.redelivery || !this.renewOwned(p)) return;
    const timer = setInterval(() => {
      const held = this.inbox.find((x) => x.item.recvKey === key);
      if (!held || !this.renewOwned(held)) this.stopRenewal(key);
    }, p.redelivery.ackWaitMs / 2);
    timer.unref?.();
    this.renewals.set(key, timer);
  }

  private stopRenewal(key: string): void {
    clearInterval(this.renewals.get(key));
    this.renewals.delete(key);
  }

  /** Restart one copy's ack wait, unless this reader can no longer vouch that it still holds that
   *  copy. JetStream acks by stream sequence rather than by delivery, so a renewal sent after the
   *  wait may have run out (a stalled loop, a link down for longer than the wait) would extend the
   *  copy the broker has since handed to another reader. Renewal stops instead and the copy is the
   *  broker's to redeliver. Nothing is sent while the link is down, because the client buffers a
   *  publish and would replay it after the wait had run out; a handle whose connection was torn
   *  down throws, which is the same lost ownership. */
  private renewOwned(p: Pending): boolean {
    if (!p.redelivery || p.ownedUntil === undefined || Date.now() >= p.ownedUntil) return false;
    if (!this._transportConnected) return true;
    try {
      p.redelivery.working();
    } catch {
      return false;
    }
    p.ownedUntil = Date.now() + p.redelivery.ackWaitMs;
    return true;
  }

  /** Return scoped pending messages and ack them — call only when they're actually surfaced. */
  drainInbox(limit?: number, scope: InboxScope = "all"): InboxItem[] {
    this.dropLapsedTakes();
    const eligible = this.inbox.filter((p) => this.inScope(p, scope));
    const n = limit && limit > 0 ? Math.min(limit, eligible.length) : eligible.length;
    const selected = eligible.slice(0, n);
    // Head progress is read from the LIVE queue, so it must be recorded while the batch is still in
    // it (#1526).
    this.noteAutomaticHeadProgress(selected);
    // Remove by OBJECT IDENTITY, not by a set of wire ids (#624): the id-less entries share "", so
    // an id set would remove every id-less neighbor beyond the limit and outside the scope while
    // acking only the selected — silent loss by selection. Identity removes exactly what was taken.
    const taken = new Set(selected);
    this.inbox = this.inbox.filter((p) => !taken.has(p));
    const automatic = selected.some((p) => !p.pullOnly);
    const items = this.commitPending(selected);
    if (items.length) this._lastInboxDrainedAt = Date.now();
    // Automatic progress is recorded from the SELECTED entries' own classification, not from the
    // returned items: `commitPending` returns `InboxItem`s, which do not carry `pullOnly`, and
    // counting a pull-only drain as automatic progress is the #1233 lie in miniature.
    if (items.length && automatic) this._lastAutomaticDrainedAt = Date.now();
    return items;
  }

  /** Ack exact surfaced deliveries without assuming they still form the physical inbox prefix.
   *  Takes RECEIVE keys ({@link InboxItem.recvKey}): the wire id for real messages, a minted key
   *  for id-less ones, and selects by them, so a host that surfaced one empty-id item drains THAT
   *  delivery, never its neighbors: the sweep the raw id produced (every pending empty-id item
   *  acked and marked handled in one call) is closed by construction, not by filtering. Every
   *  requested key whose item is present is acked and (for a real id) marked handled, including an
   *  item overflow-evicted during the turn. */
  drainInboxDeliveries(keys: readonly string[]): ExactDrainResult {
    const requested = [...new Set(keys)];
    const wanted = new Set(requested);
    // A role request the host surfaced can be back in the held set when its copy changed since. The
    // host showed it, so its commit acks it from there too. One never taken was never shown, so it
    // stays held: it is not acked, marked handled or reported missing.
    const regated = this.gated.filter((p) => wanted.has(p.item.recvKey) && p.takenOnce);
    const unshown = new Set(this.gated.filter((p) => wanted.has(p.item.recvKey) && !p.takenOnce).map((p) => p.item.recvKey));
    if (regated.length) this.gated = this.gated.filter((p) => !regated.includes(p));
    const selected = [...this.inbox.filter((p) => wanted.has(p.item.recvKey)), ...regated];
    this.noteAutomaticHeadProgress(selected);
    const present = new Set(selected.map((p) => p.item.recvKey));
    const pullOnly = new Map(selected.map((p) => [p.item.recvKey, p.pullOnly]));
    for (const id of requested) {
      const remembered = id !== "" ? this.evictedClassifications.get(id) : undefined;
      if (!pullOnly.has(id) && remembered) pullOnly.set(id, remembered.pullOnly);
    }
    this.inbox = this.inbox.filter((p) => !present.has(p.item.recvKey));
    const automatic = selected.some((p) => !p.pullOnly);
    const items = this.commitPending(selected);
    if (items.length) this._lastInboxDrainedAt = Date.now();
    if (items.length && automatic) this._lastAutomaticDrainedAt = Date.now();
    for (const id of requested) {
      // A MINTED key (an id-less delivery) is never handled-authority: its wire id is "", which
      // markHandled already refuses, so skipping it here is the same at-least-once stance rather
      // than a new one. Recording the minted key itself would pollute handledIds with a string a
      // future REAL id could legitimately equal, arming the exact suppression this change removes.
      if (!present.has(id) && !unshown.has(id) && !id.startsWith(`${this.recvKeySecret}.`)) {
        this.markHandled(id, pullOnly.get(id) ?? false);
        this.evictedClassifications.delete(id);
      }
    }
    return { items, missingKeys: requested.filter((key) => !present.has(key) && !unshown.has(key)) };
  }

  private commitPending(taken: Pending[]): InboxItem[] {
    for (const p of taken) {
      p.ack();
      this.markHandled(p.item.id, p.pullOnly);
      this.evictedClassifications.delete(p.item.id);
    }
    return taken.map((p) => p.item);
  }

  private inScope(p: Pending, scope: InboxScope): boolean {
    return scope === "all" || (scope === "pull-only" ? p.pullOnly : !p.pullOnly);
  }

  /** Record an id as surfaced/handled, for {@link ingest}'s commit-aware cross-path dedup. Bounded via
   *  two rotating windows: when the live set fills, it becomes the previous window and a fresh one
   *  starts — so memory stays ~2× the cap while the lookup horizon never shrinks below it. */
  private markHandled(id: string, pullOnly = false): void {
    if (id === "") return; // #624: an empty id is never a dedup key, so it is never recorded as one
    if (pullOnly) this.protectDisposition(id, "pull-only");
    this.handledIds.add(id);
    if (this.handledIds.size >= 4096) {
      this.handledIdsPrev = this.handledIds;
      this.handledIds = new Set();
    }
  }

  /** Receive keys of the pending messages in scope, role requests held for their take included,
   *  for bookkeeping that shows no body. */
  inboxKeys(scope: InboxScope = "all"): string[] {
    const held = scope === "pull-only" ? [] : this.gated;
    return [...this.inbox.filter((p) => this.inScope(p, scope)), ...held].map((p) => p.item.recvKey);
  }

  /** The pending messages in scope, role requests held for their take included, for a notice that
   *  counts them and shows no body. A held request is shown only through {@link takeChosen}. */
  inboxPending(scope: InboxScope = "all"): InboxItem[] {
    const held = scope === "pull-only" ? [] : this.gated;
    return [...this.inbox.filter((p) => this.inScope(p, scope)), ...held].map((p) => p.item);
  }

  /** Pending messages in scope, counting role requests still held for their take. */
  inboxCount(scope: InboxScope = "all"): number {
    const held = scope === "pull-only" ? 0 : this.gated.length;
    return held + (scope === "all" ? this.inbox.length : this.inbox.filter((p) => this.inScope(p, scope)).length);
  }

  /**
   * Read a bounded presentation snapshot without draining, acknowledging, committing, holding or
   * changing attention. Each item is a shallow copy: reassigning its fields leaves the live inbox
   * unchanged, but nested values such as `mentions` are shared, so callers must treat items as
   * read-only.
   */
  inboxSnapshot(limit = 3): InboxSnapshot {
    if (!Number.isInteger(limit) || limit < 0 || limit > 8)
      throw new Error(`inbox preview limit must be a whole number from 0 to 8, got ${limit}`);
    // A held role request is counted and never previewed: its body is shown only once a host takes
    // it to show it (SPEC §8.1).
    this.dropLapsedTakes();
    return { unread: this.inbox.length + this.gated.length, items: this.inbox.slice(0, limit).map((p) => ({ ...p.item })) };
  }

  /** Local receive time of the oldest still-buffered automatic delivery, if any. */
  oldestAutomaticReceivedAt(): number | undefined {
    let oldest: number | undefined;
    for (const pending of [...this.inbox, ...this.gated]) {
      if (pending.pullOnly) continue;
      if (oldest === undefined || pending.receivedAt < oldest) oldest = pending.receivedAt;
    }
    return oldest;
  }

  /**
   * How far this session has read the focus-mode channel recall.
   *
   * {@link recallAmbient} re-derives the same items from an unchanged frontier on every call, so a
   * reader that shows only what fits in one response would show the same prefix forever. This mark
   * moves when a response actually delivered recall items, and it belongs to ONE walk over ONE
   * frontier: it says how far this focus episode has read, not what the stream still holds, and
   * {@link setAttention} forgets it whenever the frontier under it changes.
   *
   * WHAT THIS MARK DOES NOT OWN, said here so nothing above it claims otherwise. It orders what
   * {@link recallAmbient} hands over; it does not decide what becomes recallable. A message that only
   * becomes readable after this mark has passed its timestamp, through late persistence, is below the
   * watermark and will not be walked to. That is governed by the frontier `recallAmbient` derives from
   * ({@link chatFrontier} and the focus watermark), not here, and it is the same for any
   * timestamp-ordered reader of that stream.
   *
   * What the mark DOES own is where it can be moved to, and only this session's own traffic may move
   * it: an item stamped ahead of the local clock is walked by {@link recallAhead}, not by this mark,
   * so no sender can push it past the messages it has not read yet.
   */
  get recallCursor(): RecallMark {
    return this._recallCursor;
  }

  /**
   * Record the last recall item actually handed to the caller.
   *
   * The mark is a PAIR, not a timestamp, because two recall items can share a millisecond: a
   * timestamp alone either filters the twin out for good, if it advances past both, or re-serves the
   * one already delivered, if it stops below them. Ordering by `(ts, id)` gives every item a place of
   * its own, so the next call resumes strictly after the last one delivered.
   */
  noteRecalled(mark: RecallMark): void {
    if (afterRecallMark(mark, this._recallCursor)) this._recallCursor = mark;
  }

  /**
   * Does this recall item claim a time this session has not reached?
   *
   * `ts` is stamped by the SENDING endpoint, so it is neither trustworthy nor bounded, and a mark
   * that walks it is a mark a peer can move. One message stamped far ahead otherwise parks
   * {@link recallCursor} in the future: every ordinary message after it sorts below the mark, is
   * filtered out of recall for the rest of the session, and the reply says there is no chatter. That
   * is one peer suppressing OTHER peers' recall, which makes it a security property and not only a
   * clock one, and the defence has to hold when the field is chosen rather than merely wrong.
   *
   * So the walk splits. An item at or behind this session's clock is ordered by its timestamp and
   * moves the mark. An item ahead of it is not ordered at all and NEVER moves the mark: it is handed
   * over once and remembered by id ({@link noteRecalledAhead}), so it neither leads the walk nor
   * comes back on the next call.
   *
   * THE LANES SWAP MEMBERSHIP, and the record is what keeps them honest with each other. An item
   * stamped just ahead of the clock crosses into the ordered lane the moment the clock passes it,
   * arriving above a mark that never moved for it, so the reader has to consult
   * {@link recallAheadSeen} there too or hand it over a second time. That crossing is the one part of
   * this mechanism that cannot be staged by choosing timestamps, so its cell waits for real time
   * rather than reasoning about it.
   */
  recallAhead(item: { ts: number }): boolean {
    return item.ts > Date.now();
  }

  /** Has this future-stamped recall item already been handed over in this session? */
  recallAheadSeen(id: string): boolean {
    return this.aheadDelivered.has(id);
  }

  /**
   * How many more future-stamped recall items this session will take responsibility for.
   *
   * Exactness costs memory, and that memory is what a flood of forged stamps would grow, so it is
   * bounded. A caller must not hand over what it cannot record, or it will hand it over again on
   * every call forever; past this bound it has to say so instead. Note where the cost lands: an item
   * at or behind the clock never enters this set, so a peer that spends the whole bound spends it on
   * ITS OWN messages and cannot use it to silence anyone else's.
   */
  recallAheadRoom(): number {
    return MAX_AHEAD - this.aheadDelivered.size;
  }

  /** Record that a future-stamped recall item was actually handed to the caller. */
  noteRecalledAhead(id: string): void {
    if (this.aheadDelivered.size < MAX_AHEAD) this.aheadDelivered.add(id);
  }

  /**
   * Forget how far a recall walk had read, because the thing it was walking is gone.
   *
   * The mark is session-local, which is a longer life than it can honestly carry: it describes a
   * position in ONE walk over ONE frontier, and {@link setAttention} both drops the frontier on the
   * way out of focus and captures a new one on the way in. Measured before this reset, a mark left
   * over from an earlier focus episode filtered a new episode's messages out of recall whenever they
   * were stamped behind it, which a lagging or a chosen clock produces. The focus watermark was
   * already cleared here; the mark that walks it was not.
   */
  private resetRecallWalk(): void {
    this._recallCursor = { ts: 0, id: "" };
    this.aheadDelivered.clear();
  }

  /** Buffered receive-time lane for one delivery, addressed by its receive key. Undefined means it
   *  is no longer pending. */
  inboxScope(key: string): Exclude<InboxScope, "all"> | undefined {
    const pending = this.inbox.find((p) => p.item.recvKey === key) ?? this.gated.find((p) => p.item.recvKey === key);
    return pending ? (pending.pullOnly ? "pull-only" : "automatic") : undefined;
  }

  /** Count of automatic messages that count as directed for a wake decision: real dm/anycast
   *  (authenticated kind) or a live channel @mention. Pull-only history never counts, including
   *  mentions retained while focused. The Stop→idle flush uses this in `dnd`/`focus`. */
  directedPendingCount(): number {
    return this.gated.length + this.inbox.filter((p) => !p.pullOnly && (p.item.kind !== "channel" || (!p.item.historical && p.item.mentionsMe))).length;
  }

  /** The inbox half of {@link pendingWake}: buffered items that should wake the agent, without run
   *  turns. A surface that cannot surface a run turn, such as the remote gateway, waits on this, so
   *  a turn it can never clear does not end every wait at once. */
  inboxWake(skip?: (item: InboxItem) => boolean): number {
    // A role request held for its take wakes when a read could take it: the read the wake leads to
    // takes it. While the link is down, or a take nobody could decide is waited out, none wakes, and
    // each is announced again when the link is back or the wait ends (see runTake). An in-flight take
    // already owns its next announcement; an old-link take must not block a new read after reconnect.
    // A copy whose ack wait ran out is dropped first, as a read drops it.
    this.dropLapsedTakes();
    const held = this.mayAskTakes() ? this.gated.filter((p) =>
      (p.taking === undefined || p.takingDrops !== this.transportDrops) && !skip?.(p.item)).length : 0;
    return held + this.inbox.filter((p) => {
      const it = p.item;
      if (p.pullOnly || (it.kind === "channel" && it.historical) || skip?.(it)) return false;
      if (it.kind !== "channel" || it.mentionsMe) return true;
      return this._attention === "open";
    }).length;
  }

  // ---- attention ------------------------------------------------------------

  /** This agent's global attention mode. Authoritative here; mirrored to presence (advisory) so peers
   *  can see it. Delivery never reads it back from presence — local state wins. */
  get attention(): AttentionMode {
    return this._attention;
  }

  /** This agent's per-channel override for `channel` (undefined ⇒ follow the global mode). */
  channelMode(channel?: string): ChannelMode | undefined {
    return channel ? this.channelModes.get(channel) : undefined;
  }

  /** A snapshot of every per-channel override (for the at-a-glance views). */
  channelModeEntries(): Record<string, ChannelMode> {
    return Object.fromEntries(this.channelModes);
  }

  /** Set (or clear, with `"normal"`) one channel's attention override. Validates the channel is
   *  concrete and within this agent's read ACL (`allowSubscribe` — so a mode can be pre-set for a
   *  channel it may read but hasn't joined yet), updates the AUTHORITATIVE in-memory map, then mirrors
   *  the whole map to presence (best-effort; advisory). Per-instance + runtime: it NEVER writes the
   *  agent file (a shared template) and resets on restart.
   *
   *  It does not purge messages already buffered from that channel. Quiet makes its buffered ambient
   *  pull-only, and muted makes everything buffered from it pull-only, mentions included, so neither
   *  enters another turn and both stay readable with cotal_inbox. `normal` makes nothing automatic
   *  again. */
  async setChannelMode(channel: string, mode: ChannelMode | "normal"): Promise<void> {
    if (!isConcreteChannel(channel))
      throw new Error(`"${channel}" must be a concrete channel (no wildcard) to set its attention`);
    if (!channelInAllow(this.config.allowSubscribe, channel))
      throw new Error(`"${channel}" is not within your read ACL (allowSubscribe) [${this.config.allowSubscribe.join(", ")}]`);
    await this.inOrder(() => {
      if (mode === "normal") this.channelModes.delete(channel);
      else {
        this.channelModes.set(channel, mode);
        this.lowerBuffered(channel, mode === "muted");
      }
      return this.ep.setChannelModes(this.channelModeEntries());
    });
  }

  /** Make the automatic entries buffered from `channel` (a concrete channel or a pattern) pull-only,
   *  mentions of this agent too when `mentions` is set, except on a channel `keep` still covers. An
   *  entry a host is handing over keeps its lane, since the turn carrying it acks it. If that turn
   *  fails instead, {@link releaseInFlight} lowers the entry when the hand-over ends. */
  lowerBuffered(channel: string, mentions: boolean, keep: string[] = []): void {
    for (const p of this.inbox) {
      if (p.pullOnly || p.item.kind !== "channel" || !p.item.channel || !channelInAllow([channel], p.item.channel)) continue;
      if (channelInAllow(keep, p.item.channel)) continue;
      if (p.item.mentionsMe && !mentions) continue;
      if (this.inFlightIds.has(p.item.recvKey)) {
        this.lowerOnRelease.add(p.item.recvKey);
        continue;
      }
      p.pullOnly = true;
      this.excludeFromFocus(p.item);
    }
  }

  /** Set the attention mode. Entering `focus` captures the chat frontier as the focus-watermark
   *  (recall surfaces ambient published after it); leaving focus clears it. Requires a live
    *  connection only for `focus` (it reads the stream frontier). Ambient already *buffered* when
    *  focus is entered is not retroactively ack-dropped. Traffic retained during the asynchronous
    *  frontier read is tagged out of recall, so it surfaces once from its receive-time lane whether
    *  it landed just before or after the captured frontier. Only ambient arriving after the local
    *  switch is ack-dropped. */
  async setAttention(mode: AttentionMode): Promise<void> {
    await this.inOrder(async () => {
    if (mode === "focus") {
      await this.requireConnected();
      this.focusExcludedIds.clear();
      this.focusIdless = new Map();
      this.focusIdlessEntries = 0;
      this.focusRecallUnsafeChannels.clear();
      this.enteringFocus = this._attention !== "focus";
      try {
        this.focusSince = await this.ep.chatFrontier();
      } catch (error) {
        this.enteringFocus = false;
        this.focusExcludedIds.clear();
        this.focusIdless = new Map();
        this.focusIdlessEntries = 0;
        this.focusRecallUnsafeChannels.clear();
        throw error;
      }
      this.enteringFocus = false;
      this.resetRecallWalk();
    } else {
      this.enteringFocus = false;
      this.focusSince = undefined;
      this.focusExcludedIds.clear();
      this.focusIdless = new Map();
      this.focusIdlessEntries = 0;
      this.focusRecallUnsafeChannels.clear();
      this.resetRecallWalk();
    }
    this._attention = mode;
    // Mirror to presence (advisory observability — peers can see "they're in focus"). Best-effort:
    // a no-op until the KV is bound, and never read back into delivery.
    await this.ep.setAttention(mode);
    });
  }

  /** Focus recall: the channel ambient + @mentions ack-dropped since this agent entered focus,
   *  read back from the chat stream on demand and **replay-gated per channel** (a `replay=off`
   *  channel yields nothing, and is named in `droppedChannels` — recall must not become a history
   *  bypass, and it must not claim a suppressed channel's window was empty and complete either).
   *  Items are marked `historical` (catch-up framing). `droppedChannels` also names channels whose
   *  earliest retained message postdates the focus-watermark — older ambient may have aged out of
   *  the per-channel window — and wildcard subscriptions (`team.>`), which recall cannot read back
   *  per concrete sub-channel (#977: a wildcard join is not itself a channel ingest can consult a
   *  replay policy for) and so cannot vouch for either (never-silent throughout). Empty unless in
   *  focus. Calls run one at a time (#662). `underway` names recalled items that already went out in
   *  part: an exclusion that lands after that does not hide one, since recall would then move past
   *  the rest of it (#613). */
  async recallAmbient(underway: ReadonlySet<string> = new Set()): Promise<{ items: InboxItem[]; droppedChannels: string[] }> {
    const run = this.recallLock.then(() => this.recallAmbientOnce(underway));
    this.recallLock = run.catch(() => {});
    return run;
  }

  private async recallAmbientOnce(underway: ReadonlySet<string>): Promise<{ items: InboxItem[]; droppedChannels: string[] }> {
    if (this._attention !== "focus" || this.focusSince === undefined)
      return { items: [], droppedChannels: [] };
    const items: InboxItem[] = [];
    const droppedChannels: string[] = [];
    for (const channel of this.ep.joinedChannels()) {
      if (!isConcreteChannel(channel)) {
        droppedChannels.push(channel);
        continue;
      }
      if (this.focusRecallUnsafeChannels.has(channel)) {
        droppedChannels.push(channel);
        continue;
      }
      const tallies = this.focusIdless;
      let epoch = 0;
      let read!: Awaited<ReturnType<CotalEndpoint["recallChannel"]>>;
      // #662: a copy settled while a read runs may or may not be in it, so the read is retried with
      // that copy settled first, a bounded number of times.
      for (let attempt = 1; attempt <= IDLESS_READS; attempt++) {
        epoch = ++this.idlessEpoch;
        // The read starts after every copy settled before it knows its frontier, so a copy it
        // cannot bind is behind the focus start or out of retention.
        await this.idlessReady(tallies, channel);
        read = await this.ep.recallChannel(channel, this.focusSince);
        if (read.unanswered) break;
        await this.idlessReady(tallies, channel); // copies settled during the read
        const unsure = read.messages.some(
          (m, i) => m.id === "" && this.idlessUnsure(tallies.get(idlessDigest(m)), epoch, read.seqs[i]),
        );
        if (!unsure) break;
      }
      const { messages, seqs, dropped, unanswered } = read;
      // A read that did not answer says nothing about what the channel retains, so nothing settles.
      if (unanswered) {
        droppedChannels.push(channel);
        continue;
      }
      if (this.focusRecallUnsafeChannels.has(channel)) {
        droppedChannels.push(channel);
        continue;
      }
      // #662: each copy settled before the read is bound to one retained stream copy at or below its
      // frontier. A copy no settled copy is bound to was never received (a reconnect gap) or was
      // evicted; it is handed back into the inbox, which acks each by receive key, since the recall
      // mark cannot order identical copies.
      const retained = new Set<number>();
      const digests: string[] = [];
      const free = new Map<string, number[]>();
      for (const [i, m] of messages.entries()) {
        if (m.id !== "" || tallies !== this.focusIdless) continue;
        retained.add(seqs[i]);
        const digest = (digests[i] = idlessDigest(m));
        if (tallies.get(digest)?.bound.has(seqs[i])) continue;
        const list = free.get(digest);
        if (list) list.push(seqs[i]);
        else free.set(digest, [seqs[i]]);
      }
      for (const [digest, list] of free) {
        const tally = tallies.get(digest);
        if (tally) this.bindIdless(tally, epoch, list);
      }
      let incomplete = dropped;
      for (const [i, m] of messages.entries()) {
        if (m.id !== "") {
          if (underway.has(m.id) || !this.focusExcludedIds.has(m.id)) items.push(this.toInboxItem(m, "channel", true));
          continue;
        }
        if (tallies !== this.focusIdless) continue; // focus was left or re-entered during the read
        const seq = seqs[i];
        const digest = digests[i];
        const tally = tallies.get(digest);
        if (tally?.bound.has(seq)) continue;
        // Still unsure after the last read: neither claimed nor handed back, and reported.
        if (this.idlessUnsure(tally, epoch, seq)) {
          incomplete = true;
          continue;
        }
        // A full inbox leaves it in the stream for a later call, rather than evict something else.
        const fresh = this.inbox.length < MAX_INBOX ? this.reserveIdless(digest, channel) : undefined;
        if (!fresh) {
          incomplete = true;
          continue;
        }
        const copy: IdlessCopy = { epoch, frontier: seq, ready: Promise.resolve(), seq };
        fresh.bound.add(seq);
        this.buffer(this.toInboxItem(m, "channel", true), { ack: () => {} }, true, { digest, copy });
      }
      if (tallies === this.focusIdless) this.settleIdlessRead(channel, epoch, retained);
      if (incomplete) droppedChannels.push(channel);
    }
    items.sort((a, b) => a.ts - b.ts);
    return { items, droppedChannels };
  }
}
