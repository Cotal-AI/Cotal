import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins/jwt";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { bearer } from "better-auth/plugins/bearer";
import { SignJWT, decodeJwt } from "jose";
import { toNodeHandler } from "better-auth/node";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { fromSeed } from "@nats-io/nkeys";
import { Kvm } from "@nats-io/kv";
import * as core from "@cotal-ai/core";
import * as authApi from "@cotal-ai/auth";
import { SMOKE_BROKER_TOKEN, teardownOnSignal, teardownPathOnSignal, awaitBrokerReady, killAndAwaitExit } from "@cotal-ai/smoke-kit";
import { MemoryStore } from "./_hosted-auth-fixture.js";
import { pickFreePort } from "./_free-port.js";
import { serializedFor } from "../src/serialized.js";
import { openAuthorityClient, type AuthorityClient } from "../src/authority-client.js";

const reportPath = process.env.ENDPOINT_U12_REPORT;
if (!reportPath) throw new Error("owned report required");
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN + "-endpoint-public-"));
const releasePath = teardownPathOnSignal(dir);
const checks: string[] = [], cleanupErrors: string[] = [], connections: NatsConnection[] = [];
const cell = (name: string, value: unknown) => { assert.ok(value, name); checks.push(name); console.log(JSON.stringify({ cell: name, passed: true, scope: "public-http-native-callout-diagnostic" })); };
let broker: ReturnType<typeof spawn> | undefined, releaseBroker: (() => void) | undefined;
let handle: authApi.AuthServiceHandle | undefined, failure: unknown;
let policyWriter: AuthorityClient | undefined;
let servingHandle: core.EpServeHandle | undefined, effects = 0;
let restoreClockProbe: (() => void) | undefined;
let handler: ReturnType<typeof toNodeHandler> | undefined;
const idpHttp = createServer((req, res) => handler!(req, res));
const timer = setTimeout(() => process.kill(process.pid, "SIGTERM"), 150000);
try {
  // A real device login is the client identity. Deployment secrets are fixture-host custody only.
  await new Promise<void>(resolve => idpHttp.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(idpHttp.address() as { port: number }).port}`, idpUrl = `${origin}/api/auth`;
  const idp = betterAuth({ baseURL: origin, secret: "endpoint-public-test-secret-0123456789", database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [], deviceCode: [] }), emailAndPassword: { enabled: true }, plugins: [jwt({ jwt: { issuer: origin, audience: origin } }), deviceAuthorization({ expiresIn: "2m", interval: "1s", validateClient: id => id === "cotal-cli" }), bearer()] });
  handler = toNodeHandler(idp);
  const signup = await idp.api.signUpEmail({ body: { email: "endpoint@example.test", password: "fixture-only-login-password", name: "Endpoint operator" }, returnHeaders: true });
  const cookie = signup.headers.get("set-cookie")!.split(";")[0];
  const approve = async (userCode: string) => {
    const claim = await fetch(`${idpUrl}/device?user_code=${encodeURIComponent(userCode)}`, { headers: { cookie, origin } });
    assert.ok(claim.ok, "P01-device-claim");
    const response = await fetch(`${idpUrl}/device/approve`, { method: "POST", headers: { "content-type": "application/json", cookie, origin }, body: JSON.stringify({ userCode }) });
    assert.ok(response.ok, "P01-device-approve");
  };
  const space = "publicep" + Date.now(), root = await core.createBrokerAuth("endpoint-public"), accountAuth = await core.createSpaceAccountAuth(root, space), auth = core.composeSpaceAuth(root, accountAuth);
  const stateDir = join(dir, "state"); mkdirSync(stateDir);
  const store = new MemoryStore({ kind: "injected", coordinate: `endpoint-public:${space}` });
  const prepared = await authApi.cotalAuthProvider.prepareServer({ store, dir: stateDir, space, idpUrl, operatorSeed: root.operator.seed!, account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed! } });
  const port = await pickFreePort(), servers = `nats://127.0.0.1:${port}`;
  writeFileSync(join(dir, "nats.conf"), core.serverConfig(root, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js"), extraAccounts: prepared.extraAccounts }), { mode: 0o600 });
  broker = spawn("nats-server", ["-c", join(dir, "nats.conf")], { stdio: "ignore" }); releaseBroker = teardownOnSignal(broker, dir);
  await awaitBrokerReady(() => core.isReachable(servers), { servers, attempts: 60, delayMs: 50 });
  await core.setupSpaceStreams({ servers, space, creds: await core.mintCreds(auth, core.newIdentity(), "provisioner") });
  const login = await authApi.establishIdpSession({ dir: process.env.COTAL_HOME!, idpUrl, clientId: "cotal-cli", onPrompt: prompt => approve(prompt.userCode) });
  cell("P01-genuine-device-login", typeof login.sub === "string" && !!login.sub);
  const owner = await authApi.cotalAuthProvider.ownerForLogin!({ store, dir: stateDir, space });
  const actor = authApi.grantActor(stateDir, { owner, actor: "cli", scope: [], allowSubscribe: [], allowPublish: [] });
  const principal = { owner, actor: "cli", uid: actor.lifecycleUid! };
  const endpoint = "test.example.public", account = { space, accountPublicKey: auth.account.pub, assignmentRevision: 1 };
  const input = { type: "null" }, output = { type: "object", properties: { effects: { type: "integer" } }, required: ["effects"], additionalProperties: false };
  const contract = { input: core.compileContract({ root: input }), output: core.compileContract({ root: output }) };
  const cluster = { urn: endpoint, revision: 1, attributes: [], events: [], commands: [{ name: "increment", class: "ephemeral", effect: "write", targeted: false, capability: "testcall", inputDigest: contract.input.closureDigest, outputDigest: contract.output.closureDigest }] };
  const manifest = core.singleDocumentClosure(cluster).manifest, closures = [core.contractDigest(manifest)];
  const artifacts = [input, output, { ...core.singleDocumentClosure(input).manifest }, { ...core.singleDocumentClosure(output).manifest }, cluster, { ...manifest }].map(value => ({ digest: core.contractDigest(value), value }));
  const decisions = new Map<string, core.EndpointInstanceAuthorityRequest>();
  const ceiling = { routes: { kind: "instance" as const }, resources: { kind: "ephemeral-only" as const }, expiresAt: Math.floor(Date.now() / 1000) + 120 };
  const policy: authApi.EndpointAuthorityPolicy = {
    namespace: async name => { assert.equal(name, endpoint); return { account, endpoint, governor: owner, namespaceRevision: 1, policyRevision: 1, clusterDigests: closures }; },
    actorIsCurrent: async p => core.canonicalJson(p) === core.canonicalJson(principal),
    serving: async (p, allocation) => { const binding = { account, holder: { owner: p.owner, actor: p.actor, lifecycleUid: p.uid, publicKey: allocation.publicKey }, authority: { namespaceRevision: 1, policyRevision: 1, delegationId: core.mintLifecycleUid(), delegationRevision: 1 }, ceiling }; decisions.set(allocation.instanceId, { account, endpoint, instanceId: allocation.instanceId, holder: binding.holder, clusterDigests: closures, expected: binding.authority, ceiling }); return binding; },
    authorizeInstance: async request => core.canonicalJson(decisions.get(request.instanceId)) === core.canonicalJson(request) ? { authorized: true, governor: owner, ref: request.expected, ceiling } : { authorized: false },
    caller: async (p, request) => { if (core.canonicalJson(p) !== core.canonicalJson(principal) || !decisions.has(request.instanceId) || request.endpoint !== endpoint || request.commands.some(command => command !== "increment")) throw new Error("caller policy denied"); return { capabilities: request.commands.map(command => ({ endpoint, command })), expiresAt: ceiling.expiresAt }; },
  };
  let currentAssignment: core.EndpointDeploymentAssignment | null = { account, lifecycleUid: core.mintLifecycleUid(), state: "active", expiresAt: ceiling.expiresAt };
  const assignment = structuredClone(currentAssignment), assignmentFlights = new Map<string, Promise<unknown>>();
  const deployment: core.EndpointAuthorityDeployment = { assignment, withCurrentAssignment: (expected, operation) => serializedFor(assignmentFlights, "deployment", async () => { if (!currentAssignment || core.canonicalJson(currentAssignment) !== core.canonicalJson(expected)) throw new Error("deployment assignment replaced"); core.parseEndpointDeploymentAssignment(currentAssignment); const result = await operation(); core.parseEndpointDeploymentAssignment(currentAssignment); return result; }) };
  handle = await authApi.startAuthService({ context: { accountPublicKey: account.accountPublicKey, lifecycleUid: core.mintLifecycleUid() }, space, servers, store, storeIdentity: store.identity, stateDir, endpointAuthority: { policy, deployment } });
  cell("P02-public-startAuthService-ready", (await handle.readiness()).state === "ready");
  // Embedded hosts publish their returned listener handle for the local registered provider.
  // startAuthService intentionally does not install the CLI daemon's ambient discovery file.
  authApi.saveAuthServiceInfo(stateDir, { url: handle.url, pid: process.pid, cap: handle.cap });
  // This deployment-owned policy setup is an explicit trusted fixture residual, not client authority.
  policyWriter = await openAuthorityClient({ server: servers, space, dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed! }, label: "public-fixture-policy-writer", grants: id => ({ publish: ["$JS.API.INFO", `$JS.API.STREAM.INFO.KV_${core.epAuthBucket(space)}`, `$JS.API.STREAM.MSG.GET.KV_${core.epAuthBucket(space)}`, `$KV.${core.epAuthBucket(space)}.${core.endpointPolicyKey(endpoint)}`], subscribe: [`_INBOX_${id}.>`] }), log: () => {} });
  const authKv = await new Kvm(policyWriter.nc).open(core.epAuthBucket(space));
  await core.provisionEndpointPolicyHead(authKv, endpoint, 1);
  const ordinary = await authApi.cotalAuthProvider.userCredentials({ store, dir: stateDir, space, actor: "cli" });
  cell("P03-root-provider-logged-in-bearer", !!ordinary.bearer && !!ordinary.sentinelCreds);
  const post = async (path: string, body: unknown, bearerToken = ordinary.bearer): Promise<Record<string, unknown>> => {
    const response = await fetch(handle!.url + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearerToken}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const value = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(`public HTTP ${path} refused ${response.status}: ${value.error}`);
    return value;
  };
  const trust = await handle.endpointDeploymentTrust!();
  cell("R01-authenticated-host-trust-projection", trust.account.accountPublicKey === auth.account.pub && trust.account.assignmentRevision === 1 && trust.authority.endpoint === "auth" && trust.authority.epoch === 0 && trust.keys.every(key => !("d" in key)));
  const requestPins = { account: trust.account, assignmentLifecycleUid: trust.assignmentLifecycleUid, authority: trust.authority };
  const holder = core.newIdentity(), prepareId = core.mintLifecycleUid();
  const reservation = await post("/endpoint-service-authority", { v: 2, ...requestPins, operation: "prepare", operationId: prepareId, endpoint, holderPublicKey: holder.id });
  cell("P04-public-HTTP-prepare", typeof reservation.instanceId === "string" && reservation.state === "prepared");
  const instanceId = reservation.instanceId as string, operationId = core.mintLifecycleUid(), content = { action: "activate", registrationRevision: 0, processEpoch: 0, contractArtifacts: artifacts };
  const challenge = await post("/endpoint-service-authority", { v: 2, ...requestPins, operation: "challenge", operationId, instanceId, content });
  cell("P05-public-HTTP-challenge", challenge.instanceId === instanceId && challenge.operationId === operationId);
  const signature = Buffer.from(fromSeed(new TextEncoder().encode(holder.seed)).sign(new TextEncoder().encode(core.canonicalJson(challenge)))).toString("base64url");
  const active = await post("/endpoint-service-authority", { v: 2, ...requestPins, operation: "activate", operationId, instanceId, content, signature });
  cell("P06-public-HTTP-activate", typeof active.serveJwt === "string" && typeof active.attestation === "string" && active.processEpoch === 0);

  const selection = { endpoint, instanceId, commands: ["describe", "increment"] };
  const caller = await authApi.cotalAuthProvider.endpointCallerAuthority!({ store, dir: stateDir, space, actor: "cli", trust, selection });
  cell("R02-dedicated-signed-in-provider-receipt", caller.receipt.selection.instanceId === instanceId && caller.receipt.principal.owner === owner && caller.receipt.bearerDigest === core.rawDigest(caller.bearer));
  const options = core.standaloneConnectOpts({ tls: false, bearer: caller.bearer, sentinelCreds: caller.sentinelCreds });
  const callerNc = await connect({ servers, ...options, maxReconnectAttempts: 0 }); connections.push(callerNc);
  cell("P08-real-native-user-callout-connect", !callerNc.isClosed());
  const accepted = await core.issuedUserCaller(callerNc, space, options.name as string, caller.receipt.principal);
  cell("P09-native-connectionAcceptedToken-generation", accepted.owner === owner && accepted.actor === "cli" && accepted.uid === principal.uid && typeof accepted.generation === "string");
  await assert.rejects(core.issuedUserCaller(callerNc, space, options.name as string, { ...principal, uid: core.mintLifecycleUid() }), /not the caller/);
  cell("P10-wrong-expected-principal-refused", true);
  await assert.rejects(authApi.cotalAuthProvider.endpointCallerAuthority!({ store, dir: stateDir, space, actor: "cli", trust, selection: { ...selection, commands: ["describe", "other"] } }), /caller policy denied/);
  cell("P11-public-ungranted-command-refused", true);
  const control = await authApi.cotalAuthProvider.endpointServingControlAuthority!({ store, dir: stateDir, space, actor: "cli", trust, selection: { ...selection, commands: ["describe", "ep-check", "ep-admit", "ep-release"] }, credentialDigest: active.credentialDigest as string, holder: { publicKey: holder.id, sign: async bytes => fromSeed(new TextEncoder().encode(holder.seed)).sign(bytes) } });
  cell("R03-holder-proved-public-serving-control", control.receipt.kind === "cotal.endpoint-control" && control.receipt.selection.instanceId === instanceId);
  const controlOpts = core.standaloneConnectOpts({ tls: false, bearer: control.bearer, sentinelCreds: control.sentinelCreds });
  const controlNc = await connect({ servers, ...controlOpts, maxReconnectAttempts: 0 }); connections.push(controlNc);
  const controlCaller = await core.issuedUserCaller(controlNc, space, controlOpts.name as string, control.receipt.principal);
  const adoption = await core.adoptEndpointService({ nc: controlNc, authority: { space, instanceId: trust.authority.instanceId, epoch: trust.authority.epoch, caller: controlCaller }, trust: { issuer: trust.issuer, accountPublicKey: trust.account.accountPublicKey, assignmentRevision: trust.account.assignmentRevision, keys: trust.keys, accountSigningKey: trust.accountSigningKey }, serveJwt: active.serveJwt as string, attestation: active.attestation as string, artifacts, holder: { publicKey: holder.id, sign: async bytes => fromSeed(new TextEncoder().encode(holder.seed)).sign(bytes) } });
  const { fmtCreds } = await import("@nats-io/jwt");
  const serveNc = await connect({ servers, ...core.standaloneConnectOpts({ tls: false, creds: new TextDecoder().decode(fmtCreds(active.serveJwt as string, fromSeed(new TextEncoder().encode(holder.seed)))) }), maxReconnectAttempts: 0 }); connections.push(serveNc);
  servingHandle = core.serveEndpoint(serveNc, space, adoption.grant, [{ command: "increment", contract, handler: () => ({ effects: ++effects }) }], { view: () => { throw new Error("delegated describe must use authenticated stock admission"); } }, { requestAuthority: adoption.requestAuthority });
  await serveNc.flush();
  const resolved = await core.resolveService(callerNc, space, endpoint, accepted, { instanceId, deadlineMs: 5000 });
  core.assertEndpointCallerResolvedService(resolved, caller.receipt);
  cell("R04-native-descriptor-receipt-bound", resolved.responder.instanceId === instanceId && resolved.owner === owner);
  const invoked = await core.invokeCommand(callerNc, space, resolved, "increment", undefined, { deadlineMs: 5000 });
  cell("R05-native-effect-through-public-caller-control", invoked.reply.ok && effects === 1);
  await assert.rejects(core.resolveService(callerNc, space, endpoint, accepted, { deadlineMs: 1200 }), /permission-denied|REFUSED BY THE BROKER/);
  cell("R06-class-request-broker-refused-no-effect", effects === 1);
  await assert.rejects(authApi.cotalAuthProvider.endpointCallerAuthority!({ store, dir: stateDir, space, actor: "cli", trust: { ...trust, account: { ...trust.account, assignmentRevision: 2 } }, selection }), /pins changed/);
  cell("R07-wrong-assignment-revision-refused", effects === 1);
  const receiptRequestId = core.mintLifecycleUid();
  const signed = await post("/endpoint-caller-authority", { v: 2, ...requestPins, requestId: receiptRequestId, ...selection });
  await assert.rejects(core.verifyEndpointCallerAuthorityReceipt({ receipt: signed.receipt as string, bearer: signed.token as string, trust, requestId: core.mintLifecycleUid(), selection, principal }), /request\/time mismatch/, "R10-signed-receipt-request-replay-refused");
  cell("R10-signed-receipt-request-replay-refused", effects === 1);
  await assert.rejects(core.verifyEndpointCallerAuthorityReceipt({ receipt: signed.receipt as string, bearer: signed.token + "changed", trust, requestId: receiptRequestId, selection, principal }), /bearer mismatch/, "R11-signed-receipt-bearer-substitution-refused");
  cell("R11-signed-receipt-bearer-substitution-refused", effects === 1);
  await assert.rejects(authApi.cotalAuthProvider.endpointCallerAuthority!({ store, dir: stateDir, space, actor: "cli", trust: { ...trust, authority: { ...trust.authority, epoch: 1 } }, selection }), /pins changed/, "R12-stale-native-auth-epoch-refused");
  cell("R12-stale-native-auth-epoch-refused", effects === 1);
  const foreignHolder = core.newIdentity();
  await assert.rejects(authApi.cotalAuthProvider.endpointServingControlAuthority!({ store, dir: stateDir, space, actor: "cli", trust, selection: { ...selection, commands: ["describe", "ep-check", "ep-admit", "ep-release"] }, credentialDigest: active.credentialDigest as string, holder: { publicKey: foreignHolder.id, sign: async bytes => fromSeed(new TextEncoder().encode(foreignHolder.seed)).sign(bytes) } }), /holder proof/, "R13-foreign-holder-control-proof-refused");
  cell("R13-foreign-holder-control-proof-refused", effects === 1);
  const record = { v: 2, kind: "cotal.endpoint-deployment-trust", space, exchangeOrigin: new URL(handle.url).origin, provisionedAt: Math.floor(Date.now() / 1000), trust };
  core.parseEndpointDeploymentTrustRecord(record, { space, exchangeOrigin: new URL(handle.url).origin });
  assert.throws(() => core.parseEndpointDeploymentTrustRecord(record, { space, exchangeOrigin: "https://other.example" }), /origin mismatch/, "R14-protected-root-record-wrong-origin-refused");
  cell("R14-protected-root-record-wrong-origin-refused", true);
  assert.throws(() => core.parseEndpointDeploymentTrust({ ...trust, keys: [{ ...trust.keys[0], d: "private" }] }), /closed shape/, "R15-root-trust-private-key-refused");
  cell("R15-root-trust-private-key-refused", true);
  const writeProto = Object.getPrototypeOf(authKv) as { create: typeof authKv.create; update: typeof authKv.update };
  const originalWriteCreate = writeProto.create, originalWriteUpdate = writeProto.update;
  const denialWrites: string[] = [];
  writeProto.create = async function (...args: Parameters<typeof originalWriteCreate>) { const revision = await originalWriteCreate.apply(this, args); denialWrites.push(args[0]); return revision; };
  writeProto.update = async function (...args: Parameters<typeof originalWriteUpdate>) { const revision = await originalWriteUpdate.apply(this, args); denialWrites.push(args[0]); return revision; };
  restoreClockProbe = () => { writeProto.create = originalWriteCreate; writeProto.update = originalWriteUpdate; };
  await assert.rejects(post("/endpoint-caller-authority", { v: 2, ...requestPins, account: { ...trust.account, assignmentRevision: 2 }, requestId: core.mintLifecycleUid(), ...selection }), /pins changed/);
  await assert.rejects(post("/endpoint-caller-authority", { v: 2, ...requestPins, requestId: core.mintLifecycleUid(), ...selection, owner: "untrusted" }), /closed endpoint/);
  await assert.rejects(post("/endpoint-service-authority", { v: 2, ...requestPins, operation: "control", requestId: core.mintLifecycleUid(), endpoint, instanceId, commands: ["describe", "ep-check", "ep-admit", "ep-release"], credentialDigest: active.credentialDigest, signature: Buffer.from(fromSeed(new TextEncoder().encode(foreignHolder.seed)).sign(new Uint8Array([1]))).toString("base64url") }), /holder proof/);
  restoreClockProbe(); restoreClockProbe = undefined;
  const materialWrites = denialWrites.filter(key => /^(cred\.|endpoint-grant\.|endpoint-reservation\.|endpoint-active\.|accepted\.|svc\.)/.test(key));
  console.log(JSON.stringify({ oracle: "A42-04", deniedRequests: 3, durableWrites: denialWrites.length, materialWrites: materialWrites.length, policyHoldWrites: denialWrites.filter(key => key === core.endpointPolicyKey(endpoint)).length, effects }));
  cell("A42-04-denied-public-pins-holder-zero-material-writes", materialWrites.length === 0 && effects === 1);
  if (process.env.A42_UNCERTAIN_ACCEPTED === "1") {
    const uncertainOptions = core.standaloneConnectOpts({ tls: false, bearer: caller.bearer, sentinelCreds: caller.sentinelCreds });
    const acceptedKey = core.acceptedKey(core.connectionAcceptedToken(uncertainOptions.name as string));
    const proto = Object.getPrototypeOf(authKv) as { create: typeof authKv.create };
    const originalCreate = proto.create;
    let acceptedDurableWriteObserved = false;
    proto.create = async function (...args: Parameters<typeof originalCreate>) {
      const revision = await originalCreate.apply(this, args);
      if (args[0] === acceptedKey) {
        acceptedDurableWriteObserved = true;
        throw new Error("fixture lost accepted-row acknowledgement after real broker durable write");
      }
      return revision;
    };
    restoreClockProbe = () => { proto.create = originalCreate; };
    let uncertainConnected = false;
    try { const escaped = await connect({ servers, ...uncertainOptions, maxReconnectAttempts: 0 }); connections.push(escaped); uncertainConnected = true; } catch { /* native refusal required */ }
    restoreClockProbe(); restoreClockProbe = undefined;
    const heldEntry = await authKv.get(core.endpointPolicyKey(endpoint));
    const held = heldEntry ? JSON.parse(new TextDecoder().decode(heldEntry.value)) as { state?: string } : undefined;
    cell("A42-02-real-accepted-durable-write-observed", acceptedDurableWriteObserved);
    cell("A42-02-uncertain-write-no-native-permission-release", !uncertainConnected && effects === 1);
    cell("A42-02-uncertain-accepted-write-retains-policy-custody", held?.state === "held");
    let replayConnected = false;
    try { const replay = await connect({ servers, ...uncertainOptions, maxReconnectAttempts: 0 }); connections.push(replay); replayConnected = true; } catch { /* uncertain held operation must refuse replay */ }
    cell("A42-02-same-nonce-uncertain-replay-refused", !replayConnected && effects === 1);
  } else {
  const freshIdp = await authApi.fetchIdpJwt(idpUrl, login.session.token);
  const shortExchange = await fetch(handle.url + "/exchange", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${handle.cap}` }, body: JSON.stringify({ idpToken: freshIdp, actor: "cli", ttlSec: 4 }) });
  assert.ok(shortExchange.ok, "A42-01-real-short-user-exchange");
  const shortBearer = (await shortExchange.json() as { token: string }).token, shortExp = decodeJwt(shortBearer).exp!;
  const kvProto = Object.getPrototypeOf(authKv) as { get: typeof authKv.get };
  const originalGet = kvProto.get, originalSign = SignJWT.prototype.sign;
  let signedReceipt = false, authReadsAfterSign = 0, finalReadDelayed = false;
  SignJWT.prototype.sign = async function (...args: Parameters<typeof originalSign>) {
    const value = await originalSign.apply(this, args);
    if (decodeJwt(value).kind === "cotal.endpoint-caller") signedReceipt = true;
    return value;
  };
  kvProto.get = async function (...args: Parameters<typeof originalGet>) {
    if (signedReceipt && args[0] === core.epgateKey("auth", trust.authority.instanceId) && ++authReadsAfterSign === 2) {
      finalReadDelayed = true;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, shortExp * 1000 + 50 - Date.now())));
    }
    return originalGet.apply(this, args);
  };
  restoreClockProbe = () => { kvProto.get = originalGet; SignJWT.prototype.sign = originalSign; };
  const delayedReply = await fetch(handle.url + "/endpoint-caller-authority", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${shortBearer}` }, body: JSON.stringify({ v: 2, ...requestPins, requestId: core.mintLifecycleUid(), ...selection }), signal: AbortSignal.timeout(15000) });
  await delayedReply.json();
  restoreClockProbe(); restoreClockProbe = undefined;
  cell("A42-01-final-broker-await-crossed-user-expiry", signedReceipt && finalReadDelayed && Date.now() >= shortExp * 1000);
  cell("A42-01-expired-caller-no-material-after-final-await", !delayedReply.ok && effects === 1);
  await policyWriter.close();
  policyWriter = await openAuthorityClient({ server: servers, space, dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed! }, label: "public-fixture-freeze-writer", grants: id => ({ publish: ["$JS.API.INFO", `$JS.API.STREAM.INFO.KV_${core.epAuthBucket(space)}`, `$JS.API.STREAM.MSG.GET.KV_${core.epAuthBucket(space)}`, `$KV.${core.epAuthBucket(space)}.${core.endpointPolicyKey(endpoint)}`, `$KV.${core.epAuthBucket(space)}.${core.epgateKey(endpoint, instanceId)}`], subscribe: [`_INBOX_${id}.>`] }), log: () => {} });
  const freezeKv = await new Kvm(policyWriter.nc).open(core.epAuthBucket(space));
  const freezeOperation = core.mintLifecycleUid(), freezeHold = await core.acquireEndpointPolicyHold(freezeKv, { endpoint, policyRevision: 1, operationId: freezeOperation, content: { kind: "native-frozen-caller-repro", instanceId } });
  const barrier = core.endpointRegistrationBarrier(freezeKv, space, { endpoint, instanceId, opId: freezeOperation, policyHold: freezeHold });
  const observed = await barrier.observe();
  assert.ok(observed, "A42-03-live-gate-observed");
  const frozenToken = await barrier.freeze(observed.revision);
  assert.ok(frozenToken !== null, "A42-03-native-freeze-CAS");
  await freezeHold.release();
  cell("A42-03-native-serving-gate-frozen", true);
  const frozenOptions = core.standaloneConnectOpts({ tls: false, bearer: caller.bearer, sentinelCreds: caller.sentinelCreds });
  let frozenAccepted = false;
  try { const leaked = await connect({ servers, ...frozenOptions, maxReconnectAttempts: 0 }); connections.push(leaked); frozenAccepted = true; } catch { /* broker refusal is the required outcome */ }
  cell("A42-03-frozen-serving-gate-refuses-caller-reconnect", !frozenAccepted && effects === 1);
  await serializedFor(assignmentFlights, "deployment", async () => { currentAssignment = null; });
  await assert.rejects(authApi.cotalAuthProvider.endpointCallerAuthority!({ store, dir: stateDir, space, actor: "cli", trust, selection }), /assignment replaced/);
  cell("R08-current-assignment-replacement-refused", effects === 1);
  await assert.rejects(handle.endpointDeploymentTrust!(), /assignment replaced/);
  cell("R09-stale-root-projection-refused", true);
  }

} catch (error) { failure = error; console.error(error instanceof Error ? error.stack : String(error)); }
finally {
  clearTimeout(timer);
  restoreClockProbe?.();
  try { await servingHandle?.stop(); } catch (error) { cleanupErrors.push(String(error)); }
  for (const nc of connections.reverse()) try { await nc.close(); await nc.closed(); } catch (error) { cleanupErrors.push(String(error)); }
  try { await policyWriter?.close(); } catch (error) { cleanupErrors.push(String(error)); }
  try { await handle?.close(); if (handle) await handle.closed; } catch (error) { cleanupErrors.push(String(error)); }
  await new Promise<void>(resolve => { idpHttp.closeAllConnections(); idpHttp.close(() => resolve()); });
  if (broker) try { await killAndAwaitExit(broker, "SIGTERM"); } catch (error) { cleanupErrors.push(String(error)); }
  releaseBroker?.();
  rmSync(dir, { recursive: true, force: true }); releasePath();
  writeFileSync(reportPath, JSON.stringify({ scope: "public-http-native-callout-diagnostic", checks, assertions: checks.length, passed: !failure && cleanupErrors.length === 0, failure: failure ? String(failure) : null, cleanupErrors, startAuthServicePublicLifecycle: checks.includes("P02-public-startAuthService-ready"), rootProviderOrdinaryLogin: checks.includes("P03-root-provider-logged-in-bearer"), realUserCallout: checks.includes("P08-real-native-user-callout-connect"), providerEndpointSelectionAPI: checks.includes("R02-dedicated-signed-in-provider-receipt"), authenticatedDeploymentReceipt: checks.includes("R01-authenticated-host-trust-projection"), signerlessPublicServingControl: checks.includes("R03-holder-proved-public-serving-control"), effects, fullU1U2Acceptance: false, fixtureResidual: "Deployment signer/store/policy setup stays in trusted harness; exact policy-key writer has stream-wide leader metadata read, signerless adoption/control/serve connections in one harness process, no independent A/B worker proof." }, null, 2) + "\n", { mode: 0o600 });
  if (failure || cleanupErrors.length) process.exitCode = 1;
}
