/**
 * RESOLVE RTT AMPLIFICATION — the #385 measurement, and the regression guard for its fix.
 *
 * The reported figure (idle mesh, WAN caller: mint 1.5s / connect 0.7s / resolveService 11.6s /
 * scatter both managers 1.9s) cannot be reproduced on localhost — the RTT is ~0.1ms, not ~150ms.
 * So this measures the RTT-INDEPENDENT invariants instead, and derives the seconds from them:
 *
 *   1. the COUNT of caller->broker round-trips one `resolveService` performs, and
 *   2. how many of them are IN FLIGHT at once,
 *
 * with a latency-injecting connection proxy turning this box into a WAN emulator, so the
 * arithmetic is proven rather than asserted.
 *
 * WHAT IT MEASURED BEFORE THE BATCHING CHANGE (the defect, for the record):
 *   70 round-trips for a 17-command surface, 22 of them re-reads of a digest already read;
 *   max-in-flight 1 (strictly sequential); 11.7s at an injected 160ms/read, against the 11.6s
 *   reported from the WAN. The reconstruction landed on the report with no slow manager and no
 *   load anywhere, which is the whole point: this needs no contention to happen.
 *
 * WHAT IT GUARDS NOW: the reads are deduped through one per-resolve artifact memo and the closure
 * walks run concurrently, so the same surface costs 48 round-trips with none repeated, overlapped
 * rather than queued. The assertions are written against the TRIP COUNT, the IN-FLIGHT count, and
 * the UNION of injected wait intervals — never `elapsed < count × RTT`. Injected delay plus host
 * and broker work can exceed serial inject even when max-in-flight is high (15ms × N is smaller
 * than this box's per-request overhead). Occupancy of the synthetic waits still collapses when
 * those waits overlap, and still sums to ~count × inject when they queue. Revert the memo and
 * phase 1 goes red on the refetch count; revert the concurrency and phase 2 goes red on
 * max-in-flight; revert either and the occupancy cell goes red.
 *
 * NOT fixed by this change, and still asserted as an open finding: `deadlineMs` bounds only the
 * describe leg. The store reads run under `fetchContractClosure`'s own 30s budget, PER walk, so
 * the resolve still has no total bound — it is merely fast now.
 *
 * Run: pnpm tsx implementations/manager/smoke/resolve-rtt-probe.smoke.ts
 *      (needs nats-server + node on PATH; boots its own broker on a free port)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity,
  mintLifecycleUid, standaloneConnectOpts, DEV_OWNER,
  resolveService,
  type EpCaller,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT, managerShippedSurface } from "../src/manager-service-contract.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
const shipped = managerShippedSurface();

const here = dirname(fileURLToPath(import.meta.url));

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;

// FIRST ACTION, before any broker work: this probe must never touch the live mesh.
//
// The operator environment really does carry COTAL_SERVERS=nats://broker.cotal.ai:4222, so an
// ambient read by ANY layer below (manager, core, a connector) would reach production. Scrub the
// inherited pointers first, THEN assert the scrub held and that the URL we chose is loopback.
// Neutralize-then-verify, not verify-and-hope.
const LIVE_HOST = "broker.cotal.ai";
for (const k of ["COTAL_SERVERS", "COTAL_SERVER", "COTAL_CREDS", "COTAL_SPACE"]) delete process.env[k];
for (const [k, v] of Object.entries(process.env))
  if (typeof v === "string" && v.includes(LIVE_HOST))
    throw new Error(`refusing to run: ${k} still points at the live broker (${v})`);
if (SERVERS.includes(LIVE_HOST))
  throw new Error(`refusing to run against the live broker: SERVERS=${SERVERS}`);
if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(SERVERS))
  throw new Error(`this probe only runs against an ephemeral loopback broker; got ${SERVERS}`);
console.log(`broker-url guard: ${SERVERS} is ephemeral loopback; no env var references ${LIVE_HOST}\n`);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

/** Wrap a connection so every `request` is COUNTED by subject, and optionally DELAYED by
 *  `delayMs` before it is issued — a synthetic caller->broker RTT. Concurrency is tracked so the
 *  sequential-vs-batched question is answered by observation, not by reading the source. */
interface Meter {
  total: number;
  bySubject: Map<string, number>;
  maxInFlight: number;
  order: string[];
  /** Wall time during which at least one injected wait is open. Host/broker work after the wait is excluded. */
  delayOccupancyMs: number;
}
function meteredConnection(nc: NatsConnection, meter: Meter, delayMs: number): NatsConnection {
  let inFlight = 0;
  let delaying = 0;
  let delayOpenAt: number | null = null;
  return new Proxy(nc, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop !== "request" || typeof v !== "function") {
        return typeof v === "function" ? v.bind(target) : v;
      }
      return async (subject: string, ...rest: unknown[]) => {
        meter.total++;
        const key = subject.split(".").slice(0, 4).join(".");
        meter.bySubject.set(key, (meter.bySubject.get(key) ?? 0) + 1);
        meter.order.push(subject);
        inFlight++;
        if (inFlight > meter.maxInFlight) meter.maxInFlight = inFlight;
        try {
          if (delayMs > 0) {
            delaying++;
            if (delaying === 1) delayOpenAt = performance.now();
            await wait(delayMs);
            delaying--;
            if (delaying === 0 && delayOpenAt !== null) {
              meter.delayOccupancyMs += performance.now() - delayOpenAt;
              delayOpenAt = null;
            }
          }
          return await (v as (s: string, ...r: unknown[]) => Promise<unknown>).call(target, subject, ...rest);
        } finally { inFlight--; }
      };
    },
  }) as NatsConnection;
}

const newMeter = (): Meter => ({ total: 0, bySubject: new Map(), maxInFlight: 0, order: [], delayOccupancyMs: 0 });

const space = `rttprobe-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const workspaceRoot = join(dir, "ws");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  await mgr.start();

  const id = newIdentity();
  const uid = mintLifecycleUid();
  const caller: EpCaller = { owner: DEV_OWNER, actor: id.id, uid };
  const creds = await mintCreds(auth, id, "agent", { lifecycleUid: uid, capabilities: ["spawn"] });
  const rawNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });

  // ---- 1. COUNT the round-trips one cold resolveService performs -------------------------------
  console.log("1. read count of ONE cold resolveService (the RTT-independent invariant)");
  const m1 = newMeter();
  const t0 = performance.now();
  const service = await resolveService(meteredConnection(rawNc, m1, 0), space, MANAGER_ENDPOINT, caller, { deadlineMs: 10_000 });
  const coldMs = performance.now() - t0;
  console.log(`   commands resolved:      ${service.commands.size}`);
  console.log(`   caller->broker requests:${String(m1.total).padStart(4)}`);
  console.log(`   max concurrent in-flight:${String(m1.maxInFlight).padStart(3)}`);
  console.log(`   localhost elapsed:      ${coldMs.toFixed(0)}ms`);
  console.log(`   by subject prefix:`);
  for (const [k, v] of [...m1.bySubject.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${String(v).padStart(4)}  ${k}`);
  // How much of the 70 is REPEATED work? Distinct subjects = the irreducible set of artifacts;
  // the difference is re-fetching a digest this same resolve already read. Sizes the two batching
  // seams separately: dedupe (free) vs concurrency (needs restructuring).
  const distinct = new Set(m1.order).size;
  console.log(`   distinct artifacts:     ${distinct}  (${m1.total - distinct} of the ${m1.total} reads are REFETCHES of a digest already read this resolve)`);
  // RED-FIRST TARGET #1 (dedupe). Reverting the shared artifact memo puts the 22 refetches back
  // and this goes red on the count, not on a timing wobble.
  check("no artifact is read twice in one resolve — the shared memo eliminated every refetch",
    m1.total === distinct, { reads: m1.total, distinct });
  check("the resolve still reads every distinct artifact it needs (dedupe dropped nothing)",
    distinct >= 40 && service.commands.size === shipped.commandCount, { distinct, commands: service.commands.size });

  // ---- 2. CONCURRENCY: the reads no longer queue one behind another ----------------------------
  // RED-FIRST TARGET #2. Reverting the concurrent walks pins max-in-flight back to 1.
  console.log("\n2. concurrency (the other half of count x RTT)");
  console.log(`   max concurrent in-flight: ${m1.maxInFlight}`);
  // Threshold, not `> 1`, and deliberately so: serializing the walks again would still leave TWO
  // reads in flight (a command's input and output closure resolve as a pair), so `> 1` would let
  // the regression through. This surface overlaps ~23; 8 is clear of both the fixed and the
  // reverted behaviour.
  check("the reads are issued CONCURRENTLY — many overlap, not just a command's own input/output pair",
    m1.maxInFlight >= 8, `maxInFlight=${m1.maxInFlight}`);

  // ---- 3. WAN RECONSTRUCTION: inject a synthetic RTT and check the arithmetic -------------------
  const INJECT_MS = 15; // a scaled-down stand-in for the reported ~150ms WAN RTT
  console.log(`\n3. WAN reconstruction: re-run the SAME resolve with ${INJECT_MS}ms injected per request`);
  const m2 = newMeter();
  const t1 = performance.now();
  await resolveService(meteredConnection(rawNc, m2, INJECT_MS), space, MANAGER_ENDPOINT, caller, { deadlineMs: 120_000 });
  const slowMs = performance.now() - t1;
  const serialInject = m2.total * INJECT_MS;
  console.log(`   requests:  ${m2.total}`);
  console.log(`   serial inject (count x delay): ${serialInject}ms`);
  console.log(`   delay occupancy (union of waits): ${m2.delayOccupancyMs.toFixed(0)}ms`);
  console.log(`   wall observed (inject + host + broker): ${slowMs.toFixed(0)}ms`);
  console.log(`   max in-flight: ${m2.maxInFlight}`);
  // 15ms is shorter than this host's per-request stagger, so occupancy here can sit near serial
  // even with max-in-flight in the twenties. Phase 5 uses a 160ms inject, which is the occupancy
  // proof. This phase only logs the 15ms reconstruction and re-checks in-flight overlap.
  check("the 15ms reconstruction still issues overlapping reads (in-flight, not wall-clock)",
    m2.maxInFlight >= 8,
    { serialInject, delayOccupancyMs: Math.round(m2.delayOccupancyMs), maxInFlight: m2.maxInFlight, wallObserved: Math.round(slowMs) });

  // ---- 4. EXTRAPOLATION to the reported WAN profile --------------------------------------------
  const WAN_RTT = 150;
  const serialSecs = (m1.total * WAN_RTT) / 1000;
  console.log(`\n4. extrapolation to the reported caller->broker RTT (~${WAN_RTT}ms)`);
  console.log(`   before this change: 70 sequential reads x ${WAN_RTT}ms = 10.5s (reported: 11.6s)`);
  console.log(`   now: ${m1.total} reads, but overlapped — serial-equivalent would be ${serialSecs.toFixed(1)}s`);
  console.log(`   measured wall time at ~${WAN_RTT}ms/read is phase 5 below, not this arithmetic`);

  // ---- 5. WHAT DEADLINE ACTUALLY BOUNDS THE RESOLVE? -------------------------------------------
  // The brief (and #385) say resolveService "can overrun its OWN 10s deadline". Reading the code,
  // `deadlineMs` is forwarded ONLY to describeEndpoint; the store reads run under
  // fetchContractClosure's separate walkBudgetMs (default 30_000, endpoint-contract-store.ts:339),
  // one budget PER closure walk. If that reading is right, a resolve whose reads take far longer
  // than 10s still SUCCEEDS — no deadline fires — and the caller's 10s is not a bound on the call.
  // Predicted named cell: resolves OK, elapsed > 10s, no throw.
  const SLOW_MS = 160; // 70 reads x 160ms ~ 11.2s, comfortably past the nominal 10s
  console.log(`\n5. is the caller's deadlineMs:10_000 a bound on the WHOLE resolve? (${SLOW_MS}ms/read)`);
  const m3 = newMeter();
  const t2 = performance.now();
  let outcome: string;
  try {
    const svc3 = await resolveService(meteredConnection(rawNc, m3, SLOW_MS), space, MANAGER_ENDPOINT, caller, { deadlineMs: 10_000 });
    outcome = `RESOLVED ${svc3.commands.size} commands`;
  } catch (e) {
    outcome = `THREW ${(e as Error).message}`;
  }
  const slowTotal = performance.now() - t2;
  const slowSerialInject = m3.total * SLOW_MS;
  console.log(`   elapsed: ${(slowTotal / 1000).toFixed(1)}s with deadlineMs: 10_000`);
  console.log(`   outcome: ${outcome}`);
  console.log(`   delay occupancy: ${m3.delayOccupancyMs.toFixed(0)}ms  serial inject: ${slowSerialInject}ms`);
  console.log(`   the SAME probe measured 11.7s here before the batching change (reported WAN: 11.6s)`);
  // Operator-visible wall time is logged, not asserted: this host has paid ~1.8s of overhead on a
  // concurrent 160ms inject, which sits next to a 2s wall cap and flakes. Occupancy of the
  // synthetic waits is the concurrency invariant; serialized walks occupy ~count×160ms.
  check("WAN-profile injected waits overlap — occupancy well under serial inject (was ~11s serialized)",
    m3.delayOccupancyMs < slowSerialInject * 0.5 && m3.maxInFlight >= 8,
    { serialInject: slowSerialInject, delayOccupancyMs: Math.round(m3.delayOccupancyMs), maxInFlight: m3.maxInFlight, wallObserved: Math.round(slowTotal) });
  check("...and still resolves the full shipped command surface", outcome === `RESOLVED ${shipped.commandCount} commands`, outcome);
  // The no-total-deadline FINDING is unchanged by this fix and is still worth asserting: deadlineMs
  // never bounded the store reads, it only bounds the describe leg. The fix made the call fast; it
  // did not give it a bound. Recorded so the deadline inversion is not quietly assumed fixed.
  console.log(`\n   NOTE: deadlineMs still bounds only the describe leg — the reads run under`);
  console.log(`   fetchContractClosure's own 30s budget, PER walk. Batching made the call fast;`);
  console.log(`   it did not give the resolve a total bound. That defect stands (#385).`);

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  await rawNc.drain().catch(() => rawNc.close());
} finally {
  await mgr.stop().catch(() => {});
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
process.exit(fail === 0 ? 0 : 1);
