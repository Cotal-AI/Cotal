import assert from "node:assert/strict";
import { contractDigest } from "@cotal-ai/core";
import { parseServiceHostRequest, type ServiceHostInputs } from "../src/service-host-contract.js";

const owner = "u_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const principal = { owner, actor: "cli", lifecycleUid: "p".repeat(32) };
const service = { endpoint: "org.example.orders", instanceId: "i".repeat(32) };
const digest = contractDigest({ approved: true });
const cases: ServiceHostInputs = {
  "proposal-read": { proposalId: "a".repeat(64) },
  "proposal-list": { owner, cursor: null, limit: 10 },
  "instance-read": service,
  "instance-list": { owner: null, cursor: null, limit: 10 },
  "operation-read": { operationId: "b".repeat(32) },
  "name-read": { endpoint: service.endpoint },
  "decide": { proposalId: "a".repeat(64), expectedProposalRevision: 1, expectedNameRevision: 1, decision: "approve", callerCeiling: [] },
  "name-bind": { endpoint: service.endpoint, owner, expectedRevision: 0, claimReference: "verified-domain-claim" },
  "revoke": { ...service, expectedAssignmentDigest: digest, cause: "owner-request" },
  "caller-policy-read": { grantee: principal, service },
  "caller-policy-list": { owner, cursor: null, limit: 10, service: null },
  "caller-grant": { grantee: principal, service: { ...service, approvalDigest: digest }, capabilities: [], expectedPolicyRevision: 0 },
  "caller-revoke": { grantee: principal, grantId: "c".repeat(32), expectedPolicyRevision: 1 },
  "quarantine-restored": { restoreId: "d".repeat(32) },
  "admission-open": { restoreId: "d".repeat(32), expectedQuarantineRevision: 2 },
};
const operatorOps = new Set(["name-bind", "quarantine-restored", "admission-open"]);
const requests = Object.entries(cases).map(([operation, input]) => ({
  v: 1, kind: "service-endpoint-host", requestId: "f".repeat(32), operation, input,
  granter: operatorOps.has(operation) ? { kind: "operator", auditId: "fixture" } : { kind: "owner", owner },
}));
for (const request of requests) {
  const parsed = parseServiceHostRequest(request);
  assert.deepEqual(parsed, request);
  assert.notEqual(parsed.input, request.input);
  assert.throws(() => parseServiceHostRequest({ ...request, accountPublicKey: "caller-selected" }));
  assert.throws(() => parseServiceHostRequest({ ...request, input: { ...request.input, permissions: {} } }));
}
const approve = requests.find((r) => r.operation === "decide")!;
assert.throws(() => parseServiceHostRequest({ ...approve, granter: { kind: "operator", auditId: "fixture" } }), /owner consent/);
for (const operation of ["name-release", "name-transfer", "issue-native-jwt"])
  assert.throws(() => parseServiceHostRequest({ ...approve, operation }), /unsupported operation/);
assert.throws(() => parseServiceHostRequest({ ...approve, requestId: "short" }), /32 lowercase hex/);
assert.throws(() => parseServiceHostRequest(Object.assign(Object.create({}), approve)), /plain object/);
const list = requests.find((r) => r.operation === "proposal-list")!;
assert.throws(() => parseServiceHostRequest({ ...list, input: { ...list.input, limit: 51 } }), /between 1 and 50/);
console.log(`service-host-contract: ${requests.length} operation shapes and closed-field checks passed (structural only)`);
