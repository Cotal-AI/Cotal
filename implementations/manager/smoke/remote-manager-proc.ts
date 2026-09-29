import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
const authRequire = createRequire(new URL("../../auth/package.json", import.meta.url));
const { SignJWT, importPKCS8 } = authRequire("jose");
import {
  remoteManagerActors,
  remoteManagerRegistrationProof,
  type RemoteManagerAuthorityMaterial,
  type RemoteManagerAuthorityRequest,
} from "@cotal-ai/core";
import { Manager } from "../src/manager.js";
import "@cotal-ai/runtime";
import { managerClusterArtifacts } from "../src/manager-service-contract.js";
import { registerRemoteManagerAuthority } from "../src/remote-register.js";
import {
  currentRegistrationProof,
  loadOrCreateRemoteManagerIdentity,
  materialCredential,
  remoteManagerAuthorityRequest,
  remoteRunAdmission,
  remoteRunAdmissionRequest,
  remoteRunAttemptRequest,
  remoteRunAttemptCredentials,
  remoteRunRenewalCredentials,
  remoteStandingBundleRenewal,
} from "../src/remote-authority.js";

const [space, servers, wsDir, httpUrl, owner, idpKeyFile, idpSub, idpIss] = process.argv.slice(2);
if (!space || !servers || !wsDir || !httpUrl || !owner || !idpKeyFile) {
  console.error("usage: remote-manager-proc <space> <servers> <wsDir> <httpUrl> <owner> <idpKeyFile> <idpSub> <idpIss>");
  process.exit(1);
}

const idpPrivKeyPem = readFileSync(idpKeyFile, "utf8");
const idpKey = await importPKCS8(idpPrivKeyPem, "EdDSA");
const mintIdpJwt = async () =>
  new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer(idpIss || "https://idp.example/ef-joint")
    .setAudience("cotal-services")
    .setSubject(idpSub || "operator-ef")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(idpKey);

const postHttp = async (request: unknown) => {
  const token = await mintIdpJwt();
  const resp = await fetch(httpUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idpToken: token, request }),
  });
  const json = (await resp.json()) as Record<string, unknown>;
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${String(json.error ?? "unknown")}`);
  }
  return json;
};

mkdirSync(join(wsDir, ".cotal"), { recursive: true });
const mgrIdentity = loadOrCreateRemoteManagerIdentity(wsDir, space);
const actors = remoteManagerActors(mgrIdentity.instanceId);

// 1. Prepare
const prepReq = remoteManagerAuthorityRequest(mgrIdentity, "cli", "prepare");
const prepMat = (await postHttp(prepReq)) as unknown as RemoteManagerAuthorityMaterial;
const supervisorCreds = materialCredential(prepMat, "supervisor", mgrIdentity.identities.supervisor);
const executorCreds = materialCredential(prepMat, "executor", mgrIdentity.identities.executor);

// 2. Register on broker
const registered = await registerRemoteManagerAuthority({
  space,
  server: servers,
  owner,
  instanceId: mgrIdentity.instanceId,
  serveActor: actors.serve,
  prepareCreds: executorCreds,
  tlsRequired: false,
  evict: async () => true,
});

// 3. Activate
const artifacts = managerClusterArtifacts();
const contractArtifacts = [artifacts.document, artifacts.manifest];
const activateProof = remoteManagerRegistrationProof(
  owner,
  remoteManagerAuthorityRequest(mgrIdentity, "cli", "activate", `sha256:${"0".repeat(64)}`, contractArtifacts),
);
const activateReq = remoteManagerAuthorityRequest(
  mgrIdentity,
  "cli",
  "activate",
  activateProof,
  contractArtifacts,
);
const activateMat = (await postHttp(activateReq)) as unknown as RemoteManagerAuthorityMaterial;
const retainedRegistrationProof = currentRegistrationProof(activateMat);

const standing = remoteStandingBundleRenewal({
  state: mgrIdentity,
  owner,
  registrationProof: retainedRegistrationProof,
  supervisorCreds,
  call: async (r) => (await postHttp(r)) as unknown as RemoteManagerAuthorityMaterial,
});

const renewExecutor = async () => {
  const renewed = (await postHttp(
    remoteManagerAuthorityRequest(mgrIdentity, "cli", "renew", retainedRegistrationProof),
  )) as unknown as RemoteManagerAuthorityMaterial;
  return materialCredential(renewed, "executor", mgrIdentity.identities.executor);
};

const serveCreds = materialCredential(activateMat, "serve", mgrIdentity.identities.serve);
const goalWriterCreds = materialCredential(activateMat, "goalWriter", mgrIdentity.identities.goalWriter);
const sessionLedgerCreds = materialCredential(activateMat, "sessionLedger", mgrIdentity.identities.sessionLedger);

const runBase = () => ({
  proof: retainedRegistrationProof,
  account: standing.accountPublicKey,
  epoch: registered.processEpoch,
});

const manager = new Manager({
  space,
  servers,
  runtime: "pty",
  workspaceRoot: wsDir,
  remoteAuthority: {
    ...standing,
    renewExecutor,
    owner,
    actors,
    instanceId: mgrIdentity.instanceId,
    lifecycleUid: mgrIdentity.lifecycleUid,
    identities: mgrIdentity.identities,
    supervisorCreds,
    executorCreds,
    serveCreds,
    goalWriterCreds,
    sessionLedgerCreds,
    serveGrant: registered.serveGrant,
    agentBearerExchangeUrl: "https://auth.example.test",
    mintSessionServing: async () => { throw new Error("mintSessionServing unused in test"); },
    mintRetirementRequester: async () => { throw new Error("mintRetirementRequester unused in test"); },
    prepareAgentRetirement: async () => {},
    validateRetainedAgent: async () => { throw new Error("validateRetainedAgent unused in test"); },
    scanGoalIndex: async () => [],
    authorizeAdmin: async () => true,
    runHosting: {
      admitRun: async (run) => {
        const { proof, account, epoch } = runBase();
        const request = remoteRunAdmissionRequest(mgrIdentity, proof, account, epoch, { runId: run.runId, subject: run.subject });
        const result = (await postHttp(request)) as never;
        return remoteRunAdmission(result, request);
      },
      issueAttempt: async ({ runId, takeoverId, epoch, fencingToken, driver, mediator }) => {
        const base = runBase();
        const request = remoteRunAttemptRequest(mgrIdentity, base.proof, base.account, base.epoch, {
          attempt: { runId, takeoverId, epoch, fencingToken, driverId: driver.id, mediatorId: mediator.id },
        });
        const result = (await postHttp(request)) as never;
        const pair = remoteRunAttemptCredentials(result, request, owner, { driver, mediator });
        if (!("driver" in pair)) throw new Error("host returned an operator instead of a run pair");
        return pair;
      },
      issueOperator: async ({ identity, takeoverId, runId, answers }) => {
        const { proof, account, epoch } = runBase();
        const request = remoteRunAttemptRequest(mgrIdentity, proof, account, epoch, {
          operator: { id: identity.id, takeoverId, ...(runId !== undefined ? { runId } : {}), ...(answers !== undefined ? { answers } : {}) },
        });
        const result = (await postHttp(request)) as never;
        const credential = remoteRunAttemptCredentials(result, request, owner, { operator: identity });
        if (!("operator" in credential)) throw new Error("host returned a run pair instead of an operator");
        return credential.operator;
      },
      renewRun: async ({ runId, holder, takeoverId, epoch, fencingToken, driver, mediator }) => {
        const base = runBase();
        const request: RemoteManagerAuthorityRequest = {
          ...remoteManagerAuthorityRequest(mgrIdentity, "cli", "renewRunDriver", base.proof),
          accountPublicKey: base.account,
          processEpoch: base.epoch,
          run: { runId, holder, takeoverId, epoch, fencingToken, driverId: driver.id, mediatorId: mediator.id },
        };
        const result = (await postHttp(request)) as unknown as RemoteManagerAuthorityMaterial;
        return remoteRunRenewalCredentials(result, request, owner, driver, mediator);
      },
    },
  },
});

await manager.start();
console.log(`MANAGER_READY:${mgrIdentity.instanceId}`);

process.on("SIGTERM", async () => {
  await manager.stop().catch(() => {});
  process.exit(0);
});
