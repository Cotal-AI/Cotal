/**
 * delivery-health LIVE smoke — the residue a dead daemon leaves behind.
 *
 * The assessment suite (`smoke:delivery-health`) proves the verdict logic against constructed
 * states. This one proves the PREMISE against a real daemon: that the lease record outlives the
 * process that wrote it and keeps claiming `ready:true`, so any surface that trusts the lease
 * reports healthy delivery while delivery is gone.
 *
 * The residue cannot be faked into existence. A lease written by hand is a fixture; a lease left
 * behind by a real daemon that a real SIGKILL removed is the state the incident actually produced,
 * and it only exists because an earlier process built it. That is why this runs a real
 * `cotal deliver` against a real (ephemeral) broker rather than seeding a KV.
 *
 * Cells:
 *   - control      : a live daemon — the lease is ready AND a round-trip completes
 *   - daemon-gone  : SIGKILL (no lease release runs) — the lease STILL reads ready:true with a
 *                    heartbeat inside the TTL, while no process exists. THE FALSE GREEN.
 *   - daemon-wedged: SIGSTOP inside the TTL window — the pid EXISTS, the lease STILL reads ready,
 *                    and no round-trip completes. The three facts disagree, and that gap is the
 *                    whole discriminator. Inverse control: SIGCONT restores it.
 *
 * Run: pnpm smoke:delivery-health-live   (needs `nats-server` on PATH; local ephemeral broker only)
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint, createSpaceAuth, idFromCreds, isReachable, mintCreds, newIdentity, serverConfig,
  setupSpaceStreams, assessDeliveryHealth, LEASE_TTL_MS, type DeliveryHealth,
} from "@cotal-ai/core";
import { pickFreePort } from "./_free-port.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;

// ---- FIRST ACTION, before anything is started or connected: this is not the live host ----------
const LIVE = "broker.cotal.ai";
if (SERVERS.includes(LIVE)) {
  console.error(`✗ REFUSING TO RUN: broker URL ${SERVERS} names the live host ${LIVE}`);
  process.exit(1);
}
if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(SERVERS)) {
  console.error(`✗ REFUSING TO RUN: broker URL ${SERVERS} is not a loopback ephemeral broker`);
  process.exit(1);
}
console.log(`\ndelivery-health live — ephemeral broker ${SERVERS} (asserted not ${LIVE})\n`);

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const space = `health-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-health-"));
const credsPath = join(dir, "delivery.creds");

/** pids RECORDED AT CREATION — only these are ever signalled, and only by exact pid. */
const created: { srv?: number; daemon?: number } = {};
let srv: ChildProcess | undefined;
let daemon: ChildProcess | undefined;
let daemonExited = false;
let observer: CotalEndpoint | undefined;

/** Await a child's real exit before its scratch is removed — never rm out from under a live process. */
const awaitExit = (c: ChildProcess | undefined): Promise<void> =>
  !c || c.exitCode !== null || c.signalCode !== null
    ? Promise.resolve()
    : new Promise((r) => { c.once("exit", () => r()); setTimeout(() => r(), 5000); });

/** Is the process GROUP recorded at creation still alive? `kill -0` — existence, nothing more.
 *  Deliberately the WEAK signal, so the wedged cell can show it passing while delivery is dead.
 *
 *  The group, not the pid, and this was a real defect here. `pnpm cotal deliver` is a THREE-process
 *  tree (pnpm -> tsx -> node); `spawn` returns the pnpm wrapper's pid, so signalling that pid alone
 *  left the actual daemon orphaned and still serving while this harness cheerfully asserted it was
 *  "really gone". A pid that answers "gone" while the work continues is the same disease this whole
 *  suite exists to catch, so the harness must not commit it either. `detached: true` makes the
 *  recorded pid a group leader; negative pid signals the group. */
const groupAlive = (pid?: number): boolean => {
  if (!pid) return false;
  try { process.kill(-pid, 0); return true; } catch { return false; }
};
const signalGroup = (pid: number | undefined, sig: NodeJS.Signals): void => {
  if (!pid) return;
  try { process.kill(-pid, sig); } catch { /* already gone */ }
};

const startDaemon = (): ChildProcess => {
  const c = spawn("pnpm", ["cotal", "deliver", "--space", space, "--server", SERVERS, "--creds", credsPath], {
    cwd: repoRoot, stdio: "ignore", detached: true,
    env: { ...process.env, COTAL_DELIVERY_BROKER_GONE_MS: "600000" },
  });
  created.daemon = c.pid;
  daemonExited = false;
  c.on("exit", () => { daemonExited = true; });
  return c;
};

/** Wait for the daemon's lease to read ready, or give up. Uses the REAL public read. */
const waitReady = async (ep: CotalEndpoint, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if ((await ep.readDeliveryLease(0))?.ready === true) return true; } catch { /* not yet */ }
    await wait(250);
  }
  return false;
};

try {
  writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], {
    transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js"),
  }));
  srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  created.srv = srv.pid;

  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`ephemeral nats-server did not come up on ${PORT}`);

  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provisioner });
  // The observer reads the lease bucket and publishes the ctl.delivery probe, which is the AGENT
  // grant (the lease bucket is read-only for an agent — Component 6 health); a provisioner cred
  // holds neither, and using one gets a broker PermissionViolation on the KV read.
  // The agent grants are lifecycle-keyed exact names (SPEC 13.1), so the cred and the endpoint card
  // must carry the SAME uid or the broker denies the very reads this observer exists to make.
  const OBSERVER_UID = randomUUID().replace(/-/g, ""); // 32 lowercase hex — the [a-z0-9]{26,32} lifecycle token shape
  const agentCreds = await mintCreds(auth, newIdentity(), "agent", { lifecycleUid: OBSERVER_UID });
  writeFileSync(credsPath, await mintCreds(auth, newIdentity(), "delivery"), { mode: 0o600 });

  // The OBSERVER: a separate endpoint that reads the lease exactly as a health surface would.
  observer = new CotalEndpoint({
    space, servers: SERVERS, creds: agentCreds, channels: [], consume: false,
    watchPresence: false, registerPresence: false,
    card: { id: idFromCreds(agentCreds), name: "health-observer", role: "agent", kind: "endpoint", lifecycleUid: OBSERVER_UID },
  });
  await observer.start();

  /** The affirmative probe: a real round-trip to the daemon's own ctl.delivery responder.
   *  Rejects on timeout or no-responder — both are refusals, never inferred health. */
  const probe = async (deadlineMs: number): Promise<void> => {
    await observer!.requestDeliveryHealthProbe(deadlineMs);
  };
  const assess = (deadlineMs = 1500): Promise<DeliveryHealth> =>
    assessDeliveryHealth(0, LEASE_TTL_MS, deadlineMs, {
      readLease: () => observer!.readDeliveryLease(0),
      probe,
      now: () => Date.now(),
    });

  // ---- CONTROL: a live daemon. Also validates the probe itself — if this cell does not go
  // ---- serving, the probe is wrong and every refusal below would be an artefact of that.
  daemon = startDaemon();
  const ready = await waitReady(observer, 30_000);
  check("control: a real daemon comes up and its lease reads ready", ready);
  const live = await assess();
  check("control: with the daemon live, health is SERVING (this validates the probe itself)", live.serving === true);
  check("control: the pid recorded at creation exists", groupAlive(created.daemon));

  // ---- daemon-gone: SIGKILL, so the graceful lease release NEVER runs. The lease left behind is
  // ---- residue written by a process that no longer exists.
  signalGroup(created.daemon, "SIGKILL");
  await awaitExit(daemon);
  check("daemon-gone: the daemon process is really gone", !groupAlive(created.daemon) && daemonExited);

  const leaseAfterKill = await observer.readDeliveryLease(0);
  const ageAfterKill = leaseAfterKill ? Date.now() - leaseAfterKill.since : Infinity;
  // THE FALSE GREEN, measured against a real corpse rather than a fixture.
  check("daemon-gone: THE LEASE STILL READS ready:true THOUGH NO DAEMON EXISTS", leaseAfterKill?.ready === true);
  check("daemon-gone: and its heartbeat is still INSIDE the TTL, so an age check alone would also pass",
    ageAfterKill < LEASE_TTL_MS);
  const gone = await assess();
  check("daemon-gone: the affirmative surface REFUSES", gone.serving === false);
  check("daemon-gone: and it refuses as no-responder specifically",
    !gone.serving && gone.refusal.condition === "no-responder");

  // ---- daemon-wedged: a NEW daemon, then SIGSTOP inside the TTL window. The process exists, the
  // ---- lease is fresh, and nothing answers.
  await wait(Math.min(LEASE_TTL_MS + 2000, 35_000)); // let the corpse's lease expire so a fresh one can bind
  daemon = startDaemon();
  const ready2 = await waitReady(observer, 40_000);
  check("wedged setup: a replacement daemon binds and reads ready", ready2);

  signalGroup(created.daemon, "SIGSTOP");
  await wait(1000); // inside the TTL: the last renew stamp is still fresh
  const leaseWedged = await observer.readDeliveryLease(0);
  const ageWedged = leaseWedged ? Date.now() - leaseWedged.since : Infinity;

  check("WEDGED: the pid EXISTS — a supervisor checking for a process would pass it", groupAlive(created.daemon));
  check("WEDGED: the lease STILL reads ready:true", leaseWedged?.ready === true);
  check("WEDGED: its heartbeat is still inside the TTL", ageWedged < LEASE_TTL_MS);
  const wedged = await assess();
  check("WEDGED: yet the affirmative surface REFUSES — the round-trip is what caught it", wedged.serving === false);
  check("WEDGED: and it refuses as no-responder specifically",
    !wedged.serving && wedged.refusal.condition === "no-responder");

  // INVERSE CONTROL: un-wedge it. If this does not recover, the process died and the cell above
  // proved nothing about wedging.
  signalGroup(created.daemon, "SIGCONT");
  let recovered = false;
  for (let i = 0; i < 20; i++) { if ((await assess()).serving) { recovered = true; break; } await wait(500); }
  check("WEDGED inverse control: SIGCONT restores SERVING — it was stuck, not dead", recovered);

  console.log(`\nDELIVERY-HEALTH-LIVE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  signalGroup(created.daemon, "SIGCONT"); signalGroup(created.daemon, "SIGKILL");
  await awaitExit(daemon);
  try { await observer?.stop(); } catch { /* broker may be gone */ }
  try { if (created.srv) process.kill(created.srv, "SIGKILL"); } catch { /* gone */ }
  await awaitExit(srv);
  // Only now, with both children confirmed exited, is the scratch safe to remove.
  rmSync(dir, { recursive: true, force: true });
}
