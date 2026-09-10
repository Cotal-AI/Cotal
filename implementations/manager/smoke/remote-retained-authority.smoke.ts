/** Participant-side construction and result-binding cells for remote retained validation. */
import assert from "node:assert/strict";
import { mintLifecycleUid, newIdentity, type RemoteRetainedAgentValidationResult } from "@cotal-ai/core";
import {
  currentRegistrationProof,
  remoteRetainedAgentValidationRequest,
  retainedAgentAuthority,
} from "../src/remote-authority.js";

let pass = 0;
let fail = 0;
async function cell(name: string, fn: () => void | Promise<void>) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (error) { fail++; console.log(`  ✗ FAIL: ${name}`, error); }
}
async function rejects(name: string, fn: () => unknown, pattern: RegExp) {
  await cell(name, () => {
    let error: unknown;
    try { fn(); } catch (caught) { error = caught; }
    assert.ok(error instanceof Error, "expected refusal");
    assert.match(error.message, pattern);
  });
}

const owner = `u_${"a".repeat(26)}`;
const state = {
  v: 1 as const,
  space: "demo",
  instanceId: mintLifecycleUid(),
  lifecycleUid: mintLifecycleUid(),
  identities: {
    supervisor: newIdentity(), executor: newIdentity(), serve: newIdentity(),
    goalWriter: newIdentity(), sessionLedger: newIdentity(),
  },
};
const target = { owner, actor: "worker", lifecycleUid: mintLifecycleUid() };
const request = remoteRetainedAgentValidationRequest(
  state,
  "cli",
  `sha256:${"a".repeat(64)}`,
  9,
  target,
  "actor-secret",
  "sentinel-secret",
);
const authority = {
  ...target,
  scope: ["role:worker"],
  allowSubscribe: ["general"],
  allowPublish: ["general"],
  role: "worker",
  parent: `${owner}.cli`,
};
const result: RemoteRetainedAgentValidationResult = {
  v: 1,
  kind: "manager-retained-agent-validation",
  space: request.space,
  owner,
  actor: request.actor,
  instanceId: request.instanceId,
  managerLifecycleUid: request.managerLifecycleUid,
  requestId: request.requestId,
  registrationProof: request.registrationProof,
  serveEpoch: request.serveEpoch,
  target,
  authority,
};

await cell("activation receipt supplies the host-authenticated current proof", () => {
  assert.equal(currentRegistrationProof({ nextRegistrationProof: request.registrationProof, registrationProof: `sha256:${"b".repeat(64)}` } as never), request.registrationProof);
});
await rejects("the caller-computable activation proof cannot substitute for the host proof", () =>
  currentRegistrationProof({ nextRegistrationProof: request.registrationProof, registrationProof: request.registrationProof } as never), /caller-computable activation proof/);
await rejects("a missing host proof is refused without fallback", () => currentRegistrationProof({} as never), /no host-authenticated current registration proof/);
await rejects("a malformed host proof is refused without fallback", () => currentRegistrationProof({ nextRegistrationProof: "not-a-proof" } as never), /no host-authenticated current registration proof/);

await cell("request carries exact manager, epoch, target, and existing secret material", () => {
  assert.equal(request.instanceId, state.instanceId);
  assert.equal(request.managerLifecycleUid, state.lifecycleUid);
  assert.equal(request.serveEpoch, 9);
  assert.deepEqual(request.target, target);
  assert.equal(request.actorToken, "actor-secret");
  assert.equal(request.sentinelCreds, "sentinel-secret");
  assert.deepEqual(request.identities, Object.fromEntries(Object.entries(state.identities).map(([name, identity]) => [name, { id: identity.id }])));
});
await cell("exact result returns the host authority", () => assert.deepEqual(retainedAgentAuthority(result, request), authority));
await rejects("a different request id is refused", () => retainedAgentAuthority({ ...result, requestId: `req${mintLifecycleUid()}` }, request), /different lifecycle or target/);
await rejects("a stale serve epoch is refused", () => retainedAgentAuthority({ ...result, serveEpoch: 8 }, request), /different lifecycle or target/);
await rejects("a different target is refused", () => retainedAgentAuthority({ ...result, target: { ...target, actor: "other" } }, request), /different lifecycle or target/);
await rejects("a replacement authority is refused", () => retainedAgentAuthority({ ...result, authority: { ...authority, actor: "other" } }, request), /invalid or replacement authority/);
await rejects("a missing authority is refused", () => retainedAgentAuthority({ ...result, authority: undefined as never }, request), /invalid or replacement authority/);
await rejects("unknown result fields are refused", () => retainedAgentAuthority({ ...result, actorToken: "leak" } as never, request), /non-closed result/);
await rejects("unknown authority fields are refused", () => retainedAgentAuthority({ ...result, authority: { ...authority, credential: "leak" } } as never, request), /invalid or replacement authority/);
await rejects("non-string authority entries are refused", () => retainedAgentAuthority({ ...result, authority: { ...authority, scope: ["role:worker", 7] } } as never, request), /invalid or replacement authority/);

const expected = 14;
if (pass !== expected || fail !== 0) {
  console.error(`remote retained authority smoke failed: ${pass}/${expected} passed, ${fail} failed`);
  process.exit(1);
}
console.log(`remote retained authority smoke passed: ${pass}/${expected}`);
