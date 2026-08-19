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
  const trigger = join(dir, "coop-start-drain");
  const violation = join(dir, "coop-turn-in-cutover");
  const markerQueued = join(dir, "coop-queued-swap-ran");
  mkdirSync(join(dir, "ws"), { recursive: true });
  probe = spawn(process.execPath, ["--import", "tsx", PROBE], {
    env: {
      ...process.env,
      ...spec.env,
      COTAL_EVENTS: "1",
      COTAL_WORKSPACE_ROOT: join(dir, "ws"),
      COOP_MARKER: marker,
      COOP_TRIGGER: trigger,
      COOP_VIOLATION: violation,
      COOP_MARKER_QUEUED: markerQueued,
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

  // Start a drain and stop the seat while it is STILL RUNNING. Fired earlier, it would finish on
  // its own and the marker would say nothing about whether the stop waited.
  writeFileSync(trigger, "go\n");
  await wait(400);

  // ASK FOR A TURN WHILE THE CUTOVER IS OPEN, through the ordinary door rather than the one the swap
  // itself uses. Adopting a session clears `busy`, and the inbox handler starts a turn on `!busy`, so
  // a plain inbound message is enough; nothing here reaches into the plugin. The refusal has to come
  // from the connector deciding no turn may start mid-cutover.
  const otto = watcher.getRoster().find((pr) => pr.card.name === "Otto");
  if (otto) await watcher.unicast(otto.card.id, "a message arriving mid-cutover");
  await wait(600);

  // Drive the cooperative shutdown — exactly what the manager sends on a win32 graceful stop.
  const reply = await sendShutdown(ep.path, ep.token);
  check("control server acked the shutdown", reply.trim() === JSON.stringify({ ok: true }), reply);

  // The plugin leaves the mesh cleanly: Otto flips offline, and the probe exits 0.
  let ottoOffline = false;
  let markerAtOffline = true;
  for (let i = 0; i < 60 && !ottoOffline; i++) {
    await wait(100);
    ottoOffline = watcher.getRoster().find((p) => p.card.name === "Otto")?.status === "offline";
    // Sampled AT the moment presence flips, because the question is an ORDER and it is unanswerable
    // afterwards: by the end of the run both have happened either way.
    if (ottoOffline) markerAtOffline = existsSync(marker);
  }
  check("cooperative stop leaves the mesh (watcher sees Otto offline)", ottoOffline, watcher.getRoster().find((p) => p.card.name === "Otto")?.status);

  await awaitExit(probe, 15_000);
  check("the plugin process exited cleanly (0) on cooperative shutdown", probeExit === 0, probeExit);

  // ---- THE SAME ORDER, AGAINST A KILL. The cells above grade the ORDER and cannot grade whether it
  // is sufficient, because this harness spawns the probe directly: no runtime, no grace window, no
  // SIGKILL. That is exactly the blindness the ordering fix exists to correct, so grading the fix
  // only here would let it inherit that blindness. This leg supplies the missing half: a second seat
  // is stopped and then KILLED after a grace window shorter than its drain, the way `pty.ts` and the
  // tmux and cmux runtimes do, and presence must already have left the mesh.
  //
  // The window is real rather than nominal. Presence goes stale on its own after the endpoint's TTL,
  // 6s, so a roster that says offline long enough after a kill says nothing about who published it.
  // Sampling about one second after the stop keeps the reading inside that margin, so an offline seen
  // here was PUBLISHED and not inferred from silence.
  // A FRESH control endpoint for the second seat rather than the first one's. Reusing it would ask
  // the plugin to bind a socket path a dead process may still own, and that binding is deliberately
  // fatal so a squatter cannot hijack a control plane, so the leg would fail on setup rather than on
  // the behaviour it grades.
  const spec2 = opencodeConnector.buildLaunch({
    space, name: "Otto", role: "worker", id: ottoId.id, lifecycleUid: ottoUid, creds: credsFile,
    servers: SERVERS, subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"],
  });
  const ep2 = spec2.control!;
  const marker2Path = join(dir, "coop-kill-read-finished");
  const trigger2 = join(dir, "coop-kill-start-drain");
  let probeExit2: number | null = null;
  const probe2 = spawn(process.execPath, ["--import", "tsx", PROBE], {
    env: {
      ...process.env,
      ...spec2.env,
      COTAL_EVENTS: "1",
      COTAL_WORKSPACE_ROOT: join(dir, "ws2"),
      COOP_MARKER: marker2Path,
      COOP_TRIGGER: trigger2,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  probe2.on("exit", (code) => (probeExit2 = code ?? -1));
  mkdirSync(join(dir, "ws2"), { recursive: true });

  let live2 = false;
  for (let i = 0; i < 100 && !live2; i++) {
    await wait(100);
    const o = watcher.getRoster().find((pr) => pr.card.name === "Otto");
    live2 = o !== undefined && o.status !== "offline";
  }
  check("the second seat came online, so the kill leg grades a live one", live2);

  writeFileSync(trigger2, "go\n");
  await wait(300);
  const reply2 = await sendShutdown(ep2.path, ep2.token);
  check("control server acked the second shutdown", reply2.trim() === JSON.stringify({ ok: true }), reply2);

  // A grace window shorter than the drain, then the kill the runtime would send.
  await wait(400);
  try {
    probe2.kill("SIGKILL");
  } catch {
    /* already gone */
  }

  let offlineAfterKill = false;
  for (let i = 0; i < 10 && !offlineAfterKill; i++) {
    await wait(100);
    offlineAfterKill = watcher.getRoster().find((pr) => pr.card.name === "Otto")?.status === "offline";
  }
  check("a seat killed mid-drain had ALREADY left the mesh, so no stale live entry survives it",
    offlineAfterKill, { offlineAfterKill, drainFinished: existsSync(marker2Path) });
  await awaitExit(probe2, 5_000).catch(() => undefined);

  // THE MANAGER'S STOP IS A TEARDOWN TOO, and it is the one a supervised seat actually takes.
  // The join went into the plugin-unload path first, with an absolute claim above it that nothing
  // publishes after teardown; this path ran a separate routine that exited without joining, so the
  // claim was false exactly where it mattered. The marker is written by the probe when a queued
  // read finishes, so it exists only if the stop waited for work that was already in flight.
  // LEAVING THE MESH MUST NOT QUEUE BEHIND THE DRAIN. A supervised stop is hard-killed after the
  // runtime's grace window, 1.5s for tmux and cmux and 3s for pty, and the join is bounded far above
  // that on purpose, so a seat whose drain outlives the window is killed part way through. If
  // presence waited for the drain it would be the thing lost, and the roster would hold a live entry
  // for a dead process. So offline has to land while the drain is still running, not after it.
  check("the seat left the mesh BEFORE the drain finished, not behind it",
    ottoOffline && !markerAtOffline, { ottoOffline, markerAtOffline });

  check("cooperative stop joined the queued event work before exiting", existsSync(marker), { marker });

  // The other half of the same window. The drain covers the event plane; this covers turns.
  check("no turn was started while the cutover was open", !existsSync(violation), { violation });

  // The case the running-drain cell cannot reach. A swap queued behind the one in flight has not
  // begun when the stop arrives, so the holder join does not cover it and only joining the chain
  // does. Without this, removing the chain join alone stays green.
  check("a swap still QUEUED at the stop was allowed to run before exit", existsSync(markerQueued), { markerQueued });
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
