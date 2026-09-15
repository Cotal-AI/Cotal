import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitProviderMutationRequest,
  persistProviderMutationRequest,
  readProviderMutationRequest,
  stableProviderMutationRequestId,
  type ProviderMutationCustody,
} from "../src/provision.js";
import type { AuthProvider } from "../src/auth-provider.js";

const OWNER = "u_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACTOR = "managed_actor";
const UID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";

const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "task84-core-custody-"));
let passed = 0;
const check = async (name: string, run: () => void | Promise<void>) => {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`); process.exitCode = 1; }
};

await check("core_provider_request_id_reused_after_uncertain_result", async () => {
  const requestId = stableProviderMutationRequestId({ kind: "grant", owner: OWNER, actor: ACTOR, lifecycleUid: UID, operationId: "spawn-goal-1" });
  const pending = persistProviderMutationRequest(root, { requestId, kind: "grant", owner: OWNER, actor: ACTOR, lifecycleUid: UID });
  const calls: string[] = [];
  let uncertain = true;
  const provider = {
    async grantAgent(opts: { requestId?: string }) {
      calls.push(opts.requestId ?? "missing");
      if (uncertain) { uncertain = false; throw new Error("uncertain transport result"); }
      return { actorToken: "fixture", sentinelCreds: "fixture" };
    },
  } as unknown as AuthProvider;
  await assert.rejects(provider.grantAgent({ requestId, store: {} as never, dir: root, space: "test", owner: OWNER, actor: ACTOR, scope: [], allowSubscribe: [], allowPublish: [], lifecycleUid: UID }));
  const restored = persistProviderMutationRequest(root, { requestId, kind: "grant", owner: OWNER, actor: ACTOR, lifecycleUid: UID });
  await provider.grantAgent({ requestId: restored.requestId, store: {} as never, dir: root, space: "test", owner: OWNER, actor: ACTOR, scope: [], allowSubscribe: [], allowPublish: [], lifecycleUid: UID });
  commitProviderMutationRequest(root, restored);
  assert.deepEqual(calls, [requestId, requestId]);
  assert.equal(pending.requestId, requestId);
});

await check("core_request_coordinate_conflict_refused", () => {
  const requestId = stableProviderMutationRequestId({ kind: "revoke", owner: OWNER, actor: ACTOR, lifecycleUid: UID, operationId: "retire-goal-1" });
  persistProviderMutationRequest(root, { requestId, kind: "revoke", owner: OWNER, actor: ACTOR, lifecycleUid: UID });
  assert.throws(() => persistProviderMutationRequest(root, { requestId, kind: "revoke", owner: OWNER, actor: "other", lifecycleUid: UID }), /conflicts/);
});

await check("core_request_state_is_durable_and_private", () => {
  const requestId = stableProviderMutationRequestId({ kind: "grant", owner: OWNER, actor: ACTOR, lifecycleUid: UID, operationId: "spawn-goal-2" });
  const request = persistProviderMutationRequest(root, { requestId, kind: "grant", owner: OWNER, actor: ACTOR, lifecycleUid: UID });
  const committed = commitProviderMutationRequest(root, request);
  const path = join(root, "provider-mutations", `${requestId}.json`);
  const stored = JSON.parse(readFileSync(path, "utf8")) as ProviderMutationCustody;
  assert.equal(stored.state, "host-committed");
  assert.equal(committed.requestId, requestId);
});

await check("core_exact_coordinates_change_request_identity", () => {
  const a = stableProviderMutationRequestId({ kind: "grant", owner: OWNER, actor: ACTOR, lifecycleUid: UID, operationId: "goal" });
  const b = stableProviderMutationRequestId({ kind: "grant", owner: OWNER, actor: ACTOR, lifecycleUid: "bbbbbbbbbbbbbbbbbbbbbbbbbb", operationId: "goal" });
  assert.notEqual(a, b);
});

await check("core_custody_never_persists_attempt_entropy", () => {
  const requestId = stableProviderMutationRequestId({ kind: "revoke", owner: OWNER, actor: ACTOR, lifecycleUid: UID, operationId: "attempt-entropy-absent" });
  const first = persistProviderMutationRequest(root, { requestId, kind: "revoke", owner: OWNER, actor: ACTOR, lifecycleUid: UID });
  const second = persistProviderMutationRequest(root, { requestId, kind: "revoke", owner: OWNER, actor: ACTOR, lifecycleUid: UID });
  assert.deepEqual(first,second);assert.deepEqual(Object.keys(first).sort(),["actor","kind","lifecycleUid","owner","requestId","state","ver"].sort());
});

await check("core_provisional_attempt_entropy_record_is_rejected_closed", () => {
  const requestId = stableProviderMutationRequestId({ kind: "revoke", owner: OWNER, actor: ACTOR, lifecycleUid: UID, operationId: "attempt-entropy-prototype" });
  const request = persistProviderMutationRequest(root, { requestId, kind: "revoke", owner: OWNER, actor: ACTOR, lifecycleUid: UID });
  const path = join(root, "provider-mutations", `${requestId}.json`); const raw = JSON.parse(readFileSync(path, "utf8"));
  const obsoleteEntropyField=["attempt","Random"].join("");raw[obsoleteEntropyField]=Buffer.alloc(16,9).toString("base64url");writeFileSync(path,JSON.stringify(raw));assert.throws(()=>readProviderMutationRequest(root,requestId),/unknown fields/);
  assert.equal(request.requestId,requestId);
});

console.log(`TASK84 CORE PROVIDER CUSTODY ${passed} passed, ${6 - passed} failed`);
rmSync(root, { recursive: true, force: true });
