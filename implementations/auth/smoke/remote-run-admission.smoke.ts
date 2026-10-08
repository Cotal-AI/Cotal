/** Signerless first-run admission on a real broker: a registered manager forwards the served v1
 *  run-start subject; the host resolves the REAL issued store and writes the admission itself. */
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  admissionBucket, createEndpointStreams, createSpaceAuth, epAuthBucket, epgateKey, epRequestSubject, ensureAdmissionStore, ensureAuthorityStores, ensureIssuedStores, issuanceGateKey, issuedBucket, mintGeneration,
  mintLifecycleUid, newIdentity, openIssuedStore, readRunAdmission, remoteManagerActors, type IssuedSourceRef,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { deriveOwnerForIdpSubject, grantActor, openAuthAuthorityPlane, handleManagerServiceAuthority, type ManagerServiceAuthorityCtx } from "../src/index.js";
import { admitRemoteRun } from "../src/manager-authority.js";
import { remoteManagerCurrentRegistrationProof } from "../src/retained-manager-validation.js";
import { pickFreePort } from "./_free-port.js";

let fail = 0;
const c = (name: string, ok: boolean, detail?: unknown) => { if (ok) console.log(`  ✓ ${name}`); else { fail++; console.log(`  ✗ FAIL: ${name}`, detail ?? ""); } };
const outcome = (p: Promise<unknown>) => p.then(() => "admitted", (e: Error) => `refused: ${e.message}`);

const SPACE = "admit";
const OWNER = "local";
const ACCOUNT = `A${"A".repeat(55)}`;
const SECRET = "suite-proof-secret";
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const release = teardownOnSignal(broker, sd);
try {
  const servers = `nats://127.0.0.1:${PORT}`;
  await awaitBrokerReady(() => connect({ servers }).then((n) => n.close().then(() => true), () => false), { servers, attempts: 50, delayMs: 100 });
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const jsm = await jetstreamManager(nc);
  const kvm = new Kvm(nc);
  await ensureIssuedStores(jsm, kvm, SPACE);
  await ensureAdmissionStore(jsm, kvm, SPACE);
  const issued = openIssuedStore(await kvm.open(issuedBucket(SPACE)), jsm, SPACE);
  const admissions = await kvm.open(admissionBucket(SPACE));

  const instanceId = mintLifecycleUid();
  const lifecycleUid = mintLifecycleUid();
  const identities = { supervisor: { id: newIdentity().id }, executor: { id: newIdentity().id }, serve: { id: newIdentity().id }, goalWriter: { id: newIdentity().id }, sessionLedger: { id: newIdentity().id } };
  const gate = { state: "open" as const, principal: `${OWNER}.${remoteManagerActors(instanceId).serve}`, processEpoch: 3, registrationRevision: 7 };
  const base = { v: 1, kind: "manager-run-admission", space: SPACE, actor: "cli", instanceId, managerLifecycleUid: lifecycleUid, accountPublicKey: ACCOUNT, processEpoch: 3, identities } as const;
  const proof = remoteManagerCurrentRegistrationProof(SECRET, OWNER, base, gate);

  const liveKeys = new Set<string>(["gate-a"]);
  const source: IssuedSourceRef = { space: SPACE, bucket: "cotal_lifecycle_admit", key: "gate-a" };
  async function issue(actor: string, publish: "run-start" | "none", sources: IssuedSourceRef[] = [source], uid = mintLifecycleUid()) {
    const ref = { space: SPACE, owner: OWNER, actor, uid, generation: mintGeneration() };
    const allow = publish === "none" ? { mode: "none" } as const : { mode: "patterns", patterns: [`cotal.${SPACE}.ep.v1.inst.manager.*.run-start.${OWNER}.${actor}.>`] } as const;
    const prepared = await issued.stage({ version: 1, ref, sources, permissions: { publish: { allow, deny: [] }, subscribe: { allow: { mode: "none" }, deny: [] } }, ...(sources.length ? {} : { expiresAt: Math.floor(Date.now() / 1000) + 600 }) });
    await issued.release(prepared, async () => {});
    return ref;
  }
  const subjectFor = (caller: { owner: string; actor: string; uid: string; generation?: string }, over: { space?: string; command?: string; instance?: string } = {}) =>
    epRequestSubject(over.space ?? SPACE, { route: { mode: "inst", instanceId: over.instance ?? instanceId }, endpoint: "manager", command: over.command ?? "run-start", caller: caller as never, nonce: "n".repeat(24) });
  const runId = () => `run-${Buffer.from(mintGeneration().slice(0, 16)).toString("hex").slice(0, 32)}`;
  // These cells call the host function directly, as if every forwarded subject was published;
  // the HTTP section below publishes each one the host observes.
  const takeObserved = async () => ({ operation: { command: "run-start" as const }, envelope: { class: "ephemeral" as const, op: { endpoint: "manager", command: "run-start" } } });
  const admit = (run: { runId: string; subject: string }, over: Record<string, unknown> = {}, gateOver: Partial<typeof gate> | null = {}) => admitRemoteRun({
    request: { ...base, requestId: `req-${run.runId}`, registrationProof: proof, run, ...over },
    owner: OWNER, space: SPACE, accountPublicKey: ACCOUNT, proofSecret: SECRET, endpoint: "manager",
    observeManagerGate: async () => gateOver === null ? null : { ...gate, ...gateOver },
    issued, sourceIsLive: async (s) => liveKeys.has(s.key), takeObserved, admissions,
  });
  const absent = async (id: string) => (await admissions.get(`admission.v1.manager.${id}`)) === null;

  // Positive: a real issued generation admits and the written record carries ITS evidence ceiling.
  const alice = await issue("alice", "run-start");
  const okRun = runId();
  const okSubject = subjectFor(alice);
  const result = await admitRemoteRun({
    request: { ...base, requestId: `req-${okRun}`, registrationProof: proof, run: { runId: okRun, subject: okSubject } },
    owner: OWNER, space: SPACE, accountPublicKey: ACCOUNT, proofSecret: SECRET, endpoint: "manager",
    observeManagerGate: async () => gate, issued, sourceIsLive: async (s) => liveKeys.has(s.key), takeObserved, admissions,
  }).catch((e: Error) => e);
  const view = await readRunAdmission(jsm, SPACE, "manager", okRun).catch((e: Error) => e);
  c("a registered manager's forwarded v1 run-start admits under the caller's real issued generation",
    !(result instanceof Error) && !(view instanceof Error) && view.admission.provenance.kind === "issued" &&
    view.admission.provenance.ref.generation === alice.generation && view.admission.caller.actor === "alice" &&
    view.admission.ceiling.publish.allow.mode === "patterns" && view.admission.instanceId === instanceId, { result, view });
  const retry = await admit({ runId: okRun, subject: okSubject }).catch((e: Error) => e);
  c("an exact retry returns the written admission unchanged",
    !(retry instanceof Error) && !(result instanceof Error) && retry.revision === result.revision && retry.admission.admittedAt === result.admission.admittedAt, retry);
  const bob = await issue("bob", "run-start");
  const hijack = await outcome(admit({ runId: okRun, subject: subjectFor(bob) }));
  const still = await readRunAdmission(jsm, SPACE, "manager", okRun);
  c("a retry naming another caller cannot alter an already written admission",
    hijack.includes("already admitted for another caller") && still.admission.caller.actor === "alice", hijack);

  const aliceAgain = await issue("alice", "run-start", [source], alice.uid);
  const regen = await outcome(admit({ runId: okRun, subject: subjectFor(aliceAgain) }));
  c("a retry under another generation of the same actor cannot alter the written admission",
    regen.includes("already admitted for another caller") && (await readRunAdmission(jsm, SPACE, "manager", okRun)).admission.provenance.kind === "issued", regen);
  // Forged generation: never issued.
  const forged = runId();
  const f = await outcome(admit({ runId: forged, subject: subjectFor({ ...alice, generation: mintGeneration() }) }));
  c("a forged (never issued) generation refuses and writes nothing", f.startsWith("refused") && await absent(forged), f);
  // Legacy subject: no generation.
  const legacy = runId();
  const l = await outcome(admit({ runId: legacy, subject: subjectFor({ owner: OWNER, actor: "alice", uid: alice.uid }) }));
  c("a legacy-rail (unbound) caller refuses before any write", l.includes("issued caller") && await absent(legacy), l);
  // Revoked generation.
  const carol = await issue("carol", "run-start");
  await issued.retire(carol);
  const revoked = runId();
  const rv = await outcome(admit({ runId: revoked, subject: subjectFor(carol) }));
  c("a revoked generation refuses and writes nothing", rv.includes("revoked") && await absent(revoked), rv);
  // Stale source.
  const dave = await issue("dave", "run-start", [{ ...source, key: "gate-d" }]);
  const stale = runId();
  const st = await outcome(admit({ runId: stale, subject: subjectFor(dave) }));
  c("a generation whose source is no longer live refuses", st.includes("no longer live") && await absent(stale), st);
  // Ceiling does not permit run-start.
  const erin = await issue("erin", "none");
  const narrow = runId();
  const nr = await outcome(admit({ runId: narrow, subject: subjectFor(erin) }));
  c("an issued ceiling that does not permit this run-start subject refuses", nr.includes("does not permit") && await absent(narrow), nr);
  // Foreign space / instance / command subjects.
  const fs = runId();
  const foreignSpace = await outcome(admit({ runId: fs, subject: subjectFor(alice, { space: "other" }) }));
  c("a subject of another space refuses", foreignSpace.startsWith("refused") && await absent(fs), foreignSpace);
  const fi = runId();
  const foreignInst = await outcome(admit({ runId: fi, subject: subjectFor(alice, { instance: mintLifecycleUid() }) }));
  c("a subject addressed to another manager instance refuses", foreignInst.includes("instance") && await absent(fi), foreignInst);
  const fc = runId();
  const otherCmd = await outcome(admit({ runId: fc, subject: subjectFor(alice, { command: "run-resume" }) }));
  c("a subject of another command refuses", otherCmd.includes("run-start") && await absent(fc), otherCmd);
  // Registration mismatches refuse before any write.
  const reg = runId();
  const run = { runId: reg, subject: subjectFor(alice) };
  const acct = await outcome(admit(run, { accountPublicKey: `A${"B".repeat(55)}` }));
  const epoch = await outcome(admit(run, { processEpoch: 2 }));
  const noGate = await outcome(admit(run, {}, null));
  const foreignOwner = await outcome(admit(run, {}, { principal: `other.${remoteManagerActors(instanceId).serve}` }));
  const badProof = await outcome(admit(run, { registrationProof: `sha256:${"0".repeat(64)}` }));
  const ceilingField = await outcome(admit(run, { ceiling: { publish: { allow: { mode: "all" }, deny: [] } } }));
  c("account, stale epoch, missing gate, foreign owner, bad proof and a caller-supplied ceiling all refuse before any write",
    acct.includes("space and account") && epoch.includes("stale") && noGate.includes("no current open manager gate") &&
    foreignOwner.includes("another owner") && badProof.includes("proof does not match") && ceilingField.includes("unknown field ceiling") && await absent(reg),
    { acct, epoch, noGate, foreignOwner, badProof, ceilingField });

  // ---------- Section 2: Real HTTP / service route integration ----------
  const auth = await createSpaceAuth(SPACE);
  await ensureAuthorityStores(jsm, kvm, SPACE);
  await createEndpointStreams(jsm, kvm, SPACE);

  const authDir = mkdtempSync(join(tmpdir(), "cotal-admit-http-auth-"));
  const idpPair = generateKeyPairSync("ed25519");
  const IDP_ISS = "https://idp.example/admit";
  const ownerSecret = "suite-owner-secret-32-bytes-long!";
  const httpOwner = deriveOwnerForIdpSubject(ownerSecret, IDP_ISS, "human-admit");

  grantActor(authDir, { owner: httpOwner, actor: "cli", scope: ["supervise", "spawn"], allowSubscribe: [">"], allowPublish: [">"] });
  grantActor(authDir, { owner: httpOwner, actor: "nosupervise", scope: ["spawn", "admin"], allowSubscribe: [">"], allowPublish: [">"] });

  const epKv = await kvm.open(epAuthBucket(SPACE));
  const httpInstanceId = mintLifecycleUid();
  const httpLifecycleUid = mintLifecycleUid();
  const httpActors = remoteManagerActors(httpInstanceId);
  const httpGate = { state: "open" as const, principal: `${httpOwner}.${httpActors.serve}`, processEpoch: 3, registrationRevision: 7 };
  await epKv.put(epgateKey("manager", httpInstanceId), new TextEncoder().encode(JSON.stringify({
    ...httpGate, generation: 1, nameAuthorityRevision: 0,
  })));

  const liveUid = mintLifecycleUid();
  const retiredUid = mintLifecycleUid();
  await epKv.put(issuanceGateKey(liveUid), new TextEncoder().encode(JSON.stringify({ lifecycleUid: liveUid, state: "open", generation: 1 })));
  await epKv.put(issuanceGateKey(retiredUid), new TextEncoder().encode(JSON.stringify({ lifecycleUid: retiredUid, state: "retired", generation: 1, op: { opId: mintLifecycleUid(), kind: "retirement" } })));

  const httpSource: IssuedSourceRef = { space: SPACE, bucket: epAuthBucket(SPACE), key: `cred.${liveUid}` };
  const httpStaleSource: IssuedSourceRef = { space: SPACE, bucket: epAuthBucket(SPACE), key: `cred.${retiredUid}` };

  async function issueHttp(actor: string, publish: "run-start" | "none", sources: IssuedSourceRef[] = [httpSource], uid = mintLifecycleUid()) {
    const ref = { space: SPACE, owner: httpOwner, actor, uid, generation: mintGeneration() };
    const allow = publish === "none" ? { mode: "none" } as const : { mode: "patterns", patterns: [`cotal.${SPACE}.ep.v1.inst.manager.*.run-start.${httpOwner}.${actor}.>`] } as const;
    const prepared = await issued.stage({ version: 1, ref, sources, permissions: { publish: { allow, deny: [] }, subscribe: { allow: { mode: "none" }, deny: [] } }, ...(sources.length ? {} : { expiresAt: Math.floor(Date.now() / 1000) + 600 }) });
    await issued.release(prepared, async () => {});
    return ref;
  }

  const httpAlice = await issueHttp("alice", "run-start");
  const httpDave = await issueHttp("dave", "run-start", [httpStaleSource]);
  const httpCarol = await issueHttp("carol", "run-start");
  await issued.retire(httpCarol);

  const plane = await openAuthAuthorityPlane({
    server: servers,
    space: SPACE,
    dir: authDir,
    identityRoot: authDir,
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    log: () => {},
  });

  const cap = "operator-cap-secret";
  const httpCtx: ManagerServiceAuthorityCtx = {
    space: SPACE,
    dir: authDir,
    ownerSecret,
    bridgeIdp: { issuer: IDP_ISS, audience: IDP_ISS, key: (async () => idpPair.publicKey) as never },
    managerServiceAuthority: plane.issueManagerServiceAuthority,
    maintainRemoteManager: plane.maintainRemoteManager,
    validateRetainedAgent: plane.validateRetainedAgent,
    // This suite runs no callout, so it has no sentinel credentials to enroll with; it sends run kinds only.
    enrollManagedAgent: () => { throw new Error("this suite sends no managed-agent enrollment"); },
    prepareManagedAgentRetirement: plane.prepareManagedAgentRetirement,
    scanManagerGoalIndex: plane.scanManagerGoalIndex,
    authorizeManagerAdmin: plane.authorizeManagerAdmin,
    admitManagerRun: plane.admitManagerRun,
    issueManagerRunAttempt: plane.issueManagerRunAttempt,
    secrets: new Map() as never,
    cap,
  };
  const httpServer = createServer((req, res) => void handleManagerServiceAuthority(req, res, httpCtx, {
    requireCapability: true,
    refuseViews: false,
    peerKey: () => "127.0.0.1",
    throttled: () => false,
    recordFailure: () => {},
  }));
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", () => r()));
  const httpUrl = `http://127.0.0.1:${(httpServer.address() as import("node:net").AddressInfo).port}/manager-service-authority`;

  const idpToken = await new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
    .setSubject("human-admit")
    .setIssuer(IDP_ISS)
    .setAudience(IDP_ISS)
    .setIssuedAt(Math.floor(Date.now() / 1000))
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(idpPair.privateKey);

  const httpIdentities = { supervisor: { id: newIdentity().id }, executor: { id: newIdentity().id }, serve: { id: newIdentity().id }, goalWriter: { id: newIdentity().id }, sessionLedger: { id: newIdentity().id } };
  const httpBaseReq = {
    v: 1, kind: "manager-run-admission", space: SPACE, actor: "cli", instanceId: httpInstanceId,
    managerLifecycleUid: httpLifecycleUid, accountPublicKey: auth.account.pub, processEpoch: 3, identities: httpIdentities,
  } as const;
  const httpProof = remoteManagerCurrentRegistrationProof(auth.account.signingSeed, httpOwner, httpBaseReq, httpGate);

  const postHttp = async (reqBody: unknown) => {
    const res = await fetch(httpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cap}` },
      body: JSON.stringify({ idpToken, request: reqBody }),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, body: data as Record<string, unknown> };
  };

  const httpSubjectFor = (caller: { owner: string; actor: string; uid: string; generation?: string }, over: { space?: string; command?: string; instance?: string } = {}) =>
    epRequestSubject(over.space ?? SPACE, { route: { mode: "inst", instanceId: over.instance ?? httpInstanceId }, endpoint: "manager", command: over.command ?? "run-start", caller: caller as never, nonce: "n".repeat(24) });
  // The caller's own run-start request, which the issuing host observes before the manager forwards it.
  const publishRunStart = async (caller: { owner: string; actor: string; uid: string; generation?: string }) => {
    const digest = `sha256:${"0".repeat(64)}`;
    nc.publish(httpSubjectFor(caller), JSON.stringify({
      v: 1, id: "n".repeat(24), op: { endpoint: "manager", command: "run-start", inputDigest: digest, outputDigest: digest },
      class: "ephemeral", replyExpected: true, deadlineMs: 5000, args: {}, from: { id: `${caller.owner}.${caller.actor}`, name: caller.actor },
    }));
    await nc.flush();
  };

  // Positive HTTP route check
  const httpOkRun = runId();
  await publishRunStart(httpAlice);
  const httpOkRes = await postHttp({ ...httpBaseReq, requestId: `req-${httpOkRun}`, registrationProof: httpProof, run: { runId: httpOkRun, subject: httpSubjectFor(httpAlice) } });
  const httpOkView = await readRunAdmission(jsm, SPACE, "manager", httpOkRun).catch((e: Error) => e);
  c("HTTP route: a registered manager's forwarded v1 run-start admits and writes the admission record",
    httpOkRes.status === 200 && (httpOkRes.body as { v?: number }).v === 1 && !(httpOkView instanceof Error) &&
    httpOkView.admission.caller.actor === "alice" && httpOkView.admission.instanceId === httpInstanceId, { httpOkRes, httpOkView });

  // Negative HTTP: missing supervise scope
  const nosupProof = remoteManagerCurrentRegistrationProof(auth.account.signingSeed, httpOwner, { ...httpBaseReq, actor: "nosupervise" }, httpGate);
  const nosupRes = await postHttp({ ...httpBaseReq, actor: "nosupervise", requestId: `req-${mintLifecycleUid()}`, registrationProof: nosupProof, run: { runId: runId(), subject: httpSubjectFor(httpAlice) } });
  c("HTTP route: missing supervise scope refuses (403)",
    nosupRes.status === 403 && String(nosupRes.body.error).includes('manager run admission needs scope "supervise"'), nosupRes);

  // Negative HTTP: forged generation
  const forgedHttpRun = runId();
  const forgedCaller = { ...httpAlice, generation: mintGeneration() };
  await publishRunStart(forgedCaller);
  const forgedHttpRes = await postHttp({ ...httpBaseReq, requestId: `req-${forgedHttpRun}`, registrationProof: httpProof, run: { runId: forgedHttpRun, subject: httpSubjectFor(forgedCaller) } });
  c("HTTP route: a forged generation refuses (403)",
    forgedHttpRes.status === 403 && String(forgedHttpRes.body.error).includes("no issued evidence") && await absent(forgedHttpRun), forgedHttpRes);

  // Negative HTTP: stale source
  const staleHttpRun = runId();
  await publishRunStart(httpDave);
  const staleHttpRes = await postHttp({ ...httpBaseReq, requestId: `req-${staleHttpRun}`, registrationProof: httpProof, run: { runId: staleHttpRun, subject: httpSubjectFor(httpDave) } });
  c("HTTP route: a generation whose source is no longer live refuses (403)",
    staleHttpRes.status === 403 && String(staleHttpRes.body.error).includes("no longer live") && await absent(staleHttpRun), staleHttpRes);

  // Negative HTTP: foreign space
  const fsHttpRun = runId();
  const fsHttpRes = await postHttp({ ...httpBaseReq, requestId: `req-${fsHttpRun}`, registrationProof: httpProof, run: { runId: fsHttpRun, subject: httpSubjectFor(httpAlice, { space: "other" }) } });
  c("HTTP route: a subject of another space refuses (403)",
    fsHttpRes.status === 403 && String(fsHttpRes.body.error).includes("served v1 run-start subject") && await absent(fsHttpRun), fsHttpRes);

  // Negative HTTP: foreign manager instance
  const fiHttpRun = runId();
  const fiHttpRes = await postHttp({ ...httpBaseReq, requestId: `req-${fiHttpRun}`, registrationProof: httpProof, run: { runId: fiHttpRun, subject: httpSubjectFor(httpAlice, { instance: mintLifecycleUid() }) } });
  c("HTTP route: a subject addressed to another manager instance refuses (403)",
    fiHttpRes.status === 403 && String(fiHttpRes.body.error).includes("instance") && await absent(fiHttpRun), fiHttpRes);

  // Negative HTTP: revoked generation
  const rvHttpRun = runId();
  await publishRunStart(httpCarol);
  const rvHttpRes = await postHttp({ ...httpBaseReq, requestId: `req-${rvHttpRun}`, registrationProof: httpProof, run: { runId: rvHttpRun, subject: httpSubjectFor(httpCarol) } });
  c("HTTP route: a revoked generation refuses (403)",
    rvHttpRes.status === 403 && String(rvHttpRes.body.error).includes("revoked") && await absent(rvHttpRun), rvHttpRes);

  // Negative HTTP: caller-supplied ceiling field
  const clHttpRun = runId();
  const clHttpRes = await postHttp({ ...httpBaseReq, requestId: `req-${clHttpRun}`, registrationProof: httpProof, ceiling: { publish: { allow: { mode: "all" }, deny: [] } }, run: { runId: clHttpRun, subject: httpSubjectFor(httpAlice) } });
  c("HTTP route: a caller-supplied ceiling field refuses before any write",
    (clHttpRes.status === 400 || clHttpRes.status === 403) && String(clHttpRes.body.error).includes("unknown field ceiling") && await absent(clHttpRun), clHttpRes);

  await new Promise((r) => httpServer.close(r));
  await plane.close();
  rmSync(authDir, { recursive: true, force: true });

  await nc.close();
} finally {
  await killAndAwaitExit(broker);
  rmSync(sd, { recursive: true, force: true });
  release();
}
console.log(fail === 0 ? "remote-run-admission: all cells pass" : `remote-run-admission: ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
