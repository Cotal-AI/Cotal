/**
 * A STALLED PRESENCE WATCH MUST NOT SWEEP EVERY PEER OFFLINE.
 *
 * WHAT WAS MEASURED. On 2026-08-30 a dashboard observing `cotal_presence_netcup` (31 keys,
 * heartbeat 2s / TTL 6s) over a VPN went empty. A broker-local probe of the same bucket in the
 * same window saw zero gaps >4s and zero TTL deletes. The VPN-side watch then delivered all 31
 * keys in one burst with inter-update gaps of 126.5–128.6s: the stream had stalled silently and
 * replayed on recovery. An unrelated SSH session over the same path died at the stall start
 * (`Broken pipe`), so this was an overlay stall, not NATS-specific. Clock skew was sub-second.
 *
 * MECHANISM. `sweep()` ages every roster entry against `now - p.ts > ttlMs` on a timer that
 * keeps running while the KV watch is silent. The TCP connection stays up, so nats.js reports
 * live and no `connection` event fires. ~one TTL into the stall every peer flips `offline`, the
 * web server pushes the roster, and the sidebar (an online-only list) empties. That is the
 * observer calling its own deafness peer death.
 *
 * THE STIMULUS IS A HOLD, NOT A DROP. The same TCP-proxy shape as
 * `presence-watch-rebuild.smoke.ts`: sockets stay open, bytes stop moving. Peers heartbeat
 * through a direct broker connection so the bucket itself stays fresh; only the observer's
 * watch is held.
 *
 * WHAT THIS DOES NOT CLAIM. Not a WAN, not 31 keys, not the dashboard pixels. The cells prove
 * the endpoint verdict: during a hold past TTL, with the transport still open, the observer
 * must mark the *view* stale and keep last-known statuses rather than emit one offline per
 * peer. Recovery is "the watch delivered again", not "TCP reconnect". A single laggard whose
 * own `ts` ages out while the watch is still live still goes offline — the gate is
 * whole-bucket silence, not "never sweep".
 *
 * Needs nats-server on PATH.
 * Run: pnpm smoke:presence-watch-stall
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import {
  CotalEndpoint,
  isReachable,
  setupSpaceStreams,
} from "../src/index.js";
import { pickFreePort, startOnFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

let cells = 0, failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown): void => {
  cells++;
  if (cond) return;
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pass-through that can STALL (sockets open, bytes held) without dropping the TCP session. */
function link(listen: number, target: number): Promise<{
  stall: () => void;
  resume: () => void;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    let stalled = false;
    const held: { to: net.Socket; chunk: Buffer }[] = [];
    const live = new Set<net.Socket>();
    const pipe = (from: net.Socket, to: net.Socket) => {
      from.on("data", (chunk: Buffer) => {
        if (stalled) held.push({ to, chunk });
        else if (!to.destroyed) to.write(chunk);
      });
      from.on("error", () => to.destroy());
      from.on("close", () => to.destroy());
    };
    const srv = net.createServer((client) => {
      const up = net.connect(target, "127.0.0.1");
      live.add(client); live.add(up);
      client.on("close", () => live.delete(client));
      up.on("close", () => live.delete(up));
      pipe(client, up);
      pipe(up, client);
    });
    srv.once("error", reject);
    srv.listen(listen, "127.0.0.1", () => resolve({
      stall: () => { stalled = true; },
      resume: () => { stalled = false; for (const h of held.splice(0)) if (!h.to.destroyed) h.to.write(h.chunk); },
      close: () => { for (const s of live) s.destroy(); srv.close(); },
    }));
  });
}

const HEARTBEAT_MS = 200;
const TTL_MS = 600;
const PEERS = 3;

const space = `presstall-${randomUUID().slice(0, 8)}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));

// A port picked here is unheld until `nats-server` binds it, and this suite is
// where that window was lost on a parallel shard (#1583): the broker was
// promised 45019, something else took it, and the readiness loop below waited
// its full 10s for a server that was never coming. Another port is the answer,
// so readiness moved INTO the start.
//
// Everything from the temp directory on is inside the try/finally, because
// exhausting the attempts THROWS: with the start above it, the give-up path
// left `dir` on disk and a spawned broker with no signal teardown for the
// whole readiness loop, which is minutes.
let PORT = 0;
let broker: ReturnType<typeof spawn> | undefined;
let releaseBroker: (() => void) | undefined;
let gate: Awaited<ReturnType<typeof link>> | undefined;
let SERVERS = "";
let SLOW = "";

const cleanup = () => {
  gate?.close();
  releaseBroker?.();
  broker?.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
};

try {
  // stderr is piped and kept so the give-up message can tell a port COLLISION
  // (the broker exited, saying `address already in use`) from a broker that
  // bound the port and never spoke. Both leave the port occupied, so nothing
  // the helper can see distinguishes them — only this process knows whether
  // its own child is still running and what it said.
  const stderrOf = new WeakMap<ReturnType<typeof spawn>, string[]>();
  const brokerRun = await startOnFreePort(
    (port) => {
      const child = spawn("nats-server", ["-js", "-sd", join(dir, "js"), "-p", String(port), "-a", "127.0.0.1"],
        { stdio: ["ignore", "ignore", "pipe"] });
      const lines: string[] = [];
      stderrOf.set(child, lines);
      child.stderr?.on("data", (chunk) => { lines.push(String(chunk)); });
      // `spawn` reports a missing binary through an ASYNC `error` event, not a
      // throw, so without this listener an absent `nats-server` escapes the
      // helper entirely, kills the process on an unhandled error, and takes
      // the cleanup with it. Recorded instead: the attempt then fails
      // readiness like any other and says why.
      child.once("error", (error) => { lines.push(`spawn failed: ${error.message}`); });
      return child;
    },
    async (port) => {
      for (let i = 0; i < 100; i++) {
        if (await isReachable(`nats://127.0.0.1:${port}`)) return true;
        await wait(100);
      }
      return false;
    },
    // Resolves when the child is GONE, not when the kill was sent: three
    // retries otherwise leave three live brokers racing for the next port.
    (child) => new Promise<void>((done) => {
      if (child.exitCode !== null || child.signalCode !== null) return done();
      child.once("exit", () => done());
      child.kill("SIGKILL");
    }),
    {
      describe: (child) => {
        const said = (stderrOf.get(child) ?? []).join("").trim().split("\n").at(-1) ?? "";
        const state = child.exitCode !== null ? `exited ${child.exitCode}`
          : child.signalCode !== null ? `killed by ${child.signalCode}`
          : "still running, so it bound the port and never answered";
        return said ? `${state}: ${said}` : state;
      },
    },
  );
  PORT = brokerRun.port;
  broker = brokerRun.started;
  SERVERS = `nats://127.0.0.1:${PORT}`;
  releaseBroker = teardownOnSignal(broker, dir);

  const PROXY = await pickFreePort();
  SLOW = `nats://127.0.0.1:${PROXY}`;
  gate = await link(PROXY, PORT);
} catch (error) {
  cleanup();
  throw error;
}

const live = (ep: CotalEndpoint) => ep.getRoster().filter((p) => p.status !== "offline");
const statusOf = (ep: CotalEndpoint) =>
  Object.fromEntries(ep.getRoster().map((p) => [p.card.name, p.status]));

try {
  // `startOnFreePort` already refused to return an unreachable broker; this
  // re-reads it so the suite still states its own precondition rather than
  // inheriting it silently from a helper.
  if (!(await isReachable(SERVERS)))
    throw new Error(`fixture broker never came up on ${SERVERS} - refusing to report on a server that never started`);
  await setupSpaceStreams({ servers: SERVERS, space });

  const peers: CotalEndpoint[] = [];
  for (let i = 0; i < PEERS; i++) {
    const p = new CotalEndpoint({
      space, servers: SERVERS,
      channels: [], consume: false, watchPresence: false, registerPresence: true,
      heartbeatMs: HEARTBEAT_MS, ttlMs: TTL_MS,
      card: { name: `peer${i}`, kind: "agent", role: "agent" },
    });
    p.on("error", () => { /* unused on the direct path */ });
    await p.start();
    peers.push(p);
  }

  const observer = new CotalEndpoint({
    space, servers: SLOW,
    channels: [], consume: false, registerPresence: false, watchPresence: true,
    heartbeatMs: HEARTBEAT_MS, ttlMs: TTL_MS,
    card: { name: "web", kind: "endpoint" },
  });
  const connection: { connected: boolean }[] = [];
  const presenceTypes: string[] = [];
  const views: { fresh: boolean; staleSince?: number }[] = [];
  observer.on("error", () => { /* the stall is the stimulus */ });
  observer.on("connection", (e: { connected: boolean }) => connection.push(e));
  observer.on("presence", (e: { type: string }) => presenceTypes.push(e.type));
  observer.on("presence-view", (v: { fresh: boolean; staleSince?: number }) => views.push(v));
  await observer.start();
  await observer.waitForPresenceSnapshot(2_000);
  await wait(400);

  ok("1.1 CONTROL: the observer sees every live peer before the stall",
    live(observer).length === PEERS, statusOf(observer));
  ok("1.2 CONTROL: the presence view is fresh before the stall",
    observer.presenceView().fresh === true, observer.presenceView());

  const connectedBefore = connection.filter((e) => e.connected === false).length;
  const offlineBefore = presenceTypes.filter((t) => t === "offline").length;

  gate.stall();
  await wait(TTL_MS * 2 + 400);

  const after = observer.getRoster();
  const view = observer.presenceView();
  const dropped = connection.filter((e) => e.connected === false).length - connectedBefore;
  const offlined = presenceTypes.filter((t) => t === "offline").length - offlineBefore;

  ok("1.3 the transport still claims live (no connection-drop during the hold)",
    dropped === 0, { dropped, connection });
  ok("1.4 sweep did NOT emit a wholesale offline verdict",
    offlined === 0, { offlined, presenceTypes: presenceTypes.slice(-10), status: statusOf(observer) });
  ok("1.5 last-known statuses stay online (the sidebar's input does not empty)",
    live(observer).length === PEERS && after.every((p) => p.status !== "offline"),
    statusOf(observer));
  ok("1.6 the view itself is stale: whole-bucket silence past TTL, not 3 peer deaths",
    view.fresh === false && typeof view.staleSince === "number", view);
  ok("1.7 and that stale transition was emitted (the page has something to surface)",
    views.some((v) => v.fresh === false), views);

  gate.resume();
  const recovered = await (async () => {
    const start = Date.now();
    while (Date.now() - start < 4_000) {
      if (observer.presenceView().fresh) return true;
      await wait(50);
    }
    return observer.presenceView().fresh;
  })();
  ok("1.8 on recovery the view goes fresh again (the watch delivered, not a reconnect)",
    recovered === true, observer.presenceView());
  const recoveryOfflines = presenceTypes.filter((t) => t === "offline").length - offlineBefore;
  const recoveryJoins = presenceTypes.filter((t) => t === "join").length;
  ok("1.9 recovery does NOT emit per-peer offline verdicts (a pre-resume count cannot see the flicker)",
    recoveryOfflines === 0 && live(observer).length === PEERS,
    { recoveryOfflines, recoveryJoins, presenceTypes, status: statusOf(observer) });

  // POSITIVE CONTROL: the gate is whole-bucket silence, not "never sweep". A peer that
  // publishes once and then never heartbeats ages out while others keep the watch live.
  const sleepy = new CotalEndpoint({
    space, servers: SERVERS,
    channels: [], consume: false, watchPresence: false, registerPresence: true,
    heartbeatMs: 30_000, ttlMs: TTL_MS,
    card: { name: "sleepy", kind: "agent", role: "agent" },
  });
  sleepy.on("error", () => { /* unused */ });
  await sleepy.start();
  const joined = await (async () => {
    const start = Date.now();
    while (Date.now() - start < 2_000) {
      if (observer.getRoster().some((p) => p.card.name === "sleepy" && p.status !== "offline")) return true;
      await wait(50);
    }
    return observer.getRoster().some((p) => p.card.name === "sleepy");
  })();
  ok("2.1 CONTROL: a slow-heartbeat peer joins while the watch is live",
    joined === true, statusOf(observer));
  await wait(TTL_MS * 2 + 400);
  const sleepyAfter = observer.getRoster().find((p) => p.card.name === "sleepy");
  ok("2.2 and THAT peer is swept offline (the watch was not silent; only its ts aged out)",
    sleepyAfter?.status === "offline", { sleepy: sleepyAfter?.status, status: statusOf(observer) });
  ok("2.3 the heartbeating peers stay online through that sweep",
    live(observer).filter((p) => p.card.name !== "sleepy").length === PEERS, statusOf(observer));

  await sleepy.stop().catch(() => { /* already gone */ });
  await observer.stop().catch(() => { /* stall may have raced shutdown */ });
  for (const p of peers) await p.stop().catch(() => { /* already gone */ });
} finally {
  cleanup();
}

console.log(`\npresence watch stall smoke: ${cells - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
