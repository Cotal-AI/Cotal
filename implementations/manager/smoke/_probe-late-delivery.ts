/**
 * Attack on the SUITE, not on the client: does a negative assertion behind a fixed sleep still say
 * "nothing arrived" when the delivery it is looking for is merely SLOWER than the sleep?
 *
 * One scenario, one defect, one delivery, judged TWICE at two different moments. The link heals
 * slow, so the flush that carries the buffered nonce into the seat lands seconds after the reconnect
 * is announced. The old judgement waits a flat 2000ms and looks; the new one types a later byte and
 * looks only once the seat has echoed it back. The variable under test is the judging shape alone.
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
const SEAT_DELAY_MS = 3_000; // the seat is descheduled this long before it records what it read
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
  COTAL_INPUT_SINK: SINK, COTAL_PID_SINK: PIDSINK, COTAL_SEAT_SINK_DELAY_MS: String(SEAT_DELAY_MS),
  ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
});
registry.register({
  kind: "connector", name: "stdin-seat", requires: ["node"],
  buildLaunch: (o): LaunchSpec => ({ command: process.execPath, args: [SEAT_STUB], env: envFor(o) }),
} as Connector);

let manager: InstanceType<typeof Manager> | undefined;
let child: ReturnType<typeof pty.spawn> | undefined;
const out: Record<string, unknown> = { outcome: "INCONCLUSIVE" };
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
    env: { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, COTAL_SPACE: "", COTAL_SERVERS: "", COTAL_CREDS: "" } as Record<string, string>,
  });
  child.onData((d) => { buf += d; });
  const seen = () => buf;
  const waitFor = async (re: RegExp, ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (re.test(seen())) return true; await wait(100); }
    return re.test(seen());
  };
  const sink = () => readFileSync(SINK);

  if (!await waitFor(new RegExp(`attached to ${SEAT}`), 90_000)) throw new Error(`never attached: ${seen().slice(-300)}`);
  await wait(500);
  const mark = sink().length;

  // No session, loop in a backoff rung, and the premise measured off the client's own dials.
  await closeLink();
  await severLoud();
  if (!await waitFor(/\[cotal: connection lost, reconnecting\]/, 30_000)) throw new Error("loss never announced");
  const quiet = Date.now() + 25_000;
  while (Date.now() - (knocks.at(-1) ?? 0) < 1_500 && Date.now() < quiet) await wait(100);
  out.sinceLastDial = Date.now() - (knocks.at(-1) ?? 0);

  const n = `N${randomUUID().slice(0, 8).toUpperCase()}`;
  child.write(`${n}\r`);           // the byte whose absence both judgements are about
  await wait(300);

  // Heal normally. The lateness lives at the SEAT, not on the link, and that is deliberate: a link
  // slow enough to put a delivery past 2000ms cannot establish a session at all. Measured three
  // times on the way here, at 3000ms both ways and at 2800ms upstream only, and both ways the client
  // dialled without stop (25 dials in 120s) and no session ever came up. What DOES put a delivery
  // late is the condition the red that started this was seen under: a loaded machine, where the seat
  // process is descheduled and does its work whenever it next runs. That is what SEAT_DELAY_MS is.
  await closeLink();
  await heal();
  if (!await waitFor(/\[cotal: reconnected\]/, 120_000))
    throw new Error(`reconnect never announced; dials=${knocks.length} tail=${JSON.stringify(seen().slice(-700))}`);
  const announcedAt = Date.now();

  // JUDGEMENT 1, the old shape: a flat sleep, then look.
  await wait(2_000);
  const oldSawIt = sink().subarray(mark).includes(Buffer.from(n));
  out.oldShape = { verdict: oldSawIt ? "RED" : "GREEN", sawTheByte: oldSawIt, atMs: Date.now() - announcedAt };

  // JUDGEMENT 2, the new shape: type a later byte, look only once the seat has echoed it.
  const later = `N${randomUUID().slice(0, 8).toUpperCase()}`;
  const before = sink().length;
  child.write(`${later}\r`);
  const echoed = await waitFor(new RegExp(`ECHO\\[${later}`), 60_000);
  const newSawIt = sink().subarray(mark).includes(Buffer.from(n));
  out.newShape = {
    verdict: !echoed ? "UNGRADABLE (the later byte never echoed)" : newSawIt ? "RED" : "GREEN",
    sawTheByte: newSawIt, echoed, atMs: Date.now() - announcedAt,
    laterByteArrived: sink().subarray(before).includes(Buffer.from(later)),
  };

  // When the byte IS delivered late, the two judgements disagree, and that disagreement is the
  // finding: the old shape reports the absence it was too early to see.
  out.outcome = oldSawIt === newSawIt
    ? (oldSawIt ? "BOTH-RED" : "BOTH-GREEN")
    : "DISAGREE: the fixed window passed on a delivery the echo caught";
  out.deliveredAtMs = (() => {
    const g = sink().subarray(mark).toString("utf8");
    return g.includes(n) ? "delivered (see got)" : "never delivered";
  })();
  out.got = sink().subarray(mark).toString("utf8").slice(0, 400);
  out.seatDelayMs = SEAT_DELAY_MS;
  console.log(JSON.stringify(out, null, 2));
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
