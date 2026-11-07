/** Endpoint-family enumeration under the actual instance-bound executor profile.
 * Seed through the shipped gate adapter. Count native requests, not elapsed time, for the scaling
 * assertion. The truncated-iterator cell wraps a real consumer whose bind count is still real.
 * FAMILY_SCAN_EVIDENCE_DIR retains the owned broker state and non-secret measurements for a run.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager, type PushConsumer } from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
import { PermissionViolationError } from "@nats-io/nats-core";
import { openPublishDenialWatch } from "../src/endpoint-publish-denial.js";
import type { Bucket } from "@nats-io/kv/internal";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import {
  createBrokerAuth, createSpaceAccountAuth, mintCreds, mintPublicUserJwt, credsFromJwt, remoteManagerActors, newIdentity, serverConfig, setupSpaceStreams,
  isReachable, standaloneConnectOpts, mintLifecycleUid, principalKey, DEV_OWNER, epAuthBucket, recordsBucket,
  epgateKey, epcredRowKey, provisionEndpointGateOpen, serveIssuanceGateKv, endpointRegistrationBarrier,
  IncompleteKvScan, type EpServeLedgerRow,
} from "@cotal-ai/core";
import { pickFreePort } from "./_free-port.js";

const evidence = process.env.FAMILY_SCAN_EVIDENCE_DIR;
const dir = mkdtempSync(join(evidence ?? tmpdir(), SMOKE_BROKER_TOKEN));
const port = await pickFreePort(), servers = `nats://127.0.0.1:${port}`;
const space = "familyscan", otherSpace = "familyscanother", endpoint = "manager";
const brokerAuth = await createBrokerAuth(space);
const auth = { ...brokerAuth, ...await createSpaceAccountAuth(brokerAuth, space) };
const otherAuth = { ...brokerAuth, ...await createSpaceAccountAuth(brokerAuth, otherSpace) };
writeFileSync(join(dir, "server.conf"), serverConfig(brokerAuth, [auth, otherAuth], {
  host: "127.0.0.1", port, storeDir: join(dir, "js"), transport: { kind: "plaintext" },
}), { mode: 0o600 });
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);
const connections: NatsConnection[] = [];
let passed = 0;
const check = (name: string, ok: boolean): void => { assert.ok(ok, name); passed++; console.log(`  ✓ ${name}`); };
const record = (data: object): void => { if (evidence) appendFileSync(join(dir, "measurements.jsonl"), JSON.stringify(data) + "\n", { mode: 0o600 }); };
try {
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await new Promise(resolve => setTimeout(resolve, 50));
  check("owned loopback broker answers", await isReachable(servers));
  for (const a of [auth, otherAuth]) await setupSpaceStreams({ servers, space: a.space, creds: await mintCreds(a, newIdentity(), "provisioner") });
  const open = async (creds: string): Promise<NatsConnection> => {
    const nc = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }), reconnect: false });
    connections.push(nc); return nc;
  };
  const provisioner = await open(await mintCreds(auth, newIdentity(), "provisioner"));
  const jsm = await jetstreamManager(provisioner);
  const other = await open(await mintCreds(otherAuth, newIdentity(), "provisioner"));
  await (await new Kvm(other).open(epAuthBucket(otherSpace))).status();
  check("other account's auth bucket genuinely exists", true);
  const execFor = async (instanceId: string) => {
    const nc = await open(await mintCreds(auth, newIdentity(), "endpoint-serve-executor", {
      endpointServeExecutor: { endpoint, instanceId }, expiresInSeconds: 60,
    }));
    return { nc, kv: await new Kvm(nc).open(epAuthBucket(space)) };
  };
  // Same seedless signer/profile/options as auth service prepare: the remote side keeps its seed.
  const remoteFor = async (instanceId: string) => {
    const identity = newIdentity(), owner = `u_${"a".repeat(26)}`, actor = remoteManagerActors(instanceId).executor;
    const issued = await mintPublicUserJwt(auth, identity.id, "remote-manager", {
      remoteManager: { instanceId, owner, actor }, principal: { owner, actor },
      lifecycleUid: mintLifecycleUid(), expiresInSeconds: 5 * 60,
    });
    const nc = await open(credsFromJwt(issued.jwt, identity));
    return { nc, kv: await new Kvm(nc).open(epAuthBucket(space)) };
  };
  const principal = principalKey(DEV_OWNER, "holder").key;
  const rowFor = (instanceId: string): EpServeLedgerRow => ({
    credentialId: mintLifecycleUid(), credentialKey: "", holderPrincipal: principal, endpoint, lifecycleUid: instanceId,
    sourceChain: ["root"], state: "active", exp: Math.floor(Date.now() / 1000) + 3600,
    generation: 0, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0,
  });
  const foreignId = mintLifecycleUid(), foreign = await execFor(foreignId);
  await provisionEndpointGateOpen(foreign.kv, { endpoint, instanceId: foreignId, principal });
  await serveIssuanceGateKv(foreign.kv, space, { endpoint, instanceId: foreignId }).stage(rowFor(foreignId));
  const measure = async (nc: NatsConnection, work: () => EpServeLedgerRow[] | Promise<EpServeLedgerRow[]>) => {
    const request = nc.request.bind(nc); let rpcRequests = 0;
    nc.request = (...args: Parameters<typeof request>) => { rpcRequests++; return request(...args); };
    const before = nc.stats().outMsgs, wall = performance.now(), cpu = process.cpuUsage();
    try {
      const rows = await work(), elapsed = process.cpuUsage(cpu), totalPublishes = nc.stats().outMsgs - before;
      return { rows, rpcRequests, totalPublishes, nonRpcPublishes: totalPublishes - rpcRequests,
        wallMs: performance.now() - wall, cpuMs: (elapsed.user + elapsed.system) / 1000 };
    } finally { nc.request = request; }
  };
  const deniedPublish = async (nc: NatsConnection, subject: string, name: string) => {
    const watch = openPublishDenialWatch(nc, subject, error => error, name);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      nc.publish(subject);
      const error = await Promise.race([watch.denied.catch(error => error), new Promise<unknown>(resolve => {
        timer = setTimeout(() => resolve(new Error("broker denial not observed")), 5000);
      })]);
      check(name, error instanceof PermissionViolationError && error.subject === subject);
    } finally { clearTimeout(timer); watch.release(); }
  };
  const costs: number[] = [], remoteCosts: number[] = [];
  for (const count of [0, 7905, 12753]) {
    const instanceId = mintLifecycleUid(), setup = await execFor(instanceId);
    await provisionEndpointGateOpen(setup.kv, { endpoint, instanceId, principal });
    const writer = serveIssuanceGateKv(setup.kv, space, { endpoint, instanceId });
    const barrier = endpointRegistrationBarrier(setup.kv, space, { endpoint, instanceId, opId: mintLifecycleUid() });
    const expected = new Set<string>();
    for (let start = 0; start < count; start += 16) await Promise.all(Array.from({ length: Math.min(16, count - start) }, async () => {
      const row = rowFor(instanceId); expected.add(row.credentialId); await writer.stage(row); await barrier.revoke(row);
    }));
    const before = await setup.kv.get(epgateKey(endpoint, instanceId));
    const consumersBefore = (await jsm.streams.info(`KV_${epAuthBucket(space)}`)).state.consumer_count;
    const measured = await measure(setup.nc, () => barrier.enumerate()), { rows } = measured;
    record({ count, ...measured, rows: rows.length });
    costs.push(measured.rpcRequests);
    check(`${count}: exact retained family including revoked rows`, rows.length === count && new Set(rows.map(row => row.credentialId)).size === count && rows.every(row => expected.has(row.credentialId) && row.state === "revoked" && row.endpoint === endpoint && row.lifecycleUid === instanceId));
    const after = await setup.kv.get(epgateKey(endpoint, instanceId));
    check(`${count}: enumeration leaves the gate unchanged`, before?.revision === after?.revision && Buffer.from(before!.value).equals(Buffer.from(after!.value)));
    check(`${count}: scan reclaims its native consumer`, (await jsm.streams.info(`KV_${epAuthBucket(space)}`)).state.consumer_count === consumersBefore);
    const remote = await remoteFor(instanceId);
    const remoteMeasured = await measure(remote.nc, () => endpointRegistrationBarrier(remote.kv, space, { endpoint, instanceId, opId: mintLifecycleUid() }).enumerate());
    const remoteRows = remoteMeasured.rows;
    remoteCosts.push(remoteMeasured.rpcRequests); record({ count, profile: "remote-manager-executor", ...remoteMeasured, rows: remoteRows.length });
    check(`${count}: host-signed remote executor sees the same exact family`, remoteRows.length === count && new Set(remoteRows.map(value => value.credentialId)).size === count && remoteRows.every(value => expected.has(value.credentialId) && value.state === "revoked"));
    check(`${count}: remote executor deletes its scan consumer`, (await jsm.streams.info(`KV_${epAuthBucket(space)}`)).state.consumer_count === consumersBefore);
    let remoteDenied: unknown;
    try { await (await new Kvm(remote.nc).open(epAuthBucket(otherSpace))).status(); } catch (error) { remoteDenied = error; }
    check(`${count}: remote executor cannot read the other account`, remoteDenied instanceof Error && /Permissions Violation/.test(remoteDenied.message));
    await deniedPublish(setup.nc, `$JS.FC.KV_${recordsBucket(space)}.probe`, `${count}: CLI flow control cannot reach another stream`);
    await deniedPublish(setup.nc, `$JS.FC.KV_${epAuthBucket(otherSpace)}.probe`, `${count}: CLI flow control cannot reach another account`);
    let foreignWrite: unknown;
    try { await provisionEndpointGateOpen(setup.kv, { endpoint, instanceId: foreignId, principal }); } catch (error) { foreignWrite = error; }
    check(`${count}: CLI data writes stay instance-key-pinned`, foreignWrite instanceof Error && /Permissions Violation/.test(foreignWrite.message));
    let denied: unknown;
    try { await (await new Kvm(setup.nc).open(epAuthBucket(otherSpace))).status(); } catch (error) { denied = error; }
    check(`${count}: native broker refuses another account's stream`, denied instanceof Error && /Permissions Violation/.test(denied.message));
  }
  check("large retained families do not add per-row API requests", costs[2]! <= costs[1]! + 2);

  check("remote executor also avoids per-row API requests", remoteCosts[2]! <= remoteCosts[1]! + 2);

  const instanceId = mintLifecycleUid(), active = await remoteFor(instanceId);
  await provisionEndpointGateOpen(active.kv, { endpoint, instanceId, principal });
  const writer = serveIssuanceGateKv(active.kv, space, { endpoint, instanceId });
  const row = rowFor(instanceId); await writer.stage(row);
  const barrier = endpointRegistrationBarrier(active.kv, space, { endpoint, instanceId, opId: mintLifecycleUid() });
  const observed = await barrier.observe(); assert.ok(observed);
  const frozen = await barrier.freeze(observed.revision); assert.notEqual(frozen, null);
  check("freeze still defeats an earlier mint commit", !await writer.commit(observed.revision));
  check("frozen family retains active credential evidence", (await barrier.enumerate()).some(value => value.credentialId === row.credentialId && value.state === "active"));
  await Promise.all([barrier.enumerate(), barrier.revoke(row)]);
  check("fresh scan observes concurrent revoke after it settles", (await barrier.enumerate()).every(value => value.state === "revoked"));
  check("missing evictor still refuses verification", (await barrier.evict([principal])).every(value => value === false));
  check("stale freeze token still loses reopen", !await barrier.reopen(frozen! - 1, { generation: 1, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0 }));

  // A real consumer and bind count; only the clean premature end is a detector seam, as in kv-scan.smoke.
  const bucket = active.kv as Bucket, realGet = bucket.js.consumers.getPushConsumer.bind(bucket.js.consumers);
  const victim = Object.create(bucket) as KV;
  Object.defineProperty(victim, "js", { value: { ...bucket.js, consumers: { ...bucket.js.consumers,
    getPushConsumer: async (...args: Parameters<typeof realGet>): Promise<PushConsumer> => {
      const oc = await realGet(...args);
      return Object.assign(Object.create(oc), { consume: async () => Object.assign((async function* () {})(), { close: async () => {} }) });
    },
  } } });
  const beforeCut = (await jsm.streams.info(`KV_${epAuthBucket(space)}`)).state.consumer_count;
  let cut: unknown;
  try { await endpointRegistrationBarrier(victim, space, { endpoint, instanceId, opId: mintLifecycleUid() }).enumerate(); } catch (error) { cut = error; }
  check("incomplete family never becomes a complete empty answer", cut instanceof IncompleteKvScan && cut.expected > 0);
  check("incomplete family scan cleans up its consumer", (await jsm.streams.info(`KV_${epAuthBucket(space)}`)).state.consumer_count === beforeCut);
  const malformedId = mintLifecycleUid();
  await active.kv.create(epcredRowKey(endpoint, instanceId, malformedId), new TextEncoder().encode("{}"));
  let malformed: unknown;
  try { await barrier.enumerate(); } catch (error) { malformed = error; }
  check("malformed family evidence still refuses", malformed instanceof Error);
  check("parsing refusal leaves no scan consumer", (await jsm.streams.info(`KV_${epAuthBucket(space)}`)).state.consumer_count === beforeCut);
} finally {
  for (const nc of connections) await nc.close().catch(() => {});
  const exited = broker.exitCode === null && broker.signalCode === null ? once(broker, "exit") : Promise.resolve();
  broker.kill("SIGKILL"); await exited; releaseBroker();
  if (evidence) writeFileSync(join(dir, "OUTCOME.json"), JSON.stringify({ passed, port, brokerExited: true }) + "\n", { mode: 0o600 });
  else rmSync(dir, { recursive: true, force: true });
}
assert.equal(passed, 43, "all family scan cells ran");
console.log(`ENDPOINT FAMILY SCAN: ${passed} passed`);
