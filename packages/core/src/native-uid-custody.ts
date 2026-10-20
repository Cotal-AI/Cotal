/** Immutable UID custody discrimination for native lifecycle executors.
 * Service custody is recognized only to refuse ordinary mutations. This module does not
 * enable service admission, root issuance, cancellation or terminal retirement. */
import { createHash } from "node:crypto";
import { canonicalJson, contractDigest, isContractDigest } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { assertBoundedOwner, assertLifecycleToken, endpointToken } from "./endpoint-subjects.js";
import { isAccountNkey } from "./identity.js";
import { assertDerivedOwnerToken, spacePrefix } from "./subjects.js";
import { lifecycleHeadKey, uidReservationKey } from "./lifecycle-state.js";
import type { LifecycleStateTransport } from "./lifecycle-saga.js";

export interface ServiceUidCustodyV1 {
  v: 1;
  kind: "native-service-uid";
  native: { accountPublicKey: string; space: string; lifecycleUid: string };
  assignment: { owner: string; actor: string; endpoint: string; instanceId: string; duty: "serve" };
  creation: { operationId: string; requestDigest: string };
}
export type NativeUidCustody =
  | { kind: "ordinary"; owner: string; actor: string }
  | { kind: "service"; uid: ServiceUidCustodyV1; uidDigest: string };

const dec = new TextDecoder();
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const invalid = (detail: string): never => { throw new EpEnvelopeError("failed-precondition", `native UID custody ${detail}; reconcile the authority stores`); };
function closed(v: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!record(v) || Object.keys(v).length !== keys.length || keys.some((k) => !Object.hasOwn(v, k)))
    return invalid(`${label} does not match its closed schema`);
  return v;
}

/** Parse custody without projecting a service assignment into an ordinary owner/actor audit.
 * Ordinary legacy audit fields retain their existing validation and bytes. */
export function parseNativeUidCustody(raw: Uint8Array, lifecycleUid: string): NativeUidCustody {
  assertLifecycleToken(lifecycleUid);
  let value: unknown;
  try { value = JSON.parse(dec.decode(raw)); } catch { return invalid(`for ${lifecycleUid} is not JSON`); }
  if (!record(value)) return invalid(`for ${lifecycleUid} is not an object`);
  // A service discriminant or nested coordinate is never accepted as a legacy extension.
  if (value.kind === "native-service-uid" || Object.hasOwn(value, "native") || Object.hasOwn(value, "assignment") || Object.hasOwn(value, "serviceCustody")) {
    const o = closed(value, ["v", "kind", "native", "assignment", "creation"], "service reservation");
    const n = closed(o.native, ["accountPublicKey", "space", "lifecycleUid"], "native coordinates");
    const a = closed(o.assignment, ["owner", "actor", "endpoint", "instanceId", "duty"], "assignment");
    const c = closed(o.creation, ["operationId", "requestDigest"], "creation");
    if (o.v !== 1 || o.kind !== "native-service-uid" || !isAccountNkey(n.accountPublicKey) || n.lifecycleUid !== lifecycleUid ||
        typeof n.space !== "string" || typeof a.owner !== "string" || typeof a.actor !== "string" || typeof a.endpoint !== "string" ||
        typeof a.instanceId !== "string" || a.duty !== "serve" || typeof c.operationId !== "string" || typeof c.requestDigest !== "string" || !isContractDigest(c.requestDigest))
      return invalid(`service reservation for ${lifecycleUid} has invalid coordinates`);
    try {
      spacePrefix(n.space); assertDerivedOwnerToken(a.owner); endpointToken(a.endpoint); assertLifecycleToken(a.instanceId); assertLifecycleToken(c.operationId);
      const tuple = [1, n.accountPublicKey, n.space, a.owner, a.endpoint, a.instanceId, "serve"];
      const hash = createHash("sha256").update(canonicalJson(tuple), "utf8").digest("hex");
      const expected = assertBoundedOwner(`svc_${BigInt(`0x${hash}`).toString(36).padStart(50, "0")}`, "service actor");
      if (a.actor !== expected) return invalid(`service reservation for ${lifecycleUid} has a different derived actor`);
    } catch (e) {
      return invalid(`service reservation for ${lifecycleUid} has malformed identity: ${(e as Error).message}`);
    }
    const uid = structuredClone(o) as unknown as ServiceUidCustodyV1;
    return { kind: "service", uid, uidDigest: contractDigest(uid) };
  }
  if (typeof value.owner !== "string" || value.owner.length === 0 || typeof value.actor !== "string" || value.actor.length === 0)
    return invalid(`ordinary reservation for ${lifecycleUid} has no valid owner/actor audit`);
  return { kind: "ordinary", owner: value.owner, actor: value.actor };
}

/** Read the immutable reservation. Absence is not permission to promote or replace a UID. */
export async function readNativeUidCustody(
  t: Pick<LifecycleStateTransport, "getRecord">,
  lifecycleUid: string,
): Promise<NativeUidCustody | undefined> {
  const entry = await t.getRecord(uidReservationKey(assertLifecycleToken(lifecycleUid)));
  if (entry === undefined) return undefined;
  if (entry.operation !== "PUT") return invalid(`for ${lifecycleUid} carries a ${entry.operation} marker`);
  return parseNativeUidCustody(entry.value, lifecycleUid);
}

/** Ordinary mutation guard, including the observed alias's UID before fast/idempotent returns.
 * The trusted transport fixes the stores. A service record never confers mutation authority. */
export async function assertOrdinaryNativeMutation(
  t: Pick<LifecycleStateTransport, "getRecord">,
  target: { lifecycleUid?: string; owner?: string; actor?: string },
): Promise<void> {
  const ordinary = async (uid: string) => {
    const custody = await readNativeUidCustody(t, uid);
    if (custody?.kind === "service")
      throw new EpEnvelopeError("permission-denied", `lifecycle ${uid} has immutable service custody; ordinary lifecycle operations are refused; service coordination remains unavailable`);
  };
  if (target.lifecycleUid !== undefined) await ordinary(target.lifecycleUid);
  if (target.owner !== undefined && target.actor !== undefined) {
    const key = lifecycleHeadKey(target.owner, target.actor);
    const head = await t.getRecord(key);
    if (head === undefined) return;
    if (head.operation !== "PUT") return invalid(`head ${key} carries a ${head.operation} marker`);
    let value: unknown;
    try { value = JSON.parse(dec.decode(head.value)); } catch { return invalid(`head ${key} is not JSON`); }
    if (!record(value) || typeof value.lifecycleUid !== "string") return invalid(`head ${key} has no UID`);
    if (Object.hasOwn(value, "serviceCustody"))
      throw new EpEnvelopeError("permission-denied", `lifecycle head ${key} carries service custody; ordinary lifecycle operations are refused`);
    await ordinary(value.lifecycleUid);
  }
}
