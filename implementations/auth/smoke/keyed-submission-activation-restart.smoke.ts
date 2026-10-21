/** Additional-only activation debt and restart: real signerless manager, auth HTTP, encrypted broker callout,
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
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { connect, credsAuthenticator, tokenAuthenticator } from "@nats-io/transport-node";
import {
  mintCreds, newIdentity, mintLifecycleUid, setupSpaceStreams, issuedUserCaller, resolveService,
  prepareKeyedRunSubmission, invokeKeyedRunSubmission, readKeyedRunSubmission, invokeCommand,
} from "@cotal-ai/core";
import {
  deriveOwnerForIdpSubject, ensurePinnedIdp, grantActor, loadOwnerSecret, startAuthService,
  type AuthServiceHandle,
} from "../src/index.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import { nativeRemoteManager } from "../../manager/smoke/_native-remote-manager.js";
import { bootDeliveryDaemon } from "../../manager/smoke/_boot-delivery.js";
import "../../runtime/src/index.js";
const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;

const fx = await startHostedAuthFixture("keyed-native", 1), a = fx.accounts[0]!;
const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(publicKey), kid: "keyed-idp", alg: "EdDSA" };
const idp = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); });
await new Promise<void>(resolve => idp.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(idp.address() as import("node:net").AddressInfo).port}`;
const stateDir = join(fx.dir, "keyed-auth-state"); mkdirSync(stateDir);
ensurePinnedIdp(stateDir, `${origin}/api/auth`);
const owner = deriveOwnerForIdpSubject((await loadOwnerSecret(a.store, a.space))!, origin, "keyed-human");
const cli = grantActor(stateDir, { owner, actor: "cli", scope: ["run", "supervise"], allowSubscribe: [], allowPublish: [] });
const idpToken = await new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: "keyed-idp" })
  .setSubject("keyed-human").setIssuer(origin).setAudience(origin).setIssuedAt().setExpirationTime("10m").sign(privateKey);
let service: AuthServiceHandle | undefined;
let remote: Awaited<ReturnType<typeof nativeRemoteManager>> | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
const connections: Awaited<ReturnType<typeof connect>>[] = [];
let keyedHostCalls = 0, legacyHostAdmissions = 0, attemptCalls = 0;
let rejectAttempt = true;
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
    publicFace: { port: 0, trustedProxy: false } });
  const root = join(fx.dir, "keyed-manager"); mkdirSync(root);
  remote = await nativeRemoteManager({ space: a.space, servers: fx.servers, root, exchangeUrl: service.publicUrl!, execution: "runtime", runtime: "pty",
    call: async request => {
      if (request.kind === "manager-run-submission") keyedHostCalls++;
      if (request.kind === "manager-run-admission") legacyHostAdmissions++;
      if (request.kind === "manager-run-attempt" && request.attempt) { attemptCalls++; if (rejectAttempt) throw new Error("owned transport refuses first driver issuance"); }
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
  await assert.rejects(invokeKeyedRunSubmission(d.nc, a.space, submission, { deadlineMs: 10_000 }), /owned transport|driver|issuance/);
  assert.equal(attemptCalls, 1); rejectAttempt = false;
  const held = await readKeyedRunSubmission(d.nc, a.space, submission, { deadlineMs: 5000 });
  assert.equal(held.state, "admitted"); assert.ok(held.runId);
  const duplicate = await invokeKeyedRunSubmission(d.nc, a.space, submission, { deadlineMs: 5000 });
  assert.equal(duplicate.runId, held.runId); assert.equal(duplicate.state, "admitted"); assert.equal(attemptCalls, 1);
  console.log("PASS actual signerless driver issuance failure leaves original admitted activation debt, duplicate never launches or repairs");
  const previousEpoch = remote.epoch;
  await remote.manager.stop();
  // Actual same identity/root registration restart. No operational peer or production controls.
  remote = await nativeRemoteManager({ space: a.space, servers: fx.servers, root, exchangeUrl: service.publicUrl!, execution: "runtime", runtime: "pty",
    call: async request => {
      if (request.kind === "manager-run-submission") keyedHostCalls++;
      if (request.kind === "manager-run-admission") legacyHostAdmissions++;
      if (request.kind === "manager-run-attempt" && request.attempt) attemptCalls++;
      return post("/manager-service-authority", { idpToken, request });
    } });
  assert.ok(remote.epoch > previousEpoch);
  await assert.rejects(readKeyedRunSubmission(d.nc, a.space, submission, { deadlineMs: 5000 }));
  const current = await resolveService(d.nc, a.space, "manager", d.caller, { instanceId: remote.state.instanceId, deadlineMs: 10_000 });
  const forbiddenRepin = prepareKeyedRunSubmission(a.space, current, submission.submissionId, source);
  await assert.rejects(invokeKeyedRunSubmission(d.nc, a.space, forbiddenRepin, { deadlineMs: 5000 }));
  assert.equal(attemptCalls, 1); assert.equal(legacyHostAdmissions, 0);
  console.log("PASS actual same-instance restart advances epoch, old pinned read and explicit repin cannot adopt or launch original admitted debt");
  console.log(JSON.stringify({ scope: "additional-only actual signerless activation debt and manager restart, no successful run rerun",
    instanceId: remote.state.instanceId, oldEpoch: previousEpoch, newEpoch: remote.epoch, submissionId: submission.submissionId,
    runId: held.runId, keyedHostCalls, attemptCalls, legacyHostAdmissions, modelSeats: 0 }));
} finally {
  const errors: unknown[] = [];
  for (const close of [...connections.map(nc => () => nc.close()), () => remote?.manager.stop(), () => service?.close(), () => delivery?.stop(),
    () => new Promise<void>((resolve, reject) => idp.close(error => error ? reject(error) : resolve())), () => fx.stopBroker()]) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  console.log(JSON.stringify({ cleanup: errors.length ? "failed" : "complete", retainedScratch: fx.dir, scope: "owned signerless fixture only" }));
  if (errors.length) throw new AggregateError(errors, "owned signerless fixture cleanup failed");
}
emitSentinel({ passed: counted.cells(), failed: 0 });
