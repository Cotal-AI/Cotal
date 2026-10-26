/** Retirement diagnostics through the built Manager's public spawn and real endpoint rails.
 * Provisioning and host release are fixture callbacks. The connector throws before any seat starts.
 * The broker, contract publication, discovery, invocation and detached rollback chain are real. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  AUTH_ENDPOINT, DEV_OWNER, EpEnvelopeError, contractArtifactCanonicalBytes, contractDigest,
  contractStoreContext, createEndpointStreams, createSpaceAuth, endpointRegistrationBarrier,
  epAuthBucket, isReachable, managedRetirementOpId, mintCreds, mintLifecycleUid, newIdentity,
  openRecordsBucket, principalKey, provisionEndpointGateOpen, publishContractArtifact,
  registerServingInstance, remoteManagerActors, registry, serveEndpoint, CotalEndpoint, resolveService,
} from "@cotal-ai/core";
import { Manager, type ManagerOptions } from "@cotal-ai/manager";
import { authClusterArtifacts, authCommandDefs, authContractArtifactValues } from "../../auth/src/auth-service-contract.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

const root = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}retirement-copy-`));
// Retain the private fixture root for failure diagnosis. No operator home or mesh is consulted.
for (const key of Object.keys(process.env))
  if (key.startsWith("COTAL_") || key.startsWith("JCODE_COTAL_")) delete process.env[key];
process.env.HOME = join(root, "home");
process.env.COTAL_HOME = join(root, "home");
process.env.XDG_CONFIG_HOME = join(root, "config");
mkdirSync(process.env.HOME, { recursive: true });
const workspaceRoot = join(root, "workspace");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
writeFileSync(join(workspaceRoot, ".cotal", "agents", "worker.md"), "---\nname: worker\n---\n");
registry.register({ kind: "connector", name: "retirement-copy", requires: ["node"],
  buildLaunch: () => { throw new Error("fixture launch refused after provisioning"); } });
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const space = "retirement-copy";
const broker = spawn("nats-server", ["-js", "-sd", join(root, "js"), "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, root);
let nc: NatsConnection | undefined;
let serving: ReturnType<typeof serveEndpoint> | undefined;
let endpoint: CotalEndpoint | undefined;
const originalError = console.error;
const lines: string[] = [];
console.error = (...args: unknown[]) => { const line = args.map(String).join(" "); lines.push(line); originalError(line); };
let passed = 0, failed = 0;
async function cell(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; originalError(`  ✗ FAIL: ${name}`, error); }
}
const owner = `u_${"a".repeat(26)}`;
type Target = { id: string; name: string; lifecycleUid: string };
type Hold = { opId: string; owner: string; actor: string; target: Target; startedAt: number; lastError?: string };
type Internals = {
  ep: CotalEndpoint; userMode: boolean; managerInstanceId: string; managerServeIdentity: ReturnType<typeof newIdentity>;
  serviceServe: { grant: { epoch: number } }; servers: string;
  retiring: Map<string, Hold>; confirmedRetiredPredecessors: Map<string, unknown>;
  provisionUserAgent(name: string, opts: { lifecycleUid: string }): Promise<unknown>;
  deprovisioningFlight: Map<string, Promise<void>>; lifecycleInFlight: number;
};
const expired = "the responder answered at a stale epoch";
const denied = "the serve issuance gate belongs to another principal; retirement was a full no-op";
let answer: "expired" | "denied" | "ok" = "expired";
const invoked: Array<{ uid: string; opId: unknown }> = [];
const mappings = new Map<string, string>();
let beforeAnswer: (() => void) | undefined;
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  nc = await connect({ servers });
  await createEndpointStreams(await jetstreamManager(nc), new Kvm(nc), space);
  const records = await openRecordsBucket(nc, space);
  const authKv = await new Kvm(nc).open(epAuthBucket(space));
  const artifacts = authClusterArtifacts();
  const values = [...authContractArtifactValues(), artifacts.document, artifacts.manifest];
  const store = await contractStoreContext(nc, space);
  const byDigest = new Map(values.map((value) => [contractDigest(value), value]));
  for (const value of values) await publishContractArtifact(store, contractArtifactCanonicalBytes(value));
  const instanceId = mintLifecycleUid();
  await provisionEndpointGateOpen(authKv, { endpoint: AUTH_ENDPOINT, instanceId, principal: `${DEV_OWNER}.auth` });
  const { grant } = await registerServingInstance(records, {
    space, spec: { endpoint: AUTH_ENDPOINT, owner: DEV_OWNER, clusterDigests: [artifacts.closureDigest], protocol: { v: 1 } },
    instanceId, registrant: { owner: DEV_OWNER }, authority: { authorize: () => ({ authorized: true, revision: 0 }) },
    barrier: endpointRegistrationBarrier(authKv, space, { endpoint: AUTH_ENDPOINT, instanceId, opId: mintLifecycleUid() }),
    readClusterArtifact: (digest) => byDigest.get(digest),
  });
  serving = serveEndpoint(nc, space, grant, authCommandDefs({ retireLifecycle: (ctx) => {
    const uid = ctx.request.target!.lifecycleUid;
    const args = ctx.request.args as { opId: string };
    invoked.push({ uid, opId: args.opId });
    beforeAnswer?.();
    if (answer !== "ok") throw new EpEnvelopeError(answer === "expired" ? "expired" : "permission-denied", answer === "expired" ? expired : denied);
    return { retired: true, lifecycleUid: uid, opId: args.opId, evictedPrincipals: [] };
  } }), { public: true }, { resolveTarget: (target) => {
    const lifecycleUid = mappings.get(`${target.owner}.${target.actor}`);
    return lifecycleUid === undefined ? undefined : { lifecycleUid };
  } });
  await nc.flush();
  await resolveService(nc, space, AUTH_ENDPOINT, { owner, actor: "fixture", uid: mintLifecycleUid() }, { deadlineMs: 3000 });
  console.log("native auth discovery positive control passed");
  endpoint = new CotalEndpoint({ space, servers, channels: [], consume: false, registerPresence: false,
    card: { name: "fixture", kind: "agent" } });
  await endpoint.start();
  const auth = await createSpaceAuth(space);
  const identities = { supervisor: newIdentity(), executor: newIdentity(), serve: newIdentity(), goalWriter: newIdentity(), sessionLedger: newIdentity() };
  const managerUid = mintLifecycleUid();
  const actors = remoteManagerActors(mintLifecycleUid());
  const prepared: Target[] = [];
  const remoteAuthority: NonNullable<ManagerOptions["remoteAuthority"]> = {
    owner, instanceId: mintLifecycleUid(), lifecycleUid: managerUid, identities, actors,
    supervisorCreds: "", executorCreds: "", serveCreds: "", goalWriterCreds: "", sessionLedgerCreds: "",
    serveGrant: grant, agentBearerExchangeUrl: "https://auth.example.test",
    renewExecutor: async () => { throw new Error("not used"); },
    mintSessionServing: async () => { throw new Error("not used"); },
    validateRetainedAgent: async () => { throw new Error("not used"); }, scanGoalIndex: async () => [], authorizeAdmin: async () => false,
    prepareAgentRetirement: async ({ target }) => {
      mappings.set(principalKey(target.owner, target.actor).key, target.lifecycleUid);
      prepared.push({ id: principalKey(target.owner, target.actor).key, name: target.actor, lifecycleUid: target.lifecycleUid });
    },
    mintRetirementRequester: async ({ identity, target }) => mintCreds(auth, identity, "retirement-requester", {
      retirementRequester: { owner, actor: actors.serve, uid: managerUid, target },
    }),
  };
  const manager = new Manager({ space, servers, runtime: "pty", workspaceRoot, remoteAuthority });
  const internal = manager as unknown as Internals;
  internal.ep = endpoint;
  internal.userMode = true;
  internal.managerInstanceId = remoteAuthority.instanceId;
  internal.managerServeIdentity = identities.serve;
  internal.serviceServe = { grant: { epoch: 1 } };
  const allocated: Target[] = [];
  // Fixture provisioning replaces only allocation material, never rollback or retirement methods.
  internal.provisionUserAgent = async (name, opts) => {
    allocated.push({ id: principalKey(owner, name).key, name, lifecycleUid: opts.lifecycleUid });
    return { owner, lifecycleUid: opts.lifecycleUid, files: {}, launch: { owner, actor: name, sentinelCredsPath: "", bearerCmd: [] } };
  };
  const drain = async () => {
    const end = Date.now() + 40_000;
    while ((internal.lifecycleInFlight > 0 || internal.deprovisioningFlight.size > 0) && Date.now() < end)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(internal.lifecycleInFlight, 0, "detached rollback drained");
    assert.equal(internal.deprovisioningFlight.size, 0, "no teardown remains running");
  };
  const start = () => manager.startAgent({ name: "worker", agent: "retirement-copy", events: false }, `${owner}.cli`);
  const hold = (target: Target): Hold => ({ opId: managedRetirementOpId(target.lifecycleUid), owner, actor: target.name, target, startedAt: Date.now() });
  const diagnostic = () => lines.filter((line) => /^(retire|despawn) worker:/.test(line)).at(-1)!;

  await cell("held stale-epoch retirement keeps the despawn copy and public same-name spawn re-drives it", async () => {
    const target = { id: `${owner}.worker`, name: "worker", lifecycleUid: mintLifecycleUid() };
    const held = hold(target); internal.retiring.set("worker", held);
    const reply = await start(); await drain();
    assert.equal(reply.ok, false); assert.match(reply.error!, /reserved pending retirement/);
    assert.match(diagnostic(), /^despawn worker: the despawn stopped "worker"/);
    assert.match(diagnostic(), /The name stays held.*same-name spawn re-drives/);
    assert.equal(diagnostic(), `despawn worker: ${held.lastError}`);
    assert.equal(internal.retiring.get("worker"), held);
    assert.equal(invoked.at(-1)?.uid, target.lifecycleUid);
    internal.retiring.delete("worker");
  });
  for (const mode of ["expired", "denied", "dial-refused", "ok"] as const) {
    await cell(`orphan rollback ${mode} names its lifecycle without a despawn or hold claim`, async () => {
      answer = mode === "dial-refused" ? "expired" : mode;
      internal.servers = mode === "dial-refused" ? `nats://127.0.0.1:${await freePort()}` : servers;
      lines.length = 0;
      const before = allocated.length;
      const reply = await start(); await drain();
      assert.equal(reply.ok, false); assert.match(reply.error!, /fixture launch refused after provisioning/);
      assert.equal(allocated.length, before + 1, "public spawn reached allocation rather than the hold gate");
      const target = allocated.at(-1)!;
      assert.deepEqual(prepared.at(-1), target, "orphan rollback reaches full teardown");
      assert.equal(internal.retiring.has("worker"), false);
      const line = diagnostic();
      assert.ok(line?.startsWith(`retire worker: lifecycle ${target.lifecycleUid}`), line);
      assert.doesNotMatch(line, /despawn|name stays held|same-name spawn/i);
      if (mode === "ok") assert.match(line, /retired; the name had no hold to clear/);
      else if (mode === "denied") assert.ok(line.endsWith(denied), line);
      else { assert.match(line, /could NOT be confirmed/); assert.match(line, /no hold/i); }
      if (mode !== "dial-refused") {
        assert.equal(invoked.at(-1)?.uid, target.lifecycleUid);
        assert.equal(invoked.at(-1)?.opId, managedRetirementOpId(target.lifecycleUid));
      }
    });
  }
  await cell("confirmed held retirement clears only its hold and preserves success copy", async () => {
    answer = "ok"; internal.servers = servers;
    const target = { id: `${owner}.worker`, name: "worker", lifecycleUid: mintLifecycleUid() };
    internal.retiring.set("worker", hold(target));
    const reply = await start(); await drain();
    assert.equal(reply.ok, false); assert.match(reply.error!, /reserved pending retirement/);
    assert.equal(internal.retiring.has("worker"), false);
    assert.equal(diagnostic(), "despawn worker: the agent's retirement completed; the name is free for reuse");
    assert.deepEqual(internal.confirmedRetiredPredecessors.get("worker"), { principal: target.id, lifecycleUid: target.lifecycleUid });
  });
  for (const mode of ["denied", "dial-refused"] as const) {
    await cell(`held ${mode} preserves the despawn prefix and last error`, async () => {
      answer = "denied";
      internal.servers = mode === "dial-refused" ? `nats://127.0.0.1:${await freePort()}` : servers;
      const target = { id: `${owner}.worker`, name: "worker", lifecycleUid: mintLifecycleUid() };
      const held = hold(target); internal.retiring.set("worker", held);
      try {
        const reply = await start(); await drain();
        assert.equal(reply.ok, false); assert.match(reply.error!, /reserved pending retirement/);
        assert.equal(diagnostic(), `despawn worker: ${held.lastError}`);
        if (mode === "denied") assert.equal(held.lastError, denied);
        else assert.match(held.lastError!, /The name stays held.*same-name spawn re-drives/);
        assert.equal(internal.retiring.get("worker"), held);
      } finally { internal.retiring.delete("worker"); }
    });
  }
  for (const change of ["new", "replaced", "cleared"] as const) {
    await cell(`a hold ${change} during the rail await cannot supply predecessor despawn claims`, async () => {
      answer = "expired"; internal.servers = servers;
      const target = { id: `${owner}.worker`, name: "worker", lifecycleUid: mintLifecycleUid() };
      const prior = { ...hold(target), lastError: "prior diagnostic" };
      const successor = { ...hold({ ...target, lifecycleUid: mintLifecycleUid() }), lastError: "successor diagnostic" };
      if (change !== "new") internal.retiring.set("worker", prior);
      beforeAnswer = () => {
        if (change === "cleared") internal.retiring.delete("worker");
        else internal.retiring.set("worker", successor);
      };
      try {
        await start(); await drain();
        const uid = change === "new" ? allocated.at(-1)!.lifecycleUid : target.lifecycleUid;
        assert.ok(diagnostic().startsWith(`retire worker: lifecycle ${uid}:`), diagnostic());
        assert.doesNotMatch(diagnostic(), /despawn|name stays held|same-name spawn/i);
        assert.match(diagnostic(), /No hold reserves the name for this lifecycle/);
        assert.equal(prior.lastError, "prior diagnostic");
        assert.equal(successor.lastError, "successor diagnostic");
        assert.equal(internal.retiring.get("worker"), change === "cleared" ? undefined : successor);
      } finally { beforeAnswer = undefined; internal.retiring.delete("worker"); }
    });
  }
  console.log(`retirement-copy: ${passed} passed, ${failed} failed; retained fixture ${root}`);
} finally {
  console.error = originalError;
  await endpoint?.stop();
  await serving?.stop();
  await nc?.close();
  await killAndAwaitExit(broker);
  releaseBroker();
}
process.exitCode = failed ? 1 : 0;
