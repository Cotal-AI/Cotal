/**
 * Does a PIPED one-shot attach give the process back when it detaches?
 * Run: pnpm probe:pipe-oneshot   (needs nats-server + node on PATH; boots its own broker). (#585)
 *
 * WHY A PROBE AND NOT ONLY A CELL. Cell M of `smoke:attach-stdin` grades this route inside the
 * gate, which answers "is the exit release load-bearing in THIS build". It cannot answer "what does
 * the build that ships today do", because the gate does not exist on that build. That sentence is a
 * claim about another artifact, so it is measured on that artifact: this file is the SAME trigger,
 * run in whichever worktree it sits in, against whichever CLI that worktree has built.
 *
 * WHAT IT DOES. A broker, a manager and a real seat, then `cotal attach --no-reconnect` with stdin a
 * PIPE: write a nonce, wait for the seat to receive it, write the detach byte, and time the exit. No
 * proxy and no fault: this route never loses a link, and adding one would measure a different thing.
 *
 * WHAT IT PRINTS. The worktree's HEAD, whether the built `dist` contains the exit release (so an arm
 * cannot silently grade a stale or unbuilt tree), and one VERDICT line: the exit code and the
 * milliseconds from the detach byte to the exit, or HANG with the deadline that expired.
 */
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
const EXIT_DEADLINE_MS = 30_000;

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

// The artifact this arm actually drives, printed rather than assumed: `pnpm cotal` resolves
// `@cotal-ai/cli` to `dist`, so a source tree that was never built grades the previous build.
const head = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const distFile = join(repoRoot, "implementations", "cli", "dist", "commands", "agents.js");
const dist = existsSync(distFile) ? readFileSync(distFile, "utf8") : "";
if (!dist) throw new Error(`no built CLI at ${distFile}: run pnpm build in this worktree first`);
console.log(`arm: worktree=${repoRoot}\n     head=${head}\n     built CLI has the exit release (process.stdin.unref): ${dist.includes("stdin.unref()")}`);

const BROKER_PORT = await freePort();
const BROKER = `nats://127.0.0.1:${BROKER_PORT}`;
console.log(`     broker=${BROKER} (ephemeral loopback; no env var references ${LIVE_HOST})\n`);

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const home = join(dir, "home");
mkdirSync(home, { recursive: true });
process.env.COTAL_HOME = home;
process.env.XDG_CONFIG_HOME = join(dir, "xdg");
mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
const space = `pipe1-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const SINK = join(dir, "seat-input.bin");
const PIDSINK = join(dir, "seat.pid");
writeFileSync(SINK, "");

writeFileSync(
  join(dir, "server.conf"),
  serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: BROKER_PORT, storeDir: join(dir, "js") }),
);
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

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

const sink = (): Buffer => readFileSync(SINK);
const seatAlive = (): boolean => { try { process.kill(Number(readFileSync(PIDSINK, "utf8")), 0); return true; } catch { return false; } };

let manager: InstanceType<typeof Manager> | undefined;
let child: ReturnType<typeof spawn> | undefined;
try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(BROKER)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${BROKER_PORT}`);
  await setupSpaceStreams({ servers: BROKER, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

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
  if (!seatAlive()) throw new Error("the seat never came up");

  const n = `N${randomUUID().slice(0, 8).toUpperCase()}`;
  const mark = sink().length;
  child = spawn("npx", ["tsx", BIN, "attach", "--name", SEAT, "--space", space, "--server", BROKER, "--no-reconnect"], {
    cwd: root,
    env: { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, COTAL_SPACE: "", COTAL_SERVERS: "", COTAL_CREDS: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  let code: number | undefined;
  child.stdout?.on("data", (d) => { buf += String(d); });
  child.stderr?.on("data", (d) => { buf += String(d); });
  child.on("close", (c) => { code = c ?? 0; });

  child.stdin?.write(`${n}\n`);
  let delivered = false;
  for (let i = 0; i < 150 && !delivered; i++) { delivered = sink().subarray(mark).includes(Buffer.from(n)); if (!delivered) await wait(200); }
  if (!delivered) console.log(`note: the nonce never reached the seat, so this arm never had a live session: ${buf.slice(-300)}`);

  const t0 = Date.now();
  child.stdin?.write(DETACH);
  const deadline = t0 + EXIT_DEADLINE_MS;
  while (code === undefined && Date.now() < deadline) await wait(100);
  const ms = Date.now() - t0;
  const said = /detached from/.test(buf);
  console.log(`\nVERDICT exit=${code === undefined ? "HANG" : code} ms=${code === undefined ? `>${EXIT_DEADLINE_MS}` : ms} delivered=${delivered} saidDetached=${said}`);
  console.log(`transcript tail: ${JSON.stringify(buf.slice(-400))}`);
} finally {
  try { child?.kill("SIGKILL"); } catch { /* already gone */ }
  await manager?.stop().catch(() => {});
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
