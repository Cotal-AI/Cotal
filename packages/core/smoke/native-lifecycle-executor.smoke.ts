/** Broker-free executor smoke. One cell drives the public registry entry with nothing injected. */
import type { KV } from "@nats-io/kv";
import {
  EpEnvelopeError,
  executeNativeLifecycle,
  parseBinding,
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
  if (value) { ok++; console.log("  ✓", name); }
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

function bindingRevision(kv: MemKv, key = sessionBindingKey(resource)): number {
  const row = kv.rows.get(key);
  if (!row) throw new Error(`missing binding ${key}`);
  return row.revision;
}
function readBindingRow(kv: MemKv, key = sessionBindingKey(resource)): Binding | undefined {
  const row = kv.rows.get(key);
  if (!row) return undefined;
  return parseBinding(row.value, key, resource);
}
const otherResource: ResourceKey = { ...resource, stableSessionId: "session-other" };
const effects: string[] = [];
function connection(
  ops: readonly NativeLifecycleOperation[],
  mode: NativeLifecycleConnection["capabilities"]["mode"] = "cooperative-exclusive",
  kind: "ok" | "mismatch" | "lost-release" | "native-release" | "preflight-refuse" = "ok",
): NativeLifecycleConnection {
  const inspect = async () => { effects.push("inspect"); return observation(); };
  const discover = async () => {
    effects.push("discover");
    return [observation(), observation({ resourceKey: otherResource, directory: "/tmp/session-other" })];
  };
  const preflight = async (operation: NativeLifecycleOperation) => {
    effects.push(`preflight:${operation}`);
    if (kind === "preflight-refuse")
      return { ok: false, code: "authority-required", reason: "release needs exclusive mode" } satisfies NativeLifecyclePreflight;
    return { ok: true, observation: observation() } satisfies NativeLifecyclePreflight;
  };
  const adopt = async (_binding: Binding, operation: SessionOperationRecord): Promise<NativeLifecycleOperationResult> => {
    effects.push("adopt");
    const recorded = {
      ...operation,
      state: "terminal-success" as const,
      result: { bound: true },
      proofOrigin: { kind: "native-readback" as const, provider: "com.cotal.test", evidence: { bound: true }, proves: "native-effect" as const },
    };
    if (kind === "mismatch") return { state: "recorded", operation: { ...recorded, operationId: "op-forged" } };
    return { state: "recorded", operation: recorded };
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
  if (ops.includes("release")) {
    conn.release = async (_binding, operation) => {
      effects.push("release");
      if (kind === "lost-release") throw new Error("native acknowledgement lost");
      return {
        state: "recorded",
        operation: {
          ...operation,
          state: "terminal-success",
          result: { bindingState: "released", nativeState: "preserved" },
          proofOrigin: { kind: "native-readback", provider: "com.cotal.test", evidence: { released: true }, proves: "native-effect" },
        },
      };
    };
  }
  return conn;
}

function register(
  name: string,
  ops: readonly NativeLifecycleOperation[],
  mode: NativeLifecycleConnection["capabilities"]["mode"] = "cooperative-exclusive",
  kind: "ok" | "mismatch" | "lost-release" | "native-release" | "preflight-refuse" = "ok",
): void {
  const provider: NativeLifecycleProvider = {
    kind: "native-lifecycle",
    name,
    connect: () => connection(ops, mode, kind),
  };
  registry.register(provider);
}

const mutatingOps: readonly NativeLifecycleOperation[] = ["discover", "inspect", "preflight", "adopt", "release", "queryOperation", "openView"];
register("executor-coop", mutatingOps, "cooperative-exclusive", "lost-release");
register("executor-observed", ["discover", "inspect", "preflight", "adopt", "queryOperation"], "observed");
register("executor-missing-adopt", ["discover", "inspect"]);
register("executor-mismatch", ["inspect", "preflight", "adopt"], "cooperative-exclusive", "mismatch");
register("executor-native-release", mutatingOps, "cooperative-exclusive", "native-release");
register("executor-preflight-refuse", ["preflight"], "cooperative-exclusive", "preflight-refuse");

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
c("adopt returns a native-effect receipt through the public entry", adopted.state === "recorded" && adopted.operation.state === "terminal-success", adopted);
c("adopt journalled then dispatched inspect/preflight/adopt in order", effects.join(",") === "preflight:adopt,inspect,adopt", effects);
const prepared = await queryOperation(kv, resource, "op-adopt");
c("adopt native-effect receipt is durable in the trusted store", prepared.state === "terminal-success" && prepared.proofOrigin?.proves === "native-effect", prepared);
c("adopt wrote a managed sessionbinding row", readBindingRow(kv as unknown as MemKv)?.state === "managed");

effects.length = 0;
const kvDiscover = new MemKv();
const discovered = await executeNativeLifecycle(kvDiscover as unknown as KV, {
  ...requestBase, providerName: "executor-coop", operation: "discover", operationId: "op-disc", bindingId: "binding-disc",
});
c("discover returns observations through the public entry", discovered.state === "observations" && discovered.observations.length === 1, discovered);
c("discover dropped observations outside the grant selector", discovered.state === "observations" && discovered.observations.every((o) => o.resourceKey.stableSessionId === "session-1"), discovered);
c("discover did not write a binding", !kvDiscover.rows.has(sessionBindingKey(resource)));

effects.length = 0;
const viewed = await executeNativeLifecycle(new MemKv() as unknown as KV, {
  ...requestBase, providerName: "executor-coop", operation: "openView", operationId: "op-view", bindingId: "binding-view",
});
c("openView returns the NativeLifecycleView through the public entry", viewed.state === "view" && viewed.view.command === "echo" && viewed.view.credentialRequired === false, viewed);
c("openView reached the provider once", effects.join(",") === "openView", effects);

effects.length = 0;
const preflighted = await executeNativeLifecycle(new MemKv() as unknown as KV, {
  ...requestBase, providerName: "executor-preflight-refuse", operation: "preflight", operationId: "op-pre", bindingId: "binding-pre",
  targetOperation: "release",
});
c("preflight uses targetOperation and preserves the typed refusal", preflighted.state === "preflight" && preflighted.preflight.ok === false && preflighted.preflight.code === "authority-required", preflighted);
c("preflight dispatched the requested target operation", effects.join(",") === "preflight:release", effects);
await rejects("preflight without targetOperation is refused", () => executeNativeLifecycle(new MemKv() as unknown as KV, {
  ...requestBase, providerName: "executor-coop", operation: "preflight", operationId: "op-pre-missing", bindingId: "binding-pre-missing",
}), "internal");

console.log("C. lost native acknowledgement stays indeterminate");
effects.length = 0;
const kvRelease = new MemKv() as unknown as KV;
await executeNativeLifecycle(kvRelease, {
  ...requestBase, providerName: "executor-coop", operation: "adopt", operationId: "op-adopt-2", bindingId: "binding-2",
});
const lost = await executeNativeLifecycle(kvRelease, {
  ...requestBase, providerName: "executor-coop", operation: "release", operationId: "op-rel", bindingId: "binding-2",
  expectedBindingRevision: bindingRevision(kvRelease as unknown as MemKv), expectedControllerEpoch: 1, intendedResult: { bindingState: "released" },
});
c("lost native release acknowledgement is indeterminate", lost.state === "indeterminate", lost);
const releaseRow = await queryOperation(kvRelease, resource, "op-rel");
c("indeterminate release is journalled, not invented as native-effect", releaseRow.state === "indeterminate" && releaseRow.proofOrigin === undefined, releaseRow);

effects.length = 0;
const kvMismatch = new MemKv() as unknown as KV;
const mismatched = await executeNativeLifecycle(kvMismatch, {
  ...requestBase, providerName: "executor-mismatch", operation: "adopt", operationId: "op-mismatch", bindingId: "binding-mismatch",
});
c("mismatched recorded receipt stays indeterminate", mismatched.state === "indeterminate", mismatched);
const mismatchRow = await queryOperation(kvMismatch, resource, "op-mismatch");
c("mismatched receipt is not stored as terminal-success", mismatchRow.state === "indeterminate" && mismatchRow.proofOrigin === undefined, mismatchRow);

effects.length = 0;
const kvNativeRel = new MemKv() as unknown as KV;
await executeNativeLifecycle(kvNativeRel, {
  ...requestBase, providerName: "executor-native-release", operation: "adopt", operationId: "op-adopt-3", bindingId: "binding-3",
});
const released = await executeNativeLifecycle(kvNativeRel, {
  ...requestBase, providerName: "executor-native-release", operation: "release", operationId: "op-rel-ok", bindingId: "binding-3",
  expectedBindingRevision: bindingRevision(kvNativeRel as unknown as MemKv), expectedControllerEpoch: 1, intendedResult: { bindingState: "released", nativeState: "preserved" },
});
c("cooperative-exclusive release with native-effect is terminal-success", released.state === "recorded" && released.operation.state === "terminal-success" && released.operation.proofOrigin?.proves === "native-effect", released);
const nativeRelRow = await queryOperation(kvNativeRel, resource, "op-rel-ok");
c("native-effect release receipt is durable", nativeRelRow.state === "terminal-success" && nativeRelRow.proofOrigin?.proves === "native-effect", nativeRelRow);
c("native-effect release marked the binding released", readBindingRow(kvNativeRel as unknown as MemKv)?.state === "released");

effects.length = 0;
const kvStale = new MemKv() as unknown as KV;
await executeNativeLifecycle(kvStale, {
  ...requestBase, providerName: "executor-native-release", operation: "adopt", operationId: "op-adopt-stale", bindingId: "binding-stale",
});
const inspectBeforeStale = effects.filter((e) => e === "inspect").length;
await rejects("stale expectedBindingRevision is refused as conflict", () => executeNativeLifecycle(kvStale, {
  ...requestBase, providerName: "executor-native-release", operation: "release", operationId: "op-stale", bindingId: "binding-stale",
  expectedBindingRevision: 0, expectedControllerEpoch: 1, intendedResult: { bindingState: "released" },
}), "conflict");
c("stale revision did not dispatch native preflight, inspect, or release", !effects.includes("release") && !effects.includes("preflight:release") && effects.filter((e) => e === "inspect").length === inspectBeforeStale, effects);

console.log(`\n${ok} passed, ${fail} failed`);
if (fail) process.exit(1);
