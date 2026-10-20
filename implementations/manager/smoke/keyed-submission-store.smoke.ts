/** Owned loopback immutable admission-store cells. No manager/model/operational account. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  ensureAdmissionStore, admissionBucket, admissionKey, bindAndAdmitRunSubmission, readRunSubmission,
  runSubmissionKey, contractDigest, mintGeneration, mintLifecycleUid, newSubmissionRunId, DEV_OWNER,
  type RunAdmission, type EpCaller,
} from "@cotal-ai/core";
import { freePort, awaitBrokerReady, killAndAwaitExit, teardownOnSignal, SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";
const port = process.env.AGENT41_BROKER_PORT ? Number(process.env.AGENT41_BROKER_PORT) : await freePort();
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536, "owned loopback broker port");
const servers = `nats://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", dir, "-a", "127.0.0.1", "-p", String(port)], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir);
let nc: Awaited<ReturnType<typeof connect>> | undefined;
let checks = 0;
const check = (name: string) => { checks++; console.log(`PASS ${name}`); };
try {
  await awaitBrokerReady(async () => { try { const c = await connect({ servers, reconnect: false }); await c.close(); return true; } catch { return false; } }, { servers, attempts: 50, delayMs: 100 });
  nc = await connect({ servers, reconnect: false });
  const jsm = await jetstreamManager(nc), kvm = new Kvm(nc), space = "keyed-store";
  await ensureAdmissionStore(jsm, kvm, space);
  const kv = await kvm.open(admissionBucket(space));
  const caller: EpCaller = { owner: DEV_OWNER, actor: "caller", uid: mintLifecycleUid(), generation: mintGeneration() } as EpCaller;
  const endpoint = "manager", instanceId = mintLifecycleUid(), processEpoch = 4;
  const admission = (): RunAdmission => ({ version: 1, space, endpoint, runId: newSubmissionRunId(), instanceId, caller,
    ceiling: { publish: { allow: { mode: "none" }, deny: [] }, subscribe: { allow: { mode: "none" }, deny: [] } }, admittedAt: Date.now(),
    provenance: { kind: "issued", ref: { space, ...caller, generation: (caller as { generation: string }).generation }, resolvedRevision: 1 } });
  const run = (id: string, a = admission(), fingerprint = contractDigest({ source: "same" })) => bindAndAdmitRunSubmission({ kv, jsm,
    admission: a, submissionId: id, fingerprint, processEpoch, callbackDeadline: Date.now() + 3000 });
  const read = (id: string, who = caller, epoch = processEpoch) => readRunSubmission({ jsm, space, endpoint, caller: who, submissionId: id, instanceId, processEpoch: epoch });
  const id = mintLifecycleUid(), contenders = await Promise.all(Array.from({ length: 8 }, () => run(id)));
  assert.equal(contenders.filter(r => r.winner).length, 1);
  assert.equal(new Set(contenders.map(r => r.view.runId)).size, 1);
  check("concurrent same-key first-wins binding and at most one admitting callback");
  const original = await read(id), originalAdmission = await kv.get(admissionKey(endpoint, original.runId!));
  const retry = await run(id);
  assert.equal(retry.winner, false); assert.equal(retry.view.runId, original.runId);
  assert.deepEqual((await kv.get(admissionKey(endpoint, original.runId!)))!.value, originalAdmission!.value);
  check("delayed duplicate/lost response observes original immutable run/admission bytes");
  await assert.rejects(run(id, admission(), contractDigest({ source: "different" })), e => (e as { code?: string }).code === "conflict");
  check("same key changed semantic fingerprint conflicts without replacement");
  const other: EpCaller = { ...caller, uid: mintLifecycleUid() };
  assert.equal((await read(id, other)).state, "unbound");
  await assert.rejects(read(id, { ...caller, generation: mintGeneration() } as EpCaller));
  await assert.rejects(read(id, caller, processEpoch + 1));
  check("caller lifecycle namespace, generation and exact epoch confinement");
  const put = kv.put;
  let attempts = 0;
  kv.put = async (...args) => {
    if (args[0].startsWith("admission.")) {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error("injected transient before admission write"), { code: "TIMEOUT" });
    }
    return put.apply(kv, args);
  };
  try { assert.equal((await run(mintLifecycleUid())).view.state, "admitted"); assert.equal(attempts, 2); }
  finally { kv.put = put; }
  check("transient post-binding failure retries same frozen admission in original callback");
  const unknownId = mintLifecycleUid(), frozen = admission(); attempts = 0;
  kv.put = async (...args) => {
    const r = await put.apply(kv, args);
    if (args[0] === admissionKey(endpoint, frozen.runId)) { attempts++; throw Object.assign(new Error("injected lost admission ACK"), { code: "TIMEOUT" }); }
    return r;
  };
  try { assert.equal((await run(unknownId, frozen)).view.state, "admitted"); assert.equal(attempts, 1); }
  finally { kv.put = put; }
  check("unknown admission ACK leader-reads identical frozen bytes without another create");
  const heldId = mintLifecycleUid(); attempts = 0;
  kv.put = async (...args) => {
    if (args[0].startsWith("admission.")) { attempts++; throw Object.assign(new Error("injected repeated transient"), { code: "TIMEOUT" }); }
    return put.apply(kv, args);
  };
  try { await assert.rejects(run(heldId)); assert.equal(attempts, 3); }
  finally { kv.put = put; }
  assert.equal((await read(heldId)).state, "binding-only");
  const duplicate = await run(heldId);
  assert.equal(duplicate.winner, false); assert.equal(duplicate.view.state, "binding-only");
  check("at most three attempts then visible binding-only hold, duplicate never repairs");
  const lostBindingId = mintLifecycleUid();
  kv.put = async (...args) => {
    const revision = await put.apply(kv, args);
    if (args[0] === runSubmissionKey(endpoint, caller, lostBindingId))
      throw Object.assign(new Error("injected lost binding-create ACK"), { code: "TIMEOUT" });
    return revision;
  };
  try {
    const lostBinding = await run(lostBindingId);
    assert.equal(lostBinding.winner, false); assert.equal(lostBinding.view.state, "binding-only");
  } finally { kv.put = put; }
  check("lost binding ACK cannot confer winner authority or repair from matching bytes");
  const changedId = mintLifecycleUid(); let freshnessReads = 0;
  await assert.rejects(bindAndAdmitRunSubmission({ kv, jsm, admission: admission(), submissionId: changedId,
    fingerprint: contractDigest({ changedAuthority: true }), processEpoch, callbackDeadline: Date.now() + 3000,
    assertCurrent: async () => { if (++freshnessReads === 2) throw new Error("original authority changed after binding"); } }));
  assert.equal((await read(changedId)).state, "binding-only");
  assert.equal((await run(changedId, admission(), contractDigest({ changedAuthority: true }))).winner, false);
  check("changed authority after binding holds original identity, never admits with new ceiling");
  const deadlineId = mintLifecycleUid();
  await assert.rejects(bindAndAdmitRunSubmission({ kv, jsm, admission: admission(), submissionId: deadlineId,
    fingerprint: contractDigest({ late: true }), processEpoch, callbackDeadline: Date.now() - 1 }));
  assert.equal((await read(deadlineId)).state, "unbound");
  check("expired original deadline writes no binding");
  const b = await kv.get(runSubmissionKey(endpoint, caller, id)); assert.ok(b);
  await assert.rejects(kv.put(runSubmissionKey(endpoint, caller, id), b.value));
  await assert.rejects(kv.delete(runSubmissionKey(endpoint, caller, id)));
  check("broker write-once and no deletion keep terminal binding identities permanent");
  console.log(JSON.stringify({ checks, evidence: "real immutable loopback KV with injected transport failures, not signerless/native-manager acceptance" }));
} finally {
  await nc?.close(); await killAndAwaitExit(broker); rmSync(dir, { recursive: true, force: true }); release();
  console.log(JSON.stringify({ ownedBrokerExit: broker.exitCode, signal: broker.signalCode }));
}
