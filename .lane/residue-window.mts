/**
 * THE RESIDUE WINDOW — for HOW LONG does the shipped surface lie after the daemon dies?
 *
 * Derived from the same setup as the five-arm window; the arms are replaced by sampling.
 *
 * WHY: the corpse arm measured `deliveryHealth: "active"` with the lease heartbeat 311ms old. That
 * is ~1% into `LEASE_TTL_MS = 30_000` (packages/core/src/streams.ts:83 at origin/main), so a reader
 * could fairly object that the arm killed the daemon and read too fast — a guard given no chance to
 * fire rather than a guard that failed. This measures the whole window instead of one point in it.
 *
 * PREDICTION, REGISTERED BEFORE THE RUN: `active` persists for most of the TTL and flips to
 * `degraded` when the lease key expires, because the lease is the ONLY conjunct with an expiry —
 * the membership Map has no `.clear()` and neither `.delete` site is driven by daemon liveness.
 * FALSIFIERS: still `active` past 75s ⇒ the window is UNBOUNDED and the defect is worse than
 * reported; flips almost immediately ⇒ the 311ms reading was a race and the defect is narrower.
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
  createSpaceAuth, instancePinnedInstrumentCapabilities, DEV_OWNER, mintLifecycleUid, provisionAgent,
  seedChannelRegistry,
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
const check = (name: string, cond: boolean, saw?: unknown): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}${saw === undefined ? "" : ` — saw ${JSON.stringify(saw)}`}`); }
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
/** ASYNC denials, captured rather than swallowed. First run of this harness died here: a denied KV
 *  read surfaces on TWO paths — synchronously as the assessed refusal, and asynchronously as an
 *  `'error'` event that kills any consumer with no listener (and, on that run, bypassed teardown and
 *  orphaned a daemon + broker). Recording them is the point, not silencing them. */
const asyncErrors: string[] = [];
// Typed STRUCTURALLY on purpose. `MeshAgent.ep` is a `CotalEndpoint` from core's **dist**, while this
// file imports the one from **src**; they are nominally distinct (private field `servers`), and that
// clash is the load-path split this lane recorded, surfacing as a compiler error. Widening to the
// shape actually used keeps the arm honest without pretending the two declarations are one.
type ErrorEmitter = { on: (event: "error", listener: (e: Error) => void) => unknown };
const watchErrors = (label: string, ep: ErrorEmitter): void => {
  ep.on("error", (e: Error) => asyncErrors.push(`${label}: ${e.message}`));
};

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

// LAST-RESORT REAPER. `finally` does not run when the process dies on an unhandled 'error' event —
// which is exactly how the first run of this harness left a nats-server and a fixture daemon alive
// with their scratch intact. Kills ONLY pids recorded at creation. It deliberately does NOT delete
// the scratch: an orphan with an intact scratch is recoverable, one without is not.
const reap = (why: string): void => {
  console.error(`\n  ✗ FATAL (${why}) — reaping pids recorded at creation`);
  if (created.daemon) { try { process.kill(-created.daemon, "SIGKILL"); } catch { /* gone */ } }
  if (created.srv) { try { process.kill(created.srv, "SIGKILL"); } catch { /* gone */ } }
  console.error(`  scratch left for inspection: ${dir}`);
};
process.once("uncaughtException", (e) => { reap(`uncaughtException: ${e.message}`); process.exit(1); });
process.once("unhandledRejection", (e) => { reap(`unhandledRejection: ${String(e)}`); process.exit(1); });

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
    watchErrors(profile, ep); // BEFORE start(): a denial can arrive during connect
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

  console.log("\n--- ARM A setup: a durable membership established while the daemon is ALIVE\n");

  // The MeshAgent is the REAL surface behind cotal_channels. Joined BEFORE the kill on purpose:
  // the residue state only exists for a session that had a membership when the daemon died.
  // PROVISION THE AGENT THE WAY A MANAGER DOES. Run 1 of this window minted agent creds directly and
  // the connector logged `mesh unreachable (consumer not found)`: an agent's Plane-3 footprint
  // (dm_/dlv_ durables + the read ACL) is created by a PROVISIONER, not by holding a cred. Without
  // that, no durable membership is ever established and the whole arm measures a state that never
  // existed — which is precisely how run 1's A1 control failed.
  // ONE identity, used for both the cred and the card — they must be the same nkey, and calling
  // newIdentity() twice mints two.
  const mgrId = newIdentity();
  const provCreds = await mintCreds(auth, mgrId, "provisioner");
  const mgr = new CotalEndpoint({
    space, servers: SERVERS, creds: provCreds,
    card: { id: mgrId.id, name: "window-provisioner", role: "provisioner", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false,
  });
  watchErrors("provisioner", mgr);
  await mgr.start();
  endpoints.push(mgr);

  const chan = `window-${randomUUID().slice(0, 6)}`;

  // REGISTER the channel. `listChannels()` — the source of every row `cotal_channels` renders — reads
  // the channel REGISTRY, so an ad-hoc channel name yields no row at all and `deliveryHealth` is
  // undefined for a reason that has nothing to do with daemon health. The class is written
  // EXPLICITLY rather than relying on the `?? "durable"` resolution default, so the arm does not
  // depend on a fallback it is not testing.
  await seedChannelRegistry({
    servers: SERVERS, space, creds: provCreds,
    file: { channels: { [chan]: { deliveryClass: "durable" } } },
  });

  const aId = newIdentity();
  const auid = mintLifecycleUid();
  // `role` is not cosmetic: `provisionAgentDurables` creates the role's TASK queue only when it is
  // passed (`if (opts.role) provisionTaskQueue(opts.role)`), and without it the connector loops on a
  // denied `$JS.API.CONSUMER.INFO.TASK_<space>.svc_agent` and never reaches a durable join.
  // "general" is authorized alongside the arm's channel because the connector joins it regardless of
  // this list, and an unauthorized live sub there tears down the session before Plane-3 is reached.
  const acreds = await provisionAgent(mgr, auth, aId, {
    subscribe: ["general", chan], allowSubscribe: ["general", chan], lifecycleUid: auid, role: "agent",
  });
  // NO `as never`. The cast this line used to carry is what made runs 4-6 measure nothing:
  // `AgentConfig` names the read set `subscribe`, not `channels` (config.ts:48), so the cast
  // silently discarded the channel list and the agent joined nothing at all — `listChannels()`
  // returned []. A cast that suppresses a config-shape error buys a compile and pays for it in
  // arms that redden for a reason the compiler already knew.
  agent = new MeshAgent({
    space, servers: SERVERS, creds: acreds, id: aId.id, lifecycleUid: auid,
    name: "window-agent", role: "agent", kind: "agent", tls: false,
    subscribe: ["general", chan], allowSubscribe: ["general", chan], allowPublish: [chan],
  });
  watchErrors("mesh-agent", agent.ep);
  await agent.start();

  // POLL for the boot durable join instead of sleeping a guessed interval. A fixed wait is what let
  // run 1 walk into A1 with no membership; this makes "the membership never landed" a NAMED setup
  // failure rather than a silent precondition that reddens the arm downstream.
  let joined = false;
  for (let i = 0; i < 80; i++) {
    if (agent.ep.hasDurableMembership(chan)) { joined = true; break; }
    await wait(250);
  }
  check("A-setup: the durable membership was ESTABLISHED while the daemon was alive", joined);
  if (!joined) {
    // Ask the daemon DIRECTLY why, instead of inferring from the absence. The boot path swallows a
    // `durable:false` into a background retry, so the reason never reaches the console.
    try {
      const r = await agent.ep.durableJoinChannel(chan);
      console.error(`  diagnostic: durableJoinChannel("${chan}") -> ${JSON.stringify(r)}`);
    } catch (e) {
      console.error(`  diagnostic: durableJoinChannel("${chan}") THREW -> ${(e as Error).message}`);
    }
    console.error(`  diagnostic: rows -> ${JSON.stringify(await agent.listChannels())}`);
    throw new Error("Arm A precondition failed: no durable membership — the arm measures nothing");
  }

  const rowFor = async (c: string) => (await agent!.listChannels()).find((r) => r.channel === c);
  const liveRow = await rowFor(chan);
  check("A1 control: with a LIVE daemon, the shipped surface reports deliveryHealth 'active'",
    liveRow?.deliveryHealth === "active");
  check("A5 inverse control: a channel with NO durable membership does NOT read 'active'",
    (await rowFor(`never-joined-${randomUUID().slice(0, 6)}`))?.deliveryHealth !== "active");

  console.log("\n--- KILL, then SAMPLE the shipped surface until it stops saying `active`\n");
  const killAt = Date.now();
  if (created.daemon) { try { process.kill(-created.daemon, "SIGKILL"); } catch { /* gone */ } }
  const exitOutcome = await awaitExit(daemon);
  for (let i = 0; i < 400 && groupAlive(created.daemon); i++) await wait(5);
  check("kill: the daemon's exit was OBSERVED, not inferred from a timeout", exitOutcome === "exited");
  check("kill: the whole process GROUP is confirmed absent", !groupAlive(created.daemon));

  // Elapsed is measured from a clock read at the kill. Never counted in loop iterations.
  const samples: { atMs: number; health: string; lease: string }[] = [];
  let firstNonActiveMs: number | undefined;
  const LIMIT_MS = 75_000; // comfortably past LEASE_TTL_MS = 30_000
  for (;;) {
    const atMs = Date.now() - killAt;
    if (atMs >= LIMIT_MS) break;
    const health = String((await rowFor(chan))?.deliveryHealth);
    let lease: string;
    try { const l = await c1ep.readDeliveryLease(0); lease = l === undefined ? "no-record" : `ready=${l.ready}`; }
    catch (e) { lease = `threw:${(e as Error).message.slice(0, 40)}`; }
    samples.push({ atMs, health, lease });
    console.log(`  t+${String(atMs).padStart(6)}ms  deliveryHealth=${health.padEnd(10)} lease=${lease}`);
    if (health !== "active") { firstNonActiveMs = atMs; break; }
    await wait(2000);
  }

  check("R1: the surface reported `active` AFTER the daemon's absence was confirmed",
    samples.some((s) => s.health === "active"));
  check("R2: it reported `active` at t >= 20s — the false green is available for essentially the WHOLE window, not just a race at the kill",
    samples.some((s) => s.health === "active" && s.atMs >= 20_000),
    samples.filter((s) => s.health === "active").map((s) => s.atMs));
  check("R3: the window is BOUNDED — the surface eventually stops saying `active`",
    firstNonActiveMs !== undefined, firstNonActiveMs);
  if (firstNonActiveMs !== undefined) {
    console.log(`\n  MEASURED RESIDUE WINDOW: "active" stopped at t+${firstNonActiveMs}ms after the kill (LEASE_TTL_MS = 30000).`);
    check("R4: and it stops within the lease TTL plus a sampling margin, so the TTL is what clears it",
      firstNonActiveMs <= 40_000, firstNonActiveMs);
    const last = samples[samples.length - 1];
    check("R5: what it says AFTERWARDS is `degraded` — never a named refusal, and never `undefined`",
      last?.health === "degraded", last?.health);
    check("R6: and the membership conjunct NEVER cleared — only the lease expiring moved it",
      agent.ep.hasDurableMembership(chan) === true);
  }

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

  // The async half of every denial, reported rather than swallowed. Not asserted on: which endpoint
  // emits and when is timing-dependent, and an assertion here would be a flake generator. It is
  // evidence about the SHAPE of a denial, which is this lane's subject.
  console.log(`\nASYNC 'error' EVENTS observed: ${asyncErrors.length}`);
  for (const e of asyncErrors) console.log(`  · ${e}`);

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
