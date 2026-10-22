import nodeAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { assertBoundedOwner, epRequestSubject } from "../src/endpoint-subjects.js";
import { createAccount } from "@nats-io/nkeys";
import { contractDigest } from "../src/canonical.js";
import { spacePrefix } from "../src/subjects.js";
import {
  parseServiceAuthorityEnvelope, parseServiceAuthorityInfo, parseServiceAuthorityRequest, parseServiceAuthorityResult,
  parseServiceRegistrationWitness, serviceAuthorityRequestDigest, serviceEndpointActor, serviceWitnessDigest,
  type ServiceAuthorityRequest, type ServiceRegistrationWitness,
} from "../src/remote-service-authority.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;

const owner = "u_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const identity = {
  accountPublicKey: createAccount().getPublicKey(), space: "service-authority-smoke",
  endpoint: "org.example.orders", instanceId: "1".repeat(32), owner,
};
const actor = serviceEndpointActor(identity);
const root = { v: 1, commands: [] };
const witness: ServiceRegistrationWitness = {
  accountPublicKey: identity.accountPublicKey, space: identity.space, endpoint: identity.endpoint,
  instanceId: identity.instanceId, principal: { owner, actor, lifecycleUid: "p".repeat(32) },
  rootCredentialId: "r".repeat(32), approvalDigest: contractDigest({ approved: true }),
  processEpoch: 1, registrationRevision: 2, nameAuthorityRevision: 3,
  registrationRequestId: "a".repeat(32), registrationProof: contractDigest({ registration: 1 }),
};
const common = {
  v: 1 as const, kind: "service-endpoint-authority" as const, requestId: "b".repeat(32),
  accountPublicKey: identity.accountPublicKey, space: identity.space,
  endpoint: identity.endpoint, instanceId: identity.instanceId,
};
const registration: ServiceAuthorityRequest = {
  ...common, operation: "register", requestId: witness.registrationRequestId,
  registration: { clusterDigests: [contractDigest(root)], contractArtifacts: [root] },
  expected: { state: "unregistered" },
};
const activate: ServiceAuthorityRequest = { ...common, operation: "activate", witness };
const observedSubject = epRequestSubject(identity.space, { endpoint: identity.endpoint, command: "describe", route: { mode: "one" },
  caller: { owner, actor: "caller", uid: "c".repeat(32) }, nonce: "n".repeat(32) });
const describeView: ServiceAuthorityRequest = { ...common, operation: "describe-view", witness,
  observation: { subject: observedSubject, fingerprint: contractDigest({ observed: true }) } };
const viewResult = { ...common, operation: "describe-view", state: "view", witness, observation: describeView.observation,
  basis: "principal-policy-v1", commands: ["read"], validForMs: 1000 };
assert.deepEqual(parseServiceAuthorityResult(viewResult, describeView), viewResult);
for (const change of [{ basis: "issued-ceiling" }, { commands: ["read", "read"] }, { validForMs: 0 }, { validForMs: 2001 },
  { validForMs: 1.5 }, { witness: { ...witness, processEpoch: 2 } },
  { observation: { ...describeView.observation, fingerprint: contractDigest({ changed: true }) } }])
  assert.throws(() => parseServiceAuthorityResult({ ...viewResult, ...change }, describeView));
for (const subject of [observedSubject.replace(`${spacePrefix(identity.space)}.`, `${spacePrefix("other")}.`),
  epRequestSubject(identity.space, { endpoint: identity.endpoint, command: "describe", route: { mode: "inst", instanceId: "z".repeat(32) },
    caller: { owner, actor: "caller", uid: "c".repeat(32) }, nonce: "n".repeat(32) })])
  assert.throws(() => parseServiceAuthorityRequest({ ...describeView, observation: { ...describeView.observation, subject } }));

const snapshot = {
  spec: { value: { endpoint: identity.endpoint, owner, clusterDigests: [contractDigest(root)], protocol: { v: 1 } }, revision: 2 },
  name: { authorized: true, revision: 3 }, processEpoch: 1, contractArtifacts: [root],
};
const credential = {
  ...common, operation: "activate", state: "credential", witness, snapshot, duty: "serve",
  accessBearer: "fixture-access", accessExpiresAt: 60, renewalProof: "fixture-renewal", renewalExpiresAt: 3600,
};

const info = { v: 1, kind: "service-endpoint-authority-info", space: identity.space, accountPublicKey: identity.accountPublicKey };
assert.deepEqual(parseServiceAuthorityInfo(info, identity.space), info);
assert.throws(() => parseServiceAuthorityInfo(info, "other-space"), /does not match/);
assert.throws(() => parseServiceAuthorityInfo({ ...info, token: "fixture" }, identity.space), /unsupported fields/);
assert.throws(() => parseServiceAuthorityInfo({ ...info, accountPublicKey: "invalid" }, identity.space), /DATA-account/);

assert.equal(actor.length, 54);
assert.match(actor, /^svc_[a-z0-9]{50}$/);
assert.equal(assertBoundedOwner(actor, "service actor"), actor);
const regressionActor = serviceEndpointActor({ ...identity, accountPublicKey: "ADWIN6MSGKUAPVYX2OR5YNMCNVCQ6XNMZ3YNEOZFP2HD63VB6IWZ4WJT", instanceId: "00000000000000000000000000000001" });
assert.equal(assertBoundedOwner(regressionActor, "service actor"), regressionActor);
assert.equal(actor, serviceEndpointActor(identity));
for (const change of [{ endpoint: "org.example.other" }, { instanceId: "2".repeat(32) }, { space: "other-space" }, { accountPublicKey: createAccount().getPublicKey() }])
  assert.notEqual(actor, serviceEndpointActor({ ...identity, ...change }));
assert.deepEqual(parseServiceRegistrationWitness(witness), witness);
assert.deepEqual(parseServiceAuthorityRequest(registration), registration);
assert.deepEqual(parseServiceAuthorityRequest(activate), activate);
assert.deepEqual(parseServiceAuthorityResult(credential, activate), credential);
assert.equal(serviceAuthorityRequestDigest(registration), serviceAuthorityRequestDigest(structuredClone(registration)));
assert.notEqual(serviceWitnessDigest(witness), serviceWitnessDigest({ ...witness, processEpoch: 2 }));

const proofKinds = ["idp", "service-renewal", "service-access"] as const;
const allowed = {
  register: ["idp"], activate: ["idp", "service-renewal"], renew: ["service-renewal"],
  ready: ["service-access"], revoke: ["idp", "service-renewal"],
  status: ["idp", "service-renewal", "service-access"], "describe-view": ["service-access"],
};
for (const operation of ["register", "activate", "renew", "ready", "revoke", "status", "describe-view"] as const) {
  const request = operation === "describe-view" ? describeView : operation === "register" ? registration : operation === "status"
    ? { ...common, operation, target: { kind: "instance" } }
    : { ...common, operation, witness };
  for (const kind of proofKinds) {
    const parse = () => parseServiceAuthorityEnvelope({ request, proof: { kind, token: "fixture-proof" } });
    if (allowed[operation].includes(kind)) assert.doesNotThrow(parse, `${operation}/${kind}`);
    else assert.throws(parse, /proof kind/, `${operation}/${kind}`);
  }
}

for (const extra of [{ owner }, { profile: "agent" }, { duty: "session-serving" }, { permissions: {} }])
  assert.throws(() => parseServiceAuthorityRequest({ ...activate, ...extra }), /unsupported fields/);
assert.throws(() => parseServiceAuthorityEnvelope({ request: activate, proof: { kind: "idp", token: "fixture", serviceToken: "fixture" } }), /unsupported fields/);
assert.throws(() => parseServiceRegistrationWitness({ ...witness, principal: { ...witness.principal, actor: "unrelated" } }), /actor does not match/);
assert.throws(() => parseServiceAuthorityRequest({ ...activate, instanceId: "f".repeat(32) }), /different service/);
assert.throws(() => parseServiceAuthorityRequest({ ...activate, requestId: "B".repeat(32) }), /32 lowercase/);
assert.throws(() => parseServiceAuthorityRequest({ ...registration, registration: { ...registration.registration, contractArtifacts: [root, root] } }), /duplicate contract/);
assert.throws(() => parseServiceAuthorityResult({ ...credential, requestId: "c".repeat(32) }, activate), /echo/);
assert.throws(() => parseServiceAuthorityResult({ ...credential, duty: "session-serving" }, activate), /unsupported service duty/);
assert.throws(() => parseServiceAuthorityResult({ ...credential, witness: { ...witness, processEpoch: 2 } }, activate), /submitted registration witness/);
assert.throws(() => parseServiceAuthorityResult({ ...credential, state: "ready" }, activate), /not admitted/);
assert.throws(() => parseServiceAuthorityResult({ ...credential, nativeJwt: "fixture" }, activate), /unsupported fields/);
assert.throws(() => parseServiceAuthorityResult({ ...credential, snapshot: { ...snapshot, name: { authorized: true, revision: 4 } } }, activate), /disagrees/);
assert.throws(() => parseServiceAuthorityResult({ ...common, operation: "register", state: "registered", witness, snapshot }, { ...registration, requestId: common.requestId }), /another operation/);
const registered = { ...common, operation: "register", requestId: registration.requestId, state: "registered", witness, snapshot };
assert.doesNotThrow(() => parseServiceAuthorityResult(registered, registration));
const otherRoot = { v: 1, commands: [], label: "different-surface" };
assert.throws(() => parseServiceAuthorityResult({ ...registered, snapshot: {
  ...snapshot, spec: { ...snapshot.spec, value: { ...snapshot.spec.value, clusterDigests: [contractDigest(otherRoot)] } },
  contractArtifacts: [otherRoot],
} }, registration), /submitted closure/);
assert.throws(() => parseServiceAuthorityResult({ ...registered, snapshot: {
  ...snapshot, spec: { ...snapshot.spec, value: { ...snapshot.spec.value, clusterDigests: [contractDigest(root), contractDigest(otherRoot)] } },
  contractArtifacts: [root, otherRoot],
} }, registration), /submitted closure/);
const both = { ...registration, registration: { clusterDigests: [contractDigest(root), contractDigest(otherRoot)], contractArtifacts: [root, otherRoot] } };
assert.throws(() => parseServiceAuthorityResult(registered, both), /submitted closure/);
assert.doesNotThrow(() => parseServiceAuthorityResult({ ...registered, snapshot: {
  ...snapshot, spec: { ...snapshot.spec, value: { ...snapshot.spec.value, clusterDigests: [...both.registration.clusterDigests].reverse() } },
  contractArtifacts: [root, otherRoot],
} }, both));
for (const operation of ["ready", "revoke"] as const) {
  const request: ServiceAuthorityRequest = { ...common, operation, witness };
  const response = operation === "ready"
    ? { ...common, operation, state: "ready", witness: { ...witness, processEpoch: 2 }, reportedAt: 10 }
    : { ...common, operation, state: "retired", witness: { ...witness, processEpoch: 2 }, operationId: "retirement1" };
  assert.throws(() => parseServiceAuthorityResult(response, request), /submitted witness/);
}
// The operation status selector names the mutation it reads; the earlier selector without it is refused.
const opStatus = (target: unknown) => ({ ...common, operation: "status", target });
for (const operation of ["register", "activate", "renew", "ready", "revoke"])
  assert.doesNotThrow(() => parseServiceAuthorityRequest(opStatus({ kind: "operation", operation, requestId: "d".repeat(32) })), operation);
assert.throws(() => parseServiceAuthorityRequest(opStatus({ kind: "operation", requestId: "d".repeat(32) })), /unsupported fields/);
for (const operation of ["status", "describe-view", "unknown"])
  assert.throws(() => parseServiceAuthorityRequest(opStatus({ kind: "operation", operation, requestId: "d".repeat(32) })), /unsupported status operation/, operation);
assert.throws(() => parseServiceAuthorityRequest(opStatus({ kind: "operation", operation: "register", requestId: "d".repeat(32), extra: 1 })), /unsupported fields/);
console.log("remote service authority: closed proof matrix, request/response binding and bounded identity passed");
emitSentinel({ passed: counted.cells(), failed: 0 });
