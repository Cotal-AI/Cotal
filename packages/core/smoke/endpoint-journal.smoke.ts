/**
 * v0.4 journal-contract smoke — the §13.4 discipline against a real broker: fingerprint
 * determinism and omission rules, the caller-scoped create-only decision CAS (first decision
 * wins atomically, losers read the winner, distinct callers never squat each other's ids),
 * fact shapes with their validators, size preflight, and plain (dedupe-header-free) appends.
 *
 * Run: pnpm smoke:ep-journal   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import {
  isReachable, EpEnvelopeError,
  submissionFingerprint, epfDecisionSubject, epfQuarantineSubject, epfGoalBindSubject,
  epjStreamName, epfStreamName, canonDurable,
  parseDecisionFact, parseQuarantineFact, assertFactFits,
  appendSubmission, publishFactCreateOnly, readLastFact,
  epjSubject, epRequestSubject, parseEpSubject,
  type AcceptanceFact, type RejectionFact, type QuarantineFact, type ParsedEpRequest, type EpCaller,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const throws = (n: string, fn: () => unknown) => { try { fn(); c(n, false, "no throw"); } catch { c(n, true); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const UID = "u".repeat(26);
const caller: EpCaller = { owner: "u_abc", actor: "worker", uid: UID };
const caller2: EpCaller = { owner: "u_zed", actor: "worker", uid: "z".repeat(26) };
const NONCE = "n".repeat(24);
const D = `sha256:${"a".repeat(64)}`;

// ── fingerprint (broker-free) ──
const subj = parseEpSubject(epRequestSubject("demo", { route: { mode: "one" }, endpoint: "manager", command: "spawn", caller, nonce: NONCE })) as ParsedEpRequest;
const sub1 = { v: 1, id: "req-1", op: { endpoint: "manager", command: "spawn", inputDigest: D, outputDigest: D }, class: "journal", replyExpected: false, deadlineMs: 5000, args: { name: "x" }, from: { id: "u_abc.worker", name: "w" } };
const f1 = submissionFingerprint(sub1, subj);
c("fingerprint is deterministic", f1.fingerprint === submissionFingerprint({ ...sub1 }, subj).fingerprint);
c("the caller identity rides the SUBJECT, not the body",
  (f1.object.caller as { id: string }).id === "u_abc.worker" && (f1.object.caller as { lifecycleUid: string }).lifecycleUid === UID);
c("absent args are OMITTED, never null (changes the digest)",
  submissionFingerprint({ ...sub1, args: undefined }, subj).fingerprint !== f1.fingerprint
  && !("args" in submissionFingerprint({ ...sub1, args: undefined }, subj).object));
c("an incomplete envelope fingerprints the subset it carries",
  typeof submissionFingerprint({ id: "req-1" }, subj).fingerprint === "string"
  && !("class" in submissionFingerprint({ id: "req-1" }, subj).object));
c("authDigest joins the fingerprint iff auth is present",
  "authDigest" in submissionFingerprint({ ...sub1, auth: "{}" }, subj).object && !("authDigest" in f1.object));
const targeted = parseEpSubject(epRequestSubject("demo", { route: { mode: "one" }, endpoint: "manager", command: "stop", target: { mode: "owner", tOwner: "u_abc" }, caller, nonce: NONCE })) as ParsedEpRequest;
c("the authz mode rides the subject into the fingerprint",
  submissionFingerprint(sub1, targeted).object.authz === "owner");
throws("a lone-surrogate auth slot has NO fingerprint (quarantine path)",
  () => submissionFingerprint({ ...sub1, auth: "\ud800" }, subj));
c("wrong-typed carried auth is fingerprinted AS CARRIED, never collapsed onto absent",
  submissionFingerprint({ ...sub1, auth: null }, subj).fingerprint !== f1.fingerprint
  && submissionFingerprint({ ...sub1, auth: 123 }, subj).fingerprint !== f1.fingerprint
  && submissionFingerprint({ ...sub1, auth: null }, subj).fingerprint !== submissionFingerprint({ ...sub1, auth: 123 }, subj).fingerprint);

// ── fact shapes (broker-free) ──
const acc: AcceptanceFact = {
  v: 1, id: "req-1", decision: "accepted", fingerprint: f1.fingerprint,
  request: sub1 as unknown as Record<string, unknown>,
  caller: { id: "u_abc.worker", lifecycleUid: UID },
  contractDigests: { input: D, output: D }, authzDecision: { revision: 3, epoch: 1 },
  route: "effects", sourceSeq: 7, ts: 1_720_600_000_000,
};
c("an acceptance fact validates", (parseDecisionFact(acc) as AcceptanceFact).route === "effects");
const pooled: AcceptanceFact = { ...acc, route: "pool.builds", workExpiry: 1_720_600_100_000 };
c("a pool-routed acceptance carries its workExpiry", (parseDecisionFact(pooled) as AcceptanceFact).workExpiry === 1_720_600_100_000);
throws("a pool route WITHOUT workExpiry refuses", () => parseDecisionFact({ ...acc, route: "pool.builds" }));
throws("an effects route WITH workExpiry refuses", () => parseDecisionFact({ ...acc, workExpiry: 5 }));
const rej: RejectionFact = {
  v: 1, id: "req-1", decision: "rejected", fingerprint: f1.fingerprint,
  error: { code: "conflict", detail: "same id, different fingerprint" },
  caller: { id: "u_abc.worker", lifecycleUid: UID }, sourceSeq: 8, ts: 1_720_600_000_001,
};
c("a rejection fact validates (as durable as acceptance)", parseDecisionFact(rej).decision === "rejected");
throws("an over-256-byte error detail refuses", () => parseDecisionFact({ ...rej, error: { code: "conflict", detail: "x".repeat(257) } }));
throws("an off-catalog error code refuses", () => parseDecisionFact({ ...rej, error: { code: "Oops" } }));
const quar: QuarantineFact = {
  v: 1, decision: "quarantined", sourceSeq: 9,
  submissionDigest: D, error: { code: "bad-request", detail: "not canonicalizable I-JSON" }, ts: 1_720_600_000_002,
};
c("a quarantine fact validates (no id, no fingerprint required)", parseQuarantineFact(quar).sourceSeq === 9);
c("size preflight passes a bounded fact", assertFactFits(rej, 1024 * 1024).length > 0);
throws("size preflight refuses an acceptance that cannot fit", () => assertFactFits(acc, 64));

// ── the decision CAS + plain appends (real broker) ──
const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-epjrn-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  c("broker is reachable", up);
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  // The smoke is its own composition root: the two §13.12 streams (full config lands with the
  // 13.12 binding slice; here: capture subjects + allow_direct for the fact reads).
  await jsm.streams.add({ name: epjStreamName("epjrn"), subjects: ["cotal.epjrn.epj.>"] });
  await jsm.streams.add({ name: epfStreamName("epjrn"), subjects: ["cotal.epjrn.epf.>"], allow_direct: true });
  c("stream names are the 13.12 forms", epjStreamName("epjrn") === "EPJ_epjrn" && canonDurable("manager") === "canon_manager");

  // Plain append: no dedupe header of any kind on the stored copy.
  const jSubj = epjSubject("epjrn", { endpoint: "manager", command: "spawn", caller });
  const { seq } = await appendSubmission(js, jSubj, sub1);
  c("a submission appends plain", seq === 1);
  // Harness inspection via the classic MSG.GET (EPJ deliberately has no allow_direct, §13.12).
  const stored = await jsm.streams.getMessage(epjStreamName("epjrn"), { last_by_subj: jSubj });
  c("the stored copy carries NO Nats-Msg-Id (native dedupe never relied upon)",
    stored !== null && !stored.header?.get("Nats-Msg-Id"));

  // First decision wins atomically; the loser reads the winner instead of deciding again.
  const dSubj = epfDecisionSubject("epjrn", subj, "req-1");
  const w1 = await publishFactCreateOnly(js, dSubj, assertFactFits(acc, 1024 * 1024));
  c("the first decision wins its CAS", w1.won);
  const w2 = await publishFactCreateOnly(js, dSubj, assertFactFits(rej, 1024 * 1024));
  c("a second decision on the same subject LOSES", !w2.won);
  const winner = parseDecisionFact(await readLastFact(jsm, epfStreamName("epjrn"), dSubj));
  c("the loser reads the winning fact (accepted, not the late rejection)", winner.decision === "accepted");

  // Distinct callers can never squat each other's ids: the caller triple is in the subject.
  const subj2 = parseEpSubject(epRequestSubject("demo", { route: { mode: "one" }, endpoint: "manager", command: "spawn", caller: caller2, nonce: NONCE })) as ParsedEpRequest;
  const w3 = await publishFactCreateOnly(js, epfDecisionSubject("epjrn", subj2, "req-1"),
    assertFactFits({ ...rej, caller: { id: "u_zed.worker", lifecycleUid: caller2.uid } }, 1024 * 1024));
  c("the same id under another caller is a DIFFERENT subject and wins", w3.won);

  // Quarantine + goal-bind families: disjoint namespaces, same create-only discipline.
  const qSubj = epfQuarantineSubject("epjrn", "manager", seq);
  c("quarantine keys on the source sequence", qSubj.endsWith(`.quar.${seq}`));
  const wq = await publishFactCreateOnly(js, qSubj, assertFactFits(quar, 1024 * 1024));
  c("a quarantine fact publishes create-only", wq.won);
  c("the goal-bind subject is the caller-scoped .bind leaf",
    epfGoalBindSubject("epjrn", subj, "g1") === `cotal.epjrn.epf.manager.goal.u_abc.worker.${UID}.g1.bind`);
  c("fact subjects derive STRUCTURALLY from the authenticated request (no body argument exists)",
    dSubj === `cotal.epjrn.epf.manager.dec.u_abc.worker.${UID}.req-1`);
  const wg = await publishFactCreateOnly(js, epfGoalBindSubject("epjrn", subj, "g1"),
    new TextEncoder().encode(JSON.stringify({ v: 1, fingerprint: f1.fingerprint })));
  const wg2 = await publishFactCreateOnly(js, epfGoalBindSubject("epjrn", subj, "g1"),
    new TextEncoder().encode(JSON.stringify({ v: 1, fingerprint: "sha256:" + "b".repeat(64) })));
  c("the goal bind is first-wins (a second id naming one goal stops BEFORE acceptance)", wg.won && !wg2.won);

  await nc.drain().catch(() => {});
  console.log(`\nENDPOINT JOURNAL SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
  if (fail > 0) process.exitCode = 1;
} catch (e) {
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  if (broker.pid) { try { process.kill(broker.pid, "SIGKILL"); } catch { /* gone */ } }
  await wait(200);
  rmSync(sd, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
