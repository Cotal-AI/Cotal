import assert from "node:assert/strict";
import * as manager from "@cotal-ai/manager";
import { contractDigest } from "@cotal-ai/core";
import { emitSentinel } from "@cotal-ai/smoke-kit";

let checked = 0;
try {
  const root = manager as unknown as Record<string, unknown>;
  assert.equal(typeof root.remoteManagerClient, "object", "public manager root exposes remoteManagerClient");
  checked++;
  assert.equal(typeof root.registerRemoteManagerAuthority, "function", "public manager root exposes native manager registration");
  checked++;
  const client = root.remoteManagerClient as Record<string, unknown>;
  for (const name of [
    "loadOrCreateRemoteManagerIdentity", "remoteManagerAuthorityRequest", "materialCredential",
    "currentRegistrationProof", "remoteStandingBundleRenewal", "remoteManagerRenewalCredentials",
    "remoteRunAdmissionRequest", "remoteRunAdmission", "remoteRunAttemptRequest",
    "remoteRunAttemptCredentials", "remoteRunRenewalCredentials",
    "remoteManagerAdminAuthorizationRequest", "remoteManagerAdminAuthorized", "remoteManagerGoalIndexEntries",
    "remoteManagerMaintenanceRequest", "remoteManagerMaintenanceResult", "remoteRetainedAgentValidationRequest",
    "retainedAgentAuthority", "expectedRemoteManagerActors", "remoteManagedAgentEnrollmentRequest",
    "remoteManagedAgentEnrollmentMaterial", "remoteManagedAgentPrepareRetirementRequest", "remoteManagedAgentRetirementPrepared",
    "remoteManagedAgentRuntimeRequest", "remoteManagedAgentRuntimeState",
  ]) {
    assert.equal(typeof client[name], "function", `public manager client exports ${name}`);
    checked++;
  }
  assert.equal(typeof root.managerClusterArtifacts, "function", "public manager root exposes canonical activation artifacts");
  checked++;
  assert.equal(typeof root.Manager, "function", "public manager root exposes the Manager constructor");
  checked++;
  const artifacts = manager.managerClusterArtifacts();
  assert.equal(contractDigest(artifacts.document), artifacts.rootDigest, "public activation document has its canonical digest");
  checked++;
  assert.equal(artifacts.manifest.root, artifacts.rootDigest, "public activation manifest names the canonical document");
  checked++;
  assert.equal(contractDigest(artifacts.manifest), artifacts.closureDigest, "public activation manifest has its canonical closure digest");
  checked++;
} catch (error) {
  console.error(error);
  emitSentinel({ passed: checked, failed: 1 });
  process.exit(1);
}
console.log(`public remote authority: ${checked} package-root assertions; native continuity follows`);
process.env.EF_PUBLIC_AUTHORITY = "1";
process.env.EF_REFUSE_SCOPE = "run";
await import("./remote-ef-continuity.smoke.js");
export {};
