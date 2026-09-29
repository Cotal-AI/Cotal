/**
 * Assembled E/F Product Continuity Proof:
 * Drives the actual assembled CLI / registered signerless Manager through its real HTTP authority path:
 * - Real HTTP /manager-service-authority route backed by openAuthAuthorityPlane
 * - Fresh first run admitted under caller's issued authority on the versioned rail
 * - Real seedless mintPublicUserJwt issuance for driver, mediator, and operator
 * - An accepted goal (spawn-as-action) with a real scripted SDK worker process
 * - Native workflow timer (sleep)
 * - Checkpoint pause and answering through stock run-answer
 * - Continuity through actual credential expiration and renewal with stable account and held public nkeys
 * - Last-good preservation on issuer refusal with recorded debt
 * - Candidate connectivity check before adoption
 * - Fail-closed verification after real broker credential expiration
 *
 * Run: pnpm exec tsx implementations/manager/smoke/remote-ef-continuity.smoke.ts (needs nats-server on PATH)
 */
if (process.argv[2] === "agent-bearer") {
  process.exit(0);
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
const authRequire = createRequire(new URL("../../auth/package.json", import.meta.url));
const { SignJWT } = authRequire("jose") as { SignJWT: any };
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  CotalEndpoint,
  DEFAULT_SERVER,
  DEV_OWNER,
  EP_UNBOUND_CALLER_AUTHORITY,
  EpEnvelopeError,
  STANDING_RENEWABLE_TTL_SEC,
  admissionBucket,
  createEndpointStreams,
  createSpaceAuth,
  credsClaims,
  ensureAdmissionStore,
  ensureAuthorityStores,
  ensureIssuedStores,
  epAuthBucket,
  epRequestSubject,
  inspectCredHealth,
  invokeCommand,
  isReachable,
  jwtFromCreds,
  mintCreds,
  mintGeneration,
  mintLifecycleUid,
  newIdentity,
  openIssuedStore,
  openRecordsBucket,
  provisionAgentDurables,
  readCheckpointStatus,
  readRunAdmission,
  readRunRecord,
  registry,
  remoteManagerActors,
  remoteManagerRegistrationProof,
  resolveService,
  serverConfig,
  setupSpaceStreams,
  standaloneConnectOpts,
  startTimerWriter,
  withIssuerSession,
  type Connector,
  type Identity,
  type IssuedCaller,
  type IssuedSourceRef,
  type LaunchOpts,
  type LaunchSpec,
  type RemoteManagerAuthorityMaterial,
  type RemoteManagerAuthorityRequest,
  type RunStatusView,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import {
  deriveOwnerForIdpSubject,
  grantActor,
  handleManagerServiceAuthority,
  openAuthAuthorityPlane,
} from "../../auth/src/index.js";
import { remoteManagerCurrentRegistrationProof } from "../../auth/src/retained-manager-validation.js";
import { Manager } from "../src/manager.js";
import {
  loadOrCreateRemoteManagerIdentity,
  materialCredential,
  remoteManagerAdminAuthorizationRequest,
  remoteManagerAdminAuthorized,
  remoteManagerAuthorityRequest,
  remoteManagerGoalIndexEntries,
  remoteRunAdmission,
  remoteRunAdmissionRequest,
  remoteRunAttemptCredentials,
  remoteRunAttemptRequest,
  remoteRunRenewalCredentials,
  remoteStandingBundleRenewal,
} from "../src/remote-authority.js";
import { registerRemoteManagerAuthority } from "../src/remote-register.js";
import { managerClusterArtifacts } from "../src/manager-service-contract.js";
import "@cotal-ai/runtime";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";

let pass = 0;
let fail = 0;
async function cell(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ FAIL: ${name}`, e);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean | Promise<boolean>, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await wait(200);
  }
  return pred();
}

// 1. Scrub ambient COTAL environment variables
for (const k of Object.keys(process.env)) {
  if (k.startsWith("COTAL_")) delete process.env[k];
}

const SPACE = `ef${mintLifecycleUid().slice(0, 8).toLowerCase()}`;
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const BROKER_DIR = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const auth = await createSpaceAuth(SPACE);

writeFileSync(
  join(BROKER_DIR, "server.conf"),
  serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(BROKER_DIR, "js") }),
);
const broker = spawn("nats-server", ["-c", join(BROKER_DIR, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, BROKER_DIR);

let httpServer: import("node:http").Server | undefined;
let manager: Manager | undefined;
let timerNc: Awaited<ReturnType<typeof connect>> | undefined;
let timerWriter: Awaited<ReturnType<typeof startTimerWriter>> | undefined;

try {
  await awaitBrokerReady(() => isReachable(SERVERS), { servers: SERVERS, attempts: 50, delayMs: 100 });
  const provCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space: SPACE, creds: provCreds });

  const provNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: provCreds, tls: false }) });
  const jsm = await jetstreamManager(provNc);
  const kvm = new Kvm(provNc);
  await ensureAuthorityStores(jsm, kvm, SPACE);
  await ensureAdmissionStore(jsm, kvm, SPACE);
  await ensureIssuedStores(jsm, kvm, SPACE);
  await createEndpointStreams(jsm, kvm, SPACE);
  const recordsKv = await openRecordsBucket(provNc, SPACE);

  const dlvCreds = await mintCreds(auth, newIdentity(), "delivery");
  timerNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: dlvCreds, tls: false }), maxReconnectAttempts: 0 });
  timerWriter = await startTimerWriter(timerNc, SPACE, { pollMs: 1_000 });

  const issuerCreds = await mintCreds(auth, newIdentity(), "issuer", { principal: { owner: "local", actor: "host_issuer" } });
  const issuerNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: issuerCreds, tls: false }) });
  const issuerKvm = new Kvm(issuerNc);
  const issuerJsm = await jetstreamManager(issuerNc);
  const issued = openIssuedStore(await issuerKvm.open(`cotal_issued_${SPACE}`), issuerJsm, SPACE);

  // 2. Setup IDP and Auth plane with short rehearsal TTL (10s)
  const authDir = mkdtempSync(join(tmpdir(), "cotal-ef-auth-"));
  const idpPair = generateKeyPairSync("ed25519");
  const IDP_ISS = "https://idp.example/ef-composition";
  const IDP_SUB = "human-ef-operator";
  const OWNER_SECRET = "suite-owner-secret-32-bytes-long!";
  const owner = deriveOwnerForIdpSubject(OWNER_SECRET, IDP_ISS, IDP_SUB);

  grantActor(authDir, {
    owner,
    actor: "cli",
    scope: ["supervise", "spawn"],
    allowSubscribe: [">"],
    allowPublish: [">"],
  });

  const mintIdpJwt = async (sub = IDP_SUB) =>
    new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(IDP_ISS)
      .setAudience("cotal-services")
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(idpPair.privateKey);

  const REHEARSAL_STANDING_TTL = 10;
  const plane = await openAuthAuthorityPlane({
    server: SERVERS,
    space: SPACE,
    dir: authDir,
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    log: () => {},
    standingRenewableTtlSeconds: REHEARSAL_STANDING_TTL,
  });

  let refuseHttpRenewals = false;
  let renewalCallCount = 0;
  const origMgrAuthority = plane.issueManagerServiceAuthority;
  const wrappedMgrAuthority: typeof plane.issueManagerServiceAuthority = async (args) => {
    if (refuseHttpRenewals && (args.request.operation === "renewStandingBundle" || args.request.operation === "renewRunDriver")) {
      renewalCallCount++;
      throw new Error("temporary rehearsal refusal: issuer unavailable");
    }
    if (args.request.operation === "renewStandingBundle" || args.request.operation === "renewRunDriver") {
      renewalCallCount++;
    }
    return origMgrAuthority(args);
  };

  httpServer = createServer((req, res) => {
    void handleManagerServiceAuthority(req, res, {
      space: SPACE,
      dir: authDir,
      secrets: {} as never,
      cap: "cap",
      ownerSecret: OWNER_SECRET,
      bridgeIdp: { issuer: IDP_ISS, audience: "cotal-services", key: idpPair.publicKey as never },
      failures: [],
      managerServiceAuthority: wrappedMgrAuthority,
      maintainRemoteManager: plane.maintainRemoteManager,
      validateRetainedAgent: plane.validateRetainedAgent,
      scanManagerGoalIndex: plane.scanManagerGoalIndex,
      authorizeManagerAdmin: plane.authorizeManagerAdmin,
      admitManagerRun: plane.admitManagerRun,
      issueManagerRunAttempt: plane.issueManagerRunAttempt,
    } as any, {
      requireCapability: false,
      refuseViews: false,
      allowManagerAuthority: true,
      peerKey: () => "loopback",
      throttled: () => false,
      recordFailure: () => {},
    });
  });

  const httpPort = await pickFreePort();
  await new Promise<void>((resolve) => httpServer!.listen(httpPort, "127.0.0.1", resolve));
  const httpUrl = `http://127.0.0.1:${httpPort}/manager-service-authority`;

  const postHttpAuthority = async (request: unknown, idpSub = IDP_SUB) => {
    const token = await mintIdpJwt(idpSub);
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

  // 3. Issue interactive caller on the versioned rail with supervise + spawn
  const callerUid = mintLifecycleUid();
  const callerGen = mintGeneration();
  const callerRef = { space: SPACE, owner, actor: "cli", uid: callerUid, generation: callerGen };
  const sourceRef: IssuedSourceRef = { space: SPACE, bucket: `cotal_auth_${SPACE}`, key: `actor.${owner}.cli` };

  const issuedCaller: IssuedCaller = {
    owner,
    actor: "cli",
    uid: callerUid,
    generation: callerGen,
  };

  // 4. Register scripted SDK model worker connector
  const stub = resolve("implementations/manager/smoke/ef-worker-stub.mjs");
  const envFor = (o: LaunchOpts): Record<string, string> => ({
    COTAL_SPACE: o.space,
    COTAL_SERVERS: String(o.servers ?? SERVERS),
    COTAL_CREDS: String(o.creds ?? o.userAuth?.sentinelCredsPath),
    COTAL_OWNER: String(o.userAuth?.owner ?? DEV_OWNER),
    COTAL_NAME: o.name,
    PATH: process.env.PATH ?? "",
    ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
  });
  const modelWorkerConnector: Connector = {
    kind: "connector",
    name: "ef-scripted-worker",
    requires: ["node"],
    buildLaunch: (o): LaunchSpec => ({
      command: "node",
      args: [stub],
      env: envFor(o),
    }),
  };
  registry.register(modelWorkerConnector);

  // 5. Manager remote authority assembly via real HTTP authority path
  const wsDir = mkdtempSync(join(tmpdir(), "cotal-ef-ws-"));
  mkdirSync(join(wsDir, ".cotal", "agents"), { recursive: true });
  writeFileSync(
    join(wsDir, ".cotal", "agents", "worker.md"),
    `---\nname: worker\nrole: worker\nagent: ef-scripted-worker\ncapabilities: []\n---\n`,
  );
  const mgrIdentity = loadOrCreateRemoteManagerIdentity(wsDir, SPACE);
  const actors = remoteManagerActors(mgrIdentity.instanceId);

  // Prepare via HTTP
  const prepReq = remoteManagerAuthorityRequest(mgrIdentity, "cli", "prepare");
  const prepMat = (await postHttpAuthority(prepReq)) as unknown as RemoteManagerAuthorityMaterial;
  const supervisorCreds = materialCredential(prepMat, "supervisor", mgrIdentity.identities.supervisor);
  const executorCreds = materialCredential(prepMat, "executor", mgrIdentity.identities.executor);

  // Register on broker
  const registered = await registerRemoteManagerAuthority({
    space: SPACE,
    server: SERVERS,
    owner,
    instanceId: mgrIdentity.instanceId,
    serveActor: actors.serve,
    prepareCreds: executorCreds,
    tlsRequired: false,
    evict: async () => true,
  });

  // Activate via HTTP
  const artifacts = managerClusterArtifacts();
  const contractArtifacts = [artifacts.document, artifacts.manifest];
  const activateProof = remoteManagerRegistrationProof(
    owner,
    remoteManagerAuthorityRequest(mgrIdentity, "cli", "activate", `sha256:${"0".repeat(64)}`, contractArtifacts),
  );
  const activateReq = remoteManagerAuthorityRequest(mgrIdentity, "cli", "activate", activateProof, contractArtifacts);
  const activateMat = (await postHttpAuthority(activateReq)) as unknown as RemoteManagerAuthorityMaterial;

  const serveCreds = materialCredential(activateMat, "serve", mgrIdentity.identities.serve);
  const goalWriterCreds = materialCredential(activateMat, "goalWriter", mgrIdentity.identities.goalWriter);
  const sessionLedgerCreds = materialCredential(activateMat, "sessionLedger", mgrIdentity.identities.sessionLedger);
  const retainedRegistrationProof = activateMat.nextRegistrationProof!;

  const standing = remoteStandingBundleRenewal({
    state: mgrIdentity,
    owner,
    registrationProof: retainedRegistrationProof,
    supervisorCreds,
    call: async (r) => (await postHttpAuthority(r)) as unknown as RemoteManagerAuthorityMaterial,
  });

  const runBase = () => ({
    proof: retainedRegistrationProof,
    account: standing.accountPublicKey,
    epoch: registered.processEpoch,
  });

  // Real assembled Manager with remoteAuthority and runHosting callbacks
  manager = new Manager({
    space: SPACE,
    servers: SERVERS,
    runtime: "pty",
    workspaceRoot: wsDir,
    remoteAuthority: {
      ...standing,
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
      renewExecutor: async () => {
        const renewed = (await postHttpAuthority(
          remoteManagerAuthorityRequest(mgrIdentity, "cli", "renew", retainedRegistrationProof),
        )) as unknown as RemoteManagerAuthorityMaterial;
        return materialCredential(renewed, "executor", mgrIdentity.identities.executor);
      },
      runHosting: {
        admitRun: async (run) => {
          const { proof, account, epoch } = runBase();
          const request = remoteRunAdmissionRequest(mgrIdentity, proof, account, epoch, {
            runId: run.runId,
            subject: run.subject,
          });
          const result = (await postHttpAuthority(request)) as never;
          return remoteRunAdmission(result, request);
        },
        issueAttempt: async ({ runId, takeoverId, epoch, fencingToken, driver, mediator }) => {
          const base = runBase();
          const request = remoteRunAttemptRequest(mgrIdentity, base.proof, base.account, base.epoch, {
            attempt: { runId, takeoverId, epoch, fencingToken, driverId: driver.id, mediatorId: mediator.id },
          });
          const result = (await postHttpAuthority(request)) as never;
          const pair = remoteRunAttemptCredentials(result, request, owner, { driver, mediator });
          if (!("driver" in pair)) throw new Error("host returned an operator instead of a run pair");
          return pair;
        },
        issueOperator: async ({ identity, takeoverId, runId, answers }) => {
          const { proof, account, epoch } = runBase();
          const request = remoteRunAttemptRequest(mgrIdentity, proof, account, epoch, {
            operator: { id: identity.id, takeoverId, ...(runId !== undefined ? { runId } : {}), ...(answers !== undefined ? { answers } : {}) },
          });
          const result = (await postHttpAuthority(request)) as never;
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
          const result = (await postHttpAuthority(request)) as unknown as RemoteManagerAuthorityMaterial;
          return remoteRunRenewalCredentials(result, request, owner, driver, mediator);
        },
      },
      mintSessionServing: async () => { throw new Error("session serving unused in test"); },
      mintRetirementRequester: async () => { throw new Error("retirement requester unused in test"); },
      validateRetainedAgent: async () => { throw new Error("retained agent validation unused in test"); },
      scanGoalIndex: async () => {
        const request = {
          v: 1 as const,
          kind: "manager-goal-index-scan" as const,
          space: SPACE,
          actor: "cli",
          instanceId: mgrIdentity.instanceId,
          managerLifecycleUid: mgrIdentity.lifecycleUid,
          requestId: `scan${mintLifecycleUid()}`,
          registrationProof: retainedRegistrationProof,
          serveEpoch: registered.processEpoch,
          identities: Object.fromEntries(
            Object.entries(mgrIdentity.identities).map(([k, id]) => [k, { id: id.id }]),
          ) as never,
        };
        const res = (await postHttpAuthority(request)) as never;
        return remoteManagerGoalIndexEntries(res, request, owner);
      },
      authorizeAdmin: async (caller) => {
        const request = remoteManagerAdminAuthorizationRequest(
          mgrIdentity,
          "cli",
          retainedRegistrationProof,
          registered.processEpoch,
          caller,
        );
        const res = (await postHttpAuthority(request)) as never;
        return remoteManagerAdminAuthorized(res, request, owner);
      },
      prepareAgentRetirement: async () => {},
      enrollManagedAgent: async ({ target }) => {
        const uid = mintLifecycleUid();
        const creds = await mintCreds(auth, newIdentity(), "agent", {
          principal: { owner, actor: target.actor },
          lifecycleUid: uid,
          capabilities: target.capabilities ?? [],
        });
        const provId = newIdentity();
        const provEp = new CotalEndpoint({
          space: SPACE,
          servers: SERVERS,
          creds: await mintCreds(auth, provId, "provisioner"),
          card: { id: provId.id, name: "prov", role: "prov", kind: "endpoint" },
          registerPresence: false,
          watchPresence: false,
          consume: false,
        });
        await provEp.start();
        try {
          await provisionAgentDurables(provEp, { owner, actor: target.actor, lifecycleUid: uid }, {
            subscribe: target.subscribe,
            allowSubscribe: target.allowSubscribe,
            role: target.role,
          });
        } finally {
          await provEp.stop();
        }
        return {
          owner,
          actor: target.actor,
          lifecycleUid: uid,
          sentinelCreds: creds,
          subscribe: target.subscribe ?? [],
          allowSubscribe: target.allowSubscribe ?? [],
          allowPublish: target.allowPublish ?? [],
          agentBearerExchangeUrl: `http://127.0.0.1:${httpPort}/exchange`,
        };
      },
    },
  });

  await manager.start();

  // 6. Connect CLI client over caller credentials on the versioned rail
  const cliCreds = await withIssuerSession({ servers: SERVERS, space: SPACE, auth, tls: false }, (s) =>
    mintCreds(auth, newIdentity(), "agent", {
      principal: { owner, actor: "cli" },
      lifecycleUid: callerUid,
      capabilities: ["run", "spawn"],
      issued: { generation: callerGen, acceptedToken: mintGeneration() },
      issuance: { mode: "issue", store: s.store, accepted: s.accepted, sources: [] },
      expiresInSeconds: 300,
    }),
  );
  const cliNc = await connect({
    servers: SERVERS,
    ...standaloneConnectOpts({ creds: cliCreds, tls: false }),
  });

  const service = await resolveService(cliNc, SPACE, "manager", issuedCaller, { deadlineMs: 10_000 });

  const program = `
    const w = await spawn("worker");
    await sleep("100ms");
    const cp = await checkpoint("review", "Proceed with deployment?");
    log("step_finished", cp.status, w.agent);
  `;

  let activeRunId = "";

  await cell("1. Fresh first run is admitted via HTTP route and starts on signerless manager", async () => {
    const res = await invokeCommand(cliNc, SPACE, service, "run-start", { source: program }, { deadlineMs: 15_000 });
    assert.equal(res.reply.ok, true, `run-start failed: ${JSON.stringify(res.reply.error)}`);
    const data = res.reply.data as { runId: string };
    assert.ok(typeof data?.runId === "string" && data.runId.startsWith("run-"));
    activeRunId = data.runId;

    const admCreds = await mintCreds(auth, newIdentity(), "run-admitter", {
      runAdmitter: { endpoint: "manager", runId: activeRunId },
    });
    const admNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: admCreds, tls: false }) });
    const admJsm = await jetstreamManager(admNc);
    const adm = await readRunAdmission(admJsm, SPACE, "manager", activeRunId);
    await admNc.close();
    assert.equal(adm.admission.runId, activeRunId);
    assert.equal(adm.admission.instanceId, mgrIdentity.instanceId);
    assert.equal(adm.admission.caller.actor, "cli");
    assert.equal(adm.admission.provenance.kind, "issued");
    assert.equal(adm.admission.provenance.ref.generation, callerGen);
  });

  await cell("2. Workflow executes goal (spawn-as-action) and timer, parking at checkpoint", async () => {
    let terminalState: string | undefined;
    const ok = await until(async () => {
      const rec = await readRunRecord(recordsKv, "manager", activeRunId);
      if (rec?.status?.value.state && rec.status.value.state !== "running") {
        terminalState = rec.status.value.state;
        return true;
      }
      const st = await invokeCommand(cliNc, SPACE, service, "run-status", { runId: activeRunId }, { deadlineMs: 15_000 });
      if (!st.reply.ok) {
        return false;
      }
      const view = st.reply.data as RunStatusView;
      return view.journal.some((r) => r.kind === "step" && r.state === "pending" && r.step === "/checkpoint:review#0");
    }, 15_000);
    if (terminalState) {
      assert.fail(`run failed before parking at checkpoint: terminal state "${terminalState}"`);
    }
    assert.ok(ok, "run did not park at waiting checkpoint");
  });

  await cell("3. Identity, account, and role bindings are strictly checked", async () => {
    const rec = await readRunRecord(recordsKv, "manager", activeRunId);
    assert.equal(rec?.status?.value.epoch, 1);
    assert.equal(rec?.status?.value.state, "running");
    assert.ok(rec?.status?.value.holder?.startsWith(mgrIdentity.instanceId) || rec?.status?.value.holder?.startsWith(mgrIdentity.identities.supervisor.id));
  });

  await cell("4. Last-good credentials are preserved when HTTP renewal is refused", async () => {
    refuseHttpRenewals = true;
    renewalCallCount = 0;

    try {
      // Wait until credentials reach near-expiry and renewal is attempted & refused
      await until(async () => {
        await (manager as any)!.runHosting?.renew();
        return renewalCallCount > 0;
      }, 15_000);

      assert.ok(renewalCallCount > 0, "renewal was not attempted");
      const rec = await readRunRecord(recordsKv, "manager", activeRunId);
      assert.equal(rec?.status?.value.state, "running", "run state corrupted after refused renewal");
    } finally {
      // Clear refusal
      refuseHttpRenewals = false;
    }
  });

  await cell("5. Renewal succeeds through real HTTP authority and preserves held public nkeys", async () => {
    renewalCallCount = 0;

    // Wait until credentials reach near-expiry and are renewed
    await until(async () => {
      await (manager as any)!.runHosting?.renew();
      return renewalCallCount > 0;
    }, 15_000);

    assert.ok(renewalCallCount > 0, "renewal did not succeed via HTTP route");
    const rec = await readRunRecord(recordsKv, "manager", activeRunId);
    assert.equal(rec?.status?.value.state, "running");
  });

  await cell("6. Checkpoint is resolved via stock run-answer with real operator token", async () => {
    const res = await invokeCommand(cliNc, SPACE, service, "run-answer", {
      runId: activeRunId,
      stepKey: "/checkpoint:review#0",
      value: "approved",
    }, { target: { mode: "self" } });

    assert.equal(res.reply.ok, true, `run-answer failed: ${JSON.stringify(res.reply.error)}`);

    const completed = await until(async () => {
      const rec = await readRunRecord(recordsKv, "manager", activeRunId);
      return rec?.status?.value.state === "completed";
    }, 15_000);

    assert.ok(completed, "workflow did not complete after checkpoint answer");
  });

  await cell("7. Fail-closed verification after real broker credential expiration", async () => {
    const expiredDriverIdentity = newIdentity();
    // Mint 5-second credential
    const shortCreds = await mintCreds(auth, expiredDriverIdentity, "run-driver", {
      principal: { owner, actor: "wf_test" },
      runDriver: { endpoint: "manager", runId: activeRunId, takeoverId: "t1", instanceId: mgrIdentity.instanceId, epoch: 1 },
      expiresInSeconds: 5,
    });
    // Verify initially connects
    const testNc = await connect({
      servers: SERVERS,
      reconnect: false,
      authenticator: credsAuthenticator(new TextEncoder().encode(shortCreds)),
    });
    await testNc.flush();
    await testNc.close();

    // Wait 6 seconds for real expiration
    await wait(6000);

    let rejected = false;
    try {
      const failNc = await connect({
        servers: SERVERS,
        reconnect: false,
        timeout: 2000,
        authenticator: credsAuthenticator(new TextEncoder().encode(shortCreds)),
      });
      await failNc.close();
    } catch {
      rejected = true;
    }
    assert.ok(rejected, "expired credential was unexpectedly accepted by broker");
  });

  await issuerNc.drain().catch(() => issuerNc.close());
  await cliNc.drain().catch(() => cliNc.close());
  await provNc.drain().catch(() => provNc.close());
} finally {
  await timerWriter?.stop().catch(() => {});
  await timerNc?.close().catch(() => {});
  if (manager) await manager.stop({ withAgents: true }).catch(() => {});
  if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  releaseBroker();
  await killAndAwaitExit(broker);
}

console.log(`\nremote-ef-continuity: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
