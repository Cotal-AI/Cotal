/**
 * REPRO PROBE (not a gate; not in ci-suites): what does `cotal attach` actually do when the
 * OPERATOR'S link dies and later heals, while the manager and the seat stay connected?
 *
 * This models a laptop going to sleep mid-attach honestly:
 *   - one real broker, with ping_interval/ping_max tuned down so the server reaps a dead client
 *     link in seconds instead of the default minutes;
 *   - the manager and the seat dial the broker DIRECTLY, so nothing about them is faulted;
 *   - the attach CLI dials a node `net` TCP proxy in front of the broker. SEVER destroys every
 *     live socket and stops accepting; HEAL starts accepting again. Only the client's link dies.
 *   - the CLI child runs under a REAL pty, so `stdin.isTTY`/`stdout.isTTY` are true and the
 *     raw-mode path is the one under test.
 *
 * It measures and prints; it asserts nothing. Run: pnpm probe:attach-reconnect
 * Env: PROBE_HEAL_AFTER_MS (default 45000) — how long the link stays dead before it heals.
 *      PROBE_CAP_MS (default 180000) — hard stop.
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

const HEAL_AFTER_MS = Number(process.env.PROBE_HEAL_AFTER_MS ?? 45_000);
const CAP_MS = Number(process.env.PROBE_CAP_MS ?? 180_000);

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
// The connector seed store is NOT under COTAL_HOME (it is under `globalConfigDir()`), and
// every `cotal` command reconciles it, refusing when its generation is newer than this
// binary. Isolate it or a probe run from an older tip dies on the operator's store.
process.env.XDG_CONFIG_HOME = join(dir, "xdg");
mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
const space = `attachrc-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);

// A fast-ping broker: the whole point is that a dead client link is DETECTED, and the stock
// 2-minute ping with 2 misses would put every observation four minutes downstream of the fault.
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

const envFor = (o: LaunchOpts): Record<string, string> => ({
  COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? BROKER), COTAL_CREDS: String(o.creds),
  COTAL_ID: String(o.id), COTAL_NAME: o.name, PATH: process.env.PATH ?? "",
  ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
});
registry.register({
  kind: "connector", name: "rc-seat", requires: ["node"],
  buildLaunch: (o): LaunchSpec => ({ command: process.execPath, args: [SEAT_STUB], env: envFor(o) }),
} as Connector);

const SEAT = "rcseat";
let manager: InstanceType<typeof Manager> | undefined;
let child: ReturnType<typeof pty.spawn> | undefined;
const T0 = Date.now();
const transcript: { t: number; s: string }[] = [];
const stamp = (s: string) => transcript.push({ t: Date.now() - T0, s });

try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(BROKER)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${BROKER_PORT}`);
  await setupSpaceStreams({ servers: BROKER, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  await listenProxy();

  const root = join(dir, "ws");
  mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(root, ".cotal", "agents", `${SEAT}.md`), `---\nname: ${SEAT}\nrole: worker\n---\n`);
  saveSpaceAuth(authDir(root), auth);
  // COTAL_HOME is read when the registry module loads, so pull it in AFTER the sandbox is set.
  const { recordMesh } = await import("@cotal-ai/workspace");
  recordMesh({ space, server: BROKER, root, mode: "auth", ts: new Date().toISOString() });

  manager = new Manager({ space, servers: BROKER, runtime: "pty", workspaceRoot: root });
  await manager.start();
  const started = await manager.startAgent({ name: SEAT, agent: "rc-seat", cwd: repoRoot });
  if (!started.ok) throw new Error(`seat did not start: ${JSON.stringify(started)}`);
  console.log(`seat ${SEAT} is running on the manager\n`);

  // The attach client, under a real pty, pointed at the PROXY.
  child = pty.spawn("npx", ["tsx", BIN, "attach", "--name", SEAT, "--space", space, "--server", PROXY], {
    name: "xterm-256color", cols: 100, rows: 30, cwd: root,
    env: { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, COTAL_SPACE: "", COTAL_SERVERS: "", COTAL_CREDS: "" } as Record<string, string>,
  });
  let exited: { exitCode: number; signal?: number } | undefined;
  child.onData((d) => stamp(d));
  child.onExit((e) => { exited = e; stamp(`\n<<CHILD EXIT code=${e.exitCode} signal=${e.signal ?? "none"}>>\n`); });

  const seen = () => transcript.map((x) => x.s).join("");
  const waitFor = async (re: RegExp, ms: number, what: string): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (re.test(seen())) return true;
      if (exited) return re.test(seen());
      await wait(100);
    }
    return re.test(seen());
  };

  if (!(await waitFor(/attached to/, 60_000, "attach banner"))) throw new Error("the attach never came up");
  if (!(await waitFor(/TICK-\d+/, 20_000, "first tick"))) throw new Error("no seat output reached the client");
  const ticksBefore = [...seen().matchAll(/TICK-(\d+)/g)].map((m) => Number(m[1]));
  const tSever = Date.now() - T0;
  console.log(`t=${tSever}ms  attach is live (last tick seen: TICK-${Math.max(...ticksBefore)}). SEVERING the client link.`);
  stamp(`\n<<PROBE: SEVER at t=${tSever}ms>>\n`);
  await sever();

  // Watch. Report everything the child says, and whether it exits at all.
  const healAt = Date.now() + HEAL_AFTER_MS;
  let healed = false;
  const cap = Date.now() + CAP_MS;
  while (Date.now() < cap && !exited) {
    if (!healed && Date.now() >= healAt) {
      healed = true;
      const t = Date.now() - T0;
      console.log(`t=${t}ms  HEALING the client link.`);
      stamp(`\n<<PROBE: HEAL at t=${t}ms>>\n`);
      await listenProxy();
      // Give the healed link 30s to show whatever it is going to show, then stop.
      setTimeout(() => { /* the cap loop below governs */ }, 0);
    }
    if (healed && Date.now() - healAt > 45_000) break;
    await wait(200);
  }

  const tEnd = Date.now() - T0;
  console.log(`\n=== TRANSCRIPT (t in ms from probe start; sever at t=${tSever}ms) ===`);
  for (const e of transcript) {
    const line = e.s.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\x1b/g, "\\e");
    if (line.trim()) console.log(`  [${String(e.t).padStart(6)}] ${line}`);
  }
  console.log(`\n=== VERDICT at t=${tEnd}ms ===`);
  console.log(`  child exited: ${exited ? `YES  code=${exited.exitCode} signal=${exited.signal ?? "none"}` : "NO (still running)"}`);
  const tail = seen();
  const detached = /detached from/.exec(tail);
  console.log(`  printed "detached from": ${detached ? "YES" : "NO"}`);
  const err = /mesh session transport error: (\S+)/.exec(tail);
  console.log(`  transport error reason: ${err ? err[1] : "(none printed)"}`);
  const ticksAfter = [...tail.matchAll(/TICK-(\d+)/g)].map((m) => Number(m[1]));
  console.log(`  ticks before sever: max TICK-${Math.max(...ticksBefore)}; ticks overall: max TICK-${Math.max(...ticksAfter)}`);
  console.log(`  healed at: ${healed ? "yes" : "no"}`);
} finally {
  child?.kill("SIGKILL");
  await sever();
  await manager?.stop().catch(() => {});
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
process.exit(0);
