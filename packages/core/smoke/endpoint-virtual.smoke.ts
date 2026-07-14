/**
 * v0.4 §13.6 virtual-endpoint smoke — the admission fence, the INFO-poll activator, and
 * restart-intensity supervision against a real broker. Covers: the pool-consumer config pins
 * (explicit `max_deliver: -1`; the virtual-admission durable's `max_ack_pending: 1` by
 * construction, live-asserted and behaviorally proven serial), the fail-closed occupancy read
 * (missing consumer is `unavailable`, post-create MaxDeliver drift is `failed-precondition`,
 * occupancy = num_pending + num_ack_pending across delivered-unacked work),
 * reconcile-orphans-before-admit (a lost acceptance is repaired INTO the count new work
 * competes under), the over/under-capacity verdicts, the activator's bounded poll/backoff
 * (finite ceiling enforced, quiet backoff, work resets), start dedupe while a start is in
 * flight, the isLive gate, loud INFO/start failures, stop(), the module-source default-deny
 * grep (INFO-only broker authority: no consume/ack/fetch/stream-read/consumer-mutate tokens),
 * and durable CAS-fenced restart intensity (escalation at >max within the window, pruning
 * outside it, escalated-blocks-further-notes, the honest half-committed retire failure, the
 * revision-pinned status write, the garbled-history refusal, and the epoch fence riding
 * through).
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
import {
  isReachable, EpEnvelopeError,
  createEndpointStreams, epwStreamName, epjStreamName, poolDurable, canonDurable,
  poolConsumerConfig, virtualAdmissionConsumerConfig,
  workPoolContext, enqueueWorkItem, openRecordsBucket, epjSubject,
  readPoolOccupancy, admitVirtualWork, startVirtualActivator, noteInstanceRestart,
  writeServiceStatus, RESTART_HISTORY_FIELD, SERVICE_ESCALATED, SERVICE_EXITED,
  RECORD_KINDS, recordSpecKey, recordStatusKey, createRecordEntry, updateRecordEntry,
  type EpCaller, type WorkItemRef, type WorkPoolContext, type ServiceStatus,
} from "../src/index.js";

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

const PORT = 20000 + Math.floor(Math.random() * 40000);
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

  console.log("A. config pins: max_deliver=-1 on the pool durable, max_ack_pending=1 on virtual admission");
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
    // suspends further delivery — the second submission cannot enter the admission path until
    // the first acks (count → decide → enqueue cannot interleave).
    const subj = (_id: string) => epjSubject(SPACE, { endpoint: "manager", command: "build", caller: { owner: caller.owner, actor: caller.actor, uid: caller.uid } });
    await js.publish(subj("s1"), enc("s1"));
    await js.publish(subj("s2"), enc("s2"));
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
  }

  console.log("B. the fail-closed occupancy read");
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
    await rejects("post-create MaxDeliver drift refuses at READ time (failed-precondition; creation intent proves nothing later)",
      () => readPoolOccupancy(ctx, "manager", "vbuilds"), "failed-precondition");
    await jsm.consumers.update(epwStreamName(SPACE), poolDurable("manager", "vbuilds"), { max_deliver: -1 });
    c("repinning -1 restores the read", (await readPoolOccupancy(ctx, "manager", "vbuilds")).occupancy === 2);
  }

  console.log("C. admission: capacity fence + reconcile-orphans-before-admit");
  {
    await rejects("capacity 0 refuses (a pool that admits nothing is a config bug, not a fence)",
      () => admitVirtualWork(ctx, { endpoint: "manager", pool: "vbuilds", capacity: 0, now: NOW }), "contract-invalid");
    await rejects("a non-integer capacity refuses",
      () => admitVirtualWork(ctx, { endpoint: "manager", pool: "vbuilds", capacity: 1.5, now: NOW }), "contract-invalid");
    const full = await admitVirtualWork(ctx, { endpoint: "manager", pool: "vbuilds", capacity: 2, now: NOW });
    c("occupancy 2 against capacity 2 is REFUSED (admitted false, the caller's resource-exhausted decision fact)",
      !full.admitted && full.occupancy.occupancy === 2 && full.capacity === 2 && full.repaired === 0, full);
    const free = await admitVirtualWork(ctx, { endpoint: "manager", pool: "vbuilds", capacity: 3, now: NOW });
    c("occupancy 2 against capacity 3 admits", free.admitted && free.occupancy.occupancy === 2, free);
    // ORPHAN REPAIR ORDERING: an acceptance that never made it into the pool (no terminal, no
    // lease, no live entry — the crash-between-CAS-and-enqueue state) is re-enqueued FIRST and
    // then COUNTED: the same capacity-3 admission now refuses because the repaired item filled
    // the slot the new submission was about to take.
    const orphan = ref("vb-lost", "vbuilds");
    const repaired = await admitVirtualWork(ctx, {
      endpoint: "manager", pool: "vbuilds", capacity: 3, now: NOW,
      outstanding: [{ ref: orphan, itemBytes: enc("lost"), workExpiry: EXPIRY }],
    });
    c("a lost acceptance is repaired INTO the pool before counting (repaired 1, occupancy 3, capacity 3 refuses)",
      repaired.repaired === 1 && repaired.occupancy.occupancy === 3 && !repaired.admitted, repaired);
    const again = await admitVirtualWork(ctx, {
      endpoint: "manager", pool: "vbuilds", capacity: 4, now: NOW,
      outstanding: [{ ref: orphan, itemBytes: enc("lost"), workExpiry: EXPIRY }],
    });
    c("re-presenting the same acceptance repairs NOTHING (the live entry settles the predicate; idempotent)",
      again.repaired === 0 && again.occupancy.occupancy === 3 && again.admitted, again);
  }

  console.log("D. the INFO-poll activator");
  {
    await rejects("pollMs 0 refuses", () => startVirtualActivator({ ctx, endpoint: "manager", pool: "vact", startInstance: async () => {}, isLive: () => false, onError: () => {}, pollMs: 0 }), "contract-invalid");
    await rejects("maxPollMs below pollMs refuses", () => startVirtualActivator({ ctx, endpoint: "manager", pool: "vact", startInstance: async () => {}, isLive: () => false, onError: () => {}, pollMs: 500, maxPollMs: 100 }), "contract-invalid");
    await rejects("an INFINITE backoff ceiling refuses (the ceiling bounds the activation delay)",
      () => startVirtualActivator({ ctx, endpoint: "manager", pool: "vact", startInstance: async () => {}, isLive: () => false, onError: () => {}, maxPollMs: Number.POSITIVE_INFINITY }), "contract-invalid");
    await rejects("a missing onError refuses (an unobserved activator failure is a silent liveness hole)",
      () => startVirtualActivator({ ctx, endpoint: "manager", pool: "vact", startInstance: async () => {}, isLive: () => false, onError: undefined as never }), "contract-invalid");

    await jsm.consumers.add(epwStreamName(SPACE), poolConsumerConfig(SPACE, "manager", "vact"));
    // A controllable fake timer: the smoke fires ticks by hand and records every scheduled delay.
    const delays: number[] = [];
    let pending: (() => void) | undefined;
    const timerFns = {
      setTimeoutFn: (fn: () => void, ms: number) => { delays.push(ms); pending = fn; return {}; },
      clearTimeoutFn: () => { pending = undefined; },
    };
    const fire = async (n = 1) => { for (let i = 0; i < n; i++) { const f = pending; pending = undefined; f?.(); await wait(120); } };

    // Quiet pool: backoff doubles toward the FINITE ceiling and never exceeds it.
    const errsQ: string[] = [];
    const quiet = startVirtualActivator({ ctx, endpoint: "manager", pool: "vact", startInstance: async () => {}, isLive: () => false, onError: (k) => errsQ.push(k), pollMs: 100, maxPollMs: 400, ...timerFns });
    await fire(4);
    c("quiet polls back off toward the ceiling and CAP there (100 → 200 → 400 → 400…)",
      delays.length >= 5 && delays[0] === 100 && delays[1] === 200 && delays[2] === 400 && delays.slice(2).every((d) => d === 400), delays);
    c("…with no starts and no errors on a quiet healthy pool", quiet.stats().starts === 0 && errsQ.length === 0, quiet.stats());
    quiet.stop();
    c("stop() halts the loop (no pending tick survives)", pending === undefined);

    // Work present: exactly ONE start while it is in flight (dedupe), polls continue, and the
    // backoff RESETS to the base rate.
    await enqueueWorkItem(ctx, ref("va-1", "vact"), enc("wa"));
    delays.length = 0;
    let releaseStart: () => void = () => {};
    const startGate = new Promise<void>((r) => { releaseStart = r; });
    let startCalls = 0;
    const errsW: string[] = [];
    const busy = startVirtualActivator({
      ctx, endpoint: "manager", pool: "vact",
      startInstance: async () => { startCalls++; await startGate; },
      isLive: () => false, onError: (k) => errsW.push(k), pollMs: 100, maxPollMs: 400, ...timerFns,
    });
    await fire(3);
    c("work present: the bound startInstance fires EXACTLY once while in flight (local dedupe)",
      startCalls === 1 && busy.stats().starts === 1, { startCalls, stats: busy.stats() });
    c("…polling continues at the BASE rate while work is present (a wedged start stays observable)",
      delays.every((d) => d === 100) && busy.stats().polls >= 3, delays);
    c("…and the occupancy is visible in stats", busy.stats().lastOccupancy === 1, busy.stats());
    releaseStart();
    await until(() => busy.stats().starts === 1);
    busy.stop();

    // isLive short-circuits the start (a live instance is never doubled).
    let liveStarts = 0;
    const alive = startVirtualActivator({ ctx, endpoint: "manager", pool: "vact", startInstance: async () => { liveStarts++; }, isLive: () => true, onError: () => {}, pollMs: 100, ...timerFns });
    await fire(2);
    c("a LIVE instance suppresses the start (isLive gate)", liveStarts === 0 && alive.stats().starts === 0);
    alive.stop();

    // INFO failure is LOUD and polling continues with backoff.
    const errsI: Array<{ k: string }> = [];
    delays.length = 0;
    const blind = startVirtualActivator({ ctx, endpoint: "manager", pool: "ghost", startInstance: async () => {}, isLive: () => false, onError: (k) => errsI.push({ k }), pollMs: 100, maxPollMs: 400, ...timerFns });
    await fire(2);
    c("an INFO failure surfaces loudly (onError 'info') and the loop keeps polling with backoff",
      errsI.length >= 2 && errsI.every((e) => e.k === "info") && blind.stats().infoErrors >= 2 && delays.length >= 2, { errsI, delays });
    blind.stop();

    // A start failure surfaces loudly and CLEARS the in-flight guard (the next tick retries).
    let attempt = 0;
    const errsS: string[] = [];
    const flaky = startVirtualActivator({
      ctx, endpoint: "manager", pool: "vact",
      startInstance: async () => { attempt++; throw new Error("boom"); },
      isLive: () => false, onError: (k) => errsS.push(k), pollMs: 100, ...timerFns,
    });
    await fire(2);
    c("a start failure surfaces loudly (onError 'start') and the guard clears for a retry",
      attempt >= 2 && errsS.filter((k) => k === "start").length >= 2 && flaky.stats().startErrors >= 2, { attempt, errsS });
    flaky.stop();

    // DEFAULT-DENY: the activator's broker authority is exactly the INFO read. The module source
    // must not contain any consume/ack/fetch/stream-read/consumer-mutate token.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "endpoint-virtual.ts"), "utf8");
    for (const forbidden of [".consumers.add(", ".consumers.delete(", ".consumers.update(", ".next(", ".fetch(", ".ack(", ".getMessage(", ".direct.", ".subscribe(", ".publish("]) {
      c(`default-deny: endpoint-virtual.ts never uses "${forbidden}"`, !src.includes(forbidden));
    }
    c("…and its only JetStream API call is the exact consumers.info", (src.match(/\.consumers\.info\(/g) ?? []).length === 1);
  }

  console.log("E. durable, CAS-fenced restart intensity");
  {
    const IID = "i".repeat(26);
    const EPOCH = 7;
    const spec = { endpoint: "manager", owner: "u_wrk", clusterDigests: [`sha256:${"0".repeat(64)}`], protocol: { v: 1 }, activation: { mode: "on-demand" } };
    await createRecordEntry(kv, recordSpecKey(RECORD_KINDS.svc, ["manager", IID]), spec);
    const readEpoch = () => EPOCH;
    const retire: string[] = [];
    const note = (now: number, over: Partial<Parameters<typeof noteInstanceRestart>[1]> = {}) =>
      noteInstanceRestart(kv, { endpoint: "manager", instanceId: IID, epoch: EPOCH, now, readProcessEpoch: readEpoch, retireLifecycle: async () => { retire.push("called"); }, ...over });

    const n1 = await note(NOW);
    c("restart 1 records durably (exited, history 1, no escalation)", !n1.escalated && n1.restartsInWindow === 1, n1);
    const n2 = await note(NOW + 1000);
    const n3 = await note(NOW + 2000);
    c("restarts 2 and 3 within the window accumulate (the ceiling is 'MORE than maxRestarts')",
      !n2.escalated && !n3.escalated && n3.restartsInWindow === 3, { n2, n3 });
    {
      const stored = await kv.get(recordStatusKey(RECORD_KINDS.svc, ["manager", IID]));
      const status = JSON.parse(td.decode(stored!.value)) as ServiceStatus;
      c("the history rides the DURABLE status record (a supervisor restart cannot amnesty the count)",
        status.state === SERVICE_EXITED && Array.isArray(status[RESTART_HISTORY_FIELD]) && (status[RESTART_HISTORY_FIELD] as number[]).length === 3, status);
    }
    const n4 = await note(NOW + 3000);
    c("the 4th restart within 60s ESCALATES (status escalated, D13 retire seam invoked once)",
      n4.escalated && n4.restartsInWindow === 4 && retire.length === 1, { n4, retire });
    await rejects("an escalated identity REFUSES further restart notes (the instance stops restarting, terminally)",
      () => note(NOW + 4000), "failed-precondition");
    {
      const stored = await kv.get(recordStatusKey(RECORD_KINDS.svc, ["manager", IID]));
      c("…and the escalated state is durable", (JSON.parse(td.decode(stored!.value)) as ServiceStatus).state === SERVICE_ESCALATED);
    }

    // WINDOW PRUNING: old restarts age out; intensity is a rate, not a lifetime count.
    const IID2 = "j".repeat(26);
    await createRecordEntry(kv, recordSpecKey(RECORD_KINDS.svc, ["manager", IID2]), spec);
    const note2 = (now: number) => noteInstanceRestart(kv, { endpoint: "manager", instanceId: IID2, epoch: EPOCH, now, readProcessEpoch: readEpoch, retireLifecycle: async () => {} });
    await note2(NOW);
    await note2(NOW + 10_000);
    await note2(NOW + 30_000);
    const aged = await note2(NOW + 70_000);
    c("restarts OUTSIDE the 60s window prune out (t0 and t+10s aged away: 2 in window, no escalation)",
      !aged.escalated && aged.restartsInWindow === 2, aged);

    // HONEST HALVES: the escalated status commits FIRST; a retire-seam failure is unavailable
    // with the escalation standing (nothing un-escalates; retirement retries).
    const IID3 = "k".repeat(26);
    await createRecordEntry(kv, recordSpecKey(RECORD_KINDS.svc, ["manager", IID3]), spec);
    const note3 = (now: number) => noteInstanceRestart(kv, { endpoint: "manager", instanceId: IID3, epoch: EPOCH, now, maxRestarts: 1, readProcessEpoch: readEpoch, retireLifecycle: async () => { throw new Error("registry down"); } });
    await note3(NOW);
    await rejects("a retire-seam failure after the escalation CAS is unavailable (honest half-commit)",
      () => note3(NOW + 100), "unavailable");
    {
      const stored = await kv.get(recordStatusKey(RECORD_KINDS.svc, ["manager", IID3]));
      c("…the escalated status STANDS through the failed retirement (it blocks restarts; the retire retries)",
        (JSON.parse(td.decode(stored!.value)) as ServiceStatus).state === SERVICE_ESCALATED);
    }
    await rejects("…and the standing escalation refuses the next note", () => note3(NOW + 200), "failed-precondition");

    // THE CAS PIN: a derived status write against a MOVED base loses loudly (conflict), so two
    // concurrent notes can never merge-lose a restart.
    await rejects("a status write pinned to a STALE observed revision loses its CAS (conflict, never a silent merge-lose)",
      () => writeServiceStatus(kv, {
        endpoint: "manager", instanceId: IID2, epoch: EPOCH,
        status: { epoch: EPOCH, state: SERVICE_EXITED, observedSpecRevision: 0, [RESTART_HISTORY_FIELD]: [] },
        readProcessEpoch: readEpoch, expectedStatusRevision: 1,
      }), "conflict");

    // GARBLED HISTORY refuses (a mediated-writer record that does not validate is a writer bug).
    const IID4 = "l".repeat(26);
    await createRecordEntry(kv, recordSpecKey(RECORD_KINDS.svc, ["manager", IID4]), spec);
    const statusKey4 = recordStatusKey(RECORD_KINDS.svc, ["manager", IID4]);
    await createRecordEntry(kv, statusKey4, { epoch: EPOCH, state: SERVICE_EXITED, observedSpecRevision: 0, [RESTART_HISTORY_FIELD]: ["garbled"] });
    await rejects("a garbled stored restart history refuses (internal), never a fabricated count",
      () => noteInstanceRestart(kv, { endpoint: "manager", instanceId: IID4, epoch: EPOCH, now: NOW, readProcessEpoch: readEpoch, retireLifecycle: async () => {} }), "internal");

    // THE EPOCH FENCE rides through: a note from a non-current epoch is expired.
    await rejects("a restart note from a superseded epoch is expired (the mapping fence rides through writeServiceStatus)",
      () => noteInstanceRestart(kv, { endpoint: "manager", instanceId: IID2, epoch: EPOCH, now: NOW + 80_000, readProcessEpoch: () => EPOCH + 1, retireLifecycle: async () => {} }), "expired");
  }
} finally {
  broker.kill("SIGKILL");
  await new Promise((r) => broker.once("exit", r));
  rmSync(sd, { recursive: true, force: true });
}

console.log(fail === 0 ? `\nENDPOINT VIRTUAL SMOKE OK ✅  (${ok} passed, ${fail} failed)` : `\nENDPOINT VIRTUAL SMOKE FAILED ❌  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
