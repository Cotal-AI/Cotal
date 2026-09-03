/**
 * A RECONNECTING PRESENCE VIEW MUST NOT AUTHORIZE ABSENCE DURING SNAPSHOT REFILL.
 *
 * The roster is a connection-scoped cache. Reconnect clears it, then a fresh KV watch replays
 * the bucket one entry at a time. Every roster event during that replay is sampled synchronously,
 * which makes the partial-cache window observable without timing sleeps or a synthetic endpoint.
 *
 * Needs nats-server on PATH.
 * Run: pnpm smoke:presence-view-refill
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable, setupSpaceStreams } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

let cells = 0;
let failed = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  cells++;
  if (condition) return;
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(25);
  }
  return predicate();
};

type ObservedView = { state?: string; fresh: boolean; staleSince?: number };
type RefillSample = { rosterSize: number; names: string[]; view: ObservedView };

const HEARTBEAT_MS = 200;
const TTL_MS = 1_200;
const PEER_COUNT = 4;
const STOPPED = "peer0";
const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const space = `presence-refill-${randomUUID().slice(0, 8)}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn(
  "nats-server",
  ["-js", "-sd", join(dir, "js"), "-p", String(port), "-a", "127.0.0.1"],
  { stdio: "ignore" },
);
const releaseBroker = teardownOnSignal(broker, dir);

const peers: CotalEndpoint[] = [];
let observer: CotalEndpoint | undefined;
try {
  const up = await (async () => {
    for (let i = 0; i < 100; i++) {
      if (await isReachable(servers)) return true;
      await wait(50);
    }
    return false;
  })();
  if (!up)
    throw new Error(`fixture broker never came up on ${servers} - refusing to report on a server that never started`);
  await setupSpaceStreams({ servers, space });
  console.log("  fixture: broker and streams ready");

  for (let i = 0; i < PEER_COUNT; i++) {
    const peer = new CotalEndpoint({
      space,
      servers,
      channels: [],
      consume: false,
      watchPresence: false,
      registerPresence: true,
      heartbeatMs: HEARTBEAT_MS,
      ttlMs: TTL_MS,
      card: { name: `peer${i}`, kind: "agent", role: "agent" },
    });
    peer.on("error", () => {});
    await peer.start();
    peers.push(peer);
  }
  console.log(`  fixture: ${peers.length} peers registered`);

  observer = new CotalEndpoint({
    space,
    servers,
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: true,
    heartbeatMs: HEARTBEAT_MS,
    ttlMs: TTL_MS,
    card: { name: "observer", kind: "endpoint" },
  });
  observer.on("error", () => {});
  await observer.start();
  console.log("  fixture: observer connected");
  const firstSnapshot = await observer.waitForPresenceSnapshot(3_000) as unknown;
  check("1.1 CONTROL: the initial presence snapshot completes", firstSnapshot === "snapshot", firstSnapshot);
  check(
    "1.2 CONTROL: the observer initially sees every live peer",
    observer.getRoster().filter((presence) => presence.status !== "offline").length === PEER_COUNT,
    observer.getRoster().map((presence) => ({ name: presence.card.name, status: presence.status })),
  );

  await peers[0]!.stop();
  console.log("  fixture: stopped peer published offline");
  const stoppedVisible = await until(() =>
    observer!.getRoster().some((presence) => presence.card.name === STOPPED && presence.status === "offline"));
  check(
    "1.3 CONTROL: a genuinely stopped peer is distinguishable as offline before reconnect",
    stoppedVisible,
    observer.getRoster().map((presence) => ({ name: presence.card.name, status: presence.status })),
  );

  const refillSamples: RefillSample[] = [];
  let sampling = true;
  observer.on("roster", () => {
    if (!sampling) return;
    const roster = observer!.getRoster();
    refillSamples.push({
      rosterSize: roster.length,
      names: roster.map((presence) => presence.card.name),
      view: observer!.presenceView() as ObservedView,
    });
  });

  await observer.reconnect();
  console.log("  fixture: observer reconnected");
  const reconnectSnapshot = await observer.waitForPresenceSnapshot(3_000) as unknown;
  sampling = false;
  const partialSamples = refillSamples.filter((sample) => sample.rosterSize < PEER_COUNT);
  const unsafeSamples = refillSamples.filter((sample) => sample.view.fresh || sample.view.state !== "unpopulated");

  check("2.1 reconnect refill examines at least one roster sample per retained peer",
    refillSamples.length >= PEER_COUNT, { examined: refillSamples.length, samples: refillSamples });
  check("2.2 CONTROL: reconnect sampling includes a partial roster",
    partialSamples.length > 0, { partial: partialSamples.length, samples: refillSamples });
  check("2.3 every reconnect-refill sample is unpopulated and refuses a fresh absence verdict",
    unsafeSamples.length === 0, { examined: refillSamples.length, unsafeSamples });
  check("2.4 the reconnect snapshot reports completion rather than timeout",
    reconnectSnapshot === "snapshot", reconnectSnapshot);
  check("2.5 the completed reconnect snapshot is current",
    observer.presenceView().fresh === true && (observer.presenceView() as ObservedView).state === "current",
    observer.presenceView());
  check(
    "2.6 CONTROL: the genuinely stopped peer remains distinguishable as offline after reconnect",
    observer.getRoster().some((presence) => presence.card.name === STOPPED && presence.status === "offline"),
    observer.getRoster().map((presence) => ({ name: presence.card.name, status: presence.status })),
  );
} finally {
  console.log("  fixture: cleanup starting");
  await observer?.stop().catch(() => {});
  await Promise.all(peers.slice(1).map((peer) => peer.stop().catch(() => {})));
  await releaseBroker();
  console.log("  fixture: cleanup complete");
}

console.log(`\npresence view refill smoke: ${cells - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
