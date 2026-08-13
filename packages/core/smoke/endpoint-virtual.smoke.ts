/**
 * v0.4 §13.6 virtual-endpoint smoke — the admission fence, the INFO-poll activator, and
 * restart-intensity supervision against a real broker, under the panel's expanded bar. Covers:
 * the config pins (explicit `max_deliver: -1`; the admission durable's `max_ack_pending: 1` by
 * construction, live-asserted, behaviorally serial, AND RE-PROVED at every admit since
 * MaxAckPending is editable), the fail-closed occupancy read (missing consumer unavailable;
 * MaxDeliver drift; FILTER drift — FilterSubject is editable and a narrowed filter undercounts
 * stored work; multi-filter refusal), the branded contexts (hand-assembled WorkPoolContext and
 * ActivatorContext look-alikes refuse), the REGISTERED activation policy (closed schema,
 * capacity required) binding admission, reconcile-orphans-before-admit, the activator's
 * bounded poll/backoff over its NARROW context + the exact one-row grant profile
 * (activatorGrants) + the module-source default-deny grep + stop() re-checked after awaits
 * (a not-yet-begun start never begins after stop), and durable SUPERVISOR-OWNED restart
 * intensity: epoch-bound idempotent notes (a replayed note never double-counts), history
 * carried forward through an ordinary successor `ready` write (neither reset nor forged),
 * clock-regression refusal, escalation IRREVERSIBLE at the status writer, the retirement
 * reconciler (retry until the idempotent retire seam succeeds, durable completion mark), the
 * revision-pinned note CAS, garbled-history refusal, the epoch fence, and escalated instances
 * excluded from scatter's frozen expected set.
 *
 * Run: pnpm smoke:ep-virtual   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import * as core from "../src/index.js";
import {
  isReachable, EpEnvelopeError,
  createEndpointStreams, epwStreamName, epjStreamName, poolDurable, canonDurable,
  poolConsumerConfig, virtualAdmissionConsumerConfig, activatorContext, activatorGrants,
  workPoolContext, enqueueWorkItem, openRecordsBucket, epjSubject,
  readPoolOccupancy, admitVirtualWork, startVirtualActivator, noteInstanceRestart,
  reconcileEscalation, parseActivationPolicy, freezeExpectedSet,
  writeServiceStatus, RESTART_HISTORY_FIELD, RETIRED_MARK_FIELD,
  SERVICE_ESCALATED, SERVICE_EXITED, SERVICE_READY,
  RECORD_KINDS, recordSpecKey, recordStatusKey, createRecordEntry,
  type EpCaller, type WorkItemRef, type WorkPoolContext, type ServiceStatus,
  type ActivatorContext, type RestartHistoryEntry,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const rejects = async (n: string, fn: () => Promise<unknown> | unknown, code?: string) => {
  try { await fn(); c(n, false, "no throw"); } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`);
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (f()) return true; await wait(20); }
  return f();
}

const SPACE = "epvirtual";
const UID = "u".repeat(26);
const caller: EpCaller & { id: string } = { owner: "u_abc", actor: "worker", uid: UID, id: "req-1" };
const ref = (id: string, pool: string): WorkItemRef => ({ endpoint: "manager", pool, acceptance: { ...caller, id } });
const enc = (s: string) => new TextEncoder().encode(s);
const td = new TextDecoder();

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-epvirtual-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  await createEndpointStreams(jsm, new Kvm(nc), SPACE);
  const kv = await openRecordsBucket(nc, SPACE);
  const ctx: WorkPoolContext = await workPoolContext(nc, SPACE);
  const NOW = 1_000_000;
  const EXPIRY = NOW + 60_000;

  console.log("A. config pins + the registered activation policy (closed schema)");
  {
    const pc = poolConsumerConfig(SPACE, "manager", "vbuilds");
    c("poolConsumerConfig pins max_deliver: -1 EXPLICITLY (never the implicit server default)", pc.max_deliver === -1);
    const ac = virtualAdmissionConsumerConfig(SPACE, "manager");
    c("virtualAdmissionConsumerConfig pins max_ack_pending: 1 BY CONSTRUCTION (no opt-out surface)", ac.max_ack_pending === 1);
    c("…and it is the endpoint's canonicalizer durable on EPJ (same admission path, serialized)",
      ac.durable_name === canonDurable("manager") && (ac.filter_subject as string).includes(".epj.manager."));
    await jsm.consumers.add(epjStreamName(SPACE), ac);
    const live = await jsm.consumers.info(epjStreamName(SPACE), canonDurable("manager"));
    c("the LIVE admission consumer reports max_ack_pending 1 (creation intent held)", live.config.max_ack_pending === 1);
    // Behavioral proof of SERIAL admission: with one delivered-unacked submission, the broker
    // suspends further delivery.
    const subj = () => epjSubject(SPACE, { endpoint: "manager", command: "build", caller: { owner: caller.owner, actor: caller.actor, uid: caller.uid } });
    await js.publish(subj(), enc("s1"));
    await js.publish(subj(), enc("s2"));
    const canonC = await js.consumers.get(epjStreamName(SPACE), canonDurable("manager"));
    const first: Array<{ ack: () => void }> = [];
    for await (const m of await canonC.fetch({ max_messages: 2, expires: 1200 })) first.push(m);
    c("one submission is in the admission path at a time (the second is withheld while the first is unacked)", first.length === 1, { got: first.length });
    first[0]!.ack();
    await wait(200);
    const second: Array<{ ack: () => void }> = [];
    for await (const m of await canonC.fetch({ max_messages: 1, expires: 1200 })) second.push(m);
    c("…and the ack releases exactly the next one", second.length === 1);
    second[0]!.ack();

    // The activation policy is a CLOSED schema with a REQUIRED capacity.
    c("parseActivationPolicy accepts the registered shape", parseActivationPolicy({ mode: "on-demand", capacity: 4, maxRestarts: 2 }).capacity === 4);
    await rejects("a policy without capacity refuses (an unbounded pool is not a policy)", () => parseActivationPolicy({ mode: "on-demand" }));
    await rejects("a zero capacity refuses", () => parseActivationPolicy({ mode: "on-demand", capacity: 0 }));
    await rejects("an unknown policy field refuses (closed schema)", () => parseActivationPolicy({ mode: "on-demand", capacity: 1, extra: true }));
    await rejects("a foreign mode refuses", () => parseActivationPolicy({ mode: "eager", capacity: 1 }));
    c("the activator grant profile is the ONE per-pool Consumer INFO publish row + no inbox without a connId",
      JSON.stringify(activatorGrants(SPACE, "manager", "vbuilds")) === JSON.stringify({ publish: [`$JS.API.CONSUMER.INFO.EPW_epvirtual.pool_manager_vbuilds`], subscribe: [] }));
    c("a connId adds exactly the CONNECTION-SCOPED reply inbox (never account-wide _INBOX.>)",
      JSON.stringify(activatorGrants(SPACE, "manager", "vbuilds", "actconn1").subscribe) === JSON.stringify(["_INBOX_actconn1.>"]));
  }

  console.log("B. the fail-closed occupancy read (every editable knob re-proved)");
  {
    await jsm.consumers.add(epwStreamName(SPACE), poolConsumerConfig(SPACE, "manager", "vbuilds", { ackWaitMs: 60_000 }));
    const live = await jsm.consumers.info(epwStreamName(SPACE), poolDurable("manager", "vbuilds"));
    c("the LIVE pool consumer reports max_deliver -1", live.config.max_deliver === -1);
    const o0 = await readPoolOccupancy(ctx, "manager", "vbuilds");
    c("an empty pool reads occupancy 0", o0.occupancy === 0 && o0.pending === 0 && o0.ackPending === 0, o0);
    await enqueueWorkItem(ctx, ref("vb-1", "vbuilds"), enc("w1"));
    await enqueueWorkItem(ctx, ref("vb-2", "vbuilds"), enc("w2"));
    const o2 = await readPoolOccupancy(ctx, "manager", "vbuilds");
    c("two enqueued items read pending 2 / occupancy 2", o2.pending === 2 && o2.occupancy === 2, o2);
    const poolC = await js.consumers.get(epwStreamName(SPACE), poolDurable("manager", "vbuilds"));
    for await (const _m of await poolC.fetch({ max_messages: 1, expires: 1200 })) { /* deliver, DON'T ack */ }
    const oMix = await readPoolOccupancy(ctx, "manager", "vbuilds");
    c("a delivered-unacked item COUNTS: pending 1 + ackPending 1 = occupancy 2 (in-flight work is not free capacity)",
      oMix.pending === 1 && oMix.ackPending === 1 && oMix.occupancy === 2, oMix);
    await rejects("a MISSING pool consumer is unavailable, never a fabricated zero (admission fails closed)",
      () => readPoolOccupancy(ctx, "manager", "ghost"), "unavailable");
    // MaxDeliver is EDITABLE post-create: drift the live consumer and the reader refuses.
    await jsm.consumers.update(epwStreamName(SPACE), poolDurable("manager", "vbuilds"), { max_deliver: 5 });
    await rejects("post-create MaxDeliver drift refuses at READ time (creation intent proves nothing later)",
      () => readPoolOccupancy(ctx, "manager", "vbuilds"), "failed-precondition");
    await jsm.consumers.update(epwStreamName(SPACE), poolDurable("manager", "vbuilds"), { max_deliver: -1 });
    // FilterSubject is EDITABLE too: a narrowed/foreign filter reads 0 while work remains stored.
    await jsm.consumers.update(epwStreamName(SPACE), poolDurable("manager", "vbuilds"), { filter_subject: `cotal.${SPACE}.epw.manager.vbuilds.u_abc.>` });
    await rejects("post-create FILTER drift refuses at READ time (a narrowed filter undercounts stored work)",
      () => readPoolOccupancy(ctx, "manager", "vbuilds"), "failed-precondition");
    await jsm.consumers.update(epwStreamName(SPACE), poolDurable("manager", "vbuilds"), { filter_subject: `cotal.${SPACE}.epw.manager.vbuilds.>` });
    c("repinning the exact config restores the read", (await readPoolOccupancy(ctx, "manager", "vbuilds")).occupancy === 2);
    // The context is BRANDED: a hand-assembled look-alike never authorizes.
    await rejects("a hand-built WorkPoolContext look-alike refuses (the space bond is constructed, not asserted)",
      () => readPoolOccupancy({ kv: ctx.kv, js: ctx.js, jsm: ctx.jsm, space: SPACE } as WorkPoolContext, "manager", "vbuilds"), "failed-precondition");
  }

  console.log("C. admission: the REGISTRATION-BOUND capacity fence + the live serial pin + orphan repair");
  {
    // The capacity is READ from the endpoint's registered svc spec, never the caller. Register
    // three virtual manager instances at distinct capacities (the pool 'vbuilds' occupancy is
    // shared across them) so the fence is proven against the REGISTERED value, not an argument.
    const vspec = (cap: number) => ({ endpoint: "manager", owner: "u_wrk", clusterDigests: [`sha256:${"0".repeat(64)}`], protocol: { v: 1 }, activation: { mode: "on-demand", capacity: cap } });
    const M2 = "a".repeat(26), M3 = "b".repeat(26), M4 = "c".repeat(26), MPLAIN = "d".repeat(26), MGHOST = "e".repeat(26);
    await createRecordEntry(kv, recordSpecKey(RECORD_KINDS.svc, ["manager", M2]), vspec(2));
    await createRecordEntry(kv, recordSpecKey(RECORD_KINDS.svc, ["manager", M3]), vspec(3));
    await createRecordEntry(kv, recordSpecKey(RECORD_KINDS.svc, ["manager", M4]), vspec(4));
    await createRecordEntry(kv, recordSpecKey(RECORD_KINDS.svc, ["manager", MPLAIN]), { endpoint: "manager", owner: "u_wrk", clusterDigests: [`sha256:${"0".repeat(64)}`], protocol: { v: 1 } });

    await rejects("a hand-built context refuses at admission too",
      () => admitVirtualWork({ kv: ctx.kv, js: ctx.js, jsm: ctx.jsm, space: SPACE } as WorkPoolContext, { endpoint: "manager", pool: "vbuilds", instanceId: M2, now: NOW }), "failed-precondition");
    await rejects("admission against an UNREGISTERED instance refuses (no policy to bind to)",
      () => admitVirtualWork(ctx, { endpoint: "manager", pool: "vbuilds", instanceId: MGHOST, now: NOW }), "failed-precondition");
    await rejects("admission against a NON-VIRTUAL registration (no activation) refuses",
      () => admitVirtualWork(ctx, { endpoint: "manager", pool: "vbuilds", instanceId: MPLAIN, now: NOW }), "failed-precondition");
    const full = await admitVirtualWork(ctx, { endpoint: "manager", pool: "vbuilds", instanceId: M2, now: NOW });
    c("occupancy 2 against the REGISTERED capacity 2 is REFUSED (the caller cannot widen it)",
      !full.admitted && full.occupancy.occupancy === 2 && full.capacity === 2 && full.repaired === 0, full);
    const free = await admitVirtualWork(ctx, { endpoint: "manager", pool: "vbuilds", instanceId: M3, now: NOW });
    c("occupancy 2 against REGISTERED capacity 3 admits", free.admitted && free.occupancy.occupancy === 2 && free.capacity === 3, free);
    // The SERIAL PIN is re-proved LIVE at every admission (MaxAckPending is editable).
    await jsm.consumers.update(epjStreamName(SPACE), canonDurable("manager"), { max_ack_pending: 2 });
    await rejects("a drifted admission durable (max_ack_pending 2) REFUSES admission (the serial invariant is gone, never assumed)",
      () => admitVirtualWork(ctx, { endpoint: "manager", pool: "vbuilds", instanceId: M3, now: NOW }), "failed-precondition");
    await jsm.consumers.update(epjStreamName(SPACE), canonDurable("manager"), { max_ack_pending: 1 });
    c("repinning the admission durable restores admission",
      (await admitVirtualWork(ctx, { endpoint: "manager", pool: "vbuilds", instanceId: M3, now: NOW })).admitted);
    // ORPHAN REPAIR ORDERING: an acceptance that never made it into the pool is re-enqueued
    // FIRST and then COUNTED: the capacity-3 registration now refuses.
    const orphan = ref("vb-lost", "vbuilds");
    const repaired = await admitVirtualWork(ctx, {
      endpoint: "manager", pool: "vbuilds", instanceId: M3, now: NOW,
      outstanding: [{ ref: orphan, itemBytes: enc("lost"), workExpiry: EXPIRY }],
    });
    c("a lost acceptance is repaired INTO the pool before counting (repaired 1, occupancy 3, registered capacity 3 refuses)",
      repaired.repaired === 1 && repaired.occupancy.occupancy === 3 && !repaired.admitted, repaired);
    const again = await admitVirtualWork(ctx, {
      endpoint: "manager", pool: "vbuilds", instanceId: M4, now: NOW,
      outstanding: [{ ref: orphan, itemBytes: enc("lost"), workExpiry: EXPIRY }],
    });
    c("re-presenting the same acceptance repairs NOTHING (the live entry settles the predicate; idempotent)",
      again.repaired === 0 && again.occupancy.occupancy === 3 && again.admitted, again);
  }

  console.log("D. the INFO-poll activator over its NARROW branded context");
  {
    const actx: ActivatorContext = await activatorContext(nc, SPACE);
    await rejects("a hand-built ActivatorContext look-alike refuses",
      () => startVirtualActivator({ ctx: { jsm: ctx.jsm, space: SPACE } as ActivatorContext, endpoint: "manager", pool: "vact", startInstance: async () => {}, isLive: () => false, onError: () => {} }), "failed-precondition");
    await rejects("pollMs 0 refuses", () => startVirtualActivator({ ctx: actx, endpoint: "manager", pool: "vact", startInstance: async () => {}, isLive: () => false, onError: () => {}, pollMs: 0 }), "contract-invalid");
    await rejects("maxPollMs below pollMs refuses", () => startVirtualActivator({ ctx: actx, endpoint: "manager", pool: "vact", startInstance: async () => {}, isLive: () => false, onError: () => {}, pollMs: 500, maxPollMs: 100 }), "contract-invalid");
    await rejects("an INFINITE backoff ceiling refuses (the ceiling bounds the activation delay)",
      () => startVirtualActivator({ ctx: actx, endpoint: "manager", pool: "vact", startInstance: async () => {}, isLive: () => false, onError: () => {}, maxPollMs: Number.POSITIVE_INFINITY }), "contract-invalid");
    await rejects("a missing onError refuses (an unobserved activator failure is a silent liveness hole)",
      () => startVirtualActivator({ ctx: actx, endpoint: "manager", pool: "vact", startInstance: async () => {}, isLive: () => false, onError: undefined as never }), "contract-invalid");

    await jsm.consumers.add(epwStreamName(SPACE), poolConsumerConfig(SPACE, "manager", "vact"));
    const delays: number[] = [];
    let pending: (() => void) | undefined;
    const timerFns = {
      setTimeoutFn: (fn: () => void, ms: number) => { delays.push(ms); pending = fn; return {}; },
      clearTimeoutFn: () => { pending = undefined; },
    };
    const fire = async (n = 1) => { for (let i = 0; i < n; i++) { const f = pending; pending = undefined; f?.(); await wait(120); } };

    // Quiet pool: backoff doubles toward the FINITE ceiling and never exceeds it.
    const errsQ: string[] = [];
    const quiet = startVirtualActivator({ ctx: actx, endpoint: "manager", pool: "vact", startInstance: async () => {}, isLive: () => false, onError: (k) => errsQ.push(k), pollMs: 100, maxPollMs: 400, ...timerFns });
    await fire(4);
    c("quiet polls back off toward the ceiling and CAP there (100 → 200 → 400 → 400…)",
      delays.length >= 5 && delays[0] === 100 && delays[1] === 200 && delays[2] === 400 && delays.slice(2).every((d) => d === 400), delays);
    c("…with no starts and no errors on a quiet healthy pool", quiet.stats().starts === 0 && errsQ.length === 0, quiet.stats());
    quiet.stop();
    c("stop() halts the loop (no pending tick survives)", pending === undefined);

    // Work present: exactly ONE start while it is in flight (dedupe), polls continue at base rate.
    await enqueueWorkItem(ctx, ref("va-1", "vact"), enc("wa"));
    delays.length = 0;
    let releaseStart: () => void = () => {};
    const startGate = new Promise<void>((r) => { releaseStart = r; });
    let startCalls = 0;
    const errsW: string[] = [];
    const busy = startVirtualActivator({
      ctx: actx, endpoint: "manager", pool: "vact",
      startInstance: async () => { startCalls++; await startGate; },
      isLive: () => false, onError: (k) => errsW.push(k), pollMs: 100, maxPollMs: 400, ...timerFns,
    });
    await fire(3);
    c("work present: the bound startInstance fires EXACTLY once while in flight (local dedupe)",
      startCalls === 1 && busy.stats().starts === 1, { startCalls, stats: busy.stats() });
    c("…polling continues at the BASE rate while work is present (a wedged start stays observable)",
      delays.every((d) => d === 100) && busy.stats().polls >= 3, delays);
    releaseStart();
    await until(() => busy.stats().starts === 1);
    busy.stop();

    // isLive short-circuits the start (a live instance is never doubled).
    let liveStarts = 0;
    const alive = startVirtualActivator({ ctx: actx, endpoint: "manager", pool: "vact", startInstance: async () => { liveStarts++; }, isLive: () => true, onError: () => {}, pollMs: 100, ...timerFns });
    await fire(2);
    c("a LIVE instance suppresses the start (isLive gate)", liveStarts === 0 && alive.stats().starts === 0);
    alive.stop();

    // STOP is re-checked after awaits: stop() while the liveness read is pending means a
    // not-yet-begun start NEVER begins (the same recheck guards the INFO await).
    let raceStarts = 0;
    let releaseLive: (v: boolean) => void = () => {};
    const liveGate = new Promise<boolean>((r) => { releaseLive = r; });
    const racer = startVirtualActivator({
      ctx: actx, endpoint: "manager", pool: "vact",
      startInstance: async () => { raceStarts++; },
      isLive: () => liveGate, onError: () => {}, pollMs: 100, ...timerFns,
    });
    await fire(1); // the tick saw occupancy > 0 and is awaiting isLive
    racer.stop(); // stop lands while the liveness read is pending
    releaseLive(false); // the read resolves "not live" INTO a stopped activator
    await wait(100);
    c("stop() during a pending await prevents a not-yet-begun start (re-checked after EVERY await)",
      raceStarts === 0 && racer.stats().starts === 0, { raceStarts, stats: racer.stats() });
    // A REJECTING isLive after stop is SILENT: no start began, so it is the stop winning a
    // race, not a real activation fault — onError must NOT fire (false-alarm noise).
    const raceErrs: string[] = [];
    let rejectLive: (e: Error) => void = () => {};
    const rejGate = new Promise<boolean>((_r, rej) => { rejectLive = rej; });
    const rejRacer = startVirtualActivator({
      ctx: actx, endpoint: "manager", pool: "vact",
      startInstance: async () => {}, isLive: () => rejGate, onError: (k) => raceErrs.push(k), pollMs: 100, ...timerFns,
    });
    await fire(1);
    rejRacer.stop();
    rejectLive(new Error("liveness backend blip"));
    await wait(100);
    c("a REJECTING isLive after stop is SILENT (no onError for a pre-start race the stop won)",
      raceErrs.length === 0 && rejRacer.stats().startErrors === 0, { raceErrs, stats: rejRacer.stats() });

    // INFO failure is LOUD and polling continues with backoff.
    const errsI: Array<{ k: string }> = [];
    delays.length = 0;
    const blind = startVirtualActivator({ ctx: actx, endpoint: "manager", pool: "ghost", startInstance: async () => {}, isLive: () => false, onError: (k) => errsI.push({ k }), pollMs: 100, maxPollMs: 400, ...timerFns });
    await fire(2);
    c("an INFO failure surfaces loudly (onError 'info') and the loop keeps polling with backoff",
      errsI.length >= 2 && errsI.every((e) => e.k === "info") && blind.stats().infoErrors >= 2 && delays.length >= 2, { errsI, delays });
    blind.stop();

    // A start failure surfaces loudly and CLEARS the in-flight guard (the next tick retries).
    let attempt = 0;
    const errsS: string[] = [];
    const flaky = startVirtualActivator({
      ctx: actx, endpoint: "manager", pool: "vact",
      startInstance: async () => { attempt++; throw new Error("boom"); },
      isLive: () => false, onError: (k) => errsS.push(k), pollMs: 100, ...timerFns,
    });
    await fire(2);
    c("a start failure surfaces loudly (onError 'start') and the guard clears for a retry",
      attempt >= 2 && errsS.filter((k) => k === "start").length >= 2 && flaky.stats().startErrors >= 2, { attempt, errsS });
    flaky.stop();

    // DEFAULT-DENY: the module's only JetStream API calls are the two exact consumers.info
    // reads (pool occupancy + the live admission-pin proof); no consume/ack/fetch/read/mutate.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "endpoint-virtual.ts"), "utf8");
    for (const forbidden of [".consumers.add(", ".consumers.delete(", ".consumers.update(", ".next(", ".fetch(", ".ack(", ".getMessage(", ".direct.", ".subscribe(", ".publish("]) {
      c(`default-deny: endpoint-virtual.ts never uses "${forbidden}"`, !src.includes(forbidden));
    }
    c("…and its JetStream API surface is exactly the two consumers.info reads", (src.match(/\.consumers\.info\(/g) ?? []).length === 2);
  }

  console.log("E. durable, supervisor-owned, epoch-idempotent restart intensity");
  {
    const IID = "i".repeat(26);
    let currentEpoch = 7;
    const spec = { endpoint: "manager", owner: "u_wrk", clusterDigests: [`sha256:${"0".repeat(64)}`], protocol: { v: 1 }, activation: { mode: "on-demand", capacity: 2 } };
    await createRecordEntry(kv, recordSpecKey(RECORD_KINDS.svc, ["manager", IID]), spec);
    const readEpoch = () => currentEpoch;
    const retire: string[] = [];
    const note = (now: number, epoch: number, over: Partial<Parameters<typeof noteInstanceRestart>[1]> = {}) => {
      currentEpoch = epoch;
      return noteInstanceRestart(kv, { endpoint: "manager", instanceId: IID, epoch, now, readProcessEpoch: readEpoch, readSpecLeader: specLeader(IID), retireLifecycle: async () => { retire.push("called"); }, ...over });
    };
    const readStatus = async (iid: string): Promise<ServiceStatus> => JSON.parse(td.decode((await kv.get(recordStatusKey(RECORD_KINDS.svc, ["manager", iid])))!.value)) as ServiceStatus;
    // The restart-policy read is leader-served by contract; single-node broker = kv.get is the
    // leader, so wire a {value, revision} reader over the spec key for each instance.
    const specLeader = (iid: string) => async () => { const e = await kv.get(recordSpecKey(RECORD_KINDS.svc, ["manager", iid])); return e && e.operation === "PUT" ? { value: JSON.parse(td.decode(e.value)), revision: e.revision } : undefined; };

    // SUPERVISOR-FIELD FORGE: the authority to originate the supervisor-owned state is a BRANDED
    // grant, NOT revision presence — so a forge is refused whether the caller pins a revision or
    // not (the old expectedStatusRevision-implies-privilege gate let any caller selecting the
    // current revision forge). On both the create and the update path, an ungranted write cannot
    // originate escalated and its restarts/retiredAt are stripped.
    const IIDG = "g".repeat(26);
    await createRecordEntry(kv, recordSpecKey(RECORD_KINDS.svc, ["manager", IIDG]), spec);
    await rejects("a FIRST ungranted write cannot ORIGINATE escalated (create-path forge refused)",
      () => writeServiceStatus(kv, { endpoint: "manager", instanceId: IIDG, epoch: 1, status: { epoch: 1, state: SERVICE_ESCALATED, observedSpecRevision: 0 }, readProcessEpoch: () => 1 }), "failed-precondition");
    await rejects("a PINNED but ungranted write ALSO cannot originate escalated (revision presence is not authority)",
      () => writeServiceStatus(kv, { endpoint: "manager", instanceId: IIDG, epoch: 1, status: { epoch: 1, state: SERVICE_ESCALATED, observedSpecRevision: 0 }, readProcessEpoch: () => 1, expectedStatusRevision: 0 }), "failed-precondition");
    await writeServiceStatus(kv, { endpoint: "manager", instanceId: IIDG, epoch: 1, status: { epoch: 1, state: SERVICE_READY, observedSpecRevision: 0, [RESTART_HISTORY_FIELD]: [{ t: 5, epoch: -1 }], [RETIRED_MARK_FIELD]: 123 } as ServiceStatus, readProcessEpoch: () => 1, expectedStatusRevision: 0 });
    {
      const s = await readStatus(IIDG);
      c("a PINNED but ungranted first write STRIPS forged restarts/retiredAt (branded authority, not revision presence)",
        s.state === SERVICE_READY && s[RESTART_HISTORY_FIELD] === undefined && s[RETIRED_MARK_FIELD] === undefined, s);
    }
    const forgedRecon = await reconcileEscalation(kv, { endpoint: "manager", instanceId: IIDG, now: NOW, retireLifecycle: async () => { throw new Error("should never be called on a non-escalated row"); } });
    c("…so a forged completion mark cannot fake retirement (the row is not escalated; reconcile is a clean no-op)",
      !forgedRecon.escalated && !forgedRecon.acted, forgedRecon);
    // The supervisor-write MINT is NOT in the public API: an @cotal-ai/core consumer cannot
    // import it and forge, so the brand is a real authority boundary (the sanctioned origination
    // path is exercised through noteInstanceRestart below, never a public factory).
    c("the supervisor-write mint is NOT publicly exported (no ambient forge factory)",
      (core as Record<string, unknown>).supervisorWriteGrant === undefined && (core as Record<string, unknown>).mintSupervisorWrite === undefined);

    const n1 = await note(NOW, 7);
    c("restart 1 records durably (exited, history 1, epoch-bound entry)", !n1.escalated && !n1.duplicate && n1.restartsInWindow === 1, n1);
    const n2 = await note(NOW + 1000, 8);
    const n3 = await note(NOW + 2000, 9);
    c("restarts 2 and 3 within the window accumulate", !n2.escalated && !n3.escalated && n3.restartsInWindow === 3, { n2, n3 });
    const dup = await note(NOW + 2500, 9);
    c("a REPLAYED note for an already-recorded dying epoch is an idempotent no-op (one restart counts once)",
      dup.duplicate && !dup.escalated && dup.restartsInWindow === 3, dup);
    {
      const s = await readStatus(IID);
      const hist = s[RESTART_HISTORY_FIELD] as RestartHistoryEntry[];
      c("the history rides the DURABLE status record, epoch-bound, un-inflated by the replay",
        s.state === SERVICE_EXITED && hist.length === 3 && hist.every((e) => [7, 8, 9].includes(e.epoch)), s);
    }
    // SUPERVISOR OWNERSHIP: the successor's ORDINARY ready write neither resets nor forges.
    currentEpoch = 10;
    await writeServiceStatus(kv, { endpoint: "manager", instanceId: IID, epoch: 10, status: { epoch: 10, state: SERVICE_READY, observedSpecRevision: 0 }, readProcessEpoch: readEpoch });
    {
      const s = await readStatus(IID);
      c("an ordinary successor `ready` write CARRIES the history FORWARD (a real restart cycle cannot amnesty the count)",
        s.state === SERVICE_READY && (s[RESTART_HISTORY_FIELD] as RestartHistoryEntry[]).length === 3, s);
    }
    await writeServiceStatus(kv, { endpoint: "manager", instanceId: IID, epoch: 10, status: { epoch: 10, state: SERVICE_READY, observedSpecRevision: 0, [RESTART_HISTORY_FIELD]: [] }, readProcessEpoch: readEpoch });
    {
      const s = await readStatus(IID);
      c("…and an instance-side write CANNOT FORGE/RESET it (the incoming field is stripped, the stored one copied)",
        (s[RESTART_HISTORY_FIELD] as RestartHistoryEntry[]).length === 3, s);
    }
    // The 4th DISTINCT restart within the window escalates; the retire seam runs; the mark lands.
    const n4 = await note(NOW + 3000, 10);
    c("the 4th restart within 60s ESCALATES (status escalated, D13 retire seam invoked once)",
      n4.escalated && n4.restartsInWindow === 4 && retire.length === 1, { n4, retire });
    {
      const s = await readStatus(IID);
      c("…the escalation is durable and the retirement mark landed (best-effort on the happy path)",
        s.state === SERVICE_ESCALATED && s[RETIRED_MARK_FIELD] !== undefined, s);
    }
    await rejects("an escalated identity REFUSES further restart notes (the instance stops restarting, terminally)",
      () => note(NOW + 4000, 11), "failed-precondition");
    // IRREVERSIBLE: no ordinary status write clears an escalated row.
    await rejects("a `ready` write over an escalated row REFUSES (escalation is irreversible at the writer)",
      () => writeServiceStatus(kv, { endpoint: "manager", instanceId: IID, epoch: 11, status: { epoch: 11, state: SERVICE_READY, observedSpecRevision: 0 }, readProcessEpoch: () => 11 }), "failed-precondition");
    // The reconciler on a fully-retired row is a no-op.
    const done = await reconcileEscalation(kv, { endpoint: "manager", instanceId: IID, now: NOW + 5000, retireLifecycle: async () => { retire.push("again"); } });
    c("the reconciler on an already-marked escalation is a NO-OP (idempotent, the seam is not re-invoked)",
      done.escalated && done.retired && !done.acted && retire.length === 1, { done, retire });

    // REGISTRATION-BOUND thresholds + HONEST HALVES + RETRY: the maxRestarts comes from the
    // REGISTERED activation policy (a supervisor cannot loosen it), so a spec with maxRestarts 1
    // escalates on the SECOND note. A failing retire seam leaves the escalation standing; the
    // reconciler is the retry that completes retirement and marks it.
    const IIDF = "k".repeat(26);
    await createRecordEntry(kv, recordSpecKey(RECORD_KINDS.svc, ["manager", IIDF]), { endpoint: "manager", owner: "u_wrk", clusterDigests: [`sha256:${"0".repeat(64)}`], protocol: { v: 1 }, activation: { mode: "on-demand", capacity: 2, maxRestarts: 1 } });
    let fRetire = 0;
    const noteF = (now: number, epoch: number, fail2: boolean) => {
      currentEpoch = epoch;
      return noteInstanceRestart(kv, { endpoint: "manager", instanceId: IIDF, epoch, now, readProcessEpoch: readEpoch, readSpecLeader: specLeader(IIDF), retireLifecycle: async () => { fRetire++; if (fail2) throw new Error("registry down"); } });
    };
    await noteF(NOW, 1, false);
    await rejects("a retire-seam failure after the escalation CAS is unavailable (honest half-commit)",
      () => noteF(NOW + 100, 2, true), "unavailable");
    {
      const s = await readStatus(IIDF);
      c("…the escalated status STANDS through the failed retirement, UNMARKED (it blocks restarts; the reconciler retries)",
        s.state === SERVICE_ESCALATED && s[RETIRED_MARK_FIELD] === undefined, s);
    }
    await rejects("…a still-failing reconciler surfaces unavailable (the escalation keeps standing)",
      () => reconcileEscalation(kv, { endpoint: "manager", instanceId: IIDF, now: NOW + 200, retireLifecycle: async () => { throw new Error("registry still down"); } }), "unavailable");
    const recovered = await reconcileEscalation(kv, { endpoint: "manager", instanceId: IIDF, now: NOW + 300, retireLifecycle: async () => { fRetire++; } });
    c("the reconciler RETRIES the idempotent retire seam to completion and marks it durably",
      recovered.escalated && recovered.retired && recovered.acted, recovered);
    {
      const s = await readStatus(IIDF);
      c("…the retirement mark is durable", s[RETIRED_MARK_FIELD] !== undefined, s);
    }
    const noopF = await reconcileEscalation(kv, { endpoint: "manager", instanceId: IIDF, now: NOW + 400, retireLifecycle: async () => { fRetire++; } });
    const fRetireBefore = fRetire;
    c("…and a later reconcile pass is a no-op (the seam is not re-invoked)", !noopF.acted && fRetire === fRetireBefore);

    // CLOCK REGRESSION refuses; it never silently amnesties durable history.
    const IID2 = "j".repeat(26);
    await createRecordEntry(kv, recordSpecKey(RECORD_KINDS.svc, ["manager", IID2]), spec);
    const note2 = (now: number, epoch: number) => {
      currentEpoch = epoch;
      return noteInstanceRestart(kv, { endpoint: "manager", instanceId: IID2, epoch, now, readProcessEpoch: readEpoch, readSpecLeader: specLeader(IID2), retireLifecycle: async () => {} });
    };
    await note2(NOW + 10_000, 1);
    await rejects("a supervision clock BEHIND the newest recorded restart refuses (a rollback cannot amnesty history)",
      () => note2(NOW + 5_000, 2), "failed-precondition");
    // CLOCK-BEFORE-DUPLICATE: a regressed clock refuses EVEN for a duplicate-epoch replay (the
    // clock check runs first), rather than returning a stale window count against the bad clock.
    await rejects("a regressed clock refuses even on a DUPLICATE-epoch note (clock checked before the duplicate short-circuit)",
      () => note2(NOW + 5_000, 1), "failed-precondition");
    {
      const s = await readStatus(IID2);
      c("…the history is intact after the refusal", (s[RESTART_HISTORY_FIELD] as RestartHistoryEntry[]).length === 1, s);
    }
    // WINDOW PRUNING: old restarts age out; intensity is a rate, not a lifetime count.
    await note2(NOW + 20_000, 2);
    await note2(NOW + 40_000, 3);
    const aged = await note2(NOW + 80_000, 4);
    c("restarts OUTSIDE the 60s window prune out (t+10s and t+20s aged away: 2 in window, no escalation)",
      !aged.escalated && aged.restartsInWindow === 2, aged);

    // THE CAS PIN: a derived status write against a MOVED base loses loudly.
    await rejects("a status write pinned to a STALE observed revision loses its CAS (conflict, never a silent merge-lose)",
      () => writeServiceStatus(kv, {
        endpoint: "manager", instanceId: IID2, epoch: 4,
        status: { epoch: 4, state: SERVICE_EXITED, observedSpecRevision: 0 },
        readProcessEpoch: () => 4, expectedStatusRevision: 1,
      }), "conflict");

    // GARBLED HISTORY refuses (a mediated-writer record that does not validate is a writer bug).
    const IID4 = "l".repeat(26);
    await createRecordEntry(kv, recordSpecKey(RECORD_KINDS.svc, ["manager", IID4]), spec);
    await createRecordEntry(kv, recordStatusKey(RECORD_KINDS.svc, ["manager", IID4]), { epoch: 7, state: SERVICE_EXITED, observedSpecRevision: 0, [RESTART_HISTORY_FIELD]: [{ t: 1 }] });
    await rejects("a garbled stored restart history refuses (internal), never a fabricated count",
      () => noteInstanceRestart(kv, { endpoint: "manager", instanceId: IID4, epoch: 7, now: NOW, readProcessEpoch: () => 7, readSpecLeader: specLeader(IID4), retireLifecycle: async () => {} }), "internal");

    // THE EPOCH FENCE rides through: a note from a non-current epoch is expired.
    await rejects("a restart note from a superseded epoch is expired (the mapping fence rides through writeServiceStatus)",
      () => noteInstanceRestart(kv, { endpoint: "manager", instanceId: IID2, epoch: 6, now: NOW + 90_000, readProcessEpoch: () => 5, readSpecLeader: specLeader(IID2), retireLifecycle: async () => {} }), "expired");
  }

  console.log("F. escalated instances are NEVER live to scatter");
  {
    const E = "scatter";
    const IIDR = "m".repeat(26);
    const IIDX = "n".repeat(26);
    const specR = { endpoint: E, owner: "u_wrk", clusterDigests: [`sha256:${"0".repeat(64)}`], protocol: { v: 1 } };
    const revR = await createRecordEntry(kv, recordSpecKey(RECORD_KINDS.svc, [E, IIDR]), specR);
    const revX = await createRecordEntry(kv, recordSpecKey(RECORD_KINDS.svc, [E, IIDX]), specR);
    await createRecordEntry(kv, recordStatusKey(RECORD_KINDS.svc, [E, IIDX]), { epoch: 1, state: SERVICE_ESCALATED, observedSpecRevision: revX });
    await rejects("a registry holding ONLY an escalated instance has no live members (failed-precondition, never an empty success)",
      () => freezeExpectedSet(jsm, SPACE, E), "failed-precondition");
    await createRecordEntry(kv, recordStatusKey(RECORD_KINDS.svc, [E, IIDR]), { epoch: 1, state: SERVICE_READY, observedSpecRevision: revR });
    const frozen = await freezeExpectedSet(jsm, SPACE, E);
    c("the frozen expected set contains the READY instance and EXCLUDES the escalated one (terminally not-startable)",
      frozen.length === 1 && frozen[0].instanceId === IIDR, frozen);
  }

  console.log("G. the 1ab3f8d round: mark/history validation, DEL fail-closed, connId strictness, revision carry");
  {
    const specLeader = (iid: string) => async () => { const e = await kv.get(recordSpecKey(RECORD_KINDS.svc, ["manager", iid])); return e && e.operation === "PUT" ? { value: JSON.parse(td.decode(e.value)), revision: e.revision } : undefined; };
    const spec = { endpoint: "manager", owner: "u_wrk", clusterDigests: [`sha256:${"0".repeat(64)}`], protocol: { v: 1 }, activation: { mode: "on-demand", capacity: 2 } };
    // A stored status with a retiredAt mark on a NON-escalated row is corruption: reconcileEscalation
    // reads it through parseServiceStatus and fails closed (internal), never treating it as retired.
    const IIDM = "p".repeat(26);
    await createRecordEntry(kv, recordSpecKey(RECORD_KINDS.svc, ["manager", IIDM]), spec);
    await createRecordEntry(kv, recordStatusKey(RECORD_KINDS.svc, ["manager", IIDM]), { epoch: 1, state: SERVICE_READY, observedSpecRevision: 0, [RETIRED_MARK_FIELD]: 123 });
    await rejects("a retiredAt mark on a NON-escalated stored row refuses at the read boundary (a forged mark cannot fake retirement)",
      () => reconcileEscalation(kv, { endpoint: "manager", instanceId: IIDM, now: NOW, retireLifecycle: async () => {} }), "internal");
    // A stored status with a duplicate-epoch history refuses too.
    const IIDD = "q".repeat(26);
    await createRecordEntry(kv, recordSpecKey(RECORD_KINDS.svc, ["manager", IIDD]), spec);
    await createRecordEntry(kv, recordStatusKey(RECORD_KINDS.svc, ["manager", IIDD]), { epoch: 1, state: SERVICE_EXITED, observedSpecRevision: 0, [RESTART_HISTORY_FIELD]: [{ t: 1, epoch: 2 }, { t: 2, epoch: 2 }] });
    await rejects("a DUPLICATE-epoch stored restart history refuses (a fabricated count never rides through)",
      () => noteInstanceRestart(kv, { endpoint: "manager", instanceId: IIDD, epoch: 3, now: NOW, readProcessEpoch: () => 1, readSpecLeader: specLeader(IIDD), retireLifecycle: async () => {} }), "internal");
    // reconcileEscalation on a DEL marker fails closed (a deletion is never clean absence).
    const IIDL = "r".repeat(26);
    await createRecordEntry(kv, recordSpecKey(RECORD_KINDS.svc, ["manager", IIDL]), spec);
    await createRecordEntry(kv, recordStatusKey(RECORD_KINDS.svc, ["manager", IIDL]), { epoch: 1, state: SERVICE_ESCALATED, observedSpecRevision: 0 });
    await kv.delete(recordStatusKey(RECORD_KINDS.svc, ["manager", IIDL]));
    await rejects("reconcileEscalation on a DEL marker fails closed (an escalated identity never skips retirement via a deletion)",
      () => reconcileEscalation(kv, { endpoint: "manager", instanceId: IIDL, now: NOW, retireLifecycle: async () => {} }), "failed-precondition");
    // noteInstanceRestart REQUIRES a leader-served spec reader (no follower kv.get).
    await rejects("noteInstanceRestart without readSpecLeader refuses (the policy is FENCING, never a follower read)",
      () => noteInstanceRestart(kv, { endpoint: "manager", instanceId: IIDM, epoch: 1, now: NOW, readProcessEpoch: () => 1, retireLifecycle: async () => {} } as never), "contract-invalid");
    // activatorGrants uses the strict inbox-connId grammar (8-120), not a permissive id token.
    await rejects("a too-short activator connId refuses (assertInboxConnId, not a permissive id token)", () => activatorGrants(SPACE, "manager", "vbuilds", "short"));
    // admit carries the RE-PROVEN registration revision into the verdict (bound to the accept CAS).
    const IIDA = "s".repeat(26);
    const specRev = await createRecordEntry(kv, recordSpecKey(RECORD_KINDS.svc, ["manager", IIDA]), spec);
    const admitVerdict = await admitVirtualWork(ctx, { endpoint: "manager", pool: "vbuilds", instanceId: IIDA, now: NOW });
    c("the admission verdict carries the re-proven registration revision (bound to the acceptance commit)",
      admitVerdict.policyRevision === specRev, { policyRevision: admitVerdict.policyRevision, specRev });
  }
} finally {
  broker.kill("SIGKILL");
  await new Promise((r) => broker.once("exit", r));
  rmSync(sd, { recursive: true, force: true });
}

console.log(fail === 0 ? `\nENDPOINT VIRTUAL SMOKE OK ✅  (${ok} passed, ${fail} failed)` : `\nENDPOINT VIRTUAL SMOKE FAILED ❌  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
