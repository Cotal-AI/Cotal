/**
 * The native engine adapter: implements {@link AdmittedChatSession} over ONE real `CotalEndpoint`
 * that a reviewed admission adapter constructed under the session's own identity. The adapter owns
 * start; listeners may be installed before it starts. This module never constructs, admits, mints or starts an endpoint, and never reads a
 * credential. No connector-core. The three client behaviours core lacks live in `engine.ts`.
 *
 * Classification rules (native error -> session outcome):
 *   - `isPublishPermissionDenied` (broker publish refusal)          -> refused PERMISSION_DENIED
 *   - `EpEnvelopeError` with `outcome: "not-executed"` or a
 *     pre-effect code (bad-request, permission-denied, …)          -> refused, native code kept
 *   - `EpEnvelopeError` with `outcome: "unknown"`, timeouts, and
 *     anything else thrown after a publish or request was issued   -> unknown (never retried)
 *   - local validation thrown before any I/O                       -> refused USAGE_INVALID
 *   - a send, join or channel mode outside the session's grant     -> refused PERMISSION_DENIED,
 *     before any I/O ({@link grantRefusal})
 * A denial is never turned into an empty `ok`.
 */
import {
  EpEnvelopeError,
  channelInAllow,
  isConcreteChannel,
  isConsumerNotFound,
  isPublishPermissionDenied,
  parsePrincipalKey,
  partsToText,
  resolvePeer,
  type CotalEndpoint,
  type CotalMessage,
  type Delivery,
  type MessageMeta,
  type Presence,
  type PresenceStatus,
  type PresenceView,
} from "@cotal-ai/core";
import type { RefusalCode } from "../output.js";
import { spaceStreamsAbsent, spaceStreamsExpected } from "../space-streams.js";
import { mentionsName } from "./compose.js";
import { ParticipantEngine } from "./engine.js";
import type {
  AdmittedChatSession,
  ChannelInfo,
  CloseReport,
  ConnectionReport,
  ConnectionState,
  DmTarget,
  HistoryPage,
  PublishResult,
  Refused,
  Result,
  RosterRow,
  RosterView,
  SessionEvent,
  SessionIdentity,
  SessionMessage,
} from "./session.js";
import type { ChatWords } from "./words.js";

/** Native codes that mean "refused before any effect". Anything else from a call is unknown. */
const PRE_EFFECT: Readonly<Record<string, RefusalCode>> = {
  "bad-request": "USAGE_INVALID",
  "unsupported-version": "UNSUPPORTED",
  "unauthenticated": "AUTH_REQUIRED",
  "permission-denied": "PERMISSION_DENIED",
  "not-found": "TARGET_NOT_FOUND",
  "failed-precondition": "LIFECYCLE_BLOCKED",
  "unimplemented": "UNSUPPORTED",
  "unavailable": "TARGET_UNAVAILABLE",
  "conflict": "CONFLICT",
};

function classify(e: unknown): { outcome: "refused"; code: RefusalCode; message: string; native?: { code?: string; detail?: unknown } } | { outcome: "unknown"; message: string } {
  const message = e instanceof Error ? e.message : String(e);
  if (isPublishPermissionDenied(e)) return { outcome: "refused", code: "PERMISSION_DENIED", message, native: { code: "publish-permission-denied" } };
  if (e instanceof EpEnvelopeError) {
    const code = PRE_EFFECT[e.code];
    if (code && e.outcome !== "unknown" && e.outcome !== "executed") return { outcome: "refused", code, message, native: { code: e.code, detail: e.details } };
  }
  return { outcome: "unknown", message };
}

/** Whether the chat stream of a space whose streams were created here is present. `undefined` when
 *  this space is not one of those, or the read failed: neither is evidence that the stream is gone. */
async function chatStreamPresent(endpoint: CotalEndpoint, space: string, mode: "open" | "static" | "user"): Promise<boolean | undefined> {
  if (!spaceStreamsExpected(space, mode === "static" ? "auth" : mode)) return undefined;
  try { return (await endpoint.chatRetention()).stream; } catch { return undefined; }
}

/** Refuse before publishing when the space's chat stream is known to be absent. A later absence
 *  cannot establish whether an earlier unacknowledged publish was stored. */
async function absentStreams(endpoint: CotalEndpoint, space: string, mode: "open" | "static" | "user"): Promise<Refused | undefined> {
  if (await chatStreamPresent(endpoint, space, mode) !== false) return undefined;
  const failure = spaceStreamsAbsent(space, undefined);
  return { outcome: "refused", code: "TARGET_UNAVAILABLE", message: failure.message };
}

const refusedUsage = (message: string) => ({ outcome: "refused" as const, code: "USAGE_INVALID" as const, message });

/** How long a full inbox's drops wait for more before one gap reports them all, so a replay past the
 *  bound or a burst of traffic is one gap with its total. */
const GAP_COALESCE_MS = 1_000;

/**
 * Refuse a channel outside the session's read or post grant before any effect, so the broker's
 * refusal and its subject never reach the caller. A session opened on no channel holds no grant.
 * Either refusal ends with the front end's way to open a session that holds the channel. The broker
 * remains the enforcement point.
 */
export function grantRefusal(grant: readonly string[], channel: string, use: "read" | "post", words: ChatWords): Refused | undefined {
  if (channelInAllow([...grant], channel)) return undefined;
  const message = grant.length === 0
    ? `this session was opened on no channel, so it cannot ${use === "read" ? "read" : "post to"} #${channel}. ${words.reopen(channel)}`
    : `#${channel} is outside this session's ${use} grant. ${words.reopen(channel)}`;
  return { outcome: "refused", code: "PERMISSION_DENIED", message };
}

/**
 * Resolve a DM target before any effect. A `{ principal }` target, or a typed string that parses as
 * a principal `<owner>.<actor>`, goes to that principal as is, whether or not it is present or was
 * heard from. It is never matched against display names, so a peer whose display name spells a
 * principal cannot capture it; that peer is reached by its own principal or `/reply`. Any other
 * string is a display name, which must name one principal across the roster and the heard senders:
 * a name both carry refuses and lists them instead of picking the present one. Absence is a verdict
 * only on a current roster (endpoint.ts:2816-2823).
 */
export function resolveDmTarget(
  to: DmTarget,
  roster: readonly Presence[],
  rosterState: PresenceView["state"],
  engine: ParticipantEngine,
  self: { readonly principal: string; readonly name?: string; readonly answerOne: string },
): { readonly id: string; readonly name: string } | Refused {
  if (typeof to !== "string" || parsePrincipalKey(to)) {
    const principal = typeof to === "string" ? to : to.principal;
    if (!parsePrincipalKey(principal)) return refusedUsage(`"${principal}" is not a principal <owner>.<actor>`);
    if (principal === self.principal) return refusedUsage("a direct message needs a principal other than this session");
    return { id: principal, name: roster.find((p) => p.card.id === principal)?.card.name ?? engine.senderName(principal) ?? principal };
  }
  const peers = roster.filter((p) => p.card.id !== self.principal);
  let peer: Presence | undefined;
  try {
    peer = resolvePeer(peers, to);
  } catch (e) {
    // core resolvePeer throws AmbiguousPeerError or a roster-label refusal: both are pre-effect.
    return { outcome: "refused", code: "TARGET_AMBIGUOUS", message: (e as Error).message };
  }
  const named = new Map<string, { id: string; name: string }>();
  if (peer) named.set(peer.card.id, { id: peer.card.id, name: peer.card.name });
  for (const sender of engine.sendersNamed(to)) if (!named.has(sender.id)) named.set(sender.id, sender);
  if (named.size > 1) {
    const ids = [...named.keys()];
    // Each one-shot `cotal send` signs with its own principal and exits once it has sent, so a
    // reply by its name can reach none of them.
    const present = new Set(roster.filter((p) => p.status !== "offline").map((p) => p.card.id));
    if (rosterState === "current" && !ids.some((id) => present.has(id)))
      return { outcome: "refused", code: "TARGET_AMBIGUOUS", message: `"${to}" names ${ids.length} senders that are no longer present (${ids.join(", ")}), such as one-shot senders, which exit once they have sent; ${self.answerOne}` };
    return { outcome: "refused", code: "TARGET_AMBIGUOUS", message: `"${to}" names more than one principal (${ids.join(", ")}); use the full principal` };
  }
  const only = [...named.values()][0];
  if (only) return only;
  if (self.name !== undefined && to.trim().toLowerCase() === self.name.trim().toLowerCase())
    return refusedUsage(`"${to}" is this session's own name; a direct message needs another participant`);
  if (rosterState !== "current") return { outcome: "refused", code: "TARGET_UNAVAILABLE", message: `cannot verify "${to}": the roster is ${rosterState}` };
  return { outcome: "refused", code: "TARGET_NOT_FOUND", message: `no peer "${to}" in this space` };
}

/** Inputs the admission adapter supplies with the endpoint whose start it owns. */
export interface NativeSessionInputs {
  readonly endpoint: CotalEndpoint;
  readonly identity: SessionIdentity;
  /** The admission adapter's own retirement call. This module only invokes it. */
  readonly retire: () => Promise<CloseReport>;
  /** The front end's clauses that end this session's refusals. */
  readonly words: ChatWords;
}

export class NativeChatSession implements AdmittedChatSession {
  private readonly engine: ParticipantEngine;
  private readonly listeners = new Set<(e: SessionEvent) => void>();
  /** What the session emitted before its first subscriber, such as the presence the endpoint's start
   *  reports, this session's own row included. The first subscriber gets it, so nothing is lost. */
  private early: SessionEvent[] | undefined = [];
  private state: ConnectionState = "connected";
  private bound = true;
  private transportConnected = true;
  private attention: "open" | "dnd" | "focus" = "open";
  private closed: Promise<CloseReport> | undefined;
  /** Why the session ended itself, when it could not continue. */
  private lost: string | undefined;
  /** Last observed absence of the chat stream, rechecked by a later connection report. */
  private streamsGone: string | undefined;
  /** What the full inbox let go that no gap has reported yet. */
  private overflow = { channelDropped: 0, directedDeferred: 0 };
  private overflowTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly onMessage = (m: CotalMessage, d: Delivery, meta?: MessageMeta) => this.ingest(m, d, meta);
  private readonly onConnection = (s: { connected: boolean }) => {
    this.bound = s.connected;
    this.updateConnection();
  };
  private readonly onTransport = (s: { connected: boolean }) => {
    this.transportConnected = s.connected;
    this.updateConnection();
  };
  /** The last row each roster member's presence event carried, as JSON. */
  private readonly rows = new Map<string, string>();
  /** A presence update the row cannot show, such as a change of attention or a channel mode, leaves the
   *  row as it was, so it is not reported as an update. */
  private readonly onPresence = (ev: { type: "join" | "update" | "offline"; presence: Presence }) => {
    const row = rowOf(ev.presence), shown = JSON.stringify(row);
    if (ev.type === "update" && this.rows.get(row.id) === shown) return;
    if (ev.type === "offline") this.rows.delete(row.id);
    else this.rows.set(row.id, shown);
    this.emit({ type: "presence", row, change: ev.type === "join" ? "joined" : ev.type === "offline" ? "left" : "updated" });
  };
  private readonly onError = () => { /* surfaced through call results; never thrown at the UI */ };
  /** The session's own DM inbox is gone, so a later send is stored for a recipient that will
   *  never be told. A reconnect that finds the durable gone cannot succeed by retrying: the session
   *  was retired while the broker was away, as a stack restart retires the sessions its old manager
   *  admitted. The same loss while the connection stays up, as a manager restart retires the slot
   *  and deletes the inbox without dropping the broker, is the endpoint's "DM inbox missing"
   *  warning. Either way the session ends with the reason instead of staying connected and silent. */
  private readonly onWarning = (e: Error) => {
    if (this.closed) return;
    const reconnectingGone = this.state !== "connected" && isConsumerNotFound(e);
    const stillConnectedGone = this.state === "connected" && e.message.startsWith("DM inbox missing:");
    if (!reconnectingGone && !stillConnectedGone) return;
    this.lost = reconnectingGone
      ? "this session can no longer reconnect: its inbox is gone from the broker, because the space restarted or retired the session while the connection was down; open a new session"
      : "this session can no longer receive direct messages: its inbox is gone from the broker, because the manager restarted and retired the session; open a new session";
    void this.close();
  };

  constructor(private readonly inputs: NativeSessionInputs) {
    this.engine = new ParticipantEngine(inputs.identity.principal);
    const ep = inputs.endpoint;
    ep.on("message", this.onMessage);
    ep.on("connection", this.onConnection);
    ep.on("transport", this.onTransport);
    ep.on("presence", this.onPresence);
    ep.on("error", this.onError);
    ep.on("warning", this.onWarning);
  }

  identity(): SessionIdentity {
    return this.inputs.identity;
  }

  /** This session as {@link resolveDmTarget} reads it. */
  private self(): { readonly principal: string; readonly name: string; readonly answerOne: string } {
    return { principal: this.inputs.identity.principal, name: this.inputs.identity.label, answerOne: this.inputs.words.answerOne };
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    // Drops so far, such as a replay's past the inbox bound, are reported with the early events.
    this.reportOverflow();
    const early = this.early ?? [];
    this.early = undefined;
    for (const e of early) {
      try { listener(e); } catch { /* a listener fault never breaks delivery */ }
    }
    // A front end unsubscribes before it closes the session, so it hears the drops first.
    return () => {
      this.reportOverflow();
      this.listeners.delete(listener);
    };
  }

  // ---- receive ---------------------------------------------------------------------------------

  private ingest(m: CotalMessage, d: Delivery, meta?: MessageMeta): void {
    if (this.closed) return; // unacked: a durable copy redelivers to nobody once retired
    const mentionsMe = mentionsName(m.mentions, this.inputs.identity.label);
    const disp = this.engine.accept(m, d, meta, mentionsMe);
    if (disp.kind === "surface") this.emit({ type: "message", message: disp.message });
    const over = this.engine.takeOverflow();
    if (!over.channelDropped && !over.directedDeferred) return;
    this.overflow = {
      channelDropped: this.overflow.channelDropped + over.channelDropped,
      directedDeferred: this.overflow.directedDeferred + over.directedDeferred,
    };
    this.overflowTimer ??= setTimeout(() => this.reportOverflow(), GAP_COALESCE_MS);
    this.overflowTimer.unref?.();
  }

  /** One gap for every drop since the last one, naming only the kinds that happened. */
  private reportOverflow(): void {
    clearTimeout(this.overflowTimer);
    this.overflowTimer = undefined;
    const { channelDropped, directedDeferred } = this.overflow;
    if (!channelDropped && !directedDeferred) return;
    this.overflow = { channelDropped: 0, directedDeferred: 0 };
    const parts = [
      ...(channelDropped ? [`${channelDropped} channel message(s) dropped`] : []),
      ...(directedDeferred ? [`${directedDeferred} direct message(s) left for broker redelivery`] : []),
    ];
    this.emit({ type: "gap", scope: "inbox", reason: `buffer full: ${parts.join(", ")}` });
  }

  surfaced(keys: readonly string[]): void {
    this.engine.surfaced(keys);
  }

  // ---- publish ---------------------------------------------------------------------------------

  async send(text: string, channel: string, mentions: readonly string[], replyTo?: string): Promise<PublishResult> {
    if (!isConcreteChannel(channel)) return refusedUsage("a send needs a concrete channel");
    const outside = grantRefusal(this.inputs.identity.allowPublish, channel, "post", this.inputs.words);
    if (outside) return outside;
    const gone = await this.beforePublish();
    if (gone) return gone;
    let registered: boolean;
    try {
      registered = this.inputs.endpoint.getChannelConfig(channel) !== undefined;
      const msg = await this.inputs.endpoint.multicast(text, { channel, ...(mentions.length ? { mentions: [...mentions] } : {}), ...(replyTo !== undefined ? { replyTo } : {}) });
      // Native multicast awaits the stream ack but does not return it (endpoint.ts:4231-4236): no seq.
      this.streamsGone = undefined;
      return { outcome: "stored", messageId: msg.id, channel, registered };
    } catch (e) {
      return this.afterPublish(e);
    }
  }

  async resolveDm(to: DmTarget): Promise<Result<{ readonly id: string; readonly name: string }>> {
    const ep = this.inputs.endpoint;
    const recipient = resolveDmTarget(to, ep.getRoster(), ep.presenceView().state, this.engine, this.self());
    return "outcome" in recipient ? recipient : { outcome: "ok", value: recipient };
  }

  async dm(to: DmTarget, text: string, replyTo?: string): Promise<PublishResult> {
    const ep = this.inputs.endpoint;
    const recipient = resolveDmTarget(to, ep.getRoster(), ep.presenceView().state, this.engine, this.self());
    if ("outcome" in recipient) return recipient;
    const gone = await this.beforePublish();
    if (gone) return gone;
    const recipientStatusAtSend: PresenceStatus | "unrostered" = ep.getRoster().find((p) => p.card.id === recipient.id)?.status ?? "unrostered";
    try {
      const { msg, ack } = await ep.unicastAttributed(recipient.id, text, replyTo !== undefined ? { replyTo } : {});
      this.streamsGone = undefined;
      return { outcome: "stored", messageId: msg.id, seq: ack.seq, duplicate: ack.duplicate, recipient, recipientStatusAtSend };
    } catch (e) {
      return this.afterPublish(e);
    }
  }

  async anycast(role: string, text: string): Promise<PublishResult> {
    const gone = await this.beforePublish();
    if (gone) return gone;
    try {
      const { msg, ack } = await this.inputs.endpoint.anycastAttributed(role, text);
      this.streamsGone = undefined;
      return { outcome: "stored", messageId: msg.id, seq: ack.seq, duplicate: ack.duplicate };
    } catch (e) {
      return this.afterPublish(e);
    }
  }

  // ---- presence and attention -------------------------------------------------------------------

  private async call<T>(fn: () => Promise<T>): Promise<Result<T>> {
    try {
      return { outcome: "ok", value: await fn() };
    } catch (e) {
      return classify(e);
    }
  }

  setStatus(status: "idle" | "working" | "waiting", activity?: string): Promise<Result<void>> {
    return this.call(() => this.inputs.endpoint.setStatus(status, activity));
  }

  setAttention(mode: "open" | "dnd" | "focus"): Promise<Result<void>> {
    // The local buffering decision is the session's own and takes effect immediately; the presence
    // publish is advisory. If the publish fails the mode still applies locally and the result says so.
    this.engine.setAttention(mode);
    this.attention = mode;
    return this.call(() => this.inputs.endpoint.setAttention(mode)); // advisory presence (endpoint.ts:2867-2870)
  }

  async setChannelMode(channel: string, mode: "quiet" | "muted" | "normal"): Promise<Result<void>> {
    if (!isConcreteChannel(channel)) return refusedUsage("a channel mode needs a concrete channel");
    const outside = grantRefusal(this.inputs.identity.allowSubscribe, channel, "read", this.inputs.words);
    if (outside) return outside;
    // Local first, as for attention; the presence mirror is advisory (endpoint.ts:2874-2877).
    this.engine.setChannelMode(channel, mode);
    return this.call(() => this.inputs.endpoint.setChannelModes(this.engine.channelModes()));
  }

  async join(channel: string): Promise<Result<{ joined: boolean; backfilled: number; durable: boolean; reason?: string }>> {
    const outside = grantRefusal(this.inputs.identity.allowSubscribe, channel, "read", this.inputs.words);
    if (outside) return outside;
    return this.call(() => this.inputs.endpoint.joinChannel(channel));
  }

  leave(channel: string): Promise<Result<{ left: boolean }>> {
    return this.call(() => this.inputs.endpoint.leaveChannel(channel));
  }

  // ---- reads -------------------------------------------------------------------------------------

  async inbox(peek: boolean): Promise<Result<readonly SessionMessage[]>> {
    return { outcome: "ok", value: peek ? this.engine.inbox() : this.engine.drain() };
  }

  async roster(): Promise<Result<RosterView>> {
    const ep = this.inputs.endpoint;
    return { outcome: "ok", value: { rows: ep.getRoster().map(rowOf), view: ep.presenceView().state } };
  }

  async channelInfo(channel: string): Promise<Result<ChannelInfo>> {
    const ep = this.inputs.endpoint;
    const cfg = ep.getChannelConfig(channel);
    return {
      outcome: "ok",
      value: {
        channel,
        registered: cfg !== undefined,
        ...(cfg?.description ? { description: cfg.description } : {}),
        ...(cfg?.instructions ? { instructions: cfg.instructions } : {}),
        replay: ep.channelReplay(channel),
        // Local view of the session's accepted ceilings; the broker remains the enforcement point.
        readable: channelInAllow([...this.inputs.identity.allowSubscribe], channel),
        postable: channelInAllow([...this.inputs.identity.allowPublish], channel),
      },
    };
  }

  async connection(): Promise<Result<ConnectionReport>> {
    const ep = this.inputs.endpoint;
    if (this.streamsGone) await this.observeStreams();
    return {
      outcome: "ok",
      value: {
        state: this.streamsGone ? "disconnected" : this.state,
        identity: this.inputs.identity,
        bufferedInbox: this.engine.bufferedCount(),
        joinedChannels: ep.joinedChannels(),
        attention: this.attention,
        channelModes: this.engine.channelModes(),
        ...(this.streamsGone ? { reason: this.streamsGone } : {}),
      },
    };
  }

  async history(channel: string, limit: number): Promise<Result<HistoryPage>> {
    // Native readHistory is MEDIATED by the delivery daemon (endpoint.ts:3651-3660, served at
    // :5153-5210). The daemon authorizes against the durable registry's ACL row for the caller
    // (`aclForAlias`), and that row is written only with durable membership (provision.ts
    // `reissueAcl`, skipped when `durableMembership:false`). A phase-1 live-only session therefore has
    // no row and the daemon refuses with "no read ACL on record ... not permitted". That is reported
    // as a refusal, never as an empty page. A daemon refusal arrives as a plain Error whose text the
    // daemon formats (`readHistory: ... - not permitted` / `... - refused`); other failures are
    // `failed` (a read has no effect to be unknown about).
    try {
      // An open mesh runs no delivery daemon, so an open session reads the channel itself under its
      // own lifecycle, as `cotal history` does.
      const ep = this.inputs.endpoint;
      const page = this.inputs.identity.mode === "open" ? await ep.channelHistoryPage(channel, { limit }) : await ep.readHistory(channel, { limit });
      return {
        outcome: "ok",
        value: {
          channel,
          messages: page.items.map((m, i) => historyRow(m, i)),
          partial: !page.complete,
          ...(page.complete ? {} : { note: "bounded window or retention: not the full conversation" }),
        },
      };
    } catch (e) {
      const c = classify(e);
      if (c.outcome === "refused") return c;
      if (/^readHistory: .*(not permitted|refused)$/.test(c.message))
        return { outcome: "refused", code: "PERMISSION_DENIED", message: c.message, native: { code: "delivery-refused" } };
      return { outcome: "failed", message: c.message };
    }
  }

  async invoke(endpoint: string, command: string, args: Readonly<Record<string, unknown>> | undefined, timeoutMs: number): Promise<Result<unknown>> {
    try {
      const r = await this.inputs.endpoint.invokeService(endpoint, command, args ? { ...args } : undefined, { deadlineMs: timeoutMs });
      if (r.reply.ok) return { outcome: "ok", value: r.reply.data ?? null };
      const err = r.reply.error;
      const pre = err ? PRE_EFFECT[err.code] : undefined;
      if (err && pre && err.outcome !== "unknown" && err.outcome !== "executed")
        return { outcome: "refused", code: pre, message: err.message, native: { code: err.code, detail: err.details } };
      return { outcome: "unknown", message: err?.message ?? "the endpoint answered without a result" };
    } catch (e) {
      return classify(e);
    }
  }

  async reconnect(): Promise<Result<{ reconnected: boolean; message: string }>> {
    return this.call(async () => {
      this.setState("reconnecting");
      // Native reconnect rebuilds the SAME endpoint: same principal, same lifecycle UID, same durables
      // (endpoint.ts:1969-1981). It never mints a new identity; renewal refusal surfaces as a throw.
      await this.inputs.endpoint.reconnect();
      return { reconnected: true, message: "reconnected as the same session" };
    });
  }

  close(): Promise<CloseReport> {
    this.closed ??= (async () => {
      const ep = this.inputs.endpoint;
      ep.off("message", this.onMessage);
      ep.off("connection", this.onConnection);
      ep.off("transport", this.onTransport);
      ep.off("presence", this.onPresence);
      ep.off("warning", this.onWarning);
      this.reportOverflow();
      this.engine.clear();
      let stopped = true;
      try { await ep.stop(); } catch { stopped = false; }
      let report: CloseReport;
      try { report = await this.inputs.retire(); }
      catch (e) { report = { retirement: "unknown", connectionClosed: "not-confirmed", message: (e as Error).message }; }
      ep.off("error", this.onError);
      if (this.lost) report = { ...report, lost: this.lost };
      this.setState("ended", this.lost);
      // Our own close is observed; a broker-side eviction is the retire report's claim to make.
      return stopped ? report : { ...report, connectionClosed: "not-confirmed" };
    })();
    return this.closed;
  }

  private async beforePublish(): Promise<Refused | undefined> {
    const gone = await absentStreams(this.inputs.endpoint, this.inputs.identity.space, this.inputs.identity.mode);
    if (gone) this.streamsGone = gone.message;
    return gone;
  }

  /** Refresh the connection observation without rewriting an attempted publish's outcome. */
  private async afterPublish(e: unknown): Promise<PublishResult> {
    await this.observeStreams();
    return classify(e);
  }

  /** Remember a read that found the chat stream gone, and forget one that found it present. A failed
   *  read leaves the last observation, because it says nothing about the stream. */
  private async observeStreams(): Promise<void> {
    const present = await chatStreamPresent(this.inputs.endpoint, this.inputs.identity.space, this.inputs.identity.mode);
    if (present === true) this.streamsGone = undefined;
    else if (present === false) this.streamsGone = spaceStreamsAbsent(this.inputs.identity.space, undefined).message;
  }

  /** A transient socket drop keeps the binding but loses live traffic. A fresh dial is not ready
   *  until its full bind returns. An explicit reconnect has already reported its outage. */
  private updateConnection(): void {
    if (this.bound && this.transportConnected) this.setState("connected");
    else if (this.state !== "reconnecting") this.setState("disconnected");
  }

  private setState(s: ConnectionState, reason?: string): void {
    if (this.state === s || this.state === "ended") return;
    this.state = s;
    this.emit({ type: "connection", state: s, ...(reason ? { reason } : {}) });
  }

  private emit(e: SessionEvent): void {
    if (this.early) {
      this.early.push(e);
      return;
    }
    for (const l of this.listeners) {
      try { l(e); } catch { /* a listener fault never breaks delivery */ }
    }
  }
}

function rowOf(p: Presence): RosterRow {
  const meta = p.card.meta as Record<string, unknown> | undefined;
  return {
    id: p.card.id,
    name: p.card.name,
    kind: p.card.kind,
    ...(p.card.role ? { role: p.card.role } : {}),
    status: p.status,
    ...(p.activity ? { activity: p.activity } : {}),
    ...(typeof meta?.sessionKind === "string" ? { sessionKind: meta.sessionKind } : {}),
  };
}

function historyRow(m: CotalMessage, i: number): SessionMessage {
  const kind: SessionMessage["kind"] = m.channel !== undefined ? "channel" : m.toService !== undefined ? "anycast" : "dm";
  return {
    deliveryKey: `history-${i}`, // history is read, not delivered: nothing to acknowledge
    id: m.id,
    ts: m.ts,
    kind,
    from: { id: m.from.id, name: m.from.name, ...(m.from.role ? { role: m.from.role } : {}) },
    ...(m.channel !== undefined ? { channel: m.channel } : {}),
    text: partsToText(m.parts),
    ...(m.replyTo !== undefined ? { replyTo: m.replyTo } : {}),
    mentionsMe: false,
    historical: true,
  };
}
