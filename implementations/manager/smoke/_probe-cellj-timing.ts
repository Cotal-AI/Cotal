/**
 * Why cell J of `smoke:attach-reconnect` could be raced by the very retry it means to sit between,
 * and what that turned up in the client. Run: pnpm probe:cellj-timing --arm race
 *
 * THE CELL'S PREMISE. Cell J presses the detach key while the reconnect loop is WAITING between
 * attempts, on a link that has just come back, and asserts the attach never re-established. It used
 * to get there by waiting 40s after the loss was announced and then healing, on the reasoning that
 * "after 40s the backoff is on its 30s rung, so the heal lands mid-wait".
 *
 * WHY THAT WAS NOT A MARGIN. The 40s is measured from when the TEST sees the announcement come out
 * of the pty; the ladder (1s, 2s, 5s, 10s, 30s) runs on the CLIENT's clock from the moment the link
 * died. The offset between them is however long a loaded machine takes to push a line through a pty
 * and a polling reader: 2.1s here, 7.1s on the runner that went red. Measured rather than modelled,
 * the boundary after the wait falls at 50.2s and the cell acted at 42.1s, so the margin was 8.1s.
 *
 * WHAT ACTUALLY LOSES THE PRESS. Landing past a boundary is not enough on its own. `watchDetachKey`
 * exists only for the duration of a wait, so a byte pressed while an ATTEMPT is running is not read:
 * it sits in the stream, the attempt succeeds on the just-healed link, `[cotal: reconnected]` is
 * printed, and the buffered byte then detaches the NEW session perfectly cleanly. Every other
 * assertion passes and only the premise one fails, which is exactly what the CI log showed.
 *
 * HOW IT MEASURES. During the outage the proxy port stays open and destroys what it accepts, so
 * every dial the client makes is a timestamped KNOCK: the client's schedule, read off the client.
 *
 *   --arm today  the cell as it stood: wait 40s from the announcement, heal, press. `--lag` adds
 *                the observation offset a loaded runner contributes.
 *   --arm race   the failure on demand: heal on the first dial of an attempt instead of in the wait
 *                between two, so that attempt gets to use it. reconnected=true, every time.
 *   --arm sync   the cell owning its timing: wait for two knocks a rung apart, let that attempt
 *                finish dialling, heal, and confirm nothing re-established before pressing.
 *
 * WHAT IT FOUND BESIDES. Press-to-exit tracks the distance to the next attempt: 27.0s to exit with
 * the boundary 26.9s away, 8.3s with it 8.1s away, while the terminal is restored and `detached
 * from` printed 0.1s after the press either way. Losing a `Promise.race` does not stop a
 * `setTimeout`, so the abandoned backoff timer held the process to the end of the rung. Fixed in
 * the loop, and `--arm sync` reads 0.1s to exit now.
 *
 * It prints a timeline and grades nothing. The suite is where assertions live.
 */import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
const SEAT_STUB = join(here, "attach-reconnect-seat.mjs");
const DETACH_BYTE = "\x1d";

const argv = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? String(argv[i + 1]) : fallback;
};
const ARM = argOf("arm", "today");
const LAG_MS = Number(argOf("lag", "0"));
if (!["today", "race", "sync"].includes(ARM)) throw new Error(`--arm must be today, race or sync, got ${ARM}`);

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
console.log(`broker-url guard: ${BROKER} (manager+seat) / ${PROXY} (attach client) are ephemeral loopback\n`);

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const home = join(dir, "home");
mkdirSync(home, { recursive: true });
process.env.COTAL_HOME = home;
process.env.XDG_CONFIG_HOME = join(dir, "xdg");
mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
const space = `cellj-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);

writeFileSync(
  join(dir, "server.conf"),
  serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: BROKER_PORT, storeDir: join(dir, "js") }) +
    `\nping_interval: "2s"\nping_max: 1\n`,
);
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

// --- the faultable link, plus the state that makes the client's schedule observable -------------
const liveSockets = new Set<Socket>();
let proxy: Server | undefined;
const knocks: number[] = [];
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
/** Severed, but LOUD: the port keeps listening and destroys what it accepts, so every dial the
 *  client makes lands here with a timestamp. To the client this is a link that resets rather than
 *  one that refuses; a failed attempt either way. */
const knockListener = (): Promise<void> =>
  new Promise((res, rej) => {
    const s = createServer((sock) => { knocks.push(Date.now()); sock.destroy(); });
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

const TICK_MS = 50;
const envFor = (o: LaunchOpts): Record<string, string> => ({
  COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? BROKER), COTAL_CREDS: String(o.creds),
  COTAL_ID: String(o.id), COTAL_NAME: o.name, PATH: process.env.PATH ?? "",
  SEAT_TICK_MS: String(TICK_MS), SEAT_SILENT: "1",
  ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
});
registry.register({
  kind: "connector", name: "rc-seat-quiet", requires: ["node"],
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
    waitExit: async (ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) { if (exited) return true; await wait(100); }
      return exited !== undefined;
    },
  };
}

const QUIET = "rcquiet";
let manager: InstanceType<typeof Manager> | undefined;
let att: Attached | undefined;

try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(BROKER)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${BROKER_PORT}`);
  await setupSpaceStreams({ servers: BROKER, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  await heal();

  const root = join(dir, "ws");
  mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(root, ".cotal", "agents", `${QUIET}.md`), `---\nname: ${QUIET}\nrole: worker\n---\n`);
  saveSpaceAuth(authDir(root), auth);
  const { recordMesh } = await import("@cotal-ai/workspace");
  recordMesh({ space, server: BROKER, root, mode: "auth", ts: new Date().toISOString() });

  manager = new Manager({ space, servers: BROKER, runtime: "pty", workspaceRoot: root });
  await manager.start();
  const q = await manager.startAgent({ name: QUIET, agent: "rc-seat-quiet", cwd: repoRoot });
  if (!q.ok) throw new Error(`quiet seat did not start: ${JSON.stringify(q)}`);
  const live = (): number => (manager as unknown as { sessionPlane?: { liveSessions: number } }).sessionPlane?.liveSessions ?? -1;

  const base = live();
  att = attachUnderPty(root, QUIET);
  if (!await att.waitFor(new RegExp(`attached to ${QUIET}`), 90_000)) throw new Error(`attach never came up: ${att.seen().slice(-400)}`);
  console.log(`arm=${ARM} lag=${LAG_MS}ms   sessions before: ${base} -> with the attach: ${live()}`);

  // The link dies. From here the client's ladder runs on its own clock and the knocks below are
  // the only view of it this file has that does not go through the pty.
  await closeLink();
  await knockListener();
  const tSever = Date.now();
  const announced = await att.waitFor(/\[cotal: connection lost, reconnecting\]/, 30_000);
  const tSeen = Date.now();
  console.log(`  sever at +0ms; loss announced through the pty at +${tSeen - tSever}ms (announced=${announced})`);

  /** Wait until two knocks land at least 25s apart. Only the 30s rung can produce that, so the
   *  later knock is the first dial of an attempt made from the top of a 30s wait: the schedule
   *  measured off the client's own dials rather than modelled from the ladder. */
  const waitForLongRung = async (): Promise<number> => {
    const deadline = Date.now() + 180_000;
    for (;;) {
      // Scan the whole run, not just the newest pair: an attempt dials several times in a few
      // milliseconds, so the pair that carries the rung is buried the moment the rest of its
      // cluster lands and a poll that only looks at the tail will never see it.
      for (let i = knocks.length - 1; i > 0; i--) if (knocks[i] - knocks[i - 1] >= 25_000) return knocks[i];
      if (Date.now() > deadline) throw new Error(`never observed a 25s rung in ${knocks.length} knocks`);
      await wait(200);
    }
  };
  /** The attempt is over when it has stopped dialling. */
  const waitForQuiet = async (ms: number): Promise<void> => {
    for (;;) {
      const last = knocks[knocks.length - 1] ?? 0;
      if (Date.now() - last >= ms) return;
      await wait(200);
    }
  };
  let tHeal = 0;
  let redone = 0;
  if (ARM === "today") {
    // The cell as it stands: the wait starts when the TEST saw the line, and `--lag` is the extra
    // offset a loaded runner adds between the client's clock and this one.
    await wait(LAG_MS);
    await wait(40_000);
    await closeLink();
    await heal();
    tHeal = Date.now();
  } else if (ARM === "race") {
    // The failure, on demand: heal in the MIDDLE of an attempt instead of in the wait between two.
    // The first knock of a cluster says an attempt has just begun and will dial again in a few
    // milliseconds, so a heal here is one the in-flight attempt gets to use. This is what a loaded
    // runner does by accident when the offset walks the 40s wait onto a rung boundary.
    await waitForLongRung();
    await closeLink();
    await heal();
    tHeal = Date.now();
  } else {
    // The cell owning its timing. Wait for the rung, let the attempt that proved it finish failing,
    // heal, and then VERIFY the premise before acting on it: if a reconnect announces itself, the
    // heal landed on an attempt after all, so sever and take the next rung instead of asserting
    // against a scenario that did not happen.
    for (;;) {
      await waitForLongRung();
      await waitForQuiet(1_500);
      await closeLink();
      await heal();
      tHeal = Date.now();
      await wait(1_500);
      if (!/\[cotal: reconnected\]/.test(att.seen())) break;
      if (++redone > 3) throw new Error("could not land a heal inside the wait in 4 tries");
      console.log(`  (heal ${redone} landed on an attempt, not in the wait: severing and taking the next rung)`);
      const losses = (att.seen().match(/\[cotal: connection lost, reconnecting\]/g) ?? []).length;
      await closeLink();
      await knockListener();
      const byWhen = Date.now() + 30_000;
      while (Date.now() < byWhen && (att.seen().match(/\[cotal: connection lost, reconnecting\]/g) ?? []).length === losses) await wait(200);
    }
  }
  const lenAtPress = att.seen().length;
  att.write(DETACH_BYTE);
  const tPress = Date.now();
  // When does the press produce ANY output? If the wait is interruptible, the terminal moves within
  // a moment of the press; if it is not, nothing happens until the rung expires.
  let tGrew = 0;
  void (async () => {
    while (Date.now() - tPress < 90_000) {
      if (att && att.seen().length !== lenAtPress) { tGrew = Date.now(); return; }
      await wait(100);
    }
  })();

  const exited = await att.waitExit(60_000);
  const tExit = Date.now();
  const lastKnock = knocks[knocks.length - 1] ?? tSever;
  const rel = (t: number) => `${((t - tSever) / 1000).toFixed(1)}s`;
  console.log(`  knocks (client dials, relative to sever): ${knocks.map((k) => rel(k)).join(", ")}`);
  const gaps = knocks.slice(1).map((k, i) => ((k - knocks[i]) / 1000).toFixed(1));
  console.log(`  gaps between knocks: ${gaps.join(", ")}`);
  console.log(`  heal at ${rel(tHeal)}, press at ${rel(tPress)}, exit at ${rel(tExit)} (exited=${exited}, code=${att.exit()?.code})`);
  console.log(`  press landed ${((tPress - lastKnock) / 1000).toFixed(1)}s after the last observed attempt; exit ${((tExit - lastKnock) / 1000).toFixed(1)}s after it`);
  console.log(`  press to first output: ${tGrew ? `${((tGrew - tPress) / 1000).toFixed(1)}s` : "none seen"}; press to exit: ${((tExit - tPress) / 1000).toFixed(1)}s; next attempt was due ${((lastKnock + 30_000 - tPress) / 1000).toFixed(1)}s after the press`);
  console.log(`  transcript tail: ${JSON.stringify(att.seen().slice(-260))}`);
  const reconnected = /\[cotal: reconnected\]/.test(att.seen());
  const held = /the manager still holds/.test(att.seen());
  console.log(`  RESULT: reconnected=${reconnected} (the cell asserts false) held-notice=${held} (the cell asserts false)`);
  const settled = live();
  console.log(`  sessions after: ${settled} (base ${base})`);
  console.log(reconnected
    ? `  VERDICT: the retry won the race. Cell J's premise assertion would be RED here.`
    : `  VERDICT: the press landed inside the wait. Cell J's premise assertion would be GREEN here.`);
} finally {
  att?.kill();
  await closeLink();
  await manager?.stop().catch(() => {});
  releaseBroker();
}
