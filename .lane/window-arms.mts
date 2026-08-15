/**
 * THE ONE-WINDOW HARNESS — five arms, in the approved order, on ONE ephemeral broker.
 *
 * Predictions are registered in `.lane/window-arms-predictions.md` and `.lane/credclass-predictions.md`
 * and were committed BEFORE this ran. This file must not be edited to agree with a result.
 *
 * ORDER: C1 -> C3 -> C2 -> (kill) -> C4 -> A. C1 is the harness's own known-good control and runs
 * first regardless of which arm is more interesting: if C1 is red, NOTHING else in the window is
 * interpretable and the run is abandoned rather than reported.
 *
 * THE DISCRIMINATOR IS BY CONSTRUCTION: every cred arm records `refusal.condition` ITSELF, never a
 * pass/fail. The whole claim under test is that these conditions are distinguishable, so a cell that
 * asserted only "not serving" would be blind to exactly the conflation being measured.
 *
 * A4 DRIVES THE REAL SHIPPED SURFACE. `MeshAgent.listChannels()` is the public method behind the
 * `cotal_channels` tool; the arm calls it and reads `deliveryHealth` off the row. Recomputing
 * `leaseLive && hasDurableMembership` here instead would measure a COPY of the expression and prove
 * nothing about what agents see.
 *
 * NOT RUN AT WRITE TIME — authored while another lane held the box. Any failure on first execution is
 * a harness fault until proven otherwise, and will be reported as one rather than as a finding.
 *
 * Run: pnpm exec tsx .lane/window-arms.mts
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint, assessDeliveryHealth, type DeliveryHealth, LEASE_TTL_MS,
  serverConfig, setupSpaceStreams, mintCreds, newIdentity, idFromCreds, isReachable,
  createSpaceAuth, instancePinnedInstrumentCapabilities, DEV_OWNER, mintLifecycleUid,
} from "../packages/core/src/index.js";
import { MeshAgent } from "../extensions/connector-core/src/agent.js";
import { pickFreePort } from "../implementations/delivery/smoke/_free-port.js";

// ---------------------------------------------------------------- guards, FIRST
const LIVE = "broker.cotal.ai";
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
if (SERVERS.includes(LIVE)) { console.error(`✗ REFUSING: ${SERVERS} names the live host`); process.exit(1); }
if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(SERVERS)) { console.error(`✗ REFUSING: ${SERVERS} is not a loopback ephemeral broker`); process.exit(1); }

let pass = 0, fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Record the CONDITION, not a verdict — the discriminator by construction. */
const condOf = (h: DeliveryHealth): string => (h.serving ? "SERVING" : h.refusal.condition);

const space = `health-window-${randomUUID().slice(0, 8)}`;
const dir = mkdtempSync(join(tmpdir(), "cotal-window-"));
const credsPath = join(dir, "delivery.creds");
const repoRoot = join(import.meta.dirname, "..");
const created: { srv?: number; daemon?: number } = {};
let srv: ChildProcess | undefined, daemon: ChildProcess | undefined;
let daemonExited = false;
const endpoints: CotalEndpoint[] = [];
let agent: MeshAgent | undefined;

/** Every inherited COTAL_ variable deleted BY PREFIX, never a name list. */
const childEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("COTAL_")) delete env[k];
  env.COTAL_DELIVERY_BROKER_GONE_MS = "600000";
  return env;
};
const groupAlive = (pid?: number): boolean => {
  if (!pid) return false;
  try { process.kill(-pid, 0); return true; } catch { return false; }
};
const awaitExit = (c?: ChildProcess): Promise<"exited" | "TIMED-OUT"> =>
  !c || c.exitCode !== null || c.signalCode !== null
    ? Promise.resolve("exited")
    : new Promise((r) => { c.once("exit", () => r("exited")); setTimeout(() => r("TIMED-OUT"), 8000); });

const auth = await createSpaceAuth(space);
const FIXTURE = join(repoRoot, "implementations/delivery/smoke/_fixture-daemon.mts");

try {
  writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], {
    transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js"),
  }));
  srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  created.srv = srv.pid;
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`ephemeral nats-server did not come up on ${PORT}`);

  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  writeFileSync(credsPath, await mintCreds(auth, newIdentity(), "delivery"), { mode: 0o600 });

  daemon = spawn("pnpm", ["exec", "tsx", FIXTURE, space, SERVERS, credsPath], {
    cwd: repoRoot, stdio: "ignore", detached: true, env: childEnv(),
  });
  created.daemon = daemon.pid;
  daemon.on("exit", () => { daemonExited = true; });

  /** Build an endpoint on a given profile. The cred and the ENDPOINT must carry the SAME lifecycleUid,
   *  and `lifecycleUid` is a SIBLING of `card` in `EndpointOptions` (endpoint.ts:157) — NOT a card
   *  field: `AgentCard` (types.ts:18-45) has no such property. Nesting it inside `card` is an excess
   *  property TypeScript rejects, and it leaves `ownLifecycleUid` UNDEFINED for an authed endpoint
   *  (endpoint.ts:543-548).
   *
   *  What that actually costs, read from the call sites rather than assumed: `start()` THROWS for an
   *  authed endpoint that consumes or registers presence (endpoint.ts:894-895), and a uid-less
   *  endpoint cannot durable-leave (:3066), consume DMs (:3206), read chat history (:3515), or list
   *  its durable memberships (:3119). It does NOT block `plane3Channels` — `durableJoinChannel`
   *  (:3055-3056) sends no uid and the daemon derives identity from the requester's cred — so the
   *  nesting would not by itself have falsified Arm A's `hasDurableMembership`. Stated that way
   *  because the first version of this comment claimed it would, and that was wrong. */
  const endpointFor = async (profile: string, extra: Record<string, unknown> = {}): Promise<CotalEndpoint> => {
    const uid = randomUUID().replace(/-/g, "");
    const creds = await mintCreds(auth, newIdentity(), profile as never, { lifecycleUid: uid, ...extra });
    const ep = new CotalEndpoint({
      space, servers: SERVERS, creds, lifecycleUid: uid, channels: [], consume: false,
      watchPresence: false, registerPresence: false,
      card: { id: idFromCreds(creds), name: `arm-${profile}`, role: "agent", kind: "endpoint" },
    });
    await ep.start();
    endpoints.push(ep);
    return ep;
  };

  const assessVia = (ep: CotalEndpoint, deadlineMs = 1500): Promise<DeliveryHealth> =>
    assessDeliveryHealth(0, LEASE_TTL_MS, deadlineMs, {
      readLease: () => ep.readDeliveryLease(0),
      probe: async (d: number) => { await ep.requestDeliveryHealthProbe(d); },
      now: () => Date.now(),
    });

  // Wait for the daemon to be ready, using an agent-profile reader (the one profile known to work).
  const c1ep = await endpointFor("agent");
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await c1ep.readDeliveryLease(0))?.ready === true) { ready = true; break; } } catch { /* not yet */ }
    await wait(250);
  }
  check("setup: the fixture daemon came up and its lease reads ready", ready);

  console.log("\n--- ARM B: which credential class can ask? (conditions recorded verbatim)\n");

  // ---- C1: the KNOWN-GOOD arm. If this is red the window is uninterpretable.
  const c1 = await assessVia(c1ep);
  console.log(`  C1 agent                        -> ${condOf(c1)}`);
  check("C1: the agent profile establishes SERVING — the harness's known-good control", c1.serving === true);
  if (!c1.serving) {
    console.error("\n  ABANDONING: C1 is the control. With it red, no other arm in this window is interpretable.");
    console.error("  This is a HARNESS fault until proven otherwise, NOT a finding about any credential class.\n");
    throw new Error("C1 control failed");
  }

  // ---- C3: the POSITIVE CONTROL FOR REFUSAL. Makes a universal "refused" readable.
  const c3 = await assessVia(await endpointFor("probe"));
  console.log(`  C3 probe (refusal control)      -> ${condOf(c3)}`);
  check("C3: a connect-only profile does NOT establish serving", c3.serving === false);
  check("C3: and it names a refusal condition rather than reporting an absence", condOf(c3) !== "SERVING");

  // ---- C2: the tempting reuse — what managerHealthRow mints today.
  const c2 = await assessVia(await endpointFor("control-caller-privileged", {
    endpointCapabilities: instancePinnedInstrumentCapabilities("privileged", `inst-${randomUUID().slice(0, 8)}`),
  }));
  console.log(`  C2 control-caller-privileged    -> ${condOf(c2)}`);
  check("C2: the manager row's class does NOT establish serving for delivery", c2.serving === false);
  check("C2: and it refuses as `refused` — a DENIED READ, not `no-responder`", condOf(c2) === "refused");

  console.log("\n--- ARM A setup: a durable membership established while the daemon is ALIVE\n");

  // The MeshAgent is the REAL surface behind cotal_channels. Joined BEFORE the kill on purpose:
  // the residue state only exists for a session that had a membership when the daemon died.
  const chan = `window-${randomUUID().slice(0, 6)}`;
  const auid = randomUUID().replace(/-/g, "");
  const acreds = await mintCreds(auth, newIdentity(), "agent", { lifecycleUid: auid });
  agent = new MeshAgent({
    space, servers: SERVERS, creds: acreds, channels: [chan],
    name: "window-agent", role: "agent", owner: DEV_OWNER, lifecycleUid: auid ?? mintLifecycleUid(),
  } as never);
  await agent.start();
  await wait(1500); // let the boot durable self-join land

  const rowFor = async (c: string) => (await agent!.listChannels()).find((r) => r.channel === c);
  const liveRow = await rowFor(chan);
  check("A1 control: with a LIVE daemon, the shipped surface reports deliveryHealth 'active'",
    liveRow?.deliveryHealth === "active");
  check("A5 inverse control: a channel with NO durable membership does NOT read 'active'",
    (await rowFor(`never-joined-${randomUUID().slice(0, 6)}`))?.deliveryHealth !== "active");

  console.log("\n--- KILL: SIGKILL, so no graceful lease release runs\n");
  if (created.daemon) { try { process.kill(-created.daemon, "SIGKILL"); } catch { /* gone */ } }
  const exitOutcome = await awaitExit(daemon);
  for (let i = 0; i < 400 && groupAlive(created.daemon); i++) await wait(5);
  check("kill: the daemon's exit was OBSERVED, not inferred from a timeout", exitOutcome === "exited");
  check("kill: the whole process GROUP is confirmed absent", !groupAlive(created.daemon));

  // ---- C4: same credential as C1, different world. Must produce a DIFFERENT condition from C2.
  const c4 = await assessVia(c1ep);
  console.log(`  C4 agent vs DEAD daemon         -> ${condOf(c4)}`);
  check("C4: against a dead daemon the same cred refuses as `no-responder`", condOf(c4) === "no-responder");
  check("THE DISCRIMINATOR EXISTS: C2 (denied) and C4 (absent) are DIFFERENT conditions",
    condOf(c2) !== condOf(c4));

  console.log("\n--- ARM A: does the shipped surface still say 'active' over a corpse?\n");
  check("A3: the lease STILL reads ready:true though no daemon exists",
    (await c1ep.readDeliveryLease(0))?.ready === true);
  check("A2: hasDurableMembership is STILL true — nothing clears it when the daemon dies",
    agent.ep.hasDurableMembership(chan) === true);
  const deadRow = await rowFor(chan);
  console.log(`  A4 deliveryHealth over a corpse -> ${String(deadRow?.deliveryHealth)}`);
  check("A4: THE SHIPPED SURFACE STILL REPORTS 'active' FOR A DAEMON THAT DOES NOT EXIST",
    deadRow?.deliveryHealth === "active");
} catch (e) {
  fail++;
  console.error(`\n  ✗ HARNESS ERROR: ${(e as Error).message}`);
} finally {
  for (const ep of endpoints) { try { await ep.stop(); } catch { /* closing */ } }
  try { await agent?.stop(); } catch { /* closing */ }
  if (created.daemon && groupAlive(created.daemon)) { try { process.kill(-created.daemon, "SIGKILL"); } catch { /* gone */ } }
  const dOut = await awaitExit(daemon);
  if (created.srv) { try { process.kill(created.srv, "SIGKILL"); } catch { /* gone */ } }
  const sOut = await awaitExit(srv);

  console.log(`\nWINDOW ARMS: ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exitCode = 1;
  if (pass === 0) { console.error("NOTHING WAS MEASURED — 0 cells. A decline, not a pass."); process.exitCode = 3; }

  // Never delete a scratch out from under a live process: an orphan with an intact scratch is
  // recoverable, one whose scratch was deleted under it is not.
  const why: string[] = [];
  if (dOut === "TIMED-OUT") why.push(`daemon exit not observed (outcome=${dOut})`);
  if (groupAlive(created.daemon)) why.push(`daemon group ${created.daemon} still alive`);
  if (sOut === "TIMED-OUT") why.push(`nats-server exit not observed (outcome=${sOut})`);
  if (why.length === 0) rmSync(dir, { recursive: true, force: true });
  else {
    process.exitCode = 1;
    console.error(`  ✗ TEARDOWN REFUSES to delete ${dir}:`);
    for (const w of why) console.error(`      · ${w}`);
    console.error(`  THE VERDICT ABOVE IS SUPERSEDED — teardown failed, exit code is 1.`);
  }
}
