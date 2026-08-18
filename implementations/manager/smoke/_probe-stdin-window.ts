/**
 * Who owns stdin between two attach sessions, and what happens to bytes typed while nobody does.
 * Run: pnpm probe:stdin-window --arm success   (#585)
 *
 * THE WINDOW. `watchDetachKey` is installed for the duration of a BACKOFF WAIT and stopped before
 * the attempt (`stdin.off` plus `stdin.pause()`); `attachClient` installs its own reader only in
 * `onReady`, after the session is open, and resumes stdin there. Between those two points nothing
 * is reading and the stream buffers, so `stdin.resume()` flushes whatever was typed straight into
 * `onInput` and out to the seat's pty.
 *
 * WHY A PROBE AND NOT A CELL YET. The claim is about a one-to-three second window inside a
 * reconnect, so getting there by waiting does not work: it has to be timed off the client's own
 * dials. The proxy stays listening while severed and every dial the client makes is a KNOCK, and
 * the arms below act from INSIDE that connection handler, which is the only place early enough to
 * be in the window rather than after it.
 *
 * THE ARMS. Each types a nonce and then asks the SEAT what it received, never the screen:
 *   --arm wait      typed during a backoff WAIT, while the detach watcher is installed.
 *   --arm failed    typed during an attempt that FAILS (link still severed).
 *   --arm success   typed during an attempt that SUCCEEDS (the link is healed on the same dial).
 *   --arm sigint    the same window, but the byte is 0x03. Graded on the seat's PID, not on the
 *                   manager's session count: the count is consistent with a seat that died and
 *                   with one that never did, and only one of those is the claim.
 *   --arm coalesce-wait  `x` and the detach key in ONE write during a wait: neither reader's
 *                   `d.length === 1` test matches, so the whole chunk is dropped, detach included.
 *   --arm coalesce-live  a nonce and the detach key in ONE write to a LIVE session: the same test
 *                   fails in `onInput`, which forwards the chunk to the seat with the 0x1d in it.
 *
 * The seat writes every byte it reads to a file (`_probe-stdin-seat.mjs`), so the verdict is what
 * the agent's own process received, not what the terminal showed. It prints and grades nothing;
 * the gate is where assertions live.
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
const SEAT_STUB = join(here, "_probe-stdin-seat.mjs");
const DETACH = "\x1d";
const NONCE = `N${randomUUID().slice(0, 8).toUpperCase()}`;

const argv = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? String(argv[i + 1]) : fallback;
};
const ARMS = ["wait", "failed", "success", "sigint", "coalesce-wait", "coalesce-live"] as const;
const ARM = argOf("arm", "success");
if (!(ARMS as readonly string[]).includes(ARM)) throw new Error(`--arm must be one of ${ARMS.join(", ")}, got ${ARM}`);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });

const LIVE_HOST = "broker.cotal.ai";
for (const k of ["COTAL_SERVERS", "COTAL_SERVER", "COTAL_CREDS", "COTAL_SPACE"]) delete process.env[k];
for (const [k, v] of Object.entries(process.env))
  if (typeof v === "string" && v.includes(LIVE_HOST)) throw new Error(`refusing to run: ${k} points at the live broker (${v})`);

const BROKER_PORT = await freePort();
const PROXY_PORT = await freePort();
const BROKER = `nats://127.0.0.1:${BROKER_PORT}`;
const PROXY = `nats://127.0.0.1:${PROXY_PORT}`;
console.log(`broker-url guard: ${BROKER} (manager+seat) / ${PROXY} (attach client) are ephemeral loopback`);
console.log(`arm=${ARM} nonce=${NONCE}\n`);

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const home = join(dir, "home");
mkdirSync(home, { recursive: true });
process.env.COTAL_HOME = home;
process.env.XDG_CONFIG_HOME = join(dir, "xdg");
mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
const space = `stdinw-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const SINK = join(dir, "seat-input.bin");
const PIDSINK = join(dir, "seat.pid");
writeFileSync(SINK, "");

writeFileSync(
  join(dir, "server.conf"),
  serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: BROKER_PORT, storeDir: join(dir, "js") }) +
    `\nping_interval: "2s"\nping_max: 1\n`,
);
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

// --- the faultable link, with every client dial timestamped ------------------------------------
const liveSockets = new Set<Socket>();
let proxy: Server | undefined;
const knocks: number[] = [];
let onKnock: (() => void) | undefined;
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
/** Severed but LOUD: the port keeps listening and destroys what it accepts, so every dial is a
 *  timestamped knock and a hook can fire INSIDE the connection handler, which is the only moment
 *  early enough to act on the attempt that dial belongs to. */
const knockListener = (): Promise<void> =>
  new Promise((res, rej) => {
    knocks.length = 0;
    const s = createServer((sock) => {
      knocks.push(Date.now());
      sock.destroy();
      const hook = onKnock; onKnock = undefined; hook?.();
    });
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
  kill: () => void;
};
function attachUnderPty(root: string, seat: string): Attached {
  const child = pty.spawn("npx", ["tsx", BIN, "attach", "--name", seat, "--space", space, "--server", PROXY], {
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
  };
}

const SEAT = "stdinseat";
const sink = (): Buffer => readFileSync(SINK);
const hex = (b: Buffer): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");
const seatPid = (): number => Number(readFileSync(PIDSINK, "utf8"));
const seatAlive = (): boolean => { try { process.kill(seatPid(), 0); return true; } catch { return false; } };

let manager: InstanceType<typeof Manager> | undefined;
let att: Attached | undefined;
let failed = false;

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
  console.log(`seat pid ${seatPid()}, alive=${seatAlive()}`);

  att = attachUnderPty(root, SEAT);
  const a = att;
  if (!await a.waitFor(new RegExp(`attached to ${SEAT}`), 90_000)) throw new Error(`attach never came up: ${a.seen().slice(-400)}`);
  await wait(500);
  const beforeArm = sink().length;
  console.log(`attached; the seat has read ${beforeArm} byte(s) so far\n`);

  // The CR on the coalesce-live arm is not decoration. The seat's pty is COOKED, so its line
  // discipline holds un-newlined text in the line buffer and the seat PROCESS never reads it: a
  // first run of this arm wrote `NONCE` plus the detach byte with no CR, and the sink was empty
  // while the client transcript showed `NB1655FCF^]` echoed back by that same line discipline. The
  // echo already proves `onInput` forwarded the chunk with the 0x1d in it, but the sink is the
  // witness this probe grades on, so give the line something to flush on.
  const typed = ARM === "sigint" ? "\x03" : ARM === "coalesce-wait" ? `x${DETACH}` : ARM === "coalesce-live" ? `${NONCE}${DETACH}\r` : `${NONCE}\r`;
  const label = ARM === "sigint" ? "0x03" : JSON.stringify(typed);
  let when = "";

  if (ARM === "coalesce-live") {
    // No outage at all: this is `onInput`'s own test, on a session that is up and reading.
    when = "into a LIVE session, in one write";
    a.write(typed);
    await wait(2_000);
  } else {
    await closeLink();
    await knockListener();
    const tSever = Date.now();
    if (!await a.waitFor(/\[cotal: connection lost, reconnecting\]/, 30_000)) throw new Error("the loss was never announced");
    console.log(`  sever at +0ms; loss announced at +${Date.now() - tSever}ms`);

    if (ARM === "wait" || ARM === "coalesce-wait") {
      // In a WAIT: the watcher is installed, so this is the documented drop path.
      const quiet = Date.now() + 20_000;
      while (Date.now() - (knocks.at(-1) ?? 0) < 1_500 && Date.now() < quiet) await wait(100);
      when = "during a backoff WAIT, watcher installed";
      a.write(typed);
      await wait(500);
      await closeLink();
      await heal();
    } else {
      // In an ATTEMPT: fire from inside the connection handler, before the socket is even destroyed.
      // `failed` leaves the link severed so that attempt dies; the others heal on the same dial so
      // it succeeds, which is the window the issue is about.
      let armed!: () => void;
      const fired = new Promise<void>((r) => { armed = r; });
      onKnock = () => { armed(); };
      await fired;
      if (ARM === "failed") {
        when = "during an attempt that FAILS";
        a.write(typed);
        await wait(3_000);
        await closeLink();
        await heal();
      } else {
        when = "during an attempt that SUCCEEDS";
        await closeLink();
        await heal();
        a.write(typed);
      }
    }
    const back = await a.waitFor(/\[cotal: reconnected\]/, 60_000);
    console.log(`  reconnected=${back}`);
    await wait(2_500);
  }

  const got = sink().subarray(beforeArm);
  const carries = (needle: string): boolean => got.includes(Buffer.from(needle, "latin1"));
  console.log(`\n  typed ${label} ${when}`);
  console.log(`  the SEAT read ${got.length} byte(s) after that point: ${hex(got) || "(nothing)"}`);
  console.log(`  as text: ${JSON.stringify(got.toString("utf8"))}`);
  console.log(`  nonce reached the seat:        ${ARM === "sigint" ? "n/a" : carries(NONCE)}`);
  console.log(`  detach byte reached the seat:  ${carries(DETACH)}`);
  console.log(`  seat recorded a SIGINT:        ${carries("<SIGINT>")}`);
  console.log(`  seat pid ${seatPid()} alive:        ${seatAlive()}`);
  console.log(`  attach still up:               ${att.exit() === undefined} (exit ${JSON.stringify(att.exit())})`);
  console.log(`  client transcript tail: ${JSON.stringify(att.seen().slice(-200))}`);
} catch (e) {
  failed = true;
  console.error(`  PROBE FAILED: ${(e as Error).message}`);
} finally {
  att?.kill();
  onKnock = undefined;
  await closeLink();
  await manager?.stop().catch(() => {});
  // Kill and remove FIRST, release LAST: `releaseBroker` hands the kill duty back rather than doing
  // it, so releasing before an explicit exit leaves a live broker and its store dir behind (#587).
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
  process.exit(failed ? 1 : 0);
}
