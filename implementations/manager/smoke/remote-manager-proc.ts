import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  credsClaims,
  mintLifecycleUid,
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
  remoteManagerAdminAuthorizationRequest,
  remoteManagerAdminAuthorized,
  remoteManagedAgentEnrollmentMaterial,
  remoteManagedAgentEnrollmentRequest,
  remoteManagerAuthorityRequest,
  remoteManagerGoalIndexEntries,
  remoteRunAdmission,
  remoteRunAdmissionRequest,
  remoteRunAttemptRequest,
  remoteRunAttemptCredentials,
  remoteRunRenewalCredentials,
  remoteStandingBundleRenewal,
} from "../src/remote-authority.js";

const [space, servers, wsDir, httpUrl, owner, bearerToken] = process.argv.slice(2);
if (!space || !servers || !wsDir || !httpUrl || !owner || !bearerToken) {
  console.error("usage: remote-manager-proc <space> <servers> <wsDir> <httpUrl> <owner> <bearerToken>");
  process.exit(1);
}

const postHttp = async (request: unknown) => {
  const resp = await fetch(httpUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idpToken: bearerToken, request }),
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
    mintSessionServing: async () => { throw new Error("mintSessionServing unsupported in signerless continuity smoke"); },
    mintRetirementRequester: async () => { throw new Error("mintRetirementRequester unsupported in signerless continuity smoke"); },
    prepareAgentRetirement: async () => { throw new Error("prepareAgentRetirement unsupported in signerless continuity smoke"); },
    validateRetainedAgent: async () => { throw new Error("validateRetainedAgent unsupported in signerless continuity smoke"); },
    scanGoalIndex: async () => {
      const { proof, epoch } = runBase();
      const request = {
        v: 1 as const,
        kind: "manager-goal-index-scan" as const,
        space,
        actor: "cli",
        instanceId: mgrIdentity.instanceId,
        managerLifecycleUid: mgrIdentity.lifecycleUid,
        requestId: `scan${mintLifecycleUid()}`,
        registrationProof: proof,
        serveEpoch: epoch,
        identities: Object.fromEntries(
          Object.entries(mgrIdentity.identities).map(([k, id]) => [k, { id: id.id }]),
        ) as never,
      };
      const res = (await postHttp(request)) as never;
      return remoteManagerGoalIndexEntries(res, request, owner);
    },
    authorizeAdmin: async (caller) => {
      const { proof, epoch } = runBase();
      const request = remoteManagerAdminAuthorizationRequest(
        mgrIdentity,
        "cli",
        proof,
        epoch,
        caller,
      );
      const res = (await postHttp(request)) as never;
      return remoteManagerAdminAuthorized(res, request, owner);
    },
    // FIXTURE: the manager's enrollment callback targets the labelled fixture host interception path.
    enrollManagedAgent: async ({ target }) => {
      const { proof, epoch } = runBase();
      const request = remoteManagedAgentEnrollmentRequest(mgrIdentity, "cli", proof, epoch, target);
      const url = httpUrl.replace("/manager-service-authority", "/fixture-host/manager-service-authority");
      const resp = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idpToken: bearerToken, request }) });
      const json = (await resp.json()) as Record<string, unknown>;
      if (!resp.ok) throw new Error(`fixture host HTTP ${resp.status}: ${String(json.error ?? "unknown")}`);
      return remoteManagedAgentEnrollmentMaterial(json as never, request);
    },
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

// FIXTURE-ONLY observation seam: on a `PROBE <runId>` stdin line, report bounded non-secret
// metadata (public nkey, exp, debt reason, connection state, a live broker dial verdict) read from
// the run-hosting's ACTUAL held objects. Never emits a JWT or seed. Not a product API.
let stdinBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  stdinBuf += chunk;
  let i: number;
  while ((i = stdinBuf.indexOf("\n")) >= 0) {
    const line = stdinBuf.slice(0, i).trim();
    stdinBuf = stdinBuf.slice(i + 1);
    const m = line.match(/^PROBE (\S+)$/);
    if (m) void probe(m[1]!);
    const ep = line.match(/^ENROLL_PROBE(?: (stock|host|host-forged|host-intruder))?$/);
    if (ep) void enrollProbe((ep[1] ?? "stock") as "stock" | "host" | "host-forged" | "host-intruder");
  }
});
async function probe(runId: string) {
  const run = (manager as any).runHosting?.runs?.get(runId);
  const meta = (creds: unknown) => {
    if (typeof creds !== "string") return null;
    const c = credsClaims(creds);
    return { sub: c.sub, exp: c.exp, account: c.nats?.issuer_account };
  };
  let executorDialRefused: boolean | null = null;
  const execCreds = (manager as any).remoteExecutorCreds;
  if (typeof execCreds === "string") {
    try {
      const nc = await connect({ servers, reconnect: false, authenticator: credsAuthenticator(new TextEncoder().encode(execCreds)) });
      await nc.close();
      executorDialRefused = false;
    } catch {
      executorDialRefused = true;
    }
  }
  let dialRefused: boolean | null = null;
  if (typeof run?.creds === "string") {
    try {
      const nc = await connect({ servers, reconnect: false, authenticator: credsAuthenticator(new TextEncoder().encode(run.creds)) });
      await nc.close();
      dialRefused = false;
    } catch {
      dialRefused = true;
    }
  }
  const out = run
    ? {
        runId,
        held: true,
        driver: meta(run.creds),
        mediator: meta(run.mediatorCreds),
        debt: run.renewalDebt?.reason ?? null,
        driverConnClosed: run.nc ? run.nc.isClosed() : null,
        dialRefused,
        standing: standingMeta(),
        executorDialRefused,
      }
    : { runId, held: false, standing: standingMeta(), executorDialRefused };
  console.log(`PROBE_RESULT:${JSON.stringify(out)}`);
}
/** Standing duty metadata from the manager's ACTUAL held fields (fixture-only; public data only). */
function standingMeta() {
  const m = manager as any;
  const held: Record<string, unknown> = {
    supervisor: m.remoteSupervisorCreds,
    executor: m.remoteExecutorCreds,
    serve: m.serviceServe?.creds,
    goalWriter: m.goalWriterCreds,
    sessionLedger: m.sessionLedgerCreds,
  };
  const now = Math.floor(Date.now() / 1000);
  const out: Record<string, unknown> = { debt: m.remoteRenewalDebt?.reason ?? null };
  for (const [k, v] of Object.entries(held)) {
    if (typeof v !== "string") { out[k] = null; continue; }
    const c = credsClaims(v);
    out[k] = { sub: c.sub, exp: c.exp, account: c.nats?.issuer_account, live: typeof c.exp === "number" && c.exp > now };
  }
  return out;
}

process.on("SIGTERM", async () => {
  await manager.stop().catch(() => {});
  process.exit(0);
});

// FIXTURE-ONLY: send one real managed-agent enrollment request (token DIGEST only) through the
// same public authority route the manager's callbacks use, and report status/error text only.
async function enrollProbe(mode: "stock" | "host" | "host-forged" | "host-intruder") {
  const { proof, epoch } = runBase();
  const request = remoteManagedAgentEnrollmentRequest(mgrIdentity, mode === "host-intruder" ? "intruder" : "cli", proof, epoch, {
    actor: "sdk_fixture", tokenHash: "0".repeat(64), allowSubscribe: [">"],
  });
  if (mode === "host-forged") request.registrationProof = `sha256:${"f".repeat(64)}`;
  const url = mode === "stock" ? httpUrl : httpUrl.replace("/manager-service-authority", "/fixture-host/manager-service-authority");
  const resp = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idpToken: bearerToken, request }) });
  const json = (await resp.json().catch(() => ({}))) as { error?: unknown };
  console.log(`ENROLL_RESULT:${JSON.stringify({ mode, status: resp.status, error: String(json.error ?? "").slice(0, 200) })}`);
}
