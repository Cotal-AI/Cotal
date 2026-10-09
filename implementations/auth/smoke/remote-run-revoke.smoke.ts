/** Issuing-host run revoke through the authenticated HTTP door and real JetStream.
 * Run: pnpm smoke:remote-run-revoke */
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT } from "jose";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  admissionBucket, chatSubject, createEndpointStreams, createSpaceStreams, createSpaceAuth,
  ensureAdmissionStore, ensureAuthorityStores, ensureIssuedStores, epAuthBucket, epgateKey,
  epRequestSubject, issuanceGateKey, issuedBucket, mintGeneration, mintLifecycleUid, newIdentity,
  newTakeoverId, openIssuedStore, openRecordsBucket, readRunAdmission, readRunRevocation,
  remoteManagerActors, revocationKey, serverConfig, mintCreds, standaloneConnectOpts, type RemoteRunRevokeResult, type RunRevocation,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { deriveOwnerForIdpSubject, grantActor, openAuthAuthorityPlane, handleManagerServiceAuthority, type ManagerServiceAuthorityCtx } from "../src/index.js";
import { openAuthorityClient, type AuthorityClient } from "../src/authority-client.js";
import { remoteManagerCurrentRegistrationProof } from "../src/retained-manager-validation.js";
import { RunHosting } from "../../manager/src/run-hosting.js";
import { remoteRunHosting, type RemoteManagerIdentityState } from "../../manager/src/remote-authority.js";
import { startRun } from "../../runtime/src/run-driver.js";
import { createRunEffectHost } from "../../runtime/src/run-effect-host.js";
import { createRunScopeAuthority } from "../../runtime/src/run-scope-authority.js";
import { createRunWaitHost } from "../../runtime/src/run-wait-host.js";
import "../../runtime/src/index.js";
import { pickFreePort } from "./_free-port.js";

let passed = 0, failed = 0;
const cell = (name: string, ok: boolean) => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}`); }
};
const refused = (p: Promise<unknown>) => p.then(() => "allowed", (e: Error) => e.message);
const SPACE = "revokeroute", EP = "manager";
const sd = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}revoke-`));
const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const auth = await createSpaceAuth(SPACE);
writeFileSync(join(sd, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(sd, "js") }));
const probeCreds = await mintCreds(auth, newIdentity(), "probe");
const broker = spawn("nats-server", ["-c", join(sd, "server.conf")], { stdio: "ignore" });
const release = teardownOnSignal(broker, sd);
let nc: NatsConnection | undefined, httpServer: Server | undefined, fixture: AuthorityClient | undefined;
let plane: Awaited<ReturnType<typeof openAuthAuthorityPlane>> | undefined;
try {
  await awaitBrokerReady(() => connect({ servers, ...standaloneConnectOpts({ creds: probeCreds, tls: false }) }).then(n => n.close().then(() => true), () => false), { servers, attempts: 50, delayMs: 100 });
  // Fixture setup/readback only. The shipped auth plane and both RunHosting arms open their own
  // scoped credentials against this JWT-authenticated broker, never this fixture connection.
  fixture = await openAuthorityClient({ server: servers, space: SPACE, dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed }, label: "revoke-fixture", grants: id => ({ publish: [">"], subscribe: [">", `_INBOX_${id}.>`] }), log: () => {} });
  nc = fixture.nc;
  const js = jetstream(nc), jsm = await jetstreamManager(nc), kvm = new Kvm(nc);
  await ensureAuthorityStores(jsm, kvm, SPACE);
  await ensureAdmissionStore(jsm, kvm, SPACE);
  await ensureIssuedStores(jsm, kvm, SPACE);
  await createEndpointStreams(jsm, kvm, SPACE);
  await createSpaceStreams(jsm, SPACE);
  const records = await openRecordsBucket(nc, SPACE);
  const admissions = await kvm.open(admissionBucket(SPACE));
  const issued = openIssuedStore(await kvm.open(issuedBucket(SPACE)), jsm, SPACE);
  const authDir = join(sd, "auth");
  const idpPair = generateKeyPairSync("ed25519");
  const issuer = "https://idp.example/revoke", ownerSecret = "local-revoke-suite-owner-secret-32-bytes";
  const owner = deriveOwnerForIdpSubject(ownerSecret, issuer, "owner");
  const other = deriveOwnerForIdpSubject(ownerSecret, issuer, "other");
  const admin = deriveOwnerForIdpSubject(ownerSecret, issuer, "admin");
  for (const [principal, scope] of [[owner, ["supervise", "run"]], [other, ["supervise"]], [admin, ["admin"]]] as const)
    grantActor(authDir, { owner: principal, actor: "cli", scope: [...scope], allowSubscribe: [">"], allowPublish: [">"] });
  const state: RemoteManagerIdentityState = {
    v: 1, space: SPACE, instanceId: mintLifecycleUid(), lifecycleUid: mintLifecycleUid(),
    identities: { supervisor: newIdentity(), executor: newIdentity(), serve: newIdentity(), goalWriter: newIdentity(), sessionLedger: newIdentity() },
  };
  const identities = Object.fromEntries(Object.entries(state.identities).map(([k, i]) => [k, { id: i.id }])) as import("@cotal-ai/core").RemoteManagerAuthorityRequest["identities"];
  const gate = { state: "open" as const, principal: `${owner}.${remoteManagerActors(state.instanceId).serve}`, processEpoch: 3, registrationRevision: 7 };
  const epKv = await kvm.open(epAuthBucket(SPACE));
  await epKv.put(epgateKey(EP, state.instanceId), new TextEncoder().encode(JSON.stringify({ ...gate, generation: 1, nameAuthorityRevision: 0 })));
  const base = { v: 1 as const, space: SPACE, actor: "cli", instanceId: state.instanceId, managerLifecycleUid: state.lifecycleUid, identities, accountPublicKey: auth.account.pub, processEpoch: 3 };
  const proof = remoteManagerCurrentRegistrationProof(auth.account.signingSeed, owner, base, gate);
  const liveUid = mintLifecycleUid();
  await epKv.put(issuanceGateKey(liveUid), new TextEncoder().encode(JSON.stringify({ lifecycleUid: liveUid, state: "open", generation: 1 })));
  const caller = { space: SPACE, owner, actor: "cli", uid: mintLifecycleUid(), generation: mintGeneration() };
  const prepared = await issued.stage({ version: 1, ref: caller, sources: [{ space: SPACE, bucket: epAuthBucket(SPACE), key: `cred.${liveUid}` }], permissions: {
    publish: { allow: { mode: "patterns", patterns: [`cotal.${SPACE}.ep.v1.inst.manager.*.run-start.${owner}.cli.>`] }, deny: [] },
    subscribe: { allow: { mode: "patterns", patterns: [chatSubject(SPACE, "*", "*", "build")] }, deny: [] },
  } });
  await issued.release(prepared, async () => {});
  plane = await openAuthAuthorityPlane({ server: servers, space: SPACE, dir: authDir, identityRoot: authDir, dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed }, log: () => {} });
  const cap = "local-suite-cap";
  const httpCtx: ManagerServiceAuthorityCtx = {
    space: SPACE, dir: authDir, ownerSecret, cap, failures: [], badCaps: [], secrets: new Map() as never,
    bridgeIdp: { issuer, audience: issuer, key: (async () => idpPair.publicKey) as never },
    managerServiceAuthority: plane.issueManagerServiceAuthority, maintainRemoteManager: plane.maintainRemoteManager,
    validateRetainedAgent: plane.validateRetainedAgent,
    enrollManagedAgent: async () => { throw new Error("no enrollment in this suite"); },
    prepareManagedAgentRetirement: plane.prepareManagedAgentRetirement, scanManagerGoalIndex: plane.scanManagerGoalIndex,
    authorizeManagerAdmin: plane.authorizeManagerAdmin, admitManagerRun: plane.admitManagerRun,
    issueManagerRunAttempt: plane.issueManagerRunAttempt, revokeManagerRun: plane.revokeManagerRun,
  };
  httpServer = createServer((req, res) => void handleManagerServiceAuthority(req, res, httpCtx, {
    requireCapability: true, refuseViews: false, peerKey: () => "127.0.0.1", throttled: () => false, recordFailure: () => {},
  }));
  await new Promise<void>(resolve => httpServer!.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(httpServer.address() as import("node:net").AddressInfo).port}/manager-service-authority`;
  const tokens = new Map<string, string>();
  for (const subject of ["owner", "other", "admin"]) tokens.set(subject, await new SignJWT({}).setProtectedHeader({ alg: "EdDSA" }).setSubject(subject).setIssuer(issuer).setAudience(issuer).setIssuedAt().setExpirationTime("5m").sign(idpPair.privateKey));
  const post = async (request: unknown, who = "owner") => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cap}` }, body: JSON.stringify({ idpToken: tokens.get(who), request }) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const newRun = () => `run-${randomBytes(16).toString("hex")}`;
  const admit = async (runId: string) => {
    const nonce = randomBytes(18).toString("base64url");
    const subject = epRequestSubject(SPACE, { route: { mode: "inst", instanceId: state.instanceId }, endpoint: EP, command: "run-start", caller, nonce });
    const digest = `sha256:${"0".repeat(64)}`;
    nc!.publish(subject, JSON.stringify({ v: 1, id: nonce, op: { endpoint: EP, command: "run-start", inputDigest: digest, outputDigest: digest }, class: "ephemeral", replyExpected: true, deadlineMs: 5000, args: {}, from: { id: `${owner}.cli`, name: "cli" } }));
    await nc!.flush();
    const got = await post({ ...base, kind: "manager-run-admission", requestId: mintLifecycleUid(), registrationProof: proof, run: { runId, subject } });
    if (got.status !== 200) throw new Error(`admission setup refused: ${String(got.body.error)}`);
  };
  const revokeRequest = (runId: string, reason = "stop") => ({ ...base, kind: "manager-run-revoke", requestId: mintLifecycleUid(), registrationProof: proof, revoke: { runId, reason } });
  const first = newRun(); await admit(first);
  const firstReply = await post(revokeRequest(first));
  const firstMarker = await readRunRevocation(jsm, SPACE, EP, first);
  cell("U6-1 admitted owner revokes through issuing host and readRunRevocation reads marker", firstReply.status === 200 && firstMarker?.by === `${owner}.cli` && JSON.stringify(firstReply.body.revocation) === JSON.stringify(firstMarker));

  const foreign = newRun(); await admit(foreign);
  const denied = await post(revokeRequest(foreign), "other");
  cell("U6-2 another owner is refused by name without a marker", denied.status === 403 && String(denied.body.error).includes("admitted owner or a platform admin") && await readRunRevocation(jsm, SPACE, EP, foreign) === undefined);

  const adminReply = await post(revokeRequest(foreign, "platform stop"), "admin");
  const adminMarker = await readRunRevocation(jsm, SPACE, EP, foreign);
  cell("U6-3 platform admin revokes and records verified revoker", adminReply.status === 200 && adminMarker?.by === `${admin}.cli` && adminMarker.reason === "platform stop");

  const firstBytes = (await admissions.get(revocationKey(EP, first)))?.value;
  const repeated = await post(revokeRequest(first, "second reason"), "admin");
  const after = await readRunRevocation(jsm, SPACE, EP, first);
  cell("U6-4 second revoke preserves existing revokedAt by reason and bytes", repeated.status === 200 && firstMarker !== undefined && after?.revokedAt === firstMarker.revokedAt && after.by === firstMarker.by && after.reason === firstMarker.reason && JSON.stringify(repeated.body.revocation) === JSON.stringify(firstMarker) && Buffer.from((await admissions.get(revocationKey(EP, first)))!.value).equals(Buffer.from(firstBytes!)));

  const waiting = newRun(); await admit(waiting);
  const takeoverId = newTakeoverId();
  const lease = { holder: "wait-host", epoch: 1, fencingToken: 1, takeoverId };
  const planes = { nc, js, jsm, kv: records, space: SPACE };
  const authority = createRunScopeAuthority(planes, waiting, lease);
  const admission = () => readRunAdmission(jsm, SPACE, EP, waiting);
  const waitHost = createRunWaitHost(planes, authority, admission);
  const handler = { ...createRunEffectHost(planes, { space: SPACE, endpoint: EP, runId: waiting, caller: { owner, actor: "cli", uid: caller.uid }, instanceId: state.instanceId, epoch: 1, holder: { id: lease.holder, lifecycleUid: state.lifecycleUid }, defaultCheckpointTimeout: "1h" }, authority, admission) };
  let fetched = false, fetchRefusal = "";
  handler.wait = async (_request, ctx) => {
    await ctx.bind({ waitChannel: "build" });
    await waitHost.open(ctx.requestId, "build");
    await js.publish(chatSubject(SPACE, owner, "cli", "build"), new TextEncoder().encode("before revoke"));
    fetched = (await waitHost.fetch(ctx.requestId)).length === 1;
    await post(revokeRequest(waiting, "wait stopped"));
    fetchRefusal = await refused(waitHost.fetch(ctx.requestId));
    await waitHost.close(ctx.requestId);
    return null;
  };
  await startRun(js, jsm, { space: SPACE, endpoint: EP, runId: waiting, source: 'await wait(message(channel("build")), { name: "paused" });', kv: records, lease, handler });
  cell("U6-5 open wait refuses its next fetch with revocation named", fetched && fetchRefusal.includes("was revoked") && fetchRefusal.includes("wait stopped"));

  const context = { space: SPACE, servers, endpoint: EP, instanceId: state.instanceId, holder: { id: state.identities.supervisor.id, lifecycleUid: state.lifecycleUid }, log: () => {} };
  const local = new RunHosting({ ...context, auth });
  await local.reconcile();
  const resumeRefusal = await refused(local.resume({ runId: waiting }));
  cell("U6-6 manager resume of a revoked run is refused", resumeRefusal.includes("was revoked") && resumeRefusal.includes("not resumed"));
  await local.stop();

  const pairRun = newRun(); await admit(pairRun);
  const unused = async (): Promise<never> => { throw new Error("unused issuance callback"); };
  const callbacks = remoteRunHosting({ state, owner, registrationProof: proof, accountPublicKey: auth.account.pub, processEpoch: 3, requestRunAdmission: unused, requestRunAttempt: unused, call: unused,
    requestRunRevoke: async request => {
      const got = await post(request);
      if (got.status !== 200) throw new Error(String(got.body.error));
      return got.body as unknown as RemoteRunRevokeResult;
    },
  });
  const remote = new RunHosting({ ...context, auth: undefined, ...callbacks });
  const originalNow = Date.now, at = originalNow();
  let remoteMarker: RunRevocation | undefined, signerMarker: RunRevocation | undefined;
  try {
    Date.now = () => at;
    remoteMarker = await remote.revoke(pairRun, "body-is-not-an-identity", "same inputs");
    signerMarker = await new RunHosting({ ...context, endpoint: "signer", auth }).revoke(pairRun, `${owner}.cli`, "same inputs");
  } catch (e) { console.log(`remote/signer comparison refused: ${(e as Error).message}`); }
  finally { Date.now = originalNow; }
  const remoteBytes = (await admissions.get(revocationKey(EP, pairRun)))?.value;
  const signerBytes = (await admissions.get(revocationKey("signer", pairRun)))?.value;
  cell("U6-7 remote RunHosting produces identical marker bytes to signer path", remoteMarker !== undefined && signerMarker !== undefined && remoteBytes !== undefined && signerBytes !== undefined && Buffer.from(remoteBytes).equals(Buffer.from(signerBytes)) && remoteMarker.by === `${owner}.cli`);

  // Closed schema and current manager credentials are independently exercised through the same door.
  const malformedRun = newRun(); await admit(malformedRun);
  const forgedOwner = await post({ ...revokeRequest(malformedRun), owner });
  const forgedBy = await post({ ...revokeRequest(malformedRun), revoke: { runId: malformedRun, reason: "stop", by: `${owner}.cli` } });
  const ignoredRun = await post({ ...revokeRequest(malformedRun), run: { runId: malformedRun, subject: "" } });
  cell("closed revoke body refuses owner by and ignored run assertions", forgedOwner.status !== 200 && forgedBy.status !== 200 && ignoredRun.status !== 200 && await readRunRevocation(jsm, SPACE, EP, malformedRun) === undefined);
  const stale = await post({ ...revokeRequest(malformedRun), processEpoch: 2 });
  const badProof = await post({ ...revokeRequest(malformedRun), registrationProof: `sha256:${"0".repeat(64)}` });
  cell("stale epoch and invalid registration proof write no marker", stale.status !== 200 && badProof.status === 403 && String(badProof.body.error).includes("proof does not match the current registration") && await readRunRevocation(jsm, SPACE, EP, malformedRun) === undefined);
  const missing = await post(revokeRequest(newRun()));
  cell("unrecorded run cannot be revoked", missing.status === 403 && String(missing.body.error).includes("no admission record"));
  grantActor(authDir, { owner: admin, actor: "cli", scope: ["supervise"], allowSubscribe: [">"], allowPublish: [">"] });
  const narrowed = await post(revokeRequest(malformedRun), "admin");
  cell("freshly removed admin grant refuses another owner's revoke", narrowed.status === 403 && String(narrowed.body.error).includes("admitted owner or a platform admin") && await readRunRevocation(jsm, SPACE, EP, malformedRun) === undefined);
  grantActor(authDir, { owner, actor: "cli", scope: ["run"], allowSubscribe: [">"], allowPublish: [">"] });
  const ownerNoSupervise = await post(revokeRequest(malformedRun));
  cell("admitted owner needs no supervise grant to revoke", ownerNoSupervise.status === 200);
} finally {
  if (httpServer !== undefined) await new Promise<void>((resolve, reject) => httpServer!.close(e => e ? reject(e) : resolve()));
  await plane?.close();
  await fixture?.close();
  await killAndAwaitExit(broker);
  release();
  rmSync(sd, { recursive: true, force: true });
}
console.log(`remote-run-revoke: ${passed + failed} cells, ${passed} passed, ${failed} failed`);
if (failed === 0) console.log("remote-run-revoke: all cells pass");
process.exitCode = failed === 0 ? 0 : 1;
