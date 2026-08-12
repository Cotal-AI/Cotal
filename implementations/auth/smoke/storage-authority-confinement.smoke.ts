/**
 * The D32 STORAGE-AUTHORITY CONFINEMENT PROBE (SPEC 13.9, D14): a live broker runs plain user
 * authorization where each storage-authority principal holds EXACTLY its grant-builder rows —
 * the sibling of mediator-confinement.smoke.ts for the writer principals. Positives run REAL
 * code paths under the scoped credentials (the commit principal's settlement runs
 * `retireWorkItem` end-to-end, the contract publisher runs the real typed publish/fetch); raw
 * clients on the same credentials probe the broker-enforced denials; and each named D32
 * residual is demonstrated POSSIBLE (residual honesty: what the matrix admits, the probe
 * shows, never pretends is confined).
 *
 * Load-bearing drop: a VARIANT commit user minus its lease-CAS row proves that exact row
 * load-bearing (the real settlement path dies at the broker) — the in-smoke form of the
 * temp-revert discipline.
 *
 * Leader-service note: `Kvm.open` BINDS with direct=false, so every `kv.get` under these
 * scoped credentials is a leader-served `STREAM.MSG.GET` — exactly the matrix's read-service
 * rows; no principal here holds (or needs) a records `DIRECT.GET`.
 *
 * KNOWN RECORDED GAPS (named, not probed): the canonicalizer's decision-family publish rows
 * (`dec.>`/`quar.>`/goal-bind) and the record/timer writers' records currency-read + `$KV`
 * write rows belong to their daemons' compositions (post-D14 wiring) and have no emitting
 * builder yet; this probe covers exactly what the builders emit today.
 *
 * Broker killed by exact PID; never pkill nats-server.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable, createEndpointStreams,
  canonicalizerGrants, canonicalizerWorkGrants, commitPrincipalGrants, contractPublisherGrants,
  recordWriterGrants, timerWriterGrants, effectsBindGrants, poolOwnerBindGrants, epServeGrantRows, epCallerGrantRows,
  canonConsumerConfig, effectsConsumerConfig, poolConsumerConfig, recordWriterConsumerConfig, timerWriterConsumerConfig,
  epjStreamName, epfStreamName, epwStreamName, eptReqStreamName, recordsBucket,
  epfSubject, epwSubject, workTerminalSubject,
  workPoolContext, retireWorkItem,
  contractStoreContext, publishContractArtifact, fetchContractArtifact, contractArtifactCanonicalBytes, contractArtifactDigestHex,
  RECORD_KINDS, poolDurable, effectsDurable, canonDurable,
  type EpCapability,
} from "@cotal-ai/core";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const denied = async (n: string, fn: () => Promise<unknown>) => {
  try { await fn(); c(n, false, "the broker ALLOWED it"); } catch { c(n, true); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Publish-permission probe: a pub violation surfaces async on the status channel, so publish +
 *  flush + grace, then classify (the delivery-cred-confinement smoke's proven classifier). */
const pubProbe = async (pnc: NatsConnection, subject: string, bytes: Uint8Array, graceMs = 350): Promise<"allowed" | "denied"> => {
  let hit = false;
  void (async () => { for await (const s of pnc.status()) { if (/permission|authorization/i.test(JSON.stringify(s))) { hit = true; return; } } })().catch(() => {});
  pnc.publish(subject, bytes);
  await pnc.flush().catch(() => { hit = true; });
  await wait(graceMs);
  return hit ? "denied" : "allowed";
};

const S = "stauth";
const EP = "term";
const EP2 = "other";
const POOL = "workpool";
const POOL2 = "sidepool";
const IID = "i".repeat(26);
const UID = "u".repeat(26);
const NOW = 1_700_000_000_000;
const enc = new TextEncoder();

const CONN_COMMIT = "commit-conn-0001";
const CONN_CPUB = "cpub-conn-0001";
const CONN_SERVE = "serve-conn-0001";

const canonRows = { publish: [...canonicalizerGrants(S, EP), ...canonicalizerWorkGrants(S, EP)] };
const commitRows = commitPrincipalGrants(S, EP, CONN_COMMIT);
// The load-bearing drop: the SAME commit rows minus the lease-CAS write row.
const commitNoLease = { publish: commitRows.publish.filter((r) => !r.includes(".lease.")), subscribe: commitRows.subscribe };
const cpubRows = contractPublisherGrants(S, CONN_CPUB);
const recwRows = { publish: recordWriterGrants(S, RECORD_KINDS.svc) };
const timerwRows = { publish: timerWriterGrants(S) };
const serveGrantRows = epServeGrantRows(S, { endpoint: EP, instanceId: IID, epoch: 1, ephemeralCommands: [] });
const serveRows = {
  publish: [...serveGrantRows.pub, ...effectsBindGrants(S, EP), ...poolOwnerBindGrants(S, EP, POOL), "$JS.API.INFO"],
  subscribe: [...serveGrantRows.sub.map((r) => r.split(" ")[0]), `_INBOX_${CONN_SERVE}.>`],
};
const cap: EpCapability = { endpoint: EP, command: "spawn", target: { mode: "owner", tOwner: "u_abc" }, journal: true };
const callerRows = epCallerGrantRows(S, [cap], { owner: "u_abc", actor: "cli", uid: UID });

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-stauth-"));
writeFileSync(join(sd, "server.conf"), [
  `port: ${PORT}`,
  `jetstream { store_dir: ${JSON.stringify(join(sd, "js"))} }`,
  "authorization {",
  "  users [",
  `    { user: "auth", password: "pw" }`,
  `    { user: "canon", password: "pw", permissions: { publish = ${JSON.stringify(canonRows.publish)}, subscribe = ${JSON.stringify(["_INBOX_canonconn.>"])} } }`,
  `    { user: "commit", password: "pw", permissions: { publish = ${JSON.stringify(commitRows.publish)}, subscribe = ${JSON.stringify(commitRows.subscribe)} } }`,
  `    { user: "commitnolease", password: "pw", permissions: { publish = ${JSON.stringify(commitNoLease.publish)}, subscribe = ${JSON.stringify(commitNoLease.subscribe)} } }`,
  `    { user: "cpub", password: "pw", permissions: { publish = ${JSON.stringify(cpubRows.publish)}, subscribe = ${JSON.stringify(cpubRows.subscribe)} } }`,
  `    { user: "recw", password: "pw", permissions: { publish = ${JSON.stringify(recwRows.publish)}, subscribe = ${JSON.stringify(["_INBOX_recwconn.>"])} } }`,
  `    { user: "timerw", password: "pw", permissions: { publish = ${JSON.stringify(timerwRows.publish)}, subscribe = ${JSON.stringify(["_INBOX_timerwconn.>"])} } }`,
  `    { user: "serve", password: "pw", permissions: { publish = ${JSON.stringify(serveRows.publish)}, subscribe = ${JSON.stringify(serveRows.subscribe)} } }`,
  `    { user: "agent", password: "pw", permissions: { publish = ${JSON.stringify(callerRows.pub)}, subscribe = ${JSON.stringify(callerRows.sub)} } }`,
  "  ]",
  "}",
].join("\n"));
const broker = spawn("nats-server", ["-c", join(sd, "server.conf")], { stdio: "ignore" });

const conns: NatsConnection[] = [];
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://auth:pw@127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const open = async (user: string, inbox?: string): Promise<NatsConnection> => {
    const pnc = await connect({ servers: `nats://127.0.0.1:${PORT}`, user, pass: "pw", ...(inbox ? { inboxPrefix: `_INBOX_${inbox}` } : {}) });
    conns.push(pnc);
    return pnc;
  };
  const nc = await open("auth");
  const jsm = await jetstreamManager(nc);
  const js = jetstream(nc);
  await createEndpointStreams(jsm, new Kvm(nc), S);
  // The provisioner's pre-created durables (§13.9): canonicalizer, shared effects (both
  // endpoints), pools (own + side), record writer, timer writer.
  await jsm.consumers.add(epjStreamName(S), canonConsumerConfig(S, EP));
  await jsm.consumers.add(epfStreamName(S), effectsConsumerConfig(S, EP));
  await jsm.consumers.add(epfStreamName(S), effectsConsumerConfig(S, EP2));
  await jsm.consumers.add(epwStreamName(S), poolConsumerConfig(S, EP, POOL));
  await jsm.consumers.add(epwStreamName(S), poolConsumerConfig(S, EP, POOL2));
  await jsm.consumers.add(eprStream(), recordWriterConsumerConfig(S, RECORD_KINDS.svc));
  await jsm.consumers.add(eptReqStreamName(S), timerWriterConsumerConfig(S));
  function eprStream(): string { return `EPR_${S}`; }
  // Seeds: one journal submission, one accepted-decision fact per endpoint (the eff filter),
  // one svc record write, one timer schedule.
  await js.publish(`cotal.${S}.epj.${EP}.spawn.local.cli.${UID}`, enc.encode("{}"));
  await js.publish(epfSubject(S, EP, ["dec", "local", "cli", UID, "item0001"]), enc.encode(JSON.stringify({ seeded: true })));
  await js.publish(epfSubject(S, EP2, ["dec", "local", "cli", UID, "foreign01"]), enc.encode(JSON.stringify({ foreign: true })));
  await js.publish(`cotal.${S}.epr.${EP}.${IID}.1.svc.status`, enc.encode("{}"));
  await js.publish(`cotal.${S}.ept.${EP}.${IID}.1.t1.schedule`, enc.encode("{}"));
  await js.publish(epwSubject(S, EP, POOL, { owner: "local", actor: "cli", uid: UID, id: "poolitem" }), enc.encode("{}"));

  console.log("A. the canonicalizer's rows are live-sufficient; its reach stops at its families");
  {
    const pnc = await open("canon", "canonconn");
    const pjs = jetstream(pnc, { timeout: 1500 });
    const con = await pjs.consumers.get(epjStreamName(S), canonDurable(EP));
    const batch = await con.fetch({ max_messages: 1, expires: 1200 });
    let got = 0;
    for await (const m of batch) { got++; m.ack(); }
    c("canon consumes + acks its EPJ durable (bind rows live)", got === 1);
    c("canon enqueues into ITS endpoint's pool subtree (the epw publish row live)",
      (await pubProbe(pnc, epwSubject(S, EP, POOL, { owner: "local", actor: "cli", uid: UID, id: "enq00001" }), enc.encode("{}"))) === "allowed");
    const pjsm = await jetstreamManager(pnc, { checkAPI: false, timeout: 1500 });
    const sm = await pjsm.streams.getMessage(epwStreamName(S), { last_by_subj: epwSubject(S, EP, POOL, { owner: "local", actor: "cli", uid: UID, id: "poolitem" }) });
    c("canon's EPW reconciliation leader read is live (STREAM.MSG.GET row)", sm !== null);
    c("canon is DENIED the decision-family publish (no builder row yet: the daemon composition gap stays fail-closed)",
      (await pubProbe(pnc, epfSubject(S, EP, ["dec", "local", "cli", UID, "canfrg01"]), enc.encode("{}"))) === "denied");
    c("canon is DENIED a FOREIGN endpoint's pool subtree",
      (await pubProbe(pnc, epwSubject(S, EP2, POOL, { owner: "local", actor: "cli", uid: UID, id: "enq00002" }), enc.encode("{}"))) === "denied");
    c("canon is DENIED records KV writes",
      (await pubProbe(pnc, `$KV.${recordsBucket(S)}.lease.${EP}.${POOL}.local.cli.${UID}.x.spec`, enc.encode("{}"))) === "denied");
  }

  console.log("B. the commit principal runs the REAL settlement end-to-end under its scoped rows");
  {
    const pnc = await open("commit", CONN_COMMIT);
    const ctx = await workPoolContext(pnc, S);
    const ref = { endpoint: EP, pool: POOL, acceptance: { owner: "local", actor: "cli", uid: UID, id: "retire01" } };
    const settled = await retireWorkItem(ctx, { ref, workExpiry: NOW + 60_000, opId: "o".repeat(26), targetUid: "t".repeat(26), now: NOW });
    c("retireWorkItem settles a never-leased item END-TO-END (lease create-CAS + terminal publish + leader read-back, all scoped rows live)",
      settled.won === true && settled.fact.disposition === "retired");
    const again = await retireWorkItem(ctx, { ref, workExpiry: NOW + 60_000, opId: "o".repeat(26), targetUid: "t".repeat(26), now: NOW });
    c("…and the settled terminal DOMINATES a re-settle (first terminal wins, read under the same rows)", again.won === false && again.fact.disposition === "retired");
    // Named D32 residuals, demonstrated POSSIBLE (never pretended confined):
    c("RESIDUAL: the payload-blind wrk publish CAN forge an in-endpoint terminal for work that never ran",
      (await pubProbe(pnc, workTerminalSubject(S, { endpoint: EP, pool: POOL, acceptance: { owner: "local", actor: "cli", uid: UID, id: "forged01" } }), enc.encode(JSON.stringify({ forged: true })))) === "allowed");
    c("RESIDUAL: the raw $KV subject grant CANNOT distinguish CAS from overwrite (an own-endpoint lease row can be clobbered)",
      (await pubProbe(pnc, `$KV.${recordsBucket(S)}.lease.${EP}.${POOL}.local.cli.${UID}.retire01.spec`, enc.encode(JSON.stringify({ clobbered: true })))) === "allowed");
    const pjsm = await jetstreamManager(pnc, { timeout: 1500 });
    const foreign = await pjsm.streams.getMessage(epfStreamName(S), { last_by_subj: epfSubject(S, EP2, ["dec", "local", "cli", UID, "foreign01"]) });
    c("RESIDUAL: the stream-level EPF MSG.GET exposes FOREIGN endpoints' facts (space-wide body-selected read)", foreign !== null);
    // Broker-enforced denials:
    c("commit is DENIED the canonicalizer's decision family", (await pubProbe(pnc, epfSubject(S, EP, ["dec", "local", "cli", UID, "cfrg0001"]), enc.encode("{}"))) === "denied");
    c("commit is DENIED a FOREIGN endpoint's wrk terminal", (await pubProbe(pnc, workTerminalSubject(S, { endpoint: EP2, pool: POOL, acceptance: { owner: "local", actor: "cli", uid: UID, id: "xfrg0001" } }), enc.encode("{}"))) === "denied");
    c("commit is DENIED foreign record kinds (svc keys are the svc writer's)", (await pubProbe(pnc, `$KV.${recordsBucket(S)}.svc.${EP}.${IID}.spec`, enc.encode("{}"))) === "denied");
    await denied("commit is DENIED the EPW leader read (canonicalizer/mediator-only)",
      () => pjsm.streams.getMessage(epwStreamName(S), { last_by_subj: epwSubject(S, EP, POOL, { owner: "local", actor: "cli", uid: UID, id: "poolitem" }) }));
    await denied("commit is DENIED the canonicalizer's EPJ consume",
      () => jetstream(pnc, { timeout: 1200 }).consumers.get(epjStreamName(S), canonDurable(EP)));
  }

  console.log("C. the load-bearing drop: WITHOUT the lease row the real settlement dies at the broker");
  {
    const pnc = await open("commitnolease", CONN_COMMIT);
    const ctx = await workPoolContext(pnc, S);
    const ref = { endpoint: EP, pool: POOL, acceptance: { owner: "local", actor: "cli", uid: UID, id: "retire02" } };
    await denied("retireWorkItem FAILS when the lease-CAS row is dropped (the row is load-bearing, not decorative)",
      () => retireWorkItem(ctx, { ref, workExpiry: NOW + 60_000, opId: "o".repeat(26), targetUid: "t".repeat(26), now: NOW }));
  }

  console.log("D. the contract publisher runs the REAL typed store paths");
  {
    const pnc = await open("cpub", CONN_CPUB);
    const ctx = await contractStoreContext(pnc, S);
    const bytes = contractArtifactCanonicalBytes({ kind: "probe", v: 1 });
    const pub = await publishContractArtifact(ctx, bytes);
    c("the publisher publishes an artifact create-only and re-reads it through the subject-confined Direct Get", pub.won === true
      && (await fetchContractArtifact(ctx, pub.digestHex)) !== undefined);
    // The garbage-flood residual + verify-on-read as the actual tamper boundary:
    const junkDigest = contractArtifactDigestHex(contractArtifactCanonicalBytes({ other: true }));
    c("RESIDUAL: the payload-blind epc.* publish CAN plant garbage at a fresh digest subject",
      (await pubProbe(pnc, `cotal.${S}.epc.${junkDigest}`, enc.encode("not-json-at-all"))) === "allowed");
    await denied("…but verify-on-read REFUSES to serve it (content addressing is the tamper boundary)",
      () => fetchContractArtifact(ctx, junkDigest));
    c("cpub is DENIED every fact family", (await pubProbe(pnc, epfSubject(S, EP, ["receipt", "local", "cli", UID, "r1"]), enc.encode("{}"))) === "denied");
    c("cpub is DENIED records KV writes", (await pubProbe(pnc, `$KV.${recordsBucket(S)}.goal.${EP}.local.cli.${UID}.g.spec`, enc.encode("{}"))) === "denied");
    await denied("cpub is DENIED the body-selected EPC leader read (its read-back is the subject-confined form only)",
      () => (jetstreamManager(pnc, { checkAPI: false, timeout: 1200 })).then((m) => m.streams.getMessage(`EPC_${S}`, { last_by_subj: `cotal.${S}.epc.${pub.digestHex}` })));
  }

  console.log("E. the record + timer writers own exactly their durables");
  {
    const pnc = await open("recw", "recwconn");
    const pjs = jetstream(pnc, { timeout: 1500 });
    const con = await pjs.consumers.get(eprStream(), recordWriterConsumerConfig(S, RECORD_KINDS.svc).durable_name!);
    let got = 0;
    for await (const m of await con.fetch({ max_messages: 1, expires: 1200 })) { got++; m.ack(); }
    c("the svc record writer consumes + acks its own durable", got === 1);
    const pjsm = await jetstreamManager(pnc, { checkAPI: false, timeout: 1200 });
    await denied("the svc writer is DENIED creating the goal writer's durable (create rows pin name AND filter)",
      () => pjsm.consumers.add(eprStream(), recordWriterConsumerConfig(S, RECORD_KINDS.goal)));
    c("the svc writer is DENIED records KV writes (the daemon's write rows are a separate, not-yet-composed profile)",
      (await pubProbe(pnc, `$KV.${recordsBucket(S)}.svc.${EP}.${IID}.spec`, enc.encode("{}"))) === "denied");
  }
  {
    const pnc = await open("timerw", "timerwconn");
    const pjs = jetstream(pnc, { timeout: 1500 });
    const con = await pjs.consumers.get(eptReqStreamName(S), timerWriterConsumerConfig(S).durable_name!);
    let got = 0;
    for await (const m of await con.fetch({ max_messages: 1, expires: 1200 })) { got++; m.ack(); }
    c("the timer writer consumes + acks its own EPT_REQ durable", got === 1);
    c("the timer writer is DENIED the fire rail (arming publishes ride the schedule header path, never .fire)",
      (await pubProbe(pnc, `cotal.${S}.ept.${EP}.${IID}.1.t1.fire`, enc.encode("{}"))) === "denied");
  }

  console.log("F. the serve credential's D14 bind rows: bind-only, own durables only");
  {
    const pnc = await open("serve", CONN_SERVE);
    const pjs = jetstream(pnc, { timeout: 1500 });
    const eff = await pjs.consumers.get(epfStreamName(S), effectsDurable(EP));
    let got = 0;
    for await (const m of await eff.fetch({ max_messages: 1, expires: 1200 })) { got++; m.ack(); }
    c("a journal-class instance PULLS its shared effects durable under the minted bind rows", got === 1);
    const pool = await pjs.consumers.get(epwStreamName(S), poolDurable(EP, POOL));
    let gotPool = 0;
    for await (const m of await pool.fetch({ max_messages: 1, expires: 1200 })) { gotPool++; m.ack(); }
    c("a pool-owning instance PULLS its own pool durable", gotPool >= 1);
    const pjsm = await jetstreamManager(pnc, { timeout: 1500 });
    await denied("the serve credential is DENIED CONSUMER.CREATE on its effects durable (bind-only; the provisioner pre-creates)",
      () => pjsm.consumers.add(epfStreamName(S), effectsConsumerConfig(S, EP)));
    await denied("the serve credential is DENIED a foreign pool's durable (side pool not in its grant)",
      () => pjs.consumers.get(epwStreamName(S), poolDurable(EP, POOL2)));
    await denied("the serve credential is DENIED a FOREIGN endpoint's effects durable",
      () => pjs.consumers.get(epfStreamName(S), effectsDurable(EP2)));
    c("the serve credential is DENIED raw pool enqueue (the canonicalizer's write)",
      (await pubProbe(pnc, epwSubject(S, EP, POOL, { owner: "local", actor: "cli", uid: UID, id: "srvenq01" }), enc.encode("{}"))) === "denied");
  }

  console.log("G. the untrusted caller reaches ONLY its request rails");
  {
    const pnc = await open("agent");
    c("the caller publishes its own minted request rail", (await pubProbe(pnc, `cotal.${S}.ep.one.${EP}.spawn.owner.u_abc.u_abc.cli.${UID}.n1`, enc.encode("{}"))) === "allowed");
    c("the caller is DENIED raw fact publishes", (await pubProbe(pnc, epfSubject(S, EP, ["wrk", POOL, "local", "cli", UID, "afrg0001"]), enc.encode("{}"))) === "denied");
    c("the caller is DENIED raw pool enqueue", (await pubProbe(pnc, epwSubject(S, EP, POOL, { owner: "local", actor: "cli", uid: UID, id: "agenq001" }), enc.encode("{}"))) === "denied");
    c("the caller is DENIED records KV writes", (await pubProbe(pnc, `$KV.${recordsBucket(S)}.goal.${EP}.u_abc.cli.${UID}.g.spec`, enc.encode("{}"))) === "denied");
    await denied("the caller is DENIED the leader read (no STREAM.MSG.GET anywhere on the control surface)",
      () => jetstreamManager(pnc, { checkAPI: false, timeout: 1200 }).then((m) => m.streams.getMessage(epfStreamName(S), { last_by_subj: epfSubject(S, EP, ["dec", "local", "cli", UID, "item0001"]) })));
    await denied("the caller is DENIED consumer creation on the control surface",
      () => jetstreamManager(pnc, { checkAPI: false, timeout: 1200 }).then((m) => m.consumers.add(epfStreamName(S), effectsConsumerConfig(S, EP))));
  }
} catch (e) {
  console.log("PROBE FAILED:", (e as Error).message);
  fail++;
} finally {
  for (const pnc of conns) await pnc.close().catch(() => {});
  broker.kill("SIGKILL");
  await new Promise((r) => broker.once("exit", r));
  rmSync(sd, { recursive: true, force: true });
}

console.log(fail === 0 ? `\nSTORAGE-AUTHORITY CONFINEMENT OK ✅  (${ok} passed, ${fail} failed)` : `\nSTORAGE-AUTHORITY CONFINEMENT FAILED ❌  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
