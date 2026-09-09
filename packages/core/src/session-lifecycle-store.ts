/**
 * Store operations for native session lifecycle records.
 *
 * This is storage CAS and idempotency, not provider-effect sequencing. The manager/provider executor
 * decides transitions and supplies the expected record revision. This module only preserves §4's
 * operation-id fence, epoch floor, retired binding ids, and rollback read-only invariant.
 */
import type { KV } from "@nats-io/kv";
import type { KvEntry } from "@nats-io/kv";
import { canonicalJson } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { createRecordEntry, updateRecordEntry } from "./endpoint-records.js";
import { latestKvEntries } from "./kv-scan.js";
import { parsePrincipalKey } from "./subjects.js";
import {
  parseBinding,
  parseSessionOperation,
  parseSessionTrustedState,
  resourceKeyId,
  sessionOperationInput,
  sessionOperationInputDigest,
  sessionOperationKey,
  sessionTrustStateKey,
  type ResourceKey,
  type Binding,
  type SessionOperationRecord,
  type SessionOperationState,
  type SessionTrustedState,
} from "./session-lifecycle-records.js";

const SESSION_OPERATION_STATE_RANK: Record<SessionOperationState, number> = {
  prepared: 0,
  executing: 1,
  "terminal-success": 2,
  "terminal-refusal": 2,
  indeterminate: 2,
};

function assertSessionOperationStateMonotonic(from: SessionOperationState, to: SessionOperationState): void {
  if (
    SESSION_OPERATION_STATE_RANK[to] < SESSION_OPERATION_STATE_RANK[from]
    || (SESSION_OPERATION_STATE_RANK[from] >= 2 && from !== to)
  ) {
    throw new EpEnvelopeError(
      "conflict",
      `session operation cannot regress from ${from} to ${to}; persist the receipt and never replay`,
    );
  }
}

export type NativeLifecycleBindingLookup =
  | { readonly status: "known"; readonly bindings: readonly Binding[] }
  | { readonly status: "unknown"; readonly bindings: readonly []; readonly reason: string };

export type QueryOperationResult =
  | { readonly state: "absent" }
  | { readonly state: SessionOperationRecord["state"]; readonly result?: unknown; readonly proofOrigin?: SessionOperationRecord["proofOrigin"]; readonly record: SessionOperationRecord };

function encoded(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

async function rawPut(kv: KV, key: string, value: unknown, expectedRevision?: number): Promise<number> {
  return expectedRevision === undefined
    ? await createRecordEntry(kv, key, value)
    : await updateRecordEntry(kv, key, value, expectedRevision);
}

/** Read one operation. An absent row is the only `absent` answer. Tombstones and malformed rows fail. */
export async function queryOperation(kv: KV, resourceKey: ResourceKey, operationId: string): Promise<QueryOperationResult> {
  const key = sessionOperationKey(resourceKey, operationId);
  const entry = await kv.get(key);
  if (!entry) return { state: "absent" };
  if (entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `session operation ${key} carries a ${entry.operation} marker; operation fences are never garbage-collected automatically`);
  const record = parseSessionOperation(entry.value, key, resourceKey);
  return {
    state: record.state,
    ...(record.result !== undefined ? { result: record.result } : {}),
    ...(record.proofOrigin !== undefined ? { proofOrigin: record.proofOrigin } : {}),
    record,
  };
}

async function assertStoredSessionManagementWritable(kv: KV, resourceKey: ResourceKey): Promise<void> {
  const current = await readSessionTrustedState(kv, resourceKey);
  if (current !== undefined) assertSessionManagementWritable(current);
}

/**
 * Create the prepared operation fence. Retrying the exact same input returns the recorded row;
 * reusing its operationId with different input refuses and never overwrites the first transition.
 * A store already in management-recovery-read-only cannot create a new row; an identical retry
 * may still return the recorded fence.
 */
export async function prepareSessionOperation(
  kv: KV,
  value: Omit<SessionOperationRecord, "inputDigest" | "state" | "result" | "proofOrigin">,
): Promise<{ readonly created: boolean; readonly record: SessionOperationRecord }> {
  const input = sessionOperationInput(value);
  const key = sessionOperationKey(value.resourceKey, value.operationId);
  const record = parseSessionOperation(encoded({ ...value, inputDigest: sessionOperationInputDigest(input), state: "prepared" }), key, value.resourceKey);
  const existing = await queryOperation(kv, value.resourceKey, value.operationId);
  if (existing.state !== "absent") {
    if (existing.record.inputDigest !== record.inputDigest)
      throw new EpEnvelopeError("conflict", `operationId ${value.operationId} is already bound to different transition input for resource ${resourceKeyId(value.resourceKey)}`);
    return { created: false, record: existing.record };
  }
  await assertStoredSessionManagementWritable(kv, value.resourceKey);
  try {
    await createRecordEntry(kv, key, record);
    return { created: true, record };
  } catch (e) {
    if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e;
    const raced = await queryOperation(kv, value.resourceKey, value.operationId);
    if (raced.state === "absent")
      throw new EpEnvelopeError("internal", `session operation ${key} lost its create CAS but is not readable; reconcile the store`);
    if (raced.record.inputDigest !== record.inputDigest)
      throw new EpEnvelopeError("conflict", `operationId ${value.operationId} is already bound to different transition input for resource ${resourceKeyId(value.resourceKey)}`);
    return { created: false, record: raced.record };
  }
}

/** Revision-pinned state update. Immutable input and digest cannot move between phases. */
export async function updateSessionOperation(
  kv: KV,
  value: SessionOperationRecord,
  expectedRevision: number,
): Promise<number> {
  const parsed = parseSessionOperation(encoded(value), sessionOperationKey(value.resourceKey, value.operationId), value.resourceKey);
  const existing = await queryOperation(kv, parsed.resourceKey, parsed.operationId);
  if (existing.state === "absent")
    throw new EpEnvelopeError("conflict", `session operation ${parsed.operationId} cannot advance because its prepared input fence is absent`);
  if (existing.record.inputDigest !== parsed.inputDigest || !sameSessionOperationInput(existing.record, parsed))
    throw new EpEnvelopeError("conflict", `operationId ${parsed.operationId} is already bound to different transition input and cannot be rewritten during a phase update`);
  assertSessionOperationStateMonotonic(existing.record.state, parsed.state);
  await assertStoredSessionManagementWritable(kv, parsed.resourceKey);
  return await updateRecordEntry(kv, sessionOperationKey(parsed.resourceKey, parsed.operationId), parsed, expectedRevision);
}

export async function readSessionTrustedState(kv: KV, resourceKey: ResourceKey): Promise<(SessionTrustedState & { readonly revision: number }) | undefined> {
  const key = sessionTrustStateKey(resourceKey);
  const entry = await kv.get(key);
  if (!entry) return undefined;
  if (entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `session trust state ${key} carries a ${entry.operation} marker; epoch floors and retired binding ids have no automatic tombstone GC`);
  return { ...parseSessionTrustedState(entry.value, key, resourceKey), revision: entry.revision };
}

/**
 * Persist the monotonic trusted state. A lower floor is a restored/rolled-back view and forces the
 * record into management-recovery-read-only rather than resetting native authority. Retired ids are
 * unioned forever in this implementation, including across release and re-adoption.
 *
 * Detectable rollback is a live native observation above the stored floor, or an unknown native
 * floor. Both force recovery-read-only and raise the stored floor to the observed value. A store
 * whose only remaining row is an older floor that the current native observation AGREES with is
 * not distinguishable from a store that was always at that floor: there is no durable watermark
 * older than the row itself. This function does not invent one, so that residual stays writable.
 * Fail closed on the cases that can actually be seen.
 */
export async function advanceSessionTrustedState(
  kv: KV,
  resourceKey: ResourceKey,
  requested: { readonly epochFloor: number; readonly retireBindingIds?: readonly string[]; readonly observedNativeEpochFloor: number | "unknown" },
): Promise<SessionTrustedState & { readonly revision: number }> {
  const current = await readSessionTrustedState(kv, resourceKey);
  const priorFloor = current?.epochFloor ?? 0;
  const nativeFloorUnknown = requested.observedNativeEpochFloor === "unknown";
  const observedNativeFloor = nativeFloorUnknown ? 0 : requested.observedNativeEpochFloor;
  const rollbackObserved = nativeFloorUnknown || observedNativeFloor > Math.max(priorFloor, requested.epochFloor);
  const epochFloor = Math.max(priorFloor, requested.epochFloor, observedNativeFloor);
  const retiredBindingIds = [...new Set([...(current?.retiredBindingIds ?? []), ...(requested.retireBindingIds ?? [])])].sort();
  const proposed: SessionTrustedState = {
    resourceKey,
    epochFloor,
    retiredBindingIds,
    managementMode: rollbackObserved || current?.managementMode === "management-recovery-read-only"
      ? "management-recovery-read-only"
      : "writable",
  };
  const key = sessionTrustStateKey(resourceKey);
  const value = parseSessionTrustedState(encoded(proposed), key, resourceKey);
  const revision = await rawPut(kv, key, value, current?.revision);
  return { ...value, revision };
}

export function assertSessionManagementWritable(state: SessionTrustedState): void {
  if (state.managementMode !== "writable")
    throw new EpEnvelopeError("failed-precondition", `native session management is recovery-read-only for resource ${resourceKeyId(state.resourceKey)}; reconcile native epochs and outstanding operations before writes`);
}

/** Refuse stale work before any provider effect. A known retry may instead be answered by its receipt. */
export function assertCurrentSessionFence(
  state: SessionTrustedState,
  bindingId: string,
  controllerEpoch: number,
  operationId: string,
  recordedReceipt?: QueryOperationResult,
): QueryOperationResult | undefined {
  assertSessionManagementWritable(state);
  if (state.retiredBindingIds.includes(bindingId) || controllerEpoch < state.epochFloor) {
    if (
      recordedReceipt !== undefined
      && recordedReceipt.state !== "absent"
      && recordedReceipt.record.bindingId === bindingId
      && recordedReceipt.record.operationId === operationId
    ) return recordedReceipt;
    throw new EpEnvelopeError("conflict", `stale native session operation: binding ${bindingId} is retired or epoch ${controllerEpoch} is below floor ${state.epochFloor}; it cannot act on a new binding`);
  }
  return undefined;
}

/** Exact equality helper used by tests/executors when reconciling an existing operation. */
export function sameSessionOperationInput(a: SessionOperationRecord, b: SessionOperationRecord): boolean {
  return canonicalJson(sessionOperationInput(a)) === canonicalJson(sessionOperationInput(b));
}

/**
 * Complete durable lookup of native lifecycle bindings held by one manager. Only the registered
 * `sessionbinding.*` family is scanned, so legacy managed seats retain their existing shutdown
 * behavior. Any scan failure or malformed row returns `unknown`, never a confident empty set.
 */
export async function lookupNativeLifecycleBindingsForManager(
  kv: KV,
  managerPrincipal: string,
  scan: (kv: KV, filter?: string | string[]) => Promise<KvEntry[]> = latestKvEntries,
): Promise<NativeLifecycleBindingLookup> {
  try {
    if (parsePrincipalKey(managerPrincipal) === null)
      throw new EpEnvelopeError("failed-precondition", `manager principal ${JSON.stringify(managerPrincipal)} is not canonical owner.actor identity`);
    const entries = await scan(kv, "sessionbinding.*");
    const bindings: Binding[] = [];
    for (const entry of entries) {
      if (entry.operation !== "PUT")
        throw new EpEnvelopeError("failed-precondition", `native lifecycle binding ${entry.key} carries a ${entry.operation} marker`);
      const binding = parseBinding(entry.value, entry.key);
      if (binding.managerPrincipal !== managerPrincipal) continue;
      if (binding.state !== "released") {
        bindings.push(binding);
        continue;
      }
      // A `released` label alone is not sufficient for the destructive-shutdown decision. The
      // bound release operation must itself be terminal-success with native-effect proof; absent,
      // pending, refusal or indeterminate records all mean this binding may still be live.
      const release = await queryOperation(kv, binding.resourceKey, binding.operationId);
      if (release.state !== "terminal-success" || release.record.action !== "release"
        || release.record.bindingId !== binding.bindingId
        || release.proofOrigin?.proves !== "native-effect") bindings.push(binding);
    }
    return { status: "known", bindings: Object.freeze(bindings) };
  } catch (e) {
    return { status: "unknown", bindings: [], reason: (e as Error).message };
  }
}

/**
 * Shutdown guard predicate. `true` means a native binding exists OR the durable answer could not be
 * proven. This fail-closed direction is intentional: callers may signal only on a proven `false`.
 */
export async function hasLiveNativeLifecycleBindingsForManager(
  kv: KV,
  managerPrincipal: string,
  scan?: (kv: KV, filter?: string | string[]) => Promise<KvEntry[]>,
): Promise<boolean> {
  const result = await lookupNativeLifecycleBindingsForManager(kv, managerPrincipal, scan);
  return result.status === "unknown" || result.bindings.length > 0;
}
