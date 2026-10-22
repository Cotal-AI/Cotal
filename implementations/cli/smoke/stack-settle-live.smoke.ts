/**
 * LIVE: a controller stack is settled from process evidence instead of wedging its root.
 *
 *  1. Crash mid-start. An `up` killed while delivery waits for readiness leaves an applying
 *     operation. `down --dry-run` exits 0 and names the settlement, `down --yes` settles it and stops
 *     the broker, and a second `down --yes` is a no-op. `ps` on the `--no-manager` stack is a known
 *     refusal.
 *  2. Broker crash after start. The next `up` restarts the broker from its records.
 *  3. Busy port on a first `up`. It refuses CONFLICT naming the address and the bind error and
 *     launches nothing; once the port is free the same `up` starts.
 *  4. Orphan manager. With the broker killed under a live manager, `down` refuses before any stop
 *     and names `cotal up --space`, from the operator's shell and from a managed seat's; following
 *     it, `up` then `down` stop both. While the broker is live, its refusal of a seat's credential
 *     is kept as it is. The legacy name and the broker stop name their stack members. Under umask
 *     0002 the delivery-aware marker is 0600. After a clean down, a group-writable `.cotal/auth`
 *     makes `reset space --dry-run` name it and its repair. A `down` after every member crashed
 *     exits 0, and the reset preview then names `cotal up` and `cotal down`.
 *  5. An unconfirmed native manager stop. The manager is frozen when its stop request is published,
 *     so the first `down` reports the stop unknown and the manager record stays `stopping` under that
 *     request. While the manager runs, `down` refuses `LIFECYCLE_BLOCKED` naming the instance and the
 *     request, and `service start` refuses before any readiness probe and keeps the record. After it
 *     is killed `down` still refuses and nothing is stopped or cleaned up; `up` refuses the same way
 *     and launches no manager.
 *  7. A native manager stop that completes after `down` stopped waiting. The manager is frozen once
 *     it publishes its accepted receipt, so the first `down` reports the stop unknown, then resumed,
 *     so it records the stop completed and exits. The next bare `down` settles the record `stopped`
 *     from that receipt, releases the stop reservation and stops the rest of the stack; in a second
 *     stack the next bare `up` settles it the same way and starts a manager that a later `down` stops.
 *  6. An interrupted redefinition. An `up` whose `--max-sessions` redefines the manager is killed
 *     while the replacement manager is frozen before its readiness is recorded. The next bare `down`
 *     adopts the journaled replacement and stops it; in a second stack the next bare `up` adopts it
 *     and reuses it.
 *
 * Sandboxes COTAL_HOME and every project root, and signals only pids its own stack records name.
 * Run: pnpm smoke:stack-settle:live
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, listenOn, recordSmokeSandbox, type SmokeSandboxAnchor } from "@cotal-ai/smoke-kit";
import { mintLifecycleUid } from "@cotal-ai/core";
import { agentLifecycleSecretFilePaths, canonicalLocalProcessPath, findMesh, MANAGER_DELIVERY_AWARE_MARKER, MANAGER_PIDFILE, readServiceStopRequest, stopReservationPath } from "@cotal-ai/workspace";

const WT = resolve(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
// One process per command, so a SIGKILL reaches the CLI itself and not a wrapper.
const TSX_IMPORT = import.meta.resolve("tsx");
const home = mkdtempSync(join(tmpdir(), "cotal-stack-settle-"));
const configDir = join(home, "xdg");
// The CLI children must not inherit a managed session's mesh identity from whatever runs this
// suite; they get only the private home and the values set below.
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
// Set before the stores are imported; they read COTAL_HOME on each call.
process.env.COTAL_HOME = home;
const env = { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1" };
const { observeServiceProcess, serviceInstances, serviceInstanceStore } = await import("../src/lib/service-instances.js");
const { readStackJournal } = await import("../src/lib/stack-journal.js");

const { check, finish } = createSuite();
const anchors = new Map<string, SmokeSandboxAnchor>();
const roots: string[] = [];
const owned = new Set<number>();

type Envelope = { outcome: string; target?: Record<string, unknown>; result?: Record<string, unknown>; warnings?: { code: string }[]; error?: { code: string; message: string; remedy?: string } };
type Run = { status: number | null; signal: NodeJS.Signals | null; ms: number; stderr: string; env?: Envelope };
const cliAs = (childEnv: NodeJS.ProcessEnv, cwd: string, ...args: string[]): Run => {
  const options = { cwd, env: childEnv, encoding: "utf8" as const, timeout: 180_000 };
  assertSmokeSandboxDown(anchors.get(cwd), args, options);
  const began = Date.now();
  const run = spawnSync(process.execPath, ["--import", TSX_IMPORT, CLI, ...args], options);
  let parsed: Envelope | undefined;
  try { parsed = JSON.parse(run.stdout) as Envelope; } catch { parsed = undefined; }
  return { status: run.status, signal: run.signal, ms: Date.now() - began, stderr: run.stderr, env: parsed };
};
const cli = (cwd: string, ...args: string[]): Run => cliAs(env, cwd, ...args);
/** `cli` without blocking this process, so a watcher in it can act while the command runs. */
const cliAsync = (cwd: string, ...args: string[]): Promise<Run> => {
  assertSmokeSandboxDown(anchors.get(cwd), args, { cwd, env });
  const began = Date.now();
  const child = spawn(process.execPath, ["--import", TSX_IMPORT, CLI, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
  return new Promise((done) => child.once("close", (status, signal) => {
    clearTimeout(timer);
    let parsed: Envelope | undefined;
    try { parsed = JSON.parse(stdout) as Envelope; } catch { parsed = undefined; }
    done({ status, signal, ms: Date.now() - began, stderr, env: parsed });
  }));
};
const shown = (run: Run) => ({ status: run.status, signal: run.signal, ms: run.ms, outcome: run.env?.outcome, error: run.env?.error, stderr: run.stderr.slice(-1500) });
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (cond: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(20); }
  return cond();
};
/** The pinned pid of a stack definition's single instance, read from its own record. */
const pidOf = (space: string, definition: string): number | null => {
  try { return serviceInstances(space, definition)[0]?.record.value.process?.pid ?? null; } catch { return null; }
};
const track = (space: string) => {
  for (const definition of ["stack-broker", "stack-auth", "stack-delivery", "stack-manager"]) {
    const pid = pidOf(space, definition);
    if (pid !== null) owned.add(pid);
  }
};
const gone = (space: string, definition: string) => serviceInstances(space, definition).every((row) => observeServiceProcess(row.record.value) !== "running");
const exited = (child: ChildProcess) => new Promise<void>((done) => child.exitCode !== null || child.signalCode !== null ? done() : child.once("exit", () => done()));

const prepare = (space: string): string => {
  const root = join(home, space);
  // Not group-writable under the umask step 4 sets: such a root needs a private-group proof
  // (getfacl) that a host without acl cannot give.
  mkdirSync(root, { mode: 0o755 });
  const created = cli(home, "space", "create", space, "--root", root, "--json");
  check(`space create ${space} prepares its root`, created.status === 0, shown(created));
  anchors.set(root, recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir }));
  roots.push(root);
  return root;
};

process.on("exit", () => {
  for (const pid of owned) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  rmSync(home, { recursive: true, force: true });
});

try {
  // 1 + 2. Crash mid-start, then a broker crash after a completed start (B2-01, LA-03, LA-04, B2-04, B2-09).
  {
    const space = "settle";
    const root = prepare(space);
    const port = await freePort();
    const child = spawn(process.execPath, ["--import", TSX_IMPORT, CLI, "up", "--server", `nats://127.0.0.1:${port}`, "--no-manager", "--json"], { cwd: root, env, stdio: "ignore" });
    // Freeze delivery once its process is pinned, so the up is provably mid-readiness when it dies.
    const pinned = await until(() => pidOf(space, "stack-delivery") !== null, 120_000);
    const delivery = pidOf(space, "stack-delivery");
    if (delivery !== null) process.kill(delivery, "SIGSTOP");
    track(space);
    check("the up still waits on delivery readiness when it is killed", pinned && child.exitCode === null, { pinned, exitCode: child.exitCode });
    child.kill("SIGKILL");
    await exited(child);
    if (delivery !== null) process.kill(delivery, "SIGKILL");
    await until(() => gone(space, "stack-delivery"), 10_000);
    check("the killed up left its operation applying", readStackJournal(root)?.journal.operation.phase === "applying", readStackJournal(root)?.journal.operation);

    const preview = cli(root, "down", "--dry-run", "--json");
    check("down --dry-run on the unsettled root exits 0 and names the settlement", preview.status === 0 && preview.env?.outcome === "ok" && preview.env.result?.settlesOperation !== null, shown(preview));
    const stopped = cli(root, "down", "--yes", "--json");
    const broker = pidOf(space, "stack-broker");
    check("down --yes settles the earlier operation and stops the live broker", stopped.status === 0 && Boolean(stopped.env?.warnings?.some((warning) => warning.code === "OPERATION_SETTLED")) && (broker === null || !alive(broker)), shown(stopped));
    const again = cli(root, "down", "--yes", "--json");
    check("a second down --yes is a no-op", again.status === 0 && again.env?.outcome === "no-op", shown(again));

    // A bare up adds the manager, so the restart keeps --no-manager for the ps refusal.
    const restarted = cli(root, "up", "--no-manager", "--json");
    track(space);
    check("up --no-manager starts the settled stack again", restarted.status === 0, shown(restarted));
    const ps = cli(root, "ps", "--json");
    check("ps on a --no-manager stack refuses TARGET_UNAVAILABLE, exit 2", ps.status === 2 && ps.env?.error?.code === "TARGET_UNAVAILABLE" && !ps.env.error.message.includes("SPEC"), shown(ps));
    const added = cli(root, "up", "--json");
    track(space);
    check("bare up adds the manager to the running stack", added.status === 0 && pidOf(space, "stack-manager") !== null, shown(added));

    const crashed = pidOf(space, "stack-broker");
    if (crashed !== null) process.kill(crashed, "SIGKILL");
    await until(() => gone(space, "stack-broker"), 10_000);
    const repaired = cli(root, "up", "--json");
    track(space);
    const replacement = pidOf(space, "stack-broker");
    check("up after a broker crash restarts the broker from its records", repaired.status === 0 && replacement !== null && replacement !== crashed && alive(replacement), shown(repaired));
    const finalDown = cli(root, "down", "--yes", "--json");
    check("down --yes stops the repaired stack", finalDown.status === 0 && (replacement === null || !alive(replacement)), shown(finalDown));
  }

  // 3. A busy port on the first up (B2-02).
  {
    const space = "busyport";
    const root = prepare(space);
    const squatter = createServer();
    const port = await listenOn(squatter, await freePort());
    const refused = cli(root, "up", "--server", `nats://127.0.0.1:${port}`, "--no-manager", "--json");
    track(space);
    check("a busy port refuses CONFLICT, exit 2, naming the address and bind error", refused.status === 2 && refused.env?.error?.code === "CONFLICT" && refused.env.error.message.includes(`127.0.0.1:${port}`) && refused.env.error.message.includes("address already in use"), shown(refused));
    // The bind probe is closed on the refusal path too, so the command exits on its own and promptly.
    check("the refused up exits by itself well inside its timeout", refused.signal === null && refused.status !== null && refused.ms < 60_000, shown(refused));
    check("no broker was launched over the busy port", pidOf(space, "stack-broker") === null, serviceInstances(space, "stack-broker").map((row) => row.record.value.state));
    await new Promise<void>((done) => squatter.close(() => done()));
    const started = cli(root, "up", "--json");
    track(space);
    check("once the port is free, bare up starts the stack", started.status === 0, shown(started));
    const stopped = cli(root, "down", "--yes", "--json");
    check("down --yes stops it", stopped.status === 0, shown(stopped));
  }

  // 4. An orphan manager, member names and the delivery-aware marker (B2-01, B2-03, B2-07, B2-08).
  {
    process.umask(0o002);
    const space = "orphan";
    const root = prepare(space);
    const port = await freePort();
    const started = cli(root, "up", "--server", `nats://127.0.0.1:${port}`, "--json");
    track(space);
    check("up starts the stack with its manager", started.status === 0, shown(started));
    const marker = canonicalLocalProcessPath(MANAGER_DELIVERY_AWARE_MARKER, { root, space });
    check("the delivery-aware marker is 0600 under umask 0002", (statSync(marker).mode & 0o777) === 0o600, (statSync(marker).mode & 0o777).toString(8));
    check("the marker is a regular file, not a link", lstatSync(marker).isFile(), lstatSync(marker).isSymbolicLink());

    const legacyName = cli(root, "down", "manager", "--yes", "--json");
    check("down manager on a controller stack names stack-manager", legacyName.status === 2 && legacyName.env?.error?.code === "TARGET_NOT_FOUND" && Boolean(legacyName.env.error.remedy?.includes("stack-manager")), shown(legacyName));
    const brokerFirst = cli(root, "down", "stack-broker", "--yes", "--json");
    check("the broker stop refusal names its stack dependants", brokerFirst.status === 2 && brokerFirst.env?.error?.code === "LIFECYCLE_BLOCKED" && brokerFirst.env.error.message.includes("stack-manager") && !brokerFirst.env.error.message.includes("legacy"), shown(brokerFirst));

    const broker = pidOf(space, "stack-broker");
    const manager = pidOf(space, "stack-manager");
    // A managed seat's shell dials the broker with its own credential first. The seat context is set
    // by hand, with a credential from another root of this suite that this broker does not trust.
    const uid = mintLifecycleUid();
    const seatCreds = agentLifecycleSecretFilePaths(root, space, "settle-seat", uid).creds;
    const foreign = roots.find((other) => other !== root);
    const foreignCreds = foreign ? readdirSync(join(foreign, ".cotal"), { recursive: true, encoding: "utf8" }).find((path) => path.endsWith(".creds")) : undefined;
    check("another root of this suite holds a credential the seat can present", foreign !== undefined && foreignCreds !== undefined, roots);
    mkdirSync(dirname(seatCreds), { recursive: true, mode: 0o700 });
    if (foreign && foreignCreds) copyFileSync(join(foreign, ".cotal", foreignCreds), seatCreds);
    const seat = { ...env, COTAL_NAME: "settle-seat", COTAL_ID: "settle-seat", COTAL_LIFECYCLE_UID: uid, COTAL_SPACE: space, COTAL_ACCEPTED_TOKEN: "settle-token" };
    const rejected = cliAs(seat, root, "down", "--yes", "--json");
    check("a live broker's refusal of a managed seat's credential is kept, not reported as a registry mismatch, and nothing stops", rejected.status !== 0 && rejected.env?.error?.message === "Authorization Violation" && broker !== null && alive(broker) && manager !== null && alive(manager), shown(rejected));
    if (broker !== null) process.kill(broker, "SIGKILL");
    await until(() => gone(space, "stack-broker"), 10_000);
    const blocked = cli(root, "down", "--yes", "--json");
    check("down with a live manager and a dead broker refuses before any stop and names up", blocked.status === 2 && Boolean(blocked.env?.error?.remedy?.includes(`cotal up --space ${space}`)) && manager !== null && alive(manager), shown(blocked));
    const seatBlocked = cliAs(seat, root, "down", "--yes", "--json");
    check("a managed seat's down with a dead broker refuses the same way, not as a raw dial error", seatBlocked.status === 2 && Boolean(seatBlocked.env?.error?.remedy?.includes(`cotal up --space ${space}`)) && manager !== null && alive(manager), shown(seatBlocked));
    rmSync(seatCreds, { force: true });
    const repaired = cli(root, "up", "--json");
    track(space);
    check("up restarts the broker while the manager keeps running", repaired.status === 0 && manager !== null && alive(manager), shown(repaired));
    const stopped = cli(root, "down", "--yes", "--json");
    check("down --yes then stops the manager and the broker", stopped.status === 0 && await until(() => manager === null || !alive(manager), 30_000), shown(stopped));

    // After a clean down the stopped stack is a reset target, so the identity scope check runs.
    const auth = join(root, ".cotal", "auth");
    chmodSync(auth, 0o775);
    const widened = cli(root, "reset", "space", space, "--dry-run", "--json");
    check("reset space --dry-run names a group-writable path and its repair", widened.status === 2 && widened.env?.error?.code === "CONFLICT" && Boolean(widened.env.error.message.includes(auth)) && Boolean(widened.env.error.remedy?.includes(`chmod go-w ${auth}`)), shown(widened));
    chmodSync(auth, 0o700);
    const preview = cli(root, "reset", "space", space, "--dry-run", "--json");
    check("reset space --dry-run succeeds once the path is owner-only", preview.status === 0, shown(preview));

    const again = cli(root, "up", "--json");
    track(space);
    check("bare up starts the stack again", again.status === 0, shown(again));
    const members = ["stack-broker", "stack-delivery", "stack-manager"].map((definition) => pidOf(space, definition));
    for (const pid of members) if (pid !== null) process.kill(pid, "SIGKILL");
    await until(() => members.every((pid) => pid === null || !alive(pid)), 10_000);
    const settled = cli(root, "down", "--yes", "--json");
    check("down --yes records every crashed member as stopped and exits 0", settled.status === 0 && ["ok", "no-op"].includes(settled.env?.outcome ?? ""), shown(settled));
    // A member that crashed has no recorded stop, so reset names the restart that records one.
    const unreceipted = cli(root, "reset", "store", space, "--dry-run", "--json");
    const verdict = unreceipted.env?.result?.applyVerdict as { offered?: boolean; remedy?: string | null } | undefined;
    check("reset store --dry-run after crashes refuses in its verdict and names cotal up then cotal down", unreceipted.status === 0 && verdict?.offered === false && Boolean(verdict.remedy?.includes("cotal up")) && Boolean(verdict.remedy?.includes("cotal down")), shown(unreceipted));
  }

  // 5. A native manager stop that was submitted and never confirmed (B2-1). The manager is frozen
  //    the moment its stop request file appears, before it acts on the signal that follows, so no
  //    terminal receipt can come. It is killed after the checks made while it runs.
  {
    const space = "unconfirmed";
    const root = prepare(space);
    const port = await freePort();
    const started = cli(root, "up", "--server", `nats://127.0.0.1:${port}`, "--json");
    track(space);
    check("up starts the stack whose manager stop is left unconfirmed", started.status === 0, shown(started));
    const manager = serviceInstances(space, "stack-manager")[0];
    const pid = manager?.record.value.process?.pid ?? null;
    const states = serviceInstanceStore(space).directory();
    let frozen = false;
    const watcher = states && pid !== null ? watch(states, (_event, name) => {
      if (frozen || !String(name ?? "").endsWith(".stop.json")) return;
      frozen = true;
      try { process.kill(pid, "SIGSTOP"); } catch { /* the checks below report it */ }
    }) : undefined;
    const first = await cliAsync(root, "down", "--yes", "--json");
    watcher?.close();
    check("the manager was frozen once its stop request was published", frozen && pid !== null && alive(pid), { frozen, pid });
    check("the first down reports the manager stop unknown", first.status !== 0 && first.env?.outcome === "unknown" && first.env.error?.code === "OPERATION_UNKNOWN", shown(first));
    let request: string | undefined;
    try { request = manager && states ? readServiceStopRequest({ space, instanceId: manager.name, launchRequestId: manager.record.value.launchRequestId, stateDirectory: states })?.requestId : undefined; } catch { request = undefined; }
    const record = () => serviceInstances(space, "stack-manager").map((row) => ({ instanceId: row.name, state: row.record.value.state, requestId: row.record.value.requestId }));
    const held = () => { const rows = record(); return request !== undefined && rows.length === 1 && rows[0]!.instanceId === manager?.name && rows[0]!.state === "stopping" && rows[0]!.requestId === request; };
    check("the manager record stays stopping under its published request", held(), { request, record: record() });
    // Each refusal names the instance and the request, and its remedy is the exact status command.
    const names = (run: Run) => run.status === 2 && run.env?.error?.code === "LIFECYCLE_BLOCKED" && run.env.target?.instanceId === manager?.name && run.env.target?.requestId === request && Boolean(run.env.error.remedy?.includes(`cotal service status stack-manager --instance ${manager?.name} --space ${space}`));
    const delivery = pidOf(space, "stack-delivery"), broker = pidOf(space, "stack-broker");
    const whileRunning = cli(root, "down", "--yes", "--json");
    check("while the frozen manager runs, down refuses naming its instance and request", names(whileRunning) && pid !== null && alive(pid) && held(), shown(whileRunning));
    // A public start on the live retained instance refuses before any readiness probe or record write.
    const serviceStart = cli(root, "service", "start", "stack-manager", "--space", space, "--json");
    check("while the frozen manager runs, service start refuses naming the retained request and leaves the record stopping", serviceStart.status === 2 && serviceStart.env?.outcome === "refused" && serviceStart.env.error?.code === "LIFECYCLE_BLOCKED" && serviceStart.env.target?.instanceId === manager?.name && serviceStart.env.target?.requestId === request && serviceStart.env.target?.stopPublication === "published" && Boolean(serviceStart.env.error.remedy?.includes(`cotal service status stack-manager --instance ${manager?.name} --space ${space}`)) && pid !== null && alive(pid) && held(), { ...shown(serviceStart), target: serviceStart.env?.target, record: record() });
    if (pid !== null) process.kill(pid, "SIGKILL");
    await until(() => gone(space, "stack-manager"), 10_000);
    const afterExit = cli(root, "down", "--yes", "--json");
    check("after the manager exits, down still refuses naming its instance and request", names(afterExit) && held(), shown(afterExit));
    check("no member was stopped and no registration was removed", delivery !== null && alive(delivery) && broker !== null && alive(broker) && findMesh(space) !== undefined, { delivery, broker, registered: findMesh(space) !== undefined });
    const restart = cli(root, "up", "--json");
    check("after the manager exits, up refuses the same way and launches no manager", names(restart) && held(), shown(restart));
  }

  // 7. A native manager stop the manager completes after `down` stopped waiting for it. It is frozen
  //    once its accepted receipt appears, past the first down's wait, then resumed.
  const completeLate = async (space: string) => {
    const root = prepare(space);
    const port = await freePort();
    const started = cli(root, "up", "--server", `nats://127.0.0.1:${port}`, "--json");
    track(space);
    const manager = serviceInstances(space, "stack-manager")[0];
    const pid = manager?.record.value.process?.pid ?? null;
    const states = serviceInstanceStore(space).directory();
    let frozen = false;
    const watcher = states && pid !== null ? watch(states, (_event, name) => {
      if (frozen || !String(name ?? "").endsWith(".accepted.json")) return;
      frozen = true;
      try { process.kill(pid, "SIGSTOP"); } catch { /* the checks below report it */ }
    }) : undefined;
    const first = await cliAsync(root, "down", "--yes", "--json");
    watcher?.close();
    let request: string | undefined;
    try { request = manager && states ? readServiceStopRequest({ space, instanceId: manager.name, launchRequestId: manager.record.value.launchRequestId, stateDirectory: states })?.requestId : undefined; } catch { request = undefined; }
    const marker = stopReservationPath(canonicalLocalProcessPath(MANAGER_PIDFILE, { root, space }));
    const markerHeld = () => { try { return lstatSync(marker).isFile(); } catch { return false; } };
    check(`${space}: the first down reports the accepted manager stop unknown and keeps its reservation`, started.status === 0 && frozen && first.env?.outcome === "unknown" && first.env.error?.code === "OPERATION_UNKNOWN" && request !== undefined && markerHeld(), { up: shown(started), frozen, first: shown(first), request, marker: markerHeld() });
    if (pid !== null) process.kill(pid, "SIGCONT");
    const exitedLate = pid !== null && await until(() => !alive(pid), 30_000);
    const completed = states !== undefined && readdirSync(states).some((name) => name.endsWith(".completed.json"));
    check(`${space}: the resumed manager records its stop completed and exits`, exitedLate && completed, { exitedLate, completed });
    const settled = (row = serviceInstances(space, "stack-manager").find((entry) => entry.name === manager?.name)) => row?.record.value.state === "stopped" && row.record.value.nativeStop?.requestId === request && row.record.value.nativeStop?.nativeStop === "returned";
    return { root, request, markerHeld, settled };
  };
  {
    const { root, markerHeld, settled } = await completeLate("latedown");
    const recovered = cli(root, "down", "--yes", "--json");
    check("bare down settles the late-completed manager stop from its receipt and stops the rest of the stack", recovered.status === 0 && recovered.env?.outcome === "ok" && settled() && !markerHeld() && gone("latedown", "stack-delivery") && gone("latedown", "stack-broker") && findMesh("latedown") === undefined, { ...shown(recovered), settled: settled(), marker: markerHeld() });
  }
  {
    const { root, markerHeld, settled } = await completeLate("lateup");
    const recovered = cli(root, "up", "--json");
    track("lateup");
    const relaunched = serviceInstances("lateup", "stack-manager").some((row) => observeServiceProcess(row.record.value) === "running");
    check("bare up settles the late-completed manager stop from its receipt and starts a manager", recovered.status === 0 && settled() && !markerHeld() && relaunched, { ...shown(recovered), settled: settled(), marker: markerHeld(), relaunched });
    const stopped = cli(root, "down", "--yes", "--json");
    check("down then stops the relaunched manager under a new reservation", stopped.status === 0 && stopped.env?.outcome === "ok" && gone("lateup", "stack-manager") && !markerHeld(), shown(stopped));
  }

  // 6. A redefinition cut off before its replacement's readiness is recorded (B2-2). After a clean up
  //    and down, an up with --max-sessions changes the manager definition, so it retires the stopped
  //    manager instance with the old definition and launches a replacement. Once the replacement's
  //    process is pinned it is frozen, so its readiness cannot be recorded, and the up is killed; the
  //    replacement then resumes and serves with nothing recording it.
  const interruptRedefinition = async (space: string): Promise<{ root: string; replacement?: string }> => {
    const root = prepare(space);
    const port = await freePort();
    const first = cli(root, "up", "--server", `nats://127.0.0.1:${port}`, "--json");
    track(space);
    const retired = serviceInstances(space, "stack-manager")[0]?.name;
    const clean = cli(root, "down", "--yes", "--json");
    check(`${space}: a clean up and down leave the manager instance a redefinition retires`, first.status === 0 && clean.status === 0 && retired !== undefined, { up: shown(first), down: shown(clean) });
    const child = spawn(process.execPath, ["--import", TSX_IMPORT, CLI, "up", "--max-sessions", "32", "--json"], { cwd: root, env, stdio: "ignore" });
    const launched = () => { try { return serviceInstances(space, "stack-manager").find((row) => row.name !== retired && row.record.value.process !== undefined); } catch { return undefined; } };
    const pinned = await until(() => launched() !== undefined, 120_000);
    const replacement = launched();
    const pid = replacement?.record.value.process?.pid;
    if (pid !== undefined) process.kill(pid, "SIGSTOP");
    track(space);
    const journal = readStackJournal(root)?.journal, row = journal?.members.find((member) => member.role === "manager");
    check(`${space}: the up is killed after the redefinition and before the replacement's readiness is recorded`, pinned && child.exitCode === null && journal?.operation.kind === "up" && journal.operation.phase === "applying" && row !== undefined && row.instanceId !== replacement?.name, { pinned, exitCode: child.exitCode, operation: journal?.operation, manager: row });
    child.kill("SIGKILL");
    await exited(child);
    if (pid !== undefined) process.kill(pid, "SIGCONT");
    // Asked in its own space: an unqualified ps resolves the registry's selected space, which an
    // earlier section can leave pointing at another stack.
    const last: { ps?: Run } = {};
    const serving = await until(() => { last.ps = cli(root, "ps", "--space", space, "--json"); return last.ps.status === 0 && last.ps.env?.target?.space === space; }, 60_000);
    check(`${space}: the resumed replacement manager serves`, serving, { replacement: replacement?.name, ps: last.ps && { ...shown(last.ps), target: last.ps.env?.target, managers: last.ps.env?.result?.managers } });
    return { root, replacement: replacement?.name };
  };
  {
    const { root, replacement } = await interruptRedefinition("redefdown");
    const recovered = cli(root, "down", "--yes", "--json");
    const row = readStackJournal(root)?.journal.members.find((member) => member.role === "manager");
    check("bare down after the interrupted redefinition adopts the journaled replacement and stops it", recovered.status === 0 && recovered.env?.outcome === "ok" && Boolean(recovered.env.warnings?.some((warning) => warning.code === "OPERATION_SETTLED")) && row?.instanceId === replacement && row?.state === "stopped" && gone("redefdown", "stack-manager"), shown(recovered));
  }
  {
    const { root, replacement } = await interruptRedefinition("redefup");
    const recovered = cli(root, "up", "--json");
    track("redefup");
    const journal = readStackJournal(root)?.journal, row = journal?.members.find((member) => member.role === "manager");
    check("bare up after the interrupted redefinition adopts the journaled replacement and reuses it", recovered.status === 0 && row?.instanceId === replacement && row?.state === "reused" && journal?.operation.phase === "completed" && serviceInstances("redefup", "stack-manager").length === 1, shown(recovered));
    const stopped = cli(root, "down", "--yes", "--json");
    check("down then stops the recovered stack", stopped.status === 0 && gone("redefup", "stack-manager"), shown(stopped));
  }
} finally {
  for (const root of roots) cli(root, "down", "--yes", "--json");
}
finish();
