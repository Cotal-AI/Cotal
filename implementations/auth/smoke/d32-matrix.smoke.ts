/**
 * The D32 MATRIX AUDIT GATE (SPEC 13.9, broker-free): every grant builder's emitted rows are
 * pinned against a literal reviewed fixture, and the matrix's NORMATIVE GREP TESTS run over the
 * aggregate plus the minted untrusted profiles — so a future row addition or broadening FAILS
 * THE BUILD until the fixture is consciously updated (the "generated grants match the reviewed
 * matrix" gate, P1 acceptance).
 *
 * The grep tests transcribed from 13.9: (1) no UNTRUSTED profile (agent/observer/admin, plus
 * the caller/serve row sets) holds any CONSUMER.CREATE / MSG.NEXT / DIRECT.GET / STREAM.MSG.GET
 * on a control-surface resource; (2) every consumer-name token is a LITERAL, NO exceptions,
 * and the AUTHORITY-stream (`KV_cotal_auth_<space>`, `KV_cotal_records_<space>`) consumer
 * surface is EXACTLY: the two SEALED scanner profiles (the sole DYNAMIC-ENUMERATION creates,
 * each pinned to its one literal name with its CREATE filter confined; sites 1-3,
 * nats-server#8274, the auth path's former name-wildcard enumeration family is GONE) plus the
 * provisioner's pre-created full-tail records-READER durables (CREATE+DELETE only, the 13.9
 * provisioning row); (3) the complete STREAM.MSG.GET holder set
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
  recordReaderConfig, recordsKvStreamName, readerBindGrants,
  AUTHORITY_KIND_DEFS, callerReadableRecordKind,
  createSpaceAuth, mintCreds, newIdentity, permissionsFor, DEV_OWNER,
  type EpCapability,
} from "@cotal-ai/core";
import { authorityWriterGrants, authorityBarrierGrants, barrierExecutorSettlementGrants } from "../src/authority-client.js";
import { retirementExecutorClientGrants } from "../src/retirement-cleaner.js";
import { drainApplierGrants, drainCancellerGrants, drainReconcilerGrants } from "../src/drain-repair.js";
import { authAdminListenerGrants } from "../src/auth-admin.js";
import { authConnectReaderGrants } from "../src/connect-reader.js";
import { authorityScannerGrants } from "../src/ledger-scanner.js";
import { recordsScannerGrants } from "../src/records-scanner.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };

const S = "d32m", EP = "manager", EPJ = "jobsrv", CONN = "ibxconn0123456789";
const SC_SID = "sessfixture0123456789ab"; // P2 item 6: a fixed session id for the session-caller fixture row
const UID = "u".repeat(26);
const cap: EpCapability = { endpoint: EP, command: "spawn", target: { mode: "owner", tOwner: "u_abc" }, journal: true };

// C6 (critic + fact): cross-principal disjointness needs a real NATS-pattern INTERSECTION, not
// exact string equality (a broadened `epf.<e>.goal.>` SUBSUMES a narrower `…goal.*.*.*.*.bind`
// while never string-equalling it) nor a substring deny (an open ancestor `epf.<e>.>` covers
// `.dec.`/`.quar.` without containing the substring). `subjectsOverlap` is true when SOME concrete
// subject matches both patterns: token-walk where `>` (tail) matches any non-empty remainder, `*`
// matches one token, literals must be equal. The subject's optional ` queue` suffix is stripped.
function subjectsOverlap(a: string, b: string): boolean {
  const ta = a.split(" ")[0].split("."), tb = b.split(" ")[0].split(".");
  const walk = (x: string[], y: string[]): boolean => {
    if (x.length === 0 && y.length === 0) return true;
    if (x.length === 0 || y.length === 0) return false;
    if (x[0] === ">" || y[0] === ">") return true; // tail wildcard, both remainders non-empty here
    if (x[0] === "*" || y[0] === "*" || x[0] === y[0]) return walk(x.slice(1), y.slice(1));
    return false;
  };
  return walk(ta, tb);
}
// A positively-enumerated set of DESTRUCTIVE JetStream verbs no data-plane principal may hold:
// `$JS.` alone is NOT proof of non-write authority (STREAM.PURGE / STREAM.DELETE / STREAM.MSG.DELETE
// are all `$JS.` and destroy stored rows), so the audit rejects them by shape, not by prefix (fact).
const DESTRUCTIVE_JS = /\$JS\.API\.(STREAM\.PURGE|STREAM\.DELETE|STREAM\.MSG\.DELETE)\./;

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
    // The matrix's pre-created RECORDS-READER durable (SPEC 13.9 provisioning row): a legitimate
    // non-scanner consumer authority on the records authority stream — full-literal tail,
    // kind-pinned to a CALLER record kind (recordReaderConfig REJECTS the authority-control kinds
    // incl. oblig at the seam), CREATE+DELETE only (the provisioner never consumes; the read
    // mediator binds — the records-reader-bind profile below).
    `$JS.API.CONSUMER.CREATE.KV_cotal_records_d32m.rec_${"u".repeat(26)}-g0-0.$KV.cotal_records_d32m.svc.jobsrv.>`,
    `$JS.API.CONSUMER.DELETE.KV_cotal_records_d32m.rec_${"u".repeat(26)}-g0-0`,
  ], subscribe: [] },
  // The read mediator's BIND on that pre-created reader durable (SPEC 13.9 caller-durable reads):
  // INFO/MSG.NEXT/ACK only, no CREATE/DELETE — it binds what the provisioner pre-created. Pinned so
  // (2a')'s complete-authority-surface claim genuinely accounts for every records-stream consumer
  // verb (incl. $JS.ACK), not only the CREATE/DELETE lifecycle.
  "records-reader-bind": { publish: [
    `$JS.API.CONSUMER.INFO.KV_cotal_records_d32m.rec_${"u".repeat(26)}-g0-0`,
    `$JS.API.CONSUMER.MSG.NEXT.KV_cotal_records_d32m.rec_${"u".repeat(26)}-g0-0`,
    `$JS.ACK.KV_cotal_records_d32m.rec_${"u".repeat(26)}-g0-0.>`,
  ], subscribe: [] },
  "mediator": { publish: [
    "$KV.cotal_records_d32m.oblig.*.jobsrv.>",
    "cotal.d32m.epf.jobsrv.dec.>",
    "$JS.API.STREAM.MSG.GET.KV_cotal_records_d32m",
    "$JS.API.STREAM.MSG.GET.EPF_d32m",
    "$JS.API.STREAM.MSG.GET.EPW_d32m",
    "$JS.API.STREAM.INFO.KV_cotal_records_d32m",
    // No records-stream CONSUMER.CREATE/INFO/NEXT/DELETE (site 3, nats-server#8274): a create body
    // is not subject-ACL confinable, so obligation enumeration moved to the sealed records scanner
    // and the mediator holds no consumer lifecycle on the records stream.
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
    "cotal.d32m.epf.jobsrv.goal.*.*.*.*.result.*",
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
    // P2 item 2 (2b): a GOAL-BEARING cap (spawn) grants the caller's OWN per-goal progress read
    // (epGoalProgressGrantRow) so it can follow its spawn to the terminal — caller-triple-pinned.
    "cotal.d32m.epe.manager.*.*.goal.u_abc.cli.uuuuuuuuuuuuuuuuuuuuuuuuuu.>",
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
    // The closed retirement-frontier set STREAM.INFO (#29 piece-4 HIGH 2): step 6 reads each
    // fenced stream's last_seq; EPF/EPW/EPE join records (already above) so a real callout broker
    // does not deny the frontier read. retirementFrontierStreams is the single source.
    "$JS.API.STREAM.INFO.EPF_d32m",
    "$JS.API.STREAM.INFO.EPW_d32m",
    "$JS.API.STREAM.INFO.EPE_d32m",
    "$JS.API.STREAM.MSG.GET.KV_cotal_auth_d32m",
    "$JS.API.STREAM.MSG.GET.KV_cotal_records_d32m",
    "$JS.API.DIRECT.GET.KV_cotal_records_d32m",
    "$JS.API.DIRECT.GET.KV_cotal_records_d32m.>",
    // No auth-stream CONSUMER.CREATE/INFO/DELETE/NEXT (46e778f re-verify): a create body is not
    // subject-ACL confinable (durable+push exporter surviving revoke), so this profile does NOT
    // enumerate — the barrier's family/intent/lineage scans run on the SEALED auth-ledger scanner (a
    // separate credential; ledger-scanner.ts). The MSG.GET above is this profile's leader-served
    // POINT reads only.
    "$KV.cotal_auth_d32m.gate.>",
    "$KV.cotal_auth_d32m.cred.>",
    "$KV.cotal_auth_d32m.stage.*",
    // The PLANE CLAIM key (#29 HIGH 3, SPEC 13.13): ONE exact key, never `plane.>`/`plane.*` —
    // the cross-process single-plane exclusion row (two scanner tuples + held|released). Only
    // the barrier writes it; reads ride the leader-served MSG.GET above.
    "$KV.cotal_auth_d32m.plane",
    "$KV.cotal_records_d32m.lifecycle.>",
    // The retirement frontier record (#29 piece 4): the barrier is the frontier.<uid> writer
    // (§13.7 create-only, once, before the gate/head terminals) — exact arity, never frontier.>.
    "$KV.cotal_records_d32m.frontier.*",
  ], subscribe: ["_INBOX_ibxconn0123456789.>"] },
  // The two SEALED enumeration scanners (SPEC 13.9, sites 1-3): the ONLY CONSUMER.CREATE-capable
  // profiles on the authority streams, each pinned to its ONE literal consumer name; the records
  // scanner's CREATE filter is additionally confined to the `oblig.` subtree.
  "auth-scanner": { publish: [
    "$JS.API.INFO",
    "$JS.API.STREAM.INFO.KV_cotal_auth_d32m",
    "$JS.API.CONSUMER.CREATE.KV_cotal_auth_d32m.cotal-ledger-scan.$KV.cotal_auth_d32m.>",
    "$JS.API.CONSUMER.INFO.KV_cotal_auth_d32m.cotal-ledger-scan",
    "$JS.API.CONSUMER.MSG.NEXT.KV_cotal_auth_d32m.cotal-ledger-scan",
    "$JS.API.CONSUMER.DELETE.KV_cotal_auth_d32m.cotal-ledger-scan",
  ], subscribe: ["_INBOX_ibxconn0123456789.>"] },
  "records-scanner": { publish: [
    "$JS.API.INFO",
    "$JS.API.STREAM.INFO.KV_cotal_records_d32m",
    "$JS.API.CONSUMER.CREATE.KV_cotal_records_d32m.cotal-records-scan.$KV.cotal_records_d32m.oblig.>",
    "$JS.API.CONSUMER.INFO.KV_cotal_records_d32m.cotal-records-scan",
    "$JS.API.CONSUMER.MSG.NEXT.KV_cotal_records_d32m.cotal-records-scan",
    "$JS.API.CONSUMER.DELETE.KV_cotal_records_d32m.cotal-records-scan",
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
  // The FULL production executor-client profile (#29 piece 2, the credential split): the
  // settlement rows above PLUS the reads its own code path performs. Pinned here so a future
  // widen of retirementExecutorClientGrants fails this audit (distsys residual on b8803b2),
  // not only the confinement smoke.
  "retirement-executor": { publish: [
    "$JS.API.INFO",
    "$JS.API.STREAM.INFO.KV_cotal_records_d32m",
    "$JS.API.STREAM.MSG.GET.KV_cotal_records_d32m",
    // NO EPW MSG.GET (b8803b2 re-verify): the EPW live-entry read is unreachable from the
    // settlement code path, so the space-wide work-body read + reply-injection class is not granted.
    "cotal.d32m.epf.jobsrv.wrk.pa.>",
    "$KV.cotal_records_d32m.lease.jobsrv.pa.>",
    "cotal.d32m.epf.jobsrv.wrk.pb.>",
    "$KV.cotal_records_d32m.lease.jobsrv.pb.>",
    "$JS.API.STREAM.MSG.GET.EPF_d32m",
  ], subscribe: ["_INBOX_ibxconn0123456789.>"] },
  // The per-op DRAIN-REPAIR profiles (#29 HIGH 1): ONE exact coordinate each, validated against
  // the closed self-commit class / the exact EPW item shape BEFORE any mint (the confused-deputy
  // closure). No reads, no wildcards; a widened builder fails this pin.
  "drain-applier": { publish: [
    `$KV.cotal_records_d32m.goal.jobsrv.local.worker.${"u".repeat(26)}.g00001.spec`,
  ], subscribe: ["_INBOX_ibxconn0123456789.>"] },
  "drain-reconciler": { publish: [
    `cotal.d32m.epw.jobsrv.pa.local.worker.${"u".repeat(26)}.acc001`,
  ], subscribe: ["_INBOX_ibxconn0123456789.>"] },
  "drain-canceller": { publish: [
    `cotal.d32m.epf.jobsrv.eff.local.worker.${"u".repeat(26)}.acc001`,
  ], subscribe: ["_INBOX_ibxconn0123456789.>"] },
  // P2 item 6: the per-session console/CLI CALLER cred — RAILS-ONLY for ONE §13.6 session. It pubs
  // the session's `in` rail and subs its `out` rail + its own reply inbox, and NOTHING else (no KV,
  // no JS-API, no store — so no subject-blind ledger read; the sessionId+epoch pin the exact pair).
  "session-caller": { publish: [
    `cotal.d32m.eps.manager.${SC_SID}.3.in`,
  ], subscribe: [
    `cotal.d32m.eps.manager.${SC_SID}.3.out`,
    "_INBOX_ibxconn0123456789.>",
  ] },
  // P2 item 6: the manager's per-session SERVING credential — the EXACT mirror of `session-caller`
  // with the rail directions swapped, for ONE session. It replaces a STANDING writer that held
  // `eps.manager.*.<epoch>.{in,out}` and so reached every live session's bytes at its epoch, against
  // SPEC 13.9:2526 ("no standing EPS grant exists on either side"). No KV and no JS-API at all: the
  // serving side drives bytes, and the ledger belongs to the standing credential below.
  "session-serving": { publish: [
    `cotal.d32m.eps.manager.${SC_SID}.3.out`,
  ], subscribe: [
    `cotal.d32m.eps.manager.${SC_SID}.3.in`,
    "_INBOX_ibxconn0123456789.>",
  ] },
  // P2 item 6: the manager's SESSION LEDGER — the DEDICATED sessions-bucket rows and NOTHING else,
  // with NO session rail of any shape. Standing, because SPEC 13.6 makes it the durable revocation
  // authority that must survive the serving endpoint; splitting it from the rails on that lifetime
  // boundary is what removes the wildcard. The dedicated bucket makes its bucket-blind
  // STREAM.MSG.GET expose ONLY `session.>` rows (never the auth bucket's creds/gates) — the §13.9
  // subject-blindness structural fix.
  "session-ledger": { publish: [
    `$KV.cotal_sessions_d32m.session.*`,
    `$JS.API.STREAM.MSG.GET.KV_cotal_sessions_d32m`,
    `$JS.API.STREAM.INFO.KV_cotal_sessions_d32m`,
    `$JS.API.INFO`,
  ], subscribe: [
    "_INBOX_ibxconn0123456789.>",
  ] },
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
  // The records-reader family the 13.9 provisioning row names (fact's a559d9c re-verify: the
  // REAL builders emit records-stream CREATE/DELETE for pre-created reader durables, so the
  // fixture must carry one or the sole-holder audit below passes by omission).
  { stream: recordsKvStreamName(S), config: recordReaderConfig(S, { uid: UID, grantId: "g0", index: 0, subtree: `$KV.cotal_records_${S}.svc.${EPJ}.>` }) },
]));
put("records-reader-bind", { publish: readerBindGrants(recordsKvStreamName(S), recordReaderConfig(S, { uid: UID, grantId: "g0", index: 0, subtree: `$KV.cotal_records_${S}.svc.${EPJ}.>` })), subscribe: [] });
put("mediator", admissionMediatorGrants(S, EPJ, CONN));
put("cleaner", retirementCleanerGrants(S, EPJ, ["pa", "pb"], CONN));
put("commit", commitPrincipalGrants(S, EPJ, CONN));
put("contract-publisher", contractPublisherGrants(S, CONN));
put("activator", activatorGrants(S, EPJ, "pa", CONN));
put("caller", epCallerGrantRows(S, [cap], { owner: "u_abc", actor: "cli", uid: UID }));
put("serve-rows", epServeGrantRows(S, { endpoint: EP, instanceId: "i".repeat(26), epoch: 3, ephemeralCommands: ["status"] }));
put("auth-writer", authorityWriterGrants(S, CONN));
put("auth-barrier", authorityBarrierGrants(S, CONN));
put("auth-scanner", authorityScannerGrants(S, CONN));
put("records-scanner", recordsScannerGrants(S, CONN));
put("auth-connect-reader", authConnectReaderGrants(S, CONN));
put("barrier-executor", { publish: barrierExecutorSettlementGrants(S, EPJ, ["pa", "pb"]).publish, subscribe: [] });
put("retirement-executor", retirementExecutorClientGrants(S, EPJ, ["pa", "pb"], CONN));
put("drain-applier", drainApplierGrants(S, `goal.${EPJ}.local.worker.${UID}.g00001.spec`, CONN));
put("drain-reconciler", drainReconcilerGrants(S, `cotal.${S}.epw.${EPJ}.pa.local.worker.${UID}.acc001`, CONN));
put("drain-canceller", drainCancellerGrants(S, `cotal.${S}.epf.${EPJ}.eff.local.worker.${UID}.acc001`, CONN));
{
  const scPerms = permissionsFor("session-caller", S, { owner: "u_abc", actor: "cli", connId: CONN }, { sessionCaller: { endpoint: EP, sessionId: SC_SID, epoch: 3 } }) as { pub: { allow: string[] }; sub: { allow: string[] } };
  put("session-caller", { publish: scPerms.pub.allow, subscribe: scPerms.sub.allow });
  const ssPerms = permissionsFor("session-serving", S, { owner: "u_abc", actor: "cli", connId: CONN }, { sessionServing: { endpoint: EP, sessionId: SC_SID, epoch: 3 } }) as { pub: { allow: string[] }; sub: { allow: string[] } };
  put("session-serving", { publish: ssPerms.pub.allow, subscribe: ssPerms.sub.allow });
  const slPerms = permissionsFor("session-ledger", S, { owner: "u_abc", actor: "cli", connId: CONN }, {}) as { pub: { allow: string[] }; sub: { allow: string[] } };
  put("session-ledger", { publish: slPerms.pub.allow, subscribe: slPerms.sub.allow });
}

for (const name of Object.keys(FIXTURE)) {
  c(`fixture pin: ${name}`, JSON.stringify(gen[name]) === JSON.stringify(FIXTURE[name]), gen[name]);
}
c("no unreviewed principal appeared", Object.keys(gen).every((k) => FIXTURE[k] !== undefined), Object.keys(gen));

// ---- 2. the grep tests over the aggregate -----------------------------------------------------
console.log("2. the 13.9 normative grep tests");
const CS_STREAM = /(EPF_|EPW_|EPJ_|EPR_|EPT_REQ_|EPT_|EPC_|KV_cotal_records_|KV_cotal_auth_)d32m/;
const allRows: { principal: string; row: string }[] = [];
for (const [principal, v] of Object.entries(gen)) for (const row of [...v.publish, ...v.subscribe]) allRows.push({ principal, row });

// (2a) consumer-name literalness — NO exceptions. The former auth-store name-wildcard
// enumeration family is GONE (sites 1-3, #8274): dynamic enumeration lives only in the two
// sealed scanner profiles, whose names are the pinned literals checked in (2a') below.
{
  const bad: string[] = [];
  for (const { principal, row } of allRows) {
    const m = /^\$JS\.API\.CONSUMER\.(?:DURABLE\.)?(?:CREATE|INFO|MSG\.NEXT|DELETE)\.([^.]+)\.(.+)$/.exec(row);
    if (!m) continue;
    const name = m[2].split(".")[0];
    if (name.includes("*") || name.includes(">")) bad.push(`${principal}: ${row}`);
  }
  // NO profile holds a bare ephemeral-create form (`CONSUMER.CREATE.<stream>` with no tail).
  for (const { principal, row } of allRows) {
    if (/^\$JS\.API\.CONSUMER\.CREATE\.[^.]+$/.test(row)) bad.push(`${principal}: ${row} (a bare ephemeral-create form)`);
  }
  c("every consumer-name token is literal (NO exceptions; no bare ephemeral-create form anywhere)", bad.length === 0, bad);
}

// (2a') the 13.9 authority-stream consumer surface, mechanically COMPLETE (fact/distsys/security/
// engineer's a559d9c re-verify). Every CONSUMER verb AND `$JS.ACK` on either authority stream is
// pinned to its exact (principal, row): the two sealed scanners' own-name lifecycle (the sole
// DYNAMIC-ENUMERATION CREATE holders), the provisioner's pre-created records-READER durable
// (CREATE+DELETE only), and the read mediator's BIND on it (INFO/MSG.NEXT/ACK). The `oblig`-partition
// is ENFORCED at the seam, not sampled: recordReaderConfig REFUSES an authority-control kind (2a''
// below proves it), so no reader durable can exist over `oblig.` and the records scanner is the
// provable sole holder there. Any new holder, verb, or ACK on either stream fails HERE.
{
  const authorityConsumerRows = allRows.filter(({ row }) =>
    /^\$JS\.API\.CONSUMER\.[A-Z.]+\.KV_cotal_(?:auth|records)_d32m(?:\.|$)/.test(row) ||
    /^\$JS\.ACK\.KV_cotal_(?:auth|records)_d32m(?:\.|$)/.test(row));
  const actual = authorityConsumerRows.map(({ principal, row }) => `${principal}: ${row}`).sort();
  const READER_D = `rec_${UID}-g0-0`;
  const expected = [
    "auth-scanner: $JS.API.CONSUMER.CREATE.KV_cotal_auth_d32m.cotal-ledger-scan.$KV.cotal_auth_d32m.>",
    "auth-scanner: $JS.API.CONSUMER.INFO.KV_cotal_auth_d32m.cotal-ledger-scan",
    "auth-scanner: $JS.API.CONSUMER.MSG.NEXT.KV_cotal_auth_d32m.cotal-ledger-scan",
    "auth-scanner: $JS.API.CONSUMER.DELETE.KV_cotal_auth_d32m.cotal-ledger-scan",
    "records-scanner: $JS.API.CONSUMER.CREATE.KV_cotal_records_d32m.cotal-records-scan.$KV.cotal_records_d32m.oblig.>",
    "records-scanner: $JS.API.CONSUMER.INFO.KV_cotal_records_d32m.cotal-records-scan",
    "records-scanner: $JS.API.CONSUMER.MSG.NEXT.KV_cotal_records_d32m.cotal-records-scan",
    "records-scanner: $JS.API.CONSUMER.DELETE.KV_cotal_records_d32m.cotal-records-scan",
    `provisioner-consumers: $JS.API.CONSUMER.CREATE.KV_cotal_records_d32m.${READER_D}.$KV.cotal_records_d32m.svc.jobsrv.>`,
    `provisioner-consumers: $JS.API.CONSUMER.DELETE.KV_cotal_records_d32m.${READER_D}`,
    `records-reader-bind: $JS.API.CONSUMER.INFO.KV_cotal_records_d32m.${READER_D}`,
    `records-reader-bind: $JS.API.CONSUMER.MSG.NEXT.KV_cotal_records_d32m.${READER_D}`,
    `records-reader-bind: $JS.ACK.KV_cotal_records_d32m.${READER_D}.>`,
  ].sort();
  c("the authority-stream consumer surface is EXACTLY the two sealed scanners + the provisioner's reader CREATE/DELETE + the read mediator's reader bind (INFO/NEXT/ACK); ACK included, nothing else",
    JSON.stringify(actual) === JSON.stringify(expected), actual);
}

// (2a'') the partition is ENFORCED at the reader-config SEAM, driven by the CANONICAL collection
// (panel + freelance a559d9c re-verify): the records scanner's CREATE filter is confined to
// `oblig.>`, and recordReaderConfig is an ALLOWLIST — it refuses every kind that is not a
// caller-readable record kind. Iterating AUTHORITY_KIND_DEFS (the same collection the registry is
// built from) proves the exclusion is by construction, not a hand-kept parallel list: a new
// authority def is covered automatically. Dual-token `lifecycle` admits deeper audit but head-guards.
{
  const tryReader = (subtree: string): boolean => {
    try { recordReaderConfig(S, { uid: UID, grantId: "g9", index: 0, subtree }); return true; } catch { return false; }
  };
  const pureAuthRefused = AUTHORITY_KIND_DEFS.filter((d) => !callerReadableRecordKind(d.kind))
    .every((d) => !tryReader(`$KV.cotal_records_${S}.${d.kind}.${EPJ}.>`));
  const svcOk = tryReader(`$KV.cotal_records_${S}.svc.${EPJ}.>`);                         // caller kind admits
  const unregisteredRefused = !tryReader(`$KV.cotal_records_${S}.futureauth.${EPJ}.>`);    // allowlist rejects
  const lifecycleHeadRefused = !tryReader(`$KV.cotal_records_${S}.lifecycle.u_abc.worker`) // dual-token head
    && !tryReader(`$KV.cotal_records_${S}.lifecycle.>`);
  const lifecycleAuditOk = tryReader(`$KV.cotal_records_${S}.lifecycle.u_abc.worker.${UID}.spec`); // audit detail
  c("recordReaderConfig is an ALLOWLIST driven by AUTHORITY_KIND_DEFS: refuses every pure-authority kind + unregistered kinds + the lifecycle authority head, admits caller kinds + the lifecycle audit detail",
    pureAuthRefused && svcOk && unregisteredRefused && lifecycleHeadRefused && lifecycleAuditOk);
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
    // The full production executor client (#29 piece 2): the settlement EPF read plus the
    // leader-served records-lease read its own code path performs. NO EPW (dead grant removed, b8803b2).
    "retirement-executor:EPF_d32m", "retirement-executor:KV_cotal_records_d32m",
    // P2 item 6: the session LEDGER reads its rows over a bucket-blind STREAM.MSG.GET — but ONLY on
    // the DEDICATED sessions bucket. It holds NO MSG.GET on KV_cotal_auth (creds/gates) or
    // KV_cotal_records: the dedicated bucket is the §13.9 subject-blindness structural fix. The
    // per-session SERVING credential holds no store read at all, so it is absent from this list.
    "session-ledger:KV_cotal_sessions_d32m",
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

// (2d) cross-principal namespace disjointness on the EPF fact families — by real pattern
// INTERSECTION (C6), so a broadened fixture that SUBSUMES a foreign family fails the audit.
{
  const canonSubjects = gen["canonicalizer"].publish.filter((r) => r.startsWith("cotal."));
  const commitSubjects = gen["commit"].publish.filter((r) => r.startsWith("cotal."));
  const overlaps = canonSubjects.flatMap((a) => commitSubjects.filter((b) => subjectsOverlap(a, b)).map((b) => `${a} ∩ ${b}`));
  c("the canonicalizer's subject rows and the commit principal's do not INTERSECT (dec/quar/bind vs the five commit families; subsumption caught, not just exact dupes)",
    overlaps.length === 0, overlaps);
  // The commit families must not COVER a canonicalizer decision subject either (an open ancestor
  // `epf.<e>.>` would subsume `.dec.`/`.quar.` without containing the substring).
  const decQuar = [`cotal.${S}.epf.${EPJ}.dec.x`, `cotal.${S}.epf.${EPJ}.quar.x`];
  c("no commit row COVERS a canonicalizer dec/quar decision subject (ancestor-subsumption caught)",
    decQuar.every((d) => !commitSubjects.some((r) => subjectsOverlap(r, d))), commitSubjects);
  c("per-kind record writers stay disjoint (svc vs goal full-tail filters)",
    JSON.stringify(gen["recw-svc"]) !== JSON.stringify(gen["recw-goal"])
    && !gen["recw-svc"].publish.some((r) => subjectsOverlap(r, `cotal.${S}.epf.${EPJ}.goal.x.x.x.x.bind`)));
  c("the cleaner holds NO write authority (no subject publish, no $KV, no wrk) and the executor carries it instead",
    gen["cleaner"].publish.every((r) => r.startsWith("$JS.")) && gen["barrier-executor"].publish.some((r) => r.includes(".wrk.")));
  // C6 (fact): $JS. is not proof of non-write — NO principal may hold a destructive stream verb.
  const destructive = allRows.filter(({ row }) => DESTRUCTIVE_JS.test(row)).map(({ principal, row }) => `${principal}: ${row}`);
  c("NO principal holds a destructive JetStream stream verb (STREAM.PURGE / STREAM.DELETE / STREAM.MSG.DELETE)", destructive.length === 0, destructive);
  // (2e) the PLANE CLAIM key (#29 HIGH 3, SPEC 13.13): the barrier is its SOLE writer, at exact
  // arity — a `plane.>`/`plane.*` widen or a second holder would hand the cross-process
  // single-plane exclusion to another profile.
  const planeRows = allRows.filter(({ row }) => row.includes(".plane"));
  c("the plane-claim write surface is EXACTLY the barrier's one exact-arity row (no widen, no second holder)",
    JSON.stringify(planeRows) === JSON.stringify([{ principal: "auth-barrier", row: "$KV.cotal_auth_d32m.plane" }]), planeRows);
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
// The ONE deliberate untrusted-profile read on a control-surface stream (P2 item 1, 1c): the
// §13.7 CONTRACT store fetch, EXACTLY the epc-subject-scoped Direct Get row the agent baseline
// mints. Safe by the store's construction — content-addressed public artifacts (schemas /
// manifests / cluster documents; no secrets, no authority rows), create-only with
// deny_delete/deny_purge, verify-on-read as the tamper boundary — and by the row's shape: the
// subject-scoped form reads epc subjects only, never another stream's bodies. Any OTHER read
// verb, any broader Direct Get form, and every non-EPC stream stay prohibited below.
const EPC_FETCH_ROW = `$JS.API.DIRECT.GET.EPC_${S}.cotal.${S}.epc.>`;
for (const [profile, rows] of Object.entries(untrusted)) {
  const reach = [...rows.pub, ...rows.sub].filter((r) =>
    r !== EPC_FETCH_ROW && CS_STREAM.test(r) && /(CONSUMER\.CREATE|CONSUMER\.MSG\.NEXT|DIRECT\.GET|STREAM\.MSG\.GET)/.test(r));
  c(`${profile}: no CONSUMER.CREATE/MSG.NEXT/DIRECT.GET/STREAM.MSG.GET on any control-surface stream (sole exemption: the epc-subject-scoped store fetch)`, reach.length === 0, reach);
  const kvWrites = rows.pub.filter((r) => r.startsWith("$KV.cotal_records_d32m") || r.startsWith("$KV.cotal_auth_d32m"));
  c(`${profile}: no records/auth KV write rows`, kvWrites.length === 0, kvWrites);
}
// The agent's ep reach = its minted caller rows PLUS the normative Appendix-B baseline
// (wildcard describe + delivery join/leave/list + self-mode stop), pinned EXACTLY here so a
// widened baseline (or a stray extra row) fails this audit, not just the grants smoke.
const BASELINE_PUB = [
  `cotal.${S}.ep.one.*.describe.u_abc.cli.${UID}.*`,
  `cotal.${S}.ep.one.delivery.join.u_abc.cli.${UID}.*`,
  `cotal.${S}.ep.one.delivery.leave.u_abc.cli.${UID}.*`,
  `cotal.${S}.ep.one.delivery.list.u_abc.cli.${UID}.*`,
  `cotal.${S}.ep.one.manager.stop.self.u_abc.cli.${UID}.*`,
];
c("the agent's control-surface reach is exactly its caller rows + the Appendix-B baseline (request/journal publish + own reply rail)",
  untrusted.agent.pub.filter((r) => r.includes(".ep.") || r.includes(".epj.")).every((r) => gen["caller"].publish.includes(r) || BASELINE_PUB.includes(r))
  && BASELINE_PUB.every((r) => untrusted.agent.pub.includes(r))
  && untrusted.agent.sub.filter((r) => r.includes(".ep.reply.")).every((r) => gen["caller"].subscribe.includes(r)));

// ---- 4. the #29 piece-3 rail profiles: requester mint + listener, pinned EXACTLY ---------------
console.log("4. the auth-admin rail profiles (piece 3)");
{
  const req = decode(await mintCreds(auth, newIdentity(), "retirement-requester", { retirementRequester: { owner: "local", actor: "mgr0" } }));
  c("the retirement-requester mint is EXACTLY request + own-reply + inbox (no store reads, no executing right)",
    JSON.stringify(req.pub) === JSON.stringify([`cotal.${S}.ctl.auth-admin.local.mgr0`])
    && req.sub.length === 2 && req.sub[0] === `cotal.${S}.ctl.auth-admin.local.mgr0.reply.>` && req.sub[1]!.startsWith("_INBOX_"),
    req);
  const listener = authAdminListenerGrants(S, CONN);
  c("the auth-admin listener grant is EXACTLY REPLY-ONLY publish + $JS.API.INFO + the ONE serve-gate read + inbox (no bare request subject → no self-forge)",
    JSON.stringify(listener) === JSON.stringify({
      publish: [`cotal.${S}.ctl.auth-admin.*.*.reply.>`, "$JS.API.INFO", `$JS.API.STREAM.MSG.GET.KV_cotal_auth_${S}`],
      subscribe: [`cotal.${S}.ctl.auth-admin.*.*`, `_INBOX_${CONN}.>`],
    }), listener);
  c("the listener publish CANNOT reach a bare request subject (self-forge closed): no grant matches ctl.auth-admin.<owner>.<actor> without a .reply. segment",
    !listener.publish.some((r) => /\.ctl\.auth-admin\.(\*|>)/.test(r) && !r.includes(".reply.")));
  c("the listener holds NO consumer authority and NO KV write anywhere",
    listener.publish.every((r) => !r.includes("CONSUMER.") && !r.startsWith("$KV.")));
}

// ---- 5. the endpoint-evictor profile (P2 item 3, slice 3a): scoped delivery-admin, pinned EXACTLY -
console.log("5. the endpoint-evictor profile (P2 item 3): a re-registration's verify-evict caller");
{
  const evId = newIdentity();
  const ev = decode(await mintCreds(auth, evId, "endpoint-evictor", {}));
  const rail = `cotal.${S}.ctl.delivery-admin.${DEV_OWNER}.${evId.id}`;
  c("the endpoint-evictor mint is EXACTLY its OWN delivery-admin request + $JS.API.INFO, own reply + inbox (no lease/presence/store/consumer/KV/executing right)",
    JSON.stringify(ev.pub) === JSON.stringify([rail, "$JS.API.INFO"])
    && ev.sub.length === 2 && ev.sub[0] === `${rail}.reply.>` && ev.sub[1]!.startsWith("_INBOX_"),
    ev);
  c("the endpoint-evictor is NARROWER than supervisor: NO lease, presence, chat/inst/svc, consumer, or KV write anywhere",
    ev.pub.every((r) => r === rail || r === "$JS.API.INFO")
    && !ev.pub.some((r) => r.includes("CONSUMER.") || r.startsWith("$KV.") || r.includes(".chat.") || r.includes(".inst.") || r.includes(".svc.") || r.toUpperCase().includes("LEASE") || r.includes(".presence.")));
}

console.log(fail === 0 ? `\nD32 MATRIX AUDIT OK ✅  (${ok} passed, ${fail} failed)` : `\nD32 MATRIX AUDIT FAILED ❌  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
