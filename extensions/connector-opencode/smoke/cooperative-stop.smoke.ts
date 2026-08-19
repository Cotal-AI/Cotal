/**
 * OpenCode cooperative-stop smoke (no test runner) — run with: pnpm smoke:opencode-coop
 *
 * Proves the opencode connector's control plane (extension.ts mints the endpoint + the plugin starts
 * the control server) leaves the mesh CLEANLY on a cooperative shutdown — the same {op:"shutdown"}
 * the manager sends on a signal-less runtime (ConPTY/Windows), instead of leaving the agent online
 * until its presence TTL expires. The real path, end to end:
 *
 *   parent sends {token,op:"shutdown"}  →  the plugin's startControlServer first-frame auth
 *     →  onShutdown  →  agent.stop()  →  offline presence published  →  the plugin process exits 0.
 *
 * The plugin runs in a SUBPROCESS (cooperative-stop-probe.ts) because its cooperative shutdown ends in
 * process.exit; the parent provisions a real JWT-auth broker + scoped creds, watches presence, drives
 * the shutdown, and asserts both the offline flip AND a clean exit(0). Bun-on-Windows named pipes for
 * the real opencode runtime are the one piece this can't reach (no opencode-in-Windows-CI yet); this
 * runs under Node where node:net abstracts the socket, so it guards the wiring + the agent.stop path.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CotalEndpoint,
  isReachable,
  createSpaceAuth,
  mintCreds,
  provisionAgent,
  mintLifecycleUid,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
} from "@cotal-ai/core";
import { opencodeConnector } from "../src/extension.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

// An OS-assigned free port (see _free-port.ts): a Windows-reserved port makes nats-server fail to bind.
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

// Send the manager's cooperative-shutdown frame to a control endpoint and return its reply.
function sendShutdown(path: string, token: string): Promise<string> {
  return new Promise((resolve) => {
    const sock = connect(path);
    let reply = "";
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(reply);
    };
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify({ token, op: "shutdown" }) + "\n"));
    sock.on("data", (d) => (reply += d));
    sock.on("end", finish);
    sock.on("close", finish);
    sock.on("error", finish);
    setTimeout(finish, 2000);
  });
}

const space = `oc-coop-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

let mgr: CotalEndpoint | undefined;
let watcher: CotalEndpoint | undefined;
let probe: ReturnType<typeof spawn> | undefined;

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) {
      up = true;
      break;
    }
    await wait(200);
  }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  mgr = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: mgrCreds,
    card: { name: "mgr", kind: "endpoint" },
    consume: false,
    registerPresence: false,
    watchPresence: false,
    heartbeatMs: 300,
    ttlMs: 1500,
  });
  await mgr.start();

  const acl = { subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"] };
  const ottoId = newIdentity();
  const watchId = newIdentity();
  const ottoUid = mintLifecycleUid(); // one lifecycle uid per agent (SPEC §13.1) — provision + launch env + child endpoint
  const watchUid = mintLifecycleUid();
  const ottoCreds = await provisionAgent(mgr, auth, ottoId, { ...acl, role: "worker", lifecycleUid: ottoUid });
  const watchCreds = await provisionAgent(mgr, auth, watchId, { ...acl, role: "watcher", lifecycleUid: watchUid });

  // The watcher endpoint observes Otto's presence (the proof of a clean leave).
  watcher = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: watchCreds,
    card: { id: watchId.id, name: "watch", role: "watcher", kind: "agent" },
    channels: ["general"],
    lifecycleUid: watchUid,
    heartbeatMs: 500,
    ttlMs: 30_000,
  });
  watcher.on("error", (e: Error) => console.error("  ! watcher:", e.message));
  await watcher.start();

  // Write Otto's creds to a file (COTAL_CREDS is a path), then build the launch THROUGH the connector
  // — so this also guards that buildLaunch attaches the control endpoint to the LaunchSpec + child env
  // (a regression dropping that wiring fails here instead of passing green on a hand-built env).
  const credsFile = join(dir, "otto.creds");
  writeFileSync(credsFile, ottoCreds);
  const spec = opencodeConnector.buildLaunch({
    space,
    name: "Otto",
    role: "worker",
    id: ottoId.id,
    lifecycleUid: ottoUid,
    creds: credsFile,
    servers: SERVERS,
    subscribe: ["general"],
    allowSubscribe: ["general"],
    allowPublish: ["general"],
  });
  check(
    "buildLaunch attaches the control endpoint to the LaunchSpec + child env",
    !!spec.control && spec.env?.COTAL_CONTROL_SOCKET === spec.control.path && spec.env?.COTAL_CONTROL_TOKEN === spec.control.token,
    spec.control,
  );
  const ep = spec.control!;

  // Boot the REAL plugin in a subprocess with the connector-built env (Otto's identity + control).
  const PROBE = fileURLToPath(new URL("./cooperative-stop-probe.ts", import.meta.url));
  // Arm the event plane and hand the probe a marker path. The marker is written by the probe's
  // own fake OpenCode server when it finishes answering a queued read, so its presence after the
  // process is gone says the drain was allowed to finish rather than cut off by the exit.
  const marker = join(dir, "coop-read-finished");
  mkdirSync(join(dir, "ws"), { recursive: true });
  probe = spawn(process.execPath, ["--import", "tsx", PROBE], {
    env: {
      ...process.env,
      ...spec.env,
      COTAL_EVENTS: "1",
      COTAL_WORKSPACE_ROOT: join(dir, "ws"),
      COOP_MARKER: marker,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  let probeExit: number | null = null;
  probe.on("exit", (code) => (probeExit = code ?? -1));

  // Wait for the plugin's mesh agent to come online (Otto live in the watcher's roster).
  let ottoLive = false;
  for (let i = 0; i < 100 && !ottoLive; i++) {
    await wait(100);
    const otto = watcher.getRoster().find((p) => p.card.name === "Otto");
    ottoLive = otto !== undefined && otto.status !== "offline";
  }
  check("the opencode plugin came online (Otto live in the watcher roster)", ottoLive);

  // Drive the cooperative shutdown — exactly what the manager sends on a win32 graceful stop.
  const reply = await sendShutdown(ep.path, ep.token);
  check("control server acked the shutdown", reply.trim() === JSON.stringify({ ok: true }), reply);

  // The plugin leaves the mesh cleanly: Otto flips offline, and the probe exits 0.
  let ottoOffline = false;
  for (let i = 0; i < 60 && !ottoOffline; i++) {
    await wait(100);
    ottoOffline = watcher.getRoster().find((p) => p.card.name === "Otto")?.status === "offline";
  }
  check("cooperative stop leaves the mesh (watcher sees Otto offline)", ottoOffline, watcher.getRoster().find((p) => p.card.name === "Otto")?.status);

  await awaitExit(probe, 15_000);
  check("the plugin process exited cleanly (0) on cooperative shutdown", probeExit === 0, probeExit);

  // THE MANAGER'S STOP IS A TEARDOWN TOO, and it is the one a supervised seat actually takes.
  // The join went into the plugin-unload path first, with an absolute claim above it that nothing
  // publishes after teardown; this path ran a separate routine that exited without joining, so the
  // claim was false exactly where it mattered. The marker is written by the probe when a queued
  // read finishes, so it exists only if the stop waited for work that was already in flight.
  check("cooperative stop joined the queued event work before exiting", existsSync(marker), { marker });
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
} finally {
  try {
    if (probe && probe.exitCode === null) probe.kill("SIGKILL");
  } catch {
    /* ignore */
  }
  for (const ep of [watcher, mgr]) {
    try {
      await ep?.stop();
    } catch {
      /* already down */
    }
  }
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}

console.log(`\n${fail === 0 ? "OPENCODE COOPERATIVE-STOP SMOKE OK ✅" : "OPENCODE COOPERATIVE-STOP SMOKE FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
