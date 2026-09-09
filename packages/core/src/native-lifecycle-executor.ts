/**
 * Shared native-lifecycle executor. Authentication, binding CAS and operation
 * journalling live here; a provider never grants ownership by discovery.
 *
 * Mutating sequence: authorize, refuse unsupported operations, inspect identity,
 * journal the prepared fence, then dispatch. A lost native acknowledgement stays
 * indeterminate. No Cotal resident process is started.
 */
import type { KV } from "@nats-io/kv";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { createRecordEntry, updateRecordEntry } from "./endpoint-records.js";
import {
  NativeLifecycleUnsupported,
  requireNativeLifecycleOperation,
  resolveNativeLifecycleProvider,
  type NativeLifecycleConnection,
  type NativeLifecycleObservation,
  type NativeLifecycleOperation,
  type NativeLifecycleOperationResult,
  type NativeLifecyclePreflight,
  type NativeLifecycleView,
} from "./native-lifecycle-provider.js";
import { getSessionEnrollment } from "./session-enrollment-renewal.js";
import { authorizeSessionManage } from "./session-manage-authority.js";
import {
  classifyIncarnationProof,
  parseBinding,
  parseIncarnationProof,
  parseResourceKey,
  resourceKeyId,
  sessionBindingKey,
  sessionOperationKey,
  type Binding,
  type IncarnationProof,
  type ResourceKey,
  type SessionManageAction,
  type SessionOperationRecord,
} from "./session-lifecycle-records.js";
import {
  assertCurrentSessionFence,
  prepareSessionOperation,
  queryOperation,
  readSessionTrustedState,
  releasedBindingStillLive,
  updateSessionOperation,
  type QueryOperationResult,
} from "./session-lifecycle-store.js";

const MUTATING: ReadonlySet<NativeLifecycleOperation> = new Set(["adopt", "release", "transfer", "recover"]);

/** Operations that acquire or move management authority over a native session. Release only
 * gives authority up, so it is never gated on the enrollment: an expired or superseded
 * enrollment must not strand a session under a manager that can no longer let go of it. */
const ENROLLMENT_GOVERNED: ReadonlySet<NativeLifecycleOperation> = new Set(["adopt", "transfer", "recover"]);

export type NativeLifecycleDispatchResult =
  | NativeLifecycleOperationResult
  | { readonly state: "unsupported"; readonly operation: NativeLifecycleOperation }
  | { readonly state: "identity-unproven"; readonly reason: string }
  | { readonly state: "observations"; readonly observations: readonly NativeLifecycleObservation[] }
  | { readonly state: "observation"; readonly observation: NativeLifecycleObservation }
  | { readonly state: "view"; readonly view: NativeLifecycleView }
  | { readonly state: "preflight"; readonly preflight: NativeLifecyclePreflight };

export interface NativeLifecycleExecutorRequest {
  readonly providerName: string;
  readonly operation: NativeLifecycleOperation;
  readonly resourceKey: ResourceKey;
  readonly resourceOwnerPrincipal: string;
  readonly managerPrincipal: string;
  readonly authenticatedActor: string;
  readonly grant: unknown;
  readonly authenticatedGrantIssuer: string;
  readonly now: number;
  readonly operationId: string;
  readonly bindingId: string;
  readonly expectedBindingRevision: number;
  readonly expectedControllerEpoch: number;
  readonly intendedResult: unknown;
  readonly connectOptions?: unknown;
  readonly signal?: AbortSignal;
  readonly delegation?: unknown;
  readonly authenticatedDelegationIssuer?: string;
  readonly expectedIncarnation?: IncarnationProof;
  /** Required when `operation` is `preflight`. The operation the provider should preflight. */
  readonly targetOperation?: NativeLifecycleOperation;
}

export interface NativeLifecycleExecutor {
  execute(request: NativeLifecycleExecutorRequest): Promise<NativeLifecycleDispatchResult>;
}

function sessionActionFor(operation: NativeLifecycleOperation): SessionManageAction {
  if (operation === "discover" || operation === "inspect" || operation === "openView"
    || operation === "queryOperation" || operation === "preflight") return "discover";
  if (operation === "recover") return "control";
  return operation;
}

function mutatingAction(operation: NativeLifecycleOperation): Exclude<SessionManageAction, "discover"> {
  const action = sessionActionFor(operation);
  if (action === "discover") throw new EpEnvelopeError("internal", `native lifecycle ${operation} is not a mutating session-manage action`);
  return action;
}

/** The durable, owner-authorized enrollment is the identity and authority source for acquiring
 * management. `request.expectedIncarnation` cannot serve that purpose because the caller supplies
 * it and may omit it, and a fresh provider observation cannot either, because a provider never
 * grants ownership by discovery. A changed incarnation is refused rather than adopted: the plan
 * requires renewed proof, and re-enrollment is what renews it. */
async function authorizeAgainstEnrollment(
  kv: KV,
  request: NativeLifecycleExecutorRequest,
  resourceKey: ResourceKey,
  observedProof: IncarnationProof,
  action: SessionManageAction,
): Promise<{ readonly rights: readonly SessionManageAction[] } | { readonly state: "identity-unproven"; readonly reason: string }> {
  const enrollment = await getSessionEnrollment(kv, resourceKey);
  if (enrollment.expiry <= request.now)
    throw new EpEnvelopeError("failed-precondition", `session enrollment for ${resourceKey.stableSessionId} expired at ${enrollment.expiry}; re-enroll before ${request.operation}`);
  if (enrollment.provenance.authenticatedAt > request.now)
    throw new EpEnvelopeError("failed-precondition", `session enrollment for ${resourceKey.stableSessionId} was authenticated at ${enrollment.provenance.authenticatedAt}, after the request`);
  if (enrollment.ownerPrincipal !== request.resourceOwnerPrincipal)
    throw new EpEnvelopeError("permission-denied", `session enrollment records owner ${enrollment.ownerPrincipal}; ${request.operation} was authorized against ${request.resourceOwnerPrincipal}`);
  if (!enrollment.rights.includes(action))
    throw new EpEnvelopeError("permission-denied", `session enrollment does not authorize ${action} on ${resourceKey.stableSessionId}`);
  if (classifyIncarnationProof(enrollment.incarnationProof, observedProof) === "identity-unproven")
    return { state: "identity-unproven", reason: "native incarnation differs from the enrolled proof; re-enrollment must renew the proof before management is acquired" };
  return { rights: enrollment.rights };
}

function sameResource(a: ResourceKey, b: ResourceKey): boolean {
  return resourceKeyId(a) === resourceKeyId(b);
}

function samePreparedIdentity(prepared: SessionOperationRecord, claimed: SessionOperationRecord): boolean {
  return claimed.operationId === prepared.operationId
    && claimed.bindingId === prepared.bindingId
    && resourceKeyId(claimed.resourceKey) === resourceKeyId(prepared.resourceKey);
}

/** Writer-side binding advance. Native-effect may settle adopt/release when
 *  resourceKey, bindingId and record.action match the requested operation.
 *  Cooperative-retirement may settle release only when the imported store
 *  predicate would treat that receipt as a completed release (matching ids
 *  and preserved native lifetime). A proves value alone never writes `released`. */
export function mayAdvanceBinding(
  current: Binding,
  durable: QueryOperationResult,
  operation: NativeLifecycleOperation,
): boolean {
  if (durable.state !== "terminal-success") return false;
  if (durable.record.bindingId !== current.bindingId) return false;
  if (resourceKeyId(durable.record.resourceKey) !== resourceKeyId(current.resourceKey)) return false;
  if (durable.proofOrigin?.proves === "native-effect")
    return (operation === "adopt" || operation === "release") && durable.record.action === operation;
  if (operation !== "release") return false;
  return !releasedBindingStillLive({ ...current, operationId: durable.record.operationId }, durable);
}

async function readBinding(kv: KV, resourceKey: ResourceKey): Promise<{ readonly binding: Binding; readonly revision: number } | undefined> {
  const key = sessionBindingKey(resourceKey);
  const entry = await kv.get(key);
  if (!entry) return undefined;
  if (entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `session binding ${key} carries a ${entry.operation} marker; binding fences are never garbage-collected automatically`);
  return { binding: parseBinding(entry.value, key, resourceKey), revision: entry.revision };
}

async function operationRevision(kv: KV, resourceKey: ResourceKey, operationId: string): Promise<number> {
  const key = sessionOperationKey(resourceKey, operationId);
  const entry = await kv.get(key);
  if (!entry || entry.operation !== "PUT")
    throw new EpEnvelopeError("internal", `session operation ${key} is not readable after prepare`);
  return entry.revision;
}

async function persistIndeterminate(
  kv: KV,
  prepared: SessionOperationRecord,
  reason: string,
): Promise<NativeLifecycleDispatchResult> {
  const current = await queryOperation(kv, prepared.resourceKey, prepared.operationId);
  if (current.state === "absent")
    throw new EpEnvelopeError("internal", `session operation ${prepared.operationId} vanished after prepare`);
  if (current.record.state === "prepared" || current.record.state === "executing") {
    const revision = await operationRevision(kv, prepared.resourceKey, prepared.operationId);
    await updateSessionOperation(kv, { ...prepared, state: "indeterminate", result: { reason } }, revision);
  }
  return { state: "indeterminate", reason };
}

async function persistBinding(kv: KV, binding: Binding, expectedRevision?: number): Promise<void> {
  const key = sessionBindingKey(binding.resourceKey);
  parseBinding(new TextEncoder().encode(JSON.stringify(binding)), key, binding.resourceKey);
  if (expectedRevision === undefined) await createRecordEntry(kv, key, binding);
  else await updateRecordEntry(kv, key, binding, expectedRevision);
}

export function createNativeLifecycleExecutor(kv: KV): NativeLifecycleExecutor {
  return { execute: (request) => executeNativeLifecycle(kv, request) };
}

/** Production entry: resolve the named provider from the process registry, then dispatch. */
export async function executeNativeLifecycle(
  kv: KV,
  request: NativeLifecycleExecutorRequest,
): Promise<NativeLifecycleDispatchResult> {
  const resourceKey = parseResourceKey(request.resourceKey, "native lifecycle request.resourceKey");
  authorizeSessionManage(
    request.grant,
    {
      authenticatedActor: request.authenticatedActor,
      managerPrincipal: request.managerPrincipal,
      resourceOwnerPrincipal: request.resourceOwnerPrincipal,
      resourceKey,
      action: sessionActionFor(request.operation),
      now: request.now,
    },
    request.authenticatedGrantIssuer,
    request.delegation,
    request.authenticatedDelegationIssuer,
  );

  const connection = resolveNativeLifecycleProvider(request.providerName).connect(request.connectOptions);
  // Capability refusal happens before inspect, prepare, or any other provider effect.
  let dispatched: ReturnType<typeof requireNativeLifecycleOperation>;
  try {
    dispatched = requireNativeLifecycleOperation(connection, request.operation);
  } catch (e) {
    if (e instanceof NativeLifecycleUnsupported) return { state: "unsupported", operation: request.operation };
    throw e;
  }
  const method = dispatched;
  if (MUTATING.has(request.operation) && connection.capabilities.mode === "observed")
    return { state: "unsupported", operation: request.operation };

  if (request.operation === "discover") {
    const observations = await (method as NonNullable<NativeLifecycleConnection["discover"]>)(request.signal);
    const authorized: NativeLifecycleObservation[] = [];
    for (const observation of observations) {
      try {
        authorizeSessionManage(
          request.grant,
          {
            authenticatedActor: request.authenticatedActor,
            managerPrincipal: request.managerPrincipal,
            resourceOwnerPrincipal: request.resourceOwnerPrincipal,
            resourceKey: parseResourceKey(observation.resourceKey, "native discover observation.resourceKey"),
            action: "discover",
            now: request.now,
          },
          request.authenticatedGrantIssuer,
          request.delegation,
          request.authenticatedDelegationIssuer,
        );
        authorized.push(observation);
      } catch (e) {
        if (e instanceof EpEnvelopeError && (e.code === "permission-denied" || e.code === "expired" || e.code === "internal")) continue;
        throw e;
      }
    }
    return { state: "observations", observations: authorized };
  }
  if (request.operation === "inspect") {
    const observation = await (method as NonNullable<NativeLifecycleConnection["inspect"]>)(resourceKey, request.signal);
    return { state: "observation", observation };
  }
  if (request.operation === "openView") {
    const view = await (method as NonNullable<NativeLifecycleConnection["openView"]>)(resourceKey, request.signal);
    return { state: "view", view };
  }
  if (request.operation === "preflight") {
    const target = request.targetOperation;
    if (target === undefined)
      throw new EpEnvelopeError("internal", "native lifecycle preflight requires request.targetOperation");
    const preflight = await (method as NonNullable<NativeLifecycleConnection["preflight"]>)(target, resourceKey, request.signal);
    return { state: "preflight", preflight };
  }
  if (request.operation === "queryOperation") {
    const recorded = await queryOperation(kv, resourceKey, request.operationId);
    if (recorded.state === "absent") return { state: "absent" };
    return await (method as NonNullable<NativeLifecycleConnection["queryOperation"]>)(recorded.record, request.signal);
  }

  if (!MUTATING.has(request.operation))
    throw new EpEnvelopeError("internal", `native lifecycle ${request.operation} is not a known mutating operation`);
  // Adopt is the operation that has no binding to pin the incarnation, so the caller has to say
  // which one it means. An absent expectation is refused here rather than skipped below, because a
  // condition the requester can omit is not a check.
  if (request.operation === "adopt" && request.expectedIncarnation === undefined)
    throw new EpEnvelopeError("internal", "native lifecycle adopt requires request.expectedIncarnation");

  const existing = await readBinding(kv, resourceKey);
  if (request.operation === "adopt" && existing !== undefined && existing.binding.state !== "released")
    throw new EpEnvelopeError("conflict", `resource ${resourceKey.stableSessionId} is already bound as ${existing.binding.bindingId}; use transfer`);
  if (request.operation !== "adopt" && existing === undefined)
    throw new EpEnvelopeError("failed-precondition", `native lifecycle ${request.operation} requires an existing binding`);
  if (existing !== undefined && existing.revision !== request.expectedBindingRevision)
    throw new EpEnvelopeError("conflict", `native lifecycle ${request.operation} expected binding revision ${request.expectedBindingRevision} but store is at ${existing.revision}`);
  if (existing !== undefined && existing.binding.state !== "released" && existing.binding.controllerEpoch !== request.expectedControllerEpoch)
    throw new EpEnvelopeError("conflict", `native lifecycle ${request.operation} expected controller epoch ${request.expectedControllerEpoch} but binding is at ${existing.binding.controllerEpoch}`);
  if (existing !== undefined && existing.binding.state !== "released" && existing.binding.bindingId !== request.bindingId)
    throw new EpEnvelopeError("conflict", `native lifecycle ${request.operation} expected binding ${request.bindingId} but store holds ${existing.binding.bindingId}`);

  if (connection.capabilities.operations.includes("preflight") && typeof connection.preflight === "function") {
    const preflight = await requireNativeLifecycleOperation(connection, "preflight")(request.operation, resourceKey, request.signal);
    if (!preflight.ok) {
      if (preflight.code === "identity-unproven" || preflight.code === "identity-mismatch")
        return { state: "identity-unproven", reason: preflight.reason };
      throw new EpEnvelopeError("failed-precondition", `native lifecycle preflight refused ${request.operation}: ${preflight.reason}`);
    }
  }

  const observation = await requireNativeLifecycleOperation(connection, "inspect")(resourceKey, request.signal);
  if (!sameResource(observation.resourceKey, resourceKey))
    return { state: "identity-unproven", reason: "inspect observation does not match the requested ResourceKey" };
  if (observation.incarnationProof === undefined)
    return { state: "identity-unproven", reason: "inspect did not establish a native host incarnation" };
  const observedProof = parseIncarnationProof(observation.incarnationProof, "native inspect");
  if (request.expectedIncarnation !== undefined
    && classifyIncarnationProof(request.expectedIncarnation, observedProof) === "identity-unproven") {
    return { state: "identity-unproven", reason: "native inspect incarnation does not match the expected proof" };
  }

  const trusted = await readSessionTrustedState(kv, resourceKey);
  if (trusted !== undefined) {
    const recorded = await queryOperation(kv, resourceKey, request.operationId);
    const answered = assertCurrentSessionFence(
      trusted,
      request.bindingId,
      request.expectedControllerEpoch,
      request.operationId,
      recorded,
    );
    if (answered !== undefined && answered.state !== "absent")
      return { state: "recorded", operation: answered.record };
  }

  // The binding this executor wrote is the durable statement of which incarnation is under
  // management, so it is what a mutating operation is checked against. `request.expectedIncarnation`
  // cannot serve: a caller that has observed the replacement session asserts the replacement and
  // passes. A released binding is excluded, because re-adopting after re-enrollment legitimately
  // carries a renewed proof and the enrollment is the artifact that renews it.
  if (existing !== undefined && existing.binding.state !== "released"
    && classifyIncarnationProof(existing.binding.incarnationProof, observedProof) === "identity-unproven")
    return { state: "identity-unproven", reason: `native incarnation differs from the one bound as ${existing.binding.bindingId}; the managed session has been replaced` };

  // After the fence, never before it: a replay whose operation is already recorded must return
  // that answer, not be refused a second time by an enrollment that has since expired.
  let enrolledRights: readonly SessionManageAction[] | undefined;
  if (ENROLLMENT_GOVERNED.has(request.operation)) {
    const enrolled = await authorizeAgainstEnrollment(kv, request, resourceKey, observedProof, mutatingAction(request.operation));
    if ("state" in enrolled) return enrolled;
    enrolledRights = enrolled.rights;
  }

  const incarnationProof = existing?.binding.state === "released" || existing === undefined
    ? observedProof
    : existing.binding.incarnationProof;
  const prepared = await prepareSessionOperation(kv, {
    operationId: request.operationId,
    resourceKey,
    incarnationProof,
    bindingId: request.bindingId,
    expectedBindingRevision: request.expectedBindingRevision,
    expectedControllerEpoch: request.expectedControllerEpoch,
    authenticatedActor: request.authenticatedActor,
    action: mutatingAction(request.operation),
    intendedResult: request.intendedResult,
  });

  // A released binding being re-released keeps the rights it already had; every other path to a
  // fresh binding is enrollment-governed, so there is no set of rights to invent here.
  const bindingRights = enrolledRights ?? existing?.binding.rights;
  if (bindingRights === undefined)
    throw new EpEnvelopeError("internal", `native lifecycle ${request.operation} reached binding creation with neither enrolled nor existing rights`);
  const nextBinding: Binding = existing !== undefined && existing.binding.state !== "released"
    ? existing.binding
    : {
      bindingId: request.bindingId,
      resourceKey,
      incarnationProof,
      controllerEpoch: request.expectedControllerEpoch,
      managerPrincipal: request.managerPrincipal,
      mode: connection.capabilities.mode,
      rights: bindingRights,
      state: "adopt-prepared",
      operationId: request.operationId,
      desiredRevision: existing?.binding.desiredRevision ?? 0,
    };
  if (existing === undefined) await persistBinding(kv, nextBinding);
  else if (request.operation === "adopt") await persistBinding(kv, nextBinding, existing.revision);

  let native: NativeLifecycleOperationResult;
  try {
    const mutate = method as NonNullable<NativeLifecycleConnection["adopt" | "release" | "transfer" | "recover"]>;
    native = await mutate(nextBinding, prepared.record, request.signal);
  } catch (e) {
    return persistIndeterminate(kv, prepared.record, e instanceof Error ? e.message : "native provider threw");
  }
  if (native.state === "recorded") {
    if (!samePreparedIdentity(prepared.record, native.operation))
      return persistIndeterminate(kv, prepared.record, "provider recorded receipt does not match prepared resourceKey/bindingId/operationId");
    if (native.operation.state === "terminal-success") {
      const proves = native.operation.proofOrigin?.proves;
      if (proves !== "native-effect" && proves !== "cooperative-retirement")
        return persistIndeterminate(kv, prepared.record, "provider returned terminal-success without native-effect or cooperative-retirement proof");
    }
    const stored: SessionOperationRecord = {
      ...prepared.record,
      state: native.operation.state,
      ...(native.operation.result !== undefined ? { result: native.operation.result } : {}),
      ...(native.operation.proofOrigin !== undefined ? { proofOrigin: native.operation.proofOrigin } : {}),
    };
    const revision = await operationRevision(kv, prepared.record.resourceKey, prepared.record.operationId);
    await updateSessionOperation(kv, stored, revision);
    const durable = await queryOperation(kv, prepared.record.resourceKey, prepared.record.operationId);
    if (durable.state === "absent")
      throw new EpEnvelopeError("internal", `session operation ${prepared.record.operationId} vanished after receipt persist`);
    if (durable.state === "terminal-success") {
      const current = await readBinding(kv, prepared.record.resourceKey);
      if (current === undefined)
        throw new EpEnvelopeError("internal", `session binding vanished after ${request.operation} receipt persist`);
      if (mayAdvanceBinding(current.binding, durable, request.operation)) {
        const nextState = request.operation === "release" ? "released" : request.operation === "adopt" ? "managed" : current.binding.state;
        if (nextState !== current.binding.state || current.binding.operationId !== prepared.record.operationId) {
          await persistBinding(kv, {
            ...current.binding,
            state: nextState,
            operationId: prepared.record.operationId,
          }, current.revision);
        }
      }
    }
    return { state: "recorded", operation: durable.record };
  }
  return persistIndeterminate(kv, prepared.record, native.state === "absent" ? "mutating provider returned absent" : native.reason);
}
