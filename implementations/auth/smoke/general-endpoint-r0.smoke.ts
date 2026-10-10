import assert from "node:assert/strict";
import { spawn, fork, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins/jwt";
import { toNodeHandler } from "better-auth/node";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { encodeUser, fmtCreds, decode } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import * as core from "@cotal-ai/core";
import * as authApi from "@cotal-ai/auth";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal, teardownPathOnSignal } from "@cotal-ai/smoke-kit";

const observations: Array<Record<string, unknown>> = [];
const checks: string[] = [];
function check(cell: string, value: unknown) { assert.ok(value, cell); checks.push(cell); console.log(JSON.stringify({ cell, passed: true })); }
const enc = new TextEncoder();
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function bounded<T>(promise: Promise<T>, ms = 8000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("R0 bounded operation timed out")), ms); })]); }
  finally { clearTimeout(timer); }
}
async function rejected(cell: string, action: () => Promise<unknown>, expected: RegExp) {
  try { await action(); throw new Error(cell + " unexpectedly succeeded"); }
  catch (e) { const code = (e as { code?: unknown }).code; const message = e instanceof Error ? e.message : String(e); observations.push({ cell, code, message }); check(cell, expected.test(String(code) + " " + message)); }
}
class MemoryStore implements core.SecretStore {
  readonly values = new Map<string, string>();
  constructor(readonly identity: { kind: "injected"; coordinate: string }) {}
  async get(key: string) { return this.values.get(key); }
  async put(key: string, value: string) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
}
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN + "-endpoint-r0-"));
const releasePath = teardownPathOnSignal(dir);
const connections: NatsConnection[] = [];
const handles: authApi.AuthServiceHandle[] = [];
const workers: { child: ChildProcess; messages: Record<string, unknown>[]; exit: Promise<number | null> }[] = [];
let broker: ChildProcess | undefined, releaseBroker: (() => void) | undefined;
let handler: ReturnType<typeof toNodeHandler> | undefined;
const idpServer = createServer((req, res) => handler!(req, res));
let failure: unknown;
const reportPath = process.env.ENDPOINT_R0_REPORT;
if (!reportPath) throw new Error("owned report path required");
const deadline = setTimeout(() => { console.error("R0 absolute work deadline"); process.kill(process.pid, "SIGTERM"); }, 150_000);
try {
  await new Promise<void>(resolve => idpServer.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(idpServer.address() as AddressInfo).port}`;
  const idp = betterAuth({ baseURL: origin, secret: randomBytes(32).toString("hex"), database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [] }), emailAndPassword: { enabled: true }, plugins: [jwt({ jwt: { issuer: origin, audience: origin } })] });
  handler = toNodeHandler(idp);
  const users: { id: string; token: string }[] = [];
  for (const label of ["a", "b"]) {
    const signup = await idp.api.signUpEmail({ body: { email: `${label}@endpoint-r0.test`, password: randomBytes(24).toString("hex"), name: `R0 ${label}` }, returnHeaders: true });
    const cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0];
    const response = await fetch(`${origin}/api/auth/token`, { headers: { cookie }, signal: AbortSignal.timeout(8000) });
    const { token } = await response.json() as { token: string };
    check(`R001-real-idp-${label}`, response.status === 200 && typeof token === "string");
    users.push({ id: signup.response.user.id, token });
  }
  check("R002-two-distinct-idp-users", users[0].id !== users[1].id);
  const root = await core.createBrokerAuth("endpoint-r0");
  const spaces = ["epr0s" + Date.now(), "epr0t" + Date.now()];
  const accounts: { space: string; auth: core.SpaceAuth; store: MemoryStore; callout: authApi.CalloutAuth; stateDir: string; actors: { owner: string; actor: string; uid: string; token: string }[] }[] = [];
  for (const space of spaces) {
    const spaceAuth = await core.createSpaceAccountAuth(root, space);
    const auth = core.composeSpaceAuth(root, spaceAuth);
    const store = new MemoryStore({ kind: "injected", coordinate: `r0:${space}` });
    const callout = await authApi.ensureCalloutAuth(store, { space, operatorSeed: root.operator.seed!, accountPub: auth.account.pub });
    await authApi.ensureIssuer(store, space);
    const secret = await authApi.ensureOwnerSecret(store, space);
    await authApi.saveServiceKeys(store, space, { dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed! } });
    const stateDir = join(dir, space); mkdirSync(stateDir, { mode: 0o700 });
    authApi.ensurePinnedIdp(stateDir, `${origin}/api/auth`);
    const actors = users.map(user => ({ owner: authApi.deriveOwnerForIdpSubject(secret, origin, user.id), actor: "cli", uid: core.mintLifecycleUid(), token: user.token }));
    for (const actor of actors) authApi.grantActor(stateDir, { owner: actor.owner, actor: actor.actor, lifecycleUid: actor.uid, scope: ["r0call"], allowSubscribe: [], allowPublish: [] });
    accounts.push({ space, auth, store, callout, stateDir, actors });
  }
  check("R003-distinct-native-accounts", accounts[0].auth.account.pub !== accounts[1].auth.account.pub);
  const portServer = createServer(); await new Promise<void>(resolve => portServer.listen(0, "127.0.0.1", resolve));
  const port = (portServer.address() as AddressInfo).port; await new Promise<void>(resolve => portServer.close(() => resolve()));
  const servers = `nats://127.0.0.1:${port}`;
  const conf = join(dir, "nats.conf");
  writeFileSync(conf, core.serverConfig(root, accounts.map(a => a.auth), { host: "127.0.0.1", transport: { kind: "plaintext" }, port, storeDir: join(dir, "js"), extraAccounts: accounts.map(a => ({ pub: a.callout.account.pub, jwt: a.callout.account.jwt })) }), { mode: 0o600 });
  broker = spawn("nats-server", ["-c", conf], { stdio: "ignore" }); releaseBroker = teardownOnSignal(broker, dir);
  await awaitBrokerReady(() => core.isReachable(servers), { servers, attempts: 60, delayMs: 50 });
  for (const a of accounts) {
    await core.setupSpaceStreams({ servers, space: a.space, creds: await core.mintCreds(a.auth, core.newIdentity(), "provisioner") });
    const handle = await bounded(authApi.startAuthService({ context: { accountPublicKey: a.auth.account.pub, lifecycleUid: core.mintLifecycleUid() }, space: a.space, servers, stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity }), 20000);
    handles.push(handle);
    check(`R004-auth-ready-${a.space}`, (await handle.readiness()).state === "ready");
  }
  const endpoint = "test.example.r0";
  const input = { type: "null" }, output = { type: "object", properties: { effects: { type: "integer" } }, required: ["effects"], additionalProperties: false };
  const inputContract = core.compileContract({ root: input }), outputContract = core.compileContract({ root: output });
  const cluster = { urn: "test.example.r0", revision: 1, attributes: [], events: [], commands: ["increment", "other"].map(name => ({ name, class: "ephemeral", targeted: false, capability: "r0call", inputDigest: inputContract.closureDigest, outputDigest: outputContract.closureDigest })) };
  const manifest = { v: 1, root: core.contractDigest(cluster), members: [] };
  const artifacts = [input, output, { v: 1, root: core.contractDigest(input), members: [] }, { v: 1, root: core.contractDigest(output), members: [] }, cluster, manifest];
  const artifactMap = new Map(artifacts.map(x => [core.contractDigest(x), x]));
  const registrations: { instanceId: string; owner: string; epoch: number }[] = [];
  for (const [index, a] of accounts.entries()) {
    const instanceId = core.mintLifecycleUid(), identity = core.newIdentity(), owner = a.actors[0].owner;
    const executorCreds = await core.mintCreds(a.auth, core.newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint, instanceId } });
    const nc = await connect({ servers, ...core.standaloneConnectOpts({ tls: false, creds: executorCreds }), maxReconnectAttempts: 0 }); connections.push(nc);
    const kvm = new Kvm(nc), authKv = await kvm.open(core.epAuthBucket(a.space)), recordsKv = await kvm.open(core.recordsBucket(a.space));
    const store = await core.contractStoreContext(nc, a.space);
    for (const artifact of artifacts) await core.publishContractArtifact(store, core.contractArtifactCanonicalBytes(artifact));
    await core.provisionEndpointGateOpen(authKv, { endpoint, instanceId, principal: core.principalKey(owner, identity.id).key });
    const registered = await core.registerServingInstance(recordsKv, { space: a.space, instanceId, spec: { endpoint, owner, clusterDigests: [core.contractDigest(manifest)], protocol: { v: 1 } }, registrant: { owner }, authority: { authorize: (name, o) => ({ authorized: name === endpoint && o === owner, revision: 0 }) }, barrier: core.endpointRegistrationBarrier(authKv, a.space, { endpoint, instanceId, opId: core.mintLifecycleUid() }), readClusterArtifact: digest => artifactMap.get(digest) });
    const serveCreds = await core.mintCreds(a.auth, identity, "endpoint-serve", { principal: { owner, actor: identity.id }, endpointServe: registered.grant, serveIssuance: core.serveIssuanceGateKv(authKv, a.space, { endpoint, instanceId }) });
    // Separate native reader has no issuer/executor writes. Leader MSG.GET is an explicit records-only metadata residual.
    const readerId = core.newIdentity();
    const rec = core.recordsBucket(a.space), prefix = core.spacePrefix(a.space);
    const readRows = ["$JS.API.INFO", `$JS.API.STREAM.MSG.GET.KV_${rec}`, ...[core.recordSpecKey(core.RECORD_KINDS.svc, [endpoint, instanceId]), core.recordStatusKey(core.RECORD_KINDS.svc, [endpoint, instanceId])].map(key => `$JS.API.DIRECT.GET.KV_${rec}.$KV.${rec}.${key}`), `$JS.API.DIRECT.GET.${core.epcStreamName(a.space)}.${prefix}.epc.*`];
    const readJwt = await encodeUser("r0-service-reader", fromPublic(readerId.id), fromPublic(a.auth.account.pub), { pub: { allow: readRows }, sub: { allow: [`_INBOX_${readerId.id}.>`] } }, { signer: fromSeed(enc.encode(a.auth.account.signingSeed!)), exp: Math.floor(Date.now()/1000) + 180 });
    const readerCreds = new TextDecoder().decode(fmtCreds(readJwt, fromSeed(enc.encode(readerId.seed))));
    const workerFile = join(dir, `worker-${index}.json`);
    writeFileSync(workerFile, JSON.stringify({ servers, space: a.space, endpoint, instanceId, epoch: registered.processEpoch, owner, serveCreds, readerCreds }), { mode: 0o600 });
    const messages: Record<string, unknown>[] = [];
    const child = fork(new URL("./general-endpoint-r0-worker.ts", import.meta.url), [], { execArgv: ["--import", "tsx"], env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ENDPOINT_R0_WORKER_FILE: workerFile }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.stderr!.on("data", () => {});
    const exit = new Promise<number | null>(resolve => child.once("exit", resolve));
    workers.push({ child, messages, exit });
    const ready = new Promise<void>((resolve, reject) => child.on("message", (m: Record<string, unknown>) => { messages.push(m); if (m.kind === "ready") resolve(); if (m.kind === "failure") reject(new Error(String(m.message))); }));
    await bounded(ready);
    check(`R005-actual-endpoint-process-${index}`, child.pid && messages.some(m => m.kind === "ready"));
    registrations.push({ instanceId, owner, epoch: registered.processEpoch });
    await nc.close();
  }
  const bearerClients: { nc: NatsConnection; caller: core.EpCaller; account: number; actor: number }[] = [];
  for (const [account, a] of accounts.entries()) for (const [actor, principal] of a.actors.entries()) {
    const response = await fetch(`${handles[account].url}/exchange`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${handles[account].cap}` }, body: JSON.stringify({ idpToken: principal.token, actor: "cli" }), signal: AbortSignal.timeout(8000) });
    const body = await response.json() as { token: string; owner: string; error?: string };
    observations.push({ cell: "R006", account, actor, httpStatus: response.status, reply: { owner: body.owner, error: body.error }, operatorAuthoredScope: ["r0call"], scopeIsNotNativeEndpointGrant: true });
    check(`R006-real-exchange-${account}-${actor}`, response.status === 200 && body.owner === principal.owner);
    const nc = await connect({ servers, ...core.standaloneConnectOpts({ tls: false, bearer: body.token, sentinelCreds: a.callout.sentinelCreds }), maxReconnectAttempts: 0 }); connections.push(nc);
    check(`R007-native-callout-connect-${account}-${actor}`, !nc.isClosed());
    bearerClients.push({ nc, caller: { owner: principal.owner, actor: "cli", uid: principal.uid }, account, actor });
  }
  for (const client of bearerClients) {
    const a = accounts[client.account];
    const described = await core.resolveService(client.nc, a.space, endpoint, client.caller, { deadlineMs: 1500 });
    check(`R008-direct-user-describe-${client.account}-${client.actor}`, described.commands.has("increment") && described.owner === registrations[client.account].owner);
    await rejected(`R009-user-invoke-denied-${client.account}-${client.actor}`, () => core.invokeCommand(client.nc, a.space, described, "increment", undefined, { deadlineMs: 1500 }), /permission-denied|REFUSED BY THE BROKER/);
  }
  check("R010-all-user-denials-zero-effects", workers.every(w => w.messages.filter(m => m.kind === "effect").length === 0));
  // Current stock name authority binds this governed name to A. B's real derived owner cannot
  // register another instance under it. Do not turn authorize(name,B) true to fake a delegated policy.
  {
    const a = accounts[0], b = a.actors[1], instanceId = core.mintLifecycleUid(), identity = core.newIdentity();
    const executorCreds = await core.mintCreds(a.auth, core.newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint, instanceId } });
    const nc = await connect({ servers, ...core.standaloneConnectOpts({ tls: false, creds: executorCreds }), maxReconnectAttempts: 0 }); connections.push(nc);
    const kvm = new Kvm(nc), authKv = await kvm.open(core.epAuthBucket(a.space)), recordsKv = await kvm.open(core.recordsBucket(a.space));
    await core.provisionEndpointGateOpen(authKv, { endpoint, instanceId, principal: core.principalKey(b.owner, identity.id).key });
    await rejected("R023-current-shared-name-B-registration-refused", () => core.registerServingInstance(recordsKv, {
      space: a.space, instanceId, spec: { endpoint, owner: b.owner, clusterDigests: [core.contractDigest(manifest)], protocol: { v: 1 } },
      registrant: { owner: b.owner }, authority: { authorize: (name, owner) => ({ authorized: name === endpoint && owner === a.actors[0].owner, revision: 0 }) },
      barrier: core.endpointRegistrationBarrier(authKv, a.space, { endpoint, instanceId, opId: core.mintLifecycleUid() }), readClusterArtifact: digest => artifactMap.get(digest),
    }), /permission-denied.*does not authorize owner/);
    const missingSpec = await recordsKv.get(core.recordSpecKey(core.RECORD_KINDS.svc, [endpoint, instanceId]));
    check("R024-refused-B-registration-no-spec-no-worker", missingSpec === null && workers.length === 2);
    observations.push({ cell: "R023", namespaceGovernor: a.actors[0].owner, requestedServingOwner: b.owner, endpoint, instanceId, delegatedServingNativeAcceptance: false, reason: "Current public ServiceNameAuthority has no per-instance contract/delegation revision decision. Static interface limitation plus real current-policy refusal, not an implementation of delegated authorization." });
    await nc.close();
  }
  const caller = bearerClients[0];
  await rejected("R011-user-pinned-describe-denied", () => core.resolveService(caller.nc, accounts[0].space, endpoint, caller.caller, { instanceId: registrations[0].instanceId, deadlineMs: 1500 }), /permission-denied|REFUSED BY THE BROKER/);
  await rejected("R012-foreign-account-raw-describe-denied", () => core.resolveService(caller.nc, accounts[1].space, endpoint, bearerClients[2].caller, { deadlineMs: 1500 }), /describe reply subscription failed: Permissions Violation for Subscription/);
  for (const [index, a] of accounts.entries()) {
    const principal = a.actors[0];
    const creds = await core.mintCreds(a.auth, core.newIdentity(), "agent", { principal: { owner: principal.owner, actor: "r0instrument" }, lifecycleUid: principal.uid, allowSubscribe: [], allowPublish: [], capabilities: [], endpointCapabilities: ["describe", "increment"].map(command => ({ endpoint, command, instanceId: registrations[index].instanceId, instanceOnly: true })) });
    const nc = await connect({ servers, ...core.standaloneConnectOpts({ tls: false, creds }), maxReconnectAttempts: 0 }); connections.push(nc);
    const instrument = { owner: principal.owner, actor: "r0instrument", uid: principal.uid };
    const service = await core.resolveService(nc, a.space, endpoint, instrument, { instanceId: registrations[index].instanceId, deadlineMs: 2000 });
    const result = await core.invokeCommand(nc, a.space, service, "increment", undefined, { deadlineMs: 2000 });
    observations.push({ cell: `R013-native-operator-control-${index}`, reply: result });
    check(`R013-native-operator-control-${index}`, result.reply.ok === true && result.responder.instanceId === registrations[index].instanceId);
    await rejected(`R014-ungranted-command-${index}`, () => core.invokeCommand(nc, a.space, service, "other", undefined, { deadlineMs: 1000 }), /permission-denied|REFUSED BY THE BROKER/);
    const claims = decode(core.jwtFromCreds(creds)!) as { nats: { pub: { allow: string[] } } };
    check(`R015-instrument-pin-no-class-command-${index}`, !claims.nats.pub.allow.some(row => row.includes(`.one.${core.endpointToken(endpoint)}.increment`) || row.includes(`.all.${core.endpointToken(endpoint)}.increment`)));
    await rejected(`R025-pinned-command-cannot-class-${index}`, () => core.invokeCommand(nc, a.space, { ...service, pinnedInstanceId: undefined }, "increment", undefined, { deadlineMs: 1000 }), /permission-denied|REFUSED BY THE BROKER/);
    await rejected(`R026-pinned-describe-cannot-other-instance-${index}`, () => core.resolveService(nc, a.space, endpoint, instrument, { instanceId: core.mintLifecycleUid(), deadlineMs: 1000 }), /permission-denied|REFUSED BY THE BROKER/);
  }
  await wait(100);
  check("R016-exact-operator-effects", workers.every(w => w.messages.filter(m => m.kind === "effect").length === 1));
  const handle = handles[0], principal = accounts[0].actors[0];
  for (const path of ["/endpoint-authority", "/endpoint-service-authority"]) {
    const response = await fetch(handle.url + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${handle.cap}` }, body: JSON.stringify({ idpToken: principal.token, actor: "cli", endpoint, instanceId: registrations[0].instanceId }), signal: AbortSignal.timeout(4000) });
    const text = await response.text(); observations.push({ cell: "R017", path, httpStatus: response.status, reply: text });
    check(`R017-guessed-generic-route-absent-${path}`, response.status === 404);
  }
  const generic = await fetch(handle.url + "/exchange", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${handle.cap}` }, body: JSON.stringify({ idpToken: principal.token, actor: "cli", view: "endpoint-caller", endpoint, instanceId: registrations[0].instanceId }), signal: AbortSignal.timeout(4000) });
  const genericReply = await generic.json(); observations.push({ cell: "R018", httpStatus: generic.status, reply: genericReply });
  check("R018-proposed-view-not-stock", generic.status === 401);
  const missing = ["EndpointAuthorityClient", "acquireEndpointCaller", "registerRemoteEndpointAuthority"].map(name => ({ name, exported: name in core || name in authApi }));
  observations.push({ cell: "R019", exports: missing, actualPublicExports: { core: Object.keys(core).sort(), auth: Object.keys(authApi).sort() } });
  check("R019-proposed-exports-not-stock", missing.every(x => !x.exported));
  check("R020-no-Manager-or-runtime-context", handles.every(h => !h.platformControlAuthority && !h.platformSupervisorAuthority) && workers.length === 2);
  console.log(JSON.stringify({ kind: "native-r0-summary", passed: checks.length, effects: workers.map(w => w.messages.filter(m => m.kind === "effect").length), liveUserInvokeSuccesses: 0, operatorControlSuccesses: 2 }));
} catch (error) { failure = error; console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; }
finally {
  const cleanupErrors: string[] = [];
  for (const worker of workers) {
    try { if (worker.child.connected) worker.child.send({ kind: "stop" }); const exit = await bounded(worker.exit, 5000); if (exit !== 0) throw new Error(`worker exit ${exit}`); check("R021-worker-exit-" + worker.child.pid, worker.messages.some(m => m.kind === "stopped")); }
    catch (e) { cleanupErrors.push(String(e)); await killAndAwaitExit(worker.child, "SIGKILL", 3000).catch(x => cleanupErrors.push(String(x))); }
  }
  for (const nc of connections) try { await bounded(nc.close(), 3000); await bounded(nc.closed(), 3000); } catch (e) { cleanupErrors.push(String(e)); }
  for (const handle of handles) try { await bounded(handle.close(), 6000); const closed = await bounded(handle.closed, 3000); check("R022-auth-owned-closure-" + handle.url, closed.connections.every(c => c.ended)); } catch (e) { cleanupErrors.push(String(e)); }
  if (broker) try { await killAndAwaitExit(broker, "SIGTERM", 5000); } catch (e) { cleanupErrors.push(String(e)); }
  await bounded(new Promise<void>(resolve => idpServer.close(() => resolve())), 3000).catch(e => cleanupErrors.push(String(e)));
  clearTimeout(deadline);
  if (cleanupErrors.length) process.exitCode = 1;
  writeFileSync(reportPath, JSON.stringify({ schema: "general-endpoints-native-r0.v1", currentSourceBase: "1bda7c112df8f2740992e7bf458b16b41ba7a616", runtimeImplementationChanges: 0, staticGuessesNotProductInterfaces: ["R017", "R018", "R019"], liveChecksExecuted: checks.filter(cell => !/^R01[789]/.test(cell)), noManager: true, assertionCount: checks.length, checks, observations, effects: workers.map(w => w.messages.filter(m => m.kind === "effect").length), failure: failure instanceof Error ? failure.message : failure ?? null, cleanupErrors, operatorProvisionedFixtureOnly: true, signerlessGenericServiceAcceptance: false, sameGovernedNameDelegatedServingAcceptance: false, desiredSharedNameCellsPending: ["GE17", "GE18"], readOnlyWorkerResidual: "records-stream metadata leader read only, no issuer/auth write or signer", secretDirectory: dir, directoryRemovedAfterReport: true }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  rmSync(dir, { recursive: true, force: true }); releaseBroker?.(); releasePath();
}
