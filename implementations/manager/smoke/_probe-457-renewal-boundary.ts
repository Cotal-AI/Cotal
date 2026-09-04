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
 * Emits `PROBE_CONFIG`, `TIMER_TICK`, `POST_EXPIRY`, and one line `BOUNDARY_RESULT=<verdict>`,
 * exits with a matching rc. Uses only real primitives: a real nats-server, a real signed JWT,
 * a real client connection whose authenticator presents the CURRENT credential on reconnect.
 *
 * Run: pnpm tsx implementations/manager/smoke/_probe-457-renewal-boundary.ts [--control|--mutant]
 */
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import {
  createSpaceAuth, mintCreds, newIdentity, inspectCredHealth, mintLifecycleUid,
} from "@cotal-ai/core";
import { credRenewIntervalMs } from "../src/manager.js";
import { bootBroker } from "./_boot-broker.js";

const TTL_SEC = 20;

async function main(): Promise<void> {
  const control = process.argv.includes("--control");
  const mutant = process.argv.includes("--mutant");
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

main().catch((e) => {
  console.error(`PROBE_FATAL ${(e as Error).message}`);
  process.exit(2);
});
