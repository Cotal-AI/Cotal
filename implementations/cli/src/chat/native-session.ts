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
import type { RefusalCode } from "@cotal-ai/workspace";
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

const refusedUsage = (message: string) => ({ outcome: "refused" as const, code: "USAGE_INVALID" as const, message });

/**
 * Refuse a channel outside the session's read or post grant before any effect, so the broker's
 * refusal and its subject never reach the caller. A session opened on no channel holds no grant,
 * and the refusal says how to open one that does. The broker remains the enforcement point.
 */
export function grantRefusal(grant: readonly string[], channel: string, use: "read" | "post"): Refused | undefined {
  if (channelInAllow([...grant], channel)) return undefined;
  const message = grant.length === 0
    ? `this session was opened on no channel, so it cannot ${use === "read" ? "read" : "post to"} #${channel}. Leave and run cotal chat ${channel} to open a session on it`
    : `#${channel} is outside this session's ${use} grant`;
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
  selfPrincipal: string,
): { readonly id: string; readonly name: string } | Refused {
  if (typeof to !== "string" || parsePrincipalKey(to)) {
    const principal = typeof to === "string" ? to : to.principal;
    if (!parsePrincipalKey(principal)) return refusedUsage(`"${principal}" is not a principal <owner>.<actor>`);
    if (principal === selfPrincipal) return refusedUsage("a direct message needs a principal other than this session");
    return { id: principal, name: roster.find((p) => p.card.id === principal)?.card.name ?? engine.senderName(principal) ?? principal };
  }
  const peers = roster.filter((p) => p.card.id !== selfPrincipal);
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
  if (named.size > 1)
    return { outcome: "refused", code: "TARGET_AMBIGUOUS", message: `"${to}" names more than one principal (${[...named.keys()].join(", ")}); use the full principal` };
  const only = [...named.values()][0];
  if (only) return only;
  if (rosterState !== "current") return { outcome: "refused", code: "TARGET_UNAVAILABLE", message: `cannot verify "${to}": the roster is ${rosterState}` };
  return { outcome: "refused", code: "TARGET_NOT_FOUND", message: `no peer "${to}" in this space` };
}

/** Inputs the admission adapter supplies with the endpoint whose start it owns. */
export interface NativeSessionInputs {
  readonly endpoint: CotalEndpoint;
  readonly identity: SessionIdentity;
  /** The admission adapter's own retirement call. This module only invokes it. */
  readonly retire: () => Promise<CloseReport>;
}

export class NativeChatSession implements AdmittedChatSession {
  private readonly engine: ParticipantEngine;
  private readonly listeners = new Set<(e: SessionEvent) => void>();
  private state: ConnectionState = "connected";
  private attention: "open" | "dnd" | "focus" = "open";
  private closed: Promise<CloseReport> | undefined;
  private readonly onMessage = (m: CotalMessage, d: Delivery, meta?: MessageMeta) => this.ingest(m, d, meta);
  private readonly onConnection = (s: { connected: boolean }) => this.setState(s.connected ? "connected" : "disconnected");
  private readonly onPresence = (ev: { type: "join" | "update" | "offline"; presence: Presence }) =>
    this.emit({ type: "presence", row: rowOf(ev.presence), change: ev.type === "join" ? "joined" : ev.type === "offline" ? "left" : "updated" });
  private readonly onError = () => { /* surfaced through call results; never thrown at the UI */ };

  constructor(private readonly inputs: NativeSessionInputs) {
    this.engine = new ParticipantEngine(inputs.identity.principal);
    const ep = inputs.endpoint;
    ep.on("message", this.onMessage);
    ep.on("connection", this.onConnection);
    ep.on("presence", this.onPresence);
    ep.on("error", this.onError);
  }

  identity(): SessionIdentity {
    return this.inputs.identity;
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- receive ---------------------------------------------------------------------------------

  private ingest(m: CotalMessage, d: Delivery, meta?: MessageMeta): void {
    if (this.closed) return; // unacked: a durable copy redelivers to nobody once retired
    const self = this.inputs.identity.label.toLowerCase();
    // Advisory only: the payload `mentions` list is forgeable; it changes visibility, never authority.
    const mentionsMe = (m.mentions ?? []).some((x) => x.toLowerCase() === self);
    const disp = this.engine.accept(m, d, meta, mentionsMe);
    if (disp.kind === "surface") this.emit({ type: "message", message: disp.message });
    const over = this.engine.takeOverflow();
    if (over.channelDropped || over.directedDeferred)
      this.emit({ type: "gap", scope: "inbox", reason: `buffer full: ${over.channelDropped} channel message(s) dropped, ${over.directedDeferred} direct message(s) left for broker redelivery` });
  }

  surfaced(keys: readonly string[]): void {
    this.engine.surfaced(keys);
  }

  // ---- publish ---------------------------------------------------------------------------------

  async send(text: string, channel: string, mentions: readonly string[]): Promise<PublishResult> {
    if (!isConcreteChannel(channel)) return refusedUsage("a send needs a concrete channel");
    const outside = grantRefusal(this.inputs.identity.allowPublish, channel, "post");
    if (outside) return outside;
    let registered: boolean;
    try {
      registered = this.inputs.endpoint.getChannelConfig(channel) !== undefined;
      const msg = await this.inputs.endpoint.multicast(text, { channel, ...(mentions.length ? { mentions: [...mentions] } : {}) });
      // Native multicast awaits the stream ack but does not return it (endpoint.ts:4231-4236): no seq.
      return { outcome: "stored", messageId: msg.id, channel, registered };
    } catch (e) {
      return classify(e);
    }
  }

  async dm(to: DmTarget, text: string, replyTo?: string): Promise<PublishResult> {
    const ep = this.inputs.endpoint;
    const recipient = resolveDmTarget(to, ep.getRoster(), ep.presenceView().state, this.engine, this.inputs.identity.principal);
    if ("outcome" in recipient) return recipient;
    const recipientStatusAtSend: PresenceStatus | "unrostered" = ep.getRoster().find((p) => p.card.id === recipient.id)?.status ?? "unrostered";
    try {
      const { msg, ack } = await ep.unicastAttributed(recipient.id, text, replyTo !== undefined ? { replyTo } : {});
      return { outcome: "stored", messageId: msg.id, seq: ack.seq, duplicate: ack.duplicate, recipient, recipientStatusAtSend };
    } catch (e) {
      return classify(e);
    }
  }

  async anycast(role: string, text: string): Promise<PublishResult> {
    try {
      const { msg, ack } = await this.inputs.endpoint.anycastAttributed(role, text);
      return { outcome: "stored", messageId: msg.id, seq: ack.seq, duplicate: ack.duplicate };
    } catch (e) {
      return classify(e);
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
    return this.call(async () => {
      if (activity !== undefined) await this.inputs.endpoint.setActivity(activity);
      await this.inputs.endpoint.setStatus(status);
    });
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
    const outside = grantRefusal(this.inputs.identity.allowSubscribe, channel, "read");
    if (outside) return outside;
    // Local first, as for attention; the presence mirror is advisory (endpoint.ts:2874-2877).
    this.engine.setChannelMode(channel, mode);
    return this.call(() => this.inputs.endpoint.setChannelModes(this.engine.channelModes()));
  }

  async join(channel: string): Promise<Result<{ joined: boolean; backfilled: number; durable: boolean; reason?: string }>> {
    const outside = grantRefusal(this.inputs.identity.allowSubscribe, channel, "read");
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
    return {
      outcome: "ok",
      value: {
        state: this.state,
        identity: this.inputs.identity,
        bufferedInbox: this.engine.bufferedCount(),
        joinedChannels: ep.joinedChannels(),
        attention: this.attention,
        channelModes: this.engine.channelModes(),
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
      const page = await this.inputs.endpoint.readHistory(channel, { limit });
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
      ep.off("presence", this.onPresence);
      this.engine.clear();
      let stopped = true;
      try { await ep.stop(); } catch { stopped = false; }
      let report: CloseReport;
      try { report = await this.inputs.retire(); }
      catch (e) { report = { retirement: "unknown", connectionClosed: "not-confirmed", message: (e as Error).message }; }
      ep.off("error", this.onError);
      this.setState("ended");
      // Our own close is observed; a broker-side eviction is the retire report's claim to make.
      return stopped ? report : { ...report, connectionClosed: "not-confirmed" };
    })();
    return this.closed;
  }

  private setState(s: ConnectionState): void {
    if (this.state === s || this.state === "ended") return;
    this.state = s;
    this.emit({ type: "connection", state: s });
  }

  private emit(e: SessionEvent): void {
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
