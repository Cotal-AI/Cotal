/**
 * A PRESENCE WATCH WHOSE CONSUMER DIED UNDER A LIVE CONNECTION MUST REBIND, NOT STAY STALE.
 *
 * WHAT WAS MEASURED. netcup, 2026-09-09 21:17Z: the presence stream was deleted and recreated.
 * Its sequence restarted at 1. Every observer already watching held a nats.js ORDERED push
 * consumer that re-created itself from its old cursor (`by_start_sequence`, opt_start_seq
 * 12685862 against a stream whose last sequence was 35337). The broker kept sending idle
 * heartbeats to those consumers, so the client never reset again and the iterator never
 * closed. The manager's roster froze at the pre-recreation snapshot: `cotal ps` rendered every
 * seat older than the recreation "mesh offline" and every newer seat "not in roster" for
 * hours, while a fresh observer of the same bucket saw all of them heartbeating at age 0s.
 *
 * MECHANISM. `sweep()` correctly refuses to age peers out while the whole bucket is silent
 * (#1045) and marks the view stale. That is the right verdict for a held link and the wrong
 * END STATE when the transport is up and the watch's own consumer is what died: nothing ever
 * re-created it, so "stale" was permanent. The same end state follows a plain consumer delete.
 *
 * THE STIMULUS IS A CONSUMER DELETE, NOT A LINK HOLD. `presence-watch-stall.smoke.ts` holds
 * bytes; this suite deletes the observer's consumer at the broker while every peer keeps
 * heartbeating on the same connection path. The endpoint must notice whole-bucket silence
 * with the connection up, rebind a watch from the bucket's current state, and report the
 * peers live again, without emitting a wholesale offline verdict and without a reconnect.
 *
 * Section 8 purges every key and kills the consumer so the rebind lands on an EMPTY bucket: the
 * bind-time pending count, not a delivery, is what makes that view current, retires the frozen
 * roster, and keeps the view current without a rebind per window while the mesh stays empty.
 *
 * Sections 6 and 7 hold the return of the real kv.watch() so a rebind is mid-bind when stop() or
 * reconnect() lands: the late bind must install nothing (an epoch fence retires it).
 *
 * Section 5 drives the incident's own shape: the presence STREAM is deleted and recreated
 * under the same live connection. While it is gone the rebind is refused and must be retried
 * at most once per TTL (not per sweep tick); once it is back the observer must rebind and see
 * every heartbeating peer again.
 *
 * WHAT THIS DOES NOT CLAIM. Not a WAN, not `cotal ps` pixels; the CLI rendering of the
 * manager's view state is graded in implementations/cli/smoke/ps-mesh-column.smoke.ts.
 *
 * Needs nats-server on PATH.
 * Run: pnpm smoke:presence-watch-rebind
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
  if (cond) return;
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean, ms: number): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < ms) { if (pred()) return true; await wait(50); }
  return pred();
};

const PEERS = 3;
const HEARTBEAT_MS = 500;
const TTL_MS = 1_500;
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `presrebind-${randomUUID().slice(0, 8)}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", join(dir, "js"), "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);

const live = (ep: CotalEndpoint) => ep.getRoster().filter((p) => p.status !== "offline");
const statusOf = (ep: CotalEndpoint) => Object.fromEntries(ep.getRoster().map((p) => [p.card.name, p.status]));

try {
  let up = false;
  for (let i = 0; i < 100; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(100); }
  if (!up) throw new Error(`fixture broker never came up on ${SERVERS} - refusing to report on a server that never started`);
  await setupSpaceStreams({ servers: SERVERS, space });
  const stream = `KV_cotal_presence_${space}`;
  const admin = await connect({ servers: SERVERS });
  const jsm = await jetstreamManager(admin);
  const consumerNames = async () => { const names: string[] = []; for await (const c of jsm.consumers.list(stream)) names.push(c.name); return names; };

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

  // The observer is manager-shaped: it registers AND watches, on the same direct connection.
  const observer = new CotalEndpoint({
    space, servers: SERVERS,
    channels: [], consume: false, registerPresence: true, watchPresence: true,
    heartbeatMs: HEARTBEAT_MS, ttlMs: TTL_MS,
    card: { name: "manager", kind: "endpoint", role: "manager" },
  });
  const connection: { connected: boolean }[] = [];
  const presenceTypes: string[] = [];
  const views: { state: string }[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  observer.on("error", (e: Error) => errors.push(e.message));
  observer.on("warning", (e: Error) => warnings.push(e.message));
  observer.on("connection", (e: { connected: boolean }) => connection.push(e));
  observer.on("presence", (e: { type: string }) => presenceTypes.push(e.type));
  observer.on("presence-view", (v: { state: string }) => views.push(v));
  await observer.start();
  await until(() => live(observer).length === PEERS + 1, 3_000);

  ok("1.1 CONTROL: the observer sees every live peer before the delete",
    live(observer).length === PEERS + 1, statusOf(observer));
  ok("1.2 CONTROL: the presence view is current before the delete",
    observer.presenceView().state === "current", observer.presenceView());
  const before = await consumerNames();
  ok("1.3 CONTROL: exactly one presence consumer exists, the observer's (peers do not watch)",
    before.length === 1, before);
  const connectionsBefore = connection.length;
  const offlineBefore = presenceTypes.filter((t) => t === "offline").length;

  // --- STIMULUS: the broker loses the observer's consumer; the connection stays up. ---
  for (const name of before) await jsm.consumers.delete(stream, name);
  ok("1.4 the delete landed: zero presence consumers on the stream",
    (await consumerNames()).length === 0);

  // The client's own recovery (ordered-consumer reset on a missed heartbeat) fires at 30s
  // intervals and, after a stream recreation, resumes at a dead cursor. Within TTL the
  // endpoint must reach the stale verdict on its own...
  const wentStale = await until(() => observer.presenceView().state === "stale", TTL_MS * 2 + 500);
  ok("2.1 within ~TTL of silence the view reads stale (the observer noticed its own deafness)",
    wentStale === true, observer.presenceView());
  // ...and then, with the connection up, rebind rather than stay there.
  const rebound = await until(() => observer.presenceView().state === "current", TTL_MS * 3);
  ok("2.2 the view returns to current without a reconnect (a NEW watch was bound under the live connection)",
    rebound === true && connection.length === connectionsBefore,
    { view: observer.presenceView(), connectionEvents: connection.length - connectionsBefore });
  const after = await consumerNames();
  ok("2.3 exactly one presence consumer exists again, and it is not the deleted one",
    after.length === 1 && !before.includes(after[0]!), { before, after });
  const peersBack = await until(() => live(observer).length === PEERS + 1, TTL_MS * 2);
  ok("2.4 every heartbeating peer is live again in the roster",
    peersBack === true, statusOf(observer));
  ok("2.5 the rebind is REPORTED as a warning naming the silent window, not hidden and not an error",
    warnings.some((w) => /presence watch silent for \d+ms .* rebound/.test(w)) && errors.length === 0,
    { warnings, errors });
  const offlineDuring = presenceTypes.filter((t) => t === "offline").length - offlineBefore;
  ok("2.6 no per-peer offline verdict was emitted for the observer's own deafness",
    offlineDuring === 0, { offlineDuring, presenceTypes });
  ok("2.7 the view went stale then current exactly once each (no flapping)",
    views.map((v) => v.state).filter((s) => s === "stale").length === 1 &&
      views.map((v) => v.state).filter((s) => s === "current").length >= 1,
    views);

  // --- POSITIVE CONTROL: after the rebind the watch is a real watch, not a replayed snapshot. ---
  const joiner = new CotalEndpoint({
    space, servers: SERVERS,
    channels: [], consume: false, watchPresence: false, registerPresence: true,
    heartbeatMs: HEARTBEAT_MS, ttlMs: TTL_MS,
    card: { name: "late-joiner", kind: "agent", role: "agent" },
  });
  joiner.on("error", () => { /* unused */ });
  await joiner.start();
  const joined = await until(() => observer.getRoster().some((p) => p.card.name === "late-joiner" && p.status !== "offline"), 3_000);
  ok("3.1 a peer joining AFTER the rebind is observed live (the rebound watch streams updates)",
    joined === true, statusOf(observer));
  await joiner.stop();
  const left = await until(() => observer.getRoster().find((p) => p.card.name === "late-joiner")?.status === "offline", TTL_MS * 2 + 500);
  ok("3.2 and its clean leave is observed as offline (a real DEL/offline record reached the rebound watch)",
    left === true, statusOf(observer));

  // --- NEGATIVE CONTROL: a single laggard still ages out; the rebind is not 'never offline'. ---
  const sleepy = new CotalEndpoint({
    space, servers: SERVERS,
    channels: [], consume: false, watchPresence: false, registerPresence: true,
    heartbeatMs: 30_000, ttlMs: TTL_MS,
    card: { name: "sleepy", kind: "agent", role: "agent" },
  });
  sleepy.on("error", () => { /* unused */ });
  await sleepy.start();
  await until(() => observer.getRoster().some((p) => p.card.name === "sleepy" && p.status !== "offline"), 2_000);
  const sleepyAged = await until(() => observer.getRoster().find((p) => p.card.name === "sleepy")?.status === "offline", TTL_MS * 3);
  ok("4.1 CONTROL: a slow-heartbeat peer is swept offline while the rebound watch stays live",
    sleepyAged === true && observer.presenceView().state === "current", { sleepy: statusOf(observer).sleepy, view: observer.presenceView() });
  ok("4.2 CONTROL: the heartbeating peers stay online through that sweep",
    live(observer).filter((p) => !["sleepy", "late-joiner"].includes(p.card.name)).length === PEERS + 1, statusOf(observer));
  ok("4.3 CONTROL: no second rebind was attempted while the watch was delivering (one warning total)",
    warnings.filter((w) => /rebound/.test(w)).length === 1, warnings);

  await sleepy.stop();

  // --- THE INCIDENT: the presence stream is deleted and recreated under a live connection. ---
  const errorsBefore = errors.length;
  const warningsBefore = warnings.filter((w) => /rebound/.test(w)).length;
  await jsm.streams.delete(stream);
  const staleAgain = await until(() => observer.presenceView().state === "stale", TTL_MS * 2 + 500);
  ok("5.1 with the stream gone the view reads stale within ~TTL (silence noticed, transport still up)",
    staleAgain === true, observer.presenceView());
  await wait(TTL_MS * 3);
  const refused = errors.length - errorsBefore;
  ok("5.2 a refused rebind is retried at most once per TTL, not once per sweep tick",
    refused >= 1 && refused <= 4, { refused, sample: errors.slice(errorsBefore, errorsBefore + 2) });
  ok("5.3 each refusal is REPORTED as an error naming the missing stream",
    errors.slice(errorsBefore).every((e) => /stream not found|not found/i.test(e)), errors.slice(errorsBefore, errorsBefore + 2));
  await setupSpaceStreams({ servers: SERVERS, space });
  const recreated = await until(() => observer.presenceView().state === "current", TTL_MS * 3);
  ok("5.4 after the stream is recreated the observer rebinds and the view is current again, no reconnect",
    recreated === true && connection.length === connectionsBefore, { view: observer.presenceView(), connectionEvents: connection.length - connectionsBefore });
  const peersAfterRecreate = await until(() => live(observer).filter((p) => p.card.name.startsWith("peer")).length === PEERS, TTL_MS * 3);
  ok("5.5 every heartbeating peer is live again in the roster (its heartbeats land on the new stream)",
    peersAfterRecreate === true, statusOf(observer));
  ok("5.6 exactly one more rebind was reported for the recreation",
    warnings.filter((w) => /rebound/.test(w)).length === warningsBefore + 1, warnings);

  // --- THE RACE (rev-1421-gpt BLOCK on c67c0bb9): a bind still awaiting the broker when stop()
  // or reconnect() lands must NOT install its watch afterwards. The probe holds the RETURN of the
  // real kv.watch(): the consumer and its iterator exist, the endpoint has not yet seen them.
  type Held = { release?: () => void; bound: number };
  const holdWatch = (ep: CotalEndpoint): Held => {
    const held: Held = { bound: 0 };
    const kv = (ep as unknown as { kv: { watch: (...a: unknown[]) => Promise<unknown> } }).kv;
    const real = kv.watch.bind(kv);
    kv.watch = async (...a: unknown[]) => {
      const it = await real(...a);
      held.bound++;
      await new Promise<void>((r) => { held.release = r; });
      return it;
    };
    return held;
  };
  const iterOf = (ep: CotalEndpoint) => (ep as unknown as { presenceWatchIter?: unknown }).presenceWatchIter;
  const mkObserver = (name: string, registerPresence = true) => {
    const ep = new CotalEndpoint({
      space, servers: SERVERS,
      channels: [], consume: false, registerPresence, watchPresence: true,
      heartbeatMs: HEARTBEAT_MS, ttlMs: TTL_MS,
      card: { name, kind: "endpoint", role: "manager" },
    });
    const log = { warnings: [] as string[], errors: [] as string[] };
    ep.on("error", (e: Error) => log.errors.push(e.message));
    ep.on("warning", (e: Error) => log.warnings.push(e.message));
    return { ep, log };
  };
  // Every observer's consumer on the stream except the named survivor.
  const killConsumersExcept = async (keep: string[]) => {
    for (const name of await consumerNames()) if (!keep.includes(name)) await jsm.consumers.delete(stream, name);
  };
  const survivors = await consumerNames(); // the first observer's rebound watch

  // 6. stop() during an in-flight rebind.
  {
    const { ep, log } = mkObserver("stopper");
    await ep.start();
    await until(() => live(ep).length >= PEERS + 1, 3_000);
    const held = holdWatch(ep);
    await killConsumersExcept(survivors);
    const inFlight = await until(() => held.bound === 1 && held.release !== undefined, TTL_MS * 4);
    ok("6.1 SETUP: a rebind is in flight with its watch bound at the broker and not yet returned",
      inFlight === true, { bound: held.bound, view: ep.presenceView() });
    await ep.stop();
    ok("6.2 after stop() the endpoint holds no presence watch",
      iterOf(ep) === undefined);
    const warningsAtStop = log.warnings.filter((w) => /rebound/.test(w)).length;
    held.release!();
    await wait(TTL_MS);
    ok("6.3 the late bind installs NOTHING on the stopped endpoint (no resurrected watch)",
      iterOf(ep) === undefined, { iter: iterOf(ep) !== undefined });
    ok("6.4 and reports no successful rebind after stop",
      log.warnings.filter((w) => /rebound/.test(w)).length === warningsAtStop, log.warnings);
    ok("6.5 and raises no error for the retired bind (its epoch is gone, not faulty)",
      log.errors.length === 0, log.errors);
  }

  // 7. reconnect() during an in-flight rebind: the fresh epoch's watch must stand.
  {
    const { ep, log } = mkObserver("rebuilder");
    await ep.start();
    await until(() => live(ep).length >= PEERS + 1, 3_000);
    const held = holdWatch(ep);
    await killConsumersExcept(survivors);
    const inFlight = await until(() => held.bound === 1 && held.release !== undefined, TTL_MS * 4);
    ok("7.1 SETUP: a rebind is in flight with its watch bound and not yet returned",
      inFlight === true, { bound: held.bound, view: ep.presenceView() });
    await ep.reconnect();
    const freshCurrent = await until(() => ep.presenceView().state === "current" && live(ep).length >= PEERS + 1, TTL_MS * 3);
    const fresh = iterOf(ep);
    ok("7.2 after reconnect the fresh epoch's own watch is bound and current",
      freshCurrent === true && fresh !== undefined, { view: ep.presenceView(), roster: statusOf(ep) });
    const reboundBefore = log.warnings.filter((w) => /rebound/.test(w)).length;
    held.release!();
    await wait(TTL_MS * 2);
    ok("7.3 the old epoch's late bind does not overwrite the fresh watch",
      iterOf(ep) === fresh);
    ok("7.4 the view stays current across the release (no stale relapse, no second rebind)",
      ep.presenceView().state === "current" && log.warnings.filter((w) => /rebound/.test(w)).length === reboundBefore,
      { view: ep.presenceView(), warnings: log.warnings });
    ok("7.5 every heartbeating peer is still live on the fresh watch",
      live(ep).filter((p) => p.card.name.startsWith("peer")).length === PEERS, statusOf(ep));
    ok("7.6 no error was raised for the retired bind",
      log.errors.length === 0, log.errors);
    await ep.stop();
  }

  // --- EMPTY BUCKET (rev-1421-grok BLOCK on c67c0bb9): a rebind onto zero keys delivers no entry,
  // so nothing refreshes lastPresenceWatchAt by delivery. The bind-time pending count is the one
  // fact that says "nobody is present": it must turn the view current, retire the frozen roster,
  // and NOT relapse to stale one window later (a rebind per TTL for as long as the mesh is empty).
  // A non-registering observer is populated while peers live, then every key is purged and its
  // consumer killed.
  {
    const { ep, log } = mkObserver("emptywatcher", false);
    const emptyViews: string[] = [];
    ep.on("presence-view", (v: { state: string }) => emptyViews.push(v.state));
    await ep.start();
    const populated = await until(() => ep.presenceView().state === "current" && live(ep).length >= PEERS, 3_000);
    ok("8.1 SETUP: a non-registering observer is populated and current while peers live",
      populated === true, { view: ep.presenceView(), roster: statusOf(ep) });
    for (const p of peers) await p.stop();
    await observer.stop();
    await jsm.streams.purge(stream);
    await killConsumersExcept([]);
    const wentStaleEmpty = await until(() => emptyViews.includes("stale"), TTL_MS * 2 + 500);
    ok("8.2 with every key purged and its consumer gone the view was reported stale",
      wentStaleEmpty === true, { views: emptyViews, view: ep.presenceView() });
    const reboundEmpty = await until(() => ep.presenceView().state === "current", TTL_MS * 3);
    ok("8.3 the rebind onto an EMPTY bucket turns the view current (nobody present is current knowledge)",
      reboundEmpty === true, { view: ep.presenceView(), warnings: log.warnings, errors: log.errors });
    ok("8.4 the frozen roster is retired at the rebind (no peer reads live on an empty bucket)",
      (await until(() => live(ep).length === 0, TTL_MS)) === true, statusOf(ep));
    const reboundCount = () => log.warnings.filter((w) => /rebound/.test(w)).length;
    ok("8.5 that rebind was reported once and raised no error",
      reboundCount() === 1 && log.errors.length === 0, log);
    await wait(TTL_MS * 3);
    ok("8.6 the empty-bucket view stays current for three further windows with no further rebind (silence on an empty bucket is not staleness)",
      ep.presenceView().state === "current" && reboundCount() === 1 && emptyViews.filter((v) => v === "stale").length === 1,
      { view: ep.presenceView(), rebinds: reboundCount(), views: emptyViews });
    // POSITIVE CONTROL: the empty-bucket watch is a live watch; the first write lands on it.
    const returner = new CotalEndpoint({
      space, servers: SERVERS,
      channels: [], consume: false, watchPresence: false, registerPresence: true,
      heartbeatMs: HEARTBEAT_MS, ttlMs: TTL_MS,
      card: { name: "returner", kind: "agent", role: "agent" },
    });
    returner.on("error", () => { /* unused */ });
    await returner.start();
    const returned = await until(() => ep.getRoster().some((p) => p.card.name === "returner" && p.status !== "offline"), 3_000);
    ok("8.7 CONTROL: a peer joining the empty bucket is observed live on the rebound watch",
      returned === true && ep.presenceView().state === "current", { roster: statusOf(ep), view: ep.presenceView() });
    // NEGATIVE CONTROL: once that watch has delivered, its silence is staleness again. Kill the
    // observer's consumer while the returner keeps heartbeating: the view must read stale within
    // ~TTL (the empty-bucket hold ended at the first delivery), then rebind and read current.
    const staleBefore = emptyViews.filter((v) => v === "stale").length;
    await killConsumersExcept([]);
    const staleAfterDelivery = await until(() => emptyViews.filter((v) => v === "stale").length > staleBefore, TTL_MS * 2 + 500);
    ok("8.8 CONTROL: after a delivery on that watch, silence past TTL reads stale again (the empty-bucket hold does not outlive the first write)",
      staleAfterDelivery === true, { views: emptyViews, view: ep.presenceView() });
    const currentAgain = await until(() => ep.presenceView().state === "current" && reboundCount() === 2, TTL_MS * 3);
    ok("8.9 CONTROL: and that silence is repaired by a second rebind (the returner is heard again)",
      currentAgain === true && (await until(() => ep.getRoster().some((p) => p.card.name === "returner" && p.status !== "offline"), TTL_MS * 2)),
      { view: ep.presenceView(), rebinds: reboundCount(), roster: statusOf(ep) });
    await returner.stop();
    await ep.stop();
  }

  await admin.drain();
} finally {
  releaseBroker();
  broker.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\npresence watch rebind smoke: ${cells - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
