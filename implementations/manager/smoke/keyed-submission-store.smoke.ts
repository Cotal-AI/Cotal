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
const port = process.env.KEYED_BROKER_PORT ? Number(process.env.KEYED_BROKER_PORT) : await freePort();
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
  const caller: EpCaller & { generation: string } = { owner: DEV_OWNER, actor: "caller", uid: mintLifecycleUid(), generation: mintGeneration() };
  const endpoint = "manager", instanceId = mintLifecycleUid(), processEpoch = 4;
  const admission = (): RunAdmission => ({ version: 1, space, endpoint, runId: newSubmissionRunId(), instanceId, caller,
    ceiling: { publish: { allow: { mode: "none" }, deny: [] }, subscribe: { allow: { mode: "none" }, deny: [] } }, admittedAt: Date.now(),
    provenance: { kind: "issued", ref: { space, ...caller }, resolvedRevision: 1 } });
  const run = (id: string, a = admission(), fingerprint = contractDigest({ source: "same" })) => bindAndAdmitRunSubmission({ kv, jsm,
    admission: a, submissionId: id, fingerprint, processEpoch, deadline: { requestEndsAt: performance.now() + 3000 } });
  const read = (id: string, who: EpCaller = caller, epoch = processEpoch) => readRunSubmission({ jsm, space, endpoint, caller: who, submissionId: id, instanceId, processEpoch: epoch });
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
    fingerprint: contractDigest({ changedAuthority: true }), processEpoch, deadline: { requestEndsAt: performance.now() + 3000 },
    assertCurrent: async () => { if (++freshnessReads === 2) throw new Error("original authority changed after binding"); } }));
  assert.equal((await read(changedId)).state, "binding-only");
  assert.equal((await run(changedId, admission(), contractDigest({ changedAuthority: true }))).winner, false);
  check("changed authority after binding holds original identity, never admits with new ceiling");
  const deadlineId = mintLifecycleUid();
  await assert.rejects(bindAndAdmitRunSubmission({ kv, jsm, admission: admission(), submissionId: deadlineId,
    fingerprint: contractDigest({ late: true }), processEpoch, deadline: { requestEndsAt: performance.now() - 1 } }));
  assert.equal((await read(deadlineId)).state, "unbound");
  check("expired original deadline writes no binding");
  // Clock controls. The request budget is read on this process's monotonic clock and the authority
  // expiry on the wall clock, each on its own; a wall step moves neither the budget nor the record.
  const bind = (submissionId: string, deadline: import("@cotal-ai/core").KeyedSubmissionDeadline, assertCurrent?: () => Promise<void>) =>
    bindAndAdmitRunSubmission({ kv, jsm, admission: admission(), submissionId, fingerprint: contractDigest({ clock: submissionId }),
      processEpoch, deadline, ...(assertCurrent ? { assertCurrent } : {}) });
  const code = (e: unknown) => (e as { code?: string }).code;
  const hold = (ms: number) => () => new Promise<void>(resolve => setTimeout(resolve, ms));
  for (const bad of [{ requestEndsAt: Number.NaN }, { requestEndsAt: Number.POSITIVE_INFINITY },
    { requestEndsAt: performance.now() + 3000, authorityExpiresAt: Number.NaN }]) {
    const badId = mintLifecycleUid(); let reached = false;
    await assert.rejects(bind(badId, bad, async () => { reached = true; }), e => code(e) === "bad-request");
    assert.equal(reached, false); assert.equal((await read(badId)).state, "unbound");
  }
  check("non-finite deadline fields refuse before any read or write");
  const expiredId = mintLifecycleUid(); let expiredReached = false;
  await assert.rejects(bind(expiredId, { requestEndsAt: performance.now() + 3000, authorityExpiresAt: Date.now() - 1 },
    async () => { expiredReached = true; }), e => code(e) === "deadline-exceeded");
  assert.equal(expiredReached, false); assert.equal((await read(expiredId)).state, "unbound");
  check("an authority already expired on the wall clock refuses while the request budget remains");
  type Timed = { code: string | undefined; elapsedMs: number; state: string };
  const timed = async (deadline: import("@cotal-ai/core").KeyedSubmissionDeadline): Promise<Timed> => {
    const timedId = mintLifecycleUid(), started = performance.now();
    const error = await bind(timedId, deadline, hold(600)).then(() => undefined, (e: unknown) => e);
    return { code: code(error), elapsedMs: performance.now() - started, state: (await read(timedId)).state };
  };
  const budgetMid = await timed({ requestEndsAt: performance.now() + 150 });
  const authorityMid = await timed({ requestEndsAt: performance.now() + 5000, authorityExpiresAt: Date.now() + 150 });
  const realNow = Date.now;
  let backward: Timed | undefined, forwardAuthority: Timed | undefined, forward: string | undefined;
  let forwardRecord: { recorded: number | undefined; wallBefore: number } | undefined;
  try {
    Date.now = () => realNow() - 3_600_000;
    backward = await timed({ requestEndsAt: performance.now() + 150 });
    Date.now = () => realNow() + 3_600_000;
    const forwardId = mintLifecycleUid(), wallBefore = Date.now();
    forward = await bind(forwardId, { requestEndsAt: performance.now() + 3000 }).then(r => r.view.state, (e: unknown) => code(e));
    forwardRecord = { recorded: (await read(forwardId)).callbackDeadline, wallBefore };
    forwardAuthority = await timed({ requestEndsAt: performance.now() + 3000, authorityExpiresAt: realNow() + 60_000 });
  } finally { Date.now = realNow; }
  console.log(JSON.stringify({ cell: "K4d-clock-controls", budgetMid, authorityMid, backward, forward, forwardRecord, forwardAuthority }));
  const endedEarly = (r: Timed) => r.code === "deadline-exceeded" && r.state === "unbound"
    && r.elapsedMs >= 140 && r.elapsedMs < 550;
  assert.ok(endedEarly(budgetMid), "request budget ends a held bind on the monotonic clock");
  check("a request budget that elapses mid-bind ends the wait and writes no binding");
  assert.ok(endedEarly(authorityMid), "authority expiry ends a held bind on the wall clock");
  check("an authority expiry reached mid-bind ends the wait and writes no binding");
  assert.ok(endedEarly(backward!), "a backward wall step does not extend the request budget");
  assert.equal(forward, "admitted", "a forward wall step does not spend the request budget");
  assert.ok(Number.isSafeInteger(forwardRecord!.recorded) && forwardRecord!.recorded! >= forwardRecord!.wallBefore
    && forwardRecord!.recorded! <= forwardRecord!.wallBefore + 3000, "the record is a projection on the wall clock it was taken from");
  check("wall-clock steps neither extend nor spend the monotonic request budget");
  assert.equal(forwardAuthority!.code, "deadline-exceeded"); assert.equal(forwardAuthority!.state, "unbound");
  assert.ok(forwardAuthority!.elapsedMs < 140, "the wall-clock authority check runs before the held recheck");
  check("authority expiry stays a wall-clock check, refused before the bind even with budget left");
  const b = await kv.get(runSubmissionKey(endpoint, caller, id)); assert.ok(b);
  await assert.rejects(kv.put(runSubmissionKey(endpoint, caller, id), b.value));
  await assert.rejects(kv.delete(runSubmissionKey(endpoint, caller, id)));
  check("broker write-once and no deletion keep terminal binding identities permanent");
  console.log(JSON.stringify({ checks, evidence: "real immutable loopback KV with injected transport failures, not signerless/native-manager acceptance" }));
} finally {
  await nc?.close(); await killAndAwaitExit(broker); rmSync(dir, { recursive: true, force: true }); release();
  console.log(JSON.stringify({ ownedBrokerExit: broker.exitCode, signal: broker.signalCode }));
}
