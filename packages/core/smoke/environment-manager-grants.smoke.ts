/** Fixed environment-manager grants and gate custody over a private JWT-auth broker.
 * This exercises profile minting, native instance RPC and raw broker denials, not bootstrap
 * admission, a real manager, or provider execution. */
import nodeAssert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeUser, fmtCreds } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  authorizeServeGrant, CotalEndpoint, compileContract, contractDigest, createEndpointStreams, createSpaceAuth,
  describeEndpoint, epAuthBucket, epCall, epgateKey, endpointRegistrationBarrier, endpointToken,
  isReachable, managerBucket, mintCreds, mintPublicUserJwt, mintLifecycleUid, newIdentity,
  parseEndpointGate, permissionsFor, presenceBucket, principalKey, provisionEndpointGateOpen,
  readEndpointGateGeneration, recordsBucket, registerServiceInstance, remoteManagerActors,
  serveEndpoint, serveIssuanceGateKv, serverConfig, setupSpaceStreams,
  type EpServeHandle,
} from "../src/index.js";
import { awaitBrokerReady, countedAssert, emitSentinel, freePort, killAndAwaitExit,
  SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const enc = new TextEncoder();
const dec = new TextDecoder();
const space = "environmentgrants";
const owner = `u_${"a".repeat(26)}`;
const instanceId = mintLifecycleUid();
const lifecycleUid = mintLifecycleUid();
const authorityEndpoint = "test.example.environment";
const authorityInstanceId = mintLifecycleUid();
const expiresAt = Math.floor(Date.now() / 1000) + 240;
const pin = { owner, instanceId, lifecycleUid, authorityEndpoint, authorityInstanceId, expiresAt };
const actors = remoteManagerActors(instanceId);
const profiles = [
  ["environment-bootstrap", `manager_bootstrap_${instanceId}`],
  ["environment-manager-supervisor", actors.supervisor],
  ["environment-manager-executor", actors.executor],
  ["environment-manager-goal-writer", actors.goalWriter],
] as const;
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const directory = await mkdtemp(join(tmpdir(), SMOKE_BROKER_TOKEN));
const auth = await createSpaceAuth(space);
await writeFile(join(directory, "server.conf"), serverConfig(auth, [auth], {
  transport: { kind: "plaintext" }, port, storeDir: join(directory, "store"),
}), { mode: 0o600 });
const broker = spawn("nats-server", ["-c", join(directory, "server.conf")], { stdio: "pipe" });
let brokerOutput = "";
broker.stderr.on("data", (bytes: Buffer) => { brokerOutput = (brokerOutput + bytes.toString()).slice(-4000); });
const releaseBroker = teardownOnSignal(broker, directory);
const connections: NatsConnection[] = [];
let serving: EpServeHandle | undefined;
const open = async (creds: string, id: string) => {
  const nc = await connect({ servers, authenticator: credsAuthenticator(enc.encode(creds)),
    inboxPrefix: `_INBOX_${id}`, reconnect: false });
  connections.push(nc);
  return nc;
};
const denied = async (nc: NatsConnection, subject: string, body: unknown, label: string) => {
  await assert.rejects(() => nc.request(subject, enc.encode(JSON.stringify(body)), { timeout: 1000 }),
    /Permissions Violation/i, label);
};

try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 60, delayMs: 50,
    output: () => brokerOutput });
  // Only the private fixture host holds setup/store authority. Guest JWTs below are minted
  // by the shipped profile builder, never by copying these fixture rows.
  const hostIdentity = newIdentity();
  const hostJwt = await encodeUser("environment-grant-fixture-host", fromPublic(hostIdentity.id),
    fromPublic(auth.account.pub), { pub: { allow: ["$JS.API.>", "$KV.>", "$JS.FC.>"] },
      sub: { allow: [`_INBOX_${hostIdentity.id}.>`] } },
    { signer: fromSeed(enc.encode(auth.account.signingSeed)), exp: expiresAt });
  const hostCreds = dec.decode(fmtCreds(hostJwt, fromSeed(enc.encode(hostIdentity.seed))));
  const host = await open(hostCreds, hostIdentity.id);
  await setupSpaceStreams({ servers, space, creds: hostCreds });
  const kvm = new Kvm(host);
  const jsm = await jetstreamManager(host);
  await createEndpointStreams(jsm, kvm, space);
  const authKv = await kvm.open(epAuthBucket(space));
  const presenceKv = await kvm.open(presenceBucket(space));
  const records = await kvm.open(recordsBucket(space));
  const key = epgateKey("manager", instanceId);
  await provisionEndpointGateOpen(authKv, { endpoint: "manager", instanceId,
    principal: `${owner}.${actors.serve}`, authorityFamily: "environment-manager" });
  const born = parseEndpointGate((await authKv.get(key))!.value, key);
  assert.equal(born.authorityFamily, "environment-manager", "admission gate retains its family at birth");
  const barrier = endpointRegistrationBarrier(authKv, space, { endpoint: "manager", instanceId,
    opId: mintLifecycleUid() });
  const before = await barrier.observe();
  assert.ok(before && before.state === "open");
  const freeze = await barrier.freeze(before.revision);
  assert.ok(freeze);
  assert.equal(parseEndpointGate((await authKv.get(key))!.value, key).authorityFamily,
    "environment-manager", "registration freeze preserves family");
  assert.equal(await barrier.reopen(freeze, { generation: before.generation + 1,
    processEpoch: 1, registrationRevision: 1, nameAuthorityRevision: 0 }), true);
  assert.equal((await barrier.observe())!.authorityFamily, "environment-manager",
    "registration reopen preserves family");
  const gate = serveIssuanceGateKv(authKv, space, { endpoint: "manager", instanceId });
  assert.equal(await gate.commit((await gate.observe())!.revision), true);
  assert.equal(parseEndpointGate((await authKv.get(key))!.value, key).authorityFamily,
    "environment-manager", "mint touch preserves family");
  await assert.rejects(() => provisionEndpointGateOpen(authKv, { endpoint: "manager", instanceId,
    principal: `${owner}.${actors.serve}` }), /FOREIGN content/, "plain re-provision cannot strip a family");

  const input = compileContract({ root: { type: "object", properties: {}, additionalProperties: false } });
  const output = compileContract({ root: { type: "object", properties: { command: { type: "string" } },
    required: ["command"], additionalProperties: false } });
  const commands = ["bootstrap", "bootstrap-status", "authority"];
  const document = { urn: "test.example.environment", revision: 1, attributes: [], events: [],
    commands: commands.map(name => ({ name, class: "ephemeral", targeted: false,
      capability: "environment.call", inputDigest: input.closureDigest, outputDigest: output.closureDigest })) };
  const manifest = { v: 1, root: contractDigest(document), members: [] };
  const artifacts = new Map([document, manifest].map(value => [contractDigest(value), value]));
  const readClusterArtifact = (digest: string) => artifacts.get(digest);
  const authority = { authorize: (endpoint: string, registrant: string) => ({
    authorized: endpoint === authorityEndpoint && registrant === owner, revision: 0 }) };
  const serveActor = `authority_${authorityInstanceId}`;
  await provisionEndpointGateOpen(authKv, { endpoint: authorityEndpoint, instanceId: authorityInstanceId,
    principal: `${owner}.${serveActor}` });
  await registerServiceInstance(records, { space, instanceId: authorityInstanceId,
    spec: { endpoint: authorityEndpoint, owner, clusterDigests: [contractDigest(manifest)], protocol: { v: 1 } },
    registrant: { owner }, authority, readClusterArtifact,
    barrier: endpointRegistrationBarrier(authKv, space, { endpoint: authorityEndpoint,
      instanceId: authorityInstanceId, opId: mintLifecycleUid() }),
    observeHolderGeneration: holder => readEndpointGateGeneration(authKv, { endpoint: authorityEndpoint, instanceId: holder }) });
  const serveGate = serveIssuanceGateKv(authKv, space, { endpoint: authorityEndpoint, instanceId: authorityInstanceId });
  const epoch = (await serveGate.observe())!.processEpoch;
  const grant = await authorizeServeGrant(records, { space, endpoint: authorityEndpoint,
    instanceId: authorityInstanceId, epoch, holder: { owner }, authority, readClusterArtifact,
    readProcessEpoch: () => epoch });
  const serveIdentity = newIdentity();
  const serveCreds = await mintCreds(auth, serveIdentity, "endpoint-serve", { principal: { owner, actor: serveActor },
    endpointServe: grant, serveIssuance: serveGate, expiresAt });
  const serveNc = await open(serveCreds, serveIdentity.id);
  let effects = 0;
  serving = serveEndpoint(serveNc, space, grant, commands.map(command => ({ command,
    contract: { input, output }, handler: () => { effects++; return { command }; } })), { public: true });
  await serveNc.flush();

  for (const [profile, actor] of profiles) {
    const identity = newIdentity();
    const opts = { principal: { owner, actor }, lifecycleUid, environmentManager: pin, expiresAt };
    const creds = await mintCreds(auth, identity, profile, opts);
    const nc = await open(creds, identity.id);
    if (profile === "environment-bootstrap" || profile === "environment-manager-executor") {
      const caller = { owner, actor, uid: lifecycleUid };
      const described = await describeEndpoint(nc, space, authorityEndpoint, caller,
        { instanceId: authorityInstanceId, deadlineMs: 1000 });
      assert.equal(described.responder.instanceId, authorityInstanceId, `${profile} native describe instance`);
      assert.equal(described.responder.epoch, epoch, `${profile} native describe epoch`);
      const command = profile === "environment-bootstrap" ? "bootstrap" : "authority";
      const answer = await epCall(nc, space, { mode: "inst", instanceId: authorityInstanceId, epoch },
        { endpoint: authorityEndpoint, command, caller, contract: { input, output }, args: {},
          bind: { instanceId: authorityInstanceId, epoch } }, { deadlineMs: 1000 });
      assert.equal(answer.reply.ok, true, `${profile} native bound RPC works`);
      const foreign = `cotal.${space}.ep.inst.${endpointToken(authorityEndpoint)}.${mintLifecycleUid()}.${command}.${owner}.${actor}.${lifecycleUid}.probe`;
      await denied(nc, foreign, {}, `${profile} foreign authority instance denied`);
      await denied(nc, `cotal.${space}.ep.one.${endpointToken(authorityEndpoint)}.${command}.${owner}.${actor}.${lifecycleUid}.probe`, {},
        `${profile} class route denied`);
      for (const [label, otherOwner, otherActor, otherUid] of [
        ["owner", `u_${"b".repeat(26)}`, actor, lifecycleUid],
        ["actor", owner, "foreign", lifecycleUid],
        ["lifecycle", owner, actor, mintLifecycleUid()],
      ]) {
        await denied(nc, `cotal.${space}.ep.inst.${endpointToken(authorityEndpoint)}.${authorityInstanceId}.${command}.${otherOwner}.${otherActor}.${otherUid}.probe`, {},
          `${profile} forged caller ${label} denied`);
      }
      const otherCommand = profile === "environment-bootstrap" ? "authority" : "bootstrap";
      await denied(nc, `cotal.${space}.ep.inst.${endpointToken(authorityEndpoint)}.${authorityInstanceId}.${otherCommand}.${owner}.${actor}.${lifecycleUid}.probe`, {},
        `${profile} other phase command denied`);
    }
    if (profile === "environment-manager-supervisor") {
      const supervisor = new CotalEndpoint({ space, servers, creds, lifecycleUid,
        card: { id: identity.id, owner, actor, name: "environment-supervisor-fixture", kind: "endpoint" },
        channels: [], consume: false, registerPresence: true, watchPresence: true, watchChannels: false });
      try {
        await supervisor.start();
        const info = { instanceId, holder: principalKey(owner, actor).key, runtime: "fixture",
          root: directory, pid: process.pid };
        const acquired = await supervisor.acquireManagerLease(info);
        assert.equal((await supervisor.readOwnManagerLease(instanceId))!.revision, acquired,
          "supervisor native lease acquire and leader read work");
        const renewed = await supervisor.renewManagerLease(info, acquired);
        assert.ok(renewed > acquired, "supervisor native lease renew advances revision");
        await supervisor.releaseManagerLease(instanceId, renewed);
        assert.equal(await supervisor.readOwnManagerLease(instanceId), undefined,
          "supervisor native lease release is observed");
        const pkey = principalKey(owner, actor).key;
        assert.ok(await presenceKv.get(pkey), "supervisor native own presence is registered");
        await denied(nc, `$KV.${managerBucket(space)}.lease.${mintLifecycleUid()}`, {}, "supervisor foreign lease denied");
      } finally {
        await supervisor.stop();
      }
    }
    if (profile === "environment-manager-goal-writer") {
      await nc.request(`$KV.${recordsBucket(space)}.goalidx.manager.fixture`, enc.encode("goal-index"));
      assert.equal(dec.decode((await records.get("goalidx.manager.fixture"))!.value), "goal-index");
    }
    await denied(nc, `$KV.${epAuthBucket(space)}.${key}`, { ...born, authorityFamily: undefined }, `${profile} raw gate write denied`);
    await denied(nc, `$KV.${epAuthBucket(space)}.eprepair.manager.${instanceId}`, {}, `${profile} raw repair write denied`);
    await denied(nc, `$KV.${epAuthBucket(space)}.epcred.manager.${instanceId}.probe`, {}, `${profile} raw ledger write denied`);
    await denied(nc, `$JS.API.STREAM.MSG.GET.KV_${epAuthBucket(space)}`, { last_by_subj: `$KV.${epAuthBucket(space)}.${key}` },
      `${profile} auth leader read denied`);
    await denied(nc, `$JS.API.CONSUMER.CREATE.KV_${epAuthBucket(space)}.probe`, { stream_name: `KV_${epAuthBucket(space)}`,
      config: { name: "probe", filter_subject: `$KV.${epAuthBucket(space)}.>` } }, `${profile} auth scan denied`);
    const pr = { owner, actor, connId: identity.id, lifecycleUid };
    assert.throws(() => permissionsFor(profile, space, { ...pr, actor: "foreign" }, opts), /actor/, `${profile} actor pin required`);
    assert.throws(() => permissionsFor(profile, space, { ...pr, lifecycleUid: mintLifecycleUid() }, opts), /lifecycle/, `${profile} lifecycle pin required`);
    await assert.rejects(() => mintCreds(auth, identity, profile, { ...opts, expiresAt: expiresAt + 1 }), /admission/, `${profile} mint expiry cannot exceed admission`);
    await assert.rejects(() => mintPublicUserJwt(auth, identity.id, profile, { ...opts, expiresAt: expiresAt + 1 }), /admission/,
      `${profile} public-key mint expiry cannot exceed admission`);
    console.log(`  ✓ ${profile}: native positive control and raw authority denials`);
  }
  assert.equal(effects, 2, "only the two allowed bound commands reached their handlers");
  assert.equal(parseEndpointGate((await authKv.get(key))!.value, key).authorityFamily, "environment-manager",
    "every guest raw-write attempt left the family intact");
  for (const value of [null, "human", "platform-control", "other", 1]) {
    assert.throws(() => parseEndpointGate(enc.encode(JSON.stringify({ ...born, authorityFamily: value })), key), /authorityFamily/);
  }
  const existing = permissionsFor("goal-writer", space, { owner, actor: actors.goalWriter,
    connId: newIdentity().id }, { goalWriter: { endpoint: "manager" } });
  assert.ok((existing as { pub: { allow: string[] } }).pub.allow.includes(`$JS.API.STREAM.MSG.GET.KV_${epAuthBucket(space)}`),
    "ordinary goal-writer grant is unchanged");
} finally {
  await serving?.stop();
  await Promise.all(connections.map(nc => nc.close()));
  await killAndAwaitExit(broker);
  releaseBroker();
  await rm(directory, { recursive: true, force: true });
}
console.log("ENVIRONMENT MANAGER GRANTS COMPLETE (profile/gate substrate only)");
emitSentinel({ passed: counted.cells(), failed: 0 });
