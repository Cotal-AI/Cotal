import nodeAssert from "node:assert/strict";
import { contractDigest } from "@cotal-ai/core";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { environmentClusterArtifacts, environmentOperationId } from "../src/index.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;
const caller = { owner: "u_owner", actor: "caller", uid: "a".repeat(26) };
const operationId = "contract-positive-0001";
const id = environmentOperationId(caller, operationId);
assert.match(id, /^[a-f0-9]{64}$/);
assert.equal(environmentOperationId({ ...caller }, operationId), id);
for (const other of [
  { ...caller, owner: "u_other" }, { ...caller, actor: "other" }, { ...caller, uid: "b".repeat(26) },
]) assert.notEqual(environmentOperationId(other, operationId), id);
assert.notEqual(environmentOperationId(caller, "contract-positive-0002"), id);
for (const invalid of ["short", "a".repeat(65), "contract.invalid-0001"])
  assert.throws(() => environmentOperationId(caller, invalid), /stable 16-64 character identifier/);

const artifacts = environmentClusterArtifacts();
assert.equal(artifacts.rootDigest, contractDigest(artifacts.document));
assert.equal(artifacts.closureDigest, contractDigest(artifacts.manifest));
assert.equal(artifacts.manifest.root, artifacts.rootDigest);
const digests = new Set(artifacts.artifacts.map(contractDigest));
assert.ok(digests.has(artifacts.rootDigest));
assert.ok(digests.has(artifacts.closureDigest));
assert.deepEqual(artifacts.document.commands.map((c) => [c.name, c.capability]), [
  ["create", "environment.write"], ["inspect", "environment.read"], ["destroy", "environment.write"],
]);
assert.ok(artifacts.document.commands.every((c) => c.class === "ephemeral" && !c.targeted));
console.log("  ✓ environment operation identity and contract artifacts (broker-free)");
emitSentinel({ passed: cells(), failed: 0 });
