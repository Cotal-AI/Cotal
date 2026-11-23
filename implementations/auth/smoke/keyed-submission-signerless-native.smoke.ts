/** Remaining acceptance: real signerless native manager, auth HTTP, encrypted broker callout,
 * issuer-observed keyed submission and actual seatless driver. No model seats or Cloud. */
if (process.argv[2] === "agent-bearer") {
  await import("../src/index.js");
  const { registry } = await import("@cotal-ai/core");
  const raw = process.argv.slice(3), values: Record<string, string | boolean> = {};
  for (let i = 0; i < raw.length; i++) {
    const flag = raw[i]!; if (!flag.startsWith("--")) throw new Error("fixture bearer expects flags");
    const next = raw[i + 1]; if (next && !next.startsWith("--")) { values[flag.slice(2)] = next; i++; }
    else values[flag.slice(2)] = true;
  }
  await registry.resolve<import("@cotal-ai/core").Command>("command", "agent-bearer").run({ values, positionals: [], raw });
  process.exit(0);
}
import nodeAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { connect, credsAuthenticator, tokenAuthenticator } from "@nats-io/transport-node";
import {
  mintCreds, newIdentity, mintLifecycleUid, setupSpaceStreams, issuedUserCaller, resolveService,
  prepareKeyedRunSubmission, invokeKeyedRunSubmission, readKeyedRunSubmission, invokeCommand, inspectCredHealth,
} from "@cotal-ai/core";
import {
  cotalAuthProvider, deriveOwnerForIdpSubject, ensurePinnedIdp, grantActor, loadOwnerSecret, saveIdpSession, startAuthService,
  type AuthServiceHandle,
} from "../src/index.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import { nativeRemoteManager } from "../../manager/smoke/_native-remote-manager.js";
import { bootDeliveryDaemon } from "../../manager/smoke/_boot-delivery.js";
import { homeCotalDir, recordMesh, userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";
import "../../runtime/src/index.js";
const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;

const fx = await startHostedAuthFixture("keyed-native", 1), a = fx.accounts[0]!;
const previousHome = process.env.COTAL_HOME;
const home = join(fx.dir, "cli-home"); mkdirSync(home);
process.env.COTAL_HOME = home;
const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(publicKey), kid: "keyed-idp", alg: "EdDSA" };
const idp = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(req.url === "/api/auth/token" ? { token: idpToken } : { keys: [jwk] }));
});
await new Promise<void>(resolve => idp.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(idp.address() as import("node:net").AddressInfo).port}`;
const stateDir = join(fx.dir, "keyed-auth-state"); mkdirSync(stateDir);
ensurePinnedIdp(stateDir, `${origin}/api/auth`);
const owner = deriveOwnerForIdpSubject((await loadOwnerSecret(a.store, a.space))!, origin, "keyed-human");
const cli = grantActor(stateDir, { owner, actor: "cli", scope: ["run", "supervise"], allowSubscribe: [], allowPublish: [] });
const idpToken = await new SignJWT({ name: "Fixture Member" }).setProtectedHeader({ alg: "EdDSA", kid: "keyed-idp" })
  .setSubject("keyed-human").setIssuer(origin).setAudience(origin).setIssuedAt().setExpirationTime("10m").sign(privateKey);
let service: AuthServiceHandle | undefined;
let remote: Awaited<ReturnType<typeof nativeRemoteManager>> | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
const connections: Awaited<ReturnType<typeof connect>>[] = [];
let keyedHostCalls = 0, legacyHostAdmissions = 0;
let outageStart = Infinity;
const outageMs = 20_000;
const standingRequests: { at: number; status: number }[] = [];
const edge = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const now = Date.now();
    const standing = req.method === "POST" && JSON.parse(body).request?.operation === "renewStandingBundle";
    const unavailable = req.url === "/manager-service-authority" && now >= outageStart && now < outageStart + outageMs;
    if (unavailable) {
      if (standing) standingRequests.push({ at: now, status: 503 });
      await wait(5_000);
      res.writeHead(503, { "content-type": "application/json" }).end('{"error":"backend_unavailable"}');
      return;
    }
    const upstream = await fetch(`${service!.publicUrl}${req.url}`, {
      method: req.method, headers: req.method === "POST" ? { "content-type": "application/json" } : {},
      ...(body ? { body } : {}),
    });
    if (standing) standingRequests.push({ at: now, status: upstream.status });
    res.writeHead(upstream.status, { "content-type": "application/json" }).end(await upstream.text());
  } catch (error) {
    res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: String(error) }));
  }
});

async function restartAuthority(root: string, runIds: string[], manager: Awaited<ReturnType<typeof nativeRemoteManager>>) {
  const { state: { instanceId }, remote: { supervisorCreds } } = manager;
  const renewedSupervisor = () => (manager.manager as unknown as { credentialRenewal: { remoteSupervisorCreds?: string } }).credentialRenewal.remoteSupervisorCreds;
  const entry = fileURLToPath(new URL("../../../bin/dist/cotal.js", import.meta.url));
  const cli = (args: string[]) => new Promise<{ code: number | string; text: string }>((resolve) => {
    execFile(process.execPath, [entry, ...args, "--space", a.space, "--on", instanceId], { cwd: root, timeout: 15_000 }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, text: `${stdout}${stderr}`.trim() });
    });
  });
  const probe = () => Promise.all(runIds.map(runId => cli(["run", "show", runId, "--json"])));
  const baseline = await probe();
  assert.ok(baseline.every(result => result.code === 0), `run show must answer before the restart: ${baseline.find(result => result.code !== 0)?.text}`);
  const { renewAt, exp } = inspectCredHealth(supervisorCreds);
  assert.ok(renewAt && exp);
  await wait(Math.max(0, renewAt * 1000 - Date.now() - 1_000));
  outageStart = Date.now();
  const restoredAt = outageStart + outageMs;
  console.log(`authority restart: ${outageMs}ms outage, original supervisor expires ${exp * 1000 - restoredAt}ms from restoration`);
  let firstStatus: number | undefined;
  let adoption: number | undefined;
  let duringRefusal: string | undefined;
  while (Date.now() < restoredAt + 12_000) {
    const at = Date.now() - restoredAt;
    const [results, managerStatus] = await Promise.all([probe(), at < -10_000 ? cli(["ps", "--json"]) : undefined]);
    if (managerStatus) assert.equal(managerStatus.code, 0, `Manager ps must still answer: ${managerStatus.text}`);
    const allOk = results.every(result => result.code === 0);
    if (at < -10_000 && !allOk) duringRefusal ??= results.find(result => result.code !== 0)?.text;
    if (at >= 0 && allOk) firstStatus ??= Date.now() - restoredAt;
    if (renewedSupervisor() !== supervisorCreds) adoption ??= Date.now() - restoredAt;
    console.log(`run show at ${at}ms from authority restoration: ${results.map(result => result.code).join(",")}${allOk ? "" : ` ${results.find(result => result.code !== 0)?.text}`}`);
    if (firstStatus !== undefined && adoption !== undefined) break;
    await wait(1_000);
  }
  console.log("standing renewal HTTP results (ms from restoration):", standingRequests.map(row => [row.at - restoredAt, row.status]));
  assert.ok(standingRequests.some(row => row.status === 503), "scheduled renewal must hit the restart");
  assert.match(duringRefusal ?? "", /"cause":\{"code":"unavailable"\}/, "the outage must return a retryable native code");
  assert.match(duringRefusal ?? "", /retry the read in a few seconds/);
  const renewed = standingRequests.find(row => row.at >= restoredAt && row.status === 200);
  assert.ok(renewed && renewed.at - restoredAt < 8_000, "standing renewal must retry within 8 seconds of restoration");
  assert.ok(adoption !== undefined && adoption >= 0 && adoption < 10_000, `standing family adoption after authority restoration: ${adoption}ms`);
  assert.ok(firstStatus !== undefined && firstStatus < 10_000, `run show recovery after authority restoration: ${firstStatus}ms`);
  console.log(`PASS Manager adopted the renewed family within ${adoption}ms and all three run-status reads recovered within ${firstStatus}ms of authority restoration`);
}
async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${service!.url}${path}`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${service!.cap}` }, body: JSON.stringify(body) });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${result.error ?? "refused"}`);
  return result;
}
try {
  await setupSpaceStreams({ servers: fx.servers, space: a.space, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
  delivery = await bootDeliveryDaemon({ space: a.space, servers: fx.servers, auth: a.auth, reloadStoreIdentity: a.store.identity });
  service = await startAuthService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() },
    space: a.space, servers: fx.servers, stateDir, store: a.store, storeIdentity: a.store.identity,
    publicFace: { port: 0, trustedProxy: false }, standingRenewableTtlSeconds: Number(process.env.F_STANDING_TTL ?? 128) });
  const root = join(fx.dir, "keyed-manager"); mkdirSync(root);
  await new Promise<void>(resolve => edge.listen(0, "127.0.0.1", resolve));
  const edgeUrl = `http://127.0.0.1:${(edge.address() as AddressInfo).port}`;
  const dir = userAuthStateDir(root, a.space);
  const store = workspaceSecretStore(root);
  mkdirSync(dir, { recursive: true });
  const sentinel = join(dir, "sentinel.creds");
  writeFileSync(sentinel, a.sentinelCreds, { mode: 0o600 });
  recordMesh({ space: a.space, server: fx.servers, root, mode: "user", origin: "manual", policy: { events: "required" },
    userAuth: { provider: "cotal", remote: true, idp: { url: `${origin}/api/auth`, issuer: origin, audience: origin }, endpoints: { url: edgeUrl }, sentinelCredsPath: sentinel }, ts: new Date().toISOString() });
  saveIdpSession(homeCotalDir(), `${origin}/api/auth`, { token: "fixture-session", expiresAt: Math.floor(Date.now() / 1000) + 600, sub: "keyed-human" });
  remote = await nativeRemoteManager({ space: a.space, servers: fx.servers, root, exchangeUrl: service.publicUrl!, execution: "runtime", runtime: "pty",
    call: async request => {
      if (request.kind === "manager-run-submission") keyedHostCalls++;
      if (request.kind === "manager-run-admission") legacyHostAdmissions++;
      if (request.operation === "renewStandingBundle") return cotalAuthProvider.managerServiceAuthority!({ store, dir, request });
      if (request.kind === "manager-run-attempt") return cotalAuthProvider.requestRemoteRunAttempt!({ store, dir, request });
      return post("/manager-service-authority", { idpToken, request });
    } });
  assert.equal(remote.owner, owner);
  async function dial() {
    const exchange = await post<{ token: string }>("/exchange", { idpToken, actor: "cli", view: "manager-caller", managerInstanceId: remote!.state.instanceId });
    const nonce = mintLifecycleUid();
    const nc = await connect({ servers: fx.servers,
      authenticator: [credsAuthenticator(new TextEncoder().encode(a.sentinelCreds)), tokenAuthenticator(exchange.token)],
      name: nonce, inboxPrefix: `_INBOX_${nonce}`, maxReconnectAttempts: 0, timeout: 5000 });
    connections.push(nc);
    const caller = await issuedUserCaller(nc, a.space, nonce, { owner, actor: "cli", uid: cli.lifecycleUid! });
    const selected = await resolveService(nc, a.space, "manager", caller, { instanceId: remote!.state.instanceId, deadlineMs: 10_000 });
    return { nc, caller, selected };
  }
  const d = await dial(), source = { source: 'log("signerless keyed native");', file: "signerless-keyed.cotal.js" };
  const submission = prepareKeyedRunSubmission(a.space, d.selected, mintLifecycleUid(), source);
  const results = await Promise.all(Array.from({ length: 4 }, () => invokeKeyedRunSubmission(d.nc, a.space, submission, { deadlineMs: 30_000 })));
  const runId = results[0]!.runId!;
  assert.equal(new Set(results.map(r => r.runId)).size, 1);
  assert.equal((await readKeyedRunSubmission(d.nc, a.space, submission, { deadlineMs: 5000 })).runId, runId);
  assert.equal(legacyHostAdmissions, 0); assert.ok(keyedHostCalls >= 5);
  console.log("PASS actual signerless manager forwards only keyed HTTP protocol and original caller native issued evidence binds one run");
  let completed = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const status = await invokeCommand(d.nc, a.space, d.selected, "run-status", { runId }, { deadlineMs: 5000 });
    assert.equal(status.reply.ok, true);
    if ((status.reply.data as { status?: { state: string } }).status?.state === "completed") { completed = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(completed); console.log("PASS actual signerless driver completes harmless run with no locally held account signer or model seat");
  // Fresh exchange is a new generation, not authority to take over the original reservation.
  const fresh = await dial(); assert.notEqual(fresh.caller.generation, d.caller.generation);
  const freshSameId = prepareKeyedRunSubmission(a.space, fresh.selected, submission.submissionId, source);
  await assert.rejects(invokeKeyedRunSubmission(fresh.nc, a.space, freshSameId, { deadlineMs: 5000 }));
  assert.equal((await readKeyedRunSubmission(d.nc, a.space, submission, { deadlineMs: 5000 })).runId, runId);
  console.log("PASS fresh issued generation cannot adopt the original binding, original exact pinned read remains stable");
  const runIds = [runId];
  for (let n = 0; n < 2; n++) {
    const next = await invokeKeyedRunSubmission(d.nc, a.space, prepareKeyedRunSubmission(a.space, d.selected, mintLifecycleUid(), source), { deadlineMs: 30_000 });
    assert.ok(next.runId);
    runIds.push(next.runId);
  }
  await restartAuthority(root, runIds, remote);
  console.log(JSON.stringify({ scope: "owned native signerless Manager + actual auth HTTP/encrypted callout + driver, not Cloud/webhook/deployment",
    instanceId: remote.state.instanceId, epoch: remote.epoch, submissionId: submission.submissionId, runId, keyedHostCalls, legacyHostAdmissions,
    modelSeats: 0 }));
} finally {
  const errors: unknown[] = [];
  for (const close of [...connections.map(nc => () => nc.close()), () => remote?.manager.stop(), () => service?.close(), () => delivery?.stop(),
    () => edge.listening ? new Promise<void>(resolve => edge.close(() => resolve())) : undefined,
    () => new Promise<void>((resolve, reject) => idp.close(error => error ? reject(error) : resolve())), () => fx.stopBroker()]) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  console.log(JSON.stringify({ cleanup: errors.length ? "failed" : "complete", retainedScratch: fx.dir, scope: "owned signerless fixture only" }));
  if (previousHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = previousHome;
  if (errors.length) throw new AggregateError(errors, "owned signerless fixture cleanup failed");
}
emitSentinel({ passed: counted.cells(), failed: 0 });
