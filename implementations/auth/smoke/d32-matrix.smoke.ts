/**
 * The D32 MATRIX AUDIT GATE (SPEC 13.9, broker-free): every grant builder's emitted rows are
 * pinned against a literal reviewed fixture, and the matrix's NORMATIVE GREP TESTS run over the
 * aggregate plus the minted untrusted profiles — so a future row addition or broadening FAILS
 * THE BUILD until the fixture is consciously updated (the "generated grants match the reviewed
 * matrix" gate, P1 acceptance).
 *
 * The grep tests transcribed from 13.9: (1) no UNTRUSTED profile (agent/observer/admin, plus
 * the caller/serve row sets) holds any CONSUMER.CREATE / MSG.NEXT / DIRECT.GET / STREAM.MSG.GET
 * on a control-surface resource; (2) every consumer-name token is a LITERAL — the ONLY
 * exception is the documented auth-store enumeration family (name-token wildcard rows on
 * `KV_cotal_auth_<space>`, trusted auth path only); (3) the complete STREAM.MSG.GET holder set
 * is exactly the enumerated trusted list; (4) every Direct-Get tail is fully qualified except
 * the auth path's records pair (reads feeding revision-pinned CASes, named in its builder doc);
 * (5) cross-principal namespace disjointness (the canonicalizer's dec/quar/bind families never
 * overlap the commit principal's five fact families; per-kind record writers stay disjoint).
 *
 * KNOWN RECORDED GAPS (not failures): the record-writer and timer-writer PRINCIPAL profiles are
 * not yet composed in production (their daemons are post-D14 wiring), so the writer-table's
 * records/EPT currency-read rows (`STREAM.MSG.GET` for the processEpoch / generation-deadline
 * fences) have no emitting builder yet; when those daemons land, their rows join the fixture
 * AND the holder-set test below must be consciously extended.
 */
import {
  canonicalizerGrants, canonicalizerWorkGrants, effectsBindGrants, recordWriterGrants, timerWriterGrants,
  poolOwnerBindGrants, provisionerConsumerGrants, admissionMediatorGrants, retirementCleanerGrants,
  commitPrincipalGrants, contractPublisherGrants, activatorGrants, epCallerGrantRows, epServeGrantRows,
  RECORD_KINDS, epwStreamName, epjStreamName, eptReqStreamName, epfStreamName,
  poolConsumerConfig, canonConsumerConfig, effectsConsumerConfig, timerWriterConsumerConfig,
  createSpaceAuth, mintCreds, newIdentity,
  type EpCapability,
} from "@cotal-ai/core";
import { authorityWriterGrants, authorityBarrierGrants, barrierExecutorSettlementGrants } from "../src/authority-client.js";
import { authConnectReaderGrants } from "../src/connect-reader.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };

const S = "d32m", EP = "manager", EPJ = "jobsrv", CONN = "ibxconn0123456789";
const UID = "u".repeat(26);
const cap: EpCapability = { endpoint: EP, command: "spawn", target: { mode: "owner", tOwner: "u_abc" }, journal: true };

// ---- the REVIEWED matrix fixture: principal -> exact emitted rows -----------------------------
// Regenerate deliberately when a row legitimately changes; a drift here is the audit firing.
const FIXTURE: Record<string, { publish: string[]; subscribe: string[] }> = {
  "canonicalizer": { publish: [
    "$JS.API.CONSUMER.CREATE.EPJ_d32m.canon_jobsrv.cotal.d32m.epj.jobsrv.>",
    "$JS.API.CONSUMER.INFO.EPJ_d32m.canon_jobsrv",
    "$JS.API.CONSUMER.MSG.NEXT.EPJ_d32m.canon_jobsrv",
    "$JS.ACK.EPJ_d32m.canon_jobsrv.>",
    "cotal.d32m.epw.jobsrv.>",
    "$JS.API.STREAM.MSG.GET.EPW_d32m",
  ], subscribe: [] },
  "effects-bind": { publish: [
    "$JS.API.CONSUMER.INFO.EPF_d32m.eff_jobsrv",
    "$JS.API.CONSUMER.MSG.NEXT.EPF_d32m.eff_jobsrv",
    "$JS.ACK.EPF_d32m.eff_jobsrv.>",
  ], subscribe: [] },
  "recw-svc": { publish: [
    "$JS.API.CONSUMER.CREATE.EPR_d32m.recw_d32m-svc.cotal.d32m.epr.*.*.*.svc.>",
    "$JS.API.CONSUMER.INFO.EPR_d32m.recw_d32m-svc",
    "$JS.API.CONSUMER.MSG.NEXT.EPR_d32m.recw_d32m-svc",
    "$JS.ACK.EPR_d32m.recw_d32m-svc.>",
  ], subscribe: [] },
  "recw-goal": { publish: [
    "$JS.API.CONSUMER.CREATE.EPR_d32m.recw_d32m-goal.cotal.d32m.epr.*.*.*.goal.>",
    "$JS.API.CONSUMER.INFO.EPR_d32m.recw_d32m-goal",
    "$JS.API.CONSUMER.MSG.NEXT.EPR_d32m.recw_d32m-goal",
    "$JS.ACK.EPR_d32m.recw_d32m-goal.>",
  ], subscribe: [] },
  "timerw": { publish: [
    "$JS.API.CONSUMER.CREATE.EPT_REQ_d32m.timerw_d32m.cotal.d32m.ept.*.*.*.*.schedule",
    "$JS.API.CONSUMER.INFO.EPT_REQ_d32m.timerw_d32m",
    "$JS.API.CONSUMER.MSG.NEXT.EPT_REQ_d32m.timerw_d32m",
    "$JS.ACK.EPT_REQ_d32m.timerw_d32m.>",
  ], subscribe: [] },
  "pool-owner": { publish: [
    "$JS.API.CONSUMER.INFO.EPW_d32m.pool_jobsrv_pa",
    "$JS.API.CONSUMER.MSG.NEXT.EPW_d32m.pool_jobsrv_pa",
    "$JS.ACK.EPW_d32m.pool_jobsrv_pa.>",
  ], subscribe: [] },
  "provisioner-consumers": { publish: [
    "$JS.API.CONSUMER.CREATE.EPJ_d32m.canon_jobsrv.cotal.d32m.epj.jobsrv.>",
    "$JS.API.CONSUMER.DELETE.EPJ_d32m.canon_jobsrv",
    "$JS.API.CONSUMER.CREATE.EPF_d32m.eff_jobsrv.cotal.d32m.epf.jobsrv.dec.>",
    "$JS.API.CONSUMER.DELETE.EPF_d32m.eff_jobsrv",
    "$JS.API.CONSUMER.CREATE.EPW_d32m.pool_jobsrv_pa.cotal.d32m.epw.jobsrv.pa.>",
    "$JS.API.CONSUMER.DELETE.EPW_d32m.pool_jobsrv_pa",
    "$JS.API.CONSUMER.CREATE.EPT_REQ_d32m.timerw_d32m.cotal.d32m.ept.*.*.*.*.schedule",
    "$JS.API.CONSUMER.DELETE.EPT_REQ_d32m.timerw_d32m",
  ], subscribe: [] },
  "mediator": { publish: [
    "$KV.cotal_records_d32m.oblig.*.jobsrv.>",
    "cotal.d32m.epf.jobsrv.dec.>",
    "$JS.API.STREAM.MSG.GET.KV_cotal_records_d32m",
    "$JS.API.STREAM.MSG.GET.EPF_d32m",
    "$JS.API.STREAM.MSG.GET.EPW_d32m",
    "$JS.API.STREAM.INFO.KV_cotal_records_d32m",
    "$JS.API.CONSUMER.CREATE.KV_cotal_records_d32m.medenum_jobsrv-ibxconn0123456789.$KV.cotal_records_d32m.oblig.*.jobsrv.>",
    "$JS.API.CONSUMER.INFO.KV_cotal_records_d32m.medenum_jobsrv-ibxconn0123456789",
    "$JS.API.CONSUMER.MSG.NEXT.KV_cotal_records_d32m.medenum_jobsrv-ibxconn0123456789",
    "$JS.API.CONSUMER.DELETE.KV_cotal_records_d32m.medenum_jobsrv-ibxconn0123456789",
    "$JS.API.INFO",
  ], subscribe: ["_INBOX_ibxconn0123456789.>"] },
  "cleaner": { publish: [
    "$JS.API.CONSUMER.INFO.EPW_d32m.pool_jobsrv_pa",
    "$JS.API.CONSUMER.MSG.NEXT.EPW_d32m.pool_jobsrv_pa",
    "$JS.ACK.EPW_d32m.pool_jobsrv_pa.>",
    "$JS.API.CONSUMER.INFO.EPW_d32m.pool_jobsrv_pb",
    "$JS.API.CONSUMER.MSG.NEXT.EPW_d32m.pool_jobsrv_pb",
    "$JS.ACK.EPW_d32m.pool_jobsrv_pb.>",
    "$JS.API.STREAM.MSG.GET.EPF_d32m",
    "$JS.API.INFO",
  ], subscribe: ["_INBOX_ibxconn0123456789.>"] },
  "commit": { publish: [
    "cotal.d32m.epf.jobsrv.goal.*.*.*.*.result",
    "cotal.d32m.epf.jobsrv.eff.>",
    "cotal.d32m.epf.jobsrv.receipt.>",
    "cotal.d32m.epf.jobsrv.wrk.>",
    "cotal.d32m.epf.jobsrv.cp.>",
    "$KV.cotal_records_d32m.goal.jobsrv.>",
    "$KV.cotal_records_d32m.cp.jobsrv.>",
    "$KV.cotal_records_d32m.lease.jobsrv.>",
    "$JS.API.STREAM.MSG.GET.EPF_d32m",
    "$JS.API.STREAM.MSG.GET.KV_cotal_records_d32m",
    "$JS.API.INFO",
  ], subscribe: ["_INBOX_ibxconn0123456789.>"] },
  "contract-publisher": { publish: [
    "cotal.d32m.epc.*",
    "$JS.API.DIRECT.GET.EPC_d32m.cotal.d32m.epc.>",
    "$JS.API.INFO",
  ], subscribe: ["_INBOX_ibxconn0123456789.>"] },
  "activator": { publish: [
    "$JS.API.CONSUMER.INFO.EPW_d32m.pool_jobsrv_pa",
  ], subscribe: ["_INBOX_ibxconn0123456789.>"] },
  "caller": { publish: [
    "cotal.d32m.ep.one.manager.spawn.owner.u_abc.u_abc.cli.uuuuuuuuuuuuuuuuuuuuuuuuuu.*",
    "cotal.d32m.epj.manager.spawn.owner.u_abc.u_abc.cli.uuuuuuuuuuuuuuuuuuuuuuuuuu",
  ], subscribe: [
    "cotal.d32m.ep.reply.*.*.*.u_abc.cli.uuuuuuuuuuuuuuuuuuuuuuuuuu.*",
  ] },
  "serve-rows": { publish: [
    "cotal.d32m.ep.reply.manager.iiiiiiiiiiiiiiiiiiiiiiiiii.3.*.*.*.*",
    "cotal.d32m.epe.manager.iiiiiiiiiiiiiiiiiiiiiiiiii.3.>",
    "cotal.d32m.ept.manager.iiiiiiiiiiiiiiiiiiiiiiiiii.3.*.schedule",
    "cotal.d32m.epr.manager.iiiiiiiiiiiiiiiiiiiiiiiiii.3.>",
  ], subscribe: [
    "cotal.d32m.ep.one.manager.status.> manager",
    "cotal.d32m.ep.all.manager.status.>",
    "cotal.d32m.ep.inst.manager.iiiiiiiiiiiiiiiiiiiiiiiiii.status.>",
    "cotal.d32m.ep.one.manager.describe.> manager",
    "cotal.d32m.ep.all.manager.describe.>",
    "cotal.d32m.ep.inst.manager.iiiiiiiiiiiiiiiiiiiiiiiiii.describe.>",
    "cotal.d32m.ept.manager.iiiiiiiiiiiiiiiiiiiiiiiiii.3.*.fire",
  ] },
  "auth-writer": { publish: [
    "$JS.API.INFO",
    "$JS.API.STREAM.CREATE.KV_cotal_auth_d32m",
    "$JS.API.STREAM.CREATE.KV_cotal_records_d32m",
    "$JS.API.STREAM.UPDATE.KV_cotal_records_d32m",
    "$JS.API.STREAM.INFO.KV_cotal_auth_d32m",
    "$JS.API.STREAM.INFO.KV_cotal_records_d32m",
    "$JS.API.STREAM.MSG.GET.KV_cotal_auth_d32m",
    "$JS.API.STREAM.MSG.GET.KV_cotal_records_d32m",
    "$JS.API.DIRECT.GET.KV_cotal_records_d32m",
    "$JS.API.DIRECT.GET.KV_cotal_records_d32m.>",
    "$KV.cotal_auth_d32m.gate.>",
    "$KV.cotal_auth_d32m.cred.>",
    "$KV.cotal_auth_d32m.bysrc.>",
    "$KV.cotal_records_d32m.lifecycle.>",
    "$KV.cotal_records_d32m.uid.>",
  ], subscribe: ["_INBOX_ibxconn0123456789.>"] },
  "auth-barrier": { publish: [
    "$JS.API.INFO",
    "$JS.API.STREAM.INFO.KV_cotal_auth_d32m",
    "$JS.API.STREAM.INFO.KV_cotal_records_d32m",
    "$JS.API.STREAM.MSG.GET.KV_cotal_auth_d32m",
    "$JS.API.STREAM.MSG.GET.KV_cotal_records_d32m",
    "$JS.API.DIRECT.GET.KV_cotal_records_d32m",
    "$JS.API.DIRECT.GET.KV_cotal_records_d32m.>",
    "$JS.API.CONSUMER.CREATE.KV_cotal_auth_d32m",
    "$JS.API.CONSUMER.CREATE.KV_cotal_auth_d32m.>",
    "$JS.API.CONSUMER.DURABLE.CREATE.KV_cotal_auth_d32m.>",
    "$JS.API.CONSUMER.INFO.KV_cotal_auth_d32m.>",
    "$JS.API.CONSUMER.DELETE.KV_cotal_auth_d32m.>",
    "$JS.API.CONSUMER.MSG.NEXT.KV_cotal_auth_d32m.>",
    "$KV.cotal_auth_d32m.gate.>",
    "$KV.cotal_auth_d32m.cred.>",
    "$KV.cotal_auth_d32m.stage.*",
    "$KV.cotal_records_d32m.lifecycle.>",
  ], subscribe: ["_INBOX_ibxconn0123456789.>"] },
  "auth-connect-reader": { publish: [
    "$JS.API.INFO",
    "$JS.API.STREAM.INFO.KV_cotal_auth_d32m",
    "$JS.API.STREAM.INFO.KV_cotal_records_d32m",
    "$JS.API.STREAM.MSG.GET.KV_cotal_auth_d32m",
    "$JS.API.STREAM.MSG.GET.KV_cotal_records_d32m",
  ], subscribe: ["_INBOX_ibxconn0123456789.>"] },
  "barrier-executor": { publish: [
    "cotal.d32m.epf.jobsrv.wrk.pa.>",
    "$KV.cotal_records_d32m.lease.jobsrv.pa.>",
    "cotal.d32m.epf.jobsrv.wrk.pb.>",
    "$KV.cotal_records_d32m.lease.jobsrv.pb.>",
    "$JS.API.STREAM.MSG.GET.EPF_d32m",
  ], subscribe: [] },
};

// ---- 1. regenerate every builder and pin against the fixture ----------------------------------
console.log("1. builder outputs match the reviewed fixture exactly");
const gen: Record<string, { publish: string[]; subscribe: string[] }> = {};
const put = (name: string, v: { publish?: string[]; subscribe?: string[] } | string[] | { pub: string[]; sub: string[] }) => {
  if (Array.isArray(v)) gen[name] = { publish: v, subscribe: [] };
  else if ("pub" in v) gen[name] = { publish: (v as { pub: string[] }).pub, subscribe: (v as { sub: string[] }).sub };
  else gen[name] = { publish: (v as { publish?: string[] }).publish ?? [], subscribe: (v as { subscribe?: string[] }).subscribe ?? [] };
};
put("canonicalizer", [...canonicalizerGrants(S, EPJ), ...canonicalizerWorkGrants(S, EPJ)]);
put("effects-bind", effectsBindGrants(S, EPJ));
put("recw-svc", recordWriterGrants(S, RECORD_KINDS.svc));
put("recw-goal", recordWriterGrants(S, RECORD_KINDS.goal));
put("timerw", timerWriterGrants(S));
put("pool-owner", poolOwnerBindGrants(S, EPJ, "pa"));
put("provisioner-consumers", provisionerConsumerGrants([
  { stream: epjStreamName(S), config: canonConsumerConfig(S, EPJ) },
  { stream: epfStreamName(S), config: effectsConsumerConfig(S, EPJ) },
  { stream: epwStreamName(S), config: poolConsumerConfig(S, EPJ, "pa") },
  { stream: eptReqStreamName(S), config: timerWriterConsumerConfig(S) },
]));
put("mediator", admissionMediatorGrants(S, EPJ, CONN));
put("cleaner", retirementCleanerGrants(S, EPJ, ["pa", "pb"], CONN));
put("commit", commitPrincipalGrants(S, EPJ, CONN));
put("contract-publisher", contractPublisherGrants(S, CONN));
put("activator", activatorGrants(S, EPJ, "pa", CONN));
put("caller", epCallerGrantRows(S, [cap], { owner: "u_abc", actor: "cli", uid: UID }));
put("serve-rows", epServeGrantRows(S, { endpoint: EP, instanceId: "i".repeat(26), epoch: 3, ephemeralCommands: ["status"] }));
put("auth-writer", authorityWriterGrants(S, CONN));
put("auth-barrier", authorityBarrierGrants(S, CONN));
put("auth-connect-reader", authConnectReaderGrants(S, CONN));
put("barrier-executor", { publish: barrierExecutorSettlementGrants(S, EPJ, ["pa", "pb"]).publish, subscribe: [] });

for (const name of Object.keys(FIXTURE)) {
  c(`fixture pin: ${name}`, JSON.stringify(gen[name]) === JSON.stringify(FIXTURE[name]), gen[name]);
}
c("no unreviewed principal appeared", Object.keys(gen).every((k) => FIXTURE[k] !== undefined), Object.keys(gen));

// ---- 2. the grep tests over the aggregate -----------------------------------------------------
console.log("2. the 13.9 normative grep tests");
const CS_STREAM = /(EPF_|EPW_|EPJ_|EPR_|EPT_REQ_|EPT_|EPC_|KV_cotal_records_|KV_cotal_auth_)d32m/;
const allRows: { principal: string; row: string }[] = [];
for (const [principal, v] of Object.entries(gen)) for (const row of [...v.publish, ...v.subscribe]) allRows.push({ principal, row });

// (2a) consumer-name literalness — the ONLY exception is the auth-store enumeration family.
{
  const bad: string[] = [];
  for (const { principal, row } of allRows) {
    const m = /^\$JS\.API\.CONSUMER\.(?:DURABLE\.)?(?:CREATE|INFO|MSG\.NEXT|DELETE)\.([^.]+)\.(.+)$/.exec(row);
    if (!m) continue;
    const stream = m[1], tail = m[2];
    if (stream === "KV_cotal_auth_d32m") {
      if (principal !== "auth-writer" && principal !== "auth-barrier") bad.push(`${principal}: ${row} (auth-store consumer rows are the trusted auth path's ONLY)`);
      continue; // the documented name-token-wildcard family
    }
    const name = tail.split(".")[0];
    if (name.includes("*") || name.includes(">")) bad.push(`${principal}: ${row}`);
  }
  // The bare prefix forms (`CONSUMER.CREATE.<stream>` with no tail) are auth-store-only too.
  for (const { principal, row } of allRows) {
    const m = /^\$JS\.API\.CONSUMER\.CREATE\.([^.]+)$/.exec(row);
    if (m && m[1] !== "KV_cotal_auth_d32m") bad.push(`${principal}: ${row} (a bare ephemeral-create form outside the auth store)`);
  }
  c("every consumer-name token is literal (auth-store enumeration family excepted, and confined to the auth path)", bad.length === 0, bad);
}

// (2b) the complete STREAM.MSG.GET holder set is exactly the enumerated trusted list.
{
  const holders = new Set(allRows.filter(({ row }) => row.startsWith("$JS.API.STREAM.MSG.GET."))
    .map(({ principal, row }) => `${principal}:${row.slice("$JS.API.STREAM.MSG.GET.".length)}`));
  const expected = new Set([
    "canonicalizer:EPW_d32m",
    "mediator:KV_cotal_records_d32m", "mediator:EPF_d32m", "mediator:EPW_d32m",
    "cleaner:EPF_d32m",
    "commit:EPF_d32m", "commit:KV_cotal_records_d32m",
    "auth-writer:KV_cotal_auth_d32m", "auth-writer:KV_cotal_records_d32m",
    "auth-barrier:KV_cotal_auth_d32m", "auth-barrier:KV_cotal_records_d32m",
    "auth-connect-reader:KV_cotal_auth_d32m", "auth-connect-reader:KV_cotal_records_d32m",
    "barrier-executor:EPF_d32m",
  ]);
  c("the STREAM.MSG.GET holder set equals the enumerated trusted list exactly",
    holders.size === expected.size && [...holders].every((h) => expected.has(h)), [...holders].sort());
}

// (2c) Direct-Get tails are fully qualified; the body-selected records pair is auth-path-only.
{
  const bad: string[] = [];
  for (const { principal, row } of allRows) {
    const m = /^\$JS\.API\.DIRECT\.GET\.([^.]+)(?:\.(.+))?$/.exec(row);
    if (!m) continue;
    const stream = m[1], tail = m[2];
    const bodySelected = tail === undefined || tail === ">";
    if (!bodySelected) continue; // subject-appended, broker-confined
    if (stream !== "KV_cotal_records_d32m" || (principal !== "auth-writer" && principal !== "auth-barrier"))
      bad.push(`${principal}: ${row}`);
  }
  c("body-selected Direct-Get exists ONLY as the auth path's records pair (every other tail fully qualified)", bad.length === 0, bad);
}

// (2d) cross-principal namespace disjointness on the EPF fact families.
{
  const canonSubjects = gen["canonicalizer"].publish.filter((r) => r.startsWith("cotal."));
  const commitSubjects = gen["commit"].publish.filter((r) => r.startsWith("cotal."));
  const overlap = canonSubjects.filter((r) => commitSubjects.includes(r));
  c("the canonicalizer's subject rows and the commit principal's are disjoint (dec/quar/bind vs the five commit families)",
    overlap.length === 0 && commitSubjects.every((r) => !r.includes(".dec.") && !r.includes(".quar.")), overlap);
  c("per-kind record writers stay disjoint (svc vs goal full-tail filters)",
    JSON.stringify(gen["recw-svc"]) !== JSON.stringify(gen["recw-goal"])
    && gen["recw-svc"].publish.every((r) => !r.includes(".goal.")));
  c("the cleaner holds NO write authority (no subject publish, no $KV, no wrk) and the executor carries it instead",
    gen["cleaner"].publish.every((r) => r.startsWith("$JS.")) && gen["barrier-executor"].publish.some((r) => r.includes(".wrk.")));
}

// ---- 3. the minted UNTRUSTED profiles hold nothing on control-surface resources ---------------
console.log("3. minted untrusted profiles (agent / observer / admin)");
const auth = await createSpaceAuth(S);
const decode = (creds: string): { pub: string[]; sub: string[] } => {
  const jwt = /BEGIN NATS USER JWT-+\s+(\S+)/.exec(creds)![1];
  const payload = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  const nats = (JSON.parse(Buffer.from(payload, "base64").toString()) as { nats: { pub: { allow: string[] }; sub: { allow: string[] } } }).nats;
  return { pub: nats.pub.allow ?? [], sub: nats.sub.allow ?? [] };
};
const untrusted: Record<string, { pub: string[]; sub: string[] }> = {
  agent: decode(await mintCreds(auth, newIdentity(), "agent", { principal: { owner: "u_abc", actor: "cli" }, endpointCapabilities: [cap], lifecycleUid: UID })),
  observer: decode(await mintCreds(auth, newIdentity(), "observer", { principal: { owner: "u_abc", actor: "obs" } })),
  admin: decode(await mintCreds(auth, newIdentity(), "admin", { principal: { owner: "u_abc", actor: "adm" } })),
};
for (const [profile, rows] of Object.entries(untrusted)) {
  const reach = [...rows.pub, ...rows.sub].filter((r) =>
    CS_STREAM.test(r) && /(CONSUMER\.CREATE|CONSUMER\.MSG\.NEXT|DIRECT\.GET|STREAM\.MSG\.GET)/.test(r));
  c(`${profile}: no CONSUMER.CREATE/MSG.NEXT/DIRECT.GET/STREAM.MSG.GET on any control-surface stream`, reach.length === 0, reach);
  const kvWrites = rows.pub.filter((r) => r.startsWith("$KV.cotal_records_d32m") || r.startsWith("$KV.cotal_auth_d32m"));
  c(`${profile}: no records/auth KV write rows`, kvWrites.length === 0, kvWrites);
}
c("the agent's control-surface reach is exactly its caller rows (request/journal publish + own reply rail)",
  untrusted.agent.pub.filter((r) => r.includes(".ep.") || r.includes(".epj.")).every((r) => gen["caller"].publish.includes(r))
  && untrusted.agent.sub.filter((r) => r.includes(".ep.reply.")).every((r) => gen["caller"].subscribe.includes(r)));

console.log(fail === 0 ? `\nD32 MATRIX AUDIT OK ✅  (${ok} passed, ${fail} failed)` : `\nD32 MATRIX AUDIT FAILED ❌  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
