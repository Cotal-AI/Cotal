import assert from "node:assert/strict";
import { pendingCandidateLabel } from "../src/pending.js";

for (const name of [" ", "", "\n", " \n\t"]) {
  assert.equal(pendingCandidateLabel(name, undefined, "local.blank"), "", JSON.stringify(name));
  assert.equal(pendingCandidateLabel(name, "worker", "local.blank"), "  label=local.blank/worker", JSON.stringify(name));
  assert.equal(pendingCandidateLabel(name, "worker", "local.blank").includes("\n"), false);
}
assert.equal(pendingCandidateLabel(" ada", "writer", "local.ada"), "  label= ada/writer");
assert.equal(pendingCandidateLabel("healthy-sender", "writer", "local.other"), "  label=healthy-sender/writer");
assert.equal(pendingCandidateLabel(undefined, "worker", "local.blank"), "");
assert.equal(pendingCandidateLabel(" ", " ", "local.blank"), "");

console.log("pending label smoke: all assertions passed");
