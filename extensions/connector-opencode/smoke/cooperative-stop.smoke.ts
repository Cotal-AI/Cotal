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
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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

// THE SEATS DO NOT INHERIT THE OPERATOR'S OWN SESSION. Ambient COTAL_* and OPENCODE_* belong to
// whoever is RUNNING this suite, and a launch spec only overrides the keys it sets, so anything else
// survives into the child and quietly changes what is under test. Measured, not precautionary: run
// from inside a meshed session, the inherited COTAL_MODEL is an operator model pin, the connector
// treats a pin as authoritative and never records a runtime model, so the seat that grades the model
// publish could not make one at all and its control failed. It would have passed in CI, where that
// variable is unset, which is the worst version of this: green where it is checked, wrong where it
// is written.
const HOST_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && !k.startsWith("OPENCODE_")),
);

const space = `oc-coop-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

let mgr: CotalEndpoint | undefined;
let watcher: CotalEndpoint | undefined;
let probe: ReturnType<typeof spawn> | undefined;
let toolProbe: ReturnType<typeof spawn> | undefined;
let modelProbe: ReturnType<typeof spawn> | undefined;

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
  const prompts = join(dir, "coop-prompts");
  const markerQueued = join(dir, "coop-queued-swap-ran");
  const late = join(dir, "coop-knock-now");
  const lateFired = join(dir, "coop-knocked");
  const crossParked = join(dir, "coop-crossing-parked");
  const crossRelease = join(dir, "coop-crossing-release");
  const crossArm = join(dir, "coop-crossing-arm");
  mkdirSync(join(dir, "ws"), { recursive: true });
  probe = spawn(process.execPath, ["--import", "tsx", PROBE], {
    env: {
      ...HOST_ENV,
      ...spec.env,
      COTAL_EVENTS: "1",
      COTAL_WORKSPACE_ROOT: join(dir, "ws"),
      COOP_MARKER: marker,
      COOP_TRIGGER: trigger,
      COOP_VIOLATION: violation,
      COOP_PROMPTS: prompts,
      COOP_MARKER_QUEUED: markerQueued,
      COOP_LATE: late,
      COOP_LATE_FIRED: lateFired,
      COOP_CROSS: "hook",
      COOP_CROSS_ARM: crossArm,
      COOP_CROSS_PARKED: crossParked,
      COOP_CROSS_RELEASE: crossRelease,
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
  // Armed only now, because the probe's caller must be admitted while the seat is genuinely online.
  writeFileSync(crossArm, "go\n");
  writeFileSync(trigger, "go\n");
  await wait(400);

  // ASK FOR A TURN WHILE THE CUTOVER IS OPEN, through the ordinary door rather than the one the swap
  // itself uses. Adopting a session clears `busy`, and the inbox handler starts a turn on `!busy`, so
  // a plain inbound message is enough; nothing here reaches into the plugin. The refusal has to come
  // from the connector deciding no turn may start mid-cutover.
  const otto = watcher.getRoster().find((pr) => pr.card.name === "Otto");
  if (otto) await watcher.unicast(otto.card.id, "a message arriving mid-cutover");
  await wait(600);

  // Sampled at the ACK, because the question is whether teardown STARTS anything, and by the end of
  // the run a prompt from before the stop is indistinguishable from one after it.
  const promptsAtStop = existsSync(prompts) ? readFileSync(prompts, "utf8").split("\n").filter(Boolean).length : 0;

  // Checked BEFORE the stop, because it is the precondition rather than the result: the caller must
  // already be inside its presence write for the crossing to be the thing under test.
  let hookParked = false;
  for (let i = 0; i < 40 && !hookParked; i++) {
    await wait(50);
    hookParked = existsSync(crossParked);
  }
  check("hook-seat: the pre-stop hook parked inside its presence write", hookParked, { crossParked });

  // Drive the cooperative shutdown — exactly what the manager sends on a win32 graceful stop.
  const reply = await sendShutdown(ep.path, ep.token);

  // ---- THE ORDERING IS SAMPLED DIRECTLY, BEFORE THE RELEASE, and that is the whole instrument.
  //
  // The obvious cell, release and then look for an inversion, does not work and the reason is worth
  // keeping: with the wait removed, departure and the straggler's write both land between two polls,
  // so the parent never observes the intermediate offline at all, and the next offline it sees is
  // the one agent.stop publishes at the very end. By then the inversion has been repaired by the
  // code under test, so the cell reads green while the implementation is broken. Measured, not
  // supposed: that is exactly how this mutation came back WRONG-RED.
  //
  // So ask the question the fix actually answers instead. While a presence write it admitted is
  // still in flight, the teardown must NOT have published departure yet. A correct teardown is
  // holding, so the seat is still non-offline here; one that does not wait has already departed.
  // 300ms is inside the 1s bound, so the correct arm is still holding, and far past the moment an
  // unwaiting teardown publishes.
  await wait(300);
  const beforeRelease = watcher.getRoster().find((pr) => pr.card.name === "Otto")?.status;
  check("hook-seat: departure was still unpublished while admitted work was in flight",
    beforeRelease !== undefined && beforeRelease !== "offline", { beforeRelease });
  writeFileSync(crossRelease, "go\n");
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

  // ---- ADMISSION IS CLOSED, and it is graded here rather than at the end because it is only
  // answerable while the process is still up: once it exits, losing the connection purges presence
  // and every seat reads offline whether or not anything reversed it first. The teardown's joins are
  // what hold it open, and the trigger is written only after the offline record has been SEEN, so
  // what lands is unambiguously post-teardown.
  writeFileSync(late, "go\n");
  let reversed: string | undefined;
  let knocked = false;
  // 3s of sampling, inside a drain that is three slow reads long, because both this and the control
  // below are read from the same loop: too short a window and a loaded box reports the knock as
  // undelivered, which reddens the control rather than the claim and grades nothing either way.
  for (let i = 0; i < 50 && reversed === undefined; i++) {
    await wait(60);
    knocked = knocked || existsSync(lateFired);
    const s = watcher.getRoster().find((p) => p.card.name === "Otto")?.status;
    if (s !== undefined && s !== "offline") reversed = s;
  }
  // THE POSITIVE CONTROL, and it is a separate cell on purpose: without it, "nothing changed" also
  // passes on a probe that never knocked, which is the vacuous shape this suite has already shipped
  // twice. If this one is the red, the cell below graded nothing and its result means nothing.
  check("every public hook entry was knocked on after the seat went offline", knocked, { lateFired });

  check("nothing admitted after teardown began put the seat back on the mesh",
    reversed === undefined, { reversed });

  await awaitExit(probe, 15_000);
  check("the plugin process exited cleanly (0) on cooperative shutdown", probeExit === 0, probeExit);


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

  // AND NONE WAS STARTED BY THE TEARDOWN ITSELF, which is a different fault. The mid-cutover
  // refusal does not cover it: the swap fires a deferred drive once its own cutover completes,
  // and that can land while the stop is still joining the chain, so a teardown that carefully
  // drained the old work would start new work behind its own back after going offline. The
  // buffered message from the cell above is what makes it reachable, since it leaves pending
  // input for that deferred drive to pick up.
  const promptsAtEnd = existsSync(prompts) ? readFileSync(prompts, "utf8").split("\n").filter(Boolean).length : 0;
  check("the teardown started no turn of its own after the stop began",
    promptsAtEnd === promptsAtStop, { promptsAtStop, promptsAtEnd });

  // The case the running-drain cell cannot reach. A swap queued behind the one in flight has not
  // begun when the stop arrives, so the holder join does not cover it and only joining the chain
  // does. Without this, removing the chain join alone stays green.
  check("a swap still QUEUED at the stop was allowed to run before exit", existsSync(markerQueued), { markerQueued });

  // ---- A SECOND SEAT, FOR THE OTHER DOOR. There is one teardown per process, and two callers
  // parked in the same one mask each other: waiting on either holds departure until both have
  // resumed, so removing the tracking from one path changes nothing and its mutation survives.
  // Measured rather than predicted; that is exactly how the first version of these two survived.
  //
  // This seat needs no event work. What holds the process open long enough to be sampled is the
  // teardown waiting on the parked call itself, which is the thing under test.
  const tillyId = newIdentity();
  const tillyUid = mintLifecycleUid();
  const tillyCreds = await provisionAgent(mgr, auth, tillyId, { ...acl, role: "worker", lifecycleUid: tillyUid });
  const tillyCredsFile = join(dir, "tilly.creds");
  writeFileSync(tillyCredsFile, tillyCreds);
  const toolSpec = opencodeConnector.buildLaunch({
    space, name: "Tilly", role: "worker", id: tillyId.id, lifecycleUid: tillyUid, creds: tillyCredsFile,
    servers: SERVERS, subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"],
  });
  const toolEp = toolSpec.control!;
  const toolArm = join(dir, "tool-crossing-arm");
  const toolParked = join(dir, "tool-crossing-parked");
  const toolRelease = join(dir, "tool-crossing-release");
  mkdirSync(join(dir, "ws-tool"), { recursive: true });
  toolProbe = spawn(process.execPath, ["--import", "tsx", PROBE], {
    env: {
      ...HOST_ENV,
      ...toolSpec.env,
      COTAL_WORKSPACE_ROOT: join(dir, "ws-tool"),
      COOP_CROSS: "tool",
      COOP_CROSS_ARM: toolArm,
      COOP_CROSS_PARKED: toolParked,
      COOP_CROSS_RELEASE: toolRelease,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  let tillyLive = false;
  for (let i = 0; i < 100 && !tillyLive; i++) {
    await wait(100);
    const tilly = watcher.getRoster().find((pr) => pr.card.name === "Tilly");
    tillyLive = tilly !== undefined && tilly.status !== "offline";
  }
  check("tool-seat: the second seat came online, so this leg grades a live one", tillyLive);

  writeFileSync(toolArm, "go\n");
  let toolParkedSeen = false;
  for (let i = 0; i < 60 && !toolParkedSeen; i++) {
    await wait(50);
    toolParkedSeen = existsSync(toolParked);
  }
  check("tool-seat: the pre-stop tool call parked inside its presence write", toolParkedSeen, { toolParked });

  const toolReply = await sendShutdown(toolEp.path, toolEp.token);
  check("tool-seat: control server acked the shutdown", toolReply.trim() === JSON.stringify({ ok: true }), toolReply);

  // Same instrument as the hook seat, and the same reasoning: sampled directly, before the release,
  // because an inversion looked for afterwards can complete between two polls and then be repaired
  // by the terminal stop, leaving the cell green against a broken implementation.
  await wait(300);
  const toolBeforeRelease = watcher.getRoster().find((pr) => pr.card.name === "Tilly")?.status;
  check("tool-seat: departure was still unpublished while admitted work was in flight",
    toolBeforeRelease !== undefined && toolBeforeRelease !== "offline", { toolBeforeRelease });
  writeFileSync(toolRelease, "go\n");
  await awaitExit(toolProbe, 15_000);

  // ---- A THIRD SEAT, FOR THE THIRD PRESENCE WRITER. The prompt hook records the model, and that
  // publishes presence without passing through the connector's status helper, so it is tracked at
  // its own call site and therefore needs its own proof. Its own seat for the same reason as the
  // second: a caller parked in a teardown that is already holding for another caller is masked, so
  // its mutation would survive while looking covered.
  const miloId = newIdentity();
  const miloUid = mintLifecycleUid();
  const miloCreds = await provisionAgent(mgr, auth, miloId, { ...acl, role: "worker", lifecycleUid: miloUid });
  const miloCredsFile = join(dir, "milo.creds");
  writeFileSync(miloCredsFile, miloCreds);
  const modelSpec = opencodeConnector.buildLaunch({
    space, name: "Milo", role: "worker", id: miloId.id, lifecycleUid: miloUid, creds: miloCredsFile,
    servers: SERVERS, subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"],
  });
  const modelEp = modelSpec.control!;
  const modelArm = join(dir, "model-crossing-arm");
  const modelParked = join(dir, "model-crossing-parked");
  const modelRelease = join(dir, "model-crossing-release");
  mkdirSync(join(dir, "ws-model"), { recursive: true });
  modelProbe = spawn(process.execPath, ["--import", "tsx", PROBE], {
    env: {
      ...HOST_ENV,
      ...modelSpec.env,
      COTAL_WORKSPACE_ROOT: join(dir, "ws-model"),
      COOP_CROSS: "model",
      COOP_CROSS_ARM: modelArm,
      COOP_CROSS_PARKED: modelParked,
      COOP_CROSS_RELEASE: modelRelease,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  let miloLive = false;
  for (let i = 0; i < 100 && !miloLive; i++) {
    await wait(100);
    const milo = watcher.getRoster().find((pr) => pr.card.name === "Milo");
    miloLive = milo !== undefined && milo.status !== "offline";
  }
  check("model-seat: the third seat came online, so this leg grades a live one", miloLive);

  writeFileSync(modelArm, "go\n");
  let modelParkedSeen = false;
  for (let i = 0; i < 60 && !modelParkedSeen; i++) {
    await wait(50);
    modelParkedSeen = existsSync(modelParked);
  }
  check("model-seat: the pre-stop model publish parked inside its presence write", modelParkedSeen, { modelParked });

  const modelReply = await sendShutdown(modelEp.path, modelEp.token);
  check("model-seat: control server acked the shutdown", modelReply.trim() === JSON.stringify({ ok: true }), modelReply);

  await wait(300);
  const modelBeforeRelease = watcher.getRoster().find((pr) => pr.card.name === "Milo")?.status;
  check("model-seat: departure was still unpublished while admitted work was in flight",
    modelBeforeRelease !== undefined && modelBeforeRelease !== "offline", { modelBeforeRelease });
  writeFileSync(modelRelease, "go\n");
  await awaitExit(modelProbe, 15_000);
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
} finally {
  try {
    if (probe && probe.exitCode === null) probe.kill("SIGKILL");
    if (toolProbe && toolProbe.exitCode === null) toolProbe.kill("SIGKILL");
    if (modelProbe && modelProbe.exitCode === null) modelProbe.kill("SIGKILL");
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
