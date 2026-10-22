/** Package-internal payload precondition for caller policy. A policy row may grow to
 * SERVICE_AUTHORITY_MAX_BYTES, and every row write is one message, so the revocation headroom the
 * row reserves is publishable only where every server's `max_payload` admits the largest row plus
 * the write's header block, and the auth stream sets no smaller per-message limit.
 *
 * The precondition has one durable record in the auth store, read by every caller-policy writer and
 * by any later issuance path. Only a trusted complete broker observation may assert it. The stock
 * standalone host bootstrap authenticates native VARZ and binds the row to its broker and plane
 * claim. Any writer that sees a live check fail withdraws the record until explicit reassertion.
 * One connection's INFO is not complete topology evidence and never replaces the observation. */
import { EpEnvelopeError, SERVICE_AUTHORITY_MAX_BYTES, isContractDigest } from "@cotal-ai/core";

export const SERVICE_CALLER_PAYLOAD_KEY = "svchost.payload";
/** O: a bound on the header block of one caller-policy create or CAS, which `max_payload` counts
 *  with the body. The subject and publish line count against `max_control_line`, asserted
 *  separately, so this bound is conservative. */
export const SERVICE_CALLER_PAYLOAD_OVERHEAD = 1024;
/** The smallest `max_payload` under which every row the headroom rule admits fits in one write. */
export const SERVICE_CALLER_PAYLOAD_FLOOR = SERVICE_AUTHORITY_MAX_BYTES + SERVICE_CALLER_PAYLOAD_OVERHEAD;

export type ServiceCallerPayloadRecord =
  /** `floor` is the smallest `max_payload` the operator's complete per-server assertion observed. */
  | { v: 1; kind: "service-caller-payload"; state: "asserted"; floor: number; assertedAtMs: number; evidenceDigest: string; broker?: { serverId: string; configDigest: string; claimId: string; claimGeneration: number } }
  | { v: 1; kind: "service-caller-payload"; state: "withdrawn"; reason: "live-check" | "payload-precondition"; operationId: string | null; atMs: number };

function bad(): never { throw new EpEnvelopeError("bad-request", "invalid service caller payload precondition"); }
function closed(raw: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad();
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) bad();
  if (fields.some((k) => !Object.hasOwn(raw, k)) || Reflect.ownKeys(raw).some((k) => typeof k !== "string" || !fields.includes(k))) bad();
  return raw as Record<string, unknown>;
}
const uint = (raw: unknown) => { if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) bad(); return raw as number; };

export function parseServiceCallerPayloadRecord(raw: unknown): ServiceCallerPayloadRecord {
  const o = raw as Record<string, unknown>;
  if (o?.state === "asserted") {
    const fields = ["v", "kind", "state", "floor", "assertedAtMs", "evidenceDigest"];
    closed(raw, Object.hasOwn(o, "broker") ? [...fields, "broker"] : fields);
    if (o.v !== 1 || o.kind !== "service-caller-payload" || typeof o.evidenceDigest !== "string" || !isContractDigest(o.evidenceDigest)) bad();
    let broker: Extract<ServiceCallerPayloadRecord, { state: "asserted" }>["broker"];
    if (o.broker !== undefined) {
      const b = closed(o.broker, ["serverId", "configDigest", "claimId", "claimGeneration"]);
      if (typeof b.serverId !== "string" || !/^N[A-Z2-7]{55}$/.test(b.serverId) || typeof b.configDigest !== "string" || !b.configDigest
        || b.configDigest.length > 128 || typeof b.claimId !== "string" || !b.claimId || b.claimId.length > 128 || uint(b.claimGeneration) < 1) bad();
      broker = { serverId: b.serverId, configDigest: b.configDigest, claimId: b.claimId, claimGeneration: b.claimGeneration as number };
    }
    return { v: 1, kind: "service-caller-payload", state: "asserted", floor: uint(o.floor), assertedAtMs: uint(o.assertedAtMs), evidenceDigest: o.evidenceDigest, ...(broker ? { broker } : {}) };
  }
  closed(raw, ["v", "kind", "state", "reason", "operationId", "atMs"]);
  if (o.v !== 1 || o.kind !== "service-caller-payload" || o.state !== "withdrawn" || (o.reason !== "live-check" && o.reason !== "payload-precondition")) bad();
  if (o.operationId !== null && (typeof o.operationId !== "string" || !/^[0-9a-f]{32}$/.test(o.operationId))) bad();
  return { v: 1, kind: "service-caller-payload", state: "withdrawn", reason: o.reason, operationId: o.operationId as string | null, atMs: uint(o.atMs) };
}

/** The live limits one connection observes: its server's `max_payload`, and the auth stream's
 *  `max_msg_size` (-1 when unlimited). Undefined means the value could not be read. */
export interface ServiceCallerPayloadLimits { maxPayload: number | undefined; authMaxMsgSize: number | undefined }

export type ServiceCallerPayloadCheck =
  | { holds: true }
  | { holds: false; why: "unasserted" | "withdrawn" | "server-limit" | "stream-limit" };

/** Whether the precondition holds now: asserted at or above the floor, and this connection's server
 *  and the auth stream both admit the largest row. A finite stream limit fails it. */
export function serviceCallerPayloadCheck(record: ServiceCallerPayloadRecord | undefined, live: ServiceCallerPayloadLimits): ServiceCallerPayloadCheck {
  if (record === undefined || (record.state === "asserted" && record.floor < SERVICE_CALLER_PAYLOAD_FLOOR)) return { holds: false, why: "unasserted" };
  if (record.state === "withdrawn") return { holds: false, why: "withdrawn" };
  if (live.maxPayload === undefined || live.maxPayload < SERVICE_CALLER_PAYLOAD_FLOOR) return { holds: false, why: "server-limit" };
  if (live.authMaxMsgSize !== -1) return { holds: false, why: "stream-limit" };
  return { holds: true };
}

/** Whether one row write of `bytes` fits the live limits: the smaller of the server's `max_payload`
 *  and a finite auth-stream `max_msg_size`, less O. An unreadable limit never fits. */
export function serviceCallerWriteFits(bytes: number, live: ServiceCallerPayloadLimits): boolean {
  if (live.maxPayload === undefined || live.authMaxMsgSize === undefined) return false;
  const stream = live.authMaxMsgSize === -1 ? Number.POSITIVE_INFINITY : live.authMaxMsgSize;
  return bytes <= Math.min(live.maxPayload, stream) - SERVICE_CALLER_PAYLOAD_OVERHEAD;
}
