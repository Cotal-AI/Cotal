/**
 * delivery starvation-vs-broker-gone smoke — the live half of #1318.
 *
 * The daemon must exit when the broker is GONE and must NOT exit when its own process was merely
 * prevented from asking. Those two produced the same signal, and on 2026-09-05 the second one cost
 * Plane-3 nine minutes while `nats-server` had been up continuously for 7.3 days. So both are
 * graded here, against a real daemon and a real broker, in one run.
 *
 * HOW THE STARVATION CELL MAKES THE DAEMON UNABLE TO ASK WITHOUT MAKING THE BROKER UNAVAILABLE.
 * SIGSTOP on the daemon process. That is a faithful model of the reported condition rather than a
 * replica of it: the process is on no runqueue, so its 2s interval does not fire, its probes do not
 * complete, and its wall clock advances anyway — which is precisely the state the pre-fix predicate
 * misread. The broker is untouched and is confirmed reachable from THIS process throughout, so
 * anything the daemon concludes about it is a conclusion about itself. A CPU-burn model was
 * considered and rejected: it starves the runner too, so a green result would be indistinguishable
 * from a host that happened to schedule everything anyway.
 *
 * WHAT THIS SUITE REFUSES TO CALL A PASS. Its predecessor observed only `daemonExited`, so a daemon
 * that never started graded its exit cell green — "exited because the broker went away" and "was
 * never running" were the same observation. Every cell here therefore asserts the daemon was ALIVE
 * immediately before the stimulus, and the exit cells additionally require the daemon's own
 * stderr to carry the broker-gone reason. The daemon is spawned with piped stderr for exactly that.
 *
 * Run: pnpm smoke:delivery-starvation   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect as connectSocket, type AddressInfo, type Socket } from "node:net";
import { isReachable, composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, idFromCreds, leaseKey, mintCreds, mintMembershipObserverCreds, openDeliveryRegistry, serverConfig, newIdentity, setupSpaceStreams, standaloneConnectOpts, type DeliveryLeaseInfo } from "@cotal-ai/core";
import { connect } from "@nats-io/transport-node";
import { spaceMaterialDir } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const repoRoot = join(import.meta.dirname, "..", "..", "..");
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, detail ?? ""); }
};

/** The daemon's broker-gone window for this run. Short so the suite is fast; the PREDICATE is what
 *  is under test and it does not change with the constant. */
const WINDOW_MS = 2000;
/** Starve for well past the window, so a wall-clock predicate has certainly blown it. */
const STARVE_MS = 8000;
/** Cell C's blackhole: long enough to span several broker-gone windows, so a predicate that reads
 *  elapsed time has no way to avoid tripping. */
const CHOP_TOTAL_MS = 24_000;
/** Long enough to span at least one lease renew (~half the 30s TTL), so "the revision advanced" is
 *  a statement about a live renew loop rather than about polling luck. */
const LEASE_RENEW_OBSERVE_MS = 18_000;
/** Cell E's duty cycle: long enough that many probes are issued and answered late, and several
 *  multiples of the broker-gone window so a predicate reading elapsed time cannot avoid tripping. */
const DUTY_CYCLE_MS = 20_000;

/** Last few lines of a daemon's output — enough to diagnose a red without printing its whole life. */
const tail = (d: Daemon): string => d.stderr.trimEnd().split("\n").slice(-4).join("\n");

const space = `delivery-starve-${randomUUID().slice(0, 8)}`;
// Cell B runs in its OWN space. The delivery lease is per-space with a 30s bucket TTL, so a second
// daemon in the same space would be refused by the single-flight gate for the rest of that TTL and
// would grade "never came up" instead of the coupling under test. A distinct space is the honest
// isolation; sleeping out the TTL would add half a minute to every run to reach the same place.
const spaceB = `delivery-couple-${randomUUID().slice(0, 8)}`;
// Cell C needs a third, for the same reason: its daemon runs concurrently with neither, but the
// lease bucket's 30s TTL outlives cell A's daemon and would refuse it the slot.
const spaceC = `delivery-chop-${randomUUID().slice(0, 8)}`;
// Cell D needs a fourth, for the same lease-bucket reason as B and C.
const spaceD = `delivery-cut-${randomUUID().slice(0, 8)}`;
// Cell E needs a fifth, same lease-bucket reason again.
const spaceE = `delivery-late-${randomUUID().slice(0, 8)}`;
// Cell F needs a sixth: it runs TWO daemons in one space on purpose, which is the point of it.
const spaceF = `delivery-hand-${randomUUID().slice(0, 8)}`;
// ONE broker, TWO accounts under its single operator. Two independently created brokers would be
// two operators, and `serverConfig` refuses to compose trust across them — correctly, and that
// refusal is what pins the shape here rather than a second server on a second port.
const broker = await createBrokerAuth(space);
const accountA = await createSpaceAccountAuth(broker, space);
const accountB = await createSpaceAccountAuth(broker, spaceB);
const accountC = await createSpaceAccountAuth(broker, spaceC);
const accountD = await createSpaceAccountAuth(broker, spaceD);
const accountE = await createSpaceAccountAuth(broker, spaceE);
const accountF = await createSpaceAccountAuth(broker, spaceF);
const auth = composeSpaceAuth(broker, accountA);
const authB = composeSpaceAuth(broker, accountB);
const authC = composeSpaceAuth(broker, accountC);
const authD = composeSpaceAuth(broker, accountD);
const authE = composeSpaceAuth(broker, accountE);
const authF = composeSpaceAuth(broker, accountF);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(broker, [accountA, accountB, accountC, accountD, accountE, accountF], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
const credsPath = join(dir, "delivery.creds");
const credsPathB = join(dir, "delivery-b.creds");
const credsPathC = join(dir, "delivery-c.creds");
const credsPathD = join(dir, "delivery-d.creds");
const credsPathE = join(dir, "delivery-e.creds");
const credsPathF = join(dir, "delivery-f.creds");
// The scratch workspace root the daemon runs in, and the $SYS observer cred its startup admission
// requires (`cotal up` provisions this on a live mesh; minted here the way `up` does).
const wsRoot = join(dir, "ws");

type Daemon = { proc: ReturnType<typeof spawn>; exited: boolean; code: number | null; stderr: string };
const daemons: Daemon[] = [];

/** Spawn the real daemon with stderr CAPTURED, so an exit can be attributed to its stated reason
 *  rather than merely counted, and DETACHED so it owns a process group.
 *
 *  THE PROCESS GROUP IS LOAD-BEARING, NOT TIDINESS. The daemon is started through `tsx`, which
 *  execs; a signal aimed at the pid this function returns can freeze a wrapper and leave the node
 *  that is under test running normally. The cell would then pass by never applying its stimulus,
 *  which is the worst kind of green. Its own group means `kill(-pgid)` reaches everything in the
 *  pipeline. The child's operator surfaces are isolated the way the other daemon-spawning suites do
 *  it: scratch XDG_CONFIG_HOME/COTAL_HOME keep it off the operator's real seed store and mesh
 *  registry, and a scratch workspace root WITH a `.cotal` pins findCotalRoot's cwd walk — without
 *  it the walk climbs out of the repo, adopts a developer's live workspace, and the daemon's
 *  tenancy guard correctly refuses the foreign account before it ever reaches the code under test. */
function spawnDaemon(inSpace: string, creds: string, via: string = SERVERS, extraEnv: NodeJS.ProcessEnv = {}): Daemon {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("COTAL_")) delete env[k];
  env.XDG_CONFIG_HOME = join(dir, "xdg");
  env.COTAL_HOME = join(dir, "cotal-home");
  env.COTAL_SKIP_CONNECTOR_SEED = "1";
  env.COTAL_DELIVERY_BROKER_GONE_MS = String(WINDOW_MS);
  Object.assign(env, extraEnv);
  const proc = spawn(
    join(repoRoot, "node_modules", ".bin", "tsx"),
    [join(repoRoot, "bin", "cotal.ts"), "deliver", "--space", inSpace, "--server", via, "--creds", creds],
    { cwd: wsRoot, stdio: ["ignore", "pipe", "pipe"], detached: true, env },
  );
  const d: Daemon = { proc, exited: false, code: null, stderr: "" };
  const sink = (b: Buffer) => { d.stderr += b.toString(); };
  proc.stdout?.on("data", sink);
  proc.stderr?.on("data", sink);
  proc.on("exit", (code) => { d.exited = true; d.code = code; });
  daemons.push(d);
  return d;
}

/** Signal the daemon's whole process GROUP. Throws rather than swallowing when the daemon is still
 *  alive: a stimulus that silently did not land would make a cell grade a daemon that was never
 *  subjected to it. An already-exited daemon is not a failed stimulus, so that case is a no-op. */
function signalGroup(d: Daemon, signal: NodeJS.Signals): void {
  if (d.exited) return;
  if (d.proc.pid === undefined) throw new Error(`cannot signal ${signal}: the daemon has no pid`);
  try {
    process.kill(-d.proc.pid, signal);
  } catch (e) {
    // ESRCH means it exited between the check above and this call, which is a race rather than a
    // failure to deliver. Anything else is a real problem and must not be hidden.
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
}

/** Wait for the daemon to be SERVING, not merely spawned: its own readiness line. Returns false on
 *  timeout, and the caller fails the cell rather than proceeding against a daemon that never came
 *  up — which is how the predecessor suite graded a corpse green. */
async function untilUp(d: Daemon, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (d.exited) return false;
    if (d.stderr.includes("$SYS sweeps bound to")) {
      // The sweeps line is printed after admission and before the lease is claimed; give the bind
      // that follows it a moment, then confirm the process is still there.
      await wait(3000);
      return !d.exited;
    }
    await wait(200);
  }
  return false;
}

async function untilExit(d: Daemon, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (d.exited) return true;
    await wait(250);
  }
  return false;
}

type Proxy = ReturnType<typeof startFreshConnectBlackholeProxy>;
const proxies: Proxy[] = [];

/**
 * A TCP proxy in front of the broker that can be switched to blackhole NEW connections only.
 *
 * THE ASYMMETRY IS THE ENTIRE POINT. Already-established sockets keep flowing, so the daemon's
 * standing connection — the one it actually serves on — is untouched and it goes on renewing its
 * lease. New connections are ACCEPTED and then never forwarded, so they hang: a SYN that completes
 * and a handshake that never does. That is what a client which cannot get scheduled looks like from
 * the inside, and it is what the triage for #1318 built to reproduce the daemon's exit on a live
 * broker. Accepting-then-hanging rather than refusing matters: a refusal would be an immediate,
 * honest `false` about the address, which is a DIFFERENT condition and the one that should exit.
 */
function startFreshConnectBlackholeProxy(): {
  listening: Promise<number>;
  close: () => void;
  blackholeNew: boolean;
  dropEstablished: () => void;
  readonly established: number;
  readonly blackholed: number;
} {
  const held: Socket[] = [];
  const forwarded: Socket[] = [];
  let established = 0;
  let blackholed = 0;
  const state = { blackholeNew: false };
  const server = createServer((client: Socket) => {
    if (state.blackholeNew) {
      // Accepted, never forwarded, never closed: the connect succeeds and the handshake never
      // arrives, so the client's own deadline is what ends it.
      blackholed += 1;
      held.push(client);
      client.on("error", () => { /* the client gave up; that is the point */ });
      return;
    }
    const upstream = connectSocket({ host: "127.0.0.1", port: PORT });
    established += 1;
    held.push(client, upstream);
    forwarded.push(client, upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    const drop = () => { try { client.destroy(); } catch { /* gone */ } try { upstream.destroy(); } catch { /* gone */ } };
    client.on("error", drop);
    upstream.on("error", drop);
    client.on("close", drop);
    upstream.on("close", drop);
  });
  const listening = new Promise<number>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res((server.address() as AddressInfo).port));
  });
  const handle = {
    listening,
    close: () => {
      for (const s of held) { try { s.destroy(); } catch { /* gone */ } }
      try { server.close(); } catch { /* gone */ }
    },
    get blackholeNew() { return state.blackholeNew; },
    set blackholeNew(v: boolean) { state.blackholeNew = v; },
    /** Cut every socket that is currently carrying traffic, so the daemon's TRANSPORT goes down
     *  rather than merely its side-probes failing. Combined with `blackholeNew` this is the state
     *  in which the daemon has no standing evidence left and cannot obtain any: the honest
     *  "unreachable by every means available to me" that SHOULD end it. */
    dropEstablished: () => { for (const s of forwarded.splice(0)) { try { s.destroy(); } catch { /* gone */ } } },
    get established() { return established; },
    get blackholed() { return blackholed; },
  };
  proxies.push(handle);
  return handle;
}

/** Remove this shard's lease row on a connection of the suite's OWN, so cell F can stage a handover
 *  the way an operator-driven replacement does: the row goes, and the next daemon wins the create.
 *  Done from outside rather than by stopping the holder, because the holder must stay RUNNING — the
 *  whole question is what its shutdown does to a row it no longer owns. */
async function deleteLease(inSpace: string, credsFile: string): Promise<void> {
  const creds = readFileSync(credsFile, "utf8");
  const nc = await connect({
    servers: SERVERS,
    ...standaloneConnectOpts({ creds, tls: false }),
    inboxPrefix: `_INBOX_${idFromCreds(creds)}`,
    maxReconnectAttempts: 0,
  });
  try { await (await openDeliveryRegistry(nc, inSpace)).delete(leaseKey(0)); }
  finally { try { await nc.drain(); } catch { /* already gone */ } }
}

/** Read a shard-0 delivery lease straight from the broker, on a connection of this suite's own.
 *  Asking the BROKER rather than the daemon is the point: a daemon reporting on its own liveness is
 *  the thing under test, so the evidence has to come from the other side of the wire. */
async function readLease(inSpace: string, credsFile: string): Promise<{ info: DeliveryLeaseInfo; revision: number } | undefined> {
  const creds = readFileSync(credsFile, "utf8");
  const nc = await connect({
    servers: SERVERS,
    ...standaloneConnectOpts({ creds, tls: false }),
    inboxPrefix: `_INBOX_${idFromCreds(creds)}`,
    maxReconnectAttempts: 0,
  });
  try {
    const e = await (await openDeliveryRegistry(nc, inSpace)).get(leaseKey(0));
    if (!e || e.operation === "DEL" || e.operation === "PURGE") return undefined;
    return { info: e.json<DeliveryLeaseInfo>(), revision: e.revision };
  } finally {
    try { await nc.drain(); } catch { /* already gone */ }
  }
}

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  const mgrCredsB = await mintCreds(authB, newIdentity(), "provisioner");
  const mgrCredsC = await mintCreds(authC, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  await setupSpaceStreams({ servers: SERVERS, space: spaceB, creds: mgrCredsB });
  await setupSpaceStreams({ servers: SERVERS, space: spaceC, creds: mgrCredsC });
  const mgrCredsD = await mintCreds(authD, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space: spaceD, creds: mgrCredsD });
  const mgrCredsE = await mintCreds(authE, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space: spaceE, creds: mgrCredsE });
  const mgrCredsF = await mintCreds(authF, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space: spaceF, creds: mgrCredsF });
  writeFileSync(credsPath, await mintCreds(auth, newIdentity(), "delivery"), { mode: 0o600 });
  writeFileSync(credsPathB, await mintCreds(authB, newIdentity(), "delivery"), { mode: 0o600 });
  writeFileSync(credsPathC, await mintCreds(authC, newIdentity(), "delivery"), { mode: 0o600 });
  writeFileSync(credsPathD, await mintCreds(authD, newIdentity(), "delivery"), { mode: 0o600 });
  writeFileSync(credsPathE, await mintCreds(authE, newIdentity(), "delivery"), { mode: 0o600 });
  writeFileSync(credsPathF, await mintCreds(authF, newIdentity(), "delivery"), { mode: 0o600 });
  mkdirSync(join(wsRoot, ".cotal"), { recursive: true });
  for (const [s, a] of [[space, auth], [spaceB, authB], [spaceC, authC], [spaceD, authD], [spaceE, authE], [spaceF, authF]] as const) {
    mkdirSync(spaceMaterialDir(wsRoot, s), { recursive: true });
    writeFileSync(
      join(spaceMaterialDir(wsRoot, s), "membership-observer.creds"),
      await mintMembershipObserverCreds(a, newIdentity()),
      { mode: 0o600 },
    );
  }

  // ── A. STARVATION: the daemon cannot ask, and the broker is demonstrably fine ───────────────────
  console.log("\nA. the daemon's own process is starved while the broker stays up");
  const starved = spawnDaemon(space, credsPath);
  const starvedUp = await untilUp(starved);
  check("A1 the daemon comes up and is serving against a live broker", starvedUp, tail(starved));
  if (!starvedUp) throw new Error("the starvation cell needs a daemon that was running; it never came up");

  // Take it off the runqueue entirely. Its interval cannot fire, its probes cannot complete, and
  // its wall clock runs on regardless — the exact state the pre-fix predicate read as a dead server.

  signalGroup(starved, "SIGSTOP");
  const stoppedAt = Date.now();
  await wait(STARVE_MS);
  // The broker is not merely assumed alive: it is probed from THIS process, mid-starvation, so the
  // cell below cannot be satisfied by a broker that quietly went away.
  check("A2 the broker is reachable from this process throughout the starvation", await isReachable(SERVERS));
  check("A3 the starvation lasted well past the daemon's broker-gone window",
    Date.now() - stoppedAt > WINDOW_MS * 2, { starvedMs: Date.now() - stoppedAt, windowMs: WINDOW_MS });

  signalGroup(starved, "SIGCONT");

  // Now let it run. The first interval it gets is the one the pre-fix code exited from: the window
  // is already blown, and the probe that finally runs is the likeliest to fail. It must instead
  // conclude that IT was starved, report degraded, and keep serving.
  await wait(6000);
  check("A4 the daemon did NOT exit after being starved past its window with the broker alive",
    !starved.exited, { exited: starved.exited, code: starved.code, tail: tail(starved) });
  check("A5 and it is still alive after a further settle, not exiting late",
    !(await untilExit(starved, 4000)), tail(starved));
  // The daemon must also RECOVER rather than sit in a degraded state forever: positive evidence
  // clears it, which is what "report degraded and recover" means.
  check("A6 the daemon never printed a broker-gone exit line",
    !starved.stderr.includes("exiting (coupled to the broker)"), tail(starved));
  // NOT MERELY UN-EXITED — STILL SERVING. "The process is alive" is also true of a daemon wedged
  // in a reconnect loop with its lease long expired, which would be a different defect wearing this
  // cell's green. So the lease is read from the broker: it must still be HELD BY THIS DAEMON and
  // still be advancing, which only a daemon whose renew loop survived the stall can produce.
  const first = await readLease(space, credsPath);
  check("A7 the starved daemon still holds a live, ready lease after the stall",
    first !== undefined && first.info.ready === true, first);
  await wait(LEASE_RENEW_OBSERVE_MS);
  const second = await readLease(space, credsPath);
  check("A8 and it is still RENEWING that lease — the revision advances and the holder is unchanged",
    first !== undefined && second !== undefined
      && second.revision > first.revision
      && second.info.holder === first.info.holder,
    { first, second });

  signalGroup(starved, "SIGKILL");
  await untilExit(starved, 5000);

  // ── C. THE DISCRIMINATING SHAPE: probes that COMPLETE and say no, from a live broker ────────────
  //
  // Cell A freezes the daemon outright, which stops its probes from completing at all. Measured:
  // the pre-fix tree SURVIVES that, because the first probe after the resume succeeds and refreshes
  // the window before the predicate is next consulted. A cell that both trees pass grades nothing,
  // so it is kept for what it does prove (the daemon survives a stall and goes on renewing) and the
  // discrimination is done here.
  //
  // THIS is the mechanism the issue's own triage reproduced, and the one with no luck in it. The
  // daemon reaches the broker through a proxy that PRESERVES every already-established socket and
  // blackholes only NEW connections. The daemon's standing connection keeps working, so it is
  // serving the whole time; its 2s side-probe opens a fresh connection every tick, and each one now
  // hangs until `isReachable`'s own 1s deadline ends it and flattens it to `false`. That is a
  // process that cannot complete a handshake against a server that is up and answering — which is
  // exactly what local CPU starvation does to a client, delivered deterministically instead of by
  // fighting the scheduler.
  //
  // The pre-fix predicate cannot tell this from a dead server: it sees `false` and a window that has
  // elapsed, and it exits. The repaired predicate has two independent reasons not to: the answers
  // arrive far past their own budget, and this daemon's own transport to that broker never closed.
  console.log("\nC. new connections are blackholed while the daemon's established socket keeps working");
  const proxy = startFreshConnectBlackholeProxy();
  const proxyPort = await proxy.listening;
  const chopped = spawnDaemon(spaceC, credsPathC, `nats://127.0.0.1:${proxyPort}`);
  const choppedUp = await untilUp(chopped);
  check("C1 the daemon comes up and is serving through the proxy", choppedUp, tail(chopped));
  if (!choppedUp) throw new Error("the blackhole cell needs a daemon that was running; it never came up");
  const establishedBefore = proxy.established;
  check("C2 it established at least one real connection before the blackhole began", establishedBefore > 0, establishedBefore);
  // From here, every NEW connection to the proxy hangs. The established ones are untouched.
  proxy.blackholeNew = true;
  const choppedStart = Date.now();
  let brokerStayedUp = true;
  let exitedDuringBlackhole = false;
  while (Date.now() - choppedStart < CHOP_TOTAL_MS) {
    await wait(1000);
    // The BROKER is probed directly, bypassing the proxy, so "the daemon saw failures" can never be
    // satisfied by a broker that quietly stopped answering.
    if (!(await isReachable(SERVERS))) brokerStayedUp = false;
    // Do NOT break on an exit. The remaining cells are the ones that report it, and leaving the loop
    // early would additionally red C4 on a duration the daemon's own exit cut short — a second,
    // misleading failure attached to the same event.
    if (chopped.exited) exitedDuringBlackhole = true;
  }
  check("C3 the broker answered this process directly throughout", brokerStayedUp);
  check("C4 the blackhole lasted several multiples of the daemon's broker-gone window",
    Date.now() - choppedStart > WINDOW_MS * 4, { ranMs: Date.now() - choppedStart, windowMs: WINDOW_MS });
  check("C5 the daemon's side-probes were actually being blackholed",
    proxy.blackholed > 0, { blackholed: proxy.blackholed, established: proxy.established });
  check("C6 the daemon did NOT exit while it could not complete a fresh handshake",
    !exitedDuringBlackhole && !chopped.exited,
    { exited: chopped.exited, code: chopped.code, tail: tail(chopped) });
  check("C7 and it never claimed the broker was gone",
    !chopped.stderr.includes("exiting (coupled to the broker)"), tail(chopped));
  check("C8 it reported DEGRADED instead, naming the condition rather than vanishing",
    /DEGRADED/.test(chopped.stderr), tail(chopped));
  // Still SERVING, from the broker's own record rather than the daemon's word for it.
  const cLease = await readLease(spaceC, credsPathC);
  check("C9 it still holds a live, ready lease on the far side of the wire",
    cLease !== undefined && cLease.info.ready === true, cLease);
  signalGroup(chopped, "SIGKILL");
  await untilExit(chopped, 5000);

  // ── D. THE REFUSING CASE FOR C: transport DOWN with the same failing probes, which MUST exit ────
  //
  // CELL C ALONE IS NOT ENOUGH, AND THE MUTATION RECORD IS WHAT SAID SO. Deleting the per-probe
  // lateness signal entirely left C green: C's daemon keeps its standing socket, so the open
  // transport alone carries the verdict there and the signal is never load-bearing. A cell that
  // greens on a broken implementation grades nothing about it, so the signal needed a case where it
  // is the only evidence in play. This is that case, and it is also the refusing side of the
  // guarantee: the blackhole is exactly C's, but every established socket is CUT as well. The
  // daemon now holds no standing evidence and can obtain none — it is not starved, it is genuinely
  // cut off from that address by every means available to it — so the honest answer is to exit.
  //
  // C and D therefore pin the distinction from both sides. Same failing side-probes, same live
  // server, opposite required outcomes, and the ONLY difference between them is the evidence the
  // daemon holds about its own connection. That difference is the entire claim of this repair.
  console.log("\nD. the transport is cut AND new connections are blackholed — no evidence is obtainable");
  const cutProxy = startFreshConnectBlackholeProxy();
  const cutPort = await cutProxy.listening;
  const cut = spawnDaemon(spaceD, credsPathD, `nats://127.0.0.1:${cutPort}`);
  const cutUp = await untilUp(cut);
  check("D1 the daemon comes up and is serving through the proxy", cutUp, tail(cut));
  if (!cutUp) throw new Error("the cut-off cell needs a daemon that was running; it never came up");
  check("D2 it established at least one real connection before the cut", cutProxy.established > 0, cutProxy.established);
  // Blackhole FIRST, then cut. The reverse order leaves a gap in which the client reconnects
  // straight through the proxy, and the cell would grade a daemon that was never cut off at all.
  cutProxy.blackholeNew = true;
  cutProxy.dropEstablished();
  const cutAt = Date.now();
  const exitedCut = await untilExit(cut, CHOP_TOTAL_MS);
  check("D3 the daemon EXITS once its transport is down and it still cannot reach the broker", exitedCut, tail(cut));
  check("D4 and the exit names the broker-gone reason rather than being any exit at all",
    cut.stderr.includes("exiting (coupled to the broker)"), tail(cut));
  // The prompt exit is the POINT of the coupling. A repair that keeps the exit but defers it for
  // minutes has traded the defect for a quieter version of itself, so the latency is graded too.
  const cutExitMs = Date.now() - cutAt;
  check("D5 and it exited promptly rather than waiting out the backstop", cutExitMs < CHOP_TOTAL_MS, cutExitMs);
  cutProxy.close();

  // ── E. THE INCIDENT'S OWN CONDITION: starved but still running, so probes complete LATE ─────────
  //
  // A AND D BETWEEN THEM STILL DO NOT GRADE THE LATENESS SIGNAL, and the mutation record is what
  // established that. Under A's full SIGSTOP no probe completes at all, so there is nothing to be
  // late; under D every blackholed probe is cut off by its own deadline ON TIME, at ~1000ms of a
  // 1000ms budget, so it is an honest negative. Deleting the lateness rule left both green. The
  // condition it exists for is neither: it is load 311 on 12 cores, where the process DOES run, just
  // not when it meant to. A probe issued there completes — and its own deadline timer fires seconds
  // after the deadline it was supposed to enforce, so the `false` it returns was decided by this
  // host's runqueue rather than by the server. That is the third mechanism in #1318, and the
  // measured incident is full of it.
  //
  // Duty-cycled SIGSTOP/SIGCONT is that state, reproduced with signals alone: the daemon runs in
  // short slices and is off the runqueue in between, exactly like a process getting a few percent of
  // a CPU. The transport is cut and new connects are blackholed as in D, so no other evidence can
  // carry the verdict and the lateness of the answers is the ONLY thing standing between this
  // daemon and an exit. The broker is alive throughout, so staying is the correct answer.
  //
  // The backstop is raised FOR THIS DAEMON ONLY, and that is not a thumb on the scale: the backstop
  // is a different guarantee, graded on its own by cell D (which exits well inside it) and by the
  // pure suite's F-section. Leaving it at 4× a 2s window would end this daemon on the backstop
  // before the signal under test ever got to matter, and the cell would grade the backstop twice
  // instead of grading lateness once.
  console.log("\nE. the daemon is duty-cycled off the CPU, so its probes complete long past their own deadline");
  const lateProxy = startFreshConnectBlackholeProxy();
  const latePort = await lateProxy.listening;
  const late = spawnDaemon(spaceE, credsPathE, `nats://127.0.0.1:${latePort}`, { COTAL_DELIVERY_BROKER_GONE_BACKSTOP_MS: String(DUTY_CYCLE_MS * 4) });
  const lateUp = await untilUp(late);
  check("E1 the daemon comes up and is serving through the proxy", lateUp, tail(late));
  if (!lateUp) throw new Error("the late-probe cell needs a daemon that was running; it never came up");
  lateProxy.blackholeNew = true;
  lateProxy.dropEstablished();
  // ~10% duty cycle: awake 100ms in every second. Long enough a slice that the daemon makes
  // progress and issues probes, short enough that a 1000ms deadline lands many seconds late.
  const dutyUntil = Date.now() + DUTY_CYCLE_MS;
  while (Date.now() < dutyUntil && !late.exited) {
    signalGroup(late, "SIGSTOP");
    await wait(900);
    signalGroup(late, "SIGCONT");
    await wait(100);
  }
  if (!late.exited) signalGroup(late, "SIGCONT");
  const dutyElapsed = DUTY_CYCLE_MS;
  check("E2 the duty cycle lasted several multiples of the daemon's broker-gone window",
    dutyElapsed > WINDOW_MS * 4, { dutyElapsed, window: WINDOW_MS });
  check("E3 the broker answered this process directly throughout", await isReachable(SERVERS));
  check("E4 the daemon's probes were being blackholed while it was descheduled",
    lateProxy.blackholed > 0, { blackholed: lateProxy.blackholed });
  // THE CELL. Every probe came back false; each was decided by a deadline this process could not
  // honour. A predicate that reads those as statements about the server exits here.
  check("E5 the daemon did NOT exit on answers its own scheduling delay produced", !late.exited, tail(late));
  check("E6 and it never claimed the broker was gone",
    !late.stderr.includes("exiting (coupled to the broker)"), tail(late));
  // It must also RECOVER: a daemon that survives by going permanently quiet has not distinguished
  // anything, it has just stopped reacting. Unblackhole and it should reconnect and serve.
  lateProxy.blackholeNew = false;
  await wait(WINDOW_MS * 3);
  const eLease = await readLease(spaceE, credsPathE);
  check("E7 and once the wire is healthy again it is serving: a live, ready lease on the far side",
    eLease !== undefined && eLease.info.ready === true, { eLease, tail: tail(late) });
  signalGroup(late, "SIGKILL");
  await untilExit(late, 5000);
  lateProxy.close();

  // ── F. THE HANDOVER: a departing daemon must not delete its REPLACEMENT's lease ─────────────────
  //
  // THIS CELL EXISTS BECAUSE A REVIEWER FOUND THE HOLE, and it is the refusing case for the exit
  // this whole issue is about. Every takeover path ends in `shutdown(1)`, and shutdown released the
  // lease — with an unconditional KV delete, which removes whatever row is present rather than the
  // row this process owned. By the time a daemon exits BECAUSE another daemon took the shard, the
  // row is the replacement's. So the old daemon's polite release deleted the new holder's lease and
  // left the shard with nobody serving it: a cleaner, quieter version of exactly the outage #1318
  // is about, reachable through the lease path instead of the broker-watch path.
  //
  // The repair makes release a compare-and-swap on the revision this endpoint last owned, and drops
  // the revision on the takeover paths so a departing daemon offers nothing to release. Graded here
  // end to end rather than on `leaseAction` alone: the pure decision was always correct, and the
  // damage happened downstream of it, which is precisely why a pure cell could not see it.
  console.log("\nF. a daemon that loses the shard must not delete the winner's lease on its way out");
  const holder = spawnDaemon(spaceF, credsPathF);
  const holderUp = await untilUp(holder);
  check("F1 the first daemon comes up and holds the shard", holderUp, tail(holder));
  if (!holderUp) throw new Error("the handover cell needs a daemon that was running; it never came up");
  const beforeHandover = await readLease(spaceF, credsPathF);
  check("F2 its lease is live and ready before the handover", beforeHandover?.info.ready === true, beforeHandover);

  // Take the shard away from underneath it, exactly as an operator-driven replacement does: delete
  // the row, then let a SECOND daemon win the atomic create. The first daemon's next renew fails,
  // it re-reads, and it finds the shard held by someone else.
  await deleteLease(spaceF, credsPathF);
  const winner = spawnDaemon(spaceF, credsPathF);
  const winnerUp = await untilUp(winner);
  check("F3 a replacement daemon acquires the shard", winnerUp, tail(winner));
  const winnerLease = await readLease(spaceF, credsPathF);
  check("F4 the replacement's lease is live and ready", winnerLease?.info.ready === true, winnerLease);

  // The loser must now exit on its own — that is the single-holder guarantee, and it is preserved.
  const loserExited = await untilExit(holder, 45_000);
  check("F5 the displaced daemon exits so the holder is single", loserExited, tail(holder));
  check("F6 and it says the shard is held by another daemon rather than claiming a broker loss",
    /taken shard|is held by/.test(holder.stderr) && !holder.stderr.includes("exiting (coupled to the broker)"), tail(holder));

  // THE CELL. Read the lease from the BROKER after the loser has finished shutting down. Its
  // shutdown path runs asynchronously after the exit, so settle past it before reading.
  await wait(4000);
  const afterHandover = await readLease(spaceF, credsPathF);
  check("F7 the replacement STILL holds a live, ready lease after the loser finished exiting",
    afterHandover?.info.ready === true, { afterHandover, winnerLease });
  check("F8 and it is the same holder the replacement acquired, not a third row",
    afterHandover !== undefined && winnerLease !== undefined && afterHandover.info.holder === winnerLease.info.holder,
    { after: afterHandover?.info.holder, winner: winnerLease?.info.holder });
  signalGroup(winner, "SIGKILL");
  await untilExit(winner, 5000);

  // ── B. BROKER GONE: the real thing still ends the daemon ────────────────────────────────────────
  console.log("\nB. the broker is actually killed");
  const coupled = spawnDaemon(spaceB, credsPathB);
  const coupledUp = await untilUp(coupled);
  check("B1 the daemon comes up and is serving against a live broker", coupledUp, tail(coupled));
  if (!coupledUp) throw new Error("the broker-gone cell needs a daemon that was running; it never came up");
  // ALIVE IMMEDIATELY BEFORE THE STIMULUS. Asserted here rather than inferred from B1, so "it exited
  // because the broker went away" can never be satisfied by "it was already dead".
  check("B2 the daemon is alive immediately before the broker is killed", !coupled.exited);
  srv.kill("SIGKILL");
  check("B3 the daemon EXITS on its own when the broker is gone (coupled to the broker)",
    await untilExit(coupled, 30_000), tail(coupled));
  // And for the RIGHT reason: an exit is not a verdict until it says why.
  check("B4 and the exit names the broker-gone reason rather than being any exit at all",
    coupled.stderr.includes("exiting (coupled to the broker)"), tail(coupled));
  check("B5 the exit code is non-zero", coupled.code !== 0, coupled.code);

  const EXPECTED_CELLS = 42;
  check(`every cell ran (${EXPECTED_CELLS} before this sentinel)`, pass + fail === EXPECTED_CELLS, pass + fail);

  console.log(`\nDELIVERY-STARVATION SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  // SIGCONT before SIGKILL: a SIGSTOPped process does not act on SIGKILL until it is resumed on
  // some platforms, and a suite that leaves a frozen daemon behind has poisoned the next run.
  for (const d of daemons) {
    try { if (!d.exited) { signalGroup(d, "SIGCONT"); signalGroup(d, "SIGKILL"); } } catch { /* gone */ }
  }
  // Held sockets keep the event loop alive, so a suite that fails mid-cell would otherwise hang
  // until its CI timeout rather than reporting the red it already has.
  for (const p of proxies) { try { p.close(); } catch { /* gone */ } }
  try { srv.kill("SIGKILL"); } catch { /* gone */ }
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
