/** Signerless first-run admission on a real broker: a registered manager forwards the served v1
 *  run-start subject; the host resolves the REAL issued store and writes the admission itself. */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  admissionBucket, epRequestSubject, ensureAdmissionStore, ensureIssuedStores, issuedBucket, mintGeneration,
  mintLifecycleUid, newIdentity, openIssuedStore, readRunAdmission, remoteManagerActors, type IssuedSourceRef,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { admitRemoteRun } from "../src/manager-authority.js";
import { remoteManagerCurrentRegistrationProof } from "../src/retained-manager-validation.js";
import { pickFreePort } from "./_free-port.js";

let fail = 0;
const c = (name: string, ok: boolean, detail?: unknown) => { if (ok) console.log(`  ✓ ${name}`); else { fail++; console.log(`  ✗ FAIL: ${name}`, detail ?? ""); } };
const outcome = (p: Promise<unknown>) => p.then(() => "admitted", (e: Error) => `refused: ${e.message}`);

const SPACE = "admit";
const OWNER = "local";
const ACCOUNT = "AACCOUNT";
const SECRET = "suite-proof-secret";
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const release = teardownOnSignal(broker, sd);
try {
  const servers = `nats://127.0.0.1:${PORT}`;
  await awaitBrokerReady(() => connect({ servers }).then((n) => n.close().then(() => true), () => false), { servers, attempts: 50, delayMs: 100 });
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const jsm = await jetstreamManager(nc);
  const kvm = new Kvm(nc);
  await ensureIssuedStores(jsm, kvm, SPACE);
  await ensureAdmissionStore(jsm, kvm, SPACE);
  const issued = openIssuedStore(await kvm.open(issuedBucket(SPACE)), jsm, SPACE);
  const admissions = await kvm.open(admissionBucket(SPACE));

  const instanceId = mintLifecycleUid();
  const lifecycleUid = mintLifecycleUid();
  const identities = { supervisor: { id: newIdentity().id }, executor: { id: newIdentity().id }, serve: { id: newIdentity().id }, goalWriter: { id: newIdentity().id }, sessionLedger: { id: newIdentity().id } };
  const gate = { state: "open" as const, principal: `${OWNER}.${remoteManagerActors(instanceId).serve}`, processEpoch: 3, registrationRevision: 7 };
  const base = { v: 1, kind: "manager-run-admission", space: SPACE, actor: "cli", instanceId, managerLifecycleUid: lifecycleUid, accountPublicKey: ACCOUNT, processEpoch: 3, identities } as const;
  const proof = remoteManagerCurrentRegistrationProof(SECRET, OWNER, base, gate);

  const liveKeys = new Set<string>(["gate-a"]);
  const source: IssuedSourceRef = { space: SPACE, bucket: "cotal_lifecycle_admit", key: "gate-a" };
  async function issue(actor: string, publish: "run-start" | "none", sources: IssuedSourceRef[] = [source]) {
    const ref = { space: SPACE, owner: OWNER, actor, uid: mintLifecycleUid(), generation: mintGeneration() };
    const allow = publish === "none" ? { mode: "none" } as const : { mode: "patterns", patterns: [`cotal.${SPACE}.ep.v1.inst.manager.*.run-start.${OWNER}.${actor}.>`] } as const;
    const prepared = await issued.stage({ version: 1, ref, sources, permissions: { publish: { allow, deny: [] }, subscribe: { allow: { mode: "none" }, deny: [] } }, ...(sources.length ? {} : { expiresAt: Math.floor(Date.now() / 1000) + 600 }) });
    await issued.release(prepared, async () => {});
    return ref;
  }
  const subjectFor = (caller: { owner: string; actor: string; uid: string; generation?: string }, over: { space?: string; command?: string; instance?: string } = {}) =>
    epRequestSubject(over.space ?? SPACE, { route: { mode: "inst", instanceId: over.instance ?? instanceId }, endpoint: "manager", command: over.command ?? "run-start", caller: caller as never, nonce: "n".repeat(24) });
  const runId = () => `run-${Buffer.from(mintGeneration().slice(0, 16)).toString("hex").slice(0, 32)}`;
  const admit = (run: { runId: string; subject: string }, over: Record<string, unknown> = {}, gateOver: Partial<typeof gate> | null = {}) => admitRemoteRun({
    request: { ...base, requestId: `req-${run.runId}`, registrationProof: proof, run, ...over },
    owner: OWNER, space: SPACE, accountPublicKey: ACCOUNT, proofSecret: SECRET, endpoint: "manager",
    observeManagerGate: async () => gateOver === null ? null : { ...gate, ...gateOver },
    issued, sourceIsLive: async (s) => liveKeys.has(s.key), admissions,
  });
  const absent = async (id: string) => (await admissions.get(`admission.v1.manager.${id}`)) === null;

  // Positive: a real issued generation admits and the written record carries ITS evidence ceiling.
  const alice = await issue("alice", "run-start");
  const okRun = runId();
  const okSubject = subjectFor(alice);
  const result = await admitRemoteRun({
    request: { ...base, requestId: "req-ok", registrationProof: proof, run: { runId: okRun, subject: okSubject } },
    owner: OWNER, space: SPACE, accountPublicKey: ACCOUNT, proofSecret: SECRET, endpoint: "manager",
    observeManagerGate: async () => gate, issued, sourceIsLive: async (s) => liveKeys.has(s.key), admissions,
  }).catch((e: Error) => e);
  const view = await readRunAdmission(jsm, SPACE, "manager", okRun).catch((e: Error) => e);
  c("a registered manager's forwarded v1 run-start admits under the caller's real issued generation",
    !(result instanceof Error) && !(view instanceof Error) && view.admission.provenance.kind === "issued" &&
    view.admission.provenance.ref.generation === alice.generation && view.admission.caller.actor === "alice" &&
    view.admission.ceiling.publish.allow.mode === "patterns" && view.admission.instanceId === instanceId, { result, view });
  const retry = await admit({ runId: okRun, subject: okSubject }).catch((e: Error) => e);
  c("an exact retry returns the written admission unchanged",
    !(retry instanceof Error) && !(result instanceof Error) && retry.revision === result.revision && retry.admission.admittedAt === result.admission.admittedAt, retry);
  const bob = await issue("bob", "run-start");
  const hijack = await outcome(admit({ runId: okRun, subject: subjectFor(bob) }));
  const still = await readRunAdmission(jsm, SPACE, "manager", okRun);
  c("a retry naming another caller cannot alter an already written admission",
    hijack.includes("already admitted for another caller") && still.admission.caller.actor === "alice", hijack);

  // Forged generation: never issued.
  const forged = runId();
  const f = await outcome(admit({ runId: forged, subject: subjectFor({ ...alice, generation: mintGeneration() }) }));
  c("a forged (never issued) generation refuses and writes nothing", f.startsWith("refused") && await absent(forged), f);
  // Legacy subject: no generation.
  const legacy = runId();
  const l = await outcome(admit({ runId: legacy, subject: subjectFor({ owner: OWNER, actor: "alice", uid: alice.uid }) }));
  c("a legacy-rail (unbound) caller refuses before any write", l.includes("issued caller") && await absent(legacy), l);
  // Revoked generation.
  const carol = await issue("carol", "run-start");
  await issued.retire(carol);
  const revoked = runId();
  const rv = await outcome(admit({ runId: revoked, subject: subjectFor(carol) }));
  c("a revoked generation refuses and writes nothing", rv.includes("revoked") && await absent(revoked), rv);
  // Stale source.
  const dave = await issue("dave", "run-start", [{ ...source, key: "gate-d" }]);
  const stale = runId();
  const st = await outcome(admit({ runId: stale, subject: subjectFor(dave) }));
  c("a generation whose source is no longer live refuses", st.includes("no longer live") && await absent(stale), st);
  // Ceiling does not permit run-start.
  const erin = await issue("erin", "none");
  const narrow = runId();
  const nr = await outcome(admit({ runId: narrow, subject: subjectFor(erin) }));
  c("an issued ceiling that does not permit this run-start subject refuses", nr.includes("does not permit") && await absent(narrow), nr);
  // Foreign space / instance / command subjects.
  const fs = runId();
  const foreignSpace = await outcome(admit({ runId: fs, subject: subjectFor(alice, { space: "other" }) }));
  c("a subject of another space refuses", foreignSpace.startsWith("refused") && await absent(fs), foreignSpace);
  const fi = runId();
  const foreignInst = await outcome(admit({ runId: fi, subject: subjectFor(alice, { instance: mintLifecycleUid() }) }));
  c("a subject addressed to another manager instance refuses", foreignInst.includes("instance") && await absent(fi), foreignInst);
  const fc = runId();
  const otherCmd = await outcome(admit({ runId: fc, subject: subjectFor(alice, { command: "run-resume" }) }));
  c("a subject of another command refuses", otherCmd.includes("run-start") && await absent(fc), otherCmd);
  // Registration mismatches refuse before any write.
  const reg = runId();
  const run = { runId: reg, subject: subjectFor(alice) };
  const acct = await outcome(admit(run, { accountPublicKey: "AOTHER" }));
  const epoch = await outcome(admit(run, { processEpoch: 2 }));
  const noGate = await outcome(admit(run, {}, null));
  const foreignOwner = await outcome(admit(run, {}, { principal: `other.${remoteManagerActors(instanceId).serve}` }));
  const badProof = await outcome(admit(run, { registrationProof: `sha256:${"0".repeat(64)}` }));
  const ceilingField = await outcome(admit(run, { ceiling: { publish: { allow: { mode: "all" }, deny: [] } } }));
  c("account, stale epoch, missing gate, foreign owner, bad proof and a caller-supplied ceiling all refuse before any write",
    acct.includes("space and account") && epoch.includes("stale") && noGate.includes("no open registration gate") &&
    foreignOwner.includes("another owner") && badProof.includes("proof does not match") && ceilingField.includes("unknown field ceiling") && await absent(reg),
    { acct, epoch, noGate, foreignOwner, badProof, ceilingField });
  await nc.close();
} finally {
  await killAndAwaitExit(broker);
  rmSync(sd, { recursive: true, force: true });
  release();
}
console.log(fail === 0 ? "remote-run-admission: all cells pass" : `remote-run-admission: ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
