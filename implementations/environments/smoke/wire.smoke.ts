/** Real broker and registered endpoint with two separately scoped caller credentials.
 * Provider effects are counted by a stand-in; tenki.live.ts covers the real provider separately. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import { freePort, teardownOnSignal, killAndAwaitExit, SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";
import {
  contractDigest, createEndpointStreams, recordsBucket, epAuthBucket, mintLifecycleUid,
  provisionEndpointGateOpen, endpointRegistrationBarrier, registerServiceInstance, authorizeServeGrant,
  readEndpointGateGeneration, serveIssuanceGateKv, epCallerGrantRows, epCall, type EpCaller,
  type EnvironmentProvisionProfile, type EnvironmentProvisionDriver,
} from "@cotal-ai/core";
import { EnvironmentService, environmentKvStore, environmentClusterArtifacts, environmentCommandDefs, serveEnvironmentEndpoint, type EnvironmentView } from "../src/index.js";

const space = "environmentwire";
const endpoint = "test.example.environments";
const caller: EpCaller = { owner: "local", actor: "caller", uid: mintLifecycleUid() };
const other: EpCaller = { owner: "local", actor: "other", uid: mintLifecycleUid() };
const caps = ["create", "inspect", "destroy"].map((command) => ({ endpoint, command }));
const scoped = (c: EpCaller) => {
  const rows = epCallerGrantRows(space, caps, c);
  return { publish: { allow: rows.pub }, subscribe: { allow: rows.sub } };
};
const directory = await mkdtemp(join(tmpdir(), SMOKE_BROKER_TOKEN));
const port = await freePort();
const config = { host: "127.0.0.1", port, jetstream: { store_dir: join(directory, "store") }, authorization: { users: [
  { user: "host", password: "test-host" },
  { user: "caller", password: "test-caller", permissions: scoped(caller) },
  { user: "other", password: "test-other", permissions: scoped(other) },
] } };
await writeFile(join(directory, "server.json"), JSON.stringify(config));
const broker = spawn("nats-server", ["-c", join(directory, "server.json")], { stdio: "ignore" });
const release = teardownOnSignal(broker, directory);
const connections: NatsConnection[] = [];
let serving: ReturnType<typeof serveEnvironmentEndpoint> | undefined;
try {
  let host: NatsConnection | undefined;
  for (let i = 0; i < 60; i++) {
    try { host = await connect({ servers: `nats://127.0.0.1:${port}`, user: "host", pass: "test-host", reconnect: false }); break; }
    catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  assert.ok(host, "authenticated test broker must start");
  connections.push(host);
  const jsm = await jetstreamManager(host);
  const kvm = new Kvm(host);
  await createEndpointStreams(jsm, kvm, space);
  const records = await kvm.open(recordsBucket(space));
  const auth = await kvm.open(epAuthBucket(space));
  const instanceId = mintLifecycleUid();
  const artifacts = environmentClusterArtifacts();
  const artifactMap = new Map(artifacts.artifacts.map((a) => [contractDigest(a), a]));
  const readClusterArtifact = (digest: string): unknown => artifactMap.get(digest);
  const authority = { authorize: (name: string, owner: string) => ({ authorized: name === endpoint && owner === "local", revision: 0 }) };
  await provisionEndpointGateOpen(auth, { endpoint, instanceId, principal: "local.host" });
  await registerServiceInstance(records, {
    space, spec: { endpoint, owner: "local", clusterDigests: [artifacts.closureDigest], protocol: { v: 1 } },
    instanceId, registrant: { owner: "local" }, authority, readClusterArtifact,
    barrier: endpointRegistrationBarrier(auth, space, { endpoint, instanceId, opId: mintLifecycleUid() }),
    observeHolderGeneration: (holder) => readEndpointGateGeneration(auth, { endpoint, instanceId: holder }),
  });
  const readProcessEpoch = async () => (await serveIssuanceGateKv(auth, space, { endpoint, instanceId }).observe())!.processEpoch;
  const grant = await authorizeServeGrant(records, { space, endpoint, instanceId, epoch: await readProcessEpoch(), holder: { owner: "local" }, authority, readClusterArtifact, readProcessEpoch });
  const privateKv = await kvm.create("environment_private", { history: 1, ttl: 0, storage: "file", allow_direct: false });
  await jsm.streams.update("KV_environment_private", { allow_rollup_hdrs: false });
  let creates = 0;
  const profile: EnvironmentProvisionProfile = { name: "wire", provider: "test", image: "immutable", resources: { cpus: 1, memoryMiB: 128, diskGiB: 5 }, maxDurationMs: 60_000, providerOptions: {} };
  const driver: EnvironmentProvisionDriver = {
    name: "test", validate() {}, close() {},
    async create() { creates++; return { kind: "test", id: "wire-provider-id" }; },
    async inspect(environment) { return { environment, state: "running", observedAt: Date.now() }; },
    async destroy() {},
  };
  const service = new EnvironmentService(await environmentKvStore(privateKv), [profile], [driver], {
    async authorize() { return true; }, async retainAndRetire() { throw new Error("private-host-diagnostic-must-not-escape"); },
  });
  const defs = environmentCommandDefs(service);
  serving = serveEnvironmentEndpoint({ connection: host, space, grant, service, cleanupIntervalMs: 60_000, report: () => {} });
  const cleanup = serving.cleanupDone;
  const c = await connect({ servers: `nats://127.0.0.1:${port}`, user: "caller", pass: "test-caller", reconnect: false });
  const o = await connect({ servers: `nats://127.0.0.1:${port}`, user: "other", pass: "test-other", reconnect: false });
  connections.push(c, o);
  await host.flush();
  const call = (nc: NatsConnection, identity: EpCaller, command: string, args: Record<string, unknown>) => epCall(nc, space, { mode: "one" }, {
    endpoint, command, contract: defs.find((d) => d.command === command)!.contract, caller: identity, args,
  }, { deadlineMs: 3000, currentEpoch: async (id) => { assert.equal(id, instanceId); return readProcessEpoch(); } });
  const args = { operationId: "wire-positive-0001", profile: profile.name, profileDigest: contractDigest(profile) };
  const first = await call(c, caller, "create", args);
  assert.equal(first.reply.ok, true);
  const view = first.reply.data as EnvironmentView;
  assert.equal(view.record.caller.actor, caller.actor);
  assert.equal(view.observation?.state, "running");
  assert.equal((await call(c, caller, "create", args)).reply.ok, true);
  assert.equal(creates, 1);
  const foreign = await call(o, other, "destroy", { id: view.record.id });
  assert.equal(foreign.reply.ok, false);
  assert.equal(foreign.reply.error?.code, "not-found");
  await assert.rejects(() => call(c, caller, "create", { ...args, caller: other }), /args|schema|additional/i);
  await assert.rejects(() => call(o, caller, "create", args), /permission|authorization/i);
  assert.equal(creates, 1, "forged subject is refused by the broker before provider effect");
  const failedCleanup = await call(c, caller, "destroy", { id: view.record.id });
  assert.equal(failedCleanup.reply.error?.code, "unavailable");
  assert.equal(failedCleanup.reply.error?.outcome, "unknown");
  assert.ok(!JSON.stringify(failedCleanup).includes("private-host-diagnostic"), "private callback diagnostics never cross the endpoint");
  await serving.stop();
  serving = undefined;
  await cleanup;
  console.log("PASS registered environment endpoint: create, replay, cross-lifecycle denial and broker-enforced sender binding");
} finally {
  await serving?.stop();
  await Promise.all(connections.map((c) => c.close()));
  await killAndAwaitExit(broker);
  release();
  await rm(directory, { recursive: true, force: true });
}
