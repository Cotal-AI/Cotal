// The messaging region of CotalEndpoint, as an internal component. Moved verbatim from endpoint.ts;
// the endpoint keeps the public methods and forwards to them. Not re-exported by the index.
import { randomUUID } from "node:crypto";
import { headers, PermissionViolationError, TimeoutError, type NatsConnection } from "@nats-io/transport-node";
import { JetStreamApiCodes, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import { eventPayloadSubject, eventPayloadStream } from "./event-payloads.js";
import { assertIdToken } from "./endpoint-subjects.js";
import { isCasLoss } from "./endpoint-records.js";
import { isJetStreamMissing } from "./jetstream-missing.js";
import {
  anycastSubject,
  assertValidOwnerToken,
  assertValidRole,
  chatStream,
  chatSubject,
  isConcreteChannel,
  normalizeMentions,
  parsePrincipalKey,
  unicastSubject,
} from "./subjects.js";
import type { CotalMessage, EndpointRef, HistoryMessage, Part } from "./types.js";
import type { CotalEndpoint } from "./endpoint.js";

/** What the messaging component reads from its endpoint. State is read when it is used, never
 *  copied, and every method is looked up on the endpoint at call time. */
export interface EndpointMessagingDeps {
  nc: () => NatsConnection | undefined;
  js: () => JetStreamClient | undefined;
  jsm: () => JetStreamManager | undefined;
  space: () => string;
  owner: () => string;
  actor: () => string;
  channels: () => string[];
  notLiveMsg: () => string;
  ref: () => EndpointRef;
  publishMsg: (subject: string, msg: CotalMessage) => Promise<void>;
  streamHistory: (stream: string, subjects: string[], limit: number, before?: number, signal?: AbortSignal) => Promise<{ seq: number; subject: string; msg: HistoryMessage }[]>;
  emitRecoverable: (err: Error) => void;
}

/** The messaging verbs of one endpoint: multicast (plain and serialized), unicast, anycast, and the
 *  event-payload channel. Internal: `CotalEndpoint` keeps the public methods and forwards to it. */
export class EndpointMessaging {
  constructor(private readonly deps: EndpointMessagingDeps) {}

  private get nc() { return this.deps.nc(); }
  private get js() { return this.deps.js(); }
  private get jsm() { return this.deps.jsm(); }
  private get space() { return this.deps.space(); }
  private get owner() { return this.deps.owner(); }
  private get actor() { return this.deps.actor(); }
  private get channels() { return this.deps.channels(); }
  private notLiveMsg() { return this.deps.notLiveMsg(); }
  private ref() { return this.deps.ref(); }
  private publishMsg(subject: string, msg: CotalMessage) { return this.deps.publishMsg(subject, msg); }
  private streamHistory(stream: string, subjects: string[], limit: number, before?: number, signal?: AbortSignal) { return this.deps.streamHistory(stream, subjects, limit, before, signal); }
  private emitRecoverable(err: Error) { this.deps.emitRecoverable(err); }

  /** Multicast: broadcast to everyone on a channel. */
  async multicast(
    text: string,
    opts?: { channel?: string; parts?: Part[]; replyTo?: string; contextId?: string; mentions?: string[] },
  ): Promise<CotalMessage> {
    // Publish must target a concrete sub-channel — you can't broadcast to a
    // wildcard. Default to the first concrete channel we're on (channels[0] may
    // itself be a wildcard subscription like `team.>`). On no channels there is NO default: refuse
    // rather than pick `general`, which is a destination the caller never chose and, for an agent
    // whose cred carries no channel row, one the broker would deny anyway.
    const channel = opts?.channel ?? this.channels.find(isConcreteChannel);
    if (channel === undefined)
      throw new Error(
        "no default channel: this endpoint is not on any concrete channel, so there is nothing to broadcast to - name a channel explicitly, or join one first",
      );
    if (!isConcreteChannel(channel))
      throw new Error(`cannot publish to wildcard channel "${channel}" - pick a concrete sub-channel`);
    const msg: CotalMessage = {
      id: randomUUID(),
      ts: Date.now(),
      space: this.space,
      from: this.ref(),
      channel,
      // Priority/wake hint, not routing — validation (against the roster) is the connector's
      // job; core just canonicalizes and omits the field when empty.
      mentions: normalizeMentions(opts?.mentions),
      parts: opts?.parts ?? [{ kind: "text", text }],
      replyTo: opts?.replyTo,
      contextId: opts?.contextId,
    };
    await this.publishMsg(chatSubject(this.space, this.owner, this.actor, channel), msg);
    return msg;
  }

  /** The broker's live `max_payload` — the CEILING a frame is measured against, not a budget for a
   *  caller's own payload.
   *
   *  Exposed because the connection is private and callers outside core (a connector assembling a
   *  batched payload) otherwise have no way to learn the ceiling except by failing a publish.
   *  Throws rather than guessing a default: a wrong ceiling is worse than none, because it splits
   *  either too eagerly or too late and both look like working code.
   *
   *  THIS ALONE CANNOT SIZE A MESSAGE. The envelope this endpoint adds after the publish call, and
   *  the client's own headers, are charged against the same ceiling and the caller never sees them.
   *  Use {@link encodedSize}, which measures what will actually be sent. */
  get maxPayload(): number {
    const max = this.nc?.info?.max_payload;
    if (typeof max !== "number" || !Number.isFinite(max) || max <= 0)
      throw new Error(`${this.notLiveMsg()} - max_payload is only known while connected`);
    return max;
  }

  /**
   * Verify the PRECONDITION {@link multicastExpecting} depends on: that the chat stream evaluates
   * the subject expectation BEFORE the `Nats-Msg-Id` dedup cache. **Throws if it cannot be
   * guaranteed.** Call before the first serialized append on a given endpoint.
   *
   * **The ordering follows the stream's REPLICATION FACTOR, not the deployment.** A standalone R1
   * stream and an R1 stream inside a real 3-node cluster both refuse a stale expectation with a CAS
   * error; only an R3 stream evaluates dedup first and answers a retry with `duplicate: true`. A
   * check written against cluster size would pass on exactly the deployment that breaks.
   *
   * Every stream Cotal creates is `num_replicas: 1`, from the same canonical config the restore path
   * uses, so the property holds by construction today. This exists because "by construction" is an
   * observation until something checks it: nothing in the wire contract reserves the replica factor.
   * A caller appending under a stale assumption does not fail loudly; it accepts a retry as success
   * and drops a message.
   *
   * Evidence is `smoke:cas-preflight-cluster`, which records the server version it measured against
   * rather than naming one here — the suites resolve `nats-server` from `PATH`, so a hardcoded
   * provenance ages into a claim about a machine that no longer exists.
   *
   * @throws if the stream is unreadable (no `STREAM.INFO` grant, or absent) or reports more than
   *   one replica. Never degrades to a warning: the failure it prevents is silent.
   */
  async assertExpectationSemantics(): Promise<void> {
    if (!this.jsm) throw new Error(this.notLiveMsg());
    const stream = chatStream(this.space);
    let replicas: number | undefined;
    try {
      replicas = (await this.jsm.streams.info(stream)).config.num_replicas;
    } catch (e) {
      throw new Error(
        `cannot verify expectation semantics: stream "${stream}" info unavailable (${(e as Error).message}). ` +
          `Serialized appends are refused rather than run on an unverified stream.`,
      );
    }
    // `undefined` is NOT treated as 1. A server that does not report the field is a server whose
    // ordering we have not established, which is the case this check exists for.
    if (replicas !== 1)
      throw new Error(
        `stream "${stream}" reports num_replicas=${String(replicas)}; serialized appends on THIS ` +
          `stream require 1 — a property of this one stream, not of the broker, so a clustered ` +
          `deployment is fine so long as this stream is R1, which a cluster can host. ` +
          `On a replicated stream the dedup cache is consulted before the subject expectation, so a ` +
          `retry returns a duplicate ack instead of a conflict and a lost message reads as success.`,
      );
  }

  /** The envelope {@link multicastExpecting} publishes, built in ONE place so that a frame and any
   *  measurement of that frame cannot describe different messages. The fields this adds — `ts`,
   *  `space`, `from`, `channel` and the normalized `mentions` — are exactly the ones a caller
   *  holding only its parts cannot account for. */
  private casEnvelope(opts: {
    channel: string;
    parts: Part[];
    id: string;
    mentions?: string[];
    replyTo?: string;
    contextId?: string;
  }): CotalMessage {
    return {
      id: opts.id,
      ts: Date.now(),
      space: this.space,
      from: this.ref(),
      channel: opts.channel,
      mentions: normalizeMentions(opts.mentions),
      parts: opts.parts,
      replyTo: opts.replyTo,
      contextId: opts.contextId,
    };
  }

  /**
   * The bytes this frame will ACTUALLY put on the wire, to compare against {@link maxPayload}.
   *
   * Caller-side arithmetic is wrong in the dangerous direction: a split sized against the caller's
   * own payload produces a frame the broker REJECTS, and a rejected truncation makes the loss silent
   * again — the failure splitting exists to prevent.
   *
   * It lives on the surface that BUILDS the envelope so measurement and construction cannot drift
   * apart unnoticed: it shares {@link casEnvelope} with the publish path, sets the same two headers,
   * and lets the client's own encoder encode them rather than re-implementing the wire format.
   * `frame-size.smoke.ts` binary-searches a real broker's ceiling and requires this number to land
   * on it exactly.
   *
   * `expectedLastSubjectSeq` is a parameter because it is a header VALUE: sizing at 0 and publishing
   * at 123456 differ by five bytes.
   * `expectedLastMsgId` is measured when given, so a caller that may send it can size for it.
   *
   * Residual: `ts` is re-stamped at publish, so the two differ in value — not in length until
   * epoch-millis needs a 14th digit.
   */
  encodedSize(opts: {
    channel: string;
    parts: Part[];
    id: string;
    expectedLastSubjectSeq: number;
    expectedLastMsgId?: string;
    mentions?: string[];
    replyTo?: string;
    contextId?: string;
  }): number {
    // The same argument validation the publish path applies, so a caller cannot size a frame that
    // would have been refused before it ever reached the wire.
    if (!isConcreteChannel(opts.channel))
      throw new Error(`cannot publish to wildcard channel "${opts.channel}" - pick a concrete sub-channel`);
    assertIdToken(opts.id, "publish id");
    if (!Number.isSafeInteger(opts.expectedLastSubjectSeq) || opts.expectedLastSubjectSeq < 0)
      throw new Error(
        `expectedLastSubjectSeq must be a non-negative safe integer, got ${JSON.stringify(opts.expectedLastSubjectSeq)}`,
      );
    if (!Array.isArray(opts.parts) || opts.parts.length === 0)
      throw new Error("encodedSize requires at least one part");

    const mh = headers();
    mh.set("Nats-Msg-Id", opts.id);
    mh.set("Nats-Expected-Last-Subject-Sequence", `${opts.expectedLastSubjectSeq}`);
    if (opts.expectedLastMsgId !== undefined) {
      assertIdToken(opts.expectedLastMsgId, "expected last msg id");
      mh.set("Nats-Expected-Last-Msg-Id", opts.expectedLastMsgId);
    }
    // `encode()` is on the client's header implementation but not on the published `MsgHdrs` type,
    // so it is reached through a cast rather than copied. If a client version drops it, this throws
    // immediately and loudly — the calibration cell would also fail — instead of returning a number
    // that is quietly wrong near the ceiling.
    const headerBytes = (mh as unknown as { encode(): Uint8Array }).encode().length;
    return headerBytes + Buffer.byteLength(JSON.stringify(this.casEnvelope(opts)), "utf8");
  }

  /**
   * Multicast with an OPTIMISTIC-CONCURRENCY expectation and a caller-chosen dedup id, returning
   * the `PubAck` fields instead of discarding them. The serialized-append primitive: two writers
   * racing one subject cannot interleave, because the loser's expectation no longer holds.
   *
   * **Why a separate method rather than options on {@link multicast}.** `multicast` mints a fresh
   * `id` per call and drops the ack; both are right for ordinary chat and both are fatal to a
   * caller that must retry an append idempotently. Keeping them apart means no existing caller
   * changes behaviour, and the stricter validation below applies only where a caller opted in.
   *
   * - `id` becomes the JetStream `Nats-Msg-Id`, so the SAME id may be republished on retry and the
   *   server dedups it within the stream's duplicate window. It is validated rather than trusted:
   *   it lands in a wire header, and the dedup cache is **stream-wide**, so a caller-supplied id is
   *   both an injection surface and a way to suppress another publisher's message.
   * - `expectedLastSubjectSeq` is the sequence this publisher believes is the subject's tip; `0`
   *   means "the subject must be empty". A mismatch throws, and the throw stays classifiable by the
   *   already-public {@link isCasLoss} — the error is deliberately **not wrapped**, since wrapping
   *   would hide the `err_code` that classification reads.
   * - `expectedLastMsgId`, when given, becomes `Nats-Expected-Last-Msg-Id`. The broker checks it after
   *   its dedup cache, so a fresh value nobody has published turns a publish into a probe: an id the
   *   cache holds answers `duplicate: true` with the stored sequence, and any other id is refused
   *   with error 10070 before anything is stored.
   *
   * @throws if the endpoint is not live, the channel is not concrete, `id` is malformed, `parts` is
   *   empty, or `expectedLastSubjectSeq` is not a non-negative safe integer.
   */
  async multicastExpecting(opts: {
    channel: string;
    parts: Part[];
    id: string;
    expectedLastSubjectSeq: number;
    expectedLastMsgId?: string;
    mentions?: string[];
    replyTo?: string;
    contextId?: string;
  }): Promise<{ message: CotalMessage; ack: { seq: number; duplicate: boolean } }> {
    if (!this.js) throw new Error(this.notLiveMsg());
    if (!isConcreteChannel(opts.channel))
      throw new Error(`cannot publish to wildcard channel "${opts.channel}" - pick a concrete sub-channel`);
    // Reuse the existing id grammar rather than mint a second one: [A-Za-z0-9_-]{1,64} admits a
    // UUID and rejects every character that could break a wire header (CR, LF, space, colon).
    assertIdToken(opts.id, "publish id");
    const expected = opts.expectedLastSubjectSeq;
    if (!Number.isSafeInteger(expected) || expected < 0)
      throw new Error(
        `expectedLastSubjectSeq must be a non-negative safe integer, got ${JSON.stringify(expected)}`,
      );
    if (!Array.isArray(opts.parts) || opts.parts.length === 0)
      throw new Error("multicastExpecting requires at least one part");
    if (opts.expectedLastMsgId !== undefined) assertIdToken(opts.expectedLastMsgId, "expected last msg id");

    const message = this.casEnvelope(opts);
    assertPartsSerializable(message.parts);
    // Publish DIRECTLY rather than through publishMsg: this path must set the expectation and read
    // the ack, and publishMsg deliberately does neither.
    const ack = await this.js.publish(
      chatSubject(this.space, this.owner, this.actor, opts.channel),
      JSON.stringify(message),
      { msgID: opts.id, expect: { lastSubjectSequence: expected, ...(opts.expectedLastMsgId !== undefined ? { lastMsgID: opts.expectedLastMsgId } : {}) } },
    );
    return { message, ack: { seq: ack.seq, duplicate: ack.duplicate === true } };
  }

  /** Publish a payload frame on this principal's forge-locked sibling event rail. */
  async publishEventPayload(opts: { parts: Part[]; id: string; expectedLastSubjectSeq: number }): Promise<{ ack: { seq: number; duplicate: boolean } }> {
    if (!this.js) throw new Error(this.notLiveMsg());
    assertIdToken(opts.id, "publish id");
    if (!Number.isSafeInteger(opts.expectedLastSubjectSeq) || opts.expectedLastSubjectSeq < 0)
      throw new Error("payload expectation must be a non-negative safe integer");
    if (!opts.parts.length) throw new Error("payload frame requires parts");
    const message = this.casEnvelope({ ...opts, channel: `events.${this.owner}.${this.actor}` });
    assertPartsSerializable(message.parts);
    const ack = await this.js.publish(eventPayloadSubject(this.space, this.owner, this.actor), JSON.stringify(message),
      { msgID: opts.id, expect: { lastSubjectSequence: opts.expectedLastSubjectSeq } });
    return { ack: { seq: ack.seq, duplicate: ack.duplicate === true } };
  }

  /** Read payload history through a single native-filtered consumer, never through CHAT. */
  async eventPayloadHistory(owner: string, actor: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<HistoryMessage[]> {
    return (await this.streamHistory(eventPayloadStream(this.space),
      [eventPayloadSubject(this.space, assertValidOwnerToken(owner), assertValidOwnerToken(actor))], opts?.limit ?? 100, undefined, opts?.signal))
      .map(row => row.msg);
  }

  /** Verify the sibling stream and learn its actual message ceiling. A pre-upgrade space without
   *  the stream or its info-read permission returns null and emits a warning. Other authorization,
   *  transport and config errors throw. */
  async eventPayloadLimit(): Promise<number | null> {
    if (!this.jsm) throw new Error(this.notLiveMsg());
    const stream = eventPayloadStream(this.space);
    const info = await this.jsm.streams.info(stream).catch((err: unknown) => {
      const denial = err instanceof PermissionViolationError ? err
        : (err as { cause?: unknown } | null)?.cause;
      const infoDenied = denial instanceof PermissionViolationError && denial.operation === "publish"
        && denial.subject === `$JS.API.STREAM.INFO.${stream}`;
      if (!infoDenied && !isJetStreamMissing(err, JetStreamApiCodes.StreamNotFound)) throw err;
      const reason = infoDenied ? `missing publish permission on $JS.API.STREAM.INFO.${stream}` : `stream ${stream} is absent`;
      this.emitRecoverable(new Error(
        `event payloads unavailable: ${reason}; publishing tool names and times only. Upgrade the space's broker setup and credentials to enable payloads`,
      ));
      return null;
    });
    if (info === null) return null;
    const { config } = info;
    if (config.num_replicas !== 1) throw new Error("event payload stream requires one replica for serialized appends");
    const limits = [this.maxPayload, config.max_msg_size, config.max_bytes].filter((n): n is number => typeof n === "number" && n > 0);
    return Math.min(...limits);
  }

  /** Unicast: direct message to one specific instance. */
  async unicast(
    instanceId: string,
    text: string,
    opts?: { parts?: Part[]; replyTo?: string; contextId?: string },
  ): Promise<CotalMessage> {
    const { msg } = await this.unicastAttributed(instanceId, text, opts);
    return msg;
  }

  /** Unicast, returning the JetStream publish ack alongside the message: the only truthful proof
   *  a sender has is that the broker stored the message at a sequence, never that anyone read it. */
  async unicastAttributed(
    instanceId: string,
    text: string,
    opts?: { parts?: Part[]; replyTo?: string; contextId?: string },
  ): Promise<{ msg: CotalMessage; ack: { seq: number; duplicate: boolean } }> {
    if (!this.js) throw new Error(this.notLiveMsg());
    const msg: CotalMessage = {
      id: randomUUID(),
      ts: Date.now(),
      space: this.space,
      from: this.ref(),
      to: instanceId,
      parts: opts?.parts ?? [{ kind: "text", text }],
      replyTo: opts?.replyTo,
      contextId: opts?.contextId,
    };
    // The recipient id is a principal dot-form `<owner>.<actor>` (owner+actor grammar); the 4-token DM
    // subject forge-locks recipient AND sender, so both are split into their tokens here.
    const recip = parsePrincipalKey(instanceId);
    if (!recip) throw new Error(`unicast: "${instanceId}" is not a valid recipient principal <owner>.<actor>`);
    assertPartsSerializable(msg.parts);
    // Publish DIRECTLY rather than through publishMsg, the way multicastExpecting does: this path
    // must read the ack, and publishMsg deliberately discards it.
    const subject = unicastSubject(this.space, recip.owner, recip.actor, this.owner, this.actor);
    try {
      const ack = await this.js.publish(subject, JSON.stringify(msg), { msgID: msg.id });
      return { msg, ack: { seq: ack.seq, duplicate: ack.duplicate === true } };
    } catch (error) {
      if (error instanceof TimeoutError)
        throw new Error(
          `${error.message} publishing to ${JSON.stringify(subject)}. The send outcome is unknown: the broker may have stored the message. Check before resending.`,
          { cause: error },
        );
      throw error;
    }
  }

  /** Anycast: deliver to ANY one instance of a service (role) — queue-group load balancing. */
  async anycast(
    service: string,
    text: string,
    opts?: { parts?: Part[]; replyTo?: string; contextId?: string },
  ): Promise<CotalMessage> {
    const { msg } = await this.anycastAttributed(service, text, opts);
    return msg;
  }

  /** Anycast, returning the JetStream publish ack alongside the message: the broker stored the
   *  request on the role's work queue at a sequence, which proves neither a holder nor a read. */
  async anycastAttributed(
    service: string,
    text: string,
    opts?: { parts?: Part[]; replyTo?: string; contextId?: string },
  ): Promise<{ msg: CotalMessage; ack: { seq: number; duplicate: boolean } }> {
    if (!this.js) throw new Error(this.notLiveMsg());
    // The subject builder admits `*` for allow rules; a publish needs one concrete role.
    assertValidRole(service);
    const msg: CotalMessage = {
      id: randomUUID(),
      ts: Date.now(),
      space: this.space,
      from: this.ref(),
      toService: service,
      parts: opts?.parts ?? [{ kind: "text", text }],
      replyTo: opts?.replyTo,
      contextId: opts?.contextId,
    };
    assertPartsSerializable(msg.parts);
    // Publish DIRECTLY rather than through publishMsg, the way unicastAttributed does: this path
    // must read the ack, and publishMsg deliberately discards it.
    const ack = await this.js.publish(
      anycastSubject(this.space, service, this.owner, this.actor),
      JSON.stringify(msg),
      { msgID: msg.id },
    );
    return { msg, ack: { seq: ack.seq, duplicate: ack.duplicate === true } };
  }
}

/** A `data` part value the wire can carry faithfully: a JSON value at EVERY depth (SPEC §5's
 *  `<any JSON value>`). `JSON.stringify` does not reject what it cannot represent — it silently
 *  rewrites: `undefined` (and a function-valued member) drops the key, `NaN`/`Infinity` store as
 *  `null`, a `Date` stores as a string, a sparse array's holes store as `null`, a `Map` stores as
 *  `{}`, a `Buffer` stores as `{"type":"Buffer",...}`. A reader then cannot tell a stored `null`
 *  from a real one (#1404 fix round). So the producer checks structurally, matching the exported
 *  `JsonValue`: null, boolean, finite number, string, an array whose every slot (holes included)
 *  passes, or a plain object (prototype `null` or `Object.prototype`) whose every defined member
 *  passes. A cycle is refused here too, never left for stringify's TypeError.
 *
 *  THE OBJECT/ARRAY ASYMMETRY ON `undefined`: an `undefined`-valued MEMBER of a plain object is
 *  allowed — stringify drops just that key, which is faithful (and the exported type says so) —
 *  while `undefined` at the top level or in an ARRAY SLOT is refused, because there stringify
 *  cannot drop a position: it stores `null`, which is a rewrite a reader cannot distinguish from
 *  a real `null`.
 *
 *  `seen` is the set of ANCESTORS on the current path, not every object visited: it is deleted
 *  from on the way out, so a SHARED subtree (`{a: x, b: x}`) passes — stringify carries it twice,
 *  which is faithful — while an object that contains itself at any depth still reports its path. */
function jsonPathProblem(path: string, value: unknown, seen: Set<object>): string | undefined {
  if (value === null) return undefined;
  const t = typeof value;
  if (t === "boolean" || t === "string") return undefined;
  if (t === "number") return Number.isFinite(value) ? undefined : `${path} is not a finite number`;
  if (t === "undefined" || t === "function" || t === "symbol" || t === "bigint") return `${path} is not a JSON value`;
  if (typeof value === "object") {
    if (seen.has(value)) return `${path} is cyclic`;
    seen.add(value);
    let problem: string | undefined;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        problem = jsonPathProblem(`${path}[${i}]`, value[i], seen);
        if (problem) return problem;
      }
    } else {
      const proto = Object.getPrototypeOf(value);
      if (proto !== null && proto !== Object.prototype) {
        seen.delete(value);
        return `${path} is not a plain object`;
      }
      for (const key of Object.keys(value)) {
        // A member whose value is undefined is the allowed key-drop, not a defect: stringify omits
        // the key, the object stays a JSON object, so skip it rather than walk it.
        if (value[key as keyof typeof value] === undefined) continue;
        problem = jsonPathProblem(`${path}.${key}`, value[key as keyof typeof value], seen);
        if (problem) return problem;
      }
    }
    seen.delete(value);
    return undefined;
  }
  return `${path} is not a JSON value`;
}

/** Refuse, at publish, a `data` part `JSON.stringify` would silently rewrite. The guard is the
 *  runtime half of `Part`'s `data: JsonValue` arm: with it, a non-JSON value at any depth never
 *  reaches the wire, so every reader (live core-sub, Plane-3 durable, history) gives one answer —
 *  the message was never sent — instead of the old split where history returned a rewritten row
 *  while Plane-3 terminated a keyless one as malformed. The error names the path to the offending
 *  value (e.g. `data[2].at`), so a caller learns which member to fix rather than that stringify
 *  would have mangled something. Throws rather than coercing: no fallback. */
export function assertPartsSerializable(parts: readonly Part[]): void {
  for (const p of parts) {
    if (p.kind !== "data") continue;
    const problem = jsonPathProblem("data", (p as { data?: unknown }).data, new Set());
    if (problem !== undefined) {
      throw new Error(`cannot publish a data part carrying a non-JSON value (SPEC §5) - ${problem}`);
    }
  }
}

/** The deps of one endpoint's {@link EndpointMessaging}. Every value is read from `ep` when it is used, so a field
 *  assigned after construction is seen, and a member a caller replaced on the endpoint is the one that runs. */
export function endpointMessagingDeps(ep: CotalEndpoint): EndpointMessagingDeps {
  return {
    nc: () => ep["nc"],
    js: () => ep["js"],
    jsm: () => ep["jsm"],
    space: () => ep["space"],
    owner: () => ep["owner"],
    actor: () => ep["actor"],
    channels: () => ep["channels"],
    notLiveMsg: () => ep["notLiveMsg"](),
    ref: () => ep["ref"](),
    publishMsg: (subject, msg) => ep["publishMsg"](subject, msg),
    streamHistory: (...args) => ep["streamHistory"](...args),
    emitRecoverable: (err) => ep["emitRecoverable"](err),
  };
}
