/**
 * A BROKER RESTART UNDER RUNNING ENDPOINTS, THEN `cotal up`'S RECONCILE: THE ROSTER MUST RECOVER.
 *
 * The presence bucket is memory-backed, so a broker that restarts comes back without it while every
 * endpoint rides the restart out by reconnecting (AGENT-2889). Measured order on a real broker: the
 * transport reconnects with no new `connection` event, the observer's presence view goes stale, and
 * `stream not found` arrives. `cotal up` on the running mesh reconciles through `reconcileSpaceTtls`,
 * which re-creates the missing memory bucket. After that the observer that never restarted must see
 * a live roster again.
 *
 * Cells: the restart really drops the bucket (so the recovery below is not vacuous), the reconcile
 * reports the re-creation, and the observer's view is current again. The last two prove the watch is
 * live rather than frozen: a peer started after the recovery is seen, and the original peer, once
 * stopped, goes offline.
 *
 * WHAT THIS DOES NOT CLAIM. The CLI's rendering of that recovery is graded in
 * implementations/cli/smoke/topo-membership.smoke.ts section 6; the `up` wiring was checked live.
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { CotalEndpoint, isReachable, presenceBucket, reconcileSpaceTtls, setupSpaceStreams } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal, killAndAwaitExit } from "@cotal-ai/smoke-kit";

let pass = 0, fail = 0;
const check = (n: string, v: boolean, x?: unknown) => { v ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ FAIL: ${n}`, x ?? "")); };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean, ms: number): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < ms) { if (pred()) return true; await wait(50); }
  return pred();
};

const TTL_MS = 1_500;
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `brokerrestart-${randomUUID().slice(0, 8)}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const startBroker = (): ChildProcess => spawn("nats-server", ["-js", "-sd", join(dir, "js"), "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const reachable = async () => { for (let i = 0; i < 100; i++) { if (await isReachable(SERVERS)) return true; await wait(100); } return false; };
const presenceExists = async () => {
  const nc = await connect({ servers: SERVERS });
  try { await (await jetstreamManager(nc)).streams.info(`KV_${presenceBucket(space)}`); return true; } catch { return false; } finally { await nc.close(); }
};

let broker = startBroker();
let releaseBroker = teardownOnSignal(broker);
const endpoints: CotalEndpoint[] = [];
const mk = (name: string, watch: boolean) => {
  const ep = new CotalEndpoint({
    space, servers: SERVERS, channels: [], consume: false, registerPresence: true, watchPresence: watch,
    heartbeatMs: 500, ttlMs: TTL_MS, card: { name, kind: "agent", role: "agent" },
  });
  ep.on("error", () => { /* the outage's stream-not-found is expected; the cells grade the recovery */ });
  endpoints.push(ep);
  return ep;
};
try {
  if (!(await reachable())) throw new Error(`fixture broker never came up on ${SERVERS} - refusing to report on a server that never started`);
  await setupSpaceStreams({ servers: SERVERS, space });
  const peer = mk("peer", false);
  const observer = mk("observer", true);
  let view = "unknown";
  observer.on("presence-view", (v: { state: string }) => { view = v.state; });
  await peer.start();
  await observer.start();
  const status = (name: string) => observer.getRoster().find((p) => p.card.name === name)?.status ?? "absent";
  check("before the restart the observer sees the peer live", await until(() => status("peer") !== "absent" && status("peer") !== "offline", 5_000), status("peer"));

  await killAndAwaitExit(broker, "SIGTERM");
  releaseBroker();
  broker = startBroker();
  releaseBroker = teardownOnSignal(broker);
  if (!(await reachable())) throw new Error("the restarted broker never came up");
  check("the restart dropped the memory presence bucket (the recovery below is not vacuous)", !(await presenceExists()));
  check("the observer's view goes stale while the bucket is gone", await until(() => view === "stale", 10_000), view);

  // `cotal up` on the running mesh: the reconcile re-creates the memory bucket.
  const reconciled = await reconcileSpaceTtls({ servers: SERVERS, space });
  check("the reconcile reports the presence bucket re-created", reconciled.some((r) => r.stream === `KV_${presenceBucket(space)}` && r.recreated === true), reconciled);
  check("the observer that never restarted is current again", await until(() => view === "current", 15_000), view);

  const late = mk("late", false);
  await late.start();
  check("a peer started after the recovery is seen live (the watch is live, not frozen)", await until(() => status("late") !== "absent" && status("late") !== "offline", 10_000), status("late"));
  await peer.stop();
  check("the original peer, stopped, goes offline on the recovered watch", await until(() => status("peer") === "offline" || status("peer") === "absent", 10_000), status("peer"));

  console.log(`\nPRESENCE-BROKER-RESTART SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
} catch (e) {
  fail++;
  console.log(`  ✗ FAIL: ${(e as Error).message}`);
} finally {
  await Promise.allSettled(endpoints.map((ep) => ep.stop()));
  await killAndAwaitExit(broker, "SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
process.exit(fail === 0 && pass === 7 ? 0 : 1);
