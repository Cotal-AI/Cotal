/** Broker-free executor smoke. One cell drives the public registry entry with nothing injected. */
import type { KV } from "@nats-io/kv";
import {
  EpEnvelopeError,
  executeNativeLifecycle,
  queryOperation,
  registry,
  sessionBindingKey,
  type Binding,
  type NativeLifecycleConnection,
  type NativeLifecycleObservation,
  type NativeLifecycleOperation,
  type NativeLifecycleOperationResult,
  type NativeLifecyclePreflight,
  type NativeLifecycleProvider,
  type NativeLifecycleView,
  type ResourceKey,
  type SessionManageGrant,
  type SessionOperationRecord,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (name: string, value: boolean, extra?: unknown) => {
  if (value) ok++;
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};
const rejects = async (name: string, fn: () => Promise<unknown>, code: string) => {
  try { await fn(); c(name, false, "no throw"); }
  catch (e) { c(name, e instanceof EpEnvelopeError && e.code === code, (e as Error).message); }
};

type Row = { value: Uint8Array; revision: number; operation: "PUT" };
class MemKv {
  rows = new Map<string, Row>(); seq = 0;
  async get(key: string) { return this.rows.get(key) as never; }
  async put(key: string, value: Uint8Array, opts?: { previousSeq?: number }) {
    const row = this.rows.get(key);
    if ((opts?.previousSeq ?? -1) !== 0 || row) throw Object.assign(new Error("cas"), { code: 10071 });
    const revision = ++this.seq; this.rows.set(key, { value, revision, operation: "PUT" }); return revision;
  }
  async update(key: string, value: Uint8Array, expected: number) {
    const row = this.rows.get(key);
    if (!row || row.revision !== expected) throw Object.assign(new Error("cas"), { code: 10071 });
    const revision = ++this.seq; this.rows.set(key, { value, revision, operation: "PUT" }); return revision;
  }
}

const OWNER = "u_alice.operator";
const MANAGER = "u_alice.manager";
const resource: ResourceKey = {
  hostIdentity: "host-1", provider: "com.cotal.test", nativeOwnerNamespace: "uid:1000",
  stableSessionId: "session-1", resourceGeneration: "created-1",
};
const proof = { nativeHostIncarnation: "h-1", sessionIncarnation: "s-1", evidence: { immutable: "x" } };
const observation = (extra: Partial<NativeLifecycleObservation> = {}): NativeLifecycleObservation => ({
  resourceKey: resource, incarnationProof: proof, directory: "/tmp/session-1",
  execution: "running", activity: "idle", mesh: "absent", providerVersion: "test-1", evidence: { pid: 1 },
  ...extra,
});
const grant: SessionManageGrant = {
  v: 1, family: "session-manage", ownerPrincipal: OWNER, targetManagerPrincipal: MANAGER,
  selector: {
    resourceOwnerPrincipal: OWNER, hostIdentity: "host-1", provider: "com.cotal.test",
    nativeOwnerNamespace: "uid:1000", stableSessionId: "session-1", resourceGeneration: "created-1",
  },
  actions: ["discover", "adopt", "control", "release", "transfer"], expiresAt: 10_000,
};
const requestBase = {
  resourceKey: resource, resourceOwnerPrincipal: OWNER, managerPrincipal: MANAGER,
  authenticatedActor: MANAGER, grant, authenticatedGrantIssuer: OWNER, now: 1_000,
  expectedBindingRevision: 0, expectedControllerEpoch: 1, intendedResult: { nativeState: "preserved" },
};

const effects: string[] = [];
function connection(ops: readonly NativeLifecycleOperation[], mode: NativeLifecycleConnection["capabilities"]["mode"] = "cooperative-exclusive"): NativeLifecycleConnection {
  const inspect = async () => { effects.push("inspect"); return observation(); };
  const discover = async () => { effects.push("discover"); return [observation()]; };
  const preflight = async (operation: NativeLifecycleOperation) => {
    effects.push(`preflight:${operation}`);
    return { ok: true, observation: observation() } satisfies NativeLifecyclePreflight;
  };
  const adopt = async (_binding: Binding, operation: SessionOperationRecord): Promise<NativeLifecycleOperationResult> => {
    effects.push("adopt");
    return {
      state: "recorded",
      operation: {
        ...operation,
        state: "terminal-success",
        result: { bound: true },
        proofOrigin: { kind: "native-readback", provider: "com.cotal.test", evidence: { bound: true }, proves: "native-effect" },
      },
    };
  };
  const queryOperationNative = async (): Promise<NativeLifecycleOperationResult> => {
    effects.push("queryOperation");
    return { state: "indeterminate", reason: "native acknowledgement lost" };
  };
  const openView = async (): Promise<NativeLifecycleView> => {
    effects.push("openView");
    return { kind: "native-command", command: "echo", args: ["session-1"], credentialRequired: false };
  };
  const conn: NativeLifecycleConnection = {
    capabilities: { mode, acknowledgedControlFence: "unsupported", operations: ops },
  };
  if (ops.includes("discover")) conn.discover = discover;
  if (ops.includes("inspect")) conn.inspect = inspect;
  if (ops.includes("preflight")) conn.preflight = preflight;
  if (ops.includes("adopt")) conn.adopt = adopt;
  if (ops.includes("queryOperation")) conn.queryOperation = queryOperationNative;
  if (ops.includes("openView")) conn.openView = openView;
  if (ops.includes("release")) conn.release = async () => { effects.push("release"); throw new Error("native acknowledgement lost"); };
  return conn;
}

function register(name: string, ops: readonly NativeLifecycleOperation[], mode: NativeLifecycleConnection["capabilities"]["mode"] = "cooperative-exclusive"): void {
  const provider: NativeLifecycleProvider = {
    kind: "native-lifecycle",
    name,
    connect: () => connection(ops, mode),
  };
  registry.register(provider);
}

register("executor-coop", ["discover", "inspect", "preflight", "adopt", "release", "queryOperation", "openView"]);
register("executor-observed", ["discover", "inspect", "preflight", "adopt", "queryOperation"], "observed");
register("executor-missing-adopt", ["discover", "inspect"]);

console.log("A. public entry refuses before any native effect");
effects.length = 0;
await rejects("spawn is not a session-manage grant", () => executeNativeLifecycle(new MemKv() as unknown as KV, {
  ...requestBase, providerName: "executor-coop", operation: "adopt", operationId: "op-denied", bindingId: "binding-denied",
  grant: { ...grant, family: "spawn" },
}), "internal");
c("unauthorized adopt never reached the provider", effects.length === 0, effects);

effects.length = 0;
try {
  const missing = await executeNativeLifecycle(new MemKv() as unknown as KV, {
    ...requestBase, providerName: "executor-missing-adopt", operation: "adopt", operationId: "op-unsup", bindingId: "binding-unsup",
  });
  c("unsupported adopt is refused before inspect", missing.state === "unsupported" && missing.operation === "adopt", missing);
} catch (e) {
  c("unsupported adopt is refused before inspect", false, (e as Error).message);
}
c("unsupported adopt left no native inspect/adopt effects", effects.length === 0, effects);

effects.length = 0;
try {
  const observed = await executeNativeLifecycle(new MemKv() as unknown as KV, {
    ...requestBase, providerName: "executor-observed", operation: "adopt", operationId: "op-obs", bindingId: "binding-obs",
  });
  c("observed-mode adopt is refused before inspect", observed.state === "unsupported" && observed.operation === "adopt", observed);
} catch (e) {
  c("observed-mode adopt is refused before inspect", false, (e as Error).message);
}
c("observed-mode adopt left no native effects", effects.length === 0, effects);

console.log("B. production caller: executeNativeLifecycle -> registry.resolve, nothing injected");
effects.length = 0;
const kv = new MemKv() as unknown as KV;
const adopted = await executeNativeLifecycle(kv, {
  ...requestBase, providerName: "executor-coop", operation: "adopt", operationId: "op-adopt", bindingId: "binding-1",
});
c("adopt records a native-effect receipt through the public entry", adopted.state === "recorded" && adopted.operation.state === "terminal-success", adopted);
c("adopt journalled then dispatched inspect/preflight/adopt in order", effects.join(",") === "preflight:adopt,inspect,adopt", effects);
const prepared = await queryOperation(kv, resource, "op-adopt");
c("adopt prepare is durable in the trusted store", prepared.state === "prepared" || prepared.state === "terminal-success", prepared.state);
const bound = (kv as unknown as MemKv).rows.has(sessionBindingKey(resource));
c("adopt wrote a sessionbinding row", bound);

effects.length = 0;
const discovered = await executeNativeLifecycle(new MemKv() as unknown as KV, {
  ...requestBase, providerName: "executor-coop", operation: "discover", operationId: "op-disc", bindingId: "binding-disc",
});
c("discover returns observations through the public entry", discovered.state === "observations" && discovered.observations.length === 1, discovered);
c("discover did not write a binding", !(new MemKv() as unknown as MemKv).rows.has(sessionBindingKey(resource)));

console.log("C. lost native acknowledgement stays indeterminate");
effects.length = 0;
const kvRelease = new MemKv() as unknown as KV;
await executeNativeLifecycle(kvRelease, {
  ...requestBase, providerName: "executor-coop", operation: "adopt", operationId: "op-adopt-2", bindingId: "binding-2",
});
const lost = await executeNativeLifecycle(kvRelease, {
  ...requestBase, providerName: "executor-coop", operation: "release", operationId: "op-rel", bindingId: "binding-2",
  expectedBindingRevision: 1, expectedControllerEpoch: 1, intendedResult: { bindingState: "released" },
});
c("lost native release acknowledgement is indeterminate", lost.state === "indeterminate", lost);
const releaseRow = await queryOperation(kvRelease, resource, "op-rel");
c("indeterminate release is journalled, not invented as native-effect", releaseRow.state === "indeterminate" && releaseRow.proofOrigin === undefined, releaseRow);

console.log(`\n${ok} passed, ${fail} failed`);
if (fail) process.exit(1);
