/**
 * `cotal attach` survives the operator's link dying. Run: pnpm smoke:attach-reconnect
 * (needs nats-server + node on PATH; boots its own broker).
 *
 * THE DEFECT, as measured before the fix existed. An attach left alone while the laptop sleeps was
 * gone by the time the operator came back, in one of two ways depending on how long the link was
 * down:
 *
 *   - shorter than the serving side's stall: the manager's rail keeps advancing `seq` into a
 *     subject nobody is subscribed to, and EPS has no retention, so the frames are simply gone.
 *     The instant the client redials and its subscription is restored, the next frame lands far
 *     ahead of `expected`, the caller's rail faults `gap`, and the CLI exits 1 with
 *     `✗ mesh session transport error: gap` about a second AFTER the link came back.
 *   - longer than the stall: the serving rail fills its 64-frame window, stalls, ends the session
 *     and closes. Its `end` and `close` frames are published while the client is disconnected, so
 *     neither is ever delivered, and on redial the client sits on a session nobody is serving with
 *     no output, no honest end and no exit at all.
 *
 * THE FAULT MODEL. Only the ATTACH CLIENT's link dies. The broker runs with `ping_interval: "2s"`
 * and `ping_max: 1` so a dead client link is reaped in seconds rather than the stock four minutes;
 * the manager and the seat dial it DIRECTLY, while the CLI dials a node `net` TCP proxy this suite
 * can sever (destroy every socket, stop accepting) and heal (accept again). The CLI child runs
 * under a REAL pty, so `stdin.isTTY`/`stdout.isTTY` are true and the raw-mode path is the one under
 * test rather than a piped approximation.
 *
 * WHAT EACH CELL PROVES:
 *   A. the link dying is announced, the link healing is announced, and seat output produced AFTER
 *      the heal reaches the client. The last is a nonce written into the client's keyboard after
 *      the reconnect and returned by the seat wrapped as `ECHO[...]`, which neither a local
 *      terminal echo nor the manager's replayed backlog can manufacture.
 *      It also measures how long the loss takes to NOTICE, and pins that a broker which is down AT
 *      the reconnect step produces another wait rather than ending the command.
 *   B. the detach key detaches DURING a reconnect, not only while a session is up.
 *   C. `--no-reconnect` still exits the way it does today: non-zero, on the `gap` fault.
 *   D. an outage LONGER than the serving side's own stall still reconnects, which is the arm that
 *      used to hang forever rather than exit.
 *   E. a seat despawned while the client is reconnecting ends the attach CLEAN, saying the seat is
 *      gone, rather than retrying forever against something that no longer exists.
 *   G. a FIRST attach against a mesh that is not there still refuses the way it always did: one
 *      failure mark, the refusal's own remedy, and no reconnect it was never going to make.
 *   H. a reconnect hands the abandoned session back to the manager. Against a SILENT seat, which
 *      is the one nothing on the serving side reaps, so the count is the client's doing or nobody's.
 *   F. the four classifications the loop turns on, as functions.
 *
 * ON CELL F. It builds its inputs by hand, so on its own it would prove only that the suite
 * depends on those functions. The reachability it does not prove is proven beside it: cell E
 * drives `attachRefusal("not-found")` through the real `cotal attach` binary end to end, cells
 * A to D drive `isTransportEnd` the same way, cell A drives `reconnectNotice`'s SILENT branch
 * end to end (the mesh preflight refuses at the reconnect step for several attempts there, and the
 * cell asserts its remedy line never reaches the terminal), and cell B drives `heldSessionNotice`'s
 * PRINTING branch the same way, by detaching while the link is still down. Cell F then pins the REMAINING inputs
 * of the same four functions, which no end-to-end fault in this harness can produce: a static
 * single-owner mesh mints an admin instrument for every attach, so the manager has no reason to
 * answer `permission-denied`, and nothing here can drive it to its 64-session ceiling.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect as netConnect, type AddressInfo, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as pty from "@lydell/node-pty";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity,
  registry, type Connector, type LaunchOpts, type LaunchSpec,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { attachRefusal, heldSessionNotice, reconnectNotice } from "../../cli/src/commands/agents.js"; // dev-only cross-impl smoke import
import { isTransportEnd } from "../../cli/src/lib/attach-client.js"; // dev-only cross-impl smoke import
import { Manager } from "../src/manager.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const BIN = join(repoRoot, "bin", "cotal.ts");
const SEAT_STUB = join(here, "attach-reconnect-seat.mjs");
const DETACH_BYTE = "\x1d"; // Ctrl-] , the default detach key

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? String(JSON.stringify(extra)).slice(0, 600) : ""); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });

// --- live-space guard: this suite only ever runs against its own ephemeral loopback broker ------
const LIVE_HOST = "broker.cotal.ai";
for (const k of ["COTAL_SERVERS", "COTAL_SERVER", "COTAL_CREDS", "COTAL_SPACE"]) delete process.env[k];
for (const [k, v] of Object.entries(process.env))
  if (typeof v === "string" && v.includes(LIVE_HOST)) throw new Error(`refusing to run: ${k} points at the live broker (${v})`);

const BROKER_PORT = await freePort();
const PROXY_PORT = await freePort();
const BROKER = `nats://127.0.0.1:${BROKER_PORT}`;
const PROXY = `nats://127.0.0.1:${PROXY_PORT}`;
if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(BROKER)) throw new Error(`this suite only runs against an ephemeral loopback broker; got ${BROKER}`);
console.log(`broker-url guard: ${BROKER} (manager+seat) / ${PROXY} (attach client) are ephemeral loopback; no env var references ${LIVE_HOST}\n`);

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const home = join(dir, "home");
mkdirSync(home, { recursive: true });
process.env.COTAL_HOME = home; // the CLI's mesh registry lives here, never the operator's real one
// And the CONNECTOR SEED STORE, which does NOT live under COTAL_HOME: it sits under
// `globalConfigDir()`, so it is the operator's real `~/.config/cotal` unless XDG_CONFIG_HOME
// says otherwise. Every `cotal` command except help runs `reconcileSeededConnectors()`, and
// that refuses outright when the store's generation is NEWER than the binary being run. So a
// worktree pinned to an older tip than the laptop's last release fails every cell here with
// "this cotal X is older than the seed store's generation Y", which looks exactly like a
// behaviour red and is not one. Isolated, the suite grades the code and nothing else.
process.env.XDG_CONFIG_HOME = join(dir, "xdg");
mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
const space = `attachrc-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);

// A fast-ping broker. The stock 2-minute ping with 2 misses would put every observation four
// minutes downstream of the fault; the fault itself is unchanged.
writeFileSync(
  join(dir, "server.conf"),
  serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: BROKER_PORT, storeDir: join(dir, "js") }) +
    `\nping_interval: "2s"\nping_max: 1\n`,
);
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

// --- the faultable link -------------------------------------------------------------------------
const liveSockets = new Set<Socket>();
let proxy: Server | undefined;
// The link has THREE states, not two. Severed is a socket that is gone, which the client's NATS
// layer notices at once. HELD is a socket that is still up and carries nothing, which is what a
// sleeping laptop or a black-holing middlebox actually looks like from the client: the connection
// is not closed, so anything that asks "is this link alive?" says yes, and only a round trip that
// fails to come back tells the truth. Data handlers behind a flag, because `pipe` cannot be paused
// without also pausing the socket the flag is meant to keep looking healthy.
let holding = false;
const hold = (): void => { holding = true; };
const unhold = (): void => { holding = false; };
const heal = (): Promise<void> =>
  new Promise((res, rej) => {
    holding = false;
    const s = createServer((client) => {
      const up = netConnect(BROKER_PORT, "127.0.0.1");
      liveSockets.add(client); liveSockets.add(up);
      const drop = () => { liveSockets.delete(client); liveSockets.delete(up); client.destroy(); up.destroy(); };
      for (const ev of ["error", "close"] as const) { client.on(ev, drop); up.on(ev, drop); }
      client.on("data", (b) => { if (!holding) up.write(b); });
      up.on("data", (b) => { if (!holding) client.write(b); });
    });
    s.on("error", rej);
    s.listen(PROXY_PORT, "127.0.0.1", () => { proxy = s; res(); });
  });
const sever = (): Promise<void> =>
  new Promise((res) => {
    holding = false;
    const s = proxy; proxy = undefined;
    for (const sock of liveSockets) sock.destroy();
    liveSockets.clear();
    if (!s) return res();
    s.close(() => res());
  });

// The seat ticks FAST. The manager's stall watchdog only arms once the 64-frame send window is
// full, so at 50ms the window fills in about 3s and the serving side is dead by about 33s: that is
// what makes the long-outage cell below cost 40 seconds instead of a minute and a half.
const TICK_MS = 50;
const envFor = (o: LaunchOpts): Record<string, string> => ({
  COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? BROKER), COTAL_CREDS: String(o.creds),
  COTAL_ID: String(o.id), COTAL_NAME: o.name, PATH: process.env.PATH ?? "",
  SEAT_TICK_MS: String(TICK_MS),
  ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
});
registry.register({
  kind: "connector", name: "rc-seat", requires: ["node"],
  buildLaunch: (o): LaunchSpec => ({ command: process.execPath, args: [SEAT_STUB], env: envFor(o) }),
} as Connector);
// The same seat with its ticker off. Cell H needs a serving side that never fills the send window,
// because that is the seat whose abandoned session nothing on the manager reaps.
registry.register({
  kind: "connector", name: "rc-seat-quiet", requires: ["node"],
  buildLaunch: (o): LaunchSpec => ({
    command: process.execPath, args: [SEAT_STUB], env: { ...envFor(o), SEAT_SILENT: "1" },
  }),
} as Connector);

/** One `cotal attach` under a real pty, with its whole transcript and its exit. */
type Attached = {
  seen: () => string;
  write: (s: string) => void;
  exit: () => { code: number; signal: number } | undefined;
  waitFor: (re: RegExp, ms: number) => Promise<boolean>;
  waitExit: (ms: number) => Promise<boolean>;
  kill: () => void;
};
function attachUnderPty(root: string, extra: string[] = [], seat: string = SEAT): Attached {
  const child = pty.spawn("npx", ["tsx", BIN, "attach", "--name", seat, "--space", space, "--server", PROXY, ...extra], {
    name: "xterm-256color", cols: 100, rows: 30, cwd: root,
    env: { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, COTAL_SPACE: "", COTAL_SERVERS: "", COTAL_CREDS: "" } as Record<string, string>,
  });
  let buf = "";
  let exited: { code: number; signal: number } | undefined;
  child.onData((d) => { buf += d; });
  child.onExit((e) => { exited = { code: e.exitCode, signal: e.signal ?? 0 }; });
  const seen = () => buf;
  return {
    seen,
    write: (s) => child.write(s),
    exit: () => exited,
    kill: () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } },
    waitFor: async (re, ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) { if (re.test(seen())) return true; await wait(100); }
      return re.test(seen());
    },
    waitExit: async (ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) { if (exited) return true; await wait(100); }
      return exited !== undefined;
    },
  };
}

/** A plain (non-terminal) `cotal` run, for the control-plane commands this suite drives itself. */
const cotal = (args: string[], cwd: string, timeoutMs = 90_000): Promise<{ status: number | null; out: string }> =>
  new Promise((res) => {
    const child = spawn("npx", ["tsx", BIN, ...args], {
      cwd, env: { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, COTAL_SPACE: "", COTAL_SERVERS: "", COTAL_CREDS: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (status) => { clearTimeout(timer); res({ status, out }); });
    child.on("error", (e) => { clearTimeout(timer); res({ status: null, out: `launch error: ${e.message}` }); });
  });

const SEAT = "rcseat";
let manager: InstanceType<typeof Manager> | undefined;
const started: Attached[] = [];

try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(BROKER)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${BROKER_PORT}`);
  await setupSpaceStreams({ servers: BROKER, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  await heal();

  const root = join(dir, "ws");
  mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(root, ".cotal", "agents", `${SEAT}.md`), `---\nname: ${SEAT}\nrole: worker\n---\n`);
  saveSpaceAuth(authDir(root), auth);
  // COTAL_HOME is read when the registry module loads, so pull it in AFTER the sandbox is set.
  const { recordMesh } = await import("@cotal-ai/workspace");
  recordMesh({ space, server: BROKER, root, mode: "auth", ts: new Date().toISOString() });

  manager = new Manager({ space, servers: BROKER, runtime: "pty", workspaceRoot: root });
  await manager.start();
  const spawned = await manager.startAgent({ name: SEAT, agent: "rc-seat", cwd: repoRoot });
  if (!spawned.ok) throw new Error(`seat did not start: ${JSON.stringify(spawned)}`);

  // ---------------------------------------------------------------------------------------------
  console.log("A. the link dies and comes back: the attach says so, and keeps the seat");
  {
    const a = attachUnderPty(root); started.push(a);
    check("the attach comes up", await a.waitFor(/attached to rcseat/, 90_000), a.seen().slice(-400));
    check("seat output is flowing before the fault", await a.waitFor(/TICK-\d+/, 20_000), a.seen().slice(-400));

    const tSever = Date.now();
    await sever();
    const announced = await a.waitFor(/\[cotal: connection lost, reconnecting\]/, 30_000);
    // Detection latency is part of the defect: a frozen terminal that has not yet noticed is the
    // same experience as one that never will. Measured, not assumed, and printed either way.
    const detectMs = Date.now() - tSever;
    console.log(`    (sever to "connection lost": ${detectMs}ms)`);
    check("the link dying is announced on the terminal", announced, a.seen().slice(-600));
    // What this measures is CLOSE detection: the proxy destroys every socket, so the client learns
    // through a socket error. It is deliberately not a measurement of the client ping, which exists
    // for the other shape of dead link (half-open, no error, nothing arriving) that this harness
    // cannot produce -- deleting `pingInterval` leaves this number where it is.
    check("...within 30s of the link dying, on the socket closing under it",
      announced && detectMs < 30_000, { detectMs });
    check("...and the attach does NOT exit (it used to die of `gap` the moment the link returned)",
      a.exit() === undefined, a.exit());

    // The broker is unreachable at the reconnect step for several attempts (1s, 2s, 5s of backoff),
    // so the loop crosses the mesh resolve and its preflight while they cannot succeed. That path
    // ends the COMMAND for every other caller; here it must produce another wait.
    await wait(9_000);
    check("a broker that is down AT the reconnect step produces another wait, never an exit",
      a.exit() === undefined && !/run `cotal up`/.test(a.seen()), { exit: a.exit(), tail: a.seen().slice(-500) });

    await heal();
    check("the link healing is announced", await a.waitFor(/\[cotal: reconnected\]/, 60_000), a.seen().slice(-600));

    // The nonce is minted HERE, after the heal, so nothing replayed from the manager's backlog
    // snapshot can contain it, and the ECHO[...] wrapper is something only the seat writes.
    const nonce = `NONCE-${randomUUID().slice(0, 8)}`;
    const before = a.seen().length;
    a.write(`${nonce}\r`);
    const echoed = await a.waitFor(new RegExp(`ECHO\\[${nonce}\\]`), 30_000);
    check("seat output written AFTER the heal reaches the client", echoed, a.seen().slice(before).slice(-400));

    a.write(DETACH_BYTE);
    check("the detach key still detaches after a reconnect", await a.waitExit(30_000), a.seen().slice(-300));
    check("...cleanly, saying so", a.exit()?.code === 0 && /detached from rcseat/.test(a.seen()),
      { exit: a.exit(), tail: a.seen().slice(-300) });
  }

  // ---------------------------------------------------------------------------------------------
  console.log("\nB. the detach key works DURING a reconnect, not only while a session is up");
  {
    const a = attachUnderPty(root); started.push(a);
    check("the attach comes up", await a.waitFor(/attached to rcseat/, 90_000), a.seen().slice(-400));
    await sever();
    check("the reconnect is under way", await a.waitFor(/\[cotal: connection lost, reconnecting\]/, 30_000), a.seen().slice(-400));
    a.write(DETACH_BYTE);
    check("the detach key ends the attach mid-reconnect", await a.waitExit(20_000), a.seen().slice(-300));
    check("...exiting clean", a.exit()?.code === 0, a.exit());
    // Detaching while the link is still down leaves a session this client could not hand back, and
    // the exit is the only place an operator can learn that. This is the CLOSED-link half of that
    // rule: the connection is gone, so no frame is even attempted. Cell I below is the other half,
    // where the socket is still up and only the flush tells the truth.
    check("...saying the manager is still holding the session it could not hand back",
      /the manager still holds a session/.test(a.seen()), a.seen().slice(-600));
    await heal();
  }

  // ---------------------------------------------------------------------------------------------
  console.log("\nC. `--no-reconnect` exits the way it does today");
  {
    const a = attachUnderPty(root, ["--no-reconnect"]); started.push(a);
    check("the attach comes up", await a.waitFor(/attached to rcseat/, 90_000), a.seen().slice(-400));
    check("seat output is flowing", await a.waitFor(/TICK-\d+/, 20_000), a.seen().slice(-400));
    await sever();
    await wait(3_000); // let the serving rail advance seq into a subject nobody is subscribed to
    await heal();
    check("it exits", await a.waitExit(60_000), a.seen().slice(-400));
    check("...non-zero on the `gap` fault, with no reconnect attempted",
      a.exit()?.code === 1 && /mesh session transport error: gap/.test(a.seen()) && !/\[cotal: connection lost/.test(a.seen()),
      { exit: a.exit(), tail: a.seen().slice(-400) });
  }

  // ---------------------------------------------------------------------------------------------
  console.log("\nD. an outage LONGER than the serving side's own death still reconnects");
  {
    // The two arms of the original defect are the two sides of this boundary. Shorter than the
    // serving stall (cells A to C), the manager's rail is still healthy and still advancing `seq`,
    // and the old client died of `gap` when the link returned. LONGER, the rail fills its 64-frame
    // window, stalls, ends the session and closes, and both notices are published while the client
    // is away and lost: the old client then hung forever on a session nobody was serving, with no
    // output and no exit. At a 50ms tick the window fills in about 3s and the stall lands about
    // 33s in, so a 40s outage is on the far side of it.
    const a = attachUnderPty(root); started.push(a);
    check("the attach comes up", await a.waitFor(/attached to rcseat/, 90_000), a.seen().slice(-400));
    check("seat output is flowing", await a.waitFor(/TICK-\d+/, 20_000), a.seen().slice(-400));
    await sever();
    check("the loss is announced", await a.waitFor(/\[cotal: connection lost, reconnecting\]/, 30_000), a.seen().slice(-400));
    await wait(40_000); // past the serving rail's window-full + 30s stall watchdog
    check("the attach is still alive after the SERVING session has been torn down (it used to hang here)",
      a.exit() === undefined, { exit: a.exit(), tail: a.seen().slice(-400) });
    await heal();
    check("it reconnects to a NEW session", await a.waitFor(/\[cotal: reconnected\]/, 60_000), a.seen().slice(-500));
    const nonce = `LATE-${randomUUID().slice(0, 8)}`;
    a.write(`${nonce}\r`);
    check("...and seat output written after THAT heal reaches the client",
      await a.waitFor(new RegExp(`ECHO\\[${nonce}\\]`), 30_000), a.seen().slice(-400));
    a.write(DETACH_BYTE);
    check("...and it detaches clean", (await a.waitExit(30_000)) && a.exit()?.code === 0, a.exit());
  }

  // ---------------------------------------------------------------------------------------------
  console.log("\nI. a link that is UP but carries nothing: only the flush knows the close never left");
  {
    // The rule this cell exists for is that publishing is a local buffer write and the flush is the
    // round trip. Severing cannot test it: a destroyed socket closes the connection, so the client
    // never even attempts the frame. Holding the link keeps `isClosed()` false, so the frame IS
    // published, the flush is the only thing that can fail, and a client that mistook the publish
    // for delivery would drop the session silently and say nothing on the way out.
    const a = attachUnderPty(root); started.push(a);
    check("the attach comes up", await a.waitFor(/attached to rcseat/, 90_000), a.seen().slice(-400));
    const before = a.seen().length;
    check("seat output is flowing before the link goes half-open",
      await a.waitFor(/TICK-\d+/, 20_000), a.seen().slice(before).slice(-200));

    hold();
    a.write(DETACH_BYTE);
    // The detach itself is local, so it lands at once; the exit then waits out the flush deadline
    // and the drain deadline against a socket that will never answer, which is what bounds it.
    check("the detach key ends the attach while the link is up but carries nothing", await a.waitExit(40_000), a.seen().slice(-300));
    check("...exiting clean, rather than aborting on a wait that could not be bounded", a.exit()?.code === 0, a.exit());
    check("...saying the manager is still holding the session, because the close frame's flush never returned",
      /the manager still holds a session/.test(a.seen()), a.seen().slice(-600));
    // The proxy was never severed here, so it is still listening: releasing the hold is the whole
    // repair, and calling heal() would try to bind a port it already owns.
    unhold();
  }

  // ---------------------------------------------------------------------------------------------
  console.log("\nE. a seat despawned mid-reconnect ends the attach CLEAN");
  {
    const a = attachUnderPty(root); started.push(a);
    check("the attach comes up", await a.waitFor(/attached to rcseat/, 90_000), a.seen().slice(-400));
    await sever();
    check("the reconnect is under way", await a.waitFor(/\[cotal: connection lost, reconnecting\]/, 30_000), a.seen().slice(-400));
    // The manager is still connected to the broker; only the CLIENT is cut off. Despawn the seat
    // out from under the reconnect through the public path (a real `cotal stop`, dialling the
    // broker directly rather than the severed proxy), then let the link back so the next attempt
    // gets a real answer instead of silence.
    const stopped = await cotal(["stop", "--name", SEAT, "--space", space, "--server", BROKER], root);
    if (stopped.status !== 0) throw new Error(`stop failed (${stopped.status}): ${stopped.out.slice(-400)}`);
    await heal();
    check("the attach exits", await a.waitExit(90_000), a.seen().slice(-500));
    check("...clean, saying the seat is gone (not an infinite retry against something that is not there)",
      a.exit()?.code === 0 && /seat rcseat is gone/.test(a.seen()), { exit: a.exit(), tail: a.seen().slice(-500) });
    check("...and it does NOT claim a detach", !/detached from rcseat/.test(a.seen()), a.seen().slice(-500));
  }

  // ---------------------------------------------------------------------------------------------
  console.log("\nG. a FIRST attach against a mesh that is not there refuses the way it always did");
  {
    // The reconnect flag is on by default, so the loop's "survive a refusal" path is armed from the
    // very first attempt. It must not be TAKEN on that attempt. A refusal that escapes as an
    // exception is rendered by the dispatcher's generic handler, which prefixes `✗` onto a sentence
    // that already opens with one and drops the refusal's hint, so keying the throwing form off the
    // flag instead of off `first` silently degraded the oldest error message this command has.
    //
    // `--on` is the path that reaches it: with an instance pinned, `pinForTarget` returns before
    // `locateSeat`, so this is the first thing that touches the broker. Without `--on` the refusal
    // comes from `locateSeat` and never gets near the loop.
    const { loadManagerInstanceIdentity } = await import("@cotal-ai/workspace");
    const instance = loadManagerInstanceIdentity(root, space)?.instanceId;
    check("the manager's instance id is available to pin", typeof instance === "string" && instance.length > 0, instance);
    await sever();
    const r = await cotal(["attach", "--name", SEAT, "--on", String(instance), "--space", space, "--server", PROXY], root, 60_000);
    await heal();
    check("it exits non-zero", r.status !== 0, { status: r.status, out: r.out.slice(-400) });
    check("...saying the mesh is not there, in the CLI's own words", /no mesh running at/.test(r.out), r.out.slice(-400));
    check("...with ONE failure mark, not the doubled one a rethrown refusal renders",
      !/✗\s*✗/.test(r.out), r.out.slice(-400));
    check("...and it never announced a reconnect it was not going to make",
      !/\[cotal: connection lost, reconnecting\]/.test(r.out), r.out.slice(-400));
  }

  // ---------------------------------------------------------------------------------------------
  console.log("\nH. a reconnect hands the abandoned session back, so the manager does not lose the slot");
  {
    // Every other cell runs against a seat that TICKS, and a ticking seat fills the manager's send
    // window, which arms the rail's stall watchdog and reaps the abandoned session for free. This
    // cell uses a SILENT seat, where nothing on the serving side reaps anything: the watchdog only
    // arms once the window is FULL (`endpoint-session-rail.ts`) and the bridge has no expiry timer.
    // Measured before the fix, against this same manager: 45s of dead link left the count at 1, and
    // the reconnect took it to 2 — one of the manager's 64 slots per outage, held until the seat or
    // the manager ends it.
    const QUIET = "rcquiet";
    writeFileSync(join(root, ".cotal", "agents", `${QUIET}.md`), `---\nname: ${QUIET}\nrole: worker\n---\n`);
    const q = await manager.startAgent({ name: QUIET, agent: "rc-seat-quiet", cwd: repoRoot });
    if (!q.ok) throw new Error(`quiet seat did not start: ${JSON.stringify(q)}`);
    // The manager's own accounting, read off the plane the ceiling is enforced against.
    const live = (): number => (manager as unknown as { sessionPlane?: { liveSessions: number } }).sessionPlane?.liveSessions ?? -1;
    const settle = async (want: number, ms: number): Promise<number> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline && live() !== want) await wait(200);
      return live();
    };

    const before = live();
    const a = attachUnderPty(root, [], QUIET); started.push(a);
    check("the attach to the silent seat comes up", await a.waitFor(new RegExp(`attached to ${QUIET}`), 90_000), a.seen().slice(-400));
    const withOne = live();
    check("...and the manager counts one more live session", withOne === before + 1, { before, withOne });

    await sever();
    check("the reconnect is under way", await a.waitFor(/\[cotal: connection lost, reconnecting\]/, 30_000), a.seen().slice(-400));
    // Well past the 30s stall watchdog, with the caller gone. Nothing reaps this — the honest half
    // of the cell, and the whole reason the client has to say so itself.
    await wait(35_000);
    const orphaned = live();
    check("a silent seat's session is NOT reaped while the caller is away (the watchdog never arms)",
      orphaned === withOne, { withOne, orphaned });

    await heal();
    check("the link healing is announced", await a.waitFor(/\[cotal: reconnected\]/, 90_000), a.seen().slice(-600));
    const after = await settle(withOne, 20_000);
    check("...and the reconnect left ONE live session, not two: the abandoned one was handed back",
      after === withOne, { before, withOne, orphaned, after });

    // Put the seat back the way this cell found it, and assert it: an attach left running here
    // would be severed by the next cell and would move the counts it reads.
    a.write(DETACH_BYTE);
    check("...and detaching afterwards frees that one too", await a.waitExit(30_000) && a.exit()?.code === 0, a.exit());
    const idle = await settle(before, 20_000);
    check("...leaving the manager on the count it started with", idle === before, { before, idle });

    // -------------------------------------------------------------------------------------------
    console.log("\nJ. the detach key during the backoff, on a link that came BACK, hands the session back");
    // The leak the hand-back exists to close has one more way in, and it is an ordinary operator
    // action rather than an exotic one: the link dies, the client records the session it could not
    // hand back, the link comes back, and the operator presses the detach key during the wait
    // before the next attempt. Exiting there without dialling would leave a slot held that a single
    // connection would have freed, and would then say so as though nothing could be done. The wait
    // below is long enough that the detach cannot be raced by the next attempt: after 40s of failed
    // attempts the backoff is on its 30s rung, so the heal lands mid-wait rather than mid-attempt.
    const baseJ = live();
    const b = attachUnderPty(root, [], QUIET); started.push(b);
    check("the attach comes up", await b.waitFor(new RegExp(`attached to ${QUIET}`), 90_000), b.seen().slice(-400));
    check("...and the manager counts one more live session", live() === baseJ + 1, { baseJ, now: live() });

    await sever();
    check("the reconnect is under way", await b.waitFor(/\[cotal: connection lost, reconnecting\]/, 30_000), b.seen().slice(-400));
    await wait(40_000);
    await heal();
    b.write(DETACH_BYTE);
    check("the detach key ends the attach during the backoff", await b.waitExit(30_000), b.seen().slice(-300));
    check("...exiting clean", b.exit()?.code === 0, b.exit());
    check("...without ever re-establishing, so this is the backoff path and not a reconnect",
      !/\[cotal: reconnected\]/.test(b.seen()), b.seen().slice(-600));
    check("...saying NOTHING about a held session, because it handed the session back on the way out",
      !/the manager still holds/.test(b.seen()), b.seen().slice(-600));
    const freed = await settle(baseJ, 20_000);
    check("...and the manager is back to the count it started with, with no slot left behind",
      freed === baseJ, { baseJ, freed });
  }

  // ---------------------------------------------------------------------------------------------
  console.log("\nF. the four classifications the loop turns on");
  check("transport-class: the rail's own fault vocabulary reconnects",
    ["gap", "stall", "subscription", "peer-closed", "connection-closed", "publish", "flood", "credit-overrun", "garbled-frame", "handler", "seq-exhausted", "closed"]
      .every((r) => isTransportEnd(r)));
  check("transport-class: an operator detach is NOT a transport end", !isTransportEnd("detached"));
  check("transport-class: the manager's terminal reasons are NOT transport ends",
    ["process-exit", "target-despawn", "manager-restart", "expired"].every((r) => !isTransportEnd(r)));
  check("refusal: permission-denied gives up", attachRefusal("permission-denied") === "denied");
  check("refusal: not-found means the seat is gone", attachRefusal("not-found") === "gone");
  check("refusal: anything else is worth another attempt",
    attachRefusal("unavailable") === "transient" && attachRefusal(undefined) === "transient" && attachRefusal("failed-precondition") === "transient");
  check("notice: the manager's own refusal is relayed while the loop keeps trying",
    reconnectNotice({ fromManager: true, message: "the manager is already serving its maximum of 64 concurrent sessions" }, "")
      === "[cotal: the manager is already serving its maximum of 64 concurrent sessions]");
  check("notice: a steady refusal is said once, not on every attempt",
    reconnectNotice({ fromManager: true, message: "same refusal" }, "same refusal") === undefined);
  check("notice: a LOCAL refusal is not relayed (its copy is written for someone who just typed a command)",
    reconnectNotice({ message: "✗ no mesh running at nats://127.0.0.1:4222 - run `cotal up`" }, "") === undefined);
  check("held: a session the loop could not hand back is named on exit",
    heldSessionNotice(1, "ended")?.includes("still holds a session") === true);
  check("held: more than one is counted rather than collapsed",
    heldSessionNotice(3, "failed")?.includes("still holds 3 sessions") === true);
  check("held: nothing pending says nothing", heldSessionNotice(0, "ended") === undefined);
  check("held: a seat that is GONE took its own sessions with it, so there is nothing to warn about",
    heldSessionNotice(2, "gone") === undefined);

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} - ${pass} passed, ${fail} failed`);
} finally {
  for (const a of started) a.kill();
  await sever();
  await manager?.stop().catch(() => {});
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
process.exit(fail === 0 ? 0 : 1);
