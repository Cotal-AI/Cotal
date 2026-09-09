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
} from "./native-lifecycle-provider.js";
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
  updateSessionOperation,
} from "./session-lifecycle-store.js";

const MUTATING: ReadonlySet<NativeLifecycleOperation> = new Set(["adopt", "release", "transfer", "recover"]);

export type NativeLifecycleDispatchResult =
  | NativeLifecycleOperationResult
  | { readonly state: "unsupported"; readonly operation: NativeLifecycleOperation }
  | { readonly state: "identity-unproven"; readonly reason: string }
  | { readonly state: "observations"; readonly observations: readonly NativeLifecycleObservation[] }
  | { readonly state: "observation"; readonly observation: NativeLifecycleObservation };

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

function sameResource(a: ResourceKey, b: ResourceKey): boolean {
  return resourceKeyId(a) === resourceKeyId(b);
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
  let dispatched: ReturnType<typeof requireNativeLifecycleOperation> | undefined;
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
    return { state: "observations", observations };
  }
  if (request.operation === "inspect") {
    const observation = await (method as NonNullable<NativeLifecycleConnection["inspect"]>)(resourceKey, request.signal);
    return { state: "observation", observation };
  }
  if (request.operation === "openView") {
    await (method as NonNullable<NativeLifecycleConnection["openView"]>)(resourceKey, request.signal);
    return { state: "absent" };
  }
  if (request.operation === "preflight") {
    await (method as NonNullable<NativeLifecycleConnection["preflight"]>)("inspect", resourceKey, request.signal);
    return { state: "absent" };
  }
  if (request.operation === "queryOperation") {
    const recorded = await queryOperation(kv, resourceKey, request.operationId);
    if (recorded.state === "absent") return { state: "absent" };
    return await (method as NonNullable<NativeLifecycleConnection["queryOperation"]>)(recorded.record, request.signal);
  }

  if (!MUTATING.has(request.operation))
    throw new EpEnvelopeError("internal", `native lifecycle ${request.operation} is not a known mutating operation`);

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

  const existing = await readBinding(kv, resourceKey);
  if (request.operation === "adopt" && existing !== undefined && existing.binding.state !== "released")
    throw new EpEnvelopeError("conflict", `resource ${resourceKey.stableSessionId} is already bound as ${existing.binding.bindingId}; use transfer`);
  if (request.operation !== "adopt" && existing === undefined)
    throw new EpEnvelopeError("failed-precondition", `native lifecycle ${request.operation} requires an existing binding`);

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

  const nextBinding: Binding = existing !== undefined && existing.binding.state !== "released"
    ? existing.binding
    : {
      bindingId: request.bindingId,
      resourceKey,
      incarnationProof,
      controllerEpoch: request.expectedControllerEpoch,
      managerPrincipal: request.managerPrincipal,
      mode: connection.capabilities.mode,
      rights: ["discover", "adopt", "control", "release", "transfer"],
      state: "adopt-prepared",
      operationId: request.operationId,
      desiredRevision: existing?.binding.desiredRevision ?? 0,
    };
  if (existing === undefined) await persistBinding(kv, nextBinding);
  else if (request.operation === "adopt") await persistBinding(kv, nextBinding, existing.revision);

  let native: NativeLifecycleOperationResult;
  try {
    native = await (method as NonNullable<NativeLifecycleConnection["adopt"]>)(nextBinding, prepared.record, request.signal);
  } catch (e) {
    return persistIndeterminate(kv, prepared.record, e instanceof Error ? e.message : "native provider threw");
  }
  if (native.state === "recorded") return native;
  if (native.state === "absent") return native;
  return persistIndeterminate(kv, prepared.record, native.reason);
}
