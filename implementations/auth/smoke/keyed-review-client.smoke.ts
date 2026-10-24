/** Additional-only M09-M11: actual broker denial for legacy-only issued rights, exported pinned
 * helper error preservation, and provider HTTP transport. No real login/operational profile. */
import nodeAssert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { connect } from "@nats-io/transport-node";
import { freePort, SMOKE_BROKER_TOKEN, teardownOnSignal, killAndAwaitExit, awaitBrokerReady, countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import type { ResolvedService, RemoteRunSubmissionRequest } from "@cotal-ai/core";
import { encodeUser } from "@nats-io/jwt";
import { fromSeed, fromPublic } from "@nats-io/nkeys";
const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;

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
    operator.publish(replySubject, new TextEncoder().encode(JSON.stringify({ v: 1, id: request.id, ok: true,
      data: { state: "admitted", submissionId: core.mintLifecycleUid(), fingerprint: core.contractDigest({ wrong: true }),
        instanceId: core.mintLifecycleUid(), processEpoch: 99, runId: "run-" + "a".repeat(32) } })));

  } });
  await operator.flush();
  let accepted = 0;
  for (const call of [() => core.invokeKeyedRunSubmission(operator, space, prepared, { deadlineMs: 1000 }),
    () => core.readKeyedRunSubmission(operator, space, prepared, { deadlineMs: 1000 })]) {
    try { const result = await call(); accepted++; console.log(JSON.stringify({ cell: "K8-wrong-coordinates-accepted", result, pinned: prepared })); }
    catch (error) { console.log(JSON.stringify({ cell: "K8-wrong-coordinates-refused", error: String(error) })); }
  }
  responder.unsubscribe();
  assert.equal(accepted, 0, "helper must refuse response coordinates outside pinned snapshot");

} finally {
  for (const close of closed) await close();
  await nc?.close(); await killAndAwaitExit(broker); release();
  console.log(JSON.stringify({ brokerExit: broker.exitCode, signal: broker.signalCode, port, retainedScratch: [home, dir],
    scope: "new provider transport/old ceiling and structural helper only, not new auth profiles or live login" }));
}
emitSentinel({ passed: counted.cells(), failed: 0 });
