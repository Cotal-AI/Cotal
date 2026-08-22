/**
 * Attack: after [cotal: reconnected] print, kill the link before onReady/takeStdin.
 * If idle stays set and cleanup pauses stdin, the next wait has no reader and a
 * nonce typed there flushes into the seat on the following resume.
 */
import { randomUUID } from "node:crypto";
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
import { spawn } from "node:child_process";

// A run started from a session that is itself joined to a mesh inherits `COTAL_*`, and every child
// spawned below is `cotal attach`, which READS connection material. Blanking three names by hand
// (SPACE/SERVERS/CREDS) left the rest reachable: the lifecycle uid, the control token, the user-auth
// quad, the ACLs, and the launch-material path. Scrub the whole prefix once, here; what a child
// genuinely needs (COTAL_HOME) each spawn sets for itself.
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];


const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const BIN = join(repoRoot, "bin", "cotal.ts");
const SEAT_STUB = join(here, "attach-stdin-seat.mjs");
const SEAT = "stdinseat";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });

for (const k of ["COTAL_SERVERS", "COTAL_SERVER", "COTAL_CREDS", "COTAL_SPACE"]) delete process.env[k];
// The same live-space guard its siblings carry, and the reason is that clearing the four names a
// mesh is addressed by is not the same as proving no OTHER variable does. Review found this probe
// short of the suite it sits beside; the gap was defence in depth rather than a live route, since
// everything here listens on 127.0.0.1 and the child is handed those four as empty strings.
const LIVE_HOST = "broker.cotal.ai";
for (const [k, v] of Object.entries(process.env))
  if (typeof v === "string" && v.includes(LIVE_HOST)) throw new Error(`refusing to run: ${k} points at the live broker (${v})`);

const BROKER_PORT = await freePort();
const PROXY_PORT = await freePort();
const BROKER = `nats://127.0.0.1:${BROKER_PORT}`;
const PROXY = `nats://127.0.0.1:${PROXY_PORT}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const home = join(dir, "home");
mkdirSync(home, { recursive: true });
process.env.COTAL_HOME = home;
process.env.XDG_CONFIG_HOME = join(dir, "xdg");
mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
const space = `probe-${randomUUID().slice(0, 8)}`;
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
const severLoud = (): Promise<void> =>
  new Promise((res, rej) => {
    knocks.length = 0;
    const s = createServer((sock) => { fireKnock(); sock.destroy(); });
    s.on("error", rej);
    s.listen(PROXY_PORT, "127.0.0.1", () => { proxy = s; res(); });
  });
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

let outcome = "INCONCLUSIVE";
let manager: InstanceType<typeof Manager> | undefined;
let child: ReturnType<typeof pty.spawn> | undefined;
try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(BROKER)) { up = true; break; } await wait(200); }
  if (!up) throw new Error("broker did not come up");
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

  let buf = "";
  child = pty.spawn("npx", ["tsx", BIN, "attach", "--name", SEAT, "--space", space, "--server", PROXY], {
    name: "xterm-256color", cols: 100, rows: 30, cwd: root,
    env: { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } as Record<string, string>,
  });
  child.onData((d) => { buf += d; });
  const seen = () => buf;
  const waitFor = async (re: RegExp, ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (re.test(seen())) return true; await wait(100); }
    return re.test(seen());
  };

  if (!await waitFor(new RegExp(`attached to ${SEAT}`), 90_000)) throw new Error(`never attached: ${seen().slice(-300)}`);
  await wait(500);
  const mark = readFileSync(SINK).length;

  await closeLink();
  await severLoud();
  if (!await waitFor(/\[cotal: connection lost, reconnecting\]/, 30_000)) throw new Error("loss never announced");

  const nextDial = (): Promise<void> => new Promise((r) => { onKnock = () => r(); });
  await nextDial();
  await closeLink();
  await healSlow(400);
  if (!await waitFor(/\[cotal: reconnected\]/, 90_000)) throw new Error("reconnect never announced");
  const afterAnnounce = seen();
  // Kill the handshake before onReady: this is the window takeStdin has not run.
  await closeLink();
  await severLoud();
  const lossesAtKill = (seen().match(/\[cotal: connection lost, reconnecting\]/g) ?? []).length;
  const reconnectsAtKill = (seen().match(/\[cotal: reconnected\]/g) ?? []).length;
  const lossDeadline = Date.now() + 30_000;
  while ((seen().match(/\[cotal: connection lost, reconnecting\]/g) ?? []).length <= lossesAtKill && Date.now() < lossDeadline) await wait(100);
  const secondLoss = (seen().match(/\[cotal: connection lost, reconnecting\]/g) ?? []).length > lossesAtKill;
  if (!secondLoss) throw new Error(`second loss never announced; tail=${seen().slice(-400)}`);
  // Wait until the client is actually retrying, then until it has gone quiet (backoff).
  const knockDeadline = Date.now() + 20_000;
  while (knocks.length === 0 && Date.now() < knockDeadline) await wait(100);
  const knocksAfterLoss = knocks.length;
  const quiet = Date.now() + 25_000;
  while (Date.now() - (knocks.at(-1) ?? 0) < 1_500 && Date.now() < quiet) await wait(100);
  const sinceLastDial = knocks.at(-1) ? Date.now() - (knocks.at(-1) as number) : -1;
  const n = `N${randomUUID().slice(0, 8).toUpperCase()}`;
  child.write(`${n}\r`);
  await wait(300);
  await closeLink();
  await heal();
  const recDeadline = Date.now() + 60_000;
  while ((seen().match(/\[cotal: reconnected\]/g) ?? []).length <= reconnectsAtKill && Date.now() < recDeadline) await wait(100);
  const reconnects = (seen().match(/\[cotal: reconnected\]/g) ?? []).length;
  await wait(2_500);
  const got = readFileSync(SINK).subarray(mark).toString("utf8");
  const delivered = got.includes(n);
  outcome = delivered ? "HOLE" : "CLOSED";
  console.log(JSON.stringify({
    outcome, delivered, nonce: n, got, reconnects, reconnectsAtKill, sinceLastDial, knocksAfterLoss,
    announcedThenKilled: /\[cotal: reconnected\]/.test(afterAnnounce),
    secondSession: reconnects > reconnectsAtKill,
    tail: seen().slice(-500),
  }, null, 2));
} catch (e) {
  console.log(JSON.stringify({ outcome: "THREW", error: (e as Error).message }, null, 2));
} finally {
  try { child?.kill("SIGKILL"); } catch { /* gone */ }
  await closeLink();
  await manager?.stop().catch(() => {});
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
process.exit(0);
