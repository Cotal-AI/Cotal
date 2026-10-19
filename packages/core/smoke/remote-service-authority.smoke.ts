import assert from "node:assert/strict";
import { createAccount } from "@nats-io/nkeys";
import { contractDigest } from "../src/canonical.js";
import {
  parseServiceAuthorityEnvelope, parseServiceAuthorityRequest, parseServiceAuthorityResult,
  parseServiceRegistrationWitness, serviceAuthorityRequestDigest, serviceEndpointActor, serviceWitnessDigest,
  type ServiceAuthorityRequest, type ServiceRegistrationWitness,
} from "../src/remote-service-authority.js";

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
const snapshot = {
  spec: { value: { endpoint: identity.endpoint, owner, clusterDigests: [contractDigest(root)], protocol: { v: 1 } }, revision: 2 },
  name: { authorized: true, revision: 3 }, processEpoch: 1, contractArtifacts: [root],
};
const credential = {
  ...common, operation: "activate", state: "credential", witness, snapshot, duty: "serve",
  accessBearer: "fixture-access", accessExpiresAt: 60, renewalProof: "fixture-renewal", renewalExpiresAt: 3600,
};

assert.equal(actor.length, 47);
assert.match(actor, /^[A-Za-z0-9_-]+$/);
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
  status: ["idp", "service-renewal", "service-access"],
};
for (const operation of ["register", "activate", "renew", "ready", "revoke", "status"] as const) {
  const request = operation === "register" ? registration : operation === "status"
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
for (const operation of ["ready", "revoke"] as const) {
  const request: ServiceAuthorityRequest = { ...common, operation, witness };
  const response = operation === "ready"
    ? { ...common, operation, state: "ready", witness: { ...witness, processEpoch: 2 }, reportedAt: 10 }
    : { ...common, operation, state: "retired", witness: { ...witness, processEpoch: 2 }, operationId: "retirement1" };
  assert.throws(() => parseServiceAuthorityResult(response, request), /submitted witness/);
}
console.log("remote service authority: closed proof matrix, request/response binding and bounded identity passed");
