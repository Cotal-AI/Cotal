import { EpEnvelopeError } from "./endpoint-envelope.js";
import { endpointToken } from "./endpoint-subjects.js";
import { assertLifecycleToken, spacePrefix } from "./subjects.js";
import type { InstanceDeregisterCondition } from "./endpoint-deregister.js";

/** Explicit signerless removal request. Ownership is derived by the issuing authority. */
export interface RemoteEndpointDeregisterRequest {
  v: 1;
  kind: "endpoint-deregister";
  space: string;
  endpoint: "manager";
  instanceId: string;
}

export type RemoteEndpointDeregisterResult = RemoteEndpointDeregisterRequest & (
  | { state: "removed"; removedSpecRevision: number; removedStatusRevision: number | null }
  | { state: "refused"; condition: Exclude<InstanceDeregisterCondition, "superseded"> | "permission-denied" | "unavailable" }
  | { state: "unknown"; condition: "superseded" | "unavailable" }
);

export function parseRemoteEndpointDeregisterRequest(raw: unknown): RemoteEndpointDeregisterRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new EpEnvelopeError("bad-request", "endpoint deregistration needs an object");
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== "endpoint,instanceId,kind,space,v" || o.v !== 1 || o.kind !== "endpoint-deregister")
    throw new EpEnvelopeError("bad-request", "endpoint deregistration needs only { v: 1, kind: endpoint-deregister, space, endpoint, instanceId }");
  if (typeof o.space !== "string" || typeof o.instanceId !== "string") throw new EpEnvelopeError("bad-request", "endpoint deregistration requires space and full instance id");
  spacePrefix(o.space);
  endpointToken(String(o.endpoint));
  assertLifecycleToken(o.instanceId, "instanceId");
  if (o.endpoint !== "manager") throw new EpEnvelopeError("unimplemented", "user-auth deregistration supports only manager registrations");
  return o as unknown as RemoteEndpointDeregisterRequest;
}

/** Bind every non-secret response field to the original request. Unknown outcomes never retry. */
export function parseRemoteEndpointDeregisterResult(raw: unknown, request: RemoteEndpointDeregisterRequest): RemoteEndpointDeregisterResult {
  const bad = (): never => { throw new Error("endpoint deregistration returned an unconfirmed response"); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad();
  const o = raw as Record<string, unknown>;
  for (const key of ["v", "kind", "space", "endpoint", "instanceId"] as const) if (o[key] !== request[key]) return bad();
  const extra = o.state === "removed" ? ["state", "removedSpecRevision", "removedStatusRevision"] : ["state", "condition"];
  if (Object.keys(o).some(key => !["v", "kind", "space", "endpoint", "instanceId", ...extra].includes(key))) return bad();
  if (o.state === "removed") {
    if (!Number.isSafeInteger(o.removedSpecRevision) || (o.removedSpecRevision as number) <= 0 ||
        (o.removedStatusRevision !== null && (!Number.isSafeInteger(o.removedStatusRevision) || (o.removedStatusRevision as number) <= 0))) return bad();
  } else if (o.state === "unknown") {
    if (o.condition !== "superseded" && o.condition !== "unavailable") return bad();
  } else if (o.state !== "refused" || !["instance-answered", "instance-not-affirmed-gone", "liveness-unestablishable", "not-registered", "registration-in-flight", "permission-denied", "unavailable"].includes(String(o.condition))) return bad();
  return o as unknown as RemoteEndpointDeregisterResult;
}
