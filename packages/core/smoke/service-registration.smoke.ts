import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import {
  completeFrozenRegistrationFromSpec, contractDigest, createEndpointStreams, epAuthBucket, epgateKey,
  endpointRegistrationBarrier, isReachable, mintLifecycleUid, openRecordsBucket, parseEndpointGate,
  recordSpecKey, RECORD_KINDS, registerServiceInstance, type EndpointGateRow, type EpIssuanceBarrier,
} from "../src/index.js";

const space = "service-registration", owner = `u_${"a".repeat(26)}`, actor = "fixture";
const port = await freePort(), servers = `nats://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", dir, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir), enc = new TextEncoder();
const bytes = (value: unknown) => enc.encode(JSON.stringify(value));
const failures: string[] = [];
let nc: NatsConnection | undefined;
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  nc = await connect({ servers });
  await createEndpointStreams(await jetstreamManager(nc), new Kvm(nc), space);
  const kv = await new Kvm(nc).open(epAuthBucket(space)), records = await openRecordsBucket(nc, space);
  const doc = { urn: "org.example.stamps", revision: 1, attributes: [], events: [], commands: [{
    name: "read", class: "ephemeral", targeted: false, capability: "orders.read",
    inputDigest: contractDigest({ type: "object" }), outputDigest: contractDigest({ type: "object" }),
  }] };
  const manifest = { v: 1, root: contractDigest(doc), members: [] };
  const documents = new Map<string, unknown>([[contractDigest(doc), doc], [contractDigest(manifest), manifest]]);
  for (const scenario of ["abort", "success", "lost-ack", "resume", "wrong-request"] as const) {
    const endpoint = `org.example.stamps.${scenario}`, instanceId = mintLifecycleUid(), key = epgateKey(endpoint, instanceId);
    const spec = { endpoint, owner, clusterDigests: [contractDigest(manifest)], protocol: { v: 1 as const } };
    const specKey = recordSpecKey(RECORD_KINDS.svc, [endpoint, instanceId]);
    const specRevision = await records.create(specKey, bytes(spec));
    const stampA = { operationId: mintLifecycleUid(), processEpoch: 1, registrationRevision: specRevision, nameAuthorityRevision: 1, requestId: "a".repeat(32), requestDigest: contractDigest({ request: "A", scenario }), registrationProof: contractDigest({ completed: "A", scenario }) };
    const row: EndpointGateRow = { state: "open", generation: 0, processEpoch: 1,
      registrationRevision: specRevision, nameAuthorityRevision: 1, principal: `${owner}.${actor}`, authorityFamily: "service",
      serviceAuthority: { v: 1, assignmentDigest: contractDigest({ scenario }), lifecycleUid: mintLifecycleUid(),
        state: "approved", rootCredentialId: mintLifecycleUid(), rootExpiresAt: Math.floor(Date.now() / 1000) + 600,
        approvalDigest: contractDigest({ approved: scenario }), approvalExpiresAt: null, callerCeiling: [],
        activationIssued: false, registration: stampA } };
    await kv.create(key, bytes(row));
    const requestB = { requestId: "b".repeat(32), requestDigest: contractDigest({ request: "B", scenario }) };
    const args = { endpoint, instanceId, opId: mintLifecycleUid(), serviceRegistration: requestB };
    const native = endpointRegistrationBarrier(kv, space, args);
    let barrier: EpIssuanceBarrier = native;
    if (scenario === "lost-ack") barrier = { ...native, reopen: async (pin, next) => { await native.reopen(pin, next); throw new Error("lost reopen reply"); } };
    if (scenario === "resume" || scenario === "wrong-request") barrier = { ...native, reopen: async () => { throw new Error("interrupted before reopen"); } };
    const run = () => registerServiceInstance(records, { space, spec, instanceId, registrant: { owner },
      authority: { authorize: () => ({ authorized: scenario !== "abort", revision: 1 }) }, barrier,
      readClusterArtifact: (digest) => documents.get(digest) });
    if (scenario === "success") await run(); else await assert.rejects(run);
    let entry = (await kv.get(key))!, current = parseEndpointGate(entry.value, key);
    if (scenario === "abort") {
      assert.equal(current.state, "open");
      assert.equal((await records.get(specKey))!.revision, specRevision);
      if (JSON.stringify(current.serviceAuthority!.registration) !== JSON.stringify(stampA)) failures.push("definite abort lost prior completion stamp");
      const reread = (await kv.get(key))!;
      assert.equal(reread.revision, entry.revision, "completion recovery read performs no new barrier");
      continue;
    }
    if (scenario === "resume" || scenario === "wrong-request") {
      assert.equal(current.state, "frozen");
      const recoveryArgs = { endpoint, instanceId, opId: args.opId,
        ...(scenario === "wrong-request" ? { serviceRegistration: { requestId: "c".repeat(32), requestDigest: contractDigest({ request: "C" }) } } : {}) };
      const recovery = endpointRegistrationBarrier(kv, space, recoveryArgs);
      const finish = () => completeFrozenRegistrationFromSpec(records, { endpoint, instanceId, barrier: recovery,
        freezeToken: entry.revision, gate: current });
      if (scenario === "wrong-request") {
        try { await finish(); failures.push("wrong request attributed a held completion"); }
        catch (error) { assert.match(String(error), /registration.*(identity|request|binding)/); }
        continue;
      }
      assert.equal((await finish()).completed, true);
      entry = (await kv.get(key))!; current = parseEndpointGate(entry.value, key);
    }
    assert.equal(current.state, "open");
    const stamp = current.serviceAuthority!.registration;
    if (stamp?.requestId !== requestB.requestId || stamp.requestDigest !== requestB.requestDigest)
      failures.push(`${scenario}: successful reopen lacks the completed request stamp`);
    assert.ok(current.registrationRevision > specRevision);
    assert.equal((await kv.get(key))!.revision, entry.revision, "readback after success does not change the epoch or revision");
  }
  assert.deepEqual(failures, [], "atomic registration completion and abort provenance");
  console.log("service registration: abort preservation, atomic success, lost reply and op-bound native recovery passed");
} finally {
  await nc?.close();
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  release();
}
