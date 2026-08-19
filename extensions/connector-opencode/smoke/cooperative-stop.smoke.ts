/**
 * OpenCode cooperative-stop smoke (no test runner) — run with: pnpm smoke:opencode-coop
 *
 * Proves the opencode connector's control plane (extension.ts mints the endpoint + the plugin starts
 * the control server) leaves the mesh CLEANLY on a cooperative shutdown — the same {op:"shutdown"}
 * the manager sends on a signal-less runtime (ConPTY/Windows), instead of leaving the agent online
 * until its presence TTL expires. What is asserted is this scenario against a healthy broker: the
 * publish itself is best effort in the product, so a kill or a failed write can still take it, and
 * the sequence below is what a healthy run does rather than a guarantee the mechanism carries.
 * The real path, end to end:
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
let mirrorProbe: ReturnType<typeof spawn> | undefined;
let interiorProbe: ReturnType<typeof spawn> | undefined;
let resumeProbe: ReturnType<typeof spawn> | undefined;
let carryProbe: ReturnType<typeof spawn> | undefined;
let throwProbe: ReturnType<typeof spawn> | undefined;
let collideProbe: ReturnType<typeof spawn> | undefined;

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
  // The watcher also needs `collide`, the history-free channel the ninth seat uses; it is the only
  // publisher there.
  const watchCreds = await provisionAgent(mgr, auth, watchId, {
    ...acl, role: "watcher", lifecycleUid: watchUid,
    subscribe: ["general", "collide"], allowSubscribe: ["general", "collide"], allowPublish: ["general", "collide"],
  });

  // The watcher endpoint observes Otto's presence (the proof of a clean leave).
  watcher = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: watchCreds,
    card: { id: watchId.id, name: "watch", role: "watcher", kind: "agent" },
    // `collide` exists so the ninth seat can join a channel with NO history. Every other seat is on
    // `general`, whose backlog is replayed to each newcomer and DRIVES A BATCH TURN before anything
    // the cell sends; that batch was the drive that parked, so the cell graded the batch path and
    // discriminated nothing. A fresh channel makes the cell's own mention the first drive.
    channels: ["general", "collide"],
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
  const rejectRelease = join(dir, "coop-reject-release");
  const rejectParked = join(dir, "coop-reject-parked");
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
      COOP_REJECT_RELEASE: rejectRelease,
      COOP_REJECT_PARKED: rejectParked,
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

  // BOTH calls must be in the set, or the cell below is about a set of one and cannot see the
  // difference between waiting for all of them and waiting for the first to settle.
  check("hook-seat: a second call was admitted and is waiting to fail", existsSync(rejectParked), { rejectParked });

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
  // still in flight AND the bound has not expired, the teardown must NOT have attempted departure
  // yet. A correct teardown is holding, so the seat is still non-offline here; one that does not
  // wait has already departed. Past the bound a correct teardown DOES depart with work still in
  // flight, which is why the interval below is part of the claim rather than incidental to it.
  // 300ms is inside the 1s bound, so the correct arm is still holding, and far past the moment an
  // unwaiting teardown publishes.
  // THE FAILING CALL IS RELEASED FIRST, inside the bound, so its rejection reaches the teardown's
  // wait while the other call is still parked. If that wait is satisfied by the first settlement
  // rather than by all of them, departure goes out here and the sample below catches it.
  await wait(100);
  writeFileSync(rejectRelease, "go\n");

  await wait(200);
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
  // presence waited for the drain, the EXPLICIT departure publish would be the thing lost and
  // departure would fall back to being inferred from the dropped connection. Not a live entry for a
  // dead process: losing the connection purges the presence record on its own, which the plugin says
  // in the same words. So offline has to land while the drain is still running, not after it.
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

  // ---- THE SAME REJECTION CASE WITH THE TWO CALLS SWAPPED. The hook seat admits the parked call
  // first and the failing one second; this one reverses that, so the failure is at the head of the
  // set. Promise.all short-circuits on the first rejection to OCCUR rather than on a slot, so this
  // is not a second way for the defect to show itself; what it pins is that the absorption covers
  // the head of the set and not only its tail, which the other seat cannot demonstrate. Its own
  // process, because one process has one teardown and shared state would carry between the two.
  const nellId = newIdentity();
  const nellUid = mintLifecycleUid();
  const nellCreds = await provisionAgent(mgr, auth, nellId, { ...acl, role: "worker", lifecycleUid: nellUid });
  const nellCredsFile = join(dir, "nell.creds");
  writeFileSync(nellCredsFile, nellCreds);
  const mirrorSpec = opencodeConnector.buildLaunch({
    space, name: "Nell", role: "worker", id: nellId.id, lifecycleUid: nellUid, creds: nellCredsFile,
    servers: SERVERS, subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"],
  });
  const mirrorEp = mirrorSpec.control!;
  const mirrorArm = join(dir, "mirror-arm");
  const mirrorParked = join(dir, "mirror-parked");
  const mirrorRelease = join(dir, "mirror-release");
  const mirrorRejectParked = join(dir, "mirror-reject-parked");
  const mirrorRejectRelease = join(dir, "mirror-reject-release");
  mkdirSync(join(dir, "ws-mirror"), { recursive: true });
  mirrorProbe = spawn(process.execPath, ["--import", "tsx", PROBE], {
    env: {
      ...HOST_ENV,
      ...mirrorSpec.env,
      COTAL_WORKSPACE_ROOT: join(dir, "ws-mirror"),
      COOP_CROSS: "mirror",
      COOP_CROSS_ARM: mirrorArm,
      COOP_CROSS_PARKED: mirrorParked,
      COOP_CROSS_RELEASE: mirrorRelease,
      COOP_REJECT_PARKED: mirrorRejectParked,
      COOP_REJECT_RELEASE: mirrorRejectRelease,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  let nellLive = false;
  for (let i = 0; i < 100 && !nellLive; i++) {
    await wait(100);
    const nell = watcher.getRoster().find((pr) => pr.card.name === "Nell");
    nellLive = nell !== undefined && nell.status !== "offline";
  }
  check("mirror-seat: the fourth seat came online, so this leg grades a live one", nellLive);

  writeFileSync(mirrorArm, "go\n");
  let mirrorBothIn = false;
  for (let i = 0; i < 60 && !mirrorBothIn; i++) {
    await wait(50);
    mirrorBothIn = existsSync(mirrorRejectParked) && existsSync(mirrorParked);
  }
  // Both preconditions, and in this seat the FAILING one was admitted first.
  check("mirror-seat: the failing call was admitted first and a second call parked behind it",
    mirrorBothIn, { mirrorRejectParked, mirrorParked });

  const mirrorReply = await sendShutdown(mirrorEp.path, mirrorEp.token);
  check("mirror-seat: control server acked the shutdown", mirrorReply.trim() === JSON.stringify({ ok: true }), mirrorReply);

  await wait(100);
  writeFileSync(mirrorRejectRelease, "go\n");
  await wait(200);
  const mirrorBeforeRelease = watcher.getRoster().find((pr) => pr.card.name === "Nell")?.status;
  check("mirror-seat: departure was still unpublished while admitted work was in flight",
    mirrorBeforeRelease !== undefined && mirrorBeforeRelease !== "offline", { mirrorBeforeRelease });
  writeFileSync(mirrorRelease, "go\n");
  await awaitExit(mirrorProbe, 15_000);

  // THE INTERIOR SEAT. The two seats above admit exactly two calls each, one with the failure at the
  // head and one at the tail, and neither can tell absorbing the whole set apart from absorbing only
  // its ends: in a set of two, every index is an end. This seat admits THREE with the failure in the
  // middle, which is the smallest set that has an interior at all. Its own process again, because one
  // process has one teardown.
  const ivyId = newIdentity();
  const ivyUid = mintLifecycleUid();
  const ivyCreds = await provisionAgent(mgr, auth, ivyId, { ...acl, role: "worker", lifecycleUid: ivyUid });
  const ivyCredsFile = join(dir, "ivy.creds");
  writeFileSync(ivyCredsFile, ivyCreds);
  const interiorSpec = opencodeConnector.buildLaunch({
    space, name: "Ivy", role: "worker", id: ivyId.id, lifecycleUid: ivyUid, creds: ivyCredsFile,
    servers: SERVERS, subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"],
  });
  const interiorEp = interiorSpec.control!;
  const interiorArm = join(dir, "interior-arm");
  const interiorParked = join(dir, "interior-parked");
  const interiorRelease = join(dir, "interior-release");
  const interiorRejectParked = join(dir, "interior-reject-parked");
  const interiorRejectRelease = join(dir, "interior-reject-release");
  const interiorShape = join(dir, "interior-shape");
  mkdirSync(join(dir, "ws-interior"), { recursive: true });
  interiorProbe = spawn(process.execPath, ["--import", "tsx", PROBE], {
    env: {
      ...HOST_ENV,
      ...interiorSpec.env,
      COTAL_WORKSPACE_ROOT: join(dir, "ws-interior"),
      COOP_CROSS: "interior",
      COOP_CROSS_ARM: interiorArm,
      COOP_CROSS_PARKED: interiorParked,
      COOP_CROSS_RELEASE: interiorRelease,
      COOP_REJECT_PARKED: interiorRejectParked,
      COOP_REJECT_RELEASE: interiorRejectRelease,
      COOP_INTERIOR_SHAPE: interiorShape,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  let ivyLive = false;
  for (let i = 0; i < 100 && !ivyLive; i++) {
    await wait(100);
    const ivy = watcher.getRoster().find((pr) => pr.card.name === "Ivy");
    ivyLive = ivy !== undefined && ivy.status !== "offline";
  }
  check("interior-seat: the fifth seat came online, so this leg grades a live one", ivyLive);

  writeFileSync(interiorArm, "go\n");
  let interiorReady = false;
  for (let i = 0; i < 60 && !interiorReady; i++) {
    await wait(50);
    interiorReady = existsSync(interiorShape);
  }
  // THE SHAPE IS THE CELL. Without this the leg could grade a two-call set while claiming three, and
  // the mutation it exists to kill would survive again for the same reason it survived before.
  check("interior-seat: three calls were admitted with the failing one between two parked ones",
    interiorReady, { interiorShape, interiorParked, interiorRejectParked });

  const interiorReply = await sendShutdown(interiorEp.path, interiorEp.token);
  check("interior-seat: control server acked the shutdown",
    interiorReply.trim() === JSON.stringify({ ok: true }), interiorReply);

  await wait(100);
  writeFileSync(interiorRejectRelease, "go\n");
  await wait(200);
  const interiorBeforeRelease = watcher.getRoster().find((pr) => pr.card.name === "Ivy")?.status;
  // An interior rejection must not end the wait: both parked calls are still in flight, so departure
  // may not have been published yet.
  check("interior-seat: an interior failure did not release departure while parked work remained",
    interiorBeforeRelease !== undefined && interiorBeforeRelease !== "offline", { interiorBeforeRelease });
  writeFileSync(interiorRelease, "go\n");
  await awaitExit(interiorProbe, 15_000);

  // ---- A SIXTH SEAT, FOR A DRIVE THAT WAS ALREADY PAST THE GUARD.
  //
  // Every seat above parks work that reaches presence. None of them parks a TURN SUBMISSION, and
  // that is a different door: `drive` reads `stopping` and then awaits session creation, so the
  // read and the submission are separated by a server round trip. A drive admitted while the seat
  // was healthy sits inside that round trip when the stop lands, and on resume it submitted a turn
  // after departure had published. The guard cannot see it, because it already passed.
  //
  // The hold is what makes the window certain rather than hoped for: POST /session does not answer
  // until this parent releases it, and the release happens only after the shutdown is acked, so a
  // prompt reaching the fake server in this seat cannot be a pre-stop turn that merely landed late.
  //
  // THE PRECONDITION IS CARRIED BY THE MUTATION, not by a marker, and that is deliberate. Nothing
  // observable distinguishes "the drive was admitted and refused on resume" from "no drive was ever
  // admitted": both submit nothing. So this cell would pass vacuously if the DM never landed. What
  // rules that out is C18: with the recheck removed the seat must go RED, which it can only do if a
  // drive really was admitted and really did resume. A SURVIVED there means this seat graded an
  // absent state, and that is the report we want rather than a green cell.
  const rheaId = newIdentity();
  const rheaUid = mintLifecycleUid();
  const rheaCreds = await provisionAgent(mgr, auth, rheaId, { ...acl, role: "worker", lifecycleUid: rheaUid });
  const rheaCredsFile = join(dir, "rhea.creds");
  writeFileSync(rheaCredsFile, rheaCreds);
  const resumeSpec = opencodeConnector.buildLaunch({
    space, name: "Rhea", role: "worker", id: rheaId.id, lifecycleUid: rheaUid, creds: rheaCredsFile,
    servers: SERVERS, subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"],
  });
  const resumeEp = resumeSpec.control!;
  const resumeHeld = join(dir, "resume-session-held");
  const resumeRelease = join(dir, "resume-session-release");
  const resumePrompts = join(dir, "resume-prompts");
  // A PARKED PRESENCE WRITE HOLDS THE TEARDOWN OPEN, and without it this seat grades nothing. With
  // an empty intake set `quiesce` has nothing to wait for, so it publishes departure and exits
  // before the released drive can resume, and the cell passes with the defect in place. Measured,
  // not predicted: the first version of this seat did exactly that and went green on an unfixed
  // tree. The tool door is used because a tool carries no session and can be armed from anywhere.
  const resumeArm = join(dir, "resume-tool-arm");
  const resumeParked = join(dir, "resume-tool-parked");
  const resumeToolRelease = join(dir, "resume-tool-release");
  mkdirSync(join(dir, "ws-resume"), { recursive: true });
  resumeProbe = spawn(process.execPath, ["--import", "tsx", PROBE], {
    env: {
      ...HOST_ENV,
      ...resumeSpec.env,
      COTAL_WORKSPACE_ROOT: join(dir, "ws-resume"),
      COOP_HOLD_SESSION: resumeHeld,
      COOP_HOLD_RELEASE: resumeRelease,
      COOP_PROMPTS: resumePrompts,
      COOP_CROSS: "tool",
      COOP_CROSS_ARM: resumeArm,
      COOP_CROSS_PARKED: resumeParked,
      COOP_CROSS_RELEASE: resumeToolRelease,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  // Presence does not depend on the session: the mesh agent connects on its own, so the seat is
  // live in the roster while its session creation is still held.
  let rheaLive = false;
  for (let i = 0; i < 100 && !rheaLive; i++) {
    await wait(100);
    const r = watcher.getRoster().find((p) => p.card.name === "Rhea");
    rheaLive = r !== undefined && r.status !== "offline";
  }
  let sessionHeld = false;
  for (let i = 0; i < 60 && !sessionHeld; i++) {
    await wait(50);
    sessionHeld = existsSync(resumeHeld);
  }
  check("resume-seat: the seat came online with its session creation still held",
    rheaLive && sessionHeld, { rheaLive, sessionHeld });

  // A REAL INBOUND MESSAGE, through the ordinary door. The inbox handler starts a turn on `!busy`,
  // so this admits a drive that immediately parks awaiting the held session.
  const rhea = watcher.getRoster().find((pr) => pr.card.name === "Rhea");
  if (rhea) await watcher.unicast(rhea.card.id, "a message admitted before the stop");
  await wait(500);

  // Armed only now, so the presence write is admitted while the seat is genuinely online.
  writeFileSync(resumeArm, "go\n");
  let resumeToolParked = false;
  for (let i = 0; i < 60 && !resumeToolParked; i++) {
    await wait(50);
    resumeToolParked = existsSync(resumeParked);
  }
  // The precondition for the window, graded rather than assumed: the teardown must have something
  // to wait on, or it exits before the drive resumes and the cell below means nothing.
  check("resume-seat: admitted work is parked, so the teardown will hold rather than exit",
    resumeToolParked, { resumeParked });

  const resumeReply = await sendShutdown(resumeEp.path, resumeEp.token);
  check("resume-seat: control server acked the shutdown",
    resumeReply.trim() === JSON.stringify({ ok: true }), resumeReply);

  // Released while the teardown is parked on the tool call, so the drive resumes INSIDE the window
  // rather than after the process is gone. If it still resumes too late to matter, C18 reports
  // SURVIVED and this seat is grading an absent state again.
  writeFileSync(resumeRelease, "go\n");
  await wait(400);
  writeFileSync(resumeToolRelease, "go\n");
  await awaitExit(resumeProbe, 15_000);

  // Session creation was held until after the shutdown was acked, so ANY prompt here was submitted
  // by a drive that crossed the guard before the stop and resumed after it.
  const resumeSubmitted = existsSync(resumePrompts)
    ? readFileSync(resumePrompts, "utf8").split("\n").filter(Boolean)
    : [];
  check("resume-seat: a drive already past the guard submitted no turn after teardown began",
    resumeSubmitted.length === 0, { resumeSubmitted });

  // ---- A SEVENTH SEAT: THE REFUSED BATCH IS STILL THERE AFTERWARDS.
  //
  // No stop in this seat until the assertion is done, which is the whole point. The refusal under
  // test is the same `phaseClosed()` line, taken on its CUTOVER arm, because that is the arm a
  // process outlives: a stop ends the process, so there is no later wake to watch.
  const cyId = newIdentity();
  const cyUid = mintLifecycleUid();
  const cyCreds = await provisionAgent(mgr, auth, cyId, { ...acl, role: "worker", lifecycleUid: cyUid });
  const cyCredsFile = join(dir, "carry.creds");
  writeFileSync(cyCredsFile, cyCreds);
  const carrySpec = opencodeConnector.buildLaunch({
    space, name: "Carrie", role: "worker", id: cyId.id, lifecycleUid: cyUid, creds: cyCredsFile,
    servers: SERVERS, subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"],
  });
  const carryMarker = join(dir, "carry-read-finished");
  const carryTrigger = join(dir, "carry-start-drain");
  const carryPrompts = join(dir, "carry-prompts");
  const carryFocus = join(dir, "carry-in-focus");
  mkdirSync(join(dir, "ws-carry"), { recursive: true });
  carryProbe = spawn(process.execPath, ["--import", "tsx", PROBE], {
    env: {
      ...HOST_ENV,
      ...carrySpec.env,
      COTAL_EVENTS: "1",
      COTAL_WORKSPACE_ROOT: join(dir, "ws-carry"),
      COOP_MARKER: carryMarker,
      COOP_TRIGGER: carryTrigger,
      COOP_PROMPTS: carryPrompts,
      COOP_FOCUS: "1",
      COOP_FOCUS_READY: carryFocus,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  let carrieLive = false;
  for (let i = 0; i < 100 && !carrieLive; i++) {
    await wait(100);
    const c = watcher.getRoster().find((p) => p.card.name === "Carrie");
    carrieLive = c !== undefined && c.status !== "offline";
  }
  check("carry-seat: the seventh seat came online, so this leg grades a live one", carrieLive);
  // PRECONDITION FOR THE NUDGE LEG. Outside focus an @mention is an ordinary inbox item and there is
  // no nudge to lose, so without this the leg grades the batch path twice.
  let carryFocused = false;
  for (let i = 0; i < 80 && !carryFocused; i++) {
    await wait(100);
    carryFocused = existsSync(carryFocus);
  }
  check("carry-seat: the seat is in focus, so an @mention becomes a wake rather than a batch",
    carryFocused, { carryFocus });

  // Open a cutover, then send during it. The connector must refuse the turn while the replacement
  // holder is not installed, which is the same refusal the stop path takes.
  writeFileSync(carryTrigger, "go\n");
  await wait(400);
  const carrie = watcher.getRoster().find((pr) => pr.card.name === "Carrie");
  if (carrie) await watcher.unicast(carrie.card.id, "a message refused mid-cutover");
  // AND AN @MENTION, which in focus is a different kind of input: its body is acked-and-dropped at
  // ingest and stays recallable, so the WAKE is the only thing the connector still holds, and it
  // holds it in a single string handed to `drive`. A drive refused mid-cutover used to drop that
  // string, and no later wake could reconstruct it, so the seat was never told to go and look.
  await watcher.multicast("@Carrie you were named while the cutover was open", {
    channel: "general",
    mentions: ["Carrie"],
  });
  await wait(600);
  const duringCutover = existsSync(carryPrompts) ? readFileSync(carryPrompts, "utf8").split("\n").filter(Boolean).length : 0;
  check("carry-seat: no turn was started while the cutover was open", duringCutover === 0, { duringCutover });

  // The cutover closes. The batch was refused, not consumed, so a later wake in THIS process has to
  // carry it. Without that, "refused" and "dropped" are the same observation.
  // GRADED ON THE TEXT, not on a count. A count says only that some turn started, and this seat has
  // two inputs in flight: the refused batch and the refused nudge. The first version counted, the
  // nudge's own prompt satisfied it, and a mutation that acked the batch away still passed. So each
  // cell names the input it is about.
  let carried = false;
  for (let i = 0; i < 150 && !carried; i++) {
    await wait(100);
    carried = existsSync(carryPrompts) && /refused mid-cutover/.test(readFileSync(carryPrompts, "utf8"));
  }
  check("carry-seat: the batch refused mid-cutover was kept, and driven once the cutover closed",
    carried, { carryPrompts, carryMarker });

  // The nudge is a SEPARATE claim from the batch and cannot be read off the same cell: the inbox
  // batch survives because it was never consumed, while the nudge survives only if `drive` puts it
  // back. Graded on the text, because a prompt count cannot tell the two inputs apart.
  let nudged = false;
  for (let i = 0; i < 100 && !nudged; i++) {
    await wait(100);
    nudged = existsSync(carryPrompts) && /mentioned by/i.test(readFileSync(carryPrompts, "utf8"));
  }
  check("carry-seat: the wake nudge refused mid-cutover was held, and delivered once the cutover closed",
    nudged, { carryPrompts, body: existsSync(carryPrompts) ? readFileSync(carryPrompts, "utf8").slice(0, 400) : "" });
  await sendShutdown(carrySpec.control!.path, carrySpec.control!.token);
  await awaitExit(carryProbe, 15_000);

  // ---- AN EIGHTH SEAT: THE EXIT THAT IS NOT A RETURN.
  //
  // Every cell above leaves `drive` through a guarded RETURN, where the input is put back by hand.
  // A submission that FAILS leaves through the catch instead, and that path had no such line. The
  // input is only in `pendingOverride` when it was already parked there; a wake nudge arrives as the
  // PARAMETER, and `pendingOverride` is cleared only once a submission lands, so on this exit there
  // was nothing holding it. `scheduleErrorRetry` then reads `workPending()`, which for a focus
  // @mention is false on all three sources: no boot text, nothing parked, and no inbox entry because
  // the body was acked-and-dropped at ingest. So the wake is not retried and not recallable, and the
  // seat is never told to go and look. The comment on the submission claimed the opposite in words.
  const thId = newIdentity();
  const thUid = mintLifecycleUid();
  const thCreds = await provisionAgent(mgr, auth, thId, { ...acl, role: "worker", lifecycleUid: thUid });
  const thCredsFile = join(dir, "throw.creds");
  writeFileSync(thCredsFile, thCreds);
  const throwSpec = opencodeConnector.buildLaunch({
    space, name: "Thea", role: "worker", id: thId.id, lifecycleUid: thUid, creds: thCredsFile,
    servers: SERVERS, subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"],
  });
  const throwPrompts = join(dir, "throw-prompts");
  const throwFailed = join(dir, "throw-prompts-failed");
  const throwFail = join(dir, "throw-reject-submissions");
  const throwFocus = join(dir, "throw-in-focus");
  mkdirSync(join(dir, "ws-throw"), { recursive: true });
  // ARMED BEFORE THE SEAT IS EVEN UP, so there is no window in which the mention could land on a
  // healthy server and make the failure optional.
  writeFileSync(throwFail, "submissions are rejected while this file exists\n");
  throwProbe = spawn(process.execPath, ["--import", "tsx", PROBE], {
    env: {
      ...HOST_ENV,
      ...throwSpec.env,
      COTAL_EVENTS: "1",
      COTAL_WORKSPACE_ROOT: join(dir, "ws-throw"),
      COOP_PROMPTS: throwPrompts,
      COOP_PROMPTS_FAILED: throwFailed,
      COOP_FAIL_PROMPT: throwFail,
      COOP_FOCUS: "1",
      COOP_FOCUS_READY: throwFocus,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  let theaLive = false;
  for (let i = 0; i < 100 && !theaLive; i++) {
    await wait(100);
    const t = watcher.getRoster().find((p) => p.card.name === "Thea");
    theaLive = t !== undefined && t.status !== "offline";
  }
  check("throw-seat: the eighth seat came online, so this leg grades a live one", theaLive);
  // SAME PRECONDITION AS THE CARRY SEAT, and for the same reason: outside focus the @mention is an
  // ordinary inbox item, `workPending()` sees it, and the retry the defect suppresses would fire.
  let theaFocused = false;
  for (let i = 0; i < 80 && !theaFocused; i++) {
    await wait(100);
    theaFocused = existsSync(throwFocus);
  }
  check("throw-seat: the seat is in focus, so an @mention becomes a wake with no inbox entry behind it",
    theaFocused, { throwFocus });

  await watcher.multicast("@Thea you were named while submissions were failing", {
    channel: "general",
    mentions: ["Thea"],
  });

  // THE PRECONDITION IS ITS OWN GRADED CELL. Without it, "the nudge never arrived" and "the nudge
  // arrived and was lost" are the same silence, and the leg below would pass on a seat that was
  // never woken at all. This asserts the wake really did reach the submission and really was
  // rejected there, which is the exit under test.
  let rejected = false;
  for (let i = 0; i < 150 && !rejected; i++) {
    await wait(100);
    rejected = existsSync(throwFailed) && /mentioned by/i.test(readFileSync(throwFailed, "utf8"));
  }
  check("throw-seat: the wake nudge did reach a submission, and that submission was rejected",
    rejected, { throwFailed, body: existsSync(throwFailed) ? readFileSync(throwFailed, "utf8").slice(0, 300) : "" });

  // The server is healthy again. Nothing else is sent: if the nudge reappears it is because the
  // connector still held it, and if it does not, it was destroyed by the exit rather than deferred.
  rmSync(throwFail, { force: true });
  let retried = false;
  for (let i = 0; i < 200 && !retried; i++) {
    await wait(100);
    retried = existsSync(throwPrompts) && /mentioned by/i.test(readFileSync(throwPrompts, "utf8"));
  }
  check("throw-seat: the wake nudge lost to a failed submission was held, and delivered once submissions worked",
    retried, { throwPrompts, accepted: existsSync(throwPrompts) ? readFileSync(throwPrompts, "utf8").slice(0, 400) : "" });
  await sendShutdown(throwSpec.control!.path, throwSpec.control!.token);
  await awaitExit(throwProbe, 15_000);

  // ---- A NINTH SEAT: TWO CALLERS, ONE SLOT.
  //
  // Every seat above puts ONE input in flight, so each grades a call against itself and none of them
  // can see the thing that makes this property about inputs PLURAL: `pendingOverride` is a single
  // unkeyed string shared by every caller. A drive that is parked in session creation read its own
  // input BEFORE the await; a second caller then parks a different nudge in that slot and returns
  // through the guard; and when the first call finally submits, it clears the slot on the strength of
  // ITS OWN carried value rather than on whether the slot still holds what it took. That is a lost
  // update across an await, and it destroys an input that arrived through a guarded exit, which is
  // exactly the case the property claims to cover. Found by review running this sequence live.
  const coId = newIdentity();
  const coUid = mintLifecycleUid();
  const coCreds = await provisionAgent(mgr, auth, coId, {
    ...acl, role: "worker", lifecycleUid: coUid,
    subscribe: ["collide"], allowSubscribe: ["collide"], allowPublish: ["collide"],
  });
  const coCredsFile = join(dir, "collide.creds");
  writeFileSync(coCredsFile, coCreds);
  const collideSpec = opencodeConnector.buildLaunch({
    space, name: "Cleo", role: "worker", id: coId.id, lifecycleUid: coUid, creds: coCredsFile,
    servers: SERVERS, subscribe: ["collide"], allowSubscribe: ["collide"], allowPublish: ["collide"],
  });
  const coPrompts = join(dir, "collide-prompts");
  const coFocus = join(dir, "collide-in-focus");
  const coHeld = join(dir, "collide-session-held");
  const coRelease = join(dir, "collide-release");
  const coIdle = join(dir, "collide-idle");
  const coRecall = join(dir, "collide-recall");
  const coRecallGo = join(dir, "collide-recall-go");
  mkdirSync(join(dir, "ws-collide"), { recursive: true });
  collideProbe = spawn(process.execPath, ["--import", "tsx", PROBE], {
    env: {
      ...HOST_ENV,
      ...collideSpec.env,
      COTAL_EVENTS: "1",
      COTAL_WORKSPACE_ROOT: join(dir, "ws-collide"),
      COOP_PROMPTS: coPrompts,
      COOP_FOCUS: "1",
      COOP_FOCUS_READY: coFocus,
      COOP_HOLD_SESSION: coHeld,
      COOP_HOLD_RELEASE: coRelease,
      COOP_IDLE: coIdle,
      COOP_RECALL: coRecall,
      COOP_RECALL_GO: coRecallGo,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  let cleoLive = false;
  for (let i = 0; i < 100 && !cleoLive; i++) {
    await wait(100);
    const c = watcher.getRoster().find((p) => p.card.name === "Cleo");
    cleoLive = c !== undefined && c.status !== "offline";
  }
  check("collide-seat: the ninth seat came online, so this leg grades a live one", cleoLive);
  let cleoFocused = false;
  for (let i = 0; i < 80 && !cleoFocused; i++) {
    await wait(100);
    cleoFocused = existsSync(coFocus);
  }
  check("collide-seat: the seat is in focus, so each @mention is a wake with no inbox entry behind it",
    cleoFocused, { coFocus });
  // The session create must be HELD before the first mention, or the first drive never parks and the
  // two callers never overlap. Asserted rather than slept for.
  let cleoHeld = false;
  for (let i = 0; i < 100 && !cleoHeld; i++) {
    await wait(100);
    cleoHeld = existsSync(coHeld);
  }
  check("collide-seat: session creation is held, so the first drive parks past the guard", cleoHeld);

  // TWO MENTIONS INSIDE THE PARKED WINDOW. The first drive is parked in session creation holding
  // `driving`; the second caller therefore reaches the entry guard, parks its own nudge in the
  // shared slot, and returns. That is a caller input on a guarded early exit.
  //
  // GRADED ON THE COUNT OF NUDGE SUBMISSIONS, and that is forced rather than chosen. The nudge names
  // the SENDER and never the message, so two @mentions from one sender produce a byte-identical
  // string: no text assertion can tell them apart, and a first version of this cell that tried to
  // was measuring nothing. The count is the only honest discriminator, which is also why the fix
  // compares generations instead of values.
  const nudges = (): number => {
    if (!existsSync(coPrompts)) return 0;
    return readFileSync(coPrompts, "utf8").split("\n").filter((l) => /You were mentioned by/.test(l)).length;
  };
  await watcher.multicast("@Cleo alpha names you first", { channel: "collide", mentions: ["Cleo"] });
  await wait(700);
  await watcher.multicast("@Cleo beta names you second", { channel: "collide", mentions: ["Cleo"] });
  await wait(700);
  check("collide-seat: no nudge was submitted while session creation was held", nudges() === 0,
    { nudges: nudges() });

  // Release. The parked drive submits ITS nudge. Its clear must not reach the nudge the other caller
  // parked while it was awaiting.
  writeFileSync(coRelease, "go\n");
  let firstNudge = false;
  for (let i = 0; i < 150 && !firstNudge; i++) {
    await wait(100);
    firstNudge = nudges() >= 1;
  }
  check("collide-seat: the drive parked in session creation submitted a nudge once released",
    firstNudge, { nudges: nudges() });

  // End the turn. `session.idle` is the sole turn-end site and it drives whatever is still pending,
  // so a surviving second nudge is carried HERE. With the clear unguarded, the slot was emptied by
  // the first call and there is nothing left to carry.
  writeFileSync(coIdle, "go\n");
  let secondNudge = false;
  for (let i = 0; i < 200 && !secondNudge; i++) {
    await wait(100);
    secondNudge = nudges() >= 2;
  }
  check("collide-seat: the nudge parked by the second caller survived the first caller's clear and was driven",
    secondNudge, { nudges: nudges() });

  // WHY ONE SLOT IS ENOUGH, measured rather than argued. The wake is only a hint; the bodies live on
  // the broker and come back through recall. This calls `cotal_inbox` exactly as a model would and
  // requires BOTH mentions in the answer, which is what makes collapsing wakes safe. If this cell
  // ever fails, the coalescing argument is void and the wake would have to carry content.
  writeFileSync(coRecallGo, "go\n");
  let recalled = "";
  for (let i = 0; i < 150 && !/alpha/i.test(recalled); i++) {
    await wait(100);
    recalled = existsSync(coRecall) ? readFileSync(coRecall, "utf8") : "";
  }
  check("collide-seat: recall returns the FIRST mention's body, so a wake is a hint and not the content",
    /alpha names you first/i.test(recalled), { recalled: recalled.slice(0, 400) });
  check("collide-seat: recall returns the SECOND mention's body too, so one surviving wake recovers both",
    /beta names you second/i.test(recalled), { recalled: recalled.slice(0, 400) });
  await sendShutdown(collideSpec.control!.path, collideSpec.control!.token);
  await awaitExit(collideProbe, 15_000);

  // ---- REFUSED IS NOT THE SAME AS DROPPED, and the cell above cannot tell them apart: not
  // submitting and losing the input are both zero prompts. The refusal returns before `peekInbox`
  // runs and before `surfaced` is assigned, so nothing is consumed and a later wake in the SAME
  // process carries the batch. That is the property, and it is graded on the cutover arm of
  // `phaseClosed()` rather than the stop arm, for a measured reason: at a stop the process exits,
  // so there is no later wake to observe.
  //
  // A CROSS-INCARNATION VERSION WAS TRIED AND REMOVED. A replacement seat, on a fresh lifecycle uid
  // and then on the SAME one, drove immediately on a newly sent DM but never received the refused
  // one. So a batch held at teardown does not survive the process, on either uid. That is a
  // durability question about delivery rather than a property of this refusal, and asserting it
  // here would have claimed something this change does not deliver.
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
} finally {
  try {
    if (probe && probe.exitCode === null) probe.kill("SIGKILL");
    if (toolProbe && toolProbe.exitCode === null) toolProbe.kill("SIGKILL");
    if (modelProbe && modelProbe.exitCode === null) modelProbe.kill("SIGKILL");
    if (mirrorProbe && mirrorProbe.exitCode === null) mirrorProbe.kill("SIGKILL");
    if (interiorProbe && interiorProbe.exitCode === null) interiorProbe.kill("SIGKILL");
    if (resumeProbe && resumeProbe.exitCode === null) resumeProbe.kill("SIGKILL");
    if (carryProbe && carryProbe.exitCode === null) carryProbe.kill("SIGKILL");
    if (throwProbe && throwProbe.exitCode === null) throwProbe.kill("SIGKILL");
    if (collideProbe && collideProbe.exitCode === null) collideProbe.kill("SIGKILL");
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
