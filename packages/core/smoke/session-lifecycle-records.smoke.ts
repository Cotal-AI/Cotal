/** Broker-free smoke for the §4 native lifecycle identity/binding grammar.
 *
 * Mutation controls by assertion:
 * - remove any ResourceKey field or key binding check -> resource key/key-mismatch cells fail;
 * - widen mode/right/state sets -> exact vocabulary cells fail;
 * - permit unknown/nested fields -> closed-schema cells fail;
 * - accept PID/display/cwd style aliases by omitting generation/incarnation -> required-proof cells fail.
 */
import {
  EpEnvelopeError,
  SESSION_BINDING,
  SESSION_OPERATION,
  SESSION_TRUST_STATE,
  parseRecordKey,
  resourceKeyId,
  sessionBindingKey,
  sessionOperationKey,
  sessionTrustStateKey,
  parseBinding,
  parseResourceKey,
  parseIncarnationProof,
  classifyIncarnationProof,
  parseSessionOperation,
  sessionOperationInput,
  sessionOperationInputDigest,
  type Binding,
  type ResourceKey,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (name: string, value: boolean, extra?: unknown) => {
  if (value) ok++;
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};
const throws = (name: string, fn: () => unknown) => {
  try { fn(); c(name, false, "no throw"); }
  catch (e) { c(name, e instanceof EpEnvelopeError && e.code === "internal", (e as Error).message); }
};
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

const resource: ResourceKey = {
  hostIdentity: "host-key-sha256:abc",
  provider: "com.cotal.claude",
  nativeOwnerNamespace: "uid:1000",
  stableSessionId: "native-session-17",
  resourceGeneration: "creation:2026-09-08T20:00:00Z",
};
const binding: Binding = {
  bindingId: "binding-1",
  resourceKey: resource,
  incarnationProof: {
    nativeHostIncarnation: "native-host-start:41",
    sessionIncarnation: "session-process-start:92",
    evidence: { origin: "provider-inspection", immutableCreationId: "c-17" },
  },
  controllerEpoch: 7,
  managerPrincipal: "u_alice.manager",
  mode: "cooperative-exclusive",
  rights: ["control", "release", "transfer"],
  state: "managed",
  operationId: "adopt-7",
  desiredRevision: 3,
};

console.log("A. registered key grammar and stable identity");
const rid = resourceKeyId(resource);
const bindingKey = sessionBindingKey(resource);
c("resource id is a record-safe SHA-256 token", /^[A-Za-z0-9_-]{43}$/.test(rid));
c("binding key is built through the registered atomic kind", bindingKey === `sessionbinding.${rid}` && parseRecordKey(bindingKey)?.def === SESSION_BINDING);
c("operation key binds resource and operation ids", sessionOperationKey(resource, "release-8") === `sessionop.${rid}.release-8` && parseRecordKey(`sessionop.${rid}.release-8`)?.def === SESSION_OPERATION);
c("trusted state key binds the complete resource", sessionTrustStateKey(resource) === `sessiontrust.${rid}` && parseRecordKey(`sessiontrust.${rid}`)?.def === SESSION_TRUST_STATE);
c("canonical ResourceKey order does not change its identity", resourceKeyId({ resourceGeneration: resource.resourceGeneration, stableSessionId: resource.stableSessionId, nativeOwnerNamespace: resource.nativeOwnerNamespace, provider: resource.provider, hostIdentity: resource.hostIdentity }) === rid);
c("binding parser returns the exact three management rights", parseBinding(enc(binding), bindingKey).rights.join(",") === "control,release,transfer");

console.log("B. closed consuming-boundary schemas");
throws("ResourceKey requires resourceGeneration, so a session name is not a stable identity", () => parseResourceKey({ ...resource, resourceGeneration: undefined }));
throws("ResourceKey is closed", () => parseResourceKey({ ...resource, pid: 1234 }));
throws("provider must be a DNS-shaped provider name", () => parseResourceKey({ ...resource, provider: "Claude Code" }));
throws("incarnation proof requires native host incarnation", () => parseIncarnationProof({ sessionIncarnation: "s1", evidence: {} }));
throws("incarnation proof requires evidence", () => parseIncarnationProof({ nativeHostIncarnation: "h1", sessionIncarnation: "s1" }));
throws("incarnation proof is closed", () => parseIncarnationProof({ ...binding.incarnationProof, cwd: "/work" }));
c("equal incarnation proof is matched", classifyIncarnationProof(binding.incarnationProof, { ...binding.incarnationProof, evidence: { immutableCreationId: "c-17", origin: "provider-inspection" } }) === "matched");
c("incarnation mismatch yields identity-unproven", classifyIncarnationProof(binding.incarnationProof, { ...binding.incarnationProof, sessionIncarnation: "session-process-start:93" }) === "identity-unproven");
throws("binding is closed", () => parseBinding(enc({ ...binding, legacyAdmin: true }), bindingKey));
throws("binding key must match the embedded ResourceKey", () => parseBinding(enc(binding), sessionBindingKey({ ...resource, resourceGeneration: "other" })));
throws("consumer-requested ResourceKey must match the embedded ResourceKey", () => parseBinding(enc(binding), bindingKey, { ...resource, stableSessionId: "other-session" }));

console.log("C. closed modes, states, rights and authority identity");
for (const bad of ["cooperative", "exclusive", "receiver-checked"]) {
  throws(`mode ${bad} is not wire vocabulary`, () => parseBinding(enc({ ...binding, mode: bad }), bindingKey));
}
throws("legacy spawn is not a session-manage right", () => parseBinding(enc({ ...binding, rights: ["spawn"] }), bindingKey));
throws("legacy admin is not a session-manage right", () => parseBinding(enc({ ...binding, rights: ["admin"] }), bindingKey));
throws("legacy supervise is not a session-manage right", () => parseBinding(enc({ ...binding, rights: ["supervise"] }), bindingKey));
throws("observed mode cannot carry control authority", () => parseBinding(enc({ ...binding, mode: "observed", rights: ["control"] }), bindingKey));
c("observed mode may carry discovery only", parseBinding(enc({ ...binding, mode: "observed", rights: ["discover"] }), bindingKey).rights[0] === "discover");
throws("duplicate management rights are refused rather than normalized", () => parseBinding(enc({ ...binding, rights: ["control", "control"] }), bindingKey));
throws("unknown binding state cannot authorize", () => parseBinding(enc({ ...binding, state: "active" }), bindingKey));
throws("manager principal is a canonical authenticated owner.actor", () => parseBinding(enc({ ...binding, managerPrincipal: "manager" }), bindingKey));
throws("controller epoch is positive", () => parseBinding(enc({ ...binding, controllerEpoch: 0 }), bindingKey));

console.log("D. dispatcher-retirement is not native-effect proof");
const opBase = {
  operationId: "op-disp", resourceKey: resource, incarnationProof: binding.incarnationProof,
  bindingId: "binding-1", expectedBindingRevision: 4, expectedControllerEpoch: 7,
  authenticatedActor: "u_alice.operator", action: "release" as const,
  intendedResult: { bindingState: "released", nativeState: "preserved" },
};
const opDigest = sessionOperationInputDigest(sessionOperationInput(opBase));
const opKey = sessionOperationKey(resource, "op-disp");
const dispatcherProof = {
  kind: "dispatcher-retirement" as const,
  admissionClosed: true as const,
  dispatcherSettled: true as const,
  retiredStatePersisted: true as const,
  unprovenLiveRequestIds: ["req-live-1"],
  proves: "dispatcher-retirement-only" as const,
};
const parsedDisp = parseSessionOperation(enc({ ...opBase, inputDigest: opDigest, state: "indeterminate", proofOrigin: dispatcherProof }), opKey);
c("dispatcher-retirement with unproven requests persists as indeterminate", parsedDisp.state === "indeterminate" && parsedDisp.proofOrigin?.proves === "dispatcher-retirement-only");
throws("dispatcher-retirement cannot prove terminal native success", () => parseSessionOperation(enc({
  ...opBase, inputDigest: opDigest, state: "terminal-success", result: { bindingState: "released" }, proofOrigin: dispatcherProof,
}), opKey));
throws("dispatcher-retirement cannot sit on a prepared operation", () => parseSessionOperation(enc({
  ...opBase, inputDigest: opDigest, state: "prepared", proofOrigin: dispatcherProof,
}), opKey));
throws("dispatcher-retirement without admissionClosed is not proof", () => parseSessionOperation(enc({
  ...opBase, inputDigest: opDigest, state: "indeterminate", proofOrigin: { ...dispatcherProof, admissionClosed: false },
}), opKey));
throws("unproven live request ids must be id tokens", () => parseSessionOperation(enc({
  ...opBase, inputDigest: opDigest, state: "indeterminate", proofOrigin: { ...dispatcherProof, unprovenLiveRequestIds: ["not a token"] },
}), opKey));
throws("a journal receipt is still not native-effect proof", () => parseSessionOperation(enc({
  ...opBase, inputDigest: opDigest, state: "terminal-success", result: { bindingState: "released" },
  proofOrigin: { kind: "journal-receipt", journalRevision: 9, proves: "journal-transition-only" },
}), opKey));

console.log(`\n${ok} passed, ${fail} failed`);
if (fail) process.exit(1);
