import { createHash } from "node:crypto";
import {
  NativeLifecycleUnsupported, parseResourceKey, registry, resourceKeyId,
  type NativeLifecycleCapabilities, type NativeLifecycleConnection, type NativeLifecycleObservation,
  type NativeLifecycleOperation, type NativeLifecycleOperationResult, type NativeLifecyclePreflight,
  type NativeLifecycleProvider, type NativeLifecycleView, type ResourceKey, type SessionOperationRecord,
} from "@cotal-ai/core";
import { OpenCodeNativeApi, OpenCodeNativeApiError, type OpenCodeNativeApiOptions, type OpenCodeNativeSession, type OpenCodeNativeStatus } from "./native-api.js";

export interface OpenCodeLifecycleOptions extends OpenCodeNativeApiOptions {
  /** Trusted local configuration, never an identity claim accepted from native discovery. */
  readonly hostIdentity: string;
  readonly nativeOwnerNamespace: string;
}

const optionKeys = new Set(["endpoint", "username", "password", "timeoutMs", "maxResponseBytes", "hostIdentity", "nativeOwnerNamespace"]);
function options(value: unknown): OpenCodeLifecycleOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OpenCodeNativeApiError("invalid-config");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !optionKeys.has(key)) || typeof input.endpoint !== "string"
    || typeof input.hostIdentity !== "string" || !input.hostIdentity.length
    || typeof input.nativeOwnerNamespace !== "string" || !input.nativeOwnerNamespace.length
    || input.hostIdentity.length > 8192 || input.nativeOwnerNamespace.length > 8192
    || ["username", "password"].some(key => input[key] !== undefined && typeof input[key] !== "string")
    || ["timeoutMs", "maxResponseBytes"].some(key => input[key] !== undefined && typeof input[key] !== "number"))
    throw new OpenCodeNativeApiError("invalid-config");
  return input as unknown as OpenCodeLifecycleOptions;
}

/** Native APIs expose persisted sessions, not proof that a particular native process is alive.
 * Keep discovery observed-only until the executor supplies verified host/incarnation authority. */
export class OpenCodeLifecycleConnection implements NativeLifecycleConnection {
  readonly capabilities: NativeLifecycleCapabilities = Object.freeze({
    mode: "observed",
    acknowledgedControlFence: "unsupported",
    operations: Object.freeze(["discover", "inspect", "preflight", "openView", "queryOperation"] as const),
  });
  readonly #api: OpenCodeNativeApi;
  readonly #hostIdentity: string;
  readonly #namespace: string;
  readonly #credentialRequired: boolean;

  constructor(config: OpenCodeLifecycleOptions) {
    const input = options(config);
    this.#api = new OpenCodeNativeApi(input);
    this.#hostIdentity = input.hostIdentity;
    this.#namespace = input.nativeOwnerNamespace;
    this.#credentialRequired = input.password !== undefined;
  }

  #key(session: OpenCodeNativeSession): ResourceKey {
    // Excludes mutable timestamps, title, cwd, port and native host incarnation. Creation metadata
    // helps identify a stored resource but cannot establish its current process incarnation.
    const resourceGeneration = createHash("sha256")
      .update(JSON.stringify([session.projectID, session.id, session.createdAt])).digest("hex");
    return parseResourceKey({
      hostIdentity: this.#hostIdentity, provider: "opencode", nativeOwnerNamespace: this.#namespace,
      stableSessionId: session.id, resourceGeneration,
    });
  }

  #observation(session: OpenCodeNativeSession, status: OpenCodeNativeStatus | undefined, version: string): NativeLifecycleObservation {
    return {
      resourceKey: this.#key(session), directory: session.directory,
      execution: "unknown", activity: status?.type === "busy" || status?.type === "retry" ? "busy" : status?.type === "idle" ? "idle" : "unknown",
      mesh: "unknown", providerVersion: version,
      evidence: { kind: "native-api-readback", projectID: session.projectID, createdAt: session.createdAt,
        ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
        ...(session.archivedAt === undefined ? {} : { archivedAt: session.archivedAt }),
        hostIncarnation: "unavailable", managementAuthority: "not-established" },
    };
  }

  async discover(signal?: AbortSignal): Promise<readonly NativeLifecycleObservation[]> {
    const health = await this.#api.health(signal);
    const sessions = await this.#api.sessions(signal);
    const statuses = await this.#api.statuses(signal);
    return sessions.map(session => this.#observation(session, statuses[session.id], health.version));
  }

  async inspect(resource: ResourceKey, signal?: AbortSignal): Promise<NativeLifecycleObservation> {
    const expected = parseResourceKey(resource);
    if (expected.provider !== "opencode" || expected.hostIdentity !== this.#hostIdentity
      || expected.nativeOwnerNamespace !== this.#namespace)
      throw new OpenCodeNativeApiError("invalid-session");
    const health = await this.#api.health(signal);
    const session = await this.#api.session(expected.stableSessionId, signal);
    if (resourceKeyId(this.#key(session)) !== resourceKeyId(expected))
      throw new OpenCodeNativeApiError("invalid-session");
    const statuses = await this.#api.statuses(signal);
    return this.#observation(session, statuses[session.id], health.version);
  }

  async preflight(operation: NativeLifecycleOperation, resource: ResourceKey, signal?: AbortSignal): Promise<NativeLifecyclePreflight> {
    // Refuse writes before even a native read. An HTTP health response cannot enroll a session.
    if (!["discover", "inspect", "preflight", "openView", "queryOperation"].includes(operation))
      return { ok: false, code: "identity-unproven", reason: "OpenCode's API exposes no native host incarnation or exclusive management authority; verified enrollment is required" };
    return { ok: true, observation: await this.inspect(resource, signal) };
  }

  async openView(resource: ResourceKey, signal?: AbortSignal): Promise<NativeLifecycleView> {
    const observation = await this.inspect(resource, signal);
    return { kind: "native-command", command: "opencode",
      args: ["attach", this.#api.endpoint, "--session", observation.resourceKey.stableSessionId],
      credentialRequired: this.#credentialRequired };
  }

  async queryOperation(_operation: SessionOperationRecord, _signal?: AbortSignal): Promise<NativeLifecycleOperationResult> {
    // Session state cannot prove that a specific operation ID was applied by the native server.
    return { state: "indeterminate", reason: "OpenCode has no operation-ID receipt API; consult the trusted management journal" };
  }

  async adopt(): Promise<never> { throw new NativeLifecycleUnsupported("adopt"); }
  async release(): Promise<never> { throw new NativeLifecycleUnsupported("release"); }
  async transfer(): Promise<never> { throw new NativeLifecycleUnsupported("transfer"); }
  async recover(): Promise<never> { throw new NativeLifecycleUnsupported("recover"); }
}

export const openCodeLifecycleProvider: NativeLifecycleProvider = {
  kind: "native-lifecycle", name: "opencode",
  connect(config: unknown): OpenCodeLifecycleConnection { return new OpenCodeLifecycleConnection(options(config)); },
};
registry.register(openCodeLifecycleProvider);
