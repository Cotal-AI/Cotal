/** Package-internal closed shapes for canonical R9 service native custody: the head variants, the
 * native gate variants, the native root row and the digest mirror. The active-root reader and the
 * dormant custody writer both take their field sets and mirror rule from here, so a row one of
 * them accepts can never be classified differently by the other. Never exported from the index. */
import {
  EpEnvelopeError, assertLifecycleToken, contractDigest, isContractDigest, serviceEndpointActor,
  type ServiceUidCustodyV1,
} from "@cotal-ai/core";

export interface Mirror { v: 1; uidDigest: string }
export interface RootPlan { credentialId: string; expMs: number }
export interface CreateOp { kind: "service-create"; opId: string; requestDigest: string }
export interface CancelOp { kind: "service-cancel"; opId: string; requestDigest: string }
interface HeadBase {
  owner: string; actor: string; lifecycleUid: string; managerInstance: string; processEpoch: 1; serviceCustody: Mirror;
}
export type ServiceHead =
  | (HeadBase & { state: "service-creating"; op: CreateOp; rootPlan: RootPlan | null })
  | (HeadBase & { state: "active"; currentCredentialId: string })
  | (HeadBase & { state: "service-cancelling"; op: CancelOp; rootPlan: RootPlan | null; currentCredentialId: string | null });
export type ServiceNativeGate =
  | { lifecycleUid: string; state: "open"; generation: 1; serviceCustody: Mirror }
  | { lifecycleUid: string; state: "frozen"; generation: 0 | 1; serviceCustody: Mirror; op: { opId: string; kind: "activation" | "service-cancel" } };
export interface ServiceNativeRoot {
  credentialId: string; holderPrincipal: string; lifecycleUid: string; sourceChain: ["root"];
  state: "active" | "revoked"; exp: number; serviceCustody: Mirror;
}

const HEAD_BASE = ["owner", "actor", "lifecycleUid", "managerInstance", "processEpoch", "serviceCustody"] as const;
/** Closed field sets, one per record variant. */
export const HEAD_FIELDS = {
  "service-creating": [...HEAD_BASE, "state", "op", "rootPlan"],
  active: [...HEAD_BASE, "state", "currentCredentialId"],
  "service-cancelling": [...HEAD_BASE, "state", "op", "rootPlan", "currentCredentialId"],
} as const;
export const GATE_FIELDS = { open: ["lifecycleUid", "state", "generation", "serviceCustody"], frozen: ["lifecycleUid", "state", "generation", "serviceCustody", "op"] } as const;
export const ROOT_FIELDS = ["credentialId", "holderPrincipal", "lifecycleUid", "sourceChain", "state", "exp", "serviceCustody"] as const;

/** A plain-prototype object carrying exactly `fields`, or `fail` is called. */
export function closedRecord(value: unknown, fields: readonly string[], fail: () => never): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const proto = Object.getPrototypeOf(value);
  if ((proto !== Object.prototype && proto !== null) || Reflect.ownKeys(value).length !== fields.length
    || fields.some(k => !Object.hasOwn(value, k))) return fail();
  return value as Record<string, unknown>;
}

/** The closed `{v:1, uidDigest}` mirror must name exactly `digest`. A malformed mirror calls
 *  `failShape` (default `fail`); a well-formed mirror naming another digest calls `fail`. */
export function assertMirror(value: unknown, digest: string, fail: () => never, failShape: () => never = fail): void {
  const o = closedRecord(value, ["v", "uidDigest"], failShape);
  if (o.v !== 1 || o.uidDigest !== digest) fail();
}

/** The immutable coordinates every service record of one UID is compared with. */
export interface ServiceCustodyIdentity {
  uid: ServiceUidCustodyV1; digest: string; lifecycleUid: string; owner: string; actor: string;
  instanceId: string; endpoint: string; holderPrincipal: string; mirror: Mirror;
}

export function serviceCustodyIdentity(uid: ServiceUidCustodyV1): ServiceCustodyIdentity {
  const { native, assignment } = uid;
  const actor = serviceEndpointActor({ accountPublicKey: native.accountPublicKey, space: native.space, owner: assignment.owner, endpoint: assignment.endpoint, instanceId: assignment.instanceId });
  if (actor !== assignment.actor) invalid("service reservation does not carry its derived actor");
  const digest = contractDigest(uid);
  return { uid: structuredClone(uid), digest, lifecycleUid: native.lifecycleUid, owner: assignment.owner, actor, instanceId: assignment.instanceId,
    endpoint: assignment.endpoint, holderPrincipal: `${assignment.owner}.${actor}`, mirror: { v: 1, uidDigest: digest } };
}

function invalid(detail: string): never {
  throw new EpEnvelopeError("failed-precondition", `service custody ${detail}`);
}
const shapeFail = (what: string) => (): never => invalid(`${what} does not match its closed schema`);
const lifecycleToken = (v: unknown): v is string => {
  if (typeof v !== "string") return false;
  try { assertLifecycleToken(v); return true; } catch { return false; }
};
const positiveSafe = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

function parsePlan(value: unknown): RootPlan | null {
  if (value === null) return null;
  const o = closedRecord(value, ["credentialId", "expMs"], shapeFail("root plan"));
  if (!lifecycleToken(o.credentialId) || !positiveSafe(o.expMs)) invalid("root plan has invalid coordinates");
  return { credentialId: o.credentialId, expMs: o.expMs };
}

function parseOp<K extends "service-create" | "service-cancel">(value: unknown, kind: K): { kind: K; opId: string; requestDigest: string } {
  const o = closedRecord(value, ["kind", "opId", "requestDigest"], shapeFail(`${kind} operation`));
  if (o.kind !== kind || !lifecycleToken(o.opId) || typeof o.requestDigest !== "string" || !isContractDigest(o.requestDigest))
    invalid(`${kind} operation has invalid coordinates`);
  return { kind, opId: o.opId as string, requestDigest: o.requestDigest as string };
}

/** Parse a head of this UID. Throws `failed-precondition` for any other identity, digest or shape. */
export function parseServiceHead(value: unknown, id: ServiceCustodyIdentity): ServiceHead {
  const state = value && typeof value === "object" ? (value as { state?: unknown }).state : undefined;
  if (state !== "service-creating" && state !== "active" && state !== "service-cancelling") return invalid("head has no service state");
  const o = closedRecord(value, HEAD_FIELDS[state], shapeFail(`${state} head`));
  assertMirror(o.serviceCustody, id.digest, () => invalid("head mirror is missing or mismatched"));
  if (o.owner !== id.owner || o.actor !== id.actor || o.lifecycleUid !== id.lifecycleUid
    || o.managerInstance !== id.instanceId || o.processEpoch !== 1)
    invalid("head does not bind this immutable service identity");
  const base: HeadBase = { owner: id.owner, actor: id.actor, lifecycleUid: id.lifecycleUid, managerInstance: id.instanceId, processEpoch: 1, serviceCustody: { ...id.mirror } };
  if (state === "service-creating") {
    const op = parseOp(o.op, "service-create");
    if (op.opId !== id.uid.creation.operationId || op.requestDigest !== id.uid.creation.requestDigest) invalid("creating head does not carry its creation operation");
    return { ...base, state, op, rootPlan: parsePlan(o.rootPlan) };
  }
  if (state === "active") {
    if (!lifecycleToken(o.currentCredentialId)) invalid("active head has no root credential id");
    return { ...base, state, currentCredentialId: o.currentCredentialId as string };
  }
  const op = parseOp(o.op, "service-cancel"), rootPlan = parsePlan(o.rootPlan);
  const stamp = o.currentCredentialId;
  if (stamp !== null && (!lifecycleToken(stamp) || rootPlan === null || rootPlan.credentialId !== stamp))
    invalid("cancelling head stamp does not match its preserved root plan");
  return { ...base, state, op, rootPlan, currentCredentialId: stamp as string | null };
}

/** Parse the native gate of this UID. Throws `failed-precondition` for any other identity or shape. */
export function parseServiceNativeGate(value: unknown, id: ServiceCustodyIdentity): ServiceNativeGate {
  const state = value && typeof value === "object" ? (value as { state?: unknown }).state : undefined;
  if (state !== "open" && state !== "frozen") return invalid("native gate has no service state");
  const o = closedRecord(value, GATE_FIELDS[state], shapeFail(`${state} native gate`));
  assertMirror(o.serviceCustody, id.digest, () => invalid("native gate mirror is missing or mismatched"));
  if (o.lifecycleUid !== id.lifecycleUid) invalid("native gate belongs to another UID");
  if (state === "open") {
    if (o.generation !== 1) invalid("open native gate is not at generation 1");
    return { lifecycleUid: id.lifecycleUid, state, generation: 1, serviceCustody: { ...id.mirror } };
  }
  const op = closedRecord(o.op, ["opId", "kind"], shapeFail("native gate operation"));
  if ((o.generation !== 0 && o.generation !== 1) || !lifecycleToken(op.opId) || (op.kind !== "activation" && op.kind !== "service-cancel"))
    invalid("frozen native gate has invalid coordinates");
  return { lifecycleUid: id.lifecycleUid, state, generation: o.generation as 0 | 1, serviceCustody: { ...id.mirror }, op: { opId: op.opId as string, kind: op.kind } };
}

/** Parse the native root row of this UID. Throws `failed-precondition` for any other identity or shape. */
export function parseServiceNativeRoot(value: unknown, id: ServiceCustodyIdentity, credentialId: string): ServiceNativeRoot {
  const o = closedRecord(value, ROOT_FIELDS, shapeFail("native root"));
  assertMirror(o.serviceCustody, id.digest, () => invalid("native root mirror is missing or mismatched"));
  if (o.credentialId !== credentialId || o.lifecycleUid !== id.lifecycleUid || o.holderPrincipal !== id.holderPrincipal
    || !Array.isArray(o.sourceChain) || o.sourceChain.length !== 1 || o.sourceChain[0] !== "root"
    || (o.state !== "active" && o.state !== "revoked") || !positiveSafe(o.exp))
    invalid("native root does not bind this immutable service identity");
  return { credentialId, holderPrincipal: id.holderPrincipal, lifecycleUid: id.lifecycleUid, sourceChain: ["root"], state: o.state, exp: o.exp, serviceCustody: { ...id.mirror } };
}

/** Encode one record, refusing bytes its own parser would not read back to the same value. */
export function encodeRoundTrip<T>(value: T, parse: (decoded: unknown) => T): Uint8Array {
  const text = JSON.stringify(value);
  if (contractDigest(parse(JSON.parse(text))) !== contractDigest(value)) invalid("encoder produced a row its parser reads differently");
  return new TextEncoder().encode(text);
}
