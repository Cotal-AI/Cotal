/**
 * REPRO PROBE (not a gate; not in ci-suites): when an attach client's link dies, does the MANAGER
 * ever get its session slot back?
 *
 * The reconnect loop abandons a session it can no longer reach and establishes a new one. That is
 * only sound if the manager reaps the abandoned one. The reaper the design leans on is the session
 * rail's stall watchdog (`packages/core/src/endpoint-session-rail.ts`), and it only ARMS once the
 * send window is FULL with no ack advance — so a seat that emits nothing never arms it. This probe
 * measures the manager's own live-session count across three arms that differ in exactly one thing
 * each, so the answer is a number rather than a reading of the code:
 *
 *   A  reconnecting attach + SILENT seat   — the laptop-lid case with an idle agent
 *   B  --no-reconnect attach + SILENT seat — the same outage under today's one-shot behaviour
 *   C  reconnecting attach + TICKING seat  — the control: a window that fills, so the watchdog arms
 *
 * Same broker, same manager, same proxy fault (only the CLIENT's link dies), same 45s outage.
 * It measures and prints; it asserts nothing. Run: pnpm probe:session-leak
 * Env: PROBE_OUTAGE_MS (default 45000) — how long the link stays dead (past the 30s watchdog).
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
import { Manager } from "../src/manager.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const BIN = join(repoRoot, "bin", "cotal.ts");
const SEAT_STUB = join(here, "attach-reconnect-seat.mjs");

const OUTAGE_MS = Number(process.env.PROBE_OUTAGE_MS ?? 45_000);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });

// --- live-space guard: this probe only ever runs against its own ephemeral loopback broker ------
const LIVE_HOST = "broker.cotal.ai";
for (const k of ["COTAL_SERVERS", "COTAL_SERVER", "COTAL_CREDS", "COTAL_SPACE"]) delete process.env[k];
for (const [k, v] of Object.entries(process.env))
  if (typeof v === "string" && v.includes(LIVE_HOST)) throw new Error(`refusing to run: ${k} points at the live broker (${v})`);

const BROKER_PORT = await freePort();
const PROXY_PORT = await freePort();
const BROKER = `nats://127.0.0.1:${BROKER_PORT}`;
const PROXY = `nats://127.0.0.1:${PROXY_PORT}`;
if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(BROKER)) throw new Error(`ephemeral loopback only; got ${BROKER}`);
console.log(`broker-url guard: ${BROKER} (manager+seat) / ${PROXY} (attach client) are ephemeral loopback; no env var names ${LIVE_HOST}\n`);

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const home = join(dir, "home");
mkdirSync(home, { recursive: true });
process.env.COTAL_HOME = home;
process.env.XDG_CONFIG_HOME = join(dir, "xdg");
mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
const space = `leak-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);

const conf =
  serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: BROKER_PORT, storeDir: join(dir, "js") }) +
  `\nping_interval: "2s"\nping_max: 1\n`;
writeFileSync(join(dir, "server.conf"), conf);
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

// --- the faultable link: a TCP proxy the probe can sever and heal ------------------------------
const live = new Set<Socket>();
let proxy: Server | undefined;
const listenProxy = (): Promise<void> =>
  new Promise((res, rej) => {
    const s = createServer((client) => {
      const up = netConnect(BROKER_PORT, "127.0.0.1");
      live.add(client); live.add(up);
      const drop = () => { live.delete(client); live.delete(up); client.destroy(); up.destroy(); };
      client.on("error", drop); up.on("error", drop);
      client.on("close", drop); up.on("close", drop);
      client.pipe(up); up.pipe(client);
    });
    s.on("error", rej);
    s.listen(PROXY_PORT, "127.0.0.1", () => { proxy = s; res(); });
  });
const sever = (): Promise<void> =>
  new Promise((res) => {
    const s = proxy; proxy = undefined;
    for (const sock of live) sock.destroy();
    live.clear();
    if (!s) return res();
    s.close(() => res());
  });

// SEAT_SILENT / SEAT_TICK_MS reach the seat through the launch env, so an arm can choose the
// serving-side behaviour it is measuring instead of the stub's default.
const envFor = (o: LaunchOpts): Record<string, string> => ({
  COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? BROKER), COTAL_CREDS: String(o.creds),
  COTAL_ID: String(o.id), COTAL_NAME: o.name, PATH: process.env.PATH ?? "",
  ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
  ...(process.env.SEAT_SILENT ? { SEAT_SILENT: process.env.SEAT_SILENT } : {}),
  ...(process.env.SEAT_TICK_MS ? { SEAT_TICK_MS: process.env.SEAT_TICK_MS } : {}),
});
registry.register({
  kind: "connector", name: "leak-seat", requires: ["node"],
  buildLaunch: (o): LaunchSpec => ({ command: process.execPath, args: [SEAT_STUB], env: envFor(o) }),
} as Connector);

let manager: InstanceType<typeof Manager> | undefined;
const kids: ReturnType<typeof pty.spawn>[] = [];

// The manager's own accounting, read straight off the plane the ceiling is enforced against.
const liveSessions = (): number => (manager as unknown as { sessionPlane?: { liveSessions: number } })?.sessionPlane?.liveSessions ?? -1;

try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(BROKER)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${BROKER_PORT}`);
  await setupSpaceStreams({ servers: BROKER, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  await listenProxy();

  const root = join(dir, "ws");
  mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
  saveSpaceAuth(authDir(root), auth);
  const { recordMesh } = await import("@cotal-ai/workspace");
  recordMesh({ space, server: BROKER, root, mode: "auth", ts: new Date().toISOString() });

  manager = new Manager({ space, servers: BROKER, runtime: "pty", workspaceRoot: root });
  await manager.start();

  const arms = [
    { id: "A", seat: "leakquiet", silent: true, reconnect: true, what: "reconnecting attach + SILENT seat" },
    { id: "B", seat: "leakquietone", silent: true, reconnect: false, what: "--no-reconnect attach + SILENT seat" },
    { id: "C", seat: "leakloud", silent: false, reconnect: true, what: "reconnecting attach + TICKING seat (control)" },
  ];

  const results: string[] = [];
  for (const arm of arms) {
    console.log(`\n════════ ARM ${arm.id}: ${arm.what} ════════`);
    if (arm.silent) { process.env.SEAT_SILENT = "1"; delete process.env.SEAT_TICK_MS; }
    else { delete process.env.SEAT_SILENT; process.env.SEAT_TICK_MS = "50"; }
    writeFileSync(join(root, ".cotal", "agents", `${arm.seat}.md`), `---\nname: ${arm.seat}\nrole: worker\n---\n`);
    const started = await manager.startAgent({ name: arm.seat, agent: "leak-seat", cwd: repoRoot });
    if (!started.ok) throw new Error(`seat did not start: ${JSON.stringify(started)}`);

    const before = liveSessions();
    const args = ["tsx", BIN, "attach", "--name", arm.seat, "--space", space, "--server", PROXY, ...(arm.reconnect ? [] : ["--no-reconnect"])];
    const child = pty.spawn("npx", args, {
      name: "xterm-256color", cols: 100, rows: 30, cwd: root,
      env: { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, COTAL_SPACE: "", COTAL_SERVERS: "", COTAL_CREDS: "" } as Record<string, string>,
    });
    kids.push(child);
    let out = "";
    let exited: { exitCode: number } | undefined;
    child.onData((d) => { out += d; });
    child.onExit((e) => { exited = e; });
    const waitFor = async (re: RegExp, ms: number): Promise<boolean> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) { if (re.test(out)) return true; if (exited && re.test(out)) return true; await wait(100); }
      return re.test(out);
    };
    if (!(await waitFor(/attached to/, 60_000))) throw new Error(`arm ${arm.id}: the attach never came up`);
    const attached = liveSessions();

    await sever();
    const t0 = Date.now();
    await wait(OUTAGE_MS);
    const afterOutage = liveSessions();
    console.log(`  live sessions: before=${before}  attached=${attached}  after ${Math.round((Date.now() - t0) / 1000)}s of dead link=${afterOutage}`);

    await listenProxy();
    let afterHeal = afterOutage;
    if (arm.reconnect) {
      const back = await waitFor(/\[cotal: reconnected\]/, 90_000);
      afterHeal = liveSessions();
      console.log(`  healed: reconnected=${back ? "YES" : "NO"}  live sessions now=${afterHeal}`);
    } else {
      console.log(`  child exited: ${exited ? `YES code=${exited.exitCode}` : "NO (still running)"}`);
    }
    child.kill("SIGKILL");
    await wait(3_000);
    const afterKill = liveSessions();
    console.log(`  3s after the client is killed outright: live sessions=${afterKill}`);
    results.push(`ARM ${arm.id} (${arm.what}): attached=${attached} afterOutage=${afterOutage} afterHeal=${afterHeal} afterClientKilled=${afterKill}`);
    // The seat stays running: each arm uses its own seat name, and every count below is read as a
    // DELTA against this arm's own `before`, so a previous arm's leaked session cannot flatter it.
    await wait(2_000);
  }

  console.log(`\n=== SUMMARY (manager live-session count; the ceiling is MAX_LIVE_SESSIONS_DEFAULT=64) ===`);
  for (const r of results) console.log(`  ${r}`);
} finally {
  for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* already gone */ } }
  await sever();
  await manager?.stop().catch(() => {});
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
process.exit(0);
