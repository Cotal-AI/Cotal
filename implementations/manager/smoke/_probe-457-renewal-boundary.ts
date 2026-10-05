/**
 * Boundary probe for Cotal #457.
 *
 * Reproduces the triage seat's compressed-ratio probe on a real broker: TTL 20s (production
 * 86400s / 4320x compression), interval driven by the manager's own scheduler.
 *
 * At the parent commit the manager schedules every TTL/2. On a TTL=20s cred, ticks land at
 * t=10s (`healthy`, no-op) and t=20s (`expired`, session already refused), so no tick ever sees
 * `near-expiry` and renewal never fires while the credential could still be renewed. The
 * connection is refused at expiry: `BOUNDARY_RESULT=FAILED`.
 *
 * At head the manager schedules every TTL/4 via {@link credRenewIntervalMs}. On the same TTL=20s
 * cred, ticks land at t=5s, 10s, 15s, 20s; the t=15s tick sees `near-expiry` and reissues, so the
 * refreshed cred is on disk before the broker kicks the session at t=20s. The connection recovers
 * on its reconnect: `BOUNDARY_RESULT=SURVIVED`.
 *
 * The verdict combines TWO signals to be deterministic under real broker + real reconnect timing:
 *   - `nearExpiryObserved`: some tick's `stateBefore` was `near-expiry`, so a renewal was actually
 *     issued inside `[renewAt, exp)`. This is the direct schedule signal and cannot be flakey.
 *   - `connectionAlive`: the session is not closed and can publish after expiry. This is the
 *     downstream effect the field report described.
 * Both must hold to SURVIVE. The first alone already discriminates the fix from the parent, but
 * gating on the second too keeps this cell honest about the outcome the user sees.
 *
 * Positive control: `--control` invokes the same renewal pass ONCE inside the near-expiry window
 * (at ~t=16s), proving the renewal operation itself works so any failure elsewhere is scheduling.
 * Mutant control: `--mutant` reverts the schedule to the buggy TTL/2 in-probe; the cell asserts
 * this reddens the boundary. The mutant is in-probe so a green cell requires the SHIPPED helper
 * to still be correct AND the mutant path to still fail.
 *
 * `--phase` / `--phase --mutant` / `--phase --mutant-no-push`: the shipped fix does not actually
 * rely on the periodic interval landing inside the window at all -- it arms a ONE-SHOT timeout at
 * `Math.max(1_000, credsRenewalDelayMs(creds))` (the credential's own `renewAt`), independent of
 * whatever interval phase happens to be running. `--phase` proves that: a decoy interval with the
 * PARENT's buggy TTL/2 phase (ticks at TTL/2, TTL -- healthy then expired, exactly like the
 * `--mutant` cell above) is armed alongside the real `renewAt` timeout, and the run still SURVIVES
 * because the timeout renews and pushes regardless of the interval's luck. `--mutant` strips the
 * `renewAt` timeout and keeps only the decoy interval, reproducing the parent bug's phase
 * sensitivity (FAILED: no tick lands in the window). `--mutant-no-push` keeps the `renewAt`
 * timeout's re-mint but skips the `nc.reconnect()` push (step 2's helper): the fresh JWT lands on
 * disk but the live connection still presents the stale one and dies at the old `exp` (FAILED).
 *
 * `--close` / `--close --mutant`: proves the fix's `onServeConnectionClosed` shape (brief step 3)
 * rather than the schedule. Mints a short-TTL (3s) credential with no renewal armed, dials with
 * `maxReconnectAttempts: -1`, and attaches a close handler built the same way the manager's is:
 * bounded over the SHIPPED `STATIC_RECONCILE_RETRY_DELAYS_MS`, the probe's own re-mint, a fresh
 * dial on recovery, the same handler re-attached. Left unrenewed, the credential expires and the
 * broker refuses every reconnect with the SAME auth error until the client gives up and `closed()`
 * resolves -- the "closed connection is a fault" case step 3 recovers from. `--close --mutant`
 * swaps in a log-only handler (the parent's shape): the close fires but nothing re-dials, so the
 * connection stays dead (`CLOSE_RESULT=DEAD`). The non-mutant run also carries the transport
 * control the brief asks for: after recovering, it stops the probe's OWN broker for 2s and
 * restarts it on the same port -- a transport drop, not an auth failure -- and asserts `closed()`
 * does NOT resolve during the gap (unbounded reconnects retry silently under the hood) and the
 * connection publishes again once the broker returns, so the bounded recovery path is never
 * mistaken for what masks a bare network blip.
 *
 * Emits `PROBE_CONFIG`, `TIMER_TICK`, `POST_EXPIRY`, and one line `BOUNDARY_RESULT=<verdict>` (or
 * `CLOSE_RESULT=<verdict>` / `TRANSPORT_DROP_RESULT=<verdict>` for `--close`), exits with a
 * matching rc. Uses only real primitives: a real nats-server, a real signed JWT, a real client
 * connection whose authenticator presents the CURRENT credential on reconnect.
 *
 * Run: pnpm tsx implementations/manager/smoke/_probe-457-renewal-boundary.ts
 *   [--control|--mutant|--phase [--mutant|--mutant-no-push]|--close [--mutant]]
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import {
  createSpaceAuth, mintCreds, newIdentity, inspectCredHealth, mintLifecycleUid,
  credsRenewalDelayMs, serverConfig, isReachable, type SpaceAuth,
} from "@cotal-ai/core";
import { credRenewIntervalMs, STATIC_RECONCILE_RETRY_DELAYS_MS } from "../src/manager.js";
import { bootBroker } from "./_boot-broker.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const TTL_SEC = 20;
const CLOSE_TTL_SEC = 3;

async function runScheduledMode(control: boolean, mutant: boolean): Promise<void> {
  // The manager's own scheduler drives this probe. `--mutant` bypasses it and hardcodes TTL/2 so
  // the cell can prove a red-when-broken chain without touching the file the fix lives in.
  const intervalMs = mutant ? (TTL_SEC / 2) * 1000 : credRenewIntervalMs(TTL_SEC);

  const auth = await createSpaceAuth("prb457");
  const broker = await bootBroker(auth);
  const identity = newIdentity();
  const lifecycleUid = mintLifecycleUid();

  const mint = () => mintCreds(auth, identity, "agent", {
    allowSubscribe: ["prb457"],
    allowPublish: ["prb457"],
    lifecycleUid,
    expiresInSeconds: TTL_SEC,
  });

  // Cred state: one shared object so the connection authenticator always presents the CURRENT
  // credential on (re)connect, mirroring the manager's serve authenticator shape.
  const state: { creds: string } = { creds: await mint() };

  const enc = new TextEncoder();
  const nc: NatsConnection = await connect({
    servers: broker.servers,
    authenticator: (nonce?: string) => credsAuthenticator(enc.encode(state.creds))(nonce),
    maxReconnectAttempts: -1, reconnectTimeWait: 200, waitOnFirstConnect: true,
  });

  const status = { closed: false, error: undefined as string | undefined };
  void (async () => {
    for await (const s of nc.status()) {
      if (s.type === "disconnect" || s.type === "error") status.error = String((s as { data?: unknown }).data ?? s.type);
    }
  })();
  nc.closed().then((err) => { status.closed = true; if (err) status.error = err.message; }).catch(() => {});

  let nearExpiryObserved = false;
  const renew = async () => {
    const health = inspectCredHealth(state.creds);
    if (health.state === "healthy") return { changed: false, health };
    if (health.state === "near-expiry") nearExpiryObserved = true;
    state.creds = await mint();
    return { changed: true, health };
  };

  console.log(`PROBE_CONFIG {"ttlSeconds":${TTL_SEC},"intervalMs":${intervalMs},"mode":"${control ? "control" : mutant ? "mutant" : "scheduled"}"}`);

  const start = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  if (!control) {
    timer = setInterval(async () => {
      try {
        const r = await renew();
        const t = Math.floor((Date.now() - start) / 1000);
        console.log(`TIMER_TICK {"t":${t},"changed":${r.changed},"stateBefore":"${r.health.state}"}`);
      } catch (e) {
        console.log(`TIMER_TICK_ERR {"error":${JSON.stringify((e as Error).message)}}`);
      }
    }, intervalMs);
    timer.unref?.();
  } else {
    // Positive control: at t ~= 16s (inside near-expiry, before expired), invoke the SAME
    // renewal pass exactly once. Success proves the operation, so any failure elsewhere is scheduling.
    setTimeout(async () => {
      const r = await renew();
      const t = Math.floor((Date.now() - start) / 1000);
      console.log(`CONTROL_RENEW {"t":${t},"changed":${r.changed},"stateBefore":"${r.health.state}"}`);
    }, 16_000).unref?.();
  }

  // Sample connection status just after nominal expiry.
  await new Promise((r) => setTimeout(r, 24_000));

  // A publish reveals whether the connection actually still carries a valid session.
  let publishOk = true;
  let publishErr: string | undefined;
  try {
    nc.publish("prb457.ping", new Uint8Array());
    await nc.flush();
  } catch (e) {
    publishOk = false;
    publishErr = (e as Error).message;
  }

  const post = { closed: status.closed, error: status.error, publishOk, publishErr, nearExpiryObserved };
  console.log(`POST_EXPIRY ${JSON.stringify(post)}`);

  // The verdict: a renewal must have fired inside `[renewAt, exp)` AND the connection must have
  // survived past expiry. Both signals are needed to distinguish scheduling from reconnect luck.
  const connectionAlive = !status.closed && publishOk;
  const survived = nearExpiryObserved && connectionAlive;
  console.log(`BOUNDARY_RESULT=${survived ? "SURVIVED" : "FAILED"}`);

  if (timer) clearInterval(timer);
  try { await nc.drain(); } catch { /* connection may be dead */ }
  try { nc.close(); } catch { /* already closed */ }
  await broker.stop();
  process.exit(survived ? 0 : 3);
}

async function runPhaseMode(mutant: boolean, mutantNoPush: boolean): Promise<void> {
  const auth = await createSpaceAuth("prb457");
  const broker = await bootBroker(auth);
  const identity = newIdentity();
  const lifecycleUid = mintLifecycleUid();

  const mint = () => mintCreds(auth, identity, "agent", {
    allowSubscribe: ["prb457"],
    allowPublish: ["prb457"],
    lifecycleUid,
    expiresInSeconds: TTL_SEC,
  });

  // Two credential trackers, mirroring the manager's real distinction between "reminted" and
  // "presented on the wire": `diskState.creds` is what `mint()` produces (the manager's on-disk
  // .creds file); `authState.creds` is what the authenticator actually reads live -- what step
  // 2's `nc.reconnect()` push is FOR. In the non-mutant and interval-only-mutant paths both stay
  // in lockstep (the authenticator always presents the current disk credential, matching the
  // shipped shape). `--mutant-no-push` is the ONE path that lets them diverge: it re-mints
  // (updates disk) but skips the push, so the authenticator keeps presenting the stale value it
  // already had -- reproducing "the JWT on disk is fresh while the connection dies at the old
  // exp": the broker's own kick at the old `exp` triggers an automatic reconnect, but since the
  // authenticator still offers the SAME stale JWT it was kicked for, the broker refuses it AGAIN
  // with the identical `User Authentication Expired` error; two consecutive identical auth
  // failures trip the client's own `abortReconnect` guard (nats-core `handleAuthError`), so the
  // connection dies permanently rather than self-healing.
  const diskState: { creds: string } = { creds: await mint() };
  const authState: { creds: string } = { creds: diskState.creds };
  const enc = new TextEncoder();
  const nc: NatsConnection = await connect({
    servers: broker.servers,
    authenticator: (nonce?: string) => credsAuthenticator(enc.encode(authState.creds))(nonce),
    maxReconnectAttempts: -1, reconnectTimeWait: 200, waitOnFirstConnect: true,
  });

  const status = { closed: false, error: undefined as string | undefined };
  nc.closed().then((err) => { status.closed = true; if (err) status.error = err.message; }).catch(() => {});

  const start = Date.now();
  let nearExpiryObserved = false;

  console.log(`PROBE_CONFIG {"ttlSeconds":${TTL_SEC},"mode":"phase","mutant":${mutant},"mutantNoPush":${mutantNoPush}}`);

  // Decoy interval: the SAME shape as the parent's buggy TTL/2 schedule (ticks at TTL/2, TTL).
  // Kept running in every phase variant to prove the shipped `renewAt` timeout (below) does not
  // depend on this interval's phase at all.
  const decoyIntervalMs = (TTL_SEC / 2) * 1000;
  const decoyTimer = setInterval(() => {
    const health = inspectCredHealth(diskState.creds);
    const t = Math.floor((Date.now() - start) / 1000);
    console.log(`TIMER_TICK {"t":${t},"stateBefore":"${health.state}"}`);
    if (health.state === "near-expiry") nearExpiryObserved = true;
  }, decoyIntervalMs);
  decoyTimer.unref?.();

  // The shipped renewAt timeout: one-shot at `Math.max(1_000, credsRenewalDelayMs(creds))` from
  // the current credential, independent of the decoy interval's phase. `--mutant` omits it.
  let renewAtTimer: ReturnType<typeof setTimeout> | undefined;
  if (!mutant) {
    const delay = Math.max(1_000, credsRenewalDelayMs(diskState.creds));
    renewAtTimer = setTimeout(async () => {
      const health = inspectCredHealth(diskState.creds);
      const t = Math.floor((Date.now() - start) / 1000);
      if (health.state === "near-expiry") nearExpiryObserved = true;
      diskState.creds = await mint();
      console.log(`RENEW_AT_TICK {"t":${t},"stateBefore":"${health.state}"}`);
      // The push IS setting `authState.creds` before the reconnect call, mirroring step 2's
      // `s.creds = fresh; await s.nc.reconnect()` -- the authenticator reads `authState.creds`
      // live, so this is the only place the fresh credential ever reaches the wire.
      if (!mutantNoPush) {
        authState.creds = diskState.creds;
        await nc.reconnect().catch(() => {});
      }
    }, delay);
    renewAtTimer.unref?.();
  }

  await new Promise((r) => setTimeout(r, TTL_SEC * 1000 + 4_000));

  let publishOk = true;
  let publishErr: string | undefined;
  try {
    nc.publish("prb457.ping", new Uint8Array());
    await nc.flush();
  } catch (e) {
    publishOk = false;
    publishErr = (e as Error).message;
  }

  const post = { closed: status.closed, error: status.error, publishOk, publishErr, nearExpiryObserved };
  console.log(`POST_EXPIRY ${JSON.stringify(post)}`);

  const connectionAlive = !status.closed && publishOk;
  const survived = nearExpiryObserved && connectionAlive;
  console.log(`BOUNDARY_RESULT=${survived ? "SURVIVED" : "FAILED"}`);

  clearInterval(decoyTimer);
  if (renewAtTimer) clearTimeout(renewAtTimer);
  try { await nc.drain(); } catch { /* connection may be dead */ }
  try { nc.close(); } catch { /* already closed */ }
  await broker.stop();
  process.exit(survived ? 0 : 3);
}

/** Start a nats-server for `auth` on a SPECIFIC (already-bound) port, mirroring `bootBroker`'s
 *  boot loop minus the free-port pick -- the `--close` transport control needs the SAME address
 *  back after a deliberate stop, not a fresh broker on a new port. */
async function startServerOnPort(auth: SpaceAuth, port: number): Promise<{ proc: ChildProcess; dir: string; release: () => void }> {
  const dir = mkdtempSync(pathJoin(tmpdir(), SMOKE_BROKER_TOKEN));
  const conf = serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: pathJoin(dir, "js") });
  writeFileSync(pathJoin(dir, "server.conf"), conf);
  const proc = spawnProc("nats-server", ["-c", pathJoin(dir, "server.conf")], { stdio: "ignore" });
  const release = teardownOnSignal(proc, dir);
  for (let i = 0; i < 25; i++) {
    if (proc.exitCode !== null) break;
    if (await isReachable(`nats://127.0.0.1:${port}`)) return { proc, dir, release };
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  release();
  throw new Error(`startServerOnPort: nats-server did not come up on ${port}`);
}

async function runCloseMode(mutant: boolean): Promise<void> {
  const auth = await createSpaceAuth("prb457");
  const broker = await bootBroker(auth);
  const identity = newIdentity();
  const lifecycleUid = mintLifecycleUid();
  const enc = new TextEncoder();

  const mint = () => mintCreds(auth, identity, "agent", {
    allowSubscribe: ["prb457"],
    allowPublish: ["prb457"],
    lifecycleUid,
    expiresInSeconds: CLOSE_TTL_SEC,
  });
  const state: { creds: string } = { creds: await mint() };

  console.log(`PROBE_CONFIG {"ttlSeconds":${CLOSE_TTL_SEC},"mode":"close","mutant":${mutant}}`);

  let nc: NatsConnection = await connect({
    servers: broker.servers,
    authenticator: (nonce?: string) => credsAuthenticator(enc.encode(state.creds))(nonce),
    maxReconnectAttempts: -1, reconnectTimeWait: 200, waitOnFirstConnect: true,
  });

  let recovered = false;
  let dead = false;
  // Set right before the transport-drop section starts: the manual close handler below must NOT
  // treat the broker.stop() in that section as another auth-expiry close and race it with its own
  // bounded redial -- the whole point of that section is to prove `closed()` stays UNRESOLVED
  // under a transport drop, which the client's own unbounded reconnect (maxReconnectAttempts: -1)
  // handles with no help from this handler.
  let stopReacting = false;

  // Built the way step 3's `onServeConnectionClosed` is: bounded over the SHIPPED
  // `STATIC_RECONCILE_RETRY_DELAYS_MS`, the probe's own re-mint, a fresh dial, the same handler
  // re-attached on success. `--mutant` swaps in the parent's log-only shape.
  const attachClose = (conn: NatsConnection): void => {
    conn.closed().then(async (err) => {
      if (stopReacting) return;
      console.log(`CLOSE_EVENT {"error":${JSON.stringify(err?.message ?? null)}}`);
      if (mutant) { dead = true; return; }
      for (const delayMs of STATIC_RECONCILE_RETRY_DELAYS_MS) {
        await new Promise((r) => setTimeout(r, delayMs));
        // The shipped manager re-mints its recovery credential with the standing TTL, not the
        // probe's short CLOSE_TTL_SEC: a recovery mint at CLOSE_TTL_SEC would expire again three
        // seconds later and the run would never settle. Mirror the transport section's long-lived
        // mint below (`expiresInSeconds: 300`).
        if (inspectCredHealth(state.creds).state !== "healthy") {
          state.creds = await mintCreds(auth, identity, "agent", {
            allowSubscribe: ["prb457"],
            allowPublish: ["prb457"],
            lifecycleUid,
            expiresInSeconds: 300,
          });
        }
        try {
          const fresh = await connect({
            servers: broker.servers,
            authenticator: (nonce?: string) => credsAuthenticator(enc.encode(state.creds))(nonce),
            maxReconnectAttempts: -1, reconnectTimeWait: 200, waitOnFirstConnect: true,
          });
          nc = fresh;
          attachClose(fresh);
          recovered = true;
          console.log("CLOSE_REDIALED");
          return;
        } catch (e) {
          console.log(`CLOSE_REDIAL_ATTEMPT_FAILED {"error":${JSON.stringify((e as Error).message)}}`);
        }
      }
      dead = true;
    }).catch(() => {});
  };
  attachClose(nc);

  // Left unrenewed: the credential expires, the broker refuses every reconnect with the same
  // auth error, and the client gives up -- `closed()` resolves. Wait past that plus the full
  // bounded-recovery window (1s + 5s + 30s = 36s) for the non-mutant handler to finish.
  await new Promise((r) => setTimeout(r, CLOSE_TTL_SEC * 1000 + 40_000));

  let publishOk = true;
  try {
    nc.publish("prb457.ping", new Uint8Array());
    await nc.flush();
  } catch { publishOk = false; }

  console.log(`CLOSE_POST {"recovered":${recovered},"dead":${dead},"publishOk":${publishOk}}`);
  const closeSurvived = recovered && publishOk;
  console.log(`CLOSE_RESULT=${closeSurvived ? "RECOVERED" : "DEAD"}`);

  // Transport control, non-mutant only: stop the probe's OWN broker for 2s and restart it on the
  // SAME port -- a transport drop, not an auth failure. `closed()` must NOT resolve during the
  // gap (unbounded reconnects retry silently) and the connection must publish again once the
  // broker returns, so the auth-expiry recovery above is never confused with riding out a blip.
  // Stabilize on a long-TTL credential first: the recovered connection above is still on a
  // `CLOSE_TTL_SEC`-lived credential that would otherwise keep re-expiring DURING this section and
  // reintroduce the auth-close race this control is meant to rule out. `stopReacting` disarms the
  // manual close handler before the push so it does not treat this reconnect as another
  // auth-expiry close.
  let transportSurvived = false;
  if (!mutant && closeSurvived) {
    stopReacting = true;
    state.creds = await mintCreds(auth, identity, "agent", {
      allowSubscribe: ["prb457"],
      allowPublish: ["prb457"],
      lifecycleUid,
      expiresInSeconds: 300,
    });
    await nc.reconnect().catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    const portMatch = /:(\d+)$/.exec(broker.servers);
    const port = portMatch ? Number(portMatch[1]) : undefined;
    if (port !== undefined) {
      let transportClosed = false;
      nc.closed().then(() => { transportClosed = true; }).catch(() => {});
      await broker.stop();
      await new Promise((r) => setTimeout(r, 2_000));
      const restarted = await startServerOnPort(auth, port);
      await new Promise((r) => setTimeout(r, 1_000));
      let transportPublishOk = true;
      try {
        nc.publish("prb457.ping", new Uint8Array());
        await nc.flush();
      } catch { transportPublishOk = false; }
      transportSurvived = !transportClosed && transportPublishOk;
      console.log(`TRANSPORT_DROP_DEBUG {"transportClosed":${transportClosed},"transportPublishOk":${transportPublishOk}}`);
      console.log(`TRANSPORT_DROP_RESULT=${transportSurvived ? "SURVIVED" : "FAILED"}`);
      restarted.proc.kill("SIGTERM");
      restarted.release();
      rmSync(restarted.dir, { recursive: true, force: true });
    }
  }

  try { await nc.drain(); } catch { /* connection may be dead */ }
  try { nc.close(); } catch { /* already closed */ }
  try { await broker.stop(); } catch { /* already stopped by the transport control above */ }

  // Mirror the scheduled and phase modes: exit 3 whenever the verdict is the failing one,
  // mutant or not. The mutant's failing verdict is closeSurvived === false (DEAD).
  const overallOk = closeSurvived && (mutant || transportSurvived);
  process.exit(overallOk ? 0 : 3);
}

async function main(): Promise<void> {
  const argv = process.argv;
  const control = argv.includes("--control");
  const phase = argv.includes("--phase");
  const close = argv.includes("--close");
  const mutant = argv.includes("--mutant");
  const mutantNoPush = argv.includes("--mutant-no-push");

  if (phase) { await runPhaseMode(mutant, mutantNoPush); return; }
  if (close) { await runCloseMode(mutant); return; }
  await runScheduledMode(control, mutant);
}

main().catch((e) => {
  console.error(`PROBE_FATAL ${(e as Error).message}`);
  process.exit(2);
});
