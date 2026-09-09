/** Broker-free executor smoke. One cell drives the public registry entry with nothing injected. */
import type { KV } from "@nats-io/kv";
import {
  EpEnvelopeError,
  executeNativeLifecycle,
  mayAdvanceBinding,
  parseBinding,
  queryOperation,
  putSessionEnrollment,
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
  type SessionEnrollment,
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
  expectedIncarnation: proof,
};
/** The proof a session reports after it has been replaced by a different one at the same key. */
const reincarnateProof = { ...proof, sessionIncarnation: "s-2" };
/** Flipped by the reincarnation cells so `inspect` starts reporting the replacement session. */
let reincarnated = false;

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
/** The owner-authorized enrollment for `resource`. `authorizedBy` is the owner itself: the parser
 *  refuses an enrollment authorized by anyone else. */
const enrollment: SessionEnrollment = {
  kind: "native-only",
  resourceKey: resource,
  ownerPrincipal: OWNER,
  provenance: { authorizedBy: OWNER, nativeEvidence: { immutable: "x" }, authenticatedAt: 500 },
  incarnationProof: proof,
  rights: ["discover", "adopt", "control", "release", "transfer"],
  expiry: 10_000,
};
/** A store whose session is already enrolled. Adopt, transfer and recover are enrollment-governed,
 *  so a store with no enrollment row is not one they can run against at all. */
async function enrolledKv(patch: Partial<SessionEnrollment> = {}): Promise<KV> {
  const mem = new MemKv() as unknown as KV;
  await putSessionEnrollment(mem, { ...enrollment, ...patch } as SessionEnrollment);
  return mem;
}

const otherResource: ResourceKey = { ...resource, stableSessionId: "session-other" };
const effects: string[] = [];
const drainedProof = {
  kind: "dispatcher-retirement" as const,
  admissionClosed: true as const,
  dispatcherSettled: true as const,
  retiredStatePersisted: true as const,
  liveRequestCollector: "complete" as const,
  unprovenLiveRequestIds: [] as const,
  proves: "cooperative-retirement" as const,
};

function connection(
  ops: readonly NativeLifecycleOperation[],
  mode: NativeLifecycleConnection["capabilities"]["mode"] = "cooperative-exclusive",
  kind: "ok" | "mismatch" | "lost-release" | "native-release" | "preflight-refuse" | "journal-release" | "coop-release" | "coop-release-live" | "reincarnate" = "ok",
): NativeLifecycleConnection {
  const inspect = async () => {
    effects.push("inspect");
    if (kind === "reincarnate" && reincarnated) return observation({ incarnationProof: reincarnateProof });
    return observation();
  };
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
      if (kind === "journal-release") {
        return {
          state: "recorded",
          operation: {
            ...operation,
            state: "terminal-success",
            result: { bindingState: "released" },
            proofOrigin: { kind: "journal-receipt", journalRevision: 1, proves: "journal-transition-only" },
          },
        };
      }
      if (kind === "coop-release" || kind === "coop-release-live") {
        return {
          state: "recorded",
          operation: {
            ...operation,
            state: "terminal-success",
            result: kind === "coop-release"
              ? { bindingState: "released", nativeState: "preserved" }
              : { bindingState: "released" },
            proofOrigin: drainedProof,
          },
        };
      }
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
  if (ops.includes("transfer")) {
    conn.transfer = async (_binding, operation) => {
      effects.push("transfer");
      return {
        state: "recorded",
        operation: {
          ...operation,
          state: "terminal-success",
          result: { transferred: true },
          proofOrigin: { kind: "native-readback", provider: "com.cotal.test", evidence: { transferred: true }, proves: "native-effect" },
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
  kind: "ok" | "mismatch" | "lost-release" | "native-release" | "preflight-refuse" | "journal-release" | "coop-release" | "coop-release-live" | "reincarnate" = "ok",
): void {
  const provider: NativeLifecycleProvider = {
    kind: "native-lifecycle",
    name,
    connect: () => connection(ops, mode, kind),
  };
  registry.register(provider);
}

const mutatingOps: readonly NativeLifecycleOperation[] = ["discover", "inspect", "preflight", "adopt", "release", "transfer", "queryOperation", "openView"];
register("executor-coop", mutatingOps, "cooperative-exclusive", "lost-release");
register("executor-observed", ["discover", "inspect", "preflight", "adopt", "queryOperation"], "observed");
register("executor-missing-adopt", ["discover", "inspect"]);
register("executor-mismatch", ["inspect", "preflight", "adopt"], "cooperative-exclusive", "mismatch");
register("executor-native-release", mutatingOps, "cooperative-exclusive", "native-release");
register("executor-journal-release", mutatingOps, "cooperative-exclusive", "journal-release");
register("executor-coop-release", mutatingOps, "cooperative-exclusive", "coop-release");
register("executor-coop-release-live", mutatingOps, "cooperative-exclusive", "coop-release-live");
register("executor-preflight-refuse", ["preflight"], "cooperative-exclusive", "preflight-refuse");
register("executor-reincarnate", mutatingOps, "cooperative-exclusive", "reincarnate");

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
const kv = await enrolledKv();
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
const kvRelease = await enrolledKv();
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
const kvMismatch = await enrolledKv();
const mismatched = await executeNativeLifecycle(kvMismatch, {
  ...requestBase, providerName: "executor-mismatch", operation: "adopt", operationId: "op-mismatch", bindingId: "binding-mismatch",
});
c("mismatched recorded receipt stays indeterminate", mismatched.state === "indeterminate", mismatched);
const mismatchRow = await queryOperation(kvMismatch, resource, "op-mismatch");
c("mismatched receipt is not stored as terminal-success", mismatchRow.state === "indeterminate" && mismatchRow.proofOrigin === undefined, mismatchRow);

effects.length = 0;
const kvNativeRel = await enrolledKv();
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
const kvJournalRel = await enrolledKv();
await executeNativeLifecycle(kvJournalRel, {
  ...requestBase, providerName: "executor-journal-release", operation: "adopt", operationId: "op-adopt-journal", bindingId: "binding-journal",
});
let journalReleased: Awaited<ReturnType<typeof executeNativeLifecycle>> | { state: "threw"; error: unknown };
try {
  journalReleased = await executeNativeLifecycle(kvJournalRel, {
    ...requestBase, providerName: "executor-journal-release", operation: "release", operationId: "op-rel-journal", bindingId: "binding-journal",
    expectedBindingRevision: bindingRevision(kvJournalRel as unknown as MemKv), expectedControllerEpoch: 1, intendedResult: { bindingState: "released" },
  });
} catch (e) {
  journalReleased = { state: "threw", error: e };
}
c("journal-receipt terminal-success release stays indeterminate", journalReleased.state === "indeterminate", journalReleased);
const journalRelRow = await queryOperation(kvJournalRel, resource, "op-rel-journal");
c("journal-receipt release is not stored as terminal-success", journalRelRow.state === "indeterminate" && journalRelRow.proofOrigin === undefined, journalRelRow);
c("journal-receipt release did not mark the binding released", readBindingRow(kvJournalRel as unknown as MemKv)?.state === "managed");

effects.length = 0;
const kvCoopLive = await enrolledKv();
await executeNativeLifecycle(kvCoopLive, {
  ...requestBase, providerName: "executor-coop-release-live", operation: "adopt", operationId: "op-adopt-coop-live", bindingId: "binding-coop-live",
});
const coopLive = await executeNativeLifecycle(kvCoopLive, {
  ...requestBase, providerName: "executor-coop-release-live", operation: "release", operationId: "op-rel-coop-live", bindingId: "binding-coop-live",
  expectedBindingRevision: bindingRevision(kvCoopLive as unknown as MemKv), expectedControllerEpoch: 1, intendedResult: { bindingState: "released" },
});
c("cooperative-retirement without preserved lifetime persists as terminal-success", coopLive.state === "recorded" && coopLive.operation.state === "terminal-success" && coopLive.operation.proofOrigin?.proves === "cooperative-retirement", coopLive);
const coopLiveRow = await queryOperation(kvCoopLive, resource, "op-rel-coop-live");
c("cooperative-retirement without preserved lifetime is durable", coopLiveRow.state === "terminal-success" && coopLiveRow.proofOrigin?.proves === "cooperative-retirement", coopLiveRow);
c("cooperative-retirement without preserved lifetime did not mark the binding released", readBindingRow(kvCoopLive as unknown as MemKv)?.state === "managed");

effects.length = 0;
const kvCoop = await enrolledKv();
await executeNativeLifecycle(kvCoop, {
  ...requestBase, providerName: "executor-coop-release", operation: "adopt", operationId: "op-adopt-coop", bindingId: "binding-coop-ok",
});
const coopReleased = await executeNativeLifecycle(kvCoop, {
  ...requestBase, providerName: "executor-coop-release", operation: "release", operationId: "op-rel-coop", bindingId: "binding-coop-ok",
  expectedBindingRevision: bindingRevision(kvCoop as unknown as MemKv), expectedControllerEpoch: 1, intendedResult: { bindingState: "released", nativeState: "preserved" },
});
c("cooperative-retirement with preserved lifetime is terminal-success", coopReleased.state === "recorded" && coopReleased.operation.state === "terminal-success" && coopReleased.operation.proofOrigin?.proves === "cooperative-retirement", coopReleased);
const coopRow = await queryOperation(kvCoop, resource, "op-rel-coop");
c("cooperative-retirement with preserved lifetime is durable", coopRow.state === "terminal-success" && coopRow.proofOrigin?.proves === "cooperative-retirement", coopRow);
c("cooperative-retirement with preserved lifetime marked the binding released", readBindingRow(kvCoop as unknown as MemKv)?.state === "released");

effects.length = 0;
const kvStale = await enrolledKv();
await executeNativeLifecycle(kvStale, {
  ...requestBase, providerName: "executor-native-release", operation: "adopt", operationId: "op-adopt-stale", bindingId: "binding-stale",
});
const inspectBeforeStale = effects.filter((e) => e === "inspect").length;
await rejects("stale expectedBindingRevision is refused as conflict", () => executeNativeLifecycle(kvStale, {
  ...requestBase, providerName: "executor-native-release", operation: "release", operationId: "op-stale", bindingId: "binding-stale",
  expectedBindingRevision: 0, expectedControllerEpoch: 1, intendedResult: { bindingState: "released" },
}), "conflict");
c("stale revision did not dispatch native preflight, inspect, or release", !effects.includes("release") && !effects.includes("preflight:release") && effects.filter((e) => e === "inspect").length === inspectBeforeStale, effects);

effects.length = 0;
const kvTransfer = await enrolledKv();
await executeNativeLifecycle(kvTransfer, {
  ...requestBase, providerName: "executor-native-release", operation: "adopt", operationId: "op-adopt-xfer", bindingId: "binding-xfer",
});
effects.length = 0;
const transferred = await executeNativeLifecycle(kvTransfer, {
  ...requestBase, providerName: "executor-native-release", operation: "transfer", operationId: "op-xfer", bindingId: "binding-xfer",
  expectedBindingRevision: bindingRevision(kvTransfer as unknown as MemKv), expectedControllerEpoch: 1, intendedResult: { transferred: true },
});
c("transfer dispatches the transfer method through the public entry", transferred.state === "recorded" && transferred.operation.state === "terminal-success" && effects.includes("transfer") && !effects.includes("adopt"), transferred);
c("transfer did not rewrite the binding to released", readBindingRow(kvTransfer as unknown as MemKv)?.state === "managed");

effects.length = 0;
const queried = await executeNativeLifecycle(kvTransfer, {
  ...requestBase, providerName: "executor-native-release", operation: "queryOperation", operationId: "op-xfer", bindingId: "binding-xfer",
});
c("queryOperation returns the provider result for a recorded row", queried.state === "indeterminate" && queried.reason === "native acknowledgement lost", queried);
c("queryOperation reached the provider once", effects.join(",") === "queryOperation", effects);

console.log("D. forward guard: cooperative-retirement without preserved lifetime cannot write released");
const managedBinding: Binding = {
  bindingId: "binding-coop",
  resourceKey: resource,
  incarnationProof: proof,
  controllerEpoch: 1,
  managerPrincipal: MANAGER,
  mode: "cooperative-exclusive",
  rights: ["discover", "adopt", "control", "release", "transfer"],
  state: "managed",
  operationId: "op-coop",
  desiredRevision: 0,
};
const coopRecord: SessionOperationRecord = {
  operationId: "op-coop",
  resourceKey: resource,
  incarnationProof: proof,
  bindingId: "binding-coop",
  expectedBindingRevision: 1,
  expectedControllerEpoch: 1,
  authenticatedActor: MANAGER,
  action: "release",
  intendedResult: { bindingState: "released" },
  inputDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  state: "terminal-success",
  result: { bindingState: "released" },
  proofOrigin: { kind: "journal-receipt", journalRevision: 1, proves: "journal-transition-only" },
};
c("cooperative-retirement without nativeLifetimePreserved cannot advance to released",
  mayAdvanceBinding(managedBinding, {
    state: "terminal-success",
    record: { ...coopRecord, proofOrigin: drainedProof, result: { bindingState: "released" } },
    result: { bindingState: "released" },
    proofOrigin: drainedProof,
  }, "release") === false);
c("native-effect adopt still may advance to managed",
  mayAdvanceBinding({ ...managedBinding, state: "adopt-prepared", operationId: "op-adopt" }, {
    state: "terminal-success",
    record: { ...coopRecord, operationId: "op-adopt", bindingId: "binding-coop", action: "adopt" },
    result: { bound: true },
    proofOrigin: { kind: "native-readback", provider: "com.cotal.test", evidence: { bound: true }, proves: "native-effect" },
  }, "adopt") === true);
c("native-effect cannot advance when record.action mismatches operation",
  mayAdvanceBinding({ ...managedBinding, state: "adopt-prepared", operationId: "op-adopt" }, {
    state: "terminal-success",
    record: { ...coopRecord, operationId: "op-adopt", bindingId: "binding-coop", action: "release" },
    result: { bound: true },
    proofOrigin: { kind: "native-readback", provider: "com.cotal.test", evidence: { bound: true }, proves: "native-effect" },
  }, "adopt") === false);

console.log("E. the enrollment is the identity and authority source for acquiring management");
effects.length = 0;
await rejects("adopt against a store with no enrollment is refused", () => executeNativeLifecycle(new MemKv() as unknown as KV, {
  ...requestBase, providerName: "executor-coop", operation: "adopt", operationId: "op-noenroll", bindingId: "binding-noenroll",
}), "failed-precondition");
c("unenrolled adopt never dispatched the native adopt", !effects.includes("adopt"), effects);

await rejects("adopt on an expired enrollment is refused", async () => executeNativeLifecycle(await enrolledKv({ expiry: 900 }), {
  ...requestBase, providerName: "executor-coop", operation: "adopt", operationId: "op-expired", bindingId: "binding-expired",
}), "failed-precondition");

await rejects("adopt whose enrollment records a different owner is refused", async () => executeNativeLifecycle(
  await enrolledKv({ ownerPrincipal: "u_bob.operator", provenance: { ...enrollment.provenance, authorizedBy: "u_bob.operator" } }), {
    ...requestBase, providerName: "executor-coop", operation: "adopt", operationId: "op-otherowner", bindingId: "binding-otherowner",
  }), "permission-denied");

await rejects("adopt the enrollment does not grant is refused", async () => executeNativeLifecycle(
  await enrolledKv({ rights: ["discover", "release"] }), {
    ...requestBase, providerName: "executor-coop", operation: "adopt", operationId: "op-noright", bindingId: "binding-noright",
  }), "permission-denied");

effects.length = 0;
const changedIncarnation = await executeNativeLifecycle(
  await enrolledKv({ incarnationProof: { ...proof, sessionIncarnation: "s-2" } }), {
    ...requestBase, providerName: "executor-coop", operation: "adopt", operationId: "op-reincarnated", bindingId: "binding-reincarnated",
  });
c("adopt of a session whose incarnation left the enrolled proof is identity-unproven",
  changedIncarnation.state === "identity-unproven", changedIncarnation);
c("a changed incarnation never dispatched the native adopt", !effects.includes("adopt"), effects);

const kvNarrow = await enrolledKv({ rights: ["adopt", "release"] });
const narrowAdopt = await executeNativeLifecycle(kvNarrow, {
  ...requestBase, providerName: "executor-native-release", operation: "adopt", operationId: "op-narrow", bindingId: "binding-narrow",
});
c("adopt authorized by a narrow enrollment still succeeds", narrowAdopt.state === "recorded", narrowAdopt);
c("the binding carries the enrolled rights, not a full hardcoded set",
  JSON.stringify(readBindingRow(kvNarrow as unknown as MemKv)?.rights) === JSON.stringify(["adopt", "release"]),
  readBindingRow(kvNarrow as unknown as MemKv)?.rights);

const kvGiveUp = await enrolledKv({ rights: ["adopt"] });
await executeNativeLifecycle(kvGiveUp, {
  ...requestBase, providerName: "executor-native-release", operation: "adopt", operationId: "op-giveup", bindingId: "binding-giveup",
});
const releasedUngated = await executeNativeLifecycle(kvGiveUp, {
  ...requestBase, providerName: "executor-native-release", operation: "release", operationId: "op-giveup-rel", bindingId: "binding-giveup",
  expectedBindingRevision: bindingRevision(kvGiveUp as unknown as MemKv), expectedControllerEpoch: 1,
  intendedResult: { bindingState: "released", nativeState: "preserved" },
});
c("release is not gated on the enrollment, so a session can always be given up",
  releasedUngated.state === "recorded" && releasedUngated.operation.state === "terminal-success", releasedUngated);
c("release the enrollment never granted still marked the binding released",
  readBindingRow(kvGiveUp as unknown as MemKv)?.state === "released");

console.log("F. the incarnation under management is pinned by durable state, not by the requester");
effects.length = 0;
await rejects("adopt with no expected incarnation is refused, not silently uncompared", async () => executeNativeLifecycle(await enrolledKv(), {
  ...requestBase, providerName: "executor-coop", operation: "adopt", operationId: "op-noexpect", bindingId: "binding-noexpect",
  expectedIncarnation: undefined,
}), "internal");
c("an adopt with no expectation never reached the provider", effects.length === 0, effects);

effects.length = 0;
const wrongExpectation = await executeNativeLifecycle(await enrolledKv(), {
  ...requestBase, providerName: "executor-coop", operation: "adopt", operationId: "op-wrongexpect", bindingId: "binding-wrongexpect",
  expectedIncarnation: reincarnateProof,
});
c("adopt whose expected incarnation is not the observed one is identity-unproven", wrongExpectation.state === "identity-unproven", wrongExpectation);
c("a wrong expectation never dispatched the native adopt", !effects.includes("adopt"), effects);

// The unit form of the acceptance cell: the native session goes away and the observation changes.
// The caller here has seen the replacement and asserts it, so `expectedIncarnation` agrees with the
// provider; only the binding still remembers what was adopted, which is what has to refuse.
const kvReborn = await enrolledKv();
await executeNativeLifecycle(kvReborn, {
  ...requestBase, providerName: "executor-reincarnate", operation: "adopt", operationId: "op-reborn-adopt", bindingId: "binding-reborn",
});
c("the binding recorded the incarnation it adopted",
  readBindingRow(kvReborn as unknown as MemKv)?.incarnationProof.sessionIncarnation === "s-1");
reincarnated = true;
effects.length = 0;
const onReplaced = await executeNativeLifecycle(kvReborn, {
  ...requestBase, providerName: "executor-reincarnate", operation: "release", operationId: "op-reborn-rel", bindingId: "binding-reborn",
  expectedBindingRevision: bindingRevision(kvReborn as unknown as MemKv), expectedControllerEpoch: 1,
  expectedIncarnation: reincarnateProof, intendedResult: { bindingState: "released", nativeState: "preserved" },
});
c("release against a session replaced since it was bound is identity-unproven", onReplaced.state === "identity-unproven", onReplaced);
c("the replacement session was never dispatched a native release", !effects.includes("release"), effects);
c("the binding was not rewritten by a refused release", readBindingRow(kvReborn as unknown as MemKv)?.state === "managed");
reincarnated = false;

console.log(`\n${ok} passed, ${fail} failed`);
if (fail) process.exit(1);
