/**
 * Authenticated HTTP service route tests for manager-run-attempt and operator issuance.
 * Tests POST /manager-service-authority with manager-run-attempt:
 * - Legitimate first-attempt and resume issuance returning closed response with NO seeds
 * - Real broker authentication with issued role credentials (driver, mediator, operator)
 * - Distinction between initial issue and resume/renewal of an activated run
 * - Read operator and waiting-checkpoint answer operator issuance
 * - Route refusals: missing supervise, stale registration/epoch, foreign account/instance/run,
 *   unrecorded/revoked admission, non-waiting checkpoint, and malformed request shapes.
 *
 * Run: (cd implementations/auth && npx tsx smoke/remote-run-attempt-route.smoke.ts)
 */
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT } from "jose";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  admissionBucket, createEndpointStreams, createRunAdmission, createRunSpec, createSpaceAuth,
  credsFromJwt, ensureAdmissionStore, ensureAuthorityStores, ensureIssuedStores, epAuthBucket,
  epgateKey, mintCheckpoint, mintGeneration, mintLifecycleUid, newIdentity, openRecordsBucket,
  readRunAdmission, remoteManagerActors, revokeRunAdmission, standaloneConnectOpts, writeRunStatus,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { deriveOwnerForIdpSubject, grantActor, openAuthAuthorityPlane, handleManagerServiceAuthority } from "../src/index.js";
import { remoteManagerCurrentRegistrationProof } from "../src/retained-manager-validation.js";
import { pickFreePort } from "./_free-port.js";

let fail = 0;
const c = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) console.log(`  ✓ ${name}`);
  else { fail++; console.log(`  ✗ FAIL: ${name}`, detail ?? ""); }
};

const SPACE = "attemptroute";
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(sd, "server.conf"), `
port: ${PORT}
listen: 127.0.0.1:${PORT}
max_control_line: 65536
jetstream { store_dir: ${JSON.stringify(sd)} }
`);
const broker = spawn("nats-server", ["-c", join(sd, "server.conf")], { stdio: "ignore" });
const release = teardownOnSignal(broker, sd);

try {
  const servers = `nats://127.0.0.1:${PORT}`;
  await awaitBrokerReady(() => connect({ servers }).then((n) => n.close().then(() => true), () => false), { servers, attempts: 50, delayMs: 100 });
  const nc = await connect({ servers });
  const jsm = await jetstreamManager(nc);
  const kvm = new Kvm(nc);

  const auth = await createSpaceAuth(SPACE);
  await ensureAuthorityStores(jsm, kvm, SPACE);
  await ensureAdmissionStore(jsm, kvm, SPACE);
  await ensureIssuedStores(jsm, kvm, SPACE);
  await createEndpointStreams(jsm, kvm, SPACE);

  const admissions = await kvm.open(admissionBucket(SPACE));
  const records = await openRecordsBucket(nc, SPACE, { create: true });
  const epKv = await kvm.open(epAuthBucket(SPACE));

  const authDir = mkdtempSync(join(tmpdir(), "cotal-attempt-auth-"));
  const idpPair = generateKeyPairSync("ed25519");
  const IDP_ISS = "https://idp.example/attempt-route";
  const ownerSecret = "suite-owner-secret-32-bytes-long!";
  const httpOwner = deriveOwnerForIdpSubject(ownerSecret, IDP_ISS, "human-attempt");

  // Ledger: cli has supervise; nosupervise lacks supervise
  grantActor(authDir, { owner: httpOwner, actor: "cli", scope: ["supervise", "spawn"], allowSubscribe: [">"], allowPublish: [">"] });
  grantActor(authDir, { owner: httpOwner, actor: "nosupervise", scope: ["spawn", "admin"], allowSubscribe: [">"], allowPublish: [">"] });

  const instanceId = mintLifecycleUid();
  const lifecycleUid = mintLifecycleUid();
  const actors = remoteManagerActors(instanceId);
  const identities = {
    supervisor: { id: newIdentity().id },
    executor: { id: newIdentity().id },
    serve: { id: newIdentity().id },
    goalWriter: { id: newIdentity().id },
    sessionLedger: { id: newIdentity().id },
  };
  const gate = { state: "open" as const, principal: `${httpOwner}.${actors.serve}`, processEpoch: 3, registrationRevision: 7 };
  await epKv.put(epgateKey("manager", instanceId), new TextEncoder().encode(JSON.stringify({
    ...gate, generation: 1, nameAuthorityRevision: 0,
  })));

  const plane = await openAuthAuthorityPlane({
    server: servers,
    space: SPACE,
    dir: authDir,
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    log: () => {},
  });

  const cap = "operator-cap-secret";
  const httpCtx = {
    space: SPACE,
    dir: authDir,
    ownerSecret,
    bridgeIdp: { issuer: IDP_ISS, audience: IDP_ISS, key: (async () => idpPair.publicKey) as never },
    managerServiceAuthority: plane.issueManagerServiceAuthority,
    maintainRemoteManager: plane.maintainRemoteManager,
    validateRetainedAgent: plane.validateRetainedAgent,
    verifyManagedAgentEnrollment: plane.verifyManagedAgentEnrollment,
    verifyManagedAgentPrepareRetirement: plane.verifyManagedAgentPrepareRetirement,
    scanManagerGoalIndex: plane.scanManagerGoalIndex,
    authorizeManagerAdmin: plane.authorizeManagerAdmin,
    admitManagerRun: plane.admitManagerRun,
    issueManagerRunAttempt: plane.issueManagerRunAttempt,
    secrets: new Map() as never,
    retireInteractiveLifecycle: plane.retireInteractiveLifecycle,
    retireManagedLifecycle: plane.retireManagedLifecycle,
    cap,
    failures: [],
    badCaps: [],
    mintConnectCredential: plane.mintConnectCredential,
    selectManagerInstance: plane.selectManagerInstance,
  };
  const httpServer = createServer((req, res) => void handleManagerServiceAuthority(req, res, httpCtx as never, {
    requireCapability: true,
    refuseViews: false,
    allowManagerAuthority: true,
    peerKey: () => "127.0.0.1",
    throttled: () => false,
    recordFailure: () => {},
  }));
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", () => r()));
  const httpUrl = `http://127.0.0.1:${(httpServer.address() as import("node:net").AddressInfo).port}/manager-service-authority`;

  const idpToken = await new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
    .setSubject("human-attempt")
    .setIssuer(IDP_ISS)
    .setAudience(IDP_ISS)
    .setIssuedAt(Math.floor(Date.now() / 1000))
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(idpPair.privateKey);

  const baseReq = {
    v: 1, kind: "manager-run-attempt", space: SPACE, actor: "cli", instanceId,
    managerLifecycleUid: lifecycleUid, accountPublicKey: auth.account.pub, processEpoch: 3, identities,
  } as const;
  const proof = remoteManagerCurrentRegistrationProof(auth.account.signingSeed, httpOwner, baseReq, gate);

  const postHttp = async (reqBody: unknown, capHdr = `Bearer ${cap}`) => {
    const res = await fetch(httpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: capHdr },
      body: JSON.stringify({ idpToken, request: reqBody }),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, body: data as Record<string, unknown> };
  };

  const newRun = () => `run-${Buffer.from(mintGeneration().slice(0, 16)).toString("hex").slice(0, 32)}`;
  const admit = async (runId: string, inst = instanceId) => createRunAdmission(admissions, {
    version: 1, space: SPACE, endpoint: "manager", runId, instanceId: inst,
    caller: { owner: httpOwner, actor: "alice", uid: mintLifecycleUid(), generation: mintGeneration() } as never,
    ceiling: { publish: { allow: { mode: "none" }, deny: [] }, subscribe: { allow: { mode: "none" }, deny: [] } },
    provenance: { kind: "operator", by: "suite", reason: "fixture" }, admittedAt: Date.now(),
  });

  // 1. Control: fixture IdP exchanges signed token for derived owner on HTTP service route
  c("control: fixture IdP derives expected owner for authenticated HTTP requests", httpOwner.startsWith("u_"));

  // 2. First attempt under stored admission: closed response with driver/mediator JWTs and NO seeds
  const first = newRun();
  await admit(first);
  const driverIdentity = newIdentity();
  const mediatorIdentity = newIdentity();
  const attemptReq = {
    ...baseReq,
    requestId: `req-${mintLifecycleUid()}`,
    registrationProof: proof,
    attempt: {
      runId: first, takeoverId: "t".repeat(16), epoch: 1, fencingToken: 1,
      driverId: driverIdentity.id, mediatorId: mediatorIdentity.id,
    },
  };
  const firstRes = await postHttp(attemptReq);
  const firstBody = firstRes.body as {
    v?: number; kind?: string; driver?: { jwt?: string; exp?: number }; mediator?: { jwt?: string; exp?: number };
  };
  const closedKeys = Object.keys(firstBody).sort().join(",");
  c("first attempt returns HTTP 200 with closed response schema and NO seeds",
    firstRes.status === 200 && firstBody.v === 1 && firstBody.kind === "manager-run-attempt" &&
    typeof firstBody.driver?.jwt === "string" && typeof firstBody.driver?.exp === "number" &&
    typeof firstBody.mediator?.jwt === "string" && typeof firstBody.mediator?.exp === "number" &&
    closedKeys === "actor,driver,instanceId,kind,managerLifecycleUid,mediator,owner,requestId,space,v" &&
    !JSON.stringify(firstBody).includes("seed"), firstBody);

  // 3. Issued driver credential authenticates to broker
  let driverConnected = false;
  try {
    const driverCreds = credsFromJwt(firstBody.driver!.jwt!, driverIdentity);
    const driverNc = await connect({ servers, ...standaloneConnectOpts({ creds: driverCreds, tls: false }) });
    driverConnected = !driverNc.isClosed();
    await driverNc.close();
  } catch (e) {
    driverConnected = false;
  }
  c("issued driver credential authenticates to real broker", driverConnected);

  // 4. Issued mediator credential authenticates to broker
  let mediatorConnected = false;
  try {
    const mediatorCreds = credsFromJwt(firstBody.mediator!.jwt!, mediatorIdentity);
    const mediatorNc = await connect({ servers, ...standaloneConnectOpts({ creds: mediatorCreds, tls: false }) });
    mediatorConnected = !mediatorNc.isClosed();
    await mediatorNc.close();
  } catch (e) {
    mediatorConnected = false;
  }
  c("issued mediator credential authenticates to real broker", mediatorConnected);

  // 5. Distinguish initial issue from resume/renewal of an activated run: next recorded epoch/fence succeeds
  await createRunSpec(records, "manager", first, {
    pins: { seed: "s", startedAt: Date.now(), yieldEvery: 1, stepBudget: 1, effectCeiling: 1, languageVersion: "1" },
    createdAt: Date.now(),
  });
  await writeRunStatus(records, "manager", first, {
    observedSpecRevision: 1, state: "running", holder: `${identities.supervisor.id}.${"t".repeat(16)}`,
    epoch: 1, fencingToken: 1, journalHigh: 1, at: Date.now(),
  });
  const resumeRes = await postHttp({
    ...baseReq,
    requestId: `req-${mintLifecycleUid()}`,
    registrationProof: proof,
    attempt: {
      runId: first, takeoverId: "t".repeat(16), epoch: 2, fencingToken: 2,
      driverId: newIdentity().id, mediatorId: newIdentity().id,
    },
  });
  c("resume attempt with next recorded epoch/fencing token succeeds (HTTP 200)",
    resumeRes.status === 200 && (resumeRes.body as { v?: number }).v === 1, resumeRes);

  // 6. Stale or jumped attempt coordinates on activated run refuse (403/409 conflict)
  const staleRes = await postHttp({
    ...baseReq,
    requestId: `req-${mintLifecycleUid()}`,
    registrationProof: proof,
    attempt: {
      runId: first, takeoverId: "t".repeat(16), epoch: 1, fencingToken: 1,
      driverId: newIdentity().id, mediatorId: newIdentity().id,
    },
  });
  const jumpedRes = await postHttp({
    ...baseReq,
    requestId: `req-${mintLifecycleUid()}`,
    registrationProof: proof,
    attempt: {
      runId: first, takeoverId: "t".repeat(16), epoch: 9, fencingToken: 9,
      driverId: newIdentity().id, mediatorId: newIdentity().id,
    },
  });
  c("stale or jumped attempt coordinates refuse with conflict message",
    staleRes.status === 403 && String(staleRes.body.error).includes("next recorded epoch") &&
    jumpedRes.status === 403 && String(jumpedRes.body.error).includes("next recorded epoch"),
    { staleRes, jumpedRes });

  // 7. Terminal run gets no new attempt
  const termRun = newRun();
  await admit(termRun);
  await createRunSpec(records, "manager", termRun, {
    pins: { seed: "s", startedAt: Date.now(), yieldEvery: 1, stepBudget: 1, effectCeiling: 1, languageVersion: "1" },
    createdAt: Date.now(),
  });
  await writeRunStatus(records, "manager", termRun, {
    observedSpecRevision: 1, state: "completed", holder: `${identities.supervisor.id}.${"t".repeat(16)}`,
    epoch: 1, fencingToken: 1, journalHigh: 1, at: Date.now(),
  });
  const termRes = await postHttp({
    ...baseReq,
    requestId: `req-${mintLifecycleUid()}`,
    registrationProof: proof,
    attempt: {
      runId: termRun, takeoverId: "t".repeat(16), epoch: 2, fencingToken: 2,
      driverId: newIdentity().id, mediatorId: newIdentity().id,
    },
  });
  c("attempt for a completed terminal run refuses",
    termRes.status === 403 && String(termRes.body.error).includes("terminal run gets no new attempt"), termRes);

  // 8. Read operator issuance returns closed response with JWT and NO seeds, authenticating to broker
  const opIdentity = newIdentity();
  const opRes = await postHttp({
    ...baseReq,
    requestId: `req-${mintLifecycleUid()}`,
    registrationProof: proof,
    operator: { id: opIdentity.id, takeoverId: "o".repeat(16), runId: first },
  });
  const opBody = opRes.body as { v?: number; kind?: string; operator?: { jwt?: string; exp?: number } };
  let opConnected = false;
  if (opRes.status === 200 && typeof opBody.operator?.jwt === "string") {
    try {
      const opCreds = credsFromJwt(opBody.operator.jwt, opIdentity);
      const opNc = await connect({ servers, ...standaloneConnectOpts({ creds: opCreds, tls: false }) });
      opConnected = !opNc.isClosed();
      await opNc.close();
    } catch {
      opConnected = false;
    }
  }
  c("read operator returns closed response with JWT and authenticates to broker",
    opRes.status === 200 && opBody.v === 1 && typeof opBody.operator?.jwt === "string" &&
    !JSON.stringify(opBody).includes("seed") && opConnected, opRes);

  // 9. Answer operator for waiting checkpoint returns closed response with JWT, authenticating to broker
  const cpToken = `cp-${mintGeneration()}`;
  await mintCheckpoint(records, jetstream(nc), SPACE, {
    ref: { endpoint: "manager", token: cpToken },
    instanceId,
    epoch: 3,
    holder: { id: identities.supervisor.id, lifecycleUid },
    deadline: Date.now() + 60_000,
    now: Date.now(),
  });
  const ansIdentity = newIdentity();
  const ansRes = await postHttp({
    ...baseReq,
    requestId: `req-${mintLifecycleUid()}`,
    registrationProof: proof,
    operator: { id: ansIdentity.id, takeoverId: "a".repeat(16), answers: { token: cpToken } },
  });
  const ansBody = ansRes.body as { v?: number; operator?: { jwt?: string; exp?: number } };
  let ansConnected = false;
  if (ansRes.status === 200 && typeof ansBody.operator?.jwt === "string") {
    try {
      const ansCreds = credsFromJwt(ansBody.operator.jwt, ansIdentity);
      const ansNc = await connect({ servers, ...standaloneConnectOpts({ creds: ansCreds, tls: false }) });
      ansConnected = !ansNc.isClosed();
      await ansNc.close();
    } catch {
      ansConnected = false;
    }
  }
  c("answer operator for waiting checkpoint returns JWT and authenticates to broker",
    ansRes.status === 200 && ansBody.v === 1 && typeof ansBody.operator?.jwt === "string" &&
    !JSON.stringify(ansBody).includes("seed") && ansConnected, ansRes);

  // 10. Answer operator for non-waiting checkpoint refuses
  const absentAnsRes = await postHttp({
    ...baseReq,
    requestId: `req-${mintLifecycleUid()}`,
    registrationProof: proof,
    operator: { id: newIdentity().id, takeoverId: "a".repeat(16), answers: { token: "cp_nonexistent" } },
  });
  c("answering operator for a non-waiting checkpoint refuses",
    absentAnsRes.status === 403 && String(absentAnsRes.body.error).includes("checkpoint that is still waiting"), absentAnsRes);

  // 11. Missing supervise scope refuses (403)
  const nosupProof = remoteManagerCurrentRegistrationProof(auth.account.signingSeed, httpOwner, { ...baseReq, actor: "nosupervise" }, gate);
  const nosupRes = await postHttp({
    ...baseReq,
    actor: "nosupervise",
    requestId: `req-${mintLifecycleUid()}`,
    registrationProof: nosupProof,
    attempt: { runId: first, takeoverId: "t".repeat(16), epoch: 2, fencingToken: 2, driverId: newIdentity().id, mediatorId: newIdentity().id },
  });
  c("missing supervise scope refuses (403)",
    nosupRes.status === 403 && String(nosupRes.body.error).includes('manager run attempt needs scope "supervise"'), nosupRes);

  // 12. Stale process epoch refuses (409)
  const staleEpochRes = await postHttp({
    ...baseReq,
    processEpoch: 2,
    requestId: `req-${mintLifecycleUid()}`,
    registrationProof: proof,
    attempt: { runId: first, takeoverId: "t".repeat(16), epoch: 2, fencingToken: 2, driverId: newIdentity().id, mediatorId: newIdentity().id },
  });
  c("stale process epoch refuses",
    staleEpochRes.status === 403 && String(staleEpochRes.body.error).includes("stale"), staleEpochRes);

  // 13. Stale or bad registration proof refuses (403)
  const badProofRes = await postHttp({
    ...baseReq,
    requestId: `req-${mintLifecycleUid()}`,
    registrationProof: `sha256:${"0".repeat(64)}`,
    attempt: { runId: first, takeoverId: "t".repeat(16), epoch: 2, fencingToken: 2, driverId: newIdentity().id, mediatorId: newIdentity().id },
  });
  c("bad registration proof refuses",
    badProofRes.status === 403 && String(badProofRes.body.error).includes("proof does not match"), badProofRes);

  // 14. Foreign accountPublicKey refuses (403)
  const foreignAcctRes = await postHttp({
    ...baseReq,
    accountPublicKey: "AFOREIGN",
    requestId: `req-${mintLifecycleUid()}`,
    registrationProof: proof,
    attempt: { runId: first, takeoverId: "t".repeat(16), epoch: 2, fencingToken: 2, driverId: newIdentity().id, mediatorId: newIdentity().id },
  });
  c("foreign accountPublicKey refuses",
    foreignAcctRes.status === 403 && String(foreignAcctRes.body.error).includes("space and account"), foreignAcctRes);

  // 15. Foreign manager instanceId refuses (403)
  const foreignInstId = mintLifecycleUid();
  const foreignActors = remoteManagerActors(foreignInstId);
  const foreignGate = { state: "open" as const, principal: `${httpOwner}.${foreignActors.serve}`, processEpoch: 3, registrationRevision: 7 };
  await epKv.put(epgateKey("manager", foreignInstId), new TextEncoder().encode(JSON.stringify({
    ...foreignGate, generation: 1, nameAuthorityRevision: 0,
  })));
  const foreignProof = remoteManagerCurrentRegistrationProof(auth.account.signingSeed, httpOwner, { ...baseReq, instanceId: foreignInstId }, foreignGate);
  const foreignInstRes = await postHttp({
    ...baseReq,
    instanceId: foreignInstId,
    requestId: `req-${mintLifecycleUid()}`,
    registrationProof: foreignProof,
    attempt: { runId: first, takeoverId: "t".repeat(16), epoch: 2, fencingToken: 2, driverId: newIdentity().id, mediatorId: newIdentity().id },
  });
  c("foreign manager instanceId refuses",
    foreignInstRes.status === 403 && String(foreignInstRes.body.error).includes("another manager instance"), foreignInstRes);

  // 16. Closed or missing manager gate refuses (412)
  const nogateInst = mintLifecycleUid();
  const nogateRes = await postHttp({
    ...baseReq,
    instanceId: nogateInst,
    requestId: `req-${mintLifecycleUid()}`,
    registrationProof: proof,
    attempt: { runId: first, takeoverId: "t".repeat(16), epoch: 2, fencingToken: 2, driverId: newIdentity().id, mediatorId: newIdentity().id },
  });
  c("missing manager gate refuses",
    nogateRes.status === 403 && String(nogateRes.body.error).includes("no open registration gate"), nogateRes);

  // 17. Unrecorded run (no admission) refuses (403)
  const unadmittedRun = newRun();
  const unadmitRes = await postHttp({
    ...baseReq,
    requestId: `req-${mintLifecycleUid()}`,
    registrationProof: proof,
    attempt: { runId: unadmittedRun, takeoverId: "t".repeat(16), epoch: 1, fencingToken: 1, driverId: newIdentity().id, mediatorId: newIdentity().id },
  });
  c("unrecorded run without admission record refuses",
    unadmitRes.status === 403 && String(unadmitRes.body.error).includes("no admission record"), unadmitRes);

  // 18. Revoked admission refuses attempt and read operator (403)
  const revRun = newRun();
  await admit(revRun);
  await revokeRunAdmission(admissions, "manager", { version: 1, runId: revRun, by: "suite", reason: "revoked", revokedAt: Date.now() });
  const revAttemptRes = await postHttp({
    ...baseReq,
    requestId: `req-${mintLifecycleUid()}`,
    registrationProof: proof,
    attempt: { runId: revRun, takeoverId: "t".repeat(16), epoch: 1, fencingToken: 1, driverId: newIdentity().id, mediatorId: newIdentity().id },
  });
  const revOpRes = await postHttp({
    ...baseReq,
    requestId: `req-${mintLifecycleUid()}`,
    registrationProof: proof,
    operator: { id: newIdentity().id, takeoverId: "o".repeat(16), runId: revRun },
  });
  c("revoked run refuses attempt and read operator",
    revAttemptRes.status === 403 && String(revAttemptRes.body.error).includes("revoked") &&
    revOpRes.status === 403 && String(revOpRes.body.error).includes("revoked"), { revAttemptRes, revOpRes });

  // 19. Run admitted on another manager instance refuses (403)
  const foreignInstRun = newRun();
  await admit(foreignInstRun, mintLifecycleUid());
  const foreignInstAttemptRes = await postHttp({
    ...baseReq,
    requestId: `req-${mintLifecycleUid()}`,
    registrationProof: proof,
    attempt: { runId: foreignInstRun, takeoverId: "t".repeat(16), epoch: 1, fencingToken: 1, driverId: newIdentity().id, mediatorId: newIdentity().id },
  });
  c("run admitted on another manager instance refuses",
    foreignInstAttemptRes.status === 403 && String(foreignInstAttemptRes.body.error).includes("another manager instance"), foreignInstAttemptRes);

  // 20. Request with both attempt and operator, or neither, refuses (400/403)
  const bothRes = await postHttp({
    ...baseReq,
    requestId: `req-${mintLifecycleUid()}`,
    registrationProof: proof,
    attempt: { runId: first, takeoverId: "t".repeat(16), epoch: 2, fencingToken: 2, driverId: newIdentity().id, mediatorId: newIdentity().id },
    operator: { id: newIdentity().id, takeoverId: "o".repeat(16), runId: first },
  });
  const neitherRes = await postHttp({
    ...baseReq,
    requestId: `req-${mintLifecycleUid()}`,
    registrationProof: proof,
  });
  c("request with both attempt and operator, or neither, refuses",
    bothRes.status === 403 && String(bothRes.body.error).includes("exactly one") &&
    neitherRes.status === 403 && String(neitherRes.body.error).includes("exactly one"), { bothRes, neitherRes });

  await new Promise((r) => httpServer.close(r));
  await plane.close();
  rmSync(authDir, { recursive: true, force: true });
  await nc.close();
} finally {
  await killAndAwaitExit(broker);
  rmSync(sd, { recursive: true, force: true });
  release();
}

console.log(fail === 0 ? "remote-run-attempt-route: all cells pass" : `remote-run-attempt-route: ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
