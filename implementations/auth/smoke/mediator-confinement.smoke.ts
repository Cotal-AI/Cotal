/**
 * The D14/D32 confinement smoke for the two §13.9 rows whose residual is "explicit per D32":
 * the ADMISSION MEDIATOR ("Acceptance obligation") and the RETIREMENT CLEANER ("Terminal pool
 * cleanup"). A live broker runs plain user authorization where each principal holds EXACTLY its
 * grant-builder rows; the REAL mediator and the REAL cleaner then run over those scoped
 * credentials (positive: the rows are live-sufficient), and raw clients on the same credentials
 * probe every named denial (negative: the broker, not code discipline, enforces the boundary).
 *
 * The mediator's obligation identity is fed from a REAL broker-delivered subject (a live
 * subscription's msg.subject into mediatedRequestFromSubject), never a synthetic string — the
 * B1 structural half wired end-to-end.
 *
 * Both profiles run under their CONNECTION-SCOPED reply inbox (`_INBOX_<connId>.>` from the
 * builders + a matching client inboxPrefix, never the account-wide `_INBOX.>`). The mediator holds
 * NO records-stream CONSUMER.CREATE (site 3, nats-server#8274): its drain enumerates through the
 * SEALED records scanner, and this smoke proves the durable+PUSH exploit is DENIED to the mediator
 * credential and leaves no surviving exporter.
 *
 * Broker killed by exact PID; never pkill nats-server.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, headers as natsHeaders, type NatsConnection } from "@nats-io/transport-node";
import { AckPolicy, DeliverPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable, createEndpointStreams, contractDigest,
  admissionMediatorGrants, retirementCleanerGrants, recordsBucket, recordsKvStreamName,
  epfSubject, epfStreamName, epwSubject, epwStreamName, poolConsumerConfig, poolDurable,
  publishFactCreateOnly, readLastFact, parseDecisionFact, parseWorkTerminalFact, workTerminalSubject,
  reconcileWorkItem, workPoolContext,
} from "@cotal-ai/core";
import {
  openAdmissionMediator, mediatedRequestFromSubject, obtainEpfObligation, settleEpfOrSelfObligation,
  enumerateObligationRows,
} from "../src/admission-mediator.js";
import { makeRecordsScannerOverConnection } from "../src/records-scanner.js";
import { openLifecycleRegistry, activateLifecycle } from "../src/lifecycle-registry.js";
import { runExactPoolCleaner } from "../src/retirement-barrier.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const denied = async (n: string, fn: () => Promise<unknown>) => {
  try { await fn(); c(n, false, "the broker ALLOWED it"); } catch { c(n, true); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Probe a subscribe DENIAL on a throwaway connection: a subscription permission violation never
 *  throws from subscribe() — it surfaces on the sub callback and the connection status channel
 *  (the delivery-cred-confinement smoke's proven classifier). */
const subDenied = async (n: string, user: string, subject: string, port: number) => {
  const pnc = await connect({ servers: `nats://127.0.0.1:${port}`, user, pass: "pw" });
  try {
    let hit = false;
    void (async () => { for await (const s of pnc.status()) { if (/permission|authorization/i.test(JSON.stringify(s))) hit = true; } })().catch(() => {});
    const sub = pnc.subscribe(subject, { callback: (err) => { if (err) hit = true; } });
    await pnc.flush().catch(() => { hit = true; });
    await wait(350);
    try { sub.unsubscribe(); } catch { /* closed by the violation */ }
    c(n, hit, "the broker ALLOWED the subscription");
  } finally { await pnc.close().catch(() => {}); }
};

const SPACE = "confine";
const EP = "term";
const EP2 = "other";
const POOL = "workpool";
const POOL2 = "sidepool";
const MGR = "mgr-1";
const NOW = 1_700_000_000_000;
const D = contractDigest({ s: 1 });
const fp = (tag: string): string => contractDigest({ fp: tag });
const enc = new TextEncoder();

const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-confine-"));
// The connection-scoped inbox nonces (SPEC 13.9: never the account-wide `_INBOX.>` default). The
// mediator holds NO records-stream consumer grant (site 3): its drain enumerates through the sealed
// records scanner, so there is no per-mediator enumeration consumer name to bind.
const MED_CONN = "med-conn-00000001";
const CLN_CONN = "cln-conn-00000001";
const medRows = admissionMediatorGrants(SPACE, EP, MED_CONN);
const clnRows = retirementCleanerGrants(SPACE, EP, [POOL], CLN_CONN);
writeFileSync(join(sd, "server.conf"), [
  `port: ${PORT}`,
  `jetstream { store_dir: "${join(sd, "js")}" }`,
  "authorization {",
  "  users [",
  `    { user: "auth", password: "pw" }`,
  // The mediator: EXACTLY its builder rows + the epj admit-rail subscription that delivers the
  // authenticated request subjects it derives identity from (the canonicalizer hand-off rail).
  `    { user: "med", password: "pw", permissions: { publish = ${JSON.stringify(medRows.publish)}, subscribe = ${JSON.stringify([`cotal.${SPACE}.epj.${EP}.admit.>`, ...medRows.subscribe])} } }`,
  // The cleaner: EXACTLY its builder rows.
  `    { user: "cleaner", password: "pw", permissions: { publish = ${JSON.stringify(clnRows.publish)}, subscribe = ${JSON.stringify(clnRows.subscribe)} } }`,
  "  ]",
  "}",
].join("\n"));
const broker = spawn("nats-server", ["-c", join(sd, "server.conf")], { stdio: "ignore" });

let nc: NatsConnection | undefined, medNc: NatsConnection | undefined, clnNc: NatsConnection | undefined;
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://auth:pw@127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  nc = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "auth", pass: "pw" });
  const jsm = await jetstreamManager(nc);
  const js = jetstream(nc);
  await createEndpointStreams(jsm, new Kvm(nc), SPACE);
  const reg = await openLifecycleRegistry(nc, SPACE);
  await jsm.consumers.add(epwStreamName(SPACE), poolConsumerConfig(SPACE, EP, POOL, { ackWaitMs: 700 }));
  await jsm.consumers.add(epwStreamName(SPACE), poolConsumerConfig(SPACE, EP2, POOL, { ackWaitMs: 700 }));
  const act = await activateLifecycle(reg, { owner: "local", actor: "victim", managerInstance: MGR });
  const tgt = { owner: "local", actor: "victim", lifecycleUid: act.mapping.lifecycleUid };

  console.log("A. the mediator's rows are LIVE-SUFFICIENT, fed from a real broker-delivered subject");
  // The connection carries the SCOPED inbox: the builder's `_INBOX_<connId>.>` subscribe row is
  // the ONLY inbox this credential holds, so every JS API request/reply below proves it live.
  medNc = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "med", pass: "pw", inboxPrefix: `_INBOX_${MED_CONN}` });
  // The mediator's drain enumerates through the SEALED records scanner over the TRUSTED connection
  // (site 3): the mediator's own scoped credential holds no records-stream CONSUMER.CREATE.
  const recScanner = makeRecordsScannerOverConnection(nc, SPACE);
  const med = await openAdmissionMediator(medNc, SPACE, EP, { now: () => NOW, recordsScanner: recScanner });
  c("the scoped mediator credential binds + shape-proves the records store over its scoped inbox (STREAM.INFO row live)", true);
  const jsMed = jetstream(medNc, { timeout: 1500 });
  const jsmMed = await jetstreamManager(medNc, { timeout: 1500 });
  // The B1 wiring: the caller triple reaches the mediator ONLY as a broker-delivered subject.
  // The SUB must be flushed on the mediator's OWN connection before the foreign publish, or the
  // publish can outrun the subscription registration and the iterator never completes.
  const admitSubject = `cotal.${SPACE}.epj.${EP}.admit.local.caller.${"a".repeat(26)}`;
  const sub = medNc.subscribe(`cotal.${SPACE}.epj.${EP}.admit.>`, { max: 1 });
  await medNc.flush();
  await nc.publish(admitSubject, enc.encode("{}"));
  await nc.flush();
  let deliveredSubject = "";
  for await (const m of sub) deliveredSubject = m.subject;
  c("the admission request subject arrives over a LIVE subscription (not a synthetic string)", deliveredSubject === admitSubject);
  const req = mediatedRequestFromSubject(deliveredSubject);
  const got = await obtainEpfObligation(med, req, { target: tgt, id: "req0001", fingerprint: fp("A"), sourceSeq: 3, route: "effects" });
  c("the scoped credential WINS the obligation create + fencing reads (oblig CAS + MSG.GET rows live)", got.row.state === "provisional" && !got.joined);
  const settled = await settleEpfOrSelfObligation(med, got.key, "confinement probe settle");
  c("the scoped credential publishes the terminal rejection on ITS OWN decision subject", settled === "rejected");
  {
    const decSubject = epfSubject(SPACE, EP, ["dec", "local", "caller", "a".repeat(26), "req0001"]);
    const fact = parseDecisionFact(await readLastFact(jsm, epfStreamName(SPACE), decSubject), decSubject);
    c("…and the emitted fact is core-valid on the wire", fact.decision === "rejected");
  }
  // The mediator's drain enumerates through the SEALED records scanner (site 3), NOT its own
  // credential — it holds no records-stream CONSUMER.CREATE. The scanner's lock serializes scans;
  // the endpoint-wide filter and the narrower per-target filter both resolve to the same row.
  {
    const rows1 = await enumerateObligationRows(recScanner, `oblig.*.${EP}.>`);
    c("the mediator's drain enumerates its oblig subtree through the sealed records scanner (no scoped CREATE)",
      rows1.length === 1 && rows1[0].row.state === "rejected", rows1.map((r) => r.key));
    const rows2 = await enumerateObligationRows(recScanner, `oblig.${tgt.lifecycleUid}.${EP}.>`);
    c("…and a narrower filter through the same sealed scanner returns the same row",
      rows2.length === 1 && rows2[0].key === rows1[0].key, rows2.map((r) => r.key));
  }

  console.log("B. the mediator's boundary is BROKER-enforced (denials on the same credential)");
  await denied("the mediator CANNOT publish a decision fact for ANOTHER endpoint (the cross-endpoint acceptance-forge)",
    () => publishFactCreateOnly(jsMed, epfSubject(SPACE, EP2, ["dec", "local", "caller", "a".repeat(26), "forge01"]), enc.encode(JSON.stringify({ forged: true }))).then((r) => { if (!r.won) throw new Error("cas-lost"); }));
  await denied("the mediator CANNOT write another endpoint's oblig subtree",
    () => jsMed.publish(`$KV.${recordsBucket(SPACE)}.oblig.${"z".repeat(26)}.${EP2}.local.caller.${"a".repeat(26)}.x01`, enc.encode("{}")));
  await denied("the mediator CANNOT write non-oblig records (the govern head)",
    () => jsMed.publish(`$KV.${recordsBucket(SPACE)}.govern.${EP}`, enc.encode("{}")));
  await denied("the mediator CANNOT touch the AUTH store (cred/gate families)",
    () => jsMed.publish(`$KV.cotal_auth_${SPACE}.gate.${"z".repeat(26)}`, enc.encode("{}")));
  // SITE 3 (nats-server#8274): the mediator holds NO records-stream CONSUMER.CREATE. A create-
  // request BODY is not subject-ACL confinable, so ANY create grant would admit a `durable_name` +
  // PUSH `deliver_subject` body — a persistent exporter of the whole oblig subtree that SURVIVES
  // this credential's connection and revoke (reproduced live against the prior grant). The seal
  // removed the grant entirely; enumeration moved to the sealed records scanner.
  const exploitName = `medenum_${EP}-${MED_CONN}`; // the exact name the OLD grant pinned
  const exploitFilter = `$KV.${recordsBucket(SPACE)}.oblig.*.${EP}.>`;
  await denied("the mediator CANNOT create ANY records consumer (no CONSUMER.CREATE grant), even under the old pinned name+filter",
    () => jsmMed.consumers.add(recordsKvStreamName(SPACE), { name: exploitName, filter_subject: exploitFilter, ack_policy: AckPolicy.None, deliver_policy: DeliverPolicy.LastPerSubject, mem_storage: true, inactive_threshold: 30_000_000_000 }));
  await denied("DENIED: the EXACT EXPLOIT — a matching name+filter create with a DURABLE + PUSH body (a persistent oblig-subtree exporter)",
    () => medNc.request(`$JS.API.CONSUMER.CREATE.${recordsKvStreamName(SPACE)}.${exploitName}.${exploitFilter}`, enc.encode(JSON.stringify({ stream_name: recordsKvStreamName(SPACE), config: { name: exploitName, durable_name: exploitName, filter_subject: exploitFilter, deliver_subject: `attacker.exfil.${SPACE}`, deliver_policy: "all", ack_policy: "none" } })), { timeout: 1500 }));
  await denied("no exploit consumer survives on the records stream (denied at publish, nothing created)",
    () => jsm.consumers.info(recordsKvStreamName(SPACE), exploitName));
  // A foreign records-stream consumer, created by the trusted side: the mediator holds NO records
  // consumer rows at all (site 3), so it can neither read nor disturb it.
  await jsm.consumers.add(recordsKvStreamName(SPACE), { name: "victimscan", filter_subject: `$KV.${recordsBucket(SPACE)}.oblig.*.${EP}.>`, ack_policy: AckPolicy.None, deliver_policy: DeliverPolicy.LastPerSubject, mem_storage: true, inactive_threshold: 30_000_000_000 });
  await denied("the mediator CANNOT read any records consumer (no CONSUMER.INFO grant)",
    () => jsmMed.consumers.info(recordsKvStreamName(SPACE), "victimscan"));
  // The pull probe needs an EXPLICIT reply subscription: an allowed raw NEXT always answers on
  // the reply subject (a 408 status when nothing is deliverable), while nats.js request() maps
  // that same 408 to a thrown timeout and would false-pass the denial. Reply arrived = ALLOWED.
  {
    const reply = `_INBOX_${MED_CONN}.nextprobe`;
    const rsub = medNc.subscribe(reply, { max: 1 });
    await medNc.flush();
    let gotReply = false;
    const pump = (async () => { for await (const m of rsub) { void m; gotReply = true; } })().catch(() => {});
    medNc.publish(`$JS.API.CONSUMER.MSG.NEXT.${recordsKvStreamName(SPACE)}.victimscan`, enc.encode(JSON.stringify({ batch: 1, expires: 300_000_000 })), { reply });
    await medNc.flush();
    await wait(800);
    try { rsub.unsubscribe(); } catch { /* already closed */ }
    await pump;
    c("the mediator CANNOT pull from any records consumer (no CONSUMER.MSG.NEXT grant; no cross-endpoint delivery disturbance)", !gotReply, "the broker ALLOWED the pull (a reply arrived)");
  }
  await denied("the mediator CANNOT delete any records consumer (no CONSUMER.DELETE grant)",
    () => jsmMed.consumers.delete(recordsKvStreamName(SPACE), "victimscan"));
  await subDenied("the mediator CANNOT subscribe the account-wide _INBOX.> (its reply inbox is connection-scoped)", "med", "_INBOX.>", PORT);
  await subDenied("the mediator CANNOT subscribe ANOTHER principal's scoped inbox", "med", `_INBOX_${CLN_CONN}.>`, PORT);
  await denied("the mediator CANNOT delete a message from the records stream",
    () => jsmMed.streams.deleteMessage(recordsKvStreamName(SPACE), 1));
  await denied("the mediator CANNOT purge or delete the records stream",
    () => jsmMed.streams.purge(recordsKvStreamName(SPACE)));
  await denied("the mediator CANNOT take the follower Direct Get path",
    () => jsmMed.direct.getMessage(recordsKvStreamName(SPACE), { last_by_subj: `$KV.${recordsBucket(SPACE)}.govern.${EP}` }));
  await denied("the mediator CANNOT enqueue pool work (no epw publish row)",
    () => jsMed.publish(epwSubject(SPACE, EP, POOL, { owner: "local", actor: "caller", uid: "a".repeat(26), id: "ev0001" }), enc.encode("{}")));
  // The own-endpoint ACCEPTANCE-forge stays PERMITTED by the broker: it is the NAMED D32
  // residual (rejection-only is not subject-expressible), so the probe asserts it is possible —
  // silence here would read as "reject-only enforced" when it is not (SPEC 13.9).
  {
    const r = await publishFactCreateOnly(jsMed, epfSubject(SPACE, EP, ["dec", "local", "caller", "b".repeat(26), "own001"]), enc.encode(JSON.stringify({ residual: true })));
    c("the own-endpoint decision publish REMAINS possible: the NAMED D32 acceptance-forge residual, in-endpoint only", r.won === true);
  }
  {
    const subject = `$KV.${recordsBucket(SPACE)}.${got.key}`;
    await jsMed.publish(subject, enc.encode(JSON.stringify({ ...got.row, state: "terminal" })));
    const overwritten = await jsm.streams.getMessage(recordsKvStreamName(SPACE), { last_by_subj: subject });
    c("the mediator CAN overwrite its own obligation to valid terminal: the named payload-blind KV residual",
      JSON.parse(new TextDecoder().decode(overwritten.data)).state === "terminal");

    const delSubject = `$KV.${recordsBucket(SPACE)}.oblig.${tgt.lifecycleUid}.${EP}.local.caller.${"q".repeat(26)}.del001`;
    const h = natsHeaders(); h.set("KV-Operation", "DEL");
    await jsMed.publish(delSubject, new Uint8Array(), { headers: h });
    const marker = await jsm.streams.getMessage(recordsKvStreamName(SPACE), { last_by_subj: delSubject });
    c("the mediator CAN emit an own-obligation DEL marker (readers fail loud; stream erasure remains denied)", marker.header?.get("KV-Operation") === "DEL");
  }
  {
    const foreignReply = `foreign.reply.${Date.now()}`;
    let injected = false;
    const fsub = nc.subscribe(foreignReply, { max: 1, callback: (err, m) => { if (!err && m) injected = true; } });
    await nc.flush();
    medNc.publish(`$JS.API.STREAM.MSG.GET.${recordsKvStreamName(SPACE)}`, enc.encode(JSON.stringify({ last_by_subj: `$KV.${recordsBucket(SPACE)}.${got.key}` })), { reply: foreignReply });
    await medNc.flush();
    await wait(500);
    try { fsub.unsubscribe(); } catch { /* max reached */ }
    c("raw JetStream API authority CAN direct a response onto a foreign reply subject: the named confused-deputy injection residual", injected);
  }

  console.log("E. the sealed records scanner is brand + space-bonded, and its filter is oblig-confined");
  // Brand negatives (site-1 HIGH-1, mirrored to the records scanner): the ONLY RecordsScanner an
  // injection point accepts is one built by openRecordsScanner/makeRecordsScannerOverConnection,
  // bonded to THIS space. A hand-assembled structural object (its scanObligations returns []) or a
  // foreign-space scanner would let a mediator drain declare quiescence over live obligations.
  await denied("openAdmissionMediator REJECTS a hand-assembled records scanner (not built by the module; never enumerates)",
    () => openAdmissionMediator(medNc, SPACE, EP, { now: () => NOW, recordsScanner: { scanObligations: async () => [], close: async () => {} } as never }));
  await denied("openAdmissionMediator REJECTS a FOREIGN-SPACE records scanner (bonded to another space)",
    () => openAdmissionMediator(medNc, SPACE, EP, { now: () => NOW, recordsScanner: makeRecordsScannerOverConnection(nc, "otherspace") }));
  await denied("openLifecycleRegistry REJECTS a foreign-space records scanner",
    () => openLifecycleRegistry(nc, SPACE, undefined, makeRecordsScannerOverConnection(nc, "otherspace")));
  await denied("openLifecycleRegistry REJECTS a hand-assembled records scanner (both injection points cover both negatives)",
    () => openLifecycleRegistry(nc, SPACE, undefined, { scanObligations: async () => [], close: async () => {} } as never));
  // Filter confinement: the closed scan op refuses any filter that escapes the `oblig.` subtree, so
  // the sealed scanner can never be widened to the records root or a foreign subtree (head/govern/lease).
  await denied("scanObligations REFUSES a non-oblig subtree filter (govern head)",
    () => recScanner.scanObligations(`govern.${EP}.>`));
  await denied("scanObligations REFUSES a records-root widen",
    () => recScanner.scanObligations(">"));
  await denied("scanObligations REFUSES a dotted-injection filter segment",
    () => recScanner.scanObligations("oblig.bad seg.>"));
  // HIGH 2 (capability integrity): the branded handle is FROZEN, so a post-brand method swap (the
  // silent-empty scanner the brand alone cannot catch: the WeakMap keys the reference, not the
  // behavior) THROWS instead of surviving the injection assert, and the op still enumerates.
  // (Raw scanObligations below, not enumerateObligationRows: §B deliberately left a DEL-marked
  // oblig row, which the parse layer correctly refuses as corruption; the RAW scan returns markers.)
  {
    let swapDenied = false;
    try { (recScanner as { scanObligations: unknown }).scanObligations = async () => []; } catch { swapDenied = true; }
    const after = await recScanner.scanObligations(`oblig.*.${EP}.>`);
    c("the branded records scanner is FROZEN: a post-brand silent-empty method swap THROWS and the op still enumerates the real rows",
      swapDenied && Object.isFrozen(recScanner) && after.length === 2, after.map((e) => e.key));
  }
  // HIGH 3 (fact-5 ENFORCED): scans serialize on a MODULE-LEVEL per-space chain, so a SECOND branded
  // same-space instance scanning CONCURRENTLY cannot interleave pre-clean/create/fetch/delete on the
  // one literal consumer name; both scans see the complete current set, never a partial/empty map
  // from a mid-drain delete/create.
  {
    const twin = makeRecordsScannerOverConnection(nc, SPACE);
    const [a, b] = await Promise.all([
      recScanner.scanObligations(`oblig.*.${EP}.>`),
      twin.scanObligations(`oblig.*.${EP}.>`),
    ]);
    const keys = (rows: { key: string }[]) => rows.map((r) => r.key).sort().join(",");
    c("two branded same-space scanners scanning CONCURRENTLY each see the complete oblig set (module-level serialization, fact-5)",
      a.length === 2 && keys(a) === keys(b), { a: keys(a), b: keys(b) });
  }

  console.log("C. the cleaner's rows are LIVE-SUFFICIENT (the real cleaner over the scoped credential)");
  // One expired item in the listed pool, enqueued + accepted by the trusted side.
  const cE = { owner: "local", actor: "worker", uid: "c".repeat(26) };
  {
    const from = { id: `${cE.owner}.${cE.actor}`, name: "c" };
    const request = { v: 1, id: "exp001", op: { endpoint: EP, command: "run", inputDigest: D, outputDigest: D }, class: "journal", replyExpected: false, deadlineMs: 5000, args: {}, from };
    const fact = {
      v: 1, id: "exp001", decision: "accepted", fingerprint: fp("exp001"), request,
      caller: { id: from.id, lifecycleUid: cE.uid }, contractDigests: { input: D, output: D },
      authzDecision: { revision: 1, epoch: 1 }, route: `pool.${POOL}`, workExpiry: NOW - 5, sourceSeq: 4, ts: NOW - 10,
    };
    const decSubject = epfSubject(SPACE, EP, ["dec", cE.owner, cE.actor, cE.uid, "exp001"]);
    parseDecisionFact(fact, decSubject);
    if (!(await publishFactCreateOnly(js, decSubject, enc.encode(JSON.stringify(fact)))).won) throw new Error("acceptance forge lost");
    await js.publish(epwSubject(SPACE, EP, POOL, { ...cE, id: "exp001" }), enc.encode("{}"));
  }
  clnNc = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "cleaner", pass: "pw", inboxPrefix: `_INBOX_${CLN_CONN}` });
  const bind = { jsm: await jetstreamManager(clnNc, { timeout: 2000 }), js: jetstream(clnNc, { timeout: 2000 }), principal: "local.cleaner" };
  const executorWork = await workPoolContext(nc, SPACE);
  const cleaned = await runExactPoolCleaner(bind, {
    space: SPACE, endpoint: EP, pool: POOL, targetUid: tgt.lifecycleUid, now: () => NOW, maxStalledPasses: 4,
    settleItem: async ({ ref, itemBytes }) => {
      const verdict = await reconcileWorkItem(executorWork, { ref, itemBytes, workExpiry: NOW - 5, now: NOW });
      if (!("fact" in verdict)) throw new Error(`executor returned ${verdict.state}`);
      return verdict.fact;
    },
  });
  c("the REAL cleaner reaches proven quiescence while a distinct executor owns lease + terminal settlement",
    cleaned.settledExpired === 1 && cleaned.ackedTerminal === 0 && cleaned.settledRetired === 0, cleaned);
  {
    const ref = { endpoint: EP, pool: POOL, acceptance: { ...cE, id: "exp001" } };
    const term = parseWorkTerminalFact(await readLastFact(jsm, epfStreamName(SPACE), workTerminalSubject(SPACE, ref)), workTerminalSubject(SPACE, ref), ref);
    c("…and the emitted expired terminal is core-valid on the wire", term.disposition === "expired");
  }

  console.log("D. the cleaner's boundary is BROKER-enforced");
  {
    const suppressed = { ...cE, id: "drop001" };
    await js.publish(epwSubject(SPACE, EP, POOL, suppressed), enc.encode("{}"));
    const consumer = await bind.js.consumers.get(epwStreamName(SPACE), poolDurable(EP, POOL));
    let acked = false;
    for await (const m of await consumer.fetch({ max_messages: 1, expires: 1000 })) acked = await m.ackAck();
    const ref = { endpoint: EP, pool: POOL, acceptance: suppressed };
    const terminal = await readLastFact(jsm, epfStreamName(SPACE), workTerminalSubject(SPACE, ref));
    c("the cleaner CAN ACK a listed-pool item without a terminal: the named terminal-free suppression residual", acked && terminal === undefined);
  }
  await denied("the cleaner CANNOT write a wrk terminal, even for its listed pool",
    () => publishFactCreateOnly(bind.js, epfSubject(SPACE, EP, ["wrk", POOL, cE.owner, cE.actor, cE.uid, "ev0002"]), enc.encode("{}")).then((r) => { if (!r.won) throw new Error("cas-lost"); }));
  await denied("the cleaner CANNOT write a decision fact at all",
    () => publishFactCreateOnly(bind.js, epfSubject(SPACE, EP, ["dec", cE.owner, cE.actor, cE.uid, "ev0003"]), enc.encode("{}")).then((r) => { if (!r.won) throw new Error("cas-lost"); }));
  await denied("the cleaner CANNOT enqueue pool work (no epw publish)",
    () => bind.js.publish(epwSubject(SPACE, EP, POOL, { ...cE, id: "ev0004" }), enc.encode("{}")));
  await denied("the cleaner CANNOT bind ANOTHER endpoint's pool durable (INFO/NEXT rows are durable-exact)",
    async () => { for await (const m of await (await bind.js.consumers.get(epwStreamName(SPACE), poolDurable(EP2, POOL))).fetch({ max_messages: 1, expires: 1000 })) void m; });
  await denied("the cleaner CANNOT create a consumer",
    () => bind.jsm.consumers.add(epwStreamName(SPACE), poolConsumerConfig(SPACE, EP, POOL2)));
  await denied("the cleaner CANNOT delete the pool durable",
    () => bind.jsm.consumers.delete(epwStreamName(SPACE), poolDurable(EP, POOL)));
  await denied("the cleaner CANNOT delete/purge the EPW stream",
    () => bind.jsm.streams.purge(epwStreamName(SPACE)));
  await denied("the cleaner CANNOT leader-read EPW (its reads are EPF-only; the pool item reaches it by delivery)",
    () => bind.jsm.streams.getMessage(epwStreamName(SPACE), { last_by_subj: epwSubject(SPACE, EP, POOL, { ...cE, id: "exp001" }) }));
  await denied("the cleaner CANNOT touch the records store",
    () => bind.js.publish(`$KV.${recordsBucket(SPACE)}.oblig.${tgt.lifecycleUid}.${EP}.local.caller.${"a".repeat(26)}.x02`, enc.encode("{}")));
  await denied("the cleaner CANNOT CAS or overwrite an exact listed-pool lease",
    () => bind.js.publish(`$KV.${recordsBucket(SPACE)}.lease.${EP}.${POOL}.local.caller.${cE.uid}.exp001.spec`, enc.encode("{}")));
  await denied("the cleaner CANNOT leader-read the records stream",
    () => bind.jsm.streams.getMessage(recordsKvStreamName(SPACE), { last_by_subj: `$KV.${recordsBucket(SPACE)}.lease.${EP}.${POOL}.local.caller.${cE.uid}.exp001.spec` }));
  await subDenied("the cleaner CANNOT subscribe the account-wide _INBOX.> (its reply inbox is connection-scoped)", "cleaner", "_INBOX.>", PORT);
  await subDenied("the cleaner CANNOT subscribe ANOTHER principal's scoped inbox", "cleaner", `_INBOX_${MED_CONN}.>`, PORT);

  await nc.drain().catch(() => {});
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
} finally {
  try { await medNc?.close(); } catch { /* closed */ }
  try { await clnNc?.close(); } catch { /* closed */ }
  try { await nc?.close(); } catch { /* closed */ }
  broker.kill("SIGKILL"); // exact PID — never pkill nats-server
  await new Promise((r) => broker.once("exit", r));
  rmSync(sd, { recursive: true, force: true });
}

console.log(fail === 0 ? `\nMEDIATOR/CLEANER CONFINEMENT SMOKE OK ✅  (${ok} passed, ${fail} failed)` : `\nMEDIATOR/CLEANER CONFINEMENT SMOKE FAILED ❌  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
