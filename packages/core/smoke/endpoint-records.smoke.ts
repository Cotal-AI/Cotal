/**
 * v0.4 record-contract smoke — the §13.4/§13.7 record discipline against a real KV: pinned
 * kind key grammars, split-key CAS with LOUD conflicts, the merged read's staleness rules
 * (stale-but-valid projection vs lagging-spec re-read vs torn state), the atomic lifecycle
 * head, and the snapshot-then-deltas watch that resyncs rather than patching across a gap.
 *
 * Run: pnpm smoke:ep-records   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import {
  isReachable, EpEnvelopeError,
  RECORD_KINDS, LIFECYCLE_HEAD, registerRecordKind,
  recordSpecKey, recordStatusKey, recordAtomicKey, parseRecordKey,
  createRecordEntry, updateRecordEntry, assertStatusValue,
  readRecord, readAtomicRecord, watchRecord, openRecordsBucket,
  type MergedRecord,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const throws = (n: string, fn: () => unknown, code?: string) => {
  try { fn(); c(n, false, "no throw"); }
  catch (e) { c(n, code ? e instanceof EpEnvelopeError && e.code === code : true, (e as Error).message); }
};
const rejects = async (n: string, code: string, p: Promise<unknown>) => {
  try { await p; c(n, false, "no throw"); }
  catch (e) { c(n, e instanceof EpEnvelopeError && e.code === code, (e as Error).message); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const IID = "i".repeat(26);
const UID = "u".repeat(26);

// ── key grammar: build + parse against the §13.7 table (broker-free) ──
c("svc spec key", recordSpecKey(RECORD_KINDS.svc, ["manager", IID]) === `svc.manager.${IID}.spec`);
c("goal status key carries the caller triple",
  recordStatusKey(RECORD_KINDS.goal, ["manager", "u_abc", "cli", UID, "g1"]) === `goal.manager.u_abc.cli.${UID}.g1.status`);
c("lease key is the acceptance identity",
  recordSpecKey(RECORD_KINDS.lease, ["manager", "builds", "u_abc", "cli", UID, "req-9"]) === `lease.manager.builds.u_abc.cli.${UID}.req-9.spec`);
c("the lifecycle head is one atomic key", recordAtomicKey(LIFECYCLE_HEAD, ["u_abc", "worker"]) === "lifecycle.u_abc.worker");
c("a dotted endpoint tokenizes in the key", recordSpecKey(RECORD_KINDS.contracts, ["com.acme.deploy"]) === "contracts.com_acme_deploy.spec");
throws("the head has no .spec key", () => recordSpecKey(LIFECYCLE_HEAD, ["u_abc", "worker"]));
throws("a split kind has no atomic key", () => recordAtomicKey(RECORD_KINDS.svc, ["manager", IID]));
throws("wrong qualifier arity throws", () => recordSpecKey(RECORD_KINDS.svc, ["manager"]));
throws("a grammar-breaking qualifier throws", () => recordSpecKey(RECORD_KINDS.svc, ["manager", "not-a-lifecycle-token"]));
const pSpec = parseRecordKey(`svc.manager.${IID}.spec`);
c("spec key parses", pSpec?.def.kind === "svc" && pSpec.part === "spec" && pSpec.qualifiers[1] === IID);
c("head key parses as atomic", parseRecordKey("lifecycle.u_abc.worker")?.part === "atomic");
c("detail key parses as split", parseRecordKey(`lifecycle.u_abc.worker.${UID}.status`)?.part === "status");
c("unknown kind parses null", parseRecordKey("mystery.a.b.spec") === null);
c("wrong arity parses null", parseRecordKey("svc.manager.spec") === null);
throws("a single-label third-party kind is refused", () => registerRecordKind({
  kind: "widget", qualifiers: [], split: true, writers: { spec: "x", status: "x" }, mediation: "direct",
}));
const custom = registerRecordKind({
  kind: "com.acme.widget", qualifiers: [], split: true, writers: { spec: "acme", status: "acme" }, mediation: "direct",
});
c("a reverse-DNS kind registers under its token", custom.kind === "com_acme_widget" && recordSpecKey(custom, []) === "com_acme_widget.spec");
throws("re-registration at the same arity is refused", () => registerRecordKind({
  kind: "com.acme.widget", qualifiers: [], split: true, writers: { spec: "x", status: "x" }, mediation: "direct",
}));
throws("a status value without observedSpecRevision is refused at the write seam", () => assertStatusValue({ state: "up" }));
c("a status value with observedSpecRevision passes", assertStatusValue({ state: "up", observedSpecRevision: 3 }).observedSpecRevision === 3);

// ── the live half: CAS, merged read, head, watch ──
const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-eprec-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  c("broker is reachable", up);
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const kv = await openRecordsBucket(nc, "eprec", { create: true });

  const svc = RECORD_KINDS.svc;
  const q = ["manager", IID];
  const sKey = recordSpecKey(svc, q);
  const tKey = recordStatusKey(svc, q);

  // CAS discipline: create-only, then revision-pinned; a lost race is a LOUD conflict.
  const rev1 = await createRecordEntry(kv, sKey, { endpoint: "manager", owner: "operator" });
  c("create returns the revision", rev1 > 0);
  await rejects("re-create is a loud conflict", "conflict", createRecordEntry(kv, sKey, { x: 1 }));
  await rejects("a stale-revision update is a loud conflict", "conflict", updateRecordEntry(kv, sKey, { x: 2 }, rev1 + 99));
  const rev2 = await updateRecordEntry(kv, sKey, { endpoint: "manager", owner: "operator", generation: 2 }, rev1);
  c("a revision-pinned update advances", rev2 > rev1);

  // Merged read: current, stale-but-valid projection, torn state, lagging spec.
  await createRecordEntry(kv, tKey, assertStatusValue({ state: "up", observedSpecRevision: rev2 }));
  const cur = await readRecord<{ generation?: number }, { state: string }>(kv, svc, q);
  c("merged read returns both halves, current", cur?.spec.revision === rev2 && cur.status?.value.state === "up" && !cur.staleProjection);
  const rev3 = await updateRecordEntry(kv, sKey, { endpoint: "manager", generation: 3 }, rev2);
  const stale = await readRecord(kv, svc, q);
  c("an old observedSpecRevision is a STALE-BUT-VALID projection, not an error",
    stale?.staleProjection === true && stale.spec.revision === rev3);
  const missing = await readRecord(kv, svc, ["manager", "z".repeat(26)]);
  c("an absent record reads undefined", missing === undefined);
  const tornKey = recordStatusKey(svc, ["manager", "t".repeat(26)]);
  await createRecordEntry(kv, tornKey, assertStatusValue({ state: "ghost", observedSpecRevision: 1 }));
  await rejects("a status without its spec is torn state", "failed-precondition",
    readRecord(kv, svc, ["manager", "t".repeat(26)]));
  await kv.put(sKey, new TextEncoder().encode("not-json"));
  await rejects("a garbled record value fails loud", "internal", readRecord(kv, svc, q));
  await updateRecordEntry(kv, sKey, { endpoint: "manager", generation: 4 }, (await kv.get(sKey))!.revision);

  // Lagging spec: the status writer observed a spec revision this replica has not served yet.
  // Never trust the mismatched pair: bounded re-reads until caught up, else deadline-exceeded.
  const specNow = (await kv.get(sKey))!.revision;
  await kv.put(tKey, new TextEncoder().encode(JSON.stringify({ state: "ahead", observedSpecRevision: specNow + 2 })));
  await rejects("a lagging spec read that never catches up is deadline-exceeded", "deadline-exceeded",
    readRecord(kv, svc, q, { deadlineMs: 900 }));
  const catchUp = readRecord(kv, svc, q, { deadlineMs: 8000 });
  await wait(300);
  await kv.put(sKey, new TextEncoder().encode(JSON.stringify({ endpoint: "manager", generation: 5 })));
  await kv.put(sKey, new TextEncoder().encode(JSON.stringify({ endpoint: "manager", generation: 6 })));
  const caught = await catchUp;
  c("a lagging spec read resolves once the spec catches up",
    caught !== undefined && caught.spec.revision >= caught.status!.observedSpecRevision);

  // The atomic head: plain read + CAS advance (a FENCE is always the CAS write, never a read).
  const headKey = recordAtomicKey(LIFECYCLE_HEAD, ["u_abc", "worker"]);
  const h1 = await createRecordEntry(kv, headKey, { lifecycleUid: UID, state: "active", processEpoch: 1 });
  const head = await readAtomicRecord<{ state: string }>(kv, LIFECYCLE_HEAD, ["u_abc", "worker"]);
  c("the head reads atomically", head?.value.state === "active" && head.revision === h1);
  await rejects("a stale head CAS loses loudly (activation/retirement serialize here)", "conflict",
    updateRecordEntry(kv, headKey, { state: "retired" }, h1 + 99));
  await updateRecordEntry(kv, headKey, { lifecycleUid: UID, state: "retired" }, h1);
  c("the head CAS advances at the pinned revision", (await readAtomicRecord<{ state: string }>(kv, LIFECYCLE_HEAD, ["u_abc", "worker"]))?.value.state === "retired");

  // Watch: snapshot first, re-merged view per delta, ends on spec delete.
  const wq = ["manager", "w".repeat(26)];
  const wSpec = recordSpecKey(svc, wq);
  const wStatus = recordStatusKey(svc, wq);
  const wRev = await createRecordEntry(kv, wSpec, { generation: 1 });
  const seen: MergedRecord[] = [];
  const done = (async () => {
    for await (const m of watchRecord(kv, svc, wq)) seen.push(m);
  })();
  await wait(400);
  await createRecordEntry(kv, wStatus, assertStatusValue({ state: "up", observedSpecRevision: wRev }));
  await wait(400);
  await kv.put(wSpec, new TextEncoder().encode(JSON.stringify({ generation: 2 })));
  await wait(400);
  await kv.delete(wSpec);
  await Promise.race([done, wait(3000).then(() => { throw new Error("watch did not end on spec delete"); })]);
  c("watch delivered the snapshot first", seen.length >= 3 && seen[0].status === undefined && !seen[0].staleProjection);
  c("watch re-merged the status delta", seen.some((m) => m.status?.observedSpecRevision === wRev && !m.staleProjection));
  c("watch classified the spec bump as a stale projection", seen.some((m) => m.staleProjection));
  c("watch ended when the spec was deleted", true);

  await nc.drain().catch(() => {});
  console.log(`\nENDPOINT RECORDS SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
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
