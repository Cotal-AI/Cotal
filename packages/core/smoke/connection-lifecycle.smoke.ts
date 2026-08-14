/**
 * Connection-lifecycle smoke: the three failure paths of the self-connect verbs, driven against a
 * real auth broker and asserted AT THE BROKER rather than from the endpoint's own report.
 *
 * SCOPE, stated up front so nothing here overclaims. These are CORE-level cells on
 * `CotalEndpoint.disconnect()` / `.connect()`. The tool path
 * (`extensions/connector-core/smoke/connection-control.smoke.ts`) drives the same two methods
 * through `cotalToolSpecs`, and covers the grant gate and the happy path. It cannot cover THESE
 * faults: a drain that rejects, and a creds-SOURCE endpoint, are states the connector cannot
 * construct (MeshAgent passes static creds bytes). So this suite proves the METHODS behave, and
 * makes no claim that a tool caller can reach arm 3 at all — for arm 3 that claim would be false.
 *
 * WHAT EACH ARM MEASURES, AND WHAT WOULD HAVE REFUTED IT — written before any result is cited:
 *
 * ARM 1  A refused `connect()` must leave NOTHING live.
 *        connectAndBind assigns `this.nc` at the handshake and then does fallible KV/JetStream
 *        binds. A throw there used to leave an authenticated connection open with no supervisor,
 *        while the caller was told the connect was refused.
 *        REFUTED IF: the broker still shows a live connection after the refusal.
 *        CONTROL D1-ctl: the broker's CUMULATIVE connection count must RISE across the refusal.
 *        Without it, "no live connection" is equally explained by an auth rejection that never
 *        opened one, and the arm proves nothing.
 *        CONTROL D1c: with JetStream restored, the SAME call succeeds. Arms can differ.
 *
 * ARM 2  A `teardown-failed` refusal must not report a retraction it did not send.
 *        disconnect() announces the departure, then tears down. When the teardown fails it must
 *        put the true state back — and it used to drop the KV handle first, so the re-assert was
 *        a no-op while the text said "the announcement has been retracted".
 *        REFUTED IF: an independent observer still sees the subject OFFLINE after the refusal.
 *        CONTROL D2c: with the fault removed, the same disconnect succeeds and the observer DOES
 *        see offline. Without it, "not offline" is equally explained by an observer that never
 *        sees anything.
 *
 * ARM 3  Credential renewal must not outlive a deliberate disconnect.
 *        The standing-creds arm proves its candidate with an AUTHENTICATED broker preflight, so a
 *        deliberately-off endpoint kept dialling the mesh it had just left.
 *        REFUTED IF: the source is called, or the broker's cumulative connection count rises,
 *        while the endpoint is off.
 *        CONTROL D3c: after connect(), both DO rise again. Without it, a quiet endpoint is
 *        equally explained by a timer that was never armed.
 *
 * Run: tsx packages/core/smoke/connection-lifecycle.smoke.ts   (needs `nats-server` on PATH)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint, isReachable, createSpaceAuth, mintCreds, provisionAgent, mintLifecycleUid,
  serverConfig, newIdentity, setupSpaceStreams,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

// ── Safety FIRST, before anything is constructed: never point a smoke at the live broker. ──────
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
const PORT = await pickFreePort();
const MON = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
if (SERVERS.includes("broker.cotal.ai")) throw new Error("REFUSING: live broker");
if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(SERVERS)) throw new Error(`REFUSING: not loopback (${SERVERS})`);
console.log(`[safety] inherited COTAL_* cleared; target=${SERVERS} monitor=127.0.0.1:${MON}`);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 8000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(100); }
  return fn();
};
const awaitExit = (p: ReturnType<typeof spawn>, ms = 4000): Promise<void> =>
  new Promise((res) => {
    if (p.exitCode !== null || p.signalCode !== null) return res();
    p.once("exit", () => res()); setTimeout(res, ms);
  });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

/** Broker-side truth. `total_connections` is CUMULATIVE (it only ever rises, so it witnesses a
 *  connection that has since been closed); `num_connections` is CURRENT. The pair is what
 *  separates "never opened one" from "opened one and left it open". */
const varz = async (): Promise<{ total: number; current: number }> => {
  const r = await fetch(`http://127.0.0.1:${MON}/varz`);
  const j = (await r.json()) as { total_connections: number; connections: number };
  return { total: j.total_connections, current: j.connections };
};

const space = `conn-life-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-conn-life-"));
const storeDir = join(dir, "js");
const baseConf = serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir });
/** The same broker, same accounts, same port — with or without JetStream, plus a monitoring port.
 *  Dropping the `jetstream { ... }` line is what makes ARM 1 a NATURAL post-dial failure: the
 *  socket and the credential are accepted exactly as before, and only the bind fails. No injection. */
const confFor = (jetstream: boolean): string =>
  `${baseConf.split("\n").filter((l) => jetstream || !l.trim().startsWith("jetstream")).join("\n")}\nhttp: 127.0.0.1:${MON}\n`;

let srv: ReturnType<typeof spawn> | undefined;
const startBroker = async (jetstream: boolean): Promise<void> => {
  writeFileSync(join(dir, "server.conf"), confFor(jetstream));
  srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore", detached: true });
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVERS)) return; await wait(200); }
  throw new Error(`nats-server (jetstream=${jetstream}) did not come up on ${PORT}`);
};
const stopBroker = async (): Promise<void> => {
  if (!srv) return;
  // The wrapper's pid is not necessarily the daemon's — signal the GROUP, then await the exit, or
  // the next spawn races a port still held by a process nobody waited for.
  try { process.kill(-srv.pid!, "SIGKILL"); } catch { try { srv.kill("SIGKILL"); } catch { /* gone */ } }
  await awaitExit(srv);
  srv = undefined;
};

let mgr: CotalEndpoint | undefined, obs: CotalEndpoint | undefined, a: CotalEndpoint | undefined, c: CotalEndpoint | undefined;
try {
  await startBroker(true);

  const mgrId = newIdentity();
  const mgrCreds = await mintCreds(auth, mgrId, "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  mgr = new CotalEndpoint({
    space, servers: SERVERS, creds: mgrCreds,
    card: { id: mgrId.id, name: "mgr", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false,
  });
  await mgr.start();

  // The INDEPENDENT observer. It never publishes presence; everything it reports about the subject
  // came off the broker's presence KV, not from the subject's own in-process state.
  obs = new CotalEndpoint({
    space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "operator"),
    card: { name: "observer", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: true,
  });
  await obs.start();
  const seen = (): { status?: string; activity?: string } | undefined => {
    const row = (obs!.getRoster() as any[]).find((p) => (p.name ?? p.card?.name) === "subject");
    return row ? { status: row.status, activity: row.activity } : undefined;
  };

  const aId = newIdentity();
  const uidA = mintLifecycleUid();
  const aCreds = await provisionAgent(mgr, auth, aId, { subscribe: ["general"], allowSubscribe: ["general"], lifecycleUid: uidA });
  a = new CotalEndpoint({
    space, servers: SERVERS, creds: aCreds,
    card: { id: aId.id, name: "subject", kind: "agent" },
    channels: ["general"], lifecycleUid: uidA, heartbeatMs: 400, ttlMs: 3000,
  });
  a.on("error", () => { /* the arms below break this connection on purpose */ });
  await a.start();
  check("setup: the observer sees the subject online", await until(() => seen()?.status !== undefined && seen()!.status !== "offline"), seen());

  // ══ ARM 2 — a teardown-failed refusal must not claim a retraction it never sent ═══════════════
  console.log("\n=== ARM 2: teardown-failed ===");
  const liveNc = (a as any).nc;
  const realDrain = liveNc.drain.bind(liveNc);
  liveNc.drain = () => Promise.reject(new Error("injected drain failure"));
  const d2 = await a.disconnect("arm2");
  check("D2a it refuses as THAT refusal — teardown-failed, not a generic error",
    d2.outcome === "refused" && (d2 as any).reason === "teardown-failed", d2);
  check("D2b the retraction is reported only if it was SENT (a broker revision came back)",
    d2.outcome === "refused" && /HAS been retracted/.test((d2 as any).detail), d2);
  // The cell that matters, and the one that reddens on the defect: the OBSERVER's view.
  await wait(1200);
  check("D2c the observer does NOT see the subject offline — the announcement really was retracted",
    seen()?.status !== "offline", seen());
  check("D2d and the endpoint is not stranded in a third state (connection still held, not self-disconnected)",
    (a as any).nc !== undefined && a.isSelfDisconnected() === false,
    { hasNc: (a as any).nc !== undefined, self: a.isSelfDisconnected() });

  console.log("\n--- INVERSE CONTROL: with the fault removed, the same call succeeds ---");
  liveNc.drain = realDrain; // restore on the CAPTURED object: under a mutant that drops the handle
  // early, `this.nc` may be gone, and a harness that crashes there hides the cells after it.
  const d2ok = await a.disconnect("arm2-control");
  check("D2e CONTROL: the same disconnect now SUCCEEDS (so D2a's refusal was the fault, not the path)",
    d2ok.outcome === "disconnected", d2ok);
  check("D2f CONTROL: and the observer DOES see offline (so D2c could have failed)",
    await until(() => seen()?.status === "offline"), seen());

  // ══ ARM 1 — a refused connect() must leave nothing live ══════════════════════════════════════
  console.log("\n=== ARM 1: refused connect leaves nothing live ===");
  // The broker's connection counters are GLOBAL. Retire every other endpoint first so that what
  // they report is attributable to the subject and to nothing else — otherwise the manager and the
  // observer reconnecting after the restart below would both raise the cumulative count (making the
  // control pass for the wrong reason) and hold the current count above zero (making D1b fail for
  // the wrong reason). Their work is done: only ARM 2 needed the observer.
  await obs!.stop(); obs = undefined;
  await mgr!.stop(); mgr = undefined;
  await stopBroker();
  await startBroker(false); // same accounts, same port, JetStream OFF — a natural post-dial failure
  const before1 = await varz();
  const r1 = await a.connect();
  check("D1a it refuses as bind-failed — the broker answered, so 'broker-unreachable' would be a lie",
    r1.outcome === "refused" && (r1 as any).reason === "bind-failed", r1);
  const after1 = await varz();
  check("D1-ctl CONTROL: the broker's CUMULATIVE count ROSE — it accepted an authenticated connection, so this is a post-dial failure and not an auth rejection",
    after1.total > before1.total, { before: before1, after: after1 });
  let current1 = (await varz()).current;
  for (let i = 0; i < 30 && current1 !== 0; i++) { await wait(100); current1 = (await varz()).current; }
  check("D1b nothing is left live at the broker after the refusal", current1 === 0, { current: current1 });
  // The in-process half of D1b, and the sharper of the two: the defect kept the connection ON THE
  // ENDPOINT, where disconnect() then refused `not-connected` over a live socket.
  check("D1c the endpoint holds no connection and is still deliberately off, not in a third state",
    (a as any).nc === undefined && a.isSelfDisconnected() === true,
    { hasNc: (a as any).nc !== undefined, self: a.isSelfDisconnected() });

  console.log("\n--- INVERSE CONTROL: with JetStream restored, the SAME call succeeds ---");
  await stopBroker();
  await startBroker(true);
  const r1ok = await a.connect();
  check("D1d CONTROL: connect() through the same path SUCCEEDS (so D1a's refusal was the bind, not the verb)",
    r1ok.outcome === "connected", r1ok);
  check("D1e CONTROL: and the broker now shows a live connection (so D1b could have failed)",
    (await varz()).current > 0, await varz());

  // ══ ARM 3 — credential renewal must not outlive a deliberate disconnect ══════════════════════
  // CORE-LEVEL ONLY. A creds SOURCE is not something the connector can construct, so this proves
  // the endpoint contract and says nothing about what a tool caller can reach.
  console.log("\n=== ARM 3: credential renewal does not outlive a deliberate disconnect (core API only) ===");
  await a!.stop(); a = undefined; // same reason as above: the counters must speak about `c` alone
  const TTL = 4; // renewal arms at 75% ⇒ ~3s
  const cid = newIdentity();
  let mints = 0;
  c = new CotalEndpoint({
    space, servers: SERVERS,
    creds: () => { mints++; return mintCreds(auth, cid, "supervisor", { expiresInSeconds: TTL }); },
    card: { id: cid.id, name: "renewer", kind: "endpoint" },
    consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
  });
  c.on("error", () => { /* renewal failures are reported, not thrown */ });
  await c.start();
  check("setup: the creds-source endpoint fetched once before its first connect", mints === 1, mints);
  const d3 = await c.disconnect("arm3");
  check("D3a it disconnects cleanly", d3.outcome === "disconnected", d3);
  const mintsAtOff = mints;
  const before3 = await varz();
  await wait(TTL * 1000 + 1500); // well past the 75% arm point
  check("D3b the credential source is NOT called while the endpoint is deliberately off",
    mints === mintsAtOff, { at: mintsAtOff, now: mints });
  check("D3c the broker sees NO new connection while it is off — the renewal preflight did not dial",
    (await varz()).total === before3.total, { before: before3.total, after: (await varz()).total });

  console.log("\n--- INVERSE CONTROL: after connect(), renewal really is armed and really does dial ---");
  const before3c = await varz();
  const r3 = await c.connect();
  check("D3d CONTROL: it comes back", r3.outcome === "connected", r3);
  const mintsAtOn = mints;
  check("D3e CONTROL: the timer re-armed — the source is called AGAIN without another connect()",
    await until(() => mints > mintsAtOn, TTL * 1000 + 2000), { atOn: mintsAtOn, now: mints });
  check("D3f CONTROL: and the broker's cumulative count rose (so D3c could have failed)",
    (await varz()).total > before3c.total, { before: before3c.total, after: (await varz()).total });

  console.log(`\nCONNECTION-LIFECYCLE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  for (const ep of [c, a, obs, mgr]) { try { await ep?.stop(); } catch { /* ignore */ } }
  await stopBroker(); // await the exit BEFORE removing the scratch it is running out of
  rmSync(dir, { recursive: true, force: true });
}
