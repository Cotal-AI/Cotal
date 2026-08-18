/**
 * Who owns stdin while `cotal attach` has no session, and what reaches the AGENT when nobody does.
 * Run: pnpm smoke:attach-stdin   (needs nats-server + node on PATH; boots its own broker). (#585)
 *
 * THE DEFECT, as measured before the fix existed. `watchDetachKey` was installed for the duration
 * of a backoff WAIT and stopped, with `stdin.pause()`, before each attempt; `attachClient` installs
 * its own reader in `onReady`, after the session is open, and resumes stdin there. Between those
 * two points nothing was reading and the stream buffered, so that `stdin.resume()` flushed whatever
 * had been typed at a frozen terminal straight into the seat's pty. Graded at the seat rather than
 * on screen: typed during a wait, dropped; during a FAILED attempt, dropped; during an attempt that
 * SUCCEEDED, DELIVERED, and a 0x03 there arrived as a real SIGINT at the agent, which recorded the
 * signal and exited. The detach key struck in that same window was not a detach either: it was
 * flushed into the session that had just opened and forwarded to the agent as data.
 *
 * WHERE THE CELLS GRADE, and why there. Every replay cell asks the SEAT what it received, through
 * a stub that appends every byte it reads to a file: the client's screen cannot answer this,
 * because a local terminal echo and a byte that crossed the mesh look identical on it. The Ctrl-C
 * cell grades the seat's PID, not the manager's session count, because a count that returns to base
 * is equally consistent with an agent that died and one that never noticed.
 *
 * WHY THE TIMING IS MEASURED AND NOT WAITED FOR. The window is one round trip wide, so the cells
 * act from INSIDE the proxy's connection handler on the client's own dial (issue #582 is the same
 * lesson from the other side). The link has three states here: healed; severed but LOUD, where the
 * port keeps listening and destroys what it accepts, so every dial is a timestamped knock; and
 * HELD, where the port accepts and then answers nothing, which is how an attempt is kept in flight
 * long enough to type into the middle of it.
 *
 * WHAT EACH CELL PROVES:
 *   A. bytes typed in the WAIT between attempts never reach the agent. Its premise is measured:
 *      it types only once the client's own dials have been quiet long enough to be between them.
 *   B. bytes typed during an attempt that FAILS never reach the agent (a HELD link, so the attempt
 *      is genuinely in flight while the key is struck). Its premise is measured too, and had to be:
 *      an establishment on a held link runs to the 5s link deadline, so a hold that ends before
 *      that heals an attempt still IN FLIGHT, and the client's own re-dial is the only proof the
 *      attempt is over. A witness, not a boundary: with the premise true, a revert delivers the
 *      nonce to the seat as the next session opens.
 *   C. bytes typed during an attempt that SUCCEEDS never reach the agent, and typing into the
 *      session that came up still does. The second half matters: dropping everything would pass
 *      the first.
 *   D. Ctrl-C in that window does not reach the agent as a signal, graded on its pid.
 *   E. the detach key in that window ends the attach, does not reach the agent as data, and hands
 *      the late-landing session back, so the manager's count returns to base with no slot leaked.
 *   F. a detach byte sharing one read with another byte is not a detach and is not delivered.
 *   G. the same chunk in a LIVE session is data, forwarded with the 0x1d in it, and still not a
 *      detach: that is the cost of the exact-match test, paid where it is paid.
 *   H. the detach key pressed after the reconnect is ANNOUNCED but before the session is READY still
 *      detaches. That window is a round trip wide, so this cell runs over a fourth link state: up,
 *      correct, and slow.
 *   I. the same defect on the commonest path of all: bytes typed at a TERMINAL before the FIRST
 *      attach comes up never reach the agent either.
 *   J. the boundary of I, and the reason the reader is for terminals only: with stdin a PIPE, what
 *      a script wrote before the session opened is still delivered, and a lone detach byte on a
 *      pipe still detaches.
 *   K. a detach pressed while a faulted session is being HANDED BACK is still a keypress. This one
 *      needs a fifth link state, slow and lossy, because it is the only one that ends a session
 *      without closing the socket, which is the only way the hand-back's own round trips run at all.
 *   L. J again, in every OTHER window: a pipe that RECONNECTS still delivers what the script wrote
 *      while there was no session, so `tail -f log | cotal attach` loses nothing. This is the cell a
 *      lens footnote asked for, and it was red before the population test moved inside `ownStdin`.
 *   M. a piped attach with `--no-reconnect` gives the process back when it detaches. The route with
 *      no reader anywhere: it is where releasing the stream stopped happening once the gate was
 *      honoured, because the release had been hiding inside the detach watcher's `stop`.
 *   N. the third stream kind. A stdin that is a FILE has no `unref` at all, so the exit release
 *      crashed there while the pty and pipe cells all passed; CI found it in another suite.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
/** SLOW, and able to LOSE a frame without losing the CONNECTION. Every other state here kills the
 *  socket, and on those the hand-back below a faulted session is a skipped branch, so the order of
 *  the statements inside it is unobservable. A `gap` is the way in: the caller's rail raises it the
 *  moment a data frame is missing and the next one lands, it is transport-class, and it does nothing
 *  to the link. So this reads NATS framing on the broker-to-client direction and removes whole MSG
 *  frames while armed, passing PING, PONG and INFO through untouched; the connection stays healthy
 *  and only the rail notices. The client's own PING is announced because a flush IS a PING, and that
 *  is the one edge of the hand-back window visible from outside the process. */
let dropping = false;
let droppedFrames = 0;
let sawClientPing: (() => void) | undefined;
const healSlowLossy = (delayMs: number): Promise<void> =>
  new Promise((res, rej) => {
    knocks.length = 0;
    dropping = false; droppedFrames = 0;
    const s = createServer((client) => {
      const up = netConnect(BROKER_PORT, "127.0.0.1");
      liveSockets.add(client); liveSockets.add(up);
      fireKnock();
      const drop = () => { liveSockets.delete(client); liveSockets.delete(up); client.destroy(); up.destroy(); };
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
type Piped = { seen: () => string; write: (s: string) => void; exit: () => number | undefined; waitFor: (re: RegExp, ms: number) => Promise<boolean>; waitExit: (ms: number) => Promise<boolean>; kill: () => void };
const pipedChildren: Piped[] = [];
function attachPiped(root: string, extra: readonly string[] = []): Piped {
  const child = spawn("npx", ["tsx", BIN, "attach", "--name", SEAT, "--space", space, "--server", PROXY, ...extra], {
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
    waitFor: async (re, ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) { if (re.test(buf)) return true; await wait(100); }
      return re.test(buf);
    },
    waitExit: async (ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) { if (code !== undefined) return true; await wait(100); }
      return code !== undefined;
    },
  };
  pipedChildren.push(p);
  return p;
}

/** The same command with stdin a FILE rather than a pipe or a terminal, which is a THIRD stream kind
 *  and not a spelling of the second: measured, a terminal gives `tty.ReadStream` and a pipe
 *  `net.Socket`, both sockets with an `unref`, while a file gives `fs.ReadStream`, which has none. A
 *  parent that spawns with stdio "ignore" lands on the same `fs.ReadStream`, so this helper covers
 *  that route too; the file is the one an operator writes by hand. */
function attachFromFile(root: string, contents: string, extra: readonly string[] = []): Piped {
  const path = join(dir, `stdin-${randomUUID().slice(0, 8)}.txt`);
  writeFileSync(path, contents);
  const fd = openSync(path, "r");
  const child = spawn("npx", ["tsx", BIN, "attach", "--name", SEAT, "--space", space, "--server", PROXY, ...extra], {
    cwd: root,
    env: { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, COTAL_SPACE: "", COTAL_SERVERS: "", COTAL_CREDS: "" },
    stdio: [fd, "pipe", "pipe"],
  });
  let buf = "";
  let code: number | undefined;
  child.stdout.on("data", (d) => { buf += String(d); });
  child.stderr.on("data", (d) => { buf += String(d); });
  child.on("close", (c) => { code = c ?? 0; });
  const p: Piped = {
    seen: () => buf,
    write: () => { throw new Error("a file-backed stdin is written before the spawn, not after it"); },
    exit: () => code,
    kill: () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } },
    waitFor: async (re, ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) { if (re.test(buf)) return true; await wait(100); }
      return re.test(buf);
    },
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
  const { recordMesh } = await import("@cotal-ai/workspace");
  recordMesh({ space, server: BROKER, root, mode: "auth", ts: new Date().toISOString() });

  manager = new Manager({ space, servers: BROKER, runtime: "pty", workspaceRoot: root });
  await manager.start();
  const s = await manager.startAgent({ name: SEAT, agent: "stdin-seat", cwd: repoRoot });
  if (!s.ok) throw new Error(`seat did not start: ${JSON.stringify(s)}`);
  for (let i = 0; i < 60 && !seatAlive(); i++) await wait(200);
  const live = (): number => (manager as unknown as { sessionPlane?: { liveSessions: number } }).sessionPlane?.liveSessions ?? -1;
  const settle = async (target: number, ms: number): Promise<number> => {
    const deadline = Date.now() + ms;
    for (;;) { const n = live(); if (n === target || Date.now() > deadline) return n; await wait(200); }
  };

  /** One attach, up and reading, with the seat's byte count marked. */
  const attached = async (): Promise<{ a: Attached; mark: number }> => {
    const a = attachUnderPty(root);
    if (!await a.waitFor(new RegExp(`attached to ${SEAT}`), 90_000)) throw new Error(`attach never came up: ${a.seen().slice(-400)}`);
    await wait(500);
    return { a, mark: sink().length };
  };
  /** Sever the link and wait for the client to say so, which is the start of every window below. */
  const loseTheLink = async (a: Attached): Promise<void> => {
    await closeLink();
    await severLoud();
    if (!await a.waitFor(/\[cotal: connection lost, reconnecting\]/, 30_000)) throw new Error("the loss was never announced");
  };
  /** Resolve on the client's next dial, from INSIDE the connection handler: the only moment early
   *  enough to act on the attempt that dial belongs to rather than on the one after it. */
  const nextDial = (): Promise<void> => new Promise((r) => { onKnock = () => r(); });
  const detachAndSettle = async (a: Attached, base: number, label: string): Promise<void> => {
    a.write(DETACH);
    check(`${label}: the attach detaches and exits clean`, await a.waitExit(30_000) && a.exit()?.code === 0, a.exit());
    check(`${label}: the manager is back on the session count it started with`, await settle(base, 20_000) === base, { base, now: live() });
  };

  // -----------------------------------------------------------------------------------------
  console.log("\nA. bytes typed while the loop is WAITING never reach the agent");
  {
    const base = live();
    const { a, mark } = await attached();
    const n = nonce();
    await loseTheLink(a);
    // The premise is MEASURED, not waited for: type only once the client's own dials have been
    // quiet long enough that the loop can only be in a backoff rung. An attempt dials several
    // times within a few milliseconds, so "no knock for 1.5s" is the honest test for between them.
    const quiet = Date.now() + 25_000;
    while (Date.now() - (knocks.at(-1) ?? 0) < 1_500 && Date.now() < quiet) await wait(100);
    const sinceLastDial = Date.now() - (knocks.at(-1) ?? 0);
    check("the loop is between attempts, which is this cell's premise", sinceLastDial >= 1_500, { sinceLastDial, knocks: knocks.length });
    a.write(`${n}\r`);
    await wait(300);
    await closeLink();
    await heal();
    check("the reconnect lands", await a.waitFor(/\[cotal: reconnected\]/, 60_000), a.seen().slice(-300));
    await wait(2_000);
    check("...and the seat read nothing of what was typed at a terminal with no session",
      !sink().subarray(mark).includes(Buffer.from(n)), { got: sink().subarray(mark).toString("utf8") });
    await detachAndSettle(a, base, "A");
  }

  // -----------------------------------------------------------------------------------------
  console.log("\nB. bytes typed during an attempt that FAILS never reach the agent");
  // The link is HELD for this one so the attempt is genuinely in flight while the key is struck:
  // the dial connects and no INFO ever comes back. A severed-but-resetting link fails the attempt
  // within a millisecond of the dial, which is too narrow to aim at through a pty.
  //
  // AND THE ATTEMPT HAS TO BE OVER BEFORE THE LINK HEALS. That half was asserted in a comment and
  // never measured, and it was false: an establishment on a held link does not refuse in about a
  // second. Measured over a 20s hold, the client's own dials land at 0, 5039, 5040, 6041, 6041 and
  // 16047, so the attempt runs to the 5s link deadline and a 2.5s hold never outlived it. The
  // premise is measured now, and by the only party that knows: the client re-dials, which it can
  // only do by having finished the attempt those bytes were typed into.
  //
  // WITH THE PREMISE TRUE, THIS CELL IS A WITNESS AND NOT THE BOUNDARY IT WAS FILED AS. Measured
  // both ways at the same tip, same cell, same nonce shape: against a full revert the nonce reaches
  // the seat 6ms after `[cotal: reconnected]` prints, so it waited in the terminal across the
  // failed attempt, across the backoff, and across the next establishment, and the new session's
  // own resume delivered it. Against this fix it never arrives at all. Review found this by running
  // the cell against a revert and getting the nonce delivered twice while this file still claimed
  // the cell passed either way; the claim came from a probe whose failed attempt died at the dial
  // instead of running its deadline, which is a different window with a different answer.
  {
    const base = live();
    const { a, mark } = await attached();
    const n = nonce();
    await loseTheLink(a);
    await closeLink();
    await holdOpen();
    await nextDial();
    a.write(`${n}\r`); // this attempt is now stalled on a link that will never answer it
    const dialsAtType = knocks.length;
    const deadline = Date.now() + 40_000;
    while (knocks.length <= dialsAtType && Date.now() < deadline) await wait(100);
    const redialled = knocks.length > dialsAtType;
    check("the attempt those bytes were typed into is OVER, which is this cell's premise",
      redialled, { dialsAtType, dials: knocks.length, waited: 40_000 - (deadline - Date.now()) });
    await wait(300); // let the loop settle into the backoff rung the re-dial proves it reached
    await closeLink();
    await heal();
    check("the reconnect lands", await a.waitFor(/\[cotal: reconnected\]/, 60_000), a.seen().slice(-300));
    await wait(2_000);
    check("...and the seat read nothing of what was typed during the failed attempt",
      !sink().subarray(mark).includes(Buffer.from(n)), { got: sink().subarray(mark).toString("utf8") });
    await detachAndSettle(a, base, "B");
  }

  // -----------------------------------------------------------------------------------------
  console.log("\nC. bytes typed during an attempt that SUCCEEDS never reach the agent");
  // THE DEFECT. Measured before the fix, these bytes sat in the paused stream and were flushed
  // into the seat by the `stdin.resume()` that the new session's own reader performs, a second or
  // more after they were typed and after `[cotal: reconnected]` had been printed.
  {
    const base = live();
    const { a, mark } = await attached();
    const n = nonce();
    await loseTheLink(a);
    await nextDial();
    await closeLink();
    await heal();       // this dial's attempt will now succeed
    a.write(`${n}\r`);  // typed while it is establishing: no session, and nobody used to be reading
    check("the reconnect lands", await a.waitFor(/\[cotal: reconnected\]/, 60_000), a.seen().slice(-300));
    await wait(2_500);
    check("...and the seat read nothing of what was typed while the session was being established",
      !sink().subarray(mark).includes(Buffer.from(n)), { got: sink().subarray(mark).toString("utf8") });
    // The handoff is only correct if the session's OWN reader works after it, so the same cell
    // types again once the session is up: dropping everything would pass the assertion above.
    const after = nonce();
    const mark2 = sink().length;
    a.write(`${after}\r`);
    const echoed = await a.waitFor(new RegExp(`ECHO\\[${after}`), 20_000);
    check("...while typing into the session that came up does reach the agent",
      echoed && sink().subarray(mark2).includes(Buffer.from(after)),
      { echoed, got: sink().subarray(mark2).toString("utf8") });
    await detachAndSettle(a, base, "C");
  }

  // -----------------------------------------------------------------------------------------
  console.log("\nD. Ctrl-C typed in that window does not reach the agent as a signal");
  // Graded on the SEAT's pid and its own record of the signal. The manager's session count cannot
  // answer this: it returns to base whether the agent died or never noticed.
  {
    const base = live();
    const { a, mark } = await attached();
    const pidBefore = seatPid();
    check("the seat is alive before the window", seatAlive(), { pid: pidBefore });
    await loseTheLink(a);
    await nextDial();
    await closeLink();
    await heal();
    a.write("\x03");
    check("the reconnect lands", await a.waitFor(/\[cotal: reconnected\]/, 60_000), a.seen().slice(-300));
    await wait(2_500);
    check("...the agent recorded no signal", !sink().subarray(mark).includes(Buffer.from("<SIGINT>")),
      { got: sink().subarray(mark).toString("utf8") });
    check("...and the agent is still running, on the pid it had", seatAlive() && seatPid() === pidBefore,
      { pidBefore, now: seatPid() });
    await detachAndSettle(a, base, "D");
  }

  // -----------------------------------------------------------------------------------------
  console.log("\nE. the detach key struck in that same window ends the attach and hands the slot back");
  // The other half of the defect, and the reason the window has an owner rather than a drop. Before
  // the fix the same press was not a detach at all: the byte was flushed into the session that had
  // just opened, `onInput` forwarded it to the agent as data, and the attach carried on running.
  // The session that lands after the press is a slot the manager counts, so it goes on the
  // abandoned list and `done` hands it back; the count returning to base is that hand-back.
  {
    const base = live();
    const { a, mark } = await attached();
    await loseTheLink(a);
    await nextDial();
    await closeLink();
    await heal();
    const tPress = Date.now();
    const reconnectsAtPress = saidReconnected(a);
    a.write(DETACH);
    const ended = await a.waitExit(30_000);
    // Reported, not asserted. Before the fix the same press was not a detach at all, so there is no
    // threshold here that separates two behaviours; the number is here because a press that ends
    // the attach a minute later is a different product from one that ends it now, and the next
    // reader should be able to see which one this run got.
    console.log(`    (press to exit: ${ended ? `${Date.now() - tPress}ms` : "never, inside 30s"})`);
    check("the press ends the attach, though it landed with no session to detach from",
      ended, a.seen().slice(-300));
    check("...exiting clean", a.exit()?.code === 0, a.exit());
    check("...without announcing the session that landed behind it", saidReconnected(a) === reconnectsAtPress,
      { reconnectsAtPress, now: saidReconnected(a), tail: a.seen().slice(-200) });
    check("...without the detach byte reaching the agent as data",
      !sink().subarray(mark).includes(0x1d), { got: sink().subarray(mark).toString("utf8") });
    check("...saying NOTHING about a held session, because it handed back what it had taken",
      !/the manager still holds/.test(a.seen()), a.seen().slice(-300));
    check("...and the manager is back on the session count it started with, with no slot left behind",
      await settle(base, 25_000) === base, { base, now: live(), pressToExitMs: Date.now() - tPress });
  }

  // -----------------------------------------------------------------------------------------
  console.log("\nF. a detach byte sharing a read with another byte is not a detach, and is not delivered");
  // Exact match is deliberate: measured on a pty, a real keypress arrives in a read of its own even
  // at 3ms spacing, and the only two ways the byte arrives with company are a paste and a reader
  // that was not reading. Treating a paste that happens to contain 0x1d as a detach would turn data
  // into a control action on input nobody typed.
  {
    const base = live();
    const { a, mark } = await attached();
    await loseTheLink(a);
    const quiet = Date.now() + 25_000;
    while (Date.now() - (knocks.at(-1) ?? 0) < 1_500 && Date.now() < quiet) await wait(100);
    a.write(`x${DETACH}`); // one write, two bytes, while there is no session
    await wait(1_500);
    check("the attach is still up: the chunk is not a keypress", a.exit() === undefined, a.exit());
    await closeLink();
    await heal();
    check("...the reconnect still lands", await a.waitFor(/\[cotal: reconnected\]/, 60_000), a.seen().slice(-300));
    await wait(2_000);
    check("...and neither byte reached the agent", sink().subarray(mark).length === 0,
      { got: sink().subarray(mark).toString("utf8") });
    await detachAndSettle(a, base, "F");
  }

  // -----------------------------------------------------------------------------------------
  console.log("\nG. the same chunk in a LIVE session is data, forwarded to the agent, and still not a detach");
  {
    const base = live();
    const { a, mark } = await attached();
    const n = nonce();
    // The trailing CR is not decoration: the seat's pty is cooked, so its line discipline holds
    // un-newlined text and the seat PROCESS would never read what its pty had already received.
    a.write(`${n}${DETACH}\r`);
    let carried = false;
    for (let i = 0; i < 75 && !carried; i++) { carried = sink().subarray(mark).includes(0x1d); if (!carried) await wait(200); }
    check("the agent receives it, detach byte included", carried, { got: sink().subarray(mark).toString("utf8") });
    check("...with the nonce it was typed with", sink().subarray(mark).includes(Buffer.from(n)),
      { got: sink().subarray(mark).toString("utf8") });
    check("...and the attach is still up", a.exit() === undefined, a.exit());
    await detachAndSettle(a, base, "G");
  }

  // -----------------------------------------------------------------------------------------
  console.log("\nH. the detach key pressed while the new session is OPENING still detaches");
  // Found by review, not by this suite, and the reason it was missed is the reason this cell needs a
  // slow link. The loop announces the reconnect and then opens the session, and the reader that owns
  // stdin is handed over only when that session is READY, a round trip later. On loopback that round
  // trip is under a millisecond, so a press lands after it and the session's own reader handles it.
  // On a real link it is tens or hundreds of milliseconds, and the press lands in between: seen by
  // the loop's reader, awaited by nobody, and thrown away when the handoff happens. The operator
  // watches their detach do nothing and their next keystrokes go to the agent.
  //
  // THE MUTATION FOR THIS CELL IS ITS PREMISE CHECK. Restore the swallow and this cell only passes
  // if the press landed AFTER ready, which is the window it exists to avoid; so a killed mutation is
  // what proves the press is landing where the cell claims.
  {
    const base = live();
    const { a, mark } = await attached();
    await loseTheLink(a);
    await nextDial();
    await closeLink();
    await healSlow(400); // every frame 400ms each way: the ready handshake is now visible from here
    check("the reconnect is announced, which is where an operator would give up",
      await a.waitFor(/\[cotal: reconnected\]/, 90_000), a.seen().slice(-300));
    const tPress = Date.now();
    a.write(DETACH); // announced, but the session's ready handshake is still in flight
    const gone = await a.waitExit(60_000);
    console.log(`    (announce to exit: ${gone ? `${Date.now() - tPress}ms` : "never, inside 60s"})`);
    check("the press ends the attach, though it landed while the session was opening", gone, a.seen().slice(-300));
    check("...exiting clean", a.exit()?.code === 0, a.exit());
    check("...without the detach byte reaching the agent as data",
      !sink().subarray(mark).includes(0x1d), { got: sink().subarray(mark).toString("utf8") });
    await closeLink();
    await heal();
    check("...and the manager is back on the session count it started with, with no slot left behind",
      await settle(base, 30_000) === base, { base, now: live() });
  }

  // -----------------------------------------------------------------------------------------
  console.log("\nI. bytes typed before the FIRST attach comes up never reach the agent either");
  // The same defect on the commonest path there is. An attach that has not come up yet is an attach
  // with no session, and the loop used to own the keyboard only from the first RECONNECT onwards,
  // so everything typed at a terminal while the first establishment ran was buffered and flushed
  // into the seat by the session's own resume. Found by review on this PR.
  {
    const base = live();
    const n = nonce();
    const mark = sink().length;
    const a = attachUnderPty(root);
    a.write(`${n}\r`); // typed while the FIRST establishment is still running
    check("the attach comes up", await a.waitFor(new RegExp(`attached to ${SEAT}`), 90_000), a.seen().slice(-300));
    await wait(2_500);
    check("...and the seat read nothing of what was typed before it came up",
      !sink().subarray(mark).includes(Buffer.from(n)), { got: sink().subarray(mark).toString("utf8") });
    await detachAndSettle(a, base, "I");
  }

  // -----------------------------------------------------------------------------------------
  console.log("\nJ. with stdin a PIPE, what was written before the session opened still arrives");
  // The boundary of cell I, and the reason the reader is installed only for a terminal. `echo cmd |
  // cotal attach` is a real thing to do, and there is no operator at a frozen screen in it: the
  // bytes are a script's input, written before the session could possibly be open, and dropping
  // them would eat the command with no fault anywhere in sight. So a pipe keeps the old behaviour,
  // buffered by the stream and delivered when the session opens, and this cell is what says so.
  {
    const base = live();
    const n = nonce();
    const mark = sink().length;
    const p = attachPiped(root);
    p.write(`${n}\n`); // written before the command has even resolved the mesh
    let arrived = false;
    for (let i = 0; i < 150 && !arrived; i++) { arrived = sink().subarray(mark).includes(Buffer.from(n)); if (!arrived) await wait(200); }
    check("the agent receives what the script wrote", arrived, { got: sink().subarray(mark).toString("utf8") });
    p.write(DETACH); // one byte, one write: a detach on a pipe is still a detach
    check("...and the detach key still ends a piped attach", await p.waitExit(30_000) && p.exit() === 0,
      { code: p.exit(), tail: p.seen().slice(-400) });
    check("...leaving the manager on the session count it started with", await settle(base, 25_000) === base, { base, now: live() });
  }

  // -----------------------------------------------------------------------------------------
  console.log("\nK. a detach pressed while a FAULTED session is being HANDED BACK is still a keypress");
  // Where the reader goes inside the session `finally`, measured rather than argued. Below the
  // reader are a publish, a flush and a close, each bounded by LINK_DEADLINE_MS, and they only run
  // at all when the connection outlived the session. Every other cell here faults by killing the
  // socket, so that branch is skipped and the statement order cannot be seen; this one faults the
  // RAIL and leaves the link up, which is the shape of the real complaint (a laptop whose link goes
  // slow and lossy rather than instantly away).
  //
  // Deleting the reader from this position does not LOSE the press, it delays it: stdin stays
  // paused, the byte waits in the terminal, and the backoff wait resumes and reads it a moment
  // later, so a lone press would still detach and prove nothing. What the ownerless window really
  // costs is what the second keystroke shows: buffered bytes come back in ONE read, and a detach
  // that shares a read is not a detach (cells F and G). So the operator here does what an operator
  // does when the screen has frozen: presses detach, then touches another key. Owned, those are two
  // reads and the first one ends the attach. Unowned, they are one chunk, the exact-match test
  // refuses it, and the attach reconnects into a session the operator meant to leave.
  {
    const base = live();
    await closeLink();
    await healSlowLossy(400);
    const a = attachUnderPty(root);
    check("the attach comes up over a link that is slow and readable frame by frame",
      await a.waitFor(new RegExp(`attached to ${SEAT}`), 120_000), a.seen().slice(-300));
    await wait(1_000);
    const mark = sink().length;
    // The seat echoes what it is typed, so a burst of lines is a burst of data frames. Every stage
    // below is synchronised on what the system does rather than on a sleep: drop until frames have
    // actually gone missing, then keep the seat producing until the rail notices the hole. A fixed
    // window would be a guess about how fast a loaded box echoes.
    const flushLeft = new Promise<void>((r) => { sawClientPing = () => r(); });
    dropping = true;
    for (let i = 0; i < 12 && droppedFrames < 3; i++) { a.write(`k${i}\r`); await wait(150); }
    check("the link loses frames without losing the connection", droppedFrames >= 3, { droppedFrames });
    dropping = false;
    // The fault fires on the first frame DELIVERED after the hole, and the client's flush is a PING
    // the proxy watches leave: that is the hand-back starting, on a connection the fault did not
    // close. Waiting for it is waiting for the window itself.
    let opened = false;
    for (let i = 0; i < 25 && !opened; i++) {
      a.write(`m${i}\r`);
      opened = await Promise.race([flushLeft.then(() => true), wait(400).then(() => false)]);
    }
    check("the faulted session is handed back over a link that is still up", opened, { droppedFrames });
    const seenAtPress = a.seen();
    const tPress = Date.now();
    a.write(DETACH);
    await wait(60); // two keystrokes far enough apart to be separate reads for a reader that reads
    a.write("z");
    // The premise, checked and not assumed: the press has to land INSIDE the hand-back, before the
    // loop announces the loss. After the announcement it is the backoff wait's reader that has the
    // stream, which is a window this cell is not about and other cells already cover.
    check("...and the press landed while that hand-back was still in flight, not after it",
      !/\[cotal: connection lost, reconnecting\]/.test(seenAtPress), seenAtPress.slice(-200));
    const gone = await a.waitExit(60_000);
    console.log(`    (press to exit: ${gone ? `${Date.now() - tPress}ms` : "never, inside 60s"})`);
    check("the press ends the attach, though it landed while the session was being handed back", gone, a.seen().slice(-300));
    check("...exiting clean", a.exit()?.code === 0, a.exit());
    check("...with neither keystroke reaching the agent",
      !sink().subarray(mark).includes(0x1d) && !sink().subarray(mark).includes(0x7a),
      { got: sink().subarray(mark).toString("utf8").slice(-200) });
    await closeLink();
    await heal();
    check("K: the manager is back on the session count it started with",
      await settle(base, 30_000) === base, { base, now: live() });
  }
  // -----------------------------------------------------------------------------------------
  console.log("\nL. with stdin a PIPE, what is written while there is NO session still arrives");
  // The other half of J, one window along, and the reason the population gate belongs at every
  // `ownStdin` site rather than only at the first. A pipe's bytes are a script's input wherever in
  // the run they are written, so the contract J states has to hold across a reconnect too: buffered
  // by the stream, delivered when the next session opens, which is what the code did before this
  // change because it paused stdin between sessions and the next `resume()` flushed them. Measured
  // with the gate on the first attach only: the reader installed for the backoff read the script's
  // bytes and dropped them, so `tail -f log | cotal attach` lost its feed across a link blip with
  // no fault printed anywhere. A terminal and a pipe differ in whether a human is at the other end,
  // not in which window the loop is in.
  {
    const base = live();
    const mark = sink().length;
    const p = attachPiped(root);
    if (!await p.waitFor(new RegExp(`attached to ${SEAT}`), 90_000)) throw new Error(`piped attach never came up: ${p.seen().slice(-400)}`);
    await wait(500);
    await closeLink();
    await severLoud();
    check("the piped attach is told the link went", await p.waitFor(/\[cotal: connection lost, reconnecting\]/, 30_000), p.seen().slice(-300));
    // Same premise as cell A, measured the same way: write only once the client's own dials have
    // been quiet long enough that the loop can only be in a backoff rung.
    const quiet = Date.now() + 25_000;
    while (Date.now() - (knocks.at(-1) ?? 0) < 1_500 && Date.now() < quiet) await wait(100);
    const sinceLastDial = Date.now() - (knocks.at(-1) ?? 0);
    check("the loop is between attempts, which is this cell's premise", sinceLastDial >= 1_500, { sinceLastDial, knocks: knocks.length });
    const n = nonce();
    p.write(`${n}\n`);
    await wait(300);
    await closeLink();
    await heal();
    check("the reconnect lands", await p.waitFor(/\[cotal: reconnected\]/, 60_000), p.seen().slice(-300));
    let arrived = false;
    for (let i = 0; i < 100 && !arrived; i++) { arrived = sink().subarray(mark).includes(Buffer.from(n)); if (!arrived) await wait(200); }
    check("...and the seat receives what the script wrote while there was no session", arrived,
      { got: sink().subarray(mark).toString("utf8").slice(-200) });
    p.write(DETACH);
    check("L: the piped attach detaches and exits clean", await p.waitExit(30_000) && p.exit() === 0,
      { code: p.exit(), tail: p.seen().slice(-400) });
    check("L: the manager is back on the session count it started with", await settle(base, 25_000) === base, { base, now: live() });
  }
  // -----------------------------------------------------------------------------------------
  console.log("\nM. a piped one-shot attach still gives the process back when it detaches");
  // The path with no reader anywhere: `--no-reconnect` at a PIPE never installs the loop's watcher,
  // on this code or on the code before it. That made it the one route where nothing gave the stream
  // back on the way out, because the pause that did it was inside the watcher's `stop`. So the
  // obligation was accidentally conditional on having taken the stream at all, which is the same
  // shape as a gate written at one call site of three. Measured here rather than inferred: this cell
  // is what the `process.stdin.unref()` on the exit path answers to, and it grades the one-shot
  // exit that a script's `$?` depends on.
  //
  // AND THE ROUTE IS BROKEN ON THE BUILD THAT SHIPS, measured rather than reasoned: `pnpm
  // probe:pipe-oneshot` run in a worktree at origin/main (a8589c11) takes the detach, prints
  // `detached from`, and then holds the process past 30s. The same probe at this tip exits 0 in
  // 102ms. This cell is the same trigger with the assertions attached.
  {
    const base = live();
    const mark = sink().length;
    const n = nonce();
    const p = attachPiped(root, ["--no-reconnect"]);
    p.write(`${n}\n`);
    let arrived = false;
    for (let i = 0; i < 150 && !arrived; i++) { arrived = sink().subarray(mark).includes(Buffer.from(n)); if (!arrived) await wait(200); }
    check("the one-shot receives what the script wrote", arrived, { got: sink().subarray(mark).toString("utf8").slice(-200) });
    p.write(DETACH);
    check("M: the piped one-shot exits clean", await p.waitExit(30_000) && p.exit() === 0,
      { code: p.exit(), tail: p.seen().slice(-400) });
    check("M: the manager is back on the session count it started with", await settle(base, 25_000) === base, { base, now: live() });
  }
  // -----------------------------------------------------------------------------------------
  console.log("\nN. an attach whose stdin is a FILE exits without crashing on the way out");
  // THE CELL THIS FILE OWED AND DID NOT HAVE. Every cell above drives the attach through a pty or a
  // pipe, so all thirteen lived in the two stream kinds that HAVE `unref`, and the exit release
  // crashed on the third: `cotal attach < seed.txt` and any parent spawning with stdio "ignore" get
  // an `fs.ReadStream`, where the call is a TypeError. CI found it in `smoke:cli-on-instance`, which
  // spawns attach with stdin ignored for an entirely different claim and reported
  // `process.stdin.unref is not a function` as that cell's tail. A gate with no cell in the universe
  // where a bug lives cannot see the bug, so this is the universe added rather than the report filed.
  //
  // The crash text is asserted BY NAME as well as through the exit code, because an exit code alone
  // says only that this route is broken, not that it is broken the way it was broken before.
  //
  // THE FILE HOLDS ONE BYTE, and that is a measurement rather than a preference. Written as
  // `nonce\n` plus the detach byte, this cell went red twice: a file hands the reader every byte it
  // has in ONE read, so the detach shares a read with the nonce, the exact-match test refuses it
  // exactly as cells F and G say it must, and the seat echoed `^]` as data while the attach stayed
  // up. That is the documented cost of the one-byte match arriving on a third stream kind, not a new
  // defect, so the cell asks the question it can actually ask: a lone detach byte, which a file
  // delivers as a single-byte read the same way a keypress does.
  {
    const base = live();
    const mark = sink().length;
    const p = attachFromFile(root, DETACH, ["--no-reconnect"]);
    check("the attach comes up with stdin a file", await p.waitFor(new RegExp(`attached to ${SEAT}`), 90_000), p.seen().slice(-300));
    check("N: the attach exits clean, with stdin a file", await p.waitExit(30_000) && p.exit() === 0,
      { code: p.exit(), tail: p.seen().slice(-400) });
    check("N: ...and never crashed releasing a stream that has nothing to release",
      !/unref is not a function/.test(p.seen()), { tail: p.seen().slice(-400) });
    check("N: ...with the detach byte consumed as a keypress rather than forwarded to the agent",
      !sink().subarray(mark).includes(Buffer.from(DETACH)), { got: sink().subarray(mark).toString("utf8").slice(-200) });
    check("N: the manager is back on the session count it started with", await settle(base, 25_000) === base, { base, now: live() });
  }
} catch (e) {
  fail++;
  console.log(`  ✗ FAIL: the suite threw: ${(e as Error).message}`);
} finally {
  for (const a of started) a.kill();
  for (const p of pipedChildren) p.kill();
  onKnock = undefined;
  sawClientPing = undefined;
  await closeLink();
  await manager?.stop().catch(() => {});
  // Kill and remove FIRST, release LAST: `releaseBroker` hands the kill duty back rather than doing
  // it, so releasing before the kill leaves a window where nobody owns this broker.
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
