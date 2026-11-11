/** Durable enrollment custody. The CLI timeout cases run against a real host in the live suite. */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { workspaceSecretStore } from "@cotal-ai/workspace";
import { mintLifecycleUid, type SecretStore } from "@cotal-ai/core";
import { pendingEnrollment } from "../src/pending-enrollment.js";
import { loadOrCreateRemoteManagerIdentity, remoteManagedAgentEnrollmentRequest } from "../src/remote-authority.js";

const root = mkdtempSync(join(tmpdir(), "pending-enrollment-"));
const store = workspaceSecretStore(root);
const space = "pending-enrollment";
const state = loadOrCreateRemoteManagerIdentity(root, space);
const target = { actor: "alpha", label: "alpha", allowSubscribe: ["general"], allowPublish: [] };
const input = { target, spawn: { served: "original-request" } };
const authority = { target, owner: "owner", caller: { owner: "owner", actor: "cli" } };
const args = { store, space, instanceId: state.instanceId, actor: "alpha", input, authority };
const first = await pendingEnrollment(args);
assert.equal(first.created, true);
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const request = (p: typeof first) => remoteManagedAgentEnrollmentRequest(state, "cli", "proof", 1,
  { ...p.record.input.target, tokenHash: hash(p.record.actorToken) }, p.record.input.spawn, p.record.requestId);

// A later process uses the same persisted token, request and original served request.
const later = await pendingEnrollment({ ...args, store: workspaceSecretStore(root),
  input: { target, spawn: { served: "later-request" } } });
assert.equal(later.created, false);
assert.deepEqual(request(later), request(first));
assert.equal(later.record.lifecycleUid, first.record.lifecycleUid);

// Parallel load-or-create callers all keep the winner, never their discarded candidate token.
const concurrent = await Promise.all(Array.from({ length: 8 }, () => pendingEnrollment(args)));
for (const p of concurrent) assert.deepEqual(p.record, first.record);
for (const changed of [
  { ...authority, owner: "other" },
  { ...authority, caller: { owner: "owner", actor: "other" } },
  { ...authority, target: { ...target, allowSubscribe: ["other"] } },
  { ...authority, runId: "other-run" },
]) await assert.rejects(pendingEnrollment({ ...args, authority: changed }), /earlier enrollment with different launch authority/);
assert.equal(await store.get(first.key), await workspaceSecretStore(root).get(first.key));

// Another instance and another space cannot acquire this instance's token.
const otherInstance = await pendingEnrollment({ ...args, instanceId: mintLifecycleUid() });
const otherSpace = await pendingEnrollment({ ...args, space: "other-space" });
assert.notEqual(otherInstance.record.actorToken, first.record.actorToken);
assert.notEqual(otherSpace.record.actorToken, first.record.actorToken);

// A damaged or unreadable record fails closed without overwriting it.
await store.put(first.key, "null");
await assert.rejects(pendingEnrollment(args), /invalid/);
assert.equal(await store.get(first.key), "null");
await store.put(first.key, '{"actorToken":"private-record');
await assert.rejects(pendingEnrollment(args), (error: unknown) => error instanceof Error
  && /unreadable/.test(error.message) && !error.message.includes("private-record"));
const failedStore: SecretStore = {
  identity: store.identity,
  get: async () => { throw new Error("read unavailable"); },
  create: async () => false,
  put: async () => { throw new Error("must not replace"); },
  delete: async () => { throw new Error("must not delete"); },
};
await assert.rejects(pendingEnrollment({ ...args, store: failedStore }), /read unavailable/);
await store.delete(first.key);
const successor = await pendingEnrollment(args);
assert.notEqual(successor.record.actorToken, first.record.actorToken);
assert.notEqual(successor.record.requestId, first.record.requestId);
console.log("pending enrollment smoke: replay, concurrency, authority isolation, corrupt-store refusal and successor identity passed");
console.log(`Retained fixture: ${root}`);
