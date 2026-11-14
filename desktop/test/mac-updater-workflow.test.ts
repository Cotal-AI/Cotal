import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const { parse } = createRequire(import.meta.url)("yaml");

test("hosted Mac proof is explicit, ARM first, and uses immutable shared fixture input", () => {
  const workflow = parse(readFileSync(new URL("../../.github/workflows/desktop.yml", import.meta.url), "utf8"));
  const proof = parse(readFileSync(new URL("../../.github/workflows/desktop-mac-updater.yml", import.meta.url), "utf8"));
  assert.equal(workflow.on.workflow_dispatch.inputs.updater_apply.default, false);
  assert.equal(workflow.jobs['updater-arm'].with.runner, 'macos-15');
  assert.equal(workflow.jobs['updater-followup'].needs, 'updater-arm');
  assert.equal(proof.on.workflow_call.inputs.fixture_head.required, true);
  assert.ok(proof.jobs.native.steps.some((step: { run?: string }) => step.run?.includes('git fetch origin "$FIXTURE_HEAD"')));
  const steps = workflow.jobs['native-build'].steps as { name?: string; uses?: string; run?: string }[];
  const guard = steps.findIndex(step => step.name === 'Verify compiled updater release inputs');
  const upload = steps.findIndex(step => step.name === 'Upload built desktop packages');
  assert.ok(guard >= 0 && upload > guard, 'actual executable production-config check precedes upload');
});
