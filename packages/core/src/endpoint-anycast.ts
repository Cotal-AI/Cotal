// The anycast request rail of CotalEndpoint, as an internal component: the daemon side (arm and drop the
// take responder and the request records, answer takes, send request and mention notices, answer status
// and cancel) and the holder side (take a request, read or cancel one of this endpoint's own). Moved
// verbatim from endpoint.ts; the endpoint keeps the fields and forwards to these. Not re-exported by the index.
import { AnycastRequestAuthority, ANYCAST_RECORDS_CREDENTIAL_OUTDATED, type AnycastTakeReply, type AnycastTakeRequest, isAnycastSeq, type AnycastNotice, ANYCAST_NOTICE_KEY, ANYCAST_CANCEL_OP, type AnycastStatus, ANYCAST_TAKES_OP, ANYCAST_STATUS_OP } from "./anycast-requests.js";
import { ANYCAST_SWEEP_MS, MAX_TAKES_IN_FLIGHT, ANYCAST_TAKE_TIMEOUT_MS } from "./endpoint-options.js";
import { isPermissionDenied } from "./permission-denied.js";
import { assertValidName } from "./resolve.js";
import { anycastStoreDefinition } from "./streams.js";
import { taskStream, takeServeFilter, TAKE_ROUTE, parseTakeSubject, isPrincipalOwnerToken, parsePrincipalKey, unicastSubject, MENTION_NOTICE_KEY, takeSubject } from "./subjects.js";
import type { AgentCard, EndpointRef, ControlReply, CotalMessage, AnycastTakeOutcome } from "./types.js";
import type { JetStreamManager, JetStreamClient } from "@nats-io/jetstream";
import { type KV, Kvm } from "@nats-io/kv";
import { type NatsConnection, type Subscription, type Msg, NoRespondersError, RequestError } from "@nats-io/transport-node";
import { randomUUID } from "node:crypto";
import type { CotalEndpoint } from "./endpoint.js";

/** What the anycast component reads from its endpoint. State is read when it is used, never copied, a
 *  field it reassigns is written back through its setter, and every method is looked up on the endpoint
 *  at call time, so a member a caller replaced on the endpoint is the one that runs. */
export interface EndpointAnycastDeps {
  nc: () => NatsConnection | undefined;
  jsm: () => JetStreamManager | undefined;
  js: () => JetStreamClient | undefined;
  space: () => string;
  owner: () => string;
  actor: () => string;
  card: () => AgentCard;
  authed: () => boolean;
  subs: () => Subscription[];
  anycastUnavailable: () => string | undefined;
  setAnycastUnavailable: (value: string | undefined) => void;
  anycastAuthority: () => AnycastRequestAuthority | undefined;
  setAnycastAuthority: (value: AnycastRequestAuthority | undefined) => void;
  takeServeSub: () => import("@nats-io/transport-node").Subscription | undefined;
  setTakeServeSub: (value: import("@nats-io/transport-node").Subscription | undefined) => void;
  anycastSweep: () => ReturnType<typeof setInterval> | undefined;
  setAnycastSweep: (value: ReturnType<typeof setInterval> | undefined) => void;
  takesInFlight: () => number;
  setTakesInFlight: (value: number) => void;
  emitRecoverable: (err: Error) => void;
  plane3MayAct: () => boolean;
  notLiveMsg: () => string;
  ref: () => EndpointRef;
  requestBoundReply: (nc: NatsConnection, subject: string, body: string, reply: string, timeoutMs: number) => Promise<Msg>;
  readTaskEpoch: () => Promise<string>;
  requestDelivery: (op: string, args: Record<string, unknown>, timeoutMs?: number) => Promise<ControlReply>;
}

/** One endpoint's anycast request rail. Internal: `CotalEndpoint` keeps the fields and forwards to it. */
export class EndpointAnycast {
  constructor(private readonly deps: EndpointAnycastDeps) {}

  private get nc() { return this.deps.nc(); }
  private get jsm() { return this.deps.jsm(); }
  private get js() { return this.deps.js(); }
  private get space() { return this.deps.space(); }
  private get owner() { return this.deps.owner(); }
  private get actor() { return this.deps.actor(); }
  private get card() { return this.deps.card(); }
  private get authed() { return this.deps.authed(); }
  private get subs() { return this.deps.subs(); }
  private get anycastUnavailable() { return this.deps.anycastUnavailable(); }
  private set anycastUnavailable(value: string | undefined) { this.deps.setAnycastUnavailable(value); }
  private get anycastAuthority() { return this.deps.anycastAuthority(); }
  private set anycastAuthority(value: AnycastRequestAuthority | undefined) { this.deps.setAnycastAuthority(value); }
  private get takeServeSub() { return this.deps.takeServeSub(); }
  private set takeServeSub(value: import("@nats-io/transport-node").Subscription | undefined) { this.deps.setTakeServeSub(value); }
  private get anycastSweep() { return this.deps.anycastSweep(); }
  private set anycastSweep(value: ReturnType<typeof setInterval> | undefined) { this.deps.setAnycastSweep(value); }
  private get takesInFlight() { return this.deps.takesInFlight(); }
  private set takesInFlight(value: number) { this.deps.setTakesInFlight(value); }
  private emitRecoverable(err: Error): void { return this.deps.emitRecoverable(err); }
  private plane3MayAct(): boolean { return this.deps.plane3MayAct(); }
  private notLiveMsg(): string { return this.deps.notLiveMsg(); }
  private ref(): EndpointRef { return this.deps.ref(); }
  private requestBoundReply(nc: NatsConnection, subject: string, body: string, reply: string, timeoutMs: number): Promise<Msg> { return this.deps.requestBoundReply(nc, subject, body, reply, timeoutMs); }
  private readTaskEpoch(): Promise<string> { return this.deps.readTaskEpoch(); }
  private requestDelivery(op: string, args: Record<string, unknown>, timeoutMs?: number): Promise<ControlReply> { return this.deps.requestDelivery(op, args, timeoutMs); }

  /** (Re)bind the anycast take responder and the request records maintenance on the current
   *  connection (SPEC §8.1). The records bucket is created here as well as at space setup, so a mesh
   *  that predates it gets one when its daemon restarts at this version. */
  async armAnycastRequests(): Promise<void> {
    if (!this.nc || !this.jsm) return;
    this.dropAnycastRequests();
    const definition = anycastStoreDefinition(this.space);
    let kv: KV;
    try {
      kv = await new Kvm(this.nc).create(definition.bucket, definition.createOptions);
    } catch (e) {
      // A credential minted before the records existed cannot open them. That costs the records and
      // nothing else: the rest of Plane-3 still serves, and every anycast op answers with the cause.
      if (!isPermissionDenied(e)) throw e;
      this.anycastUnavailable = ANYCAST_RECORDS_CREDENTIAL_OUTDATED;
      this.emitRecoverable(new Error(`delivery: ${ANYCAST_RECORDS_CREDENTIAL_OUTDATED}`));
      return;
    }
    this.anycastUnavailable = undefined;
    const authority = new AnycastRequestAuthority({
      jsm: this.jsm,
      kv,
      stream: taskStream(this.space),
      send: (to, event) => this.sendAnycastNotice(to, event),
      mayAct: () => this.plane3MayAct(),
      onError: (e) => this.emitRecoverable(e),
    });
    this.anycastAuthority = authority;
    this.takeServeSub = this.serveTakes(authority);
    const sweep = () => void authority.sweep().catch((e) => this.emitRecoverable(e as Error));
    this.anycastSweep = setInterval(sweep, ANYCAST_SWEEP_MS);
    this.anycastSweep.unref?.();
    sweep();
  }

  dropAnycastRequests(): void {
    if (this.takeServeSub) {
      try { this.takeServeSub.unsubscribe(); } catch { /* dead with the old connection */ }
      const i = this.subs.indexOf(this.takeServeSub);
      if (i >= 0) this.subs.splice(i, 1);
      this.takeServeSub = undefined;
    }
    clearInterval(this.anycastSweep);
    this.anycastSweep = undefined;
    this.anycastAuthority = undefined;
  }

  /** Serve takes on `take.*.*.*`, each in its own time: a take reads one request and writes one row,
   *  and shares nothing with any other take but the row's CAS. The reply is bound to the caller's own
   *  request subtree, as `serveControl`'s `boundReply` binds it. */
  private serveTakes(authority: AnycastRequestAuthority): import("@nats-io/transport-node").Subscription {
    const sub = this.nc!.subscribe(takeServeFilter(this.space), { queue: TAKE_ROUTE });
    this.subs.push(sub);
    void (async () => {
      for await (const m of sub) {
        if (!m.reply || !m.reply.startsWith(`${m.subject}.reply.`)) {
          this.emitRecoverable(new Error(`rejected take on ${m.subject}: reply target "${m.reply ?? "(none)"}" is not under the sender's own reply subtree`));
          continue;
        }
        void this.answerTake(authority, m).catch((e) => this.emitRecoverable(e as Error));
      }
    })().catch((e) => this.emitRecoverable(e as Error));
    return sub;
  }

  private async answerTake(authority: AnycastRequestAuthority, m: import("@nats-io/transport-node").Msg): Promise<void> {
    let reply: AnycastTakeReply;
    if (this.takesInFlight >= MAX_TAKES_IN_FLIGHT) reply = { ok: false, code: "busy", error: "the delivery daemon is answering too many takes; retry" };
    else {
      this.takesInFlight++;
      try {
        reply = await this.takeFor(authority, m);
      } catch (e) {
        reply = { ok: false, code: "busy", error: `the take could not be recorded: ${(e as Error).message}` };
      } finally {
        this.takesInFlight--;
      }
    }
    m.respond(JSON.stringify(reply));
  }

  /** Check one take's caller and arguments, then record it. The role and the caller come from the
   *  broker-policed subject; the payload's `from.id` must match, as on every control rail. */
  private async takeFor(authority: AnycastRequestAuthority, m: import("@nats-io/transport-node").Msg): Promise<AnycastTakeReply> {
    if (!this.plane3MayAct()) return { ok: false, code: "busy", error: "delivery: this daemon is not serving this shard (it is re-checking ownership); retry" };
    const parsed = parseTakeSubject(m.subject);
    let req: AnycastTakeRequest | undefined;
    try { req = m.json<AnycastTakeRequest>(); } catch { req = undefined; }
    if (!parsed || !isPrincipalOwnerToken(parsed.owner) || req?.from?.id !== parsed.sender || typeof req.from.name !== "string")
      return { ok: false, code: "mismatch", error: "sender mismatch - take rejected" };
    if (!isAnycastSeq(req.seq) || !isAnycastSeq(req.count) || typeof req.id !== "string" || req.id.length > 256 ||
        typeof req.epoch !== "string" || req.epoch.length > 64)
      return { ok: false, code: "mismatch", error: "a take names a seq, the request id, a delivery count and the stream's creation time" };
    // The name reaches the sender's status text, so it must pass the rule a presence card name does.
    try { assertValidName(req.from.name); } catch (e) {
      return { ok: false, code: "mismatch", error: `a take names its holder by a valid display name: ${(e as Error).message}` };
    }
    return authority.take(parsed.role, { from: { id: parsed.sender, name: req.from.name }, seq: req.seq, id: req.id, count: req.count, epoch: req.epoch });
  }

  /** DM one notice to a request's sender from this daemon's own principal. The event key is the
   *  message id, so a resend after a crash is dropped by the DM stream's duplicate window and by
   *  the receiving connector. */
  private async sendAnycastNotice(to: string, event: { key: string; text: string; notice: AnycastNotice }): Promise<void> {
    if (!this.js) throw new Error(this.notLiveMsg());
    const recipient = parsePrincipalKey(to);
    if (!recipient) throw new Error(`anycast notice: "${to}" is not a principal`);
    const msg: CotalMessage = {
      id: event.key,
      ts: Date.now(),
      space: this.space,
      from: this.ref(),
      to,
      parts: [{ kind: "text", text: event.text }, { kind: "data", data: { [ANYCAST_NOTICE_KEY]: event.notice } }],
    };
    await this.js.publish(unicastSubject(this.space, recipient.owner, recipient.actor, this.owner, this.actor), JSON.stringify(msg), { msgID: msg.id });
  }

  /** DM a post's sender that its mentions of `names` reached no one, because each of those agents
   *  may not read `channel`. The id carries the post's stream seq, so a fan-out redelivered after a
   *  crash sends the notice again under the same id and the DM stream drops the duplicate. */
  async sendMentionNotice(msg: CotalMessage, channel: string, seq: number, names: readonly string[]): Promise<void> {
    if (!this.js) throw new Error(this.notLiveMsg());
    const recipient = parsePrincipalKey(msg.from.id);
    if (!recipient) throw new Error(`mention notice: "${msg.from.id}" is not a principal`);
    const named = names.map((n) => `@${n}`).join(", ");
    const notice: CotalMessage = {
      id: `mention.${seq}.${msg.id}`,
      ts: Date.now(),
      space: this.space,
      from: this.ref(),
      to: msg.from.id,
      parts: [
        { kind: "text", text: `Your post on #${channel} mentioned ${named}, who may not read #${channel} and ${names.length === 1 ? "was" : "were"} not given it. Reach ${names.length === 1 ? "them" : "each"} another way, such as cotal_dm.` },
        { kind: "data", data: { [MENTION_NOTICE_KEY]: { channel, message: msg.id, names: [...names] } } },
      ],
    };
    await this.js.publish(unicastSubject(this.space, recipient.owner, recipient.actor, this.owner, this.actor), JSON.stringify(notice), { msgID: notice.id });
  }

  /** Answer a sender's status or cancel for one of its own requests. The caller is the
   *  authenticated subject sender, checked against the request's stored subject. */
  async deliveryAnycast(op: string, caller: string, args: Record<string, unknown>): Promise<ControlReply> {
    const authority = this.anycastAuthority;
    if (!authority)
      return { ok: false, error: `delivery: ${this.anycastUnavailable ?? "the anycast request records are not open on this daemon; retry"}` };
    if (!isAnycastSeq(args.seq)) return { ok: false, error: `${op}: seq must be a whole number of at least 1` };
    if (args.id !== undefined && (typeof args.id !== "string" || args.id.length > 256)) return { ok: false, error: `${op}: id must be a request id` };
    const q = { seq: args.seq, ...(typeof args.id === "string" ? { id: args.id } : {}) };
    try {
      const status = op === ANYCAST_CANCEL_OP ? await authority.cancel(caller, q) : await authority.status(caller, q);
      if (!this.plane3MayAct()) return { ok: false, error: "delivery: this daemon stopped serving this shard while the request was in flight; retry" };
      return { ok: true, data: status satisfies AnycastStatus };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** A control request that found NO responder — open / manager-less (no privileged control plane),
   *  distinct from a responder that errored. nats.js surfaces it as NoRespondersError, or a RequestError
   *  whose `isNoResponders()` is true. */
  isNoResponders(e: unknown): boolean {
    return e instanceof NoRespondersError || (e instanceof RequestError && e.isNoResponders());
  }

  /** Holder side of a take (SPEC §8.1): ask the delivery daemon to record this endpoint's take of the
   *  request at `seq`, for the copy with `count` deliveries. Never throws; a take the daemon could
   *  not decide is reported as held, with what the operator has to do when that is anything. */
  async takeAnycast(role: string, seq: number, id: string, count: number, epoch: string, nak: () => void): Promise<AnycastTakeOutcome> {
    const nc = this.nc;
    if (!nc) return { taken: false, drop: false, reason: "daemon-down", detail: this.notLiveMsg() };
    const held = (reason: "daemon-busy" | "daemon-down" | "daemon-outdated" | "credential-outdated", detail: string): AnycastTakeOutcome =>
      ({ taken: false, drop: false, reason, detail });
    const subject = takeSubject(this.space, role, this.owner, this.actor);
    const body: AnycastTakeRequest = { from: { id: this.card.id, name: this.card.name }, seq, id, count, epoch };
    let reply: AnycastTakeReply;
    try {
      const m = await this.requestBoundReply(nc, subject, JSON.stringify(body), `${subject}.reply.${randomUUID()}`, ANYCAST_TAKE_TIMEOUT_MS);
      reply = m.json<AnycastTakeReply>();
    } catch (e) {
      if (isPermissionDenied(e))
        return held("credential-outdated", "this seat's credential was minted before anycast takes existed, so it cannot take role requests; respawn the seat to get a current credential");
      if (this.isNoResponders(e)) return this.takeResponderMissing();
      return held("daemon-down", `the delivery daemon did not answer the take: ${(e as Error).message}`);
    }
    if (reply.ok) return { taken: true };
    // A mismatch can mean the stream was recreated under this consumer, which resumes on the new
    // stream: read its creation time again, so the copies delivered from here on carry it. When the
    // time moved, this copy is nakked, so the broker delivers it again at once with the new time. A
    // redelivery that still mismatches carries the time read here, so it is forgotten, not nakked.
    if (reply.code === "mismatch") {
      const current = await this.readTaskEpoch().catch(() => undefined);
      if (current !== undefined && current !== epoch) nak();
    }
    if (reply.code === "cancelled" || reply.code === "taken" || reply.code === "gone" || reply.code === "mismatch")
      return { taken: false, drop: true, reason: reply.code, detail: reply.error };
    return held("daemon-busy", reply.error);
  }

  /** No responder on the take rail: an older daemon answers the probe op as unsupported, and a
   *  stopped one does not answer at all. */
  private async takeResponderMissing(): Promise<AnycastTakeOutcome> {
    const held = (reason: "daemon-down" | "daemon-outdated", detail: string): AnycastTakeOutcome => ({ taken: false, drop: false, reason, detail });
    let reply: ControlReply;
    try {
      reply = await this.requestDelivery(ANYCAST_TAKES_OP, {}, ANYCAST_TAKE_TIMEOUT_MS);
    } catch {
      return held("daemon-down", "no delivery daemon is answering on this mesh, so role requests wait on the queue until one does");
    }
    if (!reply.ok && /not supported on the delivery control service/.test(reply.error ?? ""))
      return held("daemon-outdated", "the delivery daemon predates anycast takes, so this seat holds role requests until the daemon is restarted at this version (`cotal up` runs it)");
    if (!reply.ok && reply.error?.includes(ANYCAST_RECORDS_CREDENTIAL_OUTDATED))
      return held("daemon-outdated", `this seat holds role requests until the delivery daemon can record takes: ${ANYCAST_RECORDS_CREDENTIAL_OUTDATED}`);
    return held("daemon-down", "the delivery daemon is not answering takes, so role requests wait on the queue until it does");
  }

  /** The status of one of this endpoint's own anycast requests, from the delivery daemon's record
   *  or, with no record, from the queue (SPEC §8.1). `id` narrows the answer to that request. Throws
   *  on an open mesh, which runs no delivery daemon. */
  async anycastStatus(seq: number, id?: string): Promise<AnycastStatus> {
    return this.anycastRequest(ANYCAST_STATUS_OP, seq, id);
  }

  /** Cancel one of this endpoint's own anycast requests while it waits. A request a holder already
   *  took is refused, and the returned status names the taker. */
  async cancelAnycast(seq: number, id?: string): Promise<AnycastStatus> {
    return this.anycastRequest(ANYCAST_CANCEL_OP, seq, id);
  }

  private async anycastRequest(op: string, seq: number, id: string | undefined): Promise<AnycastStatus> {
    if (!this.authed) throw new Error("an open mesh runs no delivery daemon, so it keeps no record of anycast requests");
    if (!isAnycastSeq(seq)) throw new Error(`seq must be a whole number of at least 1, got ${seq}`);
    let reply: ControlReply;
    try {
      reply = await this.requestDelivery(op, { seq, ...(id !== undefined ? { id } : {}) }, 10_000);
    } catch (e) {
      if (this.isNoResponders(e)) throw new Error("no delivery daemon is answering on this mesh, so the request's record cannot be read");
      throw e;
    }
    if (!reply.ok) {
      if (/not supported on the delivery control service/.test(reply.error ?? ""))
        throw new Error("the delivery daemon predates anycast request status; restart it at this version (`cotal up` runs it)");
      throw new Error(reply.error ?? `${op} failed`);
    }
    return reply.data as AnycastStatus;
  }

}

/** The deps of one endpoint's {@link EndpointAnycast}. Every value is read from `ep` when it is used, so a field
 *  assigned after construction is seen, and a member a caller replaced on the endpoint is the one that runs. */
export function endpointAnycastDeps(ep: CotalEndpoint): EndpointAnycastDeps {
  return {
    nc: () => ep["nc"],
    jsm: () => ep["jsm"],
    js: () => ep["js"],
    space: () => ep["space"],
    owner: () => ep["owner"],
    actor: () => ep["actor"],
    card: () => ep["card"],
    authed: () => ep["authed"],
    subs: () => ep["subs"],
    anycastUnavailable: () => ep["anycastUnavailable"],
    setAnycastUnavailable: (value) => { ep["anycastUnavailable"] = value; },
    anycastAuthority: () => ep["anycastAuthority"],
    setAnycastAuthority: (value) => { ep["anycastAuthority"] = value; },
    takeServeSub: () => ep["takeServeSub"],
    setTakeServeSub: (value) => { ep["takeServeSub"] = value; },
    anycastSweep: () => ep["anycastSweep"],
    setAnycastSweep: (value) => { ep["anycastSweep"] = value; },
    takesInFlight: () => ep["takesInFlight"],
    setTakesInFlight: (value) => { ep["takesInFlight"] = value; },
    emitRecoverable: (err) => ep["emitRecoverable"](err),
    plane3MayAct: () => ep["plane3MayAct"](),
    notLiveMsg: () => ep["notLiveMsg"](),
    ref: () => ep["ref"](),
    requestBoundReply: (nc, subject, body, reply, timeoutMs) => ep["requestBoundReply"](nc, subject, body, reply, timeoutMs),
    readTaskEpoch: () => ep["readTaskEpoch"](),
    requestDelivery: (op, args, timeoutMs) => ep["requestDelivery"](op, args, timeoutMs),
  };
}
