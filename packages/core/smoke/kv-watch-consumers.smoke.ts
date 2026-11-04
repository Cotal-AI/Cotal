/**
 * A RETIRED PRESENCE OR CHANNEL-REGISTRY WATCH TAKES ITS CONSUMER WITH IT (#3914).
 *
 * `@nats-io/kv` `watch()` creates an ordered push consumer with a five-minute inactive threshold.
 * `CotalEndpoint` stopped its presence and channel-registry watch iterators on stop(), on a stale
 * presence rebind and on a manual reconnect, but never deleted their consumers, so each start/stop
 * cycle left one idle consumer on `KV_cotal_presence_<space>` and one on `KV_cotal_channels_<space>`,
 * and an observer rebinding a silent bucket once per TTL abandoned one per rebind. The issue's repro,
 * five start/stop cycles of a watching endpoint, left five on each stream.
 *
 * The instrument is the broker's own consumer count on each KV stream, read by a separate admin
 * connection, so the cells measure what the broker holds and not what the client believes it
 * released. The controls prove a bound watch does hold one consumer per stream while it lives, so
 * a count that stays flat cannot be a watch that was never bound.
 *
 * Needs nats-server on PATH.
 * Run: pnpm smoke:kv-watch-consumers
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { CotalEndpoint, isReachable, setupSpaceStreams } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

let cells = 0, failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown): void => {
  cells++;
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `kvwatch-${randomUUID().slice(0, 8)}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", join(dir, "js"), "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);

try {
  let up = false;
  for (let i = 0; i < 100; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(100); }
  if (!up) throw new Error(`fixture broker never came up on ${SERVERS} - refusing to report on a server that never started`);
  await setupSpaceStreams({ servers: SERVERS, space });
  const admin = await connect({ servers: SERVERS });
  const jsm = await jetstreamManager(admin);
  const STREAMS = { presence: `KV_cotal_presence_${space}`, channels: `KV_cotal_channels_${space}` };
  const counts = async () => ({
    presence: (await jsm.streams.info(STREAMS.presence)).state.consumer_count,
    channels: (await jsm.streams.info(STREAMS.channels)).state.consumer_count,
  });
  const flat = (a: { presence: number; channels: number }, b: { presence: number; channels: number }) =>
    a.presence === b.presence && a.channels === b.channels;
  const plus = (a: { presence: number; channels: number }, n: number) => ({ presence: a.presence + n, channels: a.channels + n });
  const mkWatcher = () => {
    const ep = new CotalEndpoint({
      space, servers: SERVERS,
      channels: [], consume: false, registerPresence: false, watchPresence: true,
      card: { name: `watcher-${randomUUID().slice(0, 6)}`, kind: "endpoint", owner: "local", actor: `w${randomUUID().slice(0, 6)}` },
    });
    ep.on("error", () => { /* graded by the counts */ });
    return ep;
  };

  const base = await counts();

  // ---- 1. The issue's repro: five start/stop cycles of a watching endpoint ----
  console.log("\n1. five start/stop cycles of a watching endpoint");
  let boundOnce = false;
  for (let i = 0; i < 5; i++) {
    const w = mkWatcher();
    await w.start();
    await w.waitForPresenceSnapshot();
    const while_ = await counts();
    if (i === 0) boundOnce = flat(while_, plus(base, 1));
    await w.stop();
  }
  const afterCycles = await counts();
  ok("1.1 CONTROL: a started watching endpoint holds one consumer on each KV stream while it lives", boundOnce, { base });
  ok("1.2 after five start/stop cycles both KV streams are back at the baseline count (was +5 each)",
    flat(afterCycles, base), { base, afterCycles });

  // ---- 2. A manual reconnect retires the old connection's watches with their consumers ----
  console.log("\n2. a manual reconnect leaves only the rebound watch's consumers");
  const r = mkWatcher();
  await r.start();
  await r.waitForPresenceSnapshot();
  const beforeReconnect = await counts();
  await r.reconnect();
  await r.waitForPresenceSnapshot();
  const afterReconnect = await counts();
  ok("2.1 CONTROL: the watcher held one consumer per stream before the reconnect", flat(beforeReconnect, plus(base, 1)), { base, beforeReconnect });
  ok("2.2 after a manual reconnect each stream holds exactly the rebound watch's one consumer (was two)",
    flat(afterReconnect, plus(base, 1)), { base, afterReconnect });
  await r.stop();
  const afterStop = await counts();
  ok("2.3 stopping the reconnected watcher returns both streams to the baseline", flat(afterStop, base), { base, afterStop });

  await admin.close();
} finally {
  releaseBroker();
  broker.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed === 0
  ? `kv-watch-consumers smoke: ${cells} checks passed`
  : `kv-watch-consumers smoke: ${failed} of ${cells} FAILED`);
process.exit(failed === 0 ? 0 : 1);
