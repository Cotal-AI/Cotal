/** Remaining acceptance: real signerless native manager, auth HTTP, encrypted broker callout,
 * issuer-observed keyed submission and actual seatless driver. Review reproduction only. No model seats or Cloud. */
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
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { connect, credsAuthenticator, tokenAuthenticator } from "@nats-io/transport-node";
import {
  mintCreds, newIdentity, mintLifecycleUid, setupSpaceStreams, issuedUserCaller, resolveService,
  prepareKeyedRunSubmission, invokeKeyedRunSubmission, readKeyedRunSubmission, invokeCommand, epRequestSubject,
} from "@cotal-ai/core";
import {
  deriveOwnerForIdpSubject, ensurePinnedIdp, grantActor, loadOwnerSecret, startAuthService,
  type AuthServiceHandle,
} from "../src/index.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import { nativeRemoteManager } from "../../manager/smoke/_native-remote-manager.js";
import { bootDeliveryDaemon } from "../../manager/smoke/_boot-delivery.js";
import "../../runtime/src/index.js";

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
let keyedHostCalls = 0, legacyHostAdmissions = 0;
async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${service!.url}${path}`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${service!.cap}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(12_000) });
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
  // Publish JSON directly through the ACTUAL freshly issued caller. The helper refuses this
  // before publish, but broker rights also permit a caller that writes its own valid envelope.
  const command = d.selected.commands.get("run-start-keyed")!;
  const subject = epRequestSubject(a.space, { route: { mode: "inst", instanceId: remote.state.instanceId },
    endpoint: "manager", command: "run-start-keyed", caller: d.caller, nonce: mintLifecycleUid() });
  const malformed = { v: 1, id: mintLifecycleUid(), class: "ephemeral", replyExpected: true, deadlineMs: 5000,
    op: { endpoint: "manager", command: "run-start-keyed", inputDigest: command.contract.input.closureDigest,
      outputDigest: command.contract.output.closureDigest },
    bind: { instanceId: remote.state.instanceId, epoch: remote.epoch },
    from: { id: `${d.caller.owner}.${d.caller.actor}`, name: d.caller.actor }, args: { source: "\ud800" } };
  const readerErrors: string[] = [], originalLog = console.log;
  console.log = (...values: unknown[]) => {
    if (values[0] === "reader closed") readerErrors.push(String(values[1]));
    originalLog(...values);
  };
  let valid: unknown;
  try {
    d.nc.publish(subject, new TextEncoder().encode(JSON.stringify(malformed))); await d.nc.flush();
    await new Promise(resolve => setTimeout(resolve, 200));
    try { valid = await invokeCommand(d.nc, a.space, d.selected, "run-start", source, { deadlineMs: 5000 }); }
    catch (error) { valid = { thrown: String(error) }; }
    console.log(JSON.stringify({ cell: "K3", processAlive: true, readerErrors, validLegacyResult: valid,
      keyedHostCalls, legacyHostAdmissions, malformedSubject: subject,
      scope: "ACTUAL issuer shared observation subscription and native signerless manager, no callback wrapper" }));
  } finally { console.log = originalLog; }
  assert.equal(readerErrors.length, 0, "malformed keyed observation must not end the actual issuer connection reader");
  assert.equal((valid as any)?.reply?.ok, true, "subsequent valid legacy start must still be admitted");

} finally {
  const errors: unknown[] = [];
  for (const close of [...connections.map(nc => () => nc.close()), () => remote?.manager.stop(), () => service?.close(), () => delivery?.stop(),
    () => new Promise<void>((resolve, reject) => idp.close(error => error ? reject(error) : resolve())), () => fx.stopBroker()]) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  console.log(JSON.stringify({ cleanup: errors.length ? "failed" : "complete", retainedScratch: fx.dir, scope: "owned signerless fixture only" }));
  if (errors.length) throw new AggregateError(errors, "owned signerless fixture cleanup failed");
}
