/**
 * M11: does `MeshAgent`'s connect-retry loop orphan an authenticated connection per attempt?
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT THE CORE SUITE. `packages/core/smoke/connection-lifecycle`
 * ARM 4 proves the FIX — that a failed `CotalEndpoint.start()` closes the half-bound connection it
 * opened. It cannot prove the REACH: core may not import the connector, so ARM 4 *reproduces*
 * `MeshAgent.connectLoop` (`await this.ep.start()` on the same object, forever, on every failure —
 * `extensions/connector-core/src/agent.ts:246-263`) rather than driving it. **A test that builds its
 * own inputs proves the code is depended on, not that a real entry point reaches it.** This probe
 * drives the real one: `MeshAgent.start()`, the fire-and-forget call every connector makes.
 *
 * THE REPORTED DEFECT (mc-rev-refusal supplement, finding 2, at `66bb07d1`): each retry overwrote
 * `this.nc` with a new handle, and `stop()` can only drain the handle it can still see, so every
 * prior attempt's authenticated socket was orphaned. Measured by that seat at the broker as
 * 1 -> 4 current connections over three failed starts, with 2 still live after both endpoints were
 * stopped. A permanent permission mismatch therefore grew live authenticated sockets without bound.
 *
 * WHAT IS ASSERTED IS THE POSITIVE, and that choice is the whole probe. "the agent never connected"
 * is true in the leaking state and in the fixed state alike, so it discriminates nothing. What
 * separates them is whether the broker's CURRENT connection count stays at baseline while the loop
 * spins — read AT THE BROKER, over its monitoring port. The agent is the thing that lost the
 * handles; asking it what it holds is asking the defect to report itself.
 *
 * REFUTATION CONDITIONS, stated before any result below is cited:
 *   - M11a is REFUTED if current connections exceeds baseline+1 at any sample while the loop spins.
 *     (baseline+1 rather than baseline: one attempt may legitimately be IN FLIGHT at a sample, and
 *     a connection that is in flight is not an orphaned one. The leak the seat measured is
 *     unbounded, so it is not hidden by that tolerance — three attempts reached 4.)
 *   - M11a IS NOT EVIDENCE unless M11-ctl shows the CUMULATIVE count rose by at least one per
 *     attempt: if the broker never accepted these connections, "never above baseline" is a fact
 *     about a broker that counted nothing, and would be true of any code at all.
 *   - M11b (nothing survives stop()) is REFUTED if current connections stays above baseline after
 *     `agent.stop()` has returned and the broker has had time to notice.
 *   - The whole probe is VOID if the agent CONNECTS: it would then be measuring the happy path.
 *
 * HOW THE FAILURE IS PRODUCED: the broker is restarted with `jetstream { ... }` removed — same
 * accounts, same port, same credential. The socket and the credential are accepted exactly as
 * before and ONLY the bind fails. No injection, no fault-plumbing, no monkey-patch: the state is
 * the one a real deployment reaches when an agent is pointed at a broker whose JetStream is off.
 *
 * SAFETY: ephemeral loopback broker from a scratch dir, asserted not to be the live host as the
 * FIRST action; inherited COTAL_* deleted; the broker's process GROUP is signalled (the wrapper pid
 * is not the daemon's) and its exit awaited before the scratch dir is removed.
 *
 * Run: node_modules/.bin/tsx .meshctl-measurement/meshctl-m11-startleak.mts
 * Needs `nats-server` on PATH. Local-only, loopback-only.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import {
  CotalEndpoint, isReachable, createSpaceAuth, mintCreds, provisionAgent, mintLifecycleUid,
  serverConfig, newIdentity, setupSpaceStreams,
} from "../packages/core/dist/index.js";
import { MeshAgent } from "../extensions/connector-core/src/agent.js";
import { pickFreePort } from "../packages/core/smoke/_free-port.js";

// ---- FIRST ACTION: never the live broker, and never anything inherited -------------------------
for (const k of Object.keys(process.env)) if (/^COTAL_(SERVERS|CREDS|SPACE|NAME|ID|CONTROL_|LIFECYCLE|CAPABILITIES)/.test(k)) delete process.env[k];
const PORT = await pickFreePort();
const MON = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const LIVE = "broker.cotal.ai";
if (SERVERS.includes(LIVE)) throw new Error(`REFUSING: ${SERVERS} is the live broker`);
if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(SERVERS)) throw new Error(`REFUSING: ${SERVERS} is not loopback`);
console.log(`[safety] dialling ${SERVERS} (monitor 127.0.0.1:${MON}) — asserted not ${LIVE}, loopback only; inherited COTAL_* deleted`);

let pass = 0, fail = 0, voided = 0;
let contaminated = false;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (contaminated) { voided++; console.log(`  ⊘ VOID (fixture contaminated upstream — observed, not evidence): ${name}`, extra ?? ""); return; }
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const precondition = (name: string, cond: boolean, extra?: unknown) => {
  if (contaminated) { voided++; console.log(`  ⊘ VOID (already contaminated — observed, not evidence): ${name}`, extra ?? ""); return; }
  if (cond) { pass++; console.log(`  ✓ PRE: ${name}`); }
  else { fail++; contaminated = true; console.log(`  ✗ FAIL PRE: ${name}`, extra ?? ""); }
};

/** Broker-side truth. `total_connections` is CUMULATIVE (it witnesses a connection that has since
 *  closed); `connections` is CURRENT. The pair is what separates "never opened one" from "opened
 *  one and left it open" — either alone would be ambiguous here. */
const varz = async (): Promise<{ total: number; current: number }> => {
  const r = await fetch(`http://127.0.0.1:${MON}/varz`);
  const j = (await r.json()) as { total_connections: number; connections: number };
  return { total: j.total_connections, current: j.connections };
};

const space = `m11-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "meshctl-m11-"));
const baseConf = serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") });
/** Same accounts, same port, with or without JetStream, plus a monitoring port. */
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
  // The wrapper's pid is not necessarily the daemon's — signal the GROUP, then await the exit.
  try { process.kill(-srv.pid!, "SIGKILL"); } catch { try { srv.kill("SIGKILL"); } catch { /* gone */ } }
  await new Promise<void>((r) => { srv!.once("exit", () => r()); srv!.once("error", () => r()); });
  srv = undefined;
};

let mgr: CotalEndpoint | undefined;
let agent: MeshAgent | undefined;
try {
  // Provision while JetStream is ON — the credential must be a REAL one, or a failure to connect
  // would be explained by the credential rather than by the bind.
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
  const subId = newIdentity();
  const uid = mintLifecycleUid();
  // `role` is load-bearing and is NOT decoration: without it no TASK queue is provisioned and the
  // endpoint spins on a permissions violation that has nothing to do with what this probe measures.
  // That is the exact fixture bug that cost the m7 probe a whole window, and it would be invisible
  // here — a leak measured against a connect that was failing for the wrong reason still "passes".
  const subCreds = await provisionAgent(mgr, auth, subId, {
    subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"],
    lifecycleUid: uid, role: "worker",
  });

  // CONTROL FIRST, and it is not optional: the same agent, same credential, same broker, must
  // CONNECT while JetStream is on. Without it, "it never connected" below is equally explained by a
  // credential that could never have worked, and the probe would be comparing two broken states.
  console.log("\n=== CONTROL: the same agent connects while JetStream is ON ===");
  const cfg: any = {
    space, name: "m11-subject", role: "worker", kind: "agent", servers: SERVERS,
    subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"], tls: false,
    id: subId.id, creds: subCreds, lifecycleUid: uid,
  };
  const okAgent = new MeshAgent({ ...cfg, name: "m11-control" });
  okAgent.start(300);
  for (let i = 0; i < 80 && !okAgent.connected; i++) await wait(150);
  precondition("CONTROL: the agent CONNECTS with this credential against this broker (so a failure below is the bind, not the fixture)",
    okAgent.connected === true, { connected: okAgent.connected });
  await okAgent.stop();
  let settle = (await varz()).current;
  for (let i = 0; i < 40 && settle > 1; i++) { await wait(100); settle = (await varz()).current; }

  // ---- the arm: JetStream off, same credential, the retry loop spins --------------------------
  console.log("\n=== ARM: JetStream OFF — the retry loop spins on a post-dial failure ===");
  await mgr.stop(); mgr = undefined;
  await stopBroker();
  await startBroker(false);
  let base = (await varz()).current;
  for (let i = 0; i < 40 && base !== 0; i++) { await wait(100); base = (await varz()).current; }
  precondition("nothing is live at the broker before the loop starts, so every count below is about this agent alone",
    base === 0, { current: base });
  const before = await varz();

  // The SAME identity, credential and lifecycle uid the control just connected with — the control
  // has stopped, so there is no second live incarnation. Anything else (a fresh identity, a fresh
  // uid) would fail at the HANDSHAKE, never reach a post-dial failure, and leave the probe
  // measuring an auth rejection while claiming to measure a leaked bind.
  agent = new MeshAgent({ ...cfg });
  const RETRY_MS = 300;
  const ATTEMPTS = 4;
  agent.start(RETRY_MS);
  // Sample the CURRENT count throughout the window rather than only at the end: a leak that is
  // later swept by something else would be invisible to a single closing read, and the peak is the
  // number the defect actually produces.
  let peak = 0;
  const deadline = Date.now() + RETRY_MS * (ATTEMPTS + 1) + 4000;
  while (Date.now() < deadline) {
    peak = Math.max(peak, (await varz()).current);
    await wait(120);
  }
  const during = await varz();
  precondition("the agent never connected (if it had, this probe would be measuring the happy path)",
    agent.connected === false, { connected: agent.connected });
  check(`M11-ctl CONTROL: the broker's CUMULATIVE count rose by at least ${ATTEMPTS} — it ACCEPTED an authenticated connection on each attempt, so these are post-dial failures and M11a could have failed`,
    during.total - before.total >= ATTEMPTS, { before: before.total, after: during.total });
  check("M11a THE POSITIVE: the broker's CURRENT connections never rose more than one above baseline while the loop spun — no attempt orphaned its socket",
    peak <= base + 1, { baseline: base, peak, accepted: during.total - before.total });

  await agent.stop();
  let after = (await varz()).current;
  for (let i = 0; i < 40 && after !== base; i++) { await wait(100); after = (await varz()).current; }
  check("M11b and nothing survives stop() — the count is back to baseline",
    after === base, { baseline: base, current: after });
  agent = undefined;

  const voidNote = voided ? `, ${voided} VOID` : "";
  console.log(`\nM11 ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed${voidNote})`);
  if (voided) console.log(`  ⊘ ${voided} cell(s) were NOT EVALUATED: a precondition failed, so their colour would not have been evidence.`);
  if (fail) process.exitCode = 1;
} catch (e) {
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  try { await agent?.stop(); } catch { /* ignore */ }
  try { await mgr?.stop(); } catch { /* ignore */ }
  await stopBroker(); // await the exit BEFORE removing the scratch it is running out of
  rmSync(dir, { recursive: true, force: true });
  // The connector's agent holds timers that would otherwise keep the process alive past the
  // summary, turning a finished run into a hang somebody has to interpret.
  process.exit(process.exitCode ?? 0);
}
