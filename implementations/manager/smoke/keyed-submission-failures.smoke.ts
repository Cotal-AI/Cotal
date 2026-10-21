/** Additional-only keyed failure schedules. Owned real immutable KV and child crashes, not
 * native-manager takeover or scheduler integration. Prior completed cells are not repeated. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { ensureAdmissionStore, admissionBucket, admissionKey, bindAndAdmitRunSubmission, readRunSubmission,
  newSubmissionRunId, mintLifecycleUid, mintGeneration, contractDigest, canonicalJson,
  type RunAdmission, type EpCaller } from "@cotal-ai/core";
import { freePort, SMOKE_BROKER_TOKEN, teardownOnSignal, awaitBrokerReady, killAndAwaitExit } from "@cotal-ai/smoke-kit";

const enc = new TextEncoder(), space = "keyed-failures", endpoint = "manager";
// The crash child inherits this environment, so no ambient COTAL_ identity reaches it.
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
if (process.argv[2] === "owned-crash-child") {
  const p = JSON.parse(process.env.AGENT41_OWNED_CRASH_PAYLOAD!);
  const nc = await connect({ servers: p.servers, reconnect: false }), jsm = await jetstreamManager(nc);
  const kv = await new Kvm(nc).open(admissionBucket(space)), put = kv.put;
  let checks = 0;
  if (p.mode === "after-admission") kv.put = async (...args) => {
    const revision = await put.apply(kv, args);
    if (args[0] === admissionKey(endpoint, p.admission.runId)) process.exit(74);
    return revision;
  };
  await bindAndAdmitRunSubmission({ kv, jsm, admission: p.admission, submissionId: p.id,
    fingerprint: p.fingerprint, processEpoch: 4, deadline: { requestEndsAt: performance.now() + p.budgetMs },
    assertCurrent: async () => {
      checks++;
      if ((p.mode === "before-binding" && checks === 1) || (p.mode === "after-binding" && checks === 2)) process.exit(73);
    } });
  throw new Error("owned child did not reach requested crash window");
}

const port = await freePort(), servers = `nats://127.0.0.1:${port}`;
assert.notEqual(port, 4222);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", dir, "-a", "127.0.0.1", "-p", String(port)], { stdio: "ignore" });
const release = teardownOnSignal(broker);
let nc: Awaited<ReturnType<typeof connect>> | undefined;
try {
  await awaitBrokerReady(async () => { try { const n = await connect({ servers, reconnect: false }); await n.close(); return true; } catch { return false; } }, { servers, attempts: 50, delayMs: 100 });
  nc = await connect({ servers, reconnect: false });
  const jsm = await jetstreamManager(nc), kvm = new Kvm(nc);
  await ensureAdmissionStore(jsm, kvm, space); const kv = await kvm.open(admissionBucket(space));
  const caller = { owner: "local", actor: "failure", uid: mintLifecycleUid(), generation: mintGeneration() };
  const instanceId = mintLifecycleUid(), processEpoch = 4, fingerprint = contractDigest({ failure: true });
  const make = (): RunAdmission => ({ version: 1, space, endpoint, runId: newSubmissionRunId(), instanceId, caller,
    admittedAt: Date.now(), provenance: { kind: "issued", ref: { space, ...caller }, resolvedRevision: 1 },
    ceiling: { publish: { allow: { mode: "none" }, deny: [] }, subscribe: { allow: { mode: "none" }, deny: [] } } });
  const read = (id: string, who: EpCaller = caller, inst = instanceId) => readRunSubmission({ jsm, space, endpoint,
    caller: who, submissionId: id, instanceId: inst, processEpoch });
  const run = (id: string, admission = make(), budgetMs = 3000) => bindAndAdmitRunSubmission({ kv, jsm,
    admission, submissionId: id, fingerprint, processEpoch, deadline: { requestEndsAt: performance.now() + budgetMs } });
  for (const mode of ["before-binding", "after-binding", "after-admission"] as const) {
    const id = mintLifecycleUid(), admission = make();
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "owned-crash-child"], {
      env: { ...process.env, AGENT41_OWNED_CRASH_PAYLOAD: JSON.stringify({ mode, id, admission, fingerprint, servers, budgetMs: 10_000 }) },
      stdio: ["ignore", "inherit", "inherit"],
    });
    const pid = child.pid;
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.equal(code, mode === "after-admission" ? 74 : 73); assert.equal(child.signalCode, null);
    const observed = await read(id);
    assert.equal(observed.state, mode === "before-binding" ? "unbound" : mode === "after-binding" ? "binding-only" : "admitted");
    if (mode !== "before-binding") {
      const duplicate = await run(id); assert.equal(duplicate.winner, false); assert.equal(duplicate.view.runId, admission.runId);
      assert.equal(duplicate.view.state, observed.state);
    }
    console.log(JSON.stringify({ pass: "actual owned process crash window", mode, pid, exitCode: code, signal: child.signalCode,
      state: observed.state, runId: observed.runId, noLaterRepair: mode !== "before-binding" }));
  }
  const getMessage = jsm.streams.getMessage;
  const opaqueId = mintLifecycleUid(), opaqueAdmission = make(); let writes = 0;
  const put = kv.put;
  kv.put = async (...args) => {
    if (args[0] === admissionKey(endpoint, opaqueAdmission.runId)) { writes++; throw Object.assign(new Error("owned unknown admission transport"), { code: "TIMEOUT" }); }
    return put.apply(kv, args);
  };
  jsm.streams.getMessage = async (...args) => {
    if ("last_by_subj" in args[1] && args[1].last_by_subj?.endsWith(`.${admissionKey(endpoint, opaqueAdmission.runId)}`)) throw new Error("owned unavailable leader read");
    return getMessage.apply(jsm.streams, args);
  };
  try {
    await assert.rejects(run(opaqueId, opaqueAdmission)); assert.equal(writes, 1);
    const unknown = await read(opaqueId); assert.equal(unknown.state, "indeterminate"); assert.equal(unknown.runId, opaqueAdmission.runId);
  } finally { kv.put = put; jsm.streams.getMessage = getMessage; }
  assert.equal((await run(opaqueId)).view.state, "binding-only");
  console.log("PASS unreadable exact admission after unknown create holds after one attempt, exact read indeterminate, later callback never repairs");
  // Real broker divergence at the exact immutable run key, injected through fixture-owned writer.
  const divergentId = mintLifecycleUid(), divergent = make();
  kv.put = async (...args) => {
    if (args[0] === admissionKey(endpoint, divergent.runId)) {
      await put.call(kv, args[0], enc.encode(canonicalJson({ ...divergent, admittedAt: divergent.admittedAt + 1 })), args[2]);
      throw Object.assign(new Error("owned divergent admission ACK"), { code: "TIMEOUT" });
    }
    return put.apply(kv, args);
  };
  try { await assert.rejects(run(divergentId, divergent), /conflicts/); }
  finally { kv.put = put; }
  await assert.rejects(read(divergentId), /diverges/);
  await assert.rejects(run(divergentId), /diverges/);
  console.log("PASS immutable divergent admission never overwrites, read and duplicate fail closed");
  const delayedId = mintLifecycleUid(), delayed = make(), budgetMs = 50, wallAtCall = Date.now();
  let releaseLate!: () => void, landed!: () => void, recorded: number | undefined;
  const held = new Promise<void>(resolve => { releaseLate = resolve; }), done = new Promise<void>(resolve => { landed = resolve; });
  kv.put = async (...args) => {
    if (args[0] === admissionKey(endpoint, delayed.runId)) { await held; const r = await put.apply(kv, args); landed(); return r; }
    return put.apply(kv, args);
  };
  try {
    await assert.rejects(run(delayedId, delayed, budgetMs), /deadline|unknown/);
    const before = await read(delayedId); assert.equal(before.state, "binding-only");
    // The recorded projection is a rounded-down wall reading of the same 50ms window, never later.
    recorded = before.callbackDeadline;
    assert.ok(Number.isSafeInteger(recorded) && recorded! <= Date.now() && Math.abs(recorded! - (wallAtCall + budgetMs)) <= 5, String(recorded));
    assert.equal((await run(delayedId)).winner, false);
    releaseLate(); await done;
  } finally { releaseLate(); kv.put = put; }
  const late = await read(delayedId); assert.equal(late.state, "admitted"); assert.equal(late.runId, delayed.runId); assert.equal(late.callbackDeadline, recorded);
  assert.deepEqual((await kv.get(admissionKey(endpoint, delayed.runId)))!.value, enc.encode(canonicalJson(delayed)));
  console.log("PASS original timed-out publish can land later at same run/frozen bytes, earlier absence never proves non-admission or authorizes replacement");
  await assert.rejects(read(delayedId, caller, mintLifecycleUid()));
  assert.equal((await read(delayedId, { ...caller, owner: "other" })).state, "unbound");
  console.log("PASS same binding refuses changed instance, cross-owner namespace cannot read it");
} finally {
  await nc?.close(); await killAndAwaitExit(broker); release();
  console.log(JSON.stringify({ ownedBrokerExit: broker.exitCode, signal: broker.signalCode, port, retainedScratch: dir,
    scope: "real store and actual process crash cells, not native takeover or scheduler" }));
}
