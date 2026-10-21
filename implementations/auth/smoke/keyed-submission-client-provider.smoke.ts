/** Additional-only M09-M11: actual broker denial for legacy-only issued rights, exported pinned
 * helper error preservation, and provider HTTP transport. No real login/operational profile. */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { connect } from "@nats-io/transport-node";
import { freePort, SMOKE_BROKER_TOKEN, teardownOnSignal, killAndAwaitExit, awaitBrokerReady } from "@cotal-ai/smoke-kit";
import type { ResolvedService, RemoteRunSubmissionRequest } from "@cotal-ai/core";
import { encodeUser } from "@nats-io/jwt";
import { fromSeed, fromPublic } from "@nats-io/nkeys";

const home = mkdtempSync(join(tmpdir(), "keyed-client-home-"));
process.env.COTAL_HOME = home;
const core = await import("@cotal-ai/core");
const workspace = await import("@cotal-ai/workspace");
const { cotalAuthProvider } = await import("../src/provider.js");
const { saveIdpSession } = await import("../src/login.js");
const { ensurePinnedIdp, ensureCalloutAuth, saveAuthServiceInfo } = await import("../src/store.js");
const { MemoryStore } = await import("./_hosted-auth-fixture.js");

// A described snapshot contains validated contracts in production. This fixture constructs the
// public shape only to isolate helper propagation, not to claim digest-verified native Describe.
const id = core.newIdentity(), uid = core.mintLifecycleUid(), generation = core.mintGeneration();
const caller = { owner: "local", actor: id.id, uid, generation }, instanceId = core.mintLifecycleUid();
const digest = core.contractDigest({ empty: true });
const contract = { input: { closureDigest: digest, validate: () => true }, output: { closureDigest: digest, validate: () => true } };
const service = { endpoint: "manager", caller, responder: { endpoint: "manager", instanceId, epoch: 0 },
  pinnedInstanceId: instanceId, commands: new Map(["run-start-keyed", "run-submission-status"].map(name => [name, { name, class: "ephemeral", contract }]))
} as unknown as ResolvedService;
const prepared = core.prepareKeyedRunSubmission("client-cells", service, core.mintLifecycleUid(), { source: "log(1);" });
if (!process.env.KEYED_REMAINING_EDGES_ONLY) {
await assert.rejects(core.invokeKeyedRunSubmission({} as never, "client-cells", JSON.parse(JSON.stringify(prepared)), { deadlineMs: 50 }), /prepared/);
await assert.rejects(core.readKeyedRunSubmission({} as never, "client-cells", JSON.parse(JSON.stringify(prepared)), { deadlineMs: 50 }), /pinned support/);
console.log("PASS exported helper rejects serialized structural handle before any broker access, no persisted restart recovery implied");
}

const port = await freePort(), servers = `nats://127.0.0.1:${port}`, space = "client-cells";
assert.notEqual(port, 4222);
const auth = await core.createSpaceAuth(space), dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const { writeFileSync } = await import("node:fs");
writeFileSync(join(dir, "server.conf"), core.serverConfig(auth, [auth], { host: "127.0.0.1", port,
  transport: { kind: "plaintext" }, storeDir: join(dir, "js") }), { mode: 0o600 });
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const release = teardownOnSignal(broker);
let nc: Awaited<ReturnType<typeof connect>> | undefined;
const closed: Array<() => Promise<void>> = [];
try {
  await awaitBrokerReady(() => core.isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  await core.setupSpaceStreams({ servers, space, creds: await core.mintCreds(auth, core.newIdentity(), "provisioner") });
  if (!process.env.KEYED_REMAINING_EDGES_ONLY) {
  const issued = { generation, acceptedToken: core.mintAcceptedToken() };
  const creds = await core.withIssuerSession({ servers, space, auth, tls: false }, s => core.mintCreds(auth, id, "agent", {
    lifecycleUid: uid, expiresInSeconds: 300, issued, endpointCapabilities: [
      { endpoint: "manager", command: "run-start", instanceId, instanceOnly: true },
    ], issuance: { mode: "issue", store: s.store, accepted: s.accepted, sources: [] },
  }));
  for (let reconnect = 0; reconnect < 2; reconnect++) {
    nc = await connect({ servers, ...core.standaloneConnectOpts({ creds, tls: false }), reconnect: false });
    await assert.rejects(core.invokeKeyedRunSubmission(nc, space, prepared, { deadlineMs: 1000 }), error =>
      error instanceof core.EpEnvelopeError && error.code === "permission-denied" && error.outcome === "not-executed");
    await nc.close();
  }
  console.log("PASS actual old legacy-only issued ceiling cannot publish keyed start, reconnect does not gain new command rights");
  }
  // Public helper + real native RPC, but synthetic contract validators and responder. This is
  // an error-propagation regression, not native serving-grant or Describe acceptance.
  const requestPattern = `cotal.${space}.ep.v1.inst.manager.${instanceId}.*.>`;
  const fixtureIdentity = core.newIdentity();
  const jwt = await encodeUser("owned-keyed-error-responder", fromPublic(fixtureIdentity.id), fromPublic(auth.account.pub), {
    pub: { allow: [requestPattern, core.epResponderIssuedReplyPattern(space, "manager", instanceId, 0)] },
    sub: { allow: [requestPattern, core.epCallerReplyFilter(space, caller)] },
  }, { signer: fromSeed(new TextEncoder().encode(auth.account.signingSeed)), exp: Math.floor(Date.now() / 1000) + 60 });
  const operator = await connect({ servers, ...core.standaloneConnectOpts({ creds: core.credsFromJwt(jwt, fixtureIdentity), tls: false }), reconnect: false });
  closed.push(() => operator.close());
  const responder = operator.subscribe(requestPattern, { callback: (error, msg) => {
    if (error || !msg?.subject) return;
    const parsed = core.parseEpSubject(msg.subject); if (!parsed || parsed.plane !== "request") return;
    const request = JSON.parse(new TextDecoder().decode(msg.data));
    const replySubject = core.epReplySubject(space, { endpoint: "manager", instanceId, epoch: 0, caller: parsed.caller, nonce: parsed.nonce });
    operator.publish(replySubject, new TextEncoder().encode(JSON.stringify({ v: 1, id: request.id, ok: false,
      error: { code: "unavailable", message: "owned reconcile hold", outcome: "unknown", details: [{ kind: "ai.cotal.keyed.held", retained: true }] } })));
  } });
  await operator.flush();
  for (const call of [() => core.invokeKeyedRunSubmission(operator, space, prepared, { deadlineMs: 1000 }),
    () => core.readKeyedRunSubmission(operator, space, prepared, { deadlineMs: 1000 })]) {
    await assert.rejects(call(), error => error instanceof core.EpEnvelopeError && error.code === "unavailable"
      && error.outcome === "unknown" && error.details?.[0]?.kind === "ai.cotal.keyed.held");
  }
  responder.unsubscribe();
  console.log("PASS exported helper preserves native responder unknown outcome and held details through real RPC with synthetic contract/responder");

  let mode: "ok" | "redirect" | "invalid" | "denied" = "ok", posts = 0, tokens = 0;
  const transport = createServer(async (req, res) => {
    if (req.url === "/api/auth/token") { tokens++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ token: "owned-idp-jwt" })); return; }
    assert.equal(req.url, "/manager-service-authority"); posts++;
    let body = ""; for await (const chunk of req) body += chunk;
    const sent = JSON.parse(body); assert.equal(sent.idpToken, "owned-idp-jwt"); assert.equal(sent.request.kind, "manager-run-submission");
    if (mode === "redirect") { res.statusCode = 307; res.setHeader("location", "/never-follow"); res.end(); }
    else if (mode === "invalid") { res.setHeader("content-type", "text/plain"); res.end("not-json"); }
    else if (mode === "denied") { res.statusCode = 403; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: "owned unknown authority hold" })); }
    else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ marker: "verbatim-return-caller-validates" })); }
  });
  await new Promise<void>(resolve => transport.listen(0, "127.0.0.1", resolve));
  closed.push(() => new Promise<void>((resolve, reject) => transport.close(e => e ? reject(e) : resolve())));
  const origin = `http://127.0.0.1:${(transport.address() as import("node:net").AddressInfo).port}`;
  const store = new MemoryStore({ kind: "injected", coordinate: "keyed-provider-edges" });
  await ensureCalloutAuth(store, { space, operatorSeed: auth.operator.seed!, accountPub: auth.account.pub });
  const state = join(home, "auth"); ensurePinnedIdp(state, `${origin}/api/auth`);
  saveAuthServiceInfo(state, { url: origin, pid: process.pid, cap: "owned-local-cap" });
  saveIdpSession(workspace.homeCotalDir(), `${origin}/api/auth`, { token: "owned-synthetic-session", expiresAt: Math.floor(Date.now() / 1000) + 60 });
  const request = { space, kind: "manager-run-submission" } as RemoteRunSubmissionRequest;
  const send = () => cotalAuthProvider.requestRemoteRunSubmission!({ store, dir: state, request });
  assert.deepEqual(await send(), { marker: "verbatim-return-caller-validates" });
  mode = "redirect"; await assert.rejects(send(), /redirects are refused/);
  mode = "invalid"; await assert.rejects(send(), /could not be read as JSON/);
  mode = "denied"; await assert.rejects(send(), /owned unknown authority hold/);
  assert.equal(posts, 4); assert.equal(tokens, 4);
  console.log("PASS actual provider HTTP uses exact new request once, fresh IdP per call, no redirect/invalid JSON/refusal fallback");
} finally {
  for (const close of closed) await close();
  await nc?.close(); await killAndAwaitExit(broker); release();
  console.log(JSON.stringify({ brokerExit: broker.exitCode, signal: broker.signalCode, port, retainedScratch: [home, dir],
    scope: "new provider transport/old ceiling and structural helper only, not new auth profiles or live login" }));
}
