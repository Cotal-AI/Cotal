// Message authentication against the delivery subject and the history-row checks, moved verbatim from
// endpoint.ts. endpoint.ts re-exports the name it exported before, so the package's export set is unchanged.
import type { JsMsg } from "@nats-io/jetstream";
import type { MsgHdrs, NatsConnection } from "@nats-io/transport-node";
import { isPrincipalOwnerToken, parseSubject, type ParsedSubject } from "./subjects.js";
import { PLUGIN_CHANNEL_ROOT } from "./plugin-channel-route.js";
import type { CotalMessage, Delivery, HistoryMessage, MessageMeta } from "./types.js";
import { authenticatedChannelMessage, isRecord } from "./endpoint-inbound.js";
import { hasStoredOrigin } from "./endpoint-provenance.js";

/** A usable delivery-message id (#624): a string, possibly empty (the never-a-key case), but
 *  never absent and never a non-string. An absent or non-string id is a malformed envelope under
 *  SPEC sec 5; each delivery pump handles it per its own class (durable term, live drop, history
 *  skip) so it never reaches the receiver's id-keyed machinery as `undefined`. */
export function isUsableMessageId(id: unknown): id is string {
  return typeof id === "string";
}

/** Map an authenticated parsed-subject kind to the message class surfaced to "message" listeners.
 *  Throws on `ctl` (control-plane is request/reply, never a "message") — per repo convention, no
 *  silent default: an unexpected delivering kind is a bug, not something to swallow. */
export function kindFromParsed(kind: ParsedSubject["kind"]): MessageMeta["kind"] {
  switch (kind) {
    case "chat":
    case PLUGIN_CHANNEL_ROOT:
      return "channel";
    case "inst":
      return "dm";
    case "svc":
      return "anycast";
    default:
      throw new Error(`cannot derive a message kind from subject kind "${kind}"`);
  }
}

/** SPEC §5 on receive: a delivery comes from the principal its subject names. The payload is an
 *  object whose `from.id` is the subject's sender, and the subject's owner is a real principal, not
 *  an old-shape alias. Check stored-message headers separately before trusting the sender. Refusals
 *  and additional checks, such as a usable ID or echo suppression, belong to the caller. */
export function isFromSubjectSender(msg: unknown, parsed: ParsedSubject): boolean {
  return isRecord(msg) && isRecord(msg.from) && msg.from.id === parsed.sender && isPrincipalOwnerToken(parsed.owner);
}

/** Routing fields in the envelope are advisory. The broker forge-locks sender (and for DMs,
 *  recipient) into the subject. Callers MUST already have passed {@link isFromSubjectSender}
 *  (SPEC §5). This derives the remaining
 *  routing tokens from the subject for rows that survived — it does not rewrite a mismatched
 *  `from.id`. Live tails, channel backfill, and channel recall skip the mismatch; history
 *  does the same (#388). The row's other fields pass through UNTOUCHED, so what the caller's
 *  row type already verified stays verified (#1413). */
export function authenticatedMessage<M extends CotalMessage>(msg: M, parsed: ParsedSubject): CotalMessage & M {
  if (parsed.kind === "chat" || parsed.kind === "evp" || parsed.kind === PLUGIN_CHANNEL_ROOT)
    return authenticatedChannelMessage(msg, parsed.rest);
  if (parsed.kind === "inst") return authenticatedDmMessage(msg, parsed.rest);
  if (parsed.kind === "svc") return authenticatedAnycastMessage(msg, parsed.rest);
  return msg;
}

function authenticatedDmMessage<M extends CotalMessage>(msg: M, to: string): CotalMessage & M {
  if (msg.to === to && (msg as CotalMessage).channel === undefined && msg.toService === undefined) return msg;
  const { channel: _channel, toService: _toService, ...base } = msg;
  return { ...base, to } as CotalMessage & M;
}

function authenticatedAnycastMessage<M extends CotalMessage>(msg: M, toService: string): CotalMessage & M {
  if (msg.toService === toService && msg.to === undefined && (msg as CotalMessage).channel === undefined) return msg;
  const { to: _to, channel: _channel, ...base } = msg;
  return { ...base, toService } as CotalMessage & M;
}

/** A DM-only copy's delivery. An ack, nak or in-progress signal on a closed connection is refused
 *  with a throw instead of being dropped silently: the copy stays unacked and the broker redelivers it. */
export function dmOnlyDelivery(m: JsMsg, ackWaitMs: number, nc: NatsConnection | undefined): Delivery {
  const open = (what: string): void => {
    if (!nc || nc.isClosed()) throw new Error(`DM-only ${what} refused: the connection that delivered this copy is closed; the broker will redeliver it`);
  };
  return {
    ack: () => { open("ack"); m.ack(); },
    nak: () => { open("nak"); m.nak(); },
    durable: true,
    redelivery: { deliveryCount: m.info.deliveryCount, ackWaitMs, working: () => { open("in-progress signal"); m.working(); } },
  };
}

/** Admit only well-formed history deliveries whose sender matches the subject and whose headers
 *  carry no stored provenance. Include the viewer's own sends. */
export function historyMessageFromDelivery(m: { subject: string; headers?: MsgHdrs; json: <T>() => T }): HistoryMessage | undefined {
  if (hasStoredOrigin(m.headers)) return undefined;
  let raw: unknown;
  try {
    raw = m.json();
  } catch {
    return undefined;
  }
  if (!isHistoryDrainEnvelope(raw)) return undefined;
  if (!isVerifiedHistoryRow(raw)) return undefined;
  const parsed = parseSubject(m.subject);
  if (!parsed || !isFromSubjectSender(raw, parsed)) return undefined;
  return authenticatedMessage(raw, parsed);
}

/** A row `isHistoryDrainEnvelope` admitted: object envelope, usable `id`, object `from` — the
 *  drain's own MINIMAL row type, what it checked and nothing more (#1413). Distinct from both
 *  `CotalMessage` (which promises more than the drain verified) and `HistoryMessage` (the
 *  PUBLIC row, whose every present field the drain checked before returning it). */
type HistoryDrainEnvelope = {
  id: string;
  from: { id: unknown; name?: unknown; role?: unknown };
  [key: string]: unknown;
};

/** The members `HistoryMessage` promises beyond the drain envelope (#1413): a full
 *  `EndpointRef` (`from.name`, and `from.role` only when a string), a finite `ts`, a string
 *  `space`, `parts` the drain could read, and the optional members in their promised shape
 *  when present. Every field the PUBLIC row type promises is checked here, before the row is
 *  returned. A row missing one is dropped, never returned with that member silently
 *  `undefined` under the full type — a consumer reading `msg.ts`, `msg.space`, `msg.parts`
 *  or `msg.from.name` must not be able to reach one that was never there. Nothing is invented
 *  for an absent field.
 *
 *  `parts` is held to READABLE, not to `isMessagePart`: every member must be an object with a
 *  string `kind` (so `partsToText` can read `part.kind` without throwing), but a keyless
 *  `{kind:"data"}` row from a pre-#1404 producer is not dropped — history must surface it.
 *  `mentions`, `replyTo`, and `contextId` keep exactly their `CotalMessage` shapes when
 *  present: an array of strings, a string, a string. */
function isVerifiedHistoryRow(row: HistoryDrainEnvelope): row is HistoryDrainEnvelope & HistoryMessage {
  if (typeof row.from.name !== "string") return false;
  if (row.from.role !== undefined && typeof row.from.role !== "string") return false;
  if (typeof row.ts !== "number" || !Number.isFinite(row.ts)) return false;
  if (typeof row.space !== "string") return false;
  if (!Array.isArray(row.parts) || !row.parts.every(isReadableMessagePart)) return false;
  if (row.mentions !== undefined &&
      (!Array.isArray(row.mentions) || !row.mentions.every((name) => typeof name === "string"))) return false;
  if (row.replyTo !== undefined && typeof row.replyTo !== "string") return false;
  if (row.contextId !== undefined && typeof row.contextId !== "string") return false;
  return true;
}

/** A part `partsToText` can read without throwing: an object with a string `kind` (#1413).
 *  Deliberately weaker than `isMessagePart` — a keyless `{kind:"data"}` part passes here —
 *  because history must surface rows a pre-#1404 producer wrote, not drop them. */
export function isReadableMessagePart(value: unknown): boolean {
  return isRecord(value) && typeof value.kind === "string";
}

/**
 * Narrow enough for the type checker and for fail-closed history: object envelope, usable `id`,
 * object `from`. That is what lets `authenticatedMessage` take the row without a cast.
 *
 * Does NOT verify SPEC §5 message shape. It does not require a string `from.id` (the SPEC §5
 * comparison still rejects a mismatch) or exactly one route key. The members the PUBLIC
 * history row promises beyond this envelope — a full EndpointRef `from` (`name`/`role`), a
 * finite `ts`, a string `space` — are checked by {@link isVerifiedHistoryRow} before the row
 * is returned (#1413). Well-formed `parts` still belong to `isCotalMessage` (Plane-3), and
 * history must not use that guard: a publisher now REFUSES a `data` part carrying a non-JSON
 * value, but a keyless `{kind:"data"}` row from a pre-fix producer can still sit in a stream,
 * and history must surface it rather than drop it.
 */
function isHistoryDrainEnvelope(value: unknown): value is HistoryDrainEnvelope {
  return isRecord(value) && isUsableMessageId(value.id) && isRecord(value.from);
}
