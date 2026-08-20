/**
 * Can this harness produce a transport-class session end with the SOCKET still alive? The whole
 * attach-stdin gate runs on faults that kill the connection first, and on those the hand-back's
 * flush is a skipped branch, so the statement order inside the session `finally` is unobservable.
 * Run: pnpm probe:live-socket-gap
 *
 * WHY IT MATTERS. `ownStdin()` sits at the top of that `finally` so the keyboard has an owner while
 * the session is handed back. Below it are a publish, a flush and a close, each bounded by
 * LINK_DEADLINE_MS, and they only actually run when `est.nc` is still open. If no cell can reach
 * that state then moving the line is unproven either way, and an unproven line is what the review
 * found the first time.
 *
 * THE CONSTRUCTION. A `gap`: the caller's rail raises it the moment a data frame is missing and the
 * next one lands (endpoint-session-rail.ts), it is in TRANSPORT_END_REASONS, and it does nothing to
 * the connection. So the proxy learns to read NATS framing on the broker-to-client direction and
 * drop whole MSG frames for a window, passing PING, PONG and INFO through untouched. The link is
 * also SLOW, because a flush over loopback is a millisecond and the window has to be wide enough to
 * be typed into on purpose.
 *
 * Its scaffolding is the gate's, copied rather than imported so the two can drift apart safely: the
 * link states it does not use are part of that copy and are left in place, because a probe that has
 * to be re-cut for the next question is a probe nobody re-cuts.
 *
 * WHAT IT REPORTS, and it asserts nothing: whether the drop produces a reconnect at all, whether
 * the client's socket was still open when it did, and how wide the hand-back window measures.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { Manager } from "../src/manager.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const BIN = join(repoRoot, "bin", "cotal.ts");
const SEAT_STUB = join(here, "attach-stdin-seat.mjs");
const DETACH = "\x1d";
const SEAT = "stdinseat";

let pass = 0;
let fail = 0;
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
process.env.COTAL_HOME = home;
// The connector seed store lives under `globalConfigDir()`, not COTAL_HOME, so without this the
// suite reads the operator's real `~/.config/cotal` and a newer seed generation refuses every cell
// with a version message that looks exactly like a behaviour red.
process.env.XDG_CONFIG_HOME = join(dir, "xdg");
mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
const space = `stdin-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const SINK = join(dir, "seat-input.bin");
const PIDSINK = join(dir, "seat.pid");
writeFileSync(SINK, "");

// A fast-ping broker, so a dead link is noticed in seconds rather than in the stock two minutes.
writeFileSync(
  join(dir, "server.conf"),
  serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: BROKER_PORT, storeDir: join(dir, "js") }) +
    `\nping_interval: "2s"\nping_max: 1\n`,
);
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

// --- the faultable link, in its three states ----------------------------------------------------
const liveSockets = new Set<Socket>();
let proxy: Server | undefined;
const knocks: number[] = [];
let onKnock: (() => void) | undefined;
const fireKnock = () => { knocks.push(Date.now()); const h = onKnock; onKnock = undefined; h?.(); };
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
/** Severed but LOUD: every dial lands here, is timestamped, and is reset. A failed attempt to the
 *  client either way, and the only way to know WHEN it is attempting. */
const severLoud = (): Promise<void> =>
  new Promise((res, rej) => {
    knocks.length = 0;
    const s = createServer((sock) => { fireKnock(); sock.destroy(); });
    s.on("error", rej);
    s.listen(PROXY_PORT, "127.0.0.1", () => { proxy = s; res(); });
  });
/** SLOW: up and correct, but every frame arrives late. Nothing here is a fault; it is the round trip
 *  a real operator has and a loopback does not, and it is the only way to make the window between
 *  "the reconnect is announced" and "the session is ready" wide enough to type into on purpose.
 *  Equal delays preserve order, so this changes the clock and nothing else. */
const healSlow = (delayMs: number): Promise<void> =>
  new Promise((res, rej) => {
    knocks.length = 0;
    const s = createServer((client) => {
      const up = netConnect(BROKER_PORT, "127.0.0.1");
      liveSockets.add(client); liveSockets.add(up);
      fireKnock();
      const drop = () => { liveSockets.delete(client); liveSockets.delete(up); client.destroy(); up.destroy(); };
      for (const ev of ["error", "close"] as const) { client.on(ev, drop); up.on(ev, drop); }
      const relay = (from: Socket, to: Socket) =>
        from.on("data", (b) => { setTimeout(() => { if (!to.destroyed) to.write(b); }, delayMs); });
      relay(client, up); relay(up, client);
    });
    s.on("error", rej);
    s.listen(PROXY_PORT, "127.0.0.1", () => { proxy = s; res(); });
  });
/** HELD: the dial connects and then nothing ever comes back. This is what holds an establishment
 *  open long enough for a key pressed in the middle of one to be pressed in the middle of one. */
const holdOpen = (): Promise<void> =>
  new Promise((res, rej) => {
    knocks.length = 0;
    const s = createServer((sock) => { liveSockets.add(sock); fireKnock(); });
    s.on("error", rej);
    s.listen(PROXY_PORT, "127.0.0.1", () => { proxy = s; res(); });
  });
const closeLink = (): Promise<void> =>
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
  COTAL_INPUT_SINK: SINK, COTAL_PID_SINK: PIDSINK,
  ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
});
registry.register({
  kind: "connector", name: "stdin-seat", requires: ["node"],
  buildLaunch: (o): LaunchSpec => ({ command: process.execPath, args: [SEAT_STUB], env: envFor(o) }),
} as Connector);

type Attached = {
  seen: () => string;
  write: (s: string) => void;
  exit: () => { code: number; signal: number } | undefined;
  waitFor: (re: RegExp, ms: number) => Promise<boolean>;
  waitExit: (ms: number) => Promise<boolean>;
  kill: () => void;
};
const started: Attached[] = [];
function attachUnderPty(root: string): Attached {
  const child = pty.spawn("npx", ["tsx", BIN, "attach", "--name", SEAT, "--space", space, "--server", PROXY], {
    name: "xterm-256color", cols: 100, rows: 30, cwd: root,
    env: { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, COTAL_SPACE: "", COTAL_SERVERS: "", COTAL_CREDS: "" } as Record<string, string>,
  });
  let buf = "";
  let exited: { code: number; signal: number } | undefined;
  child.onData((d) => { buf += d; });
  child.onExit((e) => { exited = { code: e.exitCode, signal: e.signal ?? 0 }; });
  const seen = () => buf;
  const a: Attached = {
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
  started.push(a);
  return a;
}

/** The same command with stdin as a PIPE rather than a terminal: what a script gets. Kept separate
 *  from the pty helper because the difference between the two is the whole point of the cell that
 *  uses it. */
type Piped = { seen: () => string; write: (s: string) => void; exit: () => number | undefined; waitExit: (ms: number) => Promise<boolean>; kill: () => void };
const pipedChildren: Piped[] = [];
function attachPiped(root: string): Piped {
  const child = spawn("npx", ["tsx", BIN, "attach", "--name", SEAT, "--space", space, "--server", PROXY], {
    cwd: root,
    env: { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, COTAL_SPACE: "", COTAL_SERVERS: "", COTAL_CREDS: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  let code: number | undefined;
  child.stdout.on("data", (d) => { buf += String(d); });
  child.stderr.on("data", (d) => { buf += String(d); });
  child.on("close", (c) => { code = c ?? 0; });
  const p: Piped = {
    seen: () => buf,
    write: (str) => { child.stdin.write(str); },
    exit: () => code,
    kill: () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } },
    waitExit: async (ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) { if (code !== undefined) return true; await wait(100); }
      return code !== undefined;
    },
  };
  pipedChildren.push(p);
  return p;
}

const sink = (): Buffer => readFileSync(SINK);
const seatPid = (): number => Number(readFileSync(PIDSINK, "utf8"));
const seatAlive = (): boolean => { try { process.kill(seatPid(), 0); return true; } catch { return false; } };
const saidReconnected = (a: Attached): number => (a.seen().match(/\[cotal: reconnected\]/g) ?? []).length;
const nonce = (): string => `N${randomUUID().slice(0, 8).toUpperCase()}`;

let manager: InstanceType<typeof Manager> | undefined;
// --- the same slow link, able to LOSE a frame without losing the connection ----------------------
let dropping = false;
let droppedFrames = 0;
let sawClientPing: (() => void) | undefined;
const clientSocketClosedAt: number[] = [];
/** SLOW, and lossy on demand. The broker-to-client direction is parsed into NATS frames so a whole
 *  MSG can be removed while every control line still gets through: the connection stays healthy and
 *  only the rail notices. Client-to-broker is untouched apart from the same delay, except that a
 *  PING is announced, because the client's flush is a PING and that is the one observable edge of
 *  the hand-back window. */
const healSlowLossy = (delayMs: number): Promise<void> =>
  new Promise((res, rej) => {
    knocks.length = 0;
    const s = createServer((client) => {
      const up = netConnect(BROKER_PORT, "127.0.0.1");
      liveSockets.add(client); liveSockets.add(up);
      fireKnock();
      const drop = () => { liveSockets.delete(client); liveSockets.delete(up); clientSocketClosedAt.push(Date.now()); client.destroy(); up.destroy(); };
      for (const ev of ["error", "close"] as const) { client.on(ev, drop); up.on(ev, drop); }
      client.on("data", (b) => {
        if (b.includes("PING\r\n")) { const h = sawClientPing; sawClientPing = undefined; h?.(); }
        const copy = Buffer.from(b);
        setTimeout(() => { if (!up.destroyed) up.write(copy); }, delayMs);
      });
      let buf = Buffer.alloc(0);
      up.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          const nl = buf.indexOf("\r\n");
          if (nl < 0) break;
          const line = buf.subarray(0, nl).toString("latin1");
          const sp = line.indexOf(" ");
          const verb = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
          let total = nl + 2;
          let isMsg = false;
          if (verb === "MSG" || verb === "HMSG") {
            const parts = line.trim().split(/\s+/);
            const n = Number(parts[parts.length - 1]);
            if (Number.isFinite(n)) {
              total = nl + 2 + n + 2;
              isMsg = true;
              if (buf.length < total) break; // the payload has not all arrived yet
            }
          }
          const frame = Buffer.from(buf.subarray(0, total));
          buf = buf.subarray(total);
          if (isMsg && dropping) { droppedFrames++; continue; }
          setTimeout(() => { if (!client.destroyed) client.write(frame); }, delayMs);
        }
      });
    });
    s.on("error", rej);
    s.listen(PROXY_PORT, "127.0.0.1", () => { proxy = s; res(); });
  });

const DELAY = 500;

try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(BROKER)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${BROKER_PORT}`);
  await setupSpaceStreams({ servers: BROKER, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  await healSlowLossy(DELAY);

  const root = join(dir, "ws");
  mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(root, ".cotal", "agents", `${SEAT}.md`), `---\nname: ${SEAT}\nrole: worker\n---\n`);
  saveSpaceAuth(authDir(root), auth);
  const { recordMesh } = await import("@cotal-ai/workspace");
  recordMesh({ space, server: BROKER, root, mode: "auth", ts: new Date().toISOString() });

  manager = new Manager({ space, servers: BROKER, runtime: "pty", workspaceRoot: root });
  await manager.start();
  const st = await manager.startAgent({ name: SEAT, agent: "stdin-seat", cwd: repoRoot });
  if (!st.ok) throw new Error(`seat did not start: ${JSON.stringify(st)}`);
  for (let i = 0; i < 60 && !seatAlive(); i++) await wait(200);

  const a = attachUnderPty(root);
  if (!await a.waitFor(new RegExp(`attached to ${SEAT}`), 120_000)) throw new Error(`attach never came up over the slow lossy link: ${a.seen().slice(-500)}`);
  console.log(`attach is up over a ${DELAY}ms-per-chunk link that parses every broker frame`);
  await wait(1000);

  // The seat echoes what it is typed, so a burst of lines is a burst of data frames. Drop them for
  // a window and then stop: the first frame delivered after the window is ahead of what the rail
  // expects, which is the gap.
  const pingSeen = new Promise<number>((r) => { sawClientPing = () => r(Date.now()); });
  const armedAt = Date.now();
  dropping = true;
  for (let i = 0; i < 6; i++) { a.write(`echo-${i}\r`); await wait(120); }
  await wait(600);
  dropping = false;
  console.log(`dropped ${droppedFrames} broker-to-client MSG frames over ~${Date.now() - armedAt}ms`);
  for (let i = 0; i < 4; i++) { a.write(`after-${i}\r`); await wait(150); }

  const announced = await a.waitFor(/\[cotal: connection lost, reconnecting\]/, 30_000);
  const announcedAt = Date.now();
  console.log(`reconnect announced: ${announced} (${announcedAt - armedAt}ms after arming)`);
  const pingAt = await Promise.race([pingSeen, wait(1).then(() => 0)]);
  if (pingAt) console.log(`the client's hand-back flush left at ${pingAt - armedAt}ms, so the window it opens is ${announcedAt - pingAt}ms wide`);
  else console.log("no client PING was seen, so the hand-back flush did not run: the connection was already closed");
  console.log(`client sockets closed by the proxy before the announcement: ${clientSocketClosedAt.filter((t) => t <= announcedAt).length} (0 means the socket outlived the fault)`);
  const back = await a.waitFor(/\[cotal: reconnected\]/, 60_000);
  console.log(`reconnected: ${back}`);
  console.log(`--- tail ---\n${a.seen().slice(-600)}`);

  a.write(DETACH);
  await a.waitExit(30_000);
  console.log(`exit: ${JSON.stringify(a.exit())}`);
} finally {
  for (const x of started) x.kill();
  for (const p of pipedChildren) p.kill();
  await manager?.stop().catch(() => {});
  await closeLink();
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
