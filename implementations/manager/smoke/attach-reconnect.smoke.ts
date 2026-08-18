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
 *   B. the detach key detaches DURING a reconnect, not only while a session is up.
 *   C. `--no-reconnect` still exits the way it does today: non-zero, on the transport fault.
 *   D. a seat despawned while the client is reconnecting ends the attach CLEAN, saying the seat is
 *      gone, rather than retrying forever against something that no longer exists.
 *   E. the two classifications the loop turns on, as functions.
 *
 * ON CELL E. It builds its inputs by hand, so on its own it would prove only that the suite
 * depends on those functions. The reachability it does not prove is proven beside it: cell D
 * drives `attachRefusal("not-found")` through the real `cotal attach` binary end to end, and cells
 * A/B/C drive `isTransportEnd` the same way. Cell E then pins the REMAINING inputs of the same two
 * functions, which no end-to-end fault in this harness can produce (a static single-owner mesh
 * mints an admin instrument for every attach, so the manager has no reason to answer
 * `permission-denied`).
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
import { attachRefusal } from "../../cli/src/commands/agents.js"; // dev-only cross-impl smoke import
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
const heal = (): Promise<void> =>
  new Promise((res, rej) => {
    const s = createServer((client) => {
      const up = netConnect(BROKER_PORT, "127.0.0.1");
      liveSockets.add(client); liveSockets.add(up);
      const drop = () => { liveSockets.delete(client); liveSockets.delete(up); client.destroy(); up.destroy(); };
      for (const ev of ["error", "close"] as const) { client.on(ev, drop); up.on(ev, drop); }
      client.pipe(up); up.pipe(client);
    });
    s.on("error", rej);
    s.listen(PROXY_PORT, "127.0.0.1", () => { proxy = s; res(); });
  });
const sever = (): Promise<void> =>
  new Promise((res) => {
    const s = proxy; proxy = undefined;
    for (const sock of liveSockets) sock.destroy();
    liveSockets.clear();
    if (!s) return res();
    s.close(() => res());
  });

const envFor = (o: LaunchOpts): Record<string, string> => ({
  COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? BROKER), COTAL_CREDS: String(o.creds),
  COTAL_ID: String(o.id), COTAL_NAME: o.name, PATH: process.env.PATH ?? "",
  ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
});
registry.register({
  kind: "connector", name: "rc-seat", requires: ["node"],
  buildLaunch: (o): LaunchSpec => ({ command: process.execPath, args: [SEAT_STUB], env: envFor(o) }),
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
function attachUnderPty(root: string, extra: string[] = []): Attached {
  const child = pty.spawn("npx", ["tsx", BIN, "attach", "--name", SEAT, "--space", space, "--server", PROXY, ...extra], {
    name: "xterm-256color", cols: 100, rows: 30, cwd: root,
    env: { ...process.env, COTAL_HOME: home, COTAL_SPACE: "", COTAL_SERVERS: "", COTAL_CREDS: "" } as Record<string, string>,
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
      cwd, env: { ...process.env, COTAL_HOME: home, COTAL_SPACE: "", COTAL_SERVERS: "", COTAL_CREDS: "" },
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

    await sever();
    check("the link dying is announced on the terminal",
      await a.waitFor(/\[cotal: connection lost, reconnecting\]/, 30_000), a.seen().slice(-600));
    check("...and the attach does NOT exit (it used to die of `gap` the moment the link returned)",
      a.exit() === undefined, a.exit());

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
    check("...non-zero, naming the transport fault, with no reconnect attempted",
      a.exit()?.code === 1 && /mesh session transport error/.test(a.seen()) && !/\[cotal: connection lost/.test(a.seen()),
      { exit: a.exit(), tail: a.seen().slice(-400) });
  }

  // ---------------------------------------------------------------------------------------------
  console.log("\nD. a seat despawned mid-reconnect ends the attach CLEAN");
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
  console.log("\nE. the two classifications the loop turns on");
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
