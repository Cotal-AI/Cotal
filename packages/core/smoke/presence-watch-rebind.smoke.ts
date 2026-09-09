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
 * Section 5 then drives the incident's own shape: the presence STREAM is deleted and recreated
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
import { mkdtempSync } from "node:fs";
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

  for (const p of peers) await p.stop();
  await observer.stop();
  await admin.drain();
} finally {
  releaseBroker();
}

console.log(`\npresence watch rebind smoke: ${cells - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
