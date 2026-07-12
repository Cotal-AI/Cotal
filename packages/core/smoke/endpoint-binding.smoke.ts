/**
 * v0.4 §13.12 binding smoke — the per-space control-surface resources against a real ≥2.12
 * broker: idempotent creation, the exact config the table declares (allow_direct split,
 * schedules split, duplicate-window floor, WorkQueue), and the LOAD-BEARING live behaviors the
 * design rests on: the mediated schedule→fire path (fired message carries the broker-authored
 * `Nats-Scheduler` origin; same-subject re-arm replaces, never duplicates), the ADR-51
 * confused-deputy closure (scheduling headers on the schedules-DISABLED request stream cannot
 * cause a fire), auth-store per-key TTL (cred rows expire; the bucket has no age retention),
 * and the EPW reconciliation predicate (an acked item leaves the WorkQueue, an in-flight one
 * stays direct-readable).
 *
 * Run: pnpm smoke:ep-binding   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, headers, nanos } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable,
  createEndpointStreams,
  epjStreamName, epfStreamName, epeStreamName, eptReqStreamName, eptStreamName,
  eprStreamName, epwStreamName, epcStreamName, epAuthBucket, recordsBucket,
  EPJ_DUPLICATE_WINDOW_MS,
  canonDurable, poolDurable, timerWriterDurable, recordWriterDurable, effectsDurable,
  decisionReaderDurable, goalReaderDurable, eventReaderDurable, recordReaderDurable,
  canonConsumerConfig, poolConsumerConfig, timerWriterConsumerConfig,
  recordWriterConsumerConfig, effectsConsumerConfig, decisionReaderConfig, goalReaderConfig,
  eptSubject, epwSubject, epjSubject, appendSubmission,
  type EpCaller,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const throws = (n: string, fn: () => unknown) => { try { fn(); c(n, false, "no throw"); } catch { c(n, true); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPACE = "epbind";
const UID = "u".repeat(26);
const IID = "i".repeat(26);
const caller: EpCaller = { owner: "u_abc", actor: "worker", uid: UID };

// ── name grammar (broker-free) ──
c("stream names are the §13.12 forms",
  epjStreamName(SPACE) === "EPJ_epbind" && epfStreamName(SPACE) === "EPF_epbind"
  && epeStreamName(SPACE) === "EPE_epbind" && eptReqStreamName(SPACE) === "EPT_REQ_epbind"
  && eptStreamName(SPACE) === "EPT_epbind" && eprStreamName(SPACE) === "EPR_epbind"
  && epwStreamName(SPACE) === "EPW_epbind" && epcStreamName(SPACE) === "EPC_epbind"
  && recordsBucket(SPACE) === "cotal_records_epbind" && epAuthBucket(SPACE) === "cotal_auth_epbind");
c("the §13.9 consumer-name grammar builds its documented forms",
  canonDurable("manager") === "canon_manager"
  && poolDurable("manager", "builds") === "pool_manager_builds"
  && timerWriterDurable(SPACE) === "timerw_epbind"
  && recordWriterDurable(SPACE, "svc") === "recw_epbind-svc"
  && effectsDurable("manager") === "eff_manager"
  && decisionReaderDurable(UID, "manager") === `dec_${UID}-manager`
  && goalReaderDurable(UID, "manager") === `goal_${UID}-manager`
  && eventReaderDurable(UID, "manager", "g1", 0) === `eve_${UID}-manager-g1-0`
  && recordReaderDurable(UID, "g1", 1) === `rec_${UID}-g1-1`);
throws("a pool token with an underscore refuses (the LAST-`_` parse is the collision argument)",
  () => poolDurable("manager", "bad_pool"));
throws("a dotted (reverse-DNS) kind refuses a writer durable (dots are illegal in durable names)",
  () => recordWriterDurable(SPACE, "com.example.kind"));
throws("a negative reader subtree index refuses", () => eventReaderDurable(UID, "manager", "g1", -1));
c("infra consumer configs carry the matrix's full-tail single filters",
  canonConsumerConfig(SPACE, "manager").filter_subject === "cotal.epbind.epj.manager.>"
  && effectsConsumerConfig(SPACE, "manager").filter_subject === "cotal.epbind.epf.manager.dec.>"
  && recordWriterConsumerConfig(SPACE, "svc").filter_subject === "cotal.epbind.epr.*.*.*.svc.>"
  && timerWriterConsumerConfig(SPACE).filter_subject === "cotal.epbind.ept.*.*.*.*.schedule"
  && poolConsumerConfig(SPACE, "manager", "builds").filter_subject === "cotal.epbind.epw.manager.builds.>"
  && decisionReaderConfig(SPACE, "manager", caller).filter_subject === `cotal.epbind.epf.manager.dec.u_abc.worker.${UID}.>`
  && goalReaderConfig(SPACE, "manager", caller).filter_subject === `cotal.epbind.epf.manager.goal.u_abc.worker.${UID}.>`);

// ── the resources + live behaviors (real broker) ──
const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-epbind-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  c("broker is reachable", up);
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  const kvm = new Kvm(nc);

  await createEndpointStreams(jsm, kvm, SPACE);
  await createEndpointStreams(jsm, kvm, SPACE); // identical re-run: idempotent, no throw
  c("createEndpointStreams is idempotent", true);

  // Config assertions — the §13.12 table, read back from the broker.
  const cfg = async (name: string) => (await jsm.streams.info(name)).config;
  const epj = await cfg(epjStreamName(SPACE));
  c("EPJ has NO Direct Get (nothing reads it but the canonicalizer + harness MSG.GET)", !epj.allow_direct);
  c("EPJ's duplicate window is pinned to the server minimum, never the 120s default",
    epj.duplicate_window === nanos(EPJ_DUPLICATE_WINDOW_MS));
  c("EPF serves Direct Get (the last-by-subject fact reads)", (await cfg(epfStreamName(SPACE))).allow_direct === true);
  const eptReq = await cfg(eptReqStreamName(SPACE));
  c("EPT_REQ has message schedules DISABLED", !eptReq.allow_msg_schedules);
  const ept = await cfg(eptStreamName(SPACE));
  c("EPT has message schedules ENABLED", ept.allow_msg_schedules === true);
  const epw = await cfg(epwStreamName(SPACE));
  c("EPW is a WorkQueue with Direct Get (the reconciliation probe)",
    epw.retention === "workqueue" && epw.allow_direct === true);
  const epc = await cfg(epcStreamName(SPACE));
  c("EPC has no age eviction (artifacts are permanent)", epc.allow_direct === true && epc.max_age === 0);
  c("records KV serves Direct Get", (await cfg(`KV_${recordsBucket(SPACE)}`)).allow_direct === true);
  const auth = await cfg(`KV_${epAuthBucket(SPACE)}`);
  c("auth KV is leader-served ONLY (allow_direct=false; fences need read-your-writes)", auth.allow_direct === false);
  c("auth KV has per-key TTL machinery ON and NO bucket age retention",
    auth.allow_msg_ttl === true && auth.max_age === 0);

  // Live: the mediated timer path. The timer writer arms on `.armed` targeting the sibling
  // `.fire`; the broker fires and stamps the schedule's own subject into `Nats-Scheduler`.
  const armed = eptSubject(SPACE, "manager", IID, 1, "t1", "armed");
  const fire = eptSubject(SPACE, "manager", IID, 1, "t1", "fire");
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  const h1 = headers();
  h1.set("Nats-Schedule", `@at ${at(5000)}`); // pre-replacement arm: far enough out to never fire first
  h1.set("Nats-Schedule-Target", fire);
  await js.publish(armed, new TextEncoder().encode(JSON.stringify({ timerId: "t1", generation: 1 })), { headers: h1 });
  const h2 = headers();
  h2.set("Nats-Schedule", `@at ${at(1200)}`);
  h2.set("Nats-Schedule-Target", fire);
  await js.publish(armed, new TextEncoder().encode(JSON.stringify({ timerId: "t1", generation: 2 })), { headers: h2 });
  const armedCount = (await jsm.streams.info(eptStreamName(SPACE), { subjects_filter: armed })).state.subjects?.[armed];
  c("a same-subject re-arm REPLACES the schedule (server rollup, §13.12)", armedCount === 1);

  // Live: the ADR-51 confused deputy. A `.schedule` REQUEST carrying scheduling headers lands
  // (or is refused) on the schedules-DISABLED stream — either way it can never cause a fire.
  const victimFire = eptSubject(SPACE, "manager", IID, 1, "victim", "fire");
  const dep = headers();
  dep.set("Nats-Schedule", `@at ${at(1000)}`);
  dep.set("Nats-Schedule-Target", victimFire);
  let deputyRefused = false;
  try {
    await js.publish(eptSubject(SPACE, "manager", IID, 1, "victim", "schedule"), new Uint8Array(0), { headers: dep });
  } catch {
    deputyRefused = true; // refusing the publish outright also closes the deputy
  }

  await wait(2600); // past both @at instants
  const fired = await jsm.streams.getMessage(eptStreamName(SPACE), { last_by_subj: fire });
  c("the armed schedule FIRED onto its sibling .fire", fired !== null);
  c("the fired message carries the broker-authored Nats-Scheduler = its own .armed subject (§13.2 origin check)",
    fired?.header?.get("Nats-Scheduler") === armed);
  c("the replaced (generation-1) schedule never fired (one fire, generation 2)",
    fired !== null && JSON.parse(new TextDecoder().decode(fired.data)).generation === 2);
  let victimFired = true;
  try {
    victimFired = (await jsm.streams.getMessage(eptStreamName(SPACE), { last_by_subj: victimFire })) !== null;
  } catch { victimFired = false; }
  c(`scheduling headers on the request stream are ${deputyRefused ? "refused" : "inert"} — the deputy cannot fire`,
    !victimFired);

  // Live: auth-store per-key TTL — a cred row expires by itself; authority keys persist.
  const authKv = await kvm.open(epAuthBucket(SPACE));
  await authKv.create(`cred.${UID}.c1`, new TextEncoder().encode("{}"), "1s");
  await authKv.create(`gate.${UID}`, new TextEncoder().encode(`{"state":"open"}`));
  const live = await authKv.get(`cred.${UID}.c1`);
  c("a TTL'd cred row is readable before expiry", live !== null && live.operation === "PUT");
  await wait(2200);
  // Expiry leaves a MaxAge purge MARKER on the key (operation PURGE, empty value) — the marker
  // itself carries the bucket's markerTTL and then vanishes. A ledger reader treats DEL/PURGE
  // as absent, the standard KV discipline.
  const expired = await authKv.get(`cred.${UID}.c1`);
  c("the cred row EXPIRED by per-key TTL (gone, or its transient MaxAge purge marker)",
    expired === null || (expired.operation === "PURGE" && expired.value.length === 0));
  const gate = await authKv.get(`gate.${UID}`);
  c("the un-TTL'd gate row persists (no bucket age retention)", gate !== null && gate.operation === "PUT");

  // Live: EPW reconciliation predicate — acked leaves the WorkQueue, in-flight stays readable.
  await jsm.consumers.add(epwStreamName(SPACE), poolConsumerConfig(SPACE, "manager", "builds"));
  const item1 = epwSubject(SPACE, "manager", "builds", { ...caller, id: "req-1" });
  const item2 = epwSubject(SPACE, "manager", "builds", { ...caller, id: "req-2" });
  await js.publish(item1, new TextEncoder().encode("w1"));
  await js.publish(item2, new TextEncoder().encode("w2"));
  const poolC = await js.consumers.get(epwStreamName(SPACE), poolDurable("manager", "builds"));
  const batch = await poolC.fetch({ max_messages: 1, expires: 2000 });
  let first: string | undefined;
  for await (const m of batch) { first = m.subject; m.ack(); }
  c("the pool consumer delivers a work item", first === item1);
  await wait(300); // let the ack commit (WorkQueue removal)
  let ackedGone = false;
  try { ackedGone = (await jsm.direct.getMessage(epwStreamName(SPACE), { last_by_subj: item1 })) === null; }
  catch { ackedGone = true; }
  c("an ACKED item has LEFT the WorkQueue (direct probe finds nothing)", ackedGone);
  const inflight = await jsm.direct.getMessage(epwStreamName(SPACE), { last_by_subj: item2 });
  c("an un-acked item REMAINS direct-readable (the §13.6 reconciliation predicate)", inflight !== null);

  // Live: the canonicalizer's durable form consumes exactly its endpoint's submissions.
  await jsm.consumers.add(epjStreamName(SPACE), canonConsumerConfig(SPACE, "manager"));
  await appendSubmission(js, epjSubject(SPACE, { endpoint: "manager", command: "spawn", caller }), { v: 1, id: "req-1" });
  await appendSubmission(js, epjSubject(SPACE, { endpoint: "other", command: "spawn", caller }), { v: 1, id: "req-2" });
  const canonC = await js.consumers.get(epjStreamName(SPACE), canonDurable("manager"));
  const cb = await canonC.fetch({ max_messages: 2, expires: 1500 });
  const got: string[] = [];
  for await (const m of cb) { got.push(m.subject); m.ack(); }
  c("the canonicalizer durable sees ONLY its own endpoint's submissions",
    got.length === 1 && got[0].startsWith("cotal.epbind.epj.manager."));

  await nc.drain().catch(() => {});
  console.log(`\nENDPOINT BINDING SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
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
