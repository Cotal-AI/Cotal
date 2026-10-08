/** Signerless first attempt and operator issuance on a real broker: the shipped authorizer reads the
 *  native admission, run record and checkpoint stores; RunHosting refuses a partial callback set.
 *  Run: tsx implementations/manager/smoke/remote-run-attempt.smoke.ts (needs nats-server on PATH) */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  admissionBucket, createRunAdmission, createRunSpec, ensureAdmissionStore, mintGeneration, mintLifecycleUid, newIdentity,
  openRecordsBucket, readCheckpointStatus, readRunAdmission, readRunRecord, remoteManagerActors, revokeRunAdmission, writeRunStatus,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { authorizeRemoteRunAttempt } from "../../auth/src/manager-authority.js";
import { remoteManagerCurrentRegistrationProof } from "../../auth/src/retained-manager-validation.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { RunHosting } from "../src/run-hosting.js";
import "../../runtime/src/index.js"; // registers the shipped cotal-lang run host, as bin/run.ts does

let fail = 0;
const c = (name: string, ok: boolean, detail?: unknown) => { if (ok) console.log(`  ✓ ${name}`); else { fail++; console.log(`  ✗ FAIL: ${name}`, detail ?? ""); } };
const outcome = (p: Promise<unknown>) => p.then((v) => v, (e: Error) => `refused: ${e.message}`);

const SPACE = "attempt";
const OWNER = "local";
const ACCOUNT = `A${"A".repeat(55)}`;
const SECRET = "suite-proof-secret";
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const release = teardownOnSignal(broker, sd);
try {
  const servers = `nats://127.0.0.1:${PORT}`;
  await awaitBrokerReady(() => connect({ servers }).then((n) => n.close().then(() => true), () => false), { servers, attempts: 50, delayMs: 100 });
  const nc = await connect({ servers });
  const jsm = await jetstreamManager(nc);
  const kvm = new Kvm(nc);
  await ensureAdmissionStore(jsm, kvm, SPACE);
  const admissions = await kvm.open(admissionBucket(SPACE));
  const records = await openRecordsBucket(nc, SPACE, { create: true });

  const instanceId = mintLifecycleUid();
  const identities = { supervisor: { id: newIdentity().id }, executor: { id: newIdentity().id }, serve: { id: newIdentity().id }, goalWriter: { id: newIdentity().id }, sessionLedger: { id: newIdentity().id } };
  const gate = { state: "open" as const, principal: `${OWNER}.${remoteManagerActors(instanceId).serve}`, processEpoch: 3, registrationRevision: 7 };
  const base = { v: 1, kind: "manager-run-attempt", space: SPACE, actor: "cli", instanceId, managerLifecycleUid: mintLifecycleUid(), accountPublicKey: ACCOUNT, processEpoch: 3, identities } as const;
  const proof = remoteManagerCurrentRegistrationProof(SECRET, OWNER, base, gate);
  const newRun = () => `run-${Buffer.from(mintGeneration().slice(0, 16)).toString("hex")}`;
  const admit = async (runId: string, inst = instanceId) => createRunAdmission(admissions, {
    version: 1, space: SPACE, endpoint: "manager", runId, instanceId: inst,
    caller: { owner: "alice_o", actor: "alice", uid: mintLifecycleUid(), generation: mintGeneration() } as never,
    ceiling: { publish: { allow: { mode: "none" }, deny: [] }, subscribe: { allow: { mode: "none" }, deny: [] } },
    provenance: { kind: "operator", by: "suite", reason: "fixture" }, admittedAt: Date.now(),
  });
  const authorize = (body: Record<string, unknown>, over: Record<string, unknown> = {}) => authorizeRemoteRunAttempt({
    request: { ...base, requestId: `req-${mintLifecycleUid()}`, registrationProof: proof, ...body, ...over },
    owner: OWNER, space: SPACE, accountPublicKey: ACCOUNT, proofSecret: SECRET, endpoint: "manager",
    observeManagerGate: async () => gate,
    readAdmission: (runId) => readRunAdmission(jsm, SPACE, "manager", runId),
    readRunStatus: async (runId) => (await readRunRecord(records, "manager", runId))?.status?.value,
    readJournal: async () => [],
    checkpointWaiting: async (token) => (await readCheckpointStatus(records, { endpoint: "manager", token }))?.value.state === "waiting",
    checkpointSettled: async () => false,
  });
  const attempt = (runId: string, epoch = 1, fencingToken = 1) => ({ attempt: { runId, takeoverId: "t".repeat(16), epoch, fencingToken, driverId: newIdentity().id, mediatorId: newIdentity().id } });

  // Positive: a first attempt (no run record yet, as stock start launches at 1/1).
  const first = newRun();
  await admit(first);
  const grant = await outcome(authorize(attempt(first)));
  c("a first attempt under a stored admission is granted the fixed driver/mediator pair pinned to epoch 1 and the admission owner",
    typeof grant === "object" && grant !== null && (grant as { kind: string }).kind === "attempt" &&
    JSON.stringify((grant as { driver: { runDriver: unknown } }).driver.runDriver) === JSON.stringify({ endpoint: "manager", runId: first, owner: "alice_o", takeoverId: "t".repeat(16), instanceId, epoch: 1 }) &&
    (grant as { mediator: { profile: string } }).mediator.profile === "run-mediator", grant);
  // A resume: next epoch/fence from the real run record.
  await createRunSpec(records, "manager", first, { pins: { seed: "s", startedAt: Date.now(), yieldEvery: 1, stepBudget: 1, effectCeiling: 1, languageVersion: "1" }, createdAt: Date.now() });
  await writeRunStatus(records, "manager", first, { observedSpecRevision: 1, state: "running", holder: `${identities.supervisor.id}.${"t".repeat(16)}`, epoch: 1, fencingToken: 1, journalHigh: 1, at: Date.now() });
  const next = await outcome(authorize(attempt(first, 2, 2)));
  const stale = await outcome(authorize(attempt(first, 1, 1)));
  const future = await outcome(authorize(attempt(first, 9, 9)));
  c("a later attempt is exactly the next recorded epoch/fence; a replayed or future attempt refuses",
    typeof next === "object" && String(stale).includes("next recorded epoch") && String(future).includes("next recorded epoch"), { next, stale, future });
  // Missing / revoked / foreign admission.
  const missing = await outcome(authorize(attempt(newRun())));
  c("an attempt for a run with no admission refuses", String(missing).includes("no admission record"), missing);
  const revokedRun = newRun();
  await admit(revokedRun);
  await revokeRunAdmission(admissions, "manager", { version: 1, runId: revokedRun, by: "suite", reason: "revoked", revokedAt: Date.now() });
  const revoked = await outcome(authorize(attempt(revokedRun)));
  const revokedRead = await outcome(authorize({ operator: { id: newIdentity().id, takeoverId: "o".repeat(16), runId: revokedRun } }));
  c("a revoked run is issued no attempt and no read operator", String(revoked).includes("revoked") && String(revokedRead).includes("revoked"), { revoked, revokedRead });
  const foreignRun = newRun();
  await admit(foreignRun, mintLifecycleUid());
  const foreign = await outcome(authorize(attempt(foreignRun)));
  c("a run admitted on another manager instance refuses", String(foreign).includes("another manager instance"), foreign);
  // Registration mismatches.
  const acct = await outcome(authorize(attempt(first, 2, 2), { accountPublicKey: `A${"B".repeat(55)}` }));
  const epoch = await outcome(authorize(attempt(first, 2, 2), { processEpoch: 2 }));
  const badProof = await outcome(authorize(attempt(first, 2, 2), { registrationProof: `sha256:${"0".repeat(64)}` }));
  const profile = await outcome(authorize({ ...attempt(first, 2, 2), operator: { id: newIdentity().id, takeoverId: "x".repeat(16) } }));
  c("wrong account, stale process epoch, bad registration proof and a two-grant body all refuse",
    String(acct).includes("space and account") && String(epoch).includes("stale") && String(badProof).includes("proof does not match") && String(profile).includes("exactly one"),
    { acct, epoch, badProof, profile });
  // Operator: read pinned to an admitted run; answer only for a waiting pause.
  const read = await outcome(authorize({ operator: { id: newIdentity().id, takeoverId: "o".repeat(16), runId: first } }));
  c("a read operator is pinned to the one admitted run and holds no answer row",
    typeof read === "object" && JSON.stringify((read as { operator: { runOperator: unknown } }).operator.runOperator) === JSON.stringify({ endpoint: "manager", takeoverId: "o".repeat(16), runId: first }), read);
  const answer = await outcome(authorize({ operator: { id: newIdentity().id, takeoverId: "o".repeat(16), answers: { runId: first, stepKey: "/checkpoint:absent#0" } } }));
  c("an answering operator for a step with no open pause refuses", String(answer).includes("no open checkpoint"), answer);

  // RunHosting: the signerless callback set is all or nothing, and no local signer rides with it.
  const ctx = { space: SPACE, servers, endpoint: "manager", instanceId, holder: { id: identities.supervisor.id, lifecycleUid: mintLifecycleUid() }, auth: undefined, log: () => undefined };
  const noop = async () => { throw new Error("unused"); };
  const partial = (() => { try { new RunHosting({ ...ctx, admitRun: noop, renewRun: noop }); return "built"; } catch (e) { return (e as Error).message; } })();
  const full = (() => { try { new RunHosting({ ...ctx, admitRun: noop, issueAttempt: noop, issueOperator: noop, renewRun: noop }); return "built"; } catch (e) { return (e as Error).message; } })();
  c("RunHosting refuses a partial signerless callback set and accepts the whole set", partial.includes("needs every closed callback") && full === "built", { partial, full });
  let asked: unknown;
  const hosting = new RunHosting({ ...ctx, admitRun: noop, renewRun: noop, issueAttempt: noop, issueOperator: async (a) => { asked = { runId: a.runId, answers: a.answers }; throw new Error("host refused"); } });
  const foreignEp = await outcome(hosting.status({ runId: first, endpoint: "other" }));
  const viaHost = await outcome(hosting.status({ runId: first }));
  c("a signerless read reaches only its own endpoint and asks the host for a run-pinned operator, minting nothing locally",
    String(foreignEp).includes("own endpoint") && String(viaHost).includes("host refused") && JSON.stringify(asked) === JSON.stringify({ runId: first }), { foreignEp, viaHost, asked });
  await nc.close();
} finally {
  await killAndAwaitExit(broker);
  rmSync(sd, { recursive: true, force: true });
  release();
}
console.log(fail === 0 ? "remote-run-attempt: all cells pass" : `remote-run-attempt: ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
