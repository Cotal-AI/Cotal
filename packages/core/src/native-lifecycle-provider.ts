import type { Extension } from "./registry.js";
import { registry } from "./registry.js";
import type { Binding, IncarnationProof, ResourceKey, SessionManagementMode, SessionOperationRecord } from "./session-lifecycle-records.js";

/** Optional native-owner adapter. Authentication, binding CAS and operation journalling belong
 * to the trusted management executor. A provider never grants ownership by discovery. */
export interface NativeLifecycleProvider extends Extension {
  readonly kind: "native-lifecycle";
  connect(options: unknown): NativeLifecycleConnection;
}

export interface NativeLifecycleObservation {
  readonly resourceKey: ResourceKey;
  /** Absent when the native API cannot establish the current host incarnation. */
  readonly incarnationProof?: IncarnationProof;
  readonly directory: string;
  readonly execution: "running" | "exited" | "unknown";
  readonly activity: "idle" | "busy" | "unknown";
  readonly mesh: "absent" | "joined" | "disconnected" | "unknown";
  readonly providerVersion: string;
  readonly evidence: unknown;
}

export type NativeLifecycleOperation =
  | "discover" | "inspect" | "preflight" | "adopt" | "release"
  | "transfer" | "recover" | "openView" | "queryOperation";

export interface NativeLifecycleCapabilities {
  readonly mode: SessionManagementMode;
  readonly acknowledgedControlFence: "unsupported" | "receiver-fenced";
  readonly operations: readonly NativeLifecycleOperation[];
}

export type NativeLifecyclePreflight =
  | { readonly ok: true; readonly observation: NativeLifecycleObservation }
  | { readonly ok: false; readonly code: "unsupported" | "identity-unproven" | "identity-mismatch" | "authority-required" | "independence-unproven"; readonly reason: string };

/** A viewer description contains no credential and opening it cannot acquire management rights. */
export interface NativeLifecycleView {
  readonly kind: "native-command";
  readonly command: string;
  readonly args: readonly string[];
  readonly credentialRequired: boolean;
}

export type NativeLifecycleOperationResult =
  | { readonly state: "absent" }
  | { readonly state: "indeterminate"; readonly reason: string }
  | { readonly state: "recorded"; readonly operation: SessionOperationRecord };

export interface NativeLifecycleConnection {
  readonly capabilities: NativeLifecycleCapabilities;
  discover?(signal?: AbortSignal): Promise<readonly NativeLifecycleObservation[]>;
  inspect?(resource: ResourceKey, signal?: AbortSignal): Promise<NativeLifecycleObservation>;
  preflight?(operation: NativeLifecycleOperation, resource: ResourceKey, signal?: AbortSignal): Promise<NativeLifecyclePreflight>;
  adopt?(binding: Binding, operation: SessionOperationRecord, signal?: AbortSignal): Promise<NativeLifecycleOperationResult>;
  release?(binding: Binding, operation: SessionOperationRecord, signal?: AbortSignal): Promise<NativeLifecycleOperationResult>;
  transfer?(binding: Binding, operation: SessionOperationRecord, signal?: AbortSignal): Promise<NativeLifecycleOperationResult>;
  recover?(binding: Binding, operation: SessionOperationRecord, signal?: AbortSignal): Promise<NativeLifecycleOperationResult>;
  openView?(resource: ResourceKey, signal?: AbortSignal): Promise<NativeLifecycleView>;
  queryOperation?(operation: SessionOperationRecord, signal?: AbortSignal): Promise<NativeLifecycleOperationResult>;
}

export class NativeLifecycleUnsupported extends Error {
  constructor(readonly operation: NativeLifecycleOperation) {
    super(`Native lifecycle operation ${operation} is unsupported by this provider configuration`);
    this.name = "NativeLifecycleUnsupported";
  }
}

/** Resolve through the existing extension registry. No provider name or native implementation
 * belongs in core; unknown and absent operations fail before any provider effect. */
export function resolveNativeLifecycleProvider(name: string): NativeLifecycleProvider {
  return registry.resolve<NativeLifecycleProvider>("native-lifecycle", name);
}

export function requireNativeLifecycleOperation<K extends NativeLifecycleOperation>(
  connection: NativeLifecycleConnection,
  operation: K,
): NonNullable<NativeLifecycleConnection[K]> {
  const method = connection[operation];
  if (!connection.capabilities.operations.includes(operation) || typeof method !== "function")
    throw new NativeLifecycleUnsupported(operation);
  return method.bind(connection) as NonNullable<NativeLifecycleConnection[K]>;
}
