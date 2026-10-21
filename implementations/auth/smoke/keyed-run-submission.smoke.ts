/** Real broker observation+issued/admission stores, actual signerless issuer handler.
 * Not HTTP/whole-manager/signerless driver acceptance. No model or operational account. */
import nodeAssert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { ensureIssuedStores, openIssuedStore, issuedBucket, ensureAdmissionStore, admissionBucket,
  epRequestSubject, mintLifecycleUid, mintGeneration, newIdentity, remoteManagerActors, contractDigest,
  type EndpointRequest, type IssuedSourceRef } from "@cotal-ai/core";
import { freePort, SMOKE_BROKER_TOKEN, teardownOnSignal, killAndAwaitExit, awaitBrokerReady, countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { handleRemoteRunSubmission, observedRunRequest, type ObservedRunRequest } from "../src/manager-authority.js";
import { remoteManagerCurrentRegistrationProof } from "../src/retained-manager-validation.js";
const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const port = process.env.KEYED_BROKER_PORT ? Number(process.env.KEYED_BROKER_PORT) : await freePort();
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536, "owned loopback broker port");
const servers = `nats://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", dir, "-a", "127.0.0.1", "-p", String(port)], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir);
let nc: Awaited<ReturnType<typeof connect>> | undefined;
try {
  await awaitBrokerReady(async () => { try { const c = await connect({ servers, reconnect: false }); await c.close(); return true; } catch { return false; } }, { servers, attempts: 50, delayMs: 100 });
  nc = await connect({ servers, reconnect: false });
  const jsm = await jetstreamManager(nc), kvm = new Kvm(nc), space = "keyed-issuer", owner = "local";
  await ensureIssuedStores(jsm, kvm, space); await ensureAdmissionStore(jsm, kvm, space);
  const issued = openIssuedStore(await kvm.open(issuedBucket(space)), jsm, space), kv = await kvm.open(admissionBucket(space));
  const instanceId = mintLifecycleUid(), epoch = 3, accountPublicKey = `A${"A".repeat(55)}`, proofSecret = "owned-issuer-fixture";
  const identities = { supervisor: { id: newIdentity().id }, executor: { id: newIdentity().id }, serve: { id: newIdentity().id },
    goalWriter: { id: newIdentity().id }, sessionLedger: { id: newIdentity().id } };
  const gate = { state: "open" as const, principal: `${owner}.${remoteManagerActors(instanceId).serve}`, processEpoch: epoch, registrationRevision: 7 };
  const base = { v: 1 as const, kind: "manager-run-submission" as const, space, actor: "cli", instanceId,
    managerLifecycleUid: mintLifecycleUid(), accountPublicKey, processEpoch: epoch, identities };
  const registrationProof = remoteManagerCurrentRegistrationProof(proofSecret, owner, base, gate);
  const caller = { owner, actor: "alice", uid: mintLifecycleUid(), generation: mintGeneration() };
  const source: IssuedSourceRef = { space, bucket: "owned_fixture", key: "live" }; let live = true;
  const prepared = await issued.stage({ version: 1, ref: { space, ...caller }, sources: [source], permissions: {
    publish: { allow: { mode: "patterns", patterns: [`cotal.${space}.ep.v1.inst.manager.${instanceId}.*.${owner}.alice.>`] }, deny: [] },
    subscribe: { allow: { mode: "none" }, deny: [] },
  } }); await issued.release(prepared, async () => {});
  const contract = { class: "ephemeral" as const, inputDigest: contractDigest({ input: true }), outputDigest: contractDigest({ output: true }) };
  const observations = new Map<string, ObservedRunRequest>();
  const sub = nc.subscribe(`cotal.${space}.ep.v1.inst.manager.${instanceId}.>`, { callback: (_e, m) => {
    const o = observedRunRequest(m.subject, m.data); if (o) observations.set(m.subject, o);
  } }); await nc.flush();
  const id = mintLifecycleUid();
  async function forward(command: "run-start-keyed" | "run-submission-status", over: Partial<EndpointRequest> = {}, requestOver = {}) {
    const subject = epRequestSubject(space, { route: { mode: "inst", instanceId }, endpoint: "manager", command, caller, nonce: mintLifecycleUid() });
    const env: EndpointRequest = { v: 1, id: command === "run-start-keyed" ? id : mintLifecycleUid(), class: "ephemeral",
      op: { endpoint: "manager", command, inputDigest: contract.inputDigest, outputDigest: contract.outputDigest },
      replyExpected: true, deadlineMs: 5000, bind: { instanceId, epoch }, from: { id: `${owner}.alice`, name: "alice" },
      args: command === "run-start-keyed" ? { source: 'log("owned");' } : { submissionId: id }, ...over };
    nc!.publish(subject, new TextEncoder().encode(JSON.stringify(env))); await nc!.flush();
    return handleRemoteRunSubmission({ request: { ...base, requestId: mintLifecycleUid(), registrationProof, subject, ...requestOver },
      owner, space, accountPublicKey, proofSecret, endpoint: "manager", observeManagerGate: async () => gate,
      issued, sourceIsLive: async () => live, registeredCommand: async () => contract,
      takeObserved: async s => { await nc!.flush(); const o = observations.get(s); observations.delete(s); return o; },
      withStore: async (_run, _submission, fn) => fn(kv, jsm) });
  }
  const first = await forward("run-start-keyed"), duplicate = await forward("run-start-keyed"), status = await forward("run-submission-status");
  assert.equal(first.winner, true); assert.equal(duplicate.winner, false); assert.equal(status.winner, false);
  assert.equal(first.view.runId, duplicate.view.runId); assert.equal(status.view.runId, first.view.runId);
  console.log("PASS actual observed keyed request admits once from real issued evidence and exact read remains caller-derived");
  await assert.rejects(forward("run-start-keyed", { args: { source: 'log("changed");' } }), e => (e as { code?: string }).code === "conflict");
  await assert.rejects(forward("run-start-keyed", { bind: { instanceId, epoch: epoch + 1 } }));
  await assert.rejects(forward("run-start-keyed", { op: { endpoint: "manager", command: "run-start-keyed", inputDigest: contractDigest({ old: true }), outputDigest: contract.outputDigest } }));
  await assert.rejects(forward("run-start-keyed", {}, { accountPublicKey: `A${"B".repeat(55)}` }));
  console.log("PASS semantic conflict, wrong epoch/contract/account reject at actual issuer boundary");
  live = false; await assert.rejects(forward("run-submission-status")); live = true;
  await issued.retire({ space, ...caller }); await assert.rejects(forward("run-start-keyed"));
  console.log("PASS stale source and revoked caller refuse even existing keyed binding");
  sub.unsubscribe(); await nc.close();
} finally {
  await nc?.close(); await killAndAwaitExit(broker); rmSync(dir, { recursive: true, force: true }); release();
  console.log(JSON.stringify({ ownedBrokerExit: broker.exitCode, signal: broker.signalCode, wholeSignerlessManagerAcceptance: false }));
}
emitSentinel({ passed: counted.cells(), failed: 0 });
