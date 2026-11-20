// The durable consumers of CotalEndpoint, as an internal component: the JetStream manager, binding the DM
// inbox, chat and task consumers and pumping them, the DM-only bind, the per-channel chat subscriptions, and
// the consumer and stream reads. Moved verbatim from endpoint.ts; the endpoint keeps the fields and
// chatFrontier and forwards to these. Not re-exported by the index.
import { withDeadline } from "./deadline.js";
import { ackWaitOf, durableDelivery, isRecord } from "./endpoint-inbound.js";
import { authenticatedMessage, kindFromParsed, isUsableMessageId, isFromSubjectSender, dmOnlyDelivery } from "./endpoint-messages.js";
import { DmDurableMissingError, type DmOnlyOptions, DmBindRefusedError } from "./endpoint-options.js";
import { isConsumerNotFound, isJetStreamMissing, isStreamNotFound } from "./jetstream-missing.js";
import { taskDurableConfig } from "./streams.js";
import { dmDurable, dmStream, taskStream, taskDurable, type ParsedSubject, parseSubject, chatSubject } from "./subjects.js";
import type { AgentCard, AnycastTakeOutcome, MessageMeta, CotalMessage, Delivery } from "./types.js";
import { type JetStreamManager, type JetStreamClient, type ConsumerMessages, jetstreamManager, type Consumer, type JsMsg, JetStreamApiCodes, type ConsumerInfo } from "@nats-io/jetstream";
import { type NatsConnection, type Subscription, PermissionViolationError } from "@nats-io/transport-node";
import type { CotalEndpoint } from "./endpoint.js";

/** What the consumers component reads from its endpoint. State is read when it is used, never copied, a
 *  field it reassigns is written back through its setter, and every method is looked up on the endpoint
 *  at call time, so a member a caller replaced on the endpoint is the one that runs. */
export interface EndpointConsumersDeps {
  nc: () => NatsConnection | undefined;
  jsm: () => JetStreamManager | undefined;
  setJsm: (value: JetStreamManager | undefined) => void;
  js: () => JetStreamClient | undefined;
  space: () => string;
  owner: () => string;
  actor: () => string;
  card: () => AgentCard;
  authed: () => boolean;
  channels: () => string[];
  ackWaitMs: () => number;
  inactiveThresholdMs: () => number;
  firstConnect: () => boolean;
  setFirstConnect: (value: boolean) => void;
  backfillFloor: () => number | undefined;
  streamMsgs: () => ConsumerMessages[];
  taskEpoch: () => string | undefined;
  setTaskEpoch: (value: string | undefined) => void;
  stopped: () => boolean;
  dmOnlyInFlight: () => Promise<void> | undefined;
  setDmOnlyInFlight: (value: Promise<void> | undefined) => void;
  chatSubs: () => Map<string, Subscription>;
  chatSubDenied: () => Set<string>;
  chatSubRefusals: () => WeakSet<PermissionViolationError>;
  plane3Channels: () => Map<string, number>;
  notLiveMsg: () => string;
  requireLifecycleUid: (what: string) => string;
  ensureDmDurable: (owner: string, actor: string, lifecycleUid: string, opts: { ackWaitMs?: number; inactiveThresholdMs?: number }) => Promise<void>;
  pumpDlv: () => Promise<void>;
  armJoin: (channels: string[]) => Promise<Map<string, number>>;
  backfillArmed: (frontiers: Map<string, number>, floorSeq?: number) => Promise<number>;
  armBootDurableMemberships: () => Promise<void>;
  takeAnycast: (role: string, seq: number, id: string, count: number, epoch: string, nak: () => void) => Promise<AnycastTakeOutcome>;
  emitRecoverable: (err: Error) => void;
  closeRefusedMembership: (channel: string, generation: number) => Promise<void>;
  emit: (event: string, ...args: unknown[]) => boolean;
}

/** One endpoint's durable consumers. Internal: `CotalEndpoint` keeps the fields and forwards to it. */
export class EndpointConsumers {
  constructor(private readonly deps: EndpointConsumersDeps) {}

  private get nc() { return this.deps.nc(); }
  private get jsm() { return this.deps.jsm(); }
  private set jsm(value: JetStreamManager | undefined) { this.deps.setJsm(value); }
  private get js() { return this.deps.js(); }
  private get space() { return this.deps.space(); }
  private get owner() { return this.deps.owner(); }
  private get actor() { return this.deps.actor(); }
  private get card() { return this.deps.card(); }
  private get authed() { return this.deps.authed(); }
  private get channels() { return this.deps.channels(); }
  private get ackWaitMs() { return this.deps.ackWaitMs(); }
  private get inactiveThresholdMs() { return this.deps.inactiveThresholdMs(); }
  private get firstConnect() { return this.deps.firstConnect(); }
  private set firstConnect(value: boolean) { this.deps.setFirstConnect(value); }
  private get backfillFloor() { return this.deps.backfillFloor(); }
  private get streamMsgs() { return this.deps.streamMsgs(); }
  private get taskEpoch() { return this.deps.taskEpoch(); }
  private set taskEpoch(value: string | undefined) { this.deps.setTaskEpoch(value); }
  private get stopped() { return this.deps.stopped(); }
  private get dmOnlyInFlight() { return this.deps.dmOnlyInFlight(); }
  private set dmOnlyInFlight(value: Promise<void> | undefined) { this.deps.setDmOnlyInFlight(value); }
  private get chatSubs() { return this.deps.chatSubs(); }
  private get chatSubDenied() { return this.deps.chatSubDenied(); }
  private get chatSubRefusals() { return this.deps.chatSubRefusals(); }
  private get plane3Channels() { return this.deps.plane3Channels(); }
  private notLiveMsg(): string { return this.deps.notLiveMsg(); }
  private requireLifecycleUid(what: string): string { return this.deps.requireLifecycleUid(what); }
  private ensureDmDurable(owner: string, actor: string, lifecycleUid: string, opts: { ackWaitMs?: number; inactiveThresholdMs?: number }): Promise<void> { return this.deps.ensureDmDurable(owner, actor, lifecycleUid, opts); }
  private pumpDlv(): Promise<void> { return this.deps.pumpDlv(); }
  private armJoin(channels: string[]): Promise<Map<string, number>> { return this.deps.armJoin(channels); }
  private backfillArmed(frontiers: Map<string, number>, floorSeq?: number): Promise<number> { return this.deps.backfillArmed(frontiers, floorSeq); }
  private armBootDurableMemberships(): Promise<void> { return this.deps.armBootDurableMemberships(); }
  private takeAnycast(role: string, seq: number, id: string, count: number, epoch: string, nak: () => void): Promise<AnycastTakeOutcome> { return this.deps.takeAnycast(role, seq, id, count, epoch, nak); }
  private emitRecoverable(err: Error): void { return this.deps.emitRecoverable(err); }
  private closeRefusedMembership(channel: string, generation: number): Promise<void> { return this.deps.closeRefusedMembership(channel, generation); }
  private emit(event: string, ...args: unknown[]) { return this.deps.emit(event, ...args); }

  /** Lazily obtain a JetStream manager — so a non-consuming endpoint (e.g. the supervisor,
   *  consume:false) can still pre-create others' durables. */
  async manager(): Promise<JetStreamManager> {
    if (!this.nc) throw new Error(this.notLiveMsg());
    this.jsm ??= await jetstreamManager(this.nc);
    return this.jsm;
  }

  /** Bind this endpoint's durable consumers: DM inbox, chat, and (if a role) the task queue. */
  async startConsumers(): Promise<void> {
    if (!this.jsm) throw new Error(this.notLiveMsg());

    // Unicast: this instance's private DM inbox, keyed on this endpoint's owner+actor principal. Open
    // mode self-creates; auth mode BINDS a durable the provisioner pre-created (agents are denied
    // CONSUMER.CREATE on DM_<space>, since the create-time filter_subject is the attack surface).
    const ownUid = this.requireLifecycleUid("consuming the DM inbox");
    if (!this.authed) {
      // Open-mode self-create rides the SAME per-lifecycle ensure as the privileged pre-create: an
      // existing `dm_…-<uid>` durable (this lifecycle's own restart) is kept with its ORIGINAL
      // activation frontier; a fresh lifecycle captures its frontier at creation.
      await this.ensureDmDurable(this.owner, this.actor, ownUid, {
        ackWaitMs: this.ackWaitMs,
        inactiveThresholdMs: this.inactiveThresholdMs,
      });
    }
    const dm = dmDurable(this.owner, this.actor, ownUid);
    try {
      await this.pump(dmStream(this.space), dm, { inbox: true });
    } catch (e) {
      // Auth mode cannot create the durable, so every rebind fails the same way until the session is
      // replaced. The typed error lets a caller name that route instead of a bare "consumer not found".
      if (this.authed && isConsumerNotFound(e)) throw new DmDurableMissingError(dmStream(this.space), dm);
      throw e;
    }

    // Plane-3 (SPEC §8): bind + pump our per-member DELIVER durable (`dlv_<id>`) — the re-authorized
    // durable-backstop channel copies the trusted reader transfers to us. No-op when it isn't present
    // (open mode / un-provisioned). Auth-only feature; the pump self-guards on the durable's existence.
    await this.pumpDlv();

    // Multicast: open a native CORE subscription for each channel (live, manager-free, broker-enforced
    // by sub.allow) — boot + runtime joins use the SAME path; there is no per-instance chat durable.
    // The durable backstop (a busy/offline turn) is Plane-3 (auth: membership established by the agent's
    // self-join, the delivery daemon's fan-out writer + trusted reader deliver via the `dlv_<id>` pump
    // above; open dev mode is live-only — the durable plane needs the daemon's trusted reader, the
    // security boundary). Per-
    // channel history is the explicit replay-gated backfill, on FIRST connect only; a reconnect reopens
    // the subs without re-backfilling (the durable backstop redelivers any missed window via dlv).
    if (this.channels.length) {
      // Arm the per-channel join watermarks BEFORE opening the subs: the backfill reads <= frontier and
      // the core-sub delivers > frontier, so they never overlap (first connect). On reconnect we reopen
      // without arming/backfilling.
      const armed = this.firstConnect ? await this.armJoin(this.channels) : undefined;
      for (const ch of this.channels) this.subscribeChat(ch);
      await this.confirmChatSub();
      if (armed) await this.backfillArmed(armed, this.backfillFloor);
    }
    // First connect, auth mode: self-join BOOT durable channels via the server-side delivery daemon
    // (it owns membership now — there is no manager-written boot membership). Seeds plane3Channels so a
    // later leave can tombstone the §7 boundary; idempotent on relaunch. Open mode has no Plane-3.
    if (this.firstConnect && this.authed && this.channels.length) await this.armBootDurableMemberships();
    this.firstConnect = false;

    // Anycast: a shared work-queue consumer for our role — one instance grabs each task.
    // Open mode self-creates; auth mode BINDS the provisioner-pre-created svc_<role>
    // durable (agents are denied CONSUMER.CREATE on TASK_<space>, since the create-time
    // filter is the cross-role-drain attack surface — see provisionTaskQueue).
    if (this.card.role) {
      if (!this.authed) {
        await this.jsm.consumers.add(
          taskStream(this.space),
          taskDurableConfig(this.space, this.card.role, { ackWaitMs: this.ackWaitMs }),
        );
      }
      await this.pump(taskStream(this.space), taskDurable(this.card.role), this.authed ? { takeRole: this.card.role } : {});
    }
  }

  /** Drive one consumer: decode and hand each message to listeners with ack control. Our own sends are
   *  delivered too: on the DM inbox and the role queue they were addressed to us, so none is an echo,
   *  and acking one unseen on the work queue would delete the only copy of the request. */
  private async pump(stream: string, durable: string, opts: { inbox?: boolean; takeRole?: string } = {}): Promise<void> {
    if (!this.js) throw new Error(this.notLiveMsg());
    const consumer = opts.takeRole === undefined
      ? await this.js.consumers.get(stream, durable)
      : await this.bindTaskConsumer(stream, durable);
    const ackWaitMs = await ackWaitOf(consumer);
    const msgs = await consumer.consume();
    this.streamMsgs.push(msgs);
    if (opts.inbox) this.watchInbox(msgs, stream, durable);
    void (async () => {
      for await (const m of msgs) {
        const authed = this.authenticateStreamMsg(m);
        if (!authed) continue;
        const { msg, parsed } = authed;
        const delivery = durableDelivery(m, ackWaitMs);
        // On an auth mesh a role request carries its take: the holder records it with the delivery
        // daemon before showing the request, so its sender can cancel it until then (SPEC §8.1).
        // The copy carries the creation time of the stream it came from, read at bind.
        const role = opts.takeRole;
        if (role !== undefined) {
          const epoch = this.taskEpoch!;
          delivery.take = () => this.takeAnycast(role, m.seq, msg.id, m.info.deliveryCount, epoch, () => m.nak());
        }
        this.emit("message", authenticatedMessage(msg, parsed), delivery, {
          historical: false,
          kind: kindFromParsed(parsed.kind),
        } satisfies MessageMeta);
      }
    })().catch((e) => {
      if (!this.stopped) this.emit("error", e as Error);
    });
  }

  /** Bind the role consumer and read the TASK stream's creation time on both sides of the bind, so
   *  the time belongs to the stream the consumer was bound on (SPEC §8.1). */
  private async bindTaskConsumer(stream: string, durable: string): Promise<Consumer> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.readTaskEpoch();
      const consumer = await this.js!.consumers.get(stream, durable);
      if (before === (await this.readTaskEpoch())) return consumer;
    }
    throw new Error(`the ${stream} stream was recreated while its role consumer was binding; reconnect to bind it again`);
  }

  /** Read the TASK stream's creation time into {@link taskEpoch}. */
  async readTaskEpoch(): Promise<string> {
    const epoch = (await (await this.manager()).streams.info(taskStream(this.space))).created;
    this.taskEpoch = epoch;
    return epoch;
  }

  /** Warn once when the broker reports this endpoint's own DM inbox missing while the connection is
   *  up, as after a store reset that the client's reconnect rode through, or after a manager restart
   *  deletes the inbox. nats.js keeps checking and resumes pulling if the inbox comes back, so this
   *  only reports. A `consumer_deleted` status is the consumer going away, so it warns at once. A
   *  not-found can be a passing state, so that warning waits for a second report; the several 409s a
   *  delete answers pending pulls with count once. A pull means the consumer was found again, which
   *  re-arms the warning. The loop ends when the consumer is stopped, by `stop()` or by a rebuild
   *  replacing this connection. */
  private watchInbox(msgs: ConsumerMessages, stream: string, durable: string): void {
    const boundNc = this.nc;
    void (async () => {
      let absences = 0;
      let deleted = false;
      for await (const s of msgs.status()) {
        if (this.stopped || this.nc !== boundNc) break;
        if (s.type === "next") {
          absences = 0;
          deleted = false;
          continue;
        }
        if (s.type === "consumer_deleted") {
          if (deleted) continue;
          deleted = true;
          absences = 1; // the deletion itself is the second report: warn on this one
        } else if (s.type !== "consumer_not_found" && s.type !== "stream_not_found") continue;
        if (++absences === 2)
          this.emitRecoverable(new Error(
            `DM inbox missing: the broker reports consumer "${durable}" on stream "${stream}" missing, so direct ` +
              "messages to this endpoint are not delivered. The endpoint keeps checking; if the inbox does not " +
              "come back, end this session and start a new one",
          ));
      }
    })().catch((e) => {
      if (!this.stopped) this.emit("error", e as Error);
    });
  }

  /** Decode one stream copy and apply the authenticity guard (fail closed): the sender is encoded in
   *  the subject, which the server policed who could publish. The payload `from` is advisory — it
   *  must match, and a missing `from` or an unparseable subject on a delivery is itself an anomaly.
   *  A rejected copy is `term()`ed (permanently invalid, never redelivered) and reported, and
   *  `undefined` returns, so no handler ever sees it. */
  private authenticateStreamMsg(m: JsMsg): { msg: CotalMessage; parsed: ParsedSubject } | undefined {
    let msg: CotalMessage;
    try {
      msg = m.json<CotalMessage>();
    } catch (e) {
      m.term(); // undecodable — never redeliver
      this.emit("error", e as Error);
      return undefined;
    }
    if (!isRecord(msg) || !isUsableMessageId(msg.id)) {
      m.term(); // malformed envelope (SPEC sec 5): absent/non-string id — permanently invalid
      this.emit("error", new Error(`dropped message on ${m.subject}: absent or non-string id`));
      return undefined;
    }
    const parsed = parseSubject(m.subject);
    if (!parsed || !isFromSubjectSender(msg, parsed)) {
      m.term();
      this.emit(
        "error",
        new Error(
          `dropped message on ${m.subject}: payload from ${msg.from?.id ?? "(none)"} ` +
            `does not match subject sender ${parsed?.sender ?? "(unparseable)"}`,
        ),
      );
      return undefined;
    }
    return { msg, parsed };
  }

  /** Bind this endpoint's own existing DM durable and drive it serially (EndpointOptions.dmOnly).
   *  The bind is one CONSUMER.INFO on `dm_<owner>-<actor>-<uid>`; reading is MSG.NEXT with a batch
   *  of one, and the next copy reaches the handler only after the previous handler settles. */
  async bindDmOnly(mode: DmOnlyOptions): Promise<void> {
    if (!this.js) throw new Error(this.notLiveMsg());
    const stream = dmStream(this.space);
    const durable = dmDurable(this.owner, this.actor, this.requireLifecycleUid("consuming the DM inbox"));
    let consumer: Consumer;
    try {
      consumer = await this.js.consumers.get(stream, durable);
    } catch (e) {
      if (isJetStreamMissing(e, JetStreamApiCodes.ConsumerNotFound)) throw new DmDurableMissingError(stream, durable);
      throw new DmBindRefusedError(stream, durable, e);
    }
    const ackWaitMs = await ackWaitOf(consumer); // cached by the bind's own CONSUMER.INFO, no request
    // A rebind after reconnect must not overlap the previous epoch's running handler. A handler that
    // does not settle within the stop bound fails this bind; the retry loop tries again.
    if (this.dmOnlyInFlight) {
      const settleMs = mode.settleTimeoutMs ?? 30_000;
      await withDeadline(this.dmOnlyInFlight, settleMs, () =>
        new Error(`DM-only rebind waited ${settleMs}ms for the previous handler to settle; not reading the next DM yet`));
    }
    const msgs = await consumer.consume({ max_messages: 1 });
    this.streamMsgs.push(msgs);
    // The epoch this loop belongs to. nats.js can yield copies it already received after stop() began
    // or after a rebuild replaced the connection (a stacked pull after a missed-heartbeat reset hands
    // over several at once). Such a copy never reaches the handler and is neither acked nor nak'd:
    // the connection is closing or closed, so any reply could be lost, and the broker redelivers an
    // unacked copy after the durable's ack_wait to whichever epoch binds next.
    const boundNc = this.nc;
    const retired = (): boolean => this.stopped || this.nc !== boundNc || !boundNc || boundNc.isClosed();
    void (async () => {
      for await (const m of msgs) {
        if (retired()) break;
        const authed = this.authenticateStreamMsg(m);
        if (!authed) continue;
        if (authed.parsed.kind !== "inst") {
          m.term(); // the DM stream filter admits only inst.* subjects; anything else is not a DM
          continue;
        }
        const run = Promise.resolve().then(() => mode.handler(authenticatedMessage(authed.msg, authed.parsed), dmOnlyDelivery(m, ackWaitMs, boundNc), {
          historical: false,
          kind: "dm",
        } satisfies MessageMeta));
        const flight = run.then(() => {}, () => {});
        this.dmOnlyInFlight = flight;
        try {
          await run;
        } catch (e) {
          this.emit("error", e instanceof Error ? e : new Error(String(e)));
        } finally {
          if (this.dmOnlyInFlight === flight) this.dmOnlyInFlight = undefined;
        }
      }
    })().catch((e) => {
      if (!this.stopped) this.emit("error", e as Error);
    });
  }

  /** Open a native core subscription to a channel's live feed (the manager-free live read path,
   *  broker-enforced by `sub.allow`). At-most-once — no replay, no ack; it is the live delivery for
   *  every channel (boot + runtime). For a `durable` channel it is also the low-latency wake-hint
   *  alongside the Plane-3 durable copy, coalesced by the receiver's id-dedup. Drops our own echo +
   *  spoofed senders. */
  subscribeChat(channel: string): void {
    if (!this.nc || this.chatSubs.has(channel)) return;
    this.chatSubDenied.delete(channel);
    const subject = chatSubject(this.space, "*", "*", channel);
    const sub = this.nc.subscribe(subject, {
      callback: (err, m) => {
        if (err) {
          // async sub.allow refusal (or sub error): the live feed for this channel is dead — never a
          // leak (the broker refused it). Drop the channel from local joined state even if it was
          // already treated as joined — a LATE refusal beyond the confirm window: conformance #13
          // "drop on late refusal". (During the join's own confirm the channel isn't pushed yet, so
          // this fires nothing then; joinChannel reads `chatSubDenied` and throws cleanly.) Either way
          // the refusal is reported from here, by that throw or the leave below, so watchStatus skips it.
          if (err instanceof PermissionViolationError) this.chatSubRefusals.add(err);
          this.chatSubDenied.add(channel);
          this.chatSubs.delete(channel);
          const i = this.channels.indexOf(channel);
          if (i >= 0) {
            this.channels.splice(i, 1);
            // A late sub.allow refusal forces this agent out of the channel (the broker revoked its live
            // read). If it held a Plane-3 durable membership, the §7 boundary must close too. This sub
            // callback can't await, so a fail-closed async helper RETRIES the tombstone (backoff) UNTIL it
            // succeeds, clearing the mirror only then; while pending it is surfaced via cotal_channels —
            // never a silent drop, never lost retry state.
            const gen = this.plane3Channels.get(channel);
            if (gen !== undefined) void this.closeRefusedMembership(channel, gen);
            this.emit(
              "error",
              new Error(`left channel "${channel}": its live subscription was refused by the broker`, { cause: err }),
            );
          }
          return;
        }
        const parsed = parseSubject(m.subject);
        if (!parsed || parsed.kind !== "chat") return;
        let msg: CotalMessage;
        try {
          msg = m.json<CotalMessage>();
        } catch (e) {
          this.emit("error", e as Error);
          return;
        }
        if (!isRecord(msg) || !isUsableMessageId(msg.id)) return; // malformed envelope (SPEC sec 5) — live is at-most-once: drop
        if (!isFromSubjectSender(msg, parsed)) return; // spoof/malformed/old-shape-alias — drop (at-most-once)
        if (msg.from.id === this.card.id) return; // our own echo
        const delivery: Delivery = { ack: () => {}, nak: () => {}, durable: false }; // live = at-most-once, not acked
        this.emit("message", authenticatedMessage(msg, parsed), delivery, {
          historical: false,
          kind: kindFromParsed(parsed.kind),
        } satisfies MessageMeta);
      },
    });
    this.chatSubs.set(channel, sub);
  }

  /** Close a channel's core subscription (manager-free leave). */
  unsubscribeChat(channel: string): void {
    const sub = this.chatSubs.get(channel);
    if (sub) {
      try {
        sub.unsubscribe();
      } catch {
        /* closing with the connection */
      }
      this.chatSubs.delete(channel);
    }
    this.chatSubDenied.delete(channel);
  }

  /** Confirm a just-opened core subscription was accepted by the broker. A `sub.allow` violation is
   *  async in NATS, so flush (round-trips the SUB) then settle briefly to let the refusal land — a
   *  denied subscribe must not read as a successful join (SPEC conformance #13). */
  async confirmChatSub(): Promise<void> {
    if (!this.nc) throw new Error("connection not established");
    // flush() is the deterministic boundary: the broker's -ERR for an out-of-ACL SUB arrives BEFORE the
    // PONG, so once flush resolves the subscribe callback has already recorded any denial. A flush
    // FAILURE means the connection drained/closed mid-join — we have no confirmation, so let it throw
    // (joinChannel fails closed) instead of swallowing it and continuing as if confirmed.
    await this.nc.flush();
    await new Promise((r) => setTimeout(r, 50));
  }

  /** The durable's info (rebind) or null (fresh — 404). Gates create/backfill to the join event
   *  and exposes the current `filter_subjects` for restart reconciliation. */
  async consumerInfo(stream: string, durable: string): Promise<ConsumerInfo | null> {
    if (!this.jsm) throw new Error(this.notLiveMsg());
    try {
      return await this.jsm.consumers.info(stream, durable);
    } catch (e) {
      if (isJetStreamMissing(e, JetStreamApiCodes.ConsumerNotFound))
        return null; // structured absence — fresh durable
      throw e;
    }
  }

  /** Delete one named consumer, swallowing ONLY structured consumer/stream absence. */
  async deleteConsumerIfPresent(stream: string, durable: string): Promise<void> {
    if (!this.jsm) throw new Error(this.notLiveMsg());
    try {
      await this.jsm.consumers.delete(stream, durable);
    } catch (e) {
      if (!isJetStreamMissing(e, JetStreamApiCodes.ConsumerNotFound, JetStreamApiCodes.StreamNotFound)) throw e;
    }
  }

  /** Whether this connection's account has a JetStream stream of this name. A missing stream is
   *  false. Any other failure is thrown, so a caller does not treat an unread broker as absence. */
  async streamRecorded(name: string): Promise<boolean> {
    try {
      await (await this.manager()).streams.info(name);
      return true;
    } catch (e) {
      if (isStreamNotFound(e)) return false;
      throw e;
    }
  }

  /** The bytes this connection's account holds in JetStream file storage, as `$JS.API.INFO`
   *  reports them. A broker's `max_file_store` cap counts every account it serves, so this is a
   *  lower bound on what that cap measures. */
  async storedBytes(): Promise<number> {
    return (await (await this.manager()).getAccountInfo()).storage;
  }
}

/** The deps of one endpoint's {@link EndpointConsumers}. Every value is read from `ep` when it is used, so a field
 *  assigned after construction is seen, and a member a caller replaced on the endpoint is the one that runs. */
export function endpointConsumersDeps(ep: CotalEndpoint): EndpointConsumersDeps {
  return {
    nc: () => ep["nc"],
    jsm: () => ep["jsm"],
    setJsm: (value) => { ep["jsm"] = value; },
    js: () => ep["js"],
    space: () => ep["space"],
    owner: () => ep["owner"],
    actor: () => ep["actor"],
    card: () => ep["card"],
    authed: () => ep["authed"],
    channels: () => ep["channels"],
    ackWaitMs: () => ep["ackWaitMs"],
    inactiveThresholdMs: () => ep["inactiveThresholdMs"],
    firstConnect: () => ep["firstConnect"],
    setFirstConnect: (value) => { ep["firstConnect"] = value; },
    backfillFloor: () => ep["backfillFloor"],
    streamMsgs: () => ep["streamMsgs"],
    taskEpoch: () => ep["taskEpoch"],
    setTaskEpoch: (value) => { ep["taskEpoch"] = value; },
    stopped: () => ep["stopped"],
    dmOnlyInFlight: () => ep["dmOnlyInFlight"],
    setDmOnlyInFlight: (value) => { ep["dmOnlyInFlight"] = value; },
    chatSubs: () => ep["chatSubs"],
    chatSubDenied: () => ep["chatSubDenied"],
    chatSubRefusals: () => ep["chatSubRefusals"],
    plane3Channels: () => ep["plane3Channels"],
    notLiveMsg: () => ep["notLiveMsg"](),
    requireLifecycleUid: (what) => ep["requireLifecycleUid"](what),
    ensureDmDurable: (owner, actor, lifecycleUid, opts) => ep["ensureDmDurable"](owner, actor, lifecycleUid, opts),
    pumpDlv: () => ep["pumpDlv"](),
    armJoin: (channels) => ep["armJoin"](channels),
    backfillArmed: (frontiers, floorSeq) => ep["backfillArmed"](frontiers, floorSeq),
    armBootDurableMemberships: () => ep["armBootDurableMemberships"](),
    takeAnycast: (role, seq, id, count, epoch, nak) => ep["takeAnycast"](role, seq, id, count, epoch, nak),
    emitRecoverable: (err) => ep["emitRecoverable"](err),
    closeRefusedMembership: (channel, generation) => ep["closeRefusedMembership"](channel, generation),
    emit: (event, ...args) => ep["emit"](event, ...args),
  };
}
