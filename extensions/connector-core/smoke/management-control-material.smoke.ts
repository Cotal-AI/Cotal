/** Management control material transport through every manager-facing connector. */
import { strict as assert } from "node:assert";
import { readLaunchMaterial, LAUNCH_MATERIAL_ENV, type Connector, type ManagementControlFence } from "@cotal-ai/core";
import { controlFromEnv } from "../src/config.js";
import { claudeConnector } from "../../connector-claude-code/src/extension.js";
import { codexConnector } from "../../connector-codex/src/extension.js";
import { hermesConnector } from "../../connector-hermes/src/extension.js";
import { jcodeConnector } from "../../connector-jcode/src/extension.js";
import { opencodeConnector } from "../../connector-opencode/src/extension.js";
import { piConnector } from "../../pi/src/connector.js";

const fence: ManagementControlFence = {
  resourceId: "resource-material-smoke",
  bindingId: "binding-material-smoke",
  controllerEpoch: 23,
};
const connectors: Connector[] = [claudeConnector, codexConnector, hermesConnector, jcodeConnector, opencodeConnector, piConnector];
let pass = 0;
for (const connector of connectors) {
  const spec = connector.buildLaunch({ space: "material-smoke", name: `${connector.name}-seat`, managementControl: fence });
  assert.ok(spec.control?.management, `${connector.name}: manager launch result carries the raw management bearer`);
  const materialPath = spec.env?.[LAUNCH_MATERIAL_ENV];
  assert.ok(materialPath, `${connector.name}: launch material path exists`);
  const material = readLaunchMaterial(materialPath);
  assert.equal(material.controlToken, spec.control.token, `${connector.name}: hook token crosses through launch material`);
  assert.deepEqual(
    material.managementControl && {
      resourceId: material.managementControl.resourceId,
      bindingId: material.managementControl.bindingId,
      controllerEpoch: material.managementControl.controllerEpoch,
    },
    fence,
    `${connector.name}: management verifier carries the exact lifecycle fence`,
  );
  assert.notEqual(material.managementControl?.tokenDigest, spec.control.management.token, `${connector.name}: raw management bearer is absent from child material`);
  const parsed = controlFromEnv(spec.env);
  assert.equal(parsed?.managementVerifier?.tokenDigest, material.managementControl?.tokenDigest, `${connector.name}: connector server reconstructs the verifier digest`);
  assert.equal(parsed?.managementVerifier?.fence.resourceId, fence.resourceId, `${connector.name}: connector server reconstructs resourceId`);
  pass += 6;
  console.log(`  ✓ ${connector.name}: raw bearer manager-only, digest + exact fence reach the connector`);
}
console.log(`\nMANAGEMENT CONTROL MATERIAL TESTS PASSED ✅  (${pass} checks)`);
