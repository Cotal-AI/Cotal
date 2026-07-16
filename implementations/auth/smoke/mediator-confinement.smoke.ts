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
 * Broker killed by exact PID; never pkill nats-server.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { AckPolicy, DeliverPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable, createEndpointStreams, contractDigest,
  admissionMediatorGrants, retirementCleanerGrants, recordsBucket, recordsKvStreamName,
  epfSubject, epfStreamName, epwSubject, epwStreamName, poolConsumerConfig, poolDurable,
  publishFactCreateOnly, readLastFact, parseDecisionFact, parseWorkTerminalFact, workTerminalSubject,
} from "@cotal-ai/core";
import {
  openAdmissionMediator, mediatedRequestFromSubject, obtainEpfObligation, settleEpfOrSelfObligation,
} from "../src/index.js";
import { openLifecycleRegistry, activateLifecycle } from "../src/lifecycle-registry.js";
import { runExactPoolCleaner } from "../src/retirement-barrier.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const denied = async (n: string, fn: () => Promise<unknown>) => {
  try { await fn(); c(n, false, "the broker ALLOWED it"); } catch { c(n, true); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
const medRows = admissionMediatorGrants(SPACE, EP);
const clnRows = retirementCleanerGrants(SPACE, EP, [POOL]);
writeFileSync(join(sd, "server.conf"), [
  `port: ${PORT}`,
  `jetstream { store_dir: "${join(sd, "js")}" }`,
  "authorization {",
  "  users [",
  `    { user: "auth", password: "pw" }`,
  // The mediator: EXACTLY its builder rows + the epj admit-rail subscription that delivers the
  // authenticated request subjects it derives identity from (the canonicalizer hand-off rail).
  `    { user: "med", password: "pw", permissions: { publish = ${JSON.stringify(medRows.publish)}, subscribe = ${JSON.stringify([`cotal.${SPACE}.epj.${EP}.admit.>`, "_INBOX.>"])} } }`,
  // The cleaner: EXACTLY its builder rows.
  `    { user: "cleaner", password: "pw", permissions: { publish = ${JSON.stringify(clnRows.publish)}, subscribe = ${JSON.stringify(["_INBOX.>"])} } }`,
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
  medNc = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "med", pass: "pw" });
  const med = await openAdmissionMediator(medNc, SPACE, EP, { now: () => NOW });
  c("the scoped mediator credential binds + shape-proves the records store (STREAM.INFO row live)", true);
  // The B1 wiring: the caller triple reaches the mediator ONLY as a broker-delivered subject.
  const admitSubject = `cotal.${SPACE}.epj.${EP}.admit.local.caller.${"a".repeat(26)}`;
  const sub = medNc.subscribe(`cotal.${SPACE}.epj.${EP}.admit.>`, { max: 1 });
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

  console.log("B. the mediator's boundary is BROKER-enforced (denials on the same credential)");
  const jsMed = jetstream(medNc, { timeout: 1500 });
  const jsmMed = await jetstreamManager(medNc, { timeout: 1500 });
  await denied("the mediator CANNOT publish a decision fact for ANOTHER endpoint (the cross-endpoint acceptance-forge)",
    () => publishFactCreateOnly(jsMed, epfSubject(SPACE, EP2, ["dec", "local", "caller", "a".repeat(26), "forge01"]), enc.encode(JSON.stringify({ forged: true }))).then((r) => { if (!r.won) throw new Error("cas-lost"); }));
  await denied("the mediator CANNOT write another endpoint's oblig subtree",
    () => jsMed.publish(`$KV.${recordsBucket(SPACE)}.oblig.${"z".repeat(26)}.${EP2}.local.caller.${"a".repeat(26)}.x01`, enc.encode("{}")));
  await denied("the mediator CANNOT write non-oblig records (the govern head)",
    () => jsMed.publish(`$KV.${recordsBucket(SPACE)}.govern.${EP}`, enc.encode("{}")));
  await denied("the mediator CANNOT touch the AUTH store (cred/gate families)",
    () => jsMed.publish(`$KV.cotal_auth_${SPACE}.gate.${"z".repeat(26)}`, enc.encode("{}")));
  await denied("the mediator CANNOT create an enumeration consumer with a FOREIGN filter (the create row pins the oblig subtree)",
    () => jsmMed.consumers.add(recordsKvStreamName(SPACE), { name: "evilscan", filter_subject: `$KV.${recordsBucket(SPACE)}.>`, ack_policy: AckPolicy.None, deliver_policy: DeliverPolicy.LastPerSubject, mem_storage: true, inactive_threshold: 30_000_000_000 }));
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
  clnNc = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "cleaner", pass: "pw" });
  const bind = { jsm: await jetstreamManager(clnNc, { timeout: 2000 }), js: jetstream(clnNc, { timeout: 2000 }), principal: "local.cleaner" };
  const cleaned = await runExactPoolCleaner(bind, { space: SPACE, endpoint: EP, pool: POOL, targetUid: tgt.lifecycleUid, opId: "1".repeat(26), now: () => NOW, maxStalledPasses: 4 });
  c("the REAL cleaner reaches proven quiescence over the scoped credential (bind + NEXT + ACK + wrk + MSG.GET rows live)",
    cleaned.settledExpired === 1 && cleaned.ackedTerminal === 0 && cleaned.settledRetired === 0, cleaned);
  {
    const ref = { endpoint: EP, pool: POOL, acceptance: { ...cE, id: "exp001" } };
    const term = parseWorkTerminalFact(await readLastFact(jsm, epfStreamName(SPACE), workTerminalSubject(SPACE, ref)), workTerminalSubject(SPACE, ref), ref);
    c("…and the emitted expired terminal is core-valid on the wire", term.disposition === "expired");
  }

  console.log("D. the cleaner's boundary is BROKER-enforced");
  await denied("the cleaner CANNOT write a wrk terminal for a NON-listed pool",
    () => publishFactCreateOnly(bind.js, epfSubject(SPACE, EP, ["wrk", POOL2, cE.owner, cE.actor, cE.uid, "ev0002"]), enc.encode("{}")).then((r) => { if (!r.won) throw new Error("cas-lost"); }));
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
