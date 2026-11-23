/** A mesh agent's outgoing messages: channel sends and their receipt, role anycasts and their
 *  status and cancel, DMs with peer resolution, and the reply correlation that stamps each one and
 *  remembers who asked what. The mesh agent keeps one forwarder per public member. */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  isConcreteChannel,
  parsePeerAddress,
  parsePrincipalKey,
  PeerAddressError,
  type AnycastStatus,
  assertValidRole,
  type Presence,
  type ResolvedPeerAddress,
  type CotalMessage,
} from "@cotal-ai/core";
import { attributionSafe } from "./framing.js";
import type { InboxItem } from "./agent-inbox.js";
import type { Correlation, MeshAgent } from "./agent.js";

/** How many unanswered directed messages, asked questions, and DM or anycast senders one session
 *  remembers for reply correlation. */
const MAX_CORRELATIONS = 1024;
const directedKey = (sender: string, id: string): string => JSON.stringify([sender, id]);
/** How many present names a DM miss lists before it starts counting them instead. */
const NAMED_SIMILAR = 5;

/** Why a roster whose read failed cannot support an absence verdict. */
export function presenceReadCondition(failure: Error): string {
  return `the presence read failed (${failure.message})`;
}

/** Names already known that differ from `channel` by one insertion, deletion, or substitution. */
export function closeChannelNames(channel: string, known: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of known) {
    if (name !== channel && editDistanceAtMostOne(channel, name)) out.push(name);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out.slice(0, 3);
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  const da = a.length - b.length;
  if (da > 1 || da < -1) return false;
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return true;
}

/** What {@link AgentMessaging} reads from the MeshAgent. Every entry is read at use, so a field the handler
 *  assigns after construction is always current, and a handler method a suite replaces is the one that runs. */
export interface AgentMessagingDeps {
  config: () => MeshAgent["config"];
  ep: () => MeshAgent["ep"];
  id: () => MeshAgent["id"];
  readRoster: (...args: Parameters<MeshAgent["readRoster"]>) => ReturnType<MeshAgent["readRoster"]>;
  requireConnected: (...args: Parameters<MeshAgent["requireConnected"]>) => ReturnType<MeshAgent["requireConnected"]>;
  roleHolders: (...args: Parameters<MeshAgent["roleHolders"]>) => ReturnType<MeshAgent["roleHolders"]>;
  warn: (error: Error) => void;
  unanswered: () => MeshAgent["unanswered"];
}

/** The messaging members of a mesh agent, over the agent's own inputs. */
export class AgentMessaging {
  constructor(private readonly deps: AgentMessagingDeps) {}

  // The MeshAgent members these bodies read, under their agent names. Each reads through its dep at
  // use, so a field the agent assigns later is current and a method a suite replaces on the agent
  // is the one that runs.
  private get config() { return this.deps.config(); }
  private get ep() { return this.deps.ep(); }
  private get id() { return this.deps.id(); }
  private readRoster(...args: Parameters<MeshAgent["readRoster"]>): ReturnType<MeshAgent["readRoster"]> { return this.deps.readRoster(...args); }
  private requireConnected(...args: Parameters<MeshAgent["requireConnected"]>): ReturnType<MeshAgent["requireConnected"]> { return this.deps.requireConnected(...args); }
  private roleHolders(...args: Parameters<MeshAgent["roleHolders"]>): ReturnType<MeshAgent["roleHolders"]> { return this.deps.roleHolders(...args); }
  private get unanswered() { return this.deps.unanswered(); }
  private _contextId: string | undefined;
  /** The per-call correlation a {@link withCorrelation} scope binds for the sends inside it. */
  private readonly correlation = new AsyncLocalStorage<Correlation>();
  /** By sender id, least recently heard first: the display name of each peer that sent us a DM or
   *  anycast (bounded). The id is the authenticated sender (the broker forge-locks it on the
   *  subject), so a DM back to it is addressed to a real identity even when that sender has no
   *  roster row, as a one-shot `cotal send` never has. See {@link heldSender}. */
  private readonly senders = new Map<string, string>();
  /** By `contextId`, the questions this seat asked inside a {@link withCorrelation} scope, and whom
   *  they went to (bounded). See {@link answersQuestion}. */
  private readonly asked = new Map<string, { peerId?: string; role?: string; request?: { seq: number; id: string } }>();

  /** Correlates outgoing messages to the host agent's current context/window. */
  setContextId(contextId: string | undefined): void {
    const clean = contextId?.trim();
    this._contextId = clean ? clean : undefined;
  }

  /** Run `fn` with a per-call correlation for the sends it makes. A `replyTo` names the message a
   *  DM answers unless the DM names one itself, and `contextId` is then that message's
   *  conversation, copied from the message when the scope omits it. Without a `replyTo`,
   *  `contextId` is the caller's own conversation: a send, a question DM or an anycast carries it
   *  ahead of the agent-wide one from {@link setContextId}, and {@link answersQuestion} recognizes
   *  a DM back that copies it. A connector that serves several host sessions from one seat uses it,
   *  because one agent-wide context id cannot tell two concurrent sessions apart. */
  withCorrelation<T>(correlation: Correlation, fn: () => T): T {
    const contextId = correlation.contextId?.trim() || undefined;
    const replyTo = correlation.replyTo?.trim() || undefined;
    const peerId = correlation.peerId?.trim() || undefined;
    return this.correlation.run({ contextId, replyTo, peerId }, fn);
  }

  /** Whether `item` is a live DM answering a question this seat asked inside a
   *  {@link withCorrelation} scope: it copies that question's `contextId`, and its authenticated
   *  sender is the peer the question went to or the daemon's recorded anycast taker. A
   *  `contextId` is a string any peer can set, so the copy alone proves nothing. */
  async answersQuestion(item: InboxItem): Promise<boolean> {
    if (item.kind !== "dm" || item.historical || !item.contextId) return false;
    const q = this.asked.get(item.contextId);
    if (!q) return false;
    if (q.peerId === item.fromId) return true;
    if (!this.config.userAuth && !this.config.creds) return !!q.role && q.role === item.fromRole;
    if (!q.request || item.replyTo !== q.request.id) return false;
    const status = await this.ep.anycastStatus(q.request.seq, q.request.id);
    return status.state === "taken" && status.taker.id === item.fromId;
  }

  /** The correlation a send carries, and the question it asks (a `contextId` the caller's scope
   *  owns, which {@link recordQuestion} remembers). `answered` is the message a DM answers: a reply
   *  copies its `contextId`, which belongs to the asker, and names it in `replyTo` (SPEC §5). */
  private stamp(answered?: { id: string; contextId?: string }): { stamp: Correlation; own?: string } {
    const c = this.correlation.getStore();
    // A DM's own `replyTo` naming another message wins over the scope's, as in answering().
    if (c?.replyTo && (!answered || answered.id === c.replyTo))
      return { stamp: { replyTo: c.replyTo, contextId: c.contextId ?? answered?.contextId ?? this._contextId } };
    if (answered?.contextId) return { stamp: { replyTo: answered.id, contextId: answered.contextId } };
    // A scope's `contextId` is the caller's own only when the scope names no message it answers.
    const own = c?.replyTo ? undefined : c?.contextId;
    return { stamp: { replyTo: answered?.id, contextId: own ?? this._contextId }, own };
  }

  /** Remember a question this seat asked, so {@link answersQuestion} can recognize its answer. */
  private recordQuestion(contextId: string | undefined, to: { peerId?: string; role?: string; request?: { seq: number; id: string } }): void {
    if (!contextId) return;
    this.asked.delete(contextId);
    this.asked.set(contextId, to);
    if (this.asked.size > MAX_CORRELATIONS) this.asked.delete(this.asked.keys().next().value!);
  }

  /** The unanswered message a DM to `peerId` answers. `replyTo` names it, and must be a message
   *  from that peer that is still waiting for an answer. Otherwise the scope's `replyTo` names it if
   *  it is that peer's, else it is the oldest one from that peer no other DM in flight is answering.
   *  The oldest is taken only while all of that peer's waiting messages, including those a DM in
   *  flight is answering, share one conversation (`contextId`): across several, a guess could put
   *  the answer in the wrong conversation, so the DM is refused with the list to choose from. A
   *  caller with its own `contextId` answers only in the conversation its scope names. */
  private answering(peerId: string, replyTo?: string): { id: string; contextId?: string } | undefined {
    if (replyTo) {
      const e = this.unanswered.get(directedKey(peerId, replyTo));
      if (!e || e.fromId !== peerId)
        throw new Error(`replyTo "${attributionSafe(replyTo)}" is not a message from this peer that is waiting for an answer`);
      return { id: replyTo, contextId: e.contextId };
    }
    const c = this.correlation.getStore();
    if (c?.replyTo) {
      const e = this.unanswered.get(directedKey(peerId, c.replyTo));
      return e && e.fromId === peerId ? { id: c.replyTo, contextId: e.contextId } : undefined;
    }
    if (c?.contextId && c.peerId !== peerId) return undefined;
    // One a DM in flight is answering still waits until that DM is published, so it still counts.
    const waiting = [...this.unanswered].filter(([, e]) => e.fromId === peerId);
    if (new Set(waiting.map(([, e]) => e.contextId)).size > 1) {
      const list = waiting.map(([, e]) => `  • replyTo: ${attributionSafe(e.id)} — "${attributionSafe(e.text ?? "")}"`);
      throw new Error(
        `this peer has messages from more than one conversation waiting for an answer. Re-send with ` +
          `"replyTo" set to the id of the one this answers:\n${list.join("\n")}`,
      );
    }
    const first = waiting.find(([, e]) => !e.pending);
    return first && { id: first[1].id, contextId: first[1].contextId };
  }

  /** Record a DM or role request as a peer's message to us: its sender becomes addressable by principal,
   *  and it waits for an answer unless it answers our own question. */
  noteDirected(item: InboxItem): void {
    if (item.kind !== "dm" && item.kind !== "anycast") return;
    this.senders.delete(item.fromId);
    this.senders.set(item.fromId, item.fromName);
    if (this.senders.size > MAX_CORRELATIONS) this.senders.delete(this.senders.keys().next().value!);
    if (!item.historical && item.id !== "") {
      // A DM back to this peer answers it (see dm()). An answer to our own question needs none.
      const key = directedKey(item.fromId, item.id);
      const entry = { id: item.id, fromId: item.fromId, contextId: item.contextId, text: item.text.slice(0, 80) };
      this.unanswered.set(key, entry);
      if (this.unanswered.size > MAX_CORRELATIONS) this.unanswered.delete(this.unanswered.keys().next().value!);
      void this.answersQuestion(item).then((matches) => {
        if (matches && this.unanswered.get(key) === entry) this.unanswered.delete(key);
      }, (error: unknown) => {
        this.deps.warn(new Error(`Could not verify the recorded anycast taker: ${String(error)}`, { cause: error }));
      });
    }
  }

  // ---- sending -------------------------------------------------------------

  async send(text: string, channel?: string, mentions?: string[]): Promise<CotalMessage> {
    try {
      await this.requireConnected();
    } catch (error) {
      throw new Error(`${(error as Error).message}. The message was not sent.`, { cause: error });
    }
    return this.ep.postChannel(text, { channel, mentions, legacyValidation: "names", ...this.stamp().stamp });
  }

  /**
   * What a caller can TELL about a send target BEFORE the publish: whether the name
   * already existed (joined, registry, or prior traffic) and close matches when it
   * did not. Does not refuse create. Graded before multicast so the new message cannot
   * make the name look pre-existing.
   *
   * #7401: only a channel list that was read supports calling the name new, as with mentions
   * (#1229). When the read fails, `unchecked` carries its error and the name is neither known
   * nor new; joined and registered names still count as known and still feed the hints.
   */
  async describeSendChannel(channel: string): Promise<{ known: boolean; hints: string[]; unchecked?: string }> {
    if (this.ep.getChannelConfig(channel)) return { known: true, hints: [] };
    const known = new Set<string>(this.ep.joinedChannels().filter(isConcreteChannel));
    let unchecked: string | undefined;
    try {
      for (const row of await this.ep.listChannels()) known.add(row.channel);
    } catch (e) {
      unchecked = (e as Error).message;
    }
    if (known.has(channel)) return { known: true, hints: [] };
    const hints = closeChannelNames(channel, [...known]);
    return unchecked === undefined ? { known: false, hints } : { known: false, hints, unchecked };
  }

  /** A failed roster read cannot establish that a peer is absent. */
  private cannotVerify(subject: string, failure: Error, outcome: string): Error {
    return new Error(
      `cannot verify ${subject} in space "${this.config.space}": ${presenceReadCondition(failure)}, so absence is not a verdict — the peer may be present but unread. ${outcome}`,
      { cause: failure },
    );
  }

  async anycast(
    role: string,
    text: string,
  ): Promise<{
    msg: CotalMessage;
    ack: { seq: number; duplicate: boolean };
    /** Live roster rows holding `role`, ourselves included; absent when the roster read failed,
     *  since only a read that succeeded can say that no holder exists (#1229). */
    holdersAtSend?: { id: string; name: string }[];
  }> {
    // Refuse the address before recording a question it could never carry, as `dm` resolves its peer first.
    assertValidRole(role);
    await this.requireConnected();
    // Like a DM's recipient status, the only holders we can truthfully name are the roster read
    // right before the publish. Our own task consumer competes for our own request, so we count
    // when we hold the role.
    const holdersAtSend = await this.roleHolders(role);
    const { stamp, own } = this.stamp();
    const { msg, ack } = await this.ep.anycastAttributed(role, text, stamp);
    this.recordQuestion(own, { role, request: { seq: ack.seq, id: msg.id } });
    this.rememberSent(ack.seq, msg.id);
    return { msg, ack, holdersAtSend };
  }

  /** Message ids this session sent as role requests, by the seq the queue gave each. A queue that
   *  was recreated reuses seqs, so one seq can name two of them. */
  private sentRequests = new Map<number, string[]>();

  private rememberSent(seq: number, id: string): void {
    const ids = this.sentRequests.get(seq) ?? [];
    if (!ids.includes(id)) ids.push(id);
    this.sentRequests.delete(seq);
    this.sentRequests.set(seq, ids);
    if (this.sentRequests.size > MAX_CORRELATIONS) this.sentRequests.delete(this.sentRequests.keys().next().value!);
  }

  /** The message id to name a request by. Undefined when this session did not send that seq (the
   *  daemon still checks the sender); refused when it sent two requests under one seq. */
  private sentRequestId(seq: number): string | undefined {
    const ids = this.sentRequests.get(seq);
    if (ids && ids.length > 1)
      throw new Error(`seq ${seq} names ${ids.length} requests this session sent (the role queue was recreated between them), so it is ambiguous; nothing was asked or cancelled`);
    return ids?.[0];
  }

  /** The status of one of this session's own role requests, from the delivery daemon (SPEC §8.1). */
  async anycastStatus(seq: number): Promise<AnycastStatus> {
    await this.requireConnected();
    return this.ep.anycastStatus(seq, this.sentRequestId(seq));
  }

  /** Cancel one of this session's own role requests while it waits. A taken one is refused, and
   *  the status returned names its taker. */
  async cancelAnycast(seq: number): Promise<AnycastStatus> {
    await this.requireConnected();
    return this.ep.cancelAnycast(seq, this.sentRequestId(seq));
  }

  /** Resolve an address against the last roster with this session's authenticated principal. */
  resolvePeer(target: string): Promise<ResolvedPeerAddress | undefined> {
    return this.ep.resolvePeerAddress(target, { selfId: this.id });
  }

  /** Exact principal of a sender the session received a message from. */
  private heldSender(target: string): { id: string; name: string } | undefined {
    if (target === this.id) return undefined;
    const name = this.senders.get(target);
    return name === undefined ? undefined : { id: target, name };
  }

  /** Why a DM target resolved to no one, under a roster read that succeeded. A target that names this
   *  session says so, since the roster leaves it out of DM resolution. Present names that start with
   *  the target are listed for the caller to choose from; none of them is ever picked. */
  private noPeer(target: string): string {
    const want = target.trim().toLowerCase();
    const own = this.ep.principal;
    if (target === this.id || (this.config.userAuth ? target.trim() === own.actor : want === this.ep.card.name.toLowerCase()))
      return `"${target}" is this session: a DM goes to another peer, so nothing was sent. cotal_roster lists who is present.`;
    const missing = `no peer "${target}" in space "${this.config.space}"`;
    if (!want) return missing;
    const names = [...new Set(this.ep.getRoster().flatMap((p) => {
      if (p.card.id === this.id) return [];
      if (!this.config.userAuth) return p.card.name.toLowerCase().startsWith(want) ? [p.card.name] : [];
      const key = parsePrincipalKey(p.card.id);
      return key?.owner === own.owner && key.actor.startsWith(target.trim()) ? [key.actor] : [];
    }))];
    if (!names.length) return missing;
    const shown = names.slice(0, NAMED_SIMILAR).map((n) => JSON.stringify(n)).join(", ");
    const more = names.length > NAMED_SIMILAR ? ` and ${names.length - NAMED_SIMILAR} more` : "";
    return `${missing}. A name must match in full, so nothing was sent. Present names that start with it: ${shown}${more}. DM one by its full name or instance id.`;
  }

  async dm(
    target: string,
    text: string,
    opts: { replyTo?: string } = {},
  ): Promise<{
    msg: CotalMessage;
    /** The roster row the target resolved to, if any. */
    peer?: Presence;
    recipient: { id: string; name: string };
    ack: { seq: number; duplicate: boolean };
    /** `unrostered` is a known sender with no roster row. `unobserved` is a routing-only principal. */
    recipientStatusAtSend: Presence["status"] | "unrostered" | "unobserved";
  }> {
    const address = parsePeerAddress(target);
    await this.requireConnected();
    const { roster, failure } = address.kind === "qualified" ? { roster: [], failure: undefined } : await this.readRoster();
    const peer = await this.ep.resolvePeerAddress(target, { roster, selfId: this.id });
    const literal = address.kind === "principal" && address.value !== this.id ? address.value : undefined;
    const known = !peer && literal ? this.heldSender(literal) : undefined;
    const recipient = peer ? { id: peer.card.id, name: peer.card.name } : known ?? (literal ? { id: literal, name: literal } : undefined);
    if (!recipient) {
      if (address.kind === "principal") throw new PeerAddressError(target, "USAGE_INVALID", this.noPeer(address.value));
      if (!failure) throw new PeerAddressError(target, "TARGET_NOT_FOUND", this.noPeer(target));
      const error = this.cannotVerify(`peer "${target}"`, failure, "The DM was not sent.");
      throw new PeerAddressError(target, "TARGET_UNAVAILABLE", error.message, [], { cause: failure });
    }
    // The only status we can truthfully attribute is the roster snapshot taken right before the
    // publish: recipient state can change the instant after, and the ack never tells us either way.
    const recipientStatusAtSend = peer?.status ?? (known ? "unrostered" : "unobserved");
    // A DM back to a peer answers the message `replyTo` names, or the oldest one it sent us that no
    // DM has answered yet (see answering()). It counts as answered only once the DM is published,
    // so a failed send leaves it to the retry.
    const answered = this.answering(recipient.id, opts.replyTo?.trim() || undefined);
    const key = answered && directedKey(recipient.id, answered.id);
    const entry = key && this.unanswered.get(key);
    const { stamp, own } = this.stamp(answered);
    this.recordQuestion(own, { peerId: recipient.id });
    if (entry) entry.pending = true;
    try {
      const { msg, ack } = await this.ep.unicastAttributed(recipient.id, text, stamp);
      if (key) this.unanswered.delete(key);
      return { msg, peer: peer && !("routingOnly" in peer) ? peer : undefined, recipient, ack, recipientStatusAtSend };
    } finally {
      if (entry) entry.pending = false;
    }
  }
}
