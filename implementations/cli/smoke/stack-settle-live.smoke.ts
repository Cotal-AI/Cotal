/**
 * LIVE: a controller stack is settled from process evidence instead of wedging its root.
 *
 *  1. Crash mid-start. An `up` killed while delivery waits for readiness leaves an applying
 *     operation. `status` names the half-started stack and leads Next with the `up --root
 *     <root> --no-manager` that finishes it. `down --dry-run` exits 0 and names the settlement, `down --yes` settles it and stops
 *     the broker, and a second `down --yes` is a no-op. `ps` on the `--no-manager` stack is a known
 *     refusal.
 *  2. Broker crash after start. The `up` that adds the manager and `service status` list the broker's
 *     client and websocket listeners and the manager's console, and `status` lists the members by
 *     definition. With the space's service instance folder unwritable, `down --yes` and `up` refuse
 *     naming it and stop nothing; a wildcard configuration lists them
 *     on every interface and names the plaintext ones. `service add` refuses a broker `--server`
 *     that is no broker address, by preset or `--file`, quoting it unless it may hold a credential, and
 *     starting such a definition saved earlier names its `server` option. The next `up` restarts the broker from its
 *     records. After a manager crash, the next `up` relaunches the manager over the pidfile the
 *     killed process left. Once delivery is killed, `status` reads its ready row as stale instead of
 *     bound. The `down --yes` that stops it prints one receipt: the mesh once, the members in stop
 *     order with their results, and `cotal up` as the next step.
 *  2b. A `ps` while an `up` is still starting the manager says it is starting. Once that `up` is
 *     killed, `ps` gives the no-manager refusal again.
 *  3. Busy port on a first `up`. It refuses CONFLICT naming the address and the bind error and
 *     launches nothing; once the port is free the same `up` starts. A second space whose first `up`
 *     finds that stack's broker answering refuses CONFLICT naming the address and that space, with a
 *     next step to another `--server`; its `down` stops nothing, `reset space` finds nothing to reset,
 *     and its next `up` starts at another address. Once it ran, a third space's broker at that
 *     address makes its bare `up` name stopping that space, and it keeps the address. A first `up`
 *     refused at a port another program holds names another `--server`, records no broker instance
 *     and pins nothing: `down --yes` stops nothing and the next `up` starts at another address. The
 *     refusal says the stack started no member. A running broker keeps its file store cap; a stopped
 *     one takes a new `--max-file-store`, and a recorded cap too small for the space's streams fails
 *     naming that cap and the flag. A cap equal to the membership bucket's reservation fails that way
 *     too, and one byte more starts. A project folder renamed while its stack runs: the broker names
 *     its store relative to the root, so it does not create the old path again; `send`, `up` and
 *     `status --space` from the renamed folder name the move and the way back, `status` there offers
 *     no `clean store`, and after the move back `down` stops it.
 *     Stopped and moved again, `up`, `send`, `history` and `status` there all name moving it back.
 *     Status there, and in a copy, does not offer `clean store`, which refuses in both.
 *     With its journal removed after `down`, as the way out of a damaged one says, `up` starts at the
 *     address its saved broker definition names and warns; with no definition either, it refuses and
 *     asks for `--server`.
 *  4. Orphan manager. With the broker suspended under a live manager, `down` refuses
 *     TARGET_UNAVAILABLE naming the broker's pid and `kill -CONT`, and stops nothing. With the broker
 *     killed under a live manager, `down` refuses before any stop
 *     and names `cotal up --space`, from the operator's shell and from a managed seat's; following
 *     it, `up` then `down` stop both. While the broker is live, its refusal of a seat's credential
 *     is kept as it is. The legacy name and the broker stop name their stack members. Under umask
 *     0002 the delivery-aware marker is 0600. After a clean down, a group-writable `.cotal/auth`
 *     makes `reset space --dry-run` name it and its repair. A `down` after every member crashed
 *     exits 0 and keeps the delivery credential, and the reset preview then names `cotal up` and
 *     `cotal down`. That `up` waits out the killed daemon's lease and starts delivery.
 *  5. An unconfirmed native manager stop. The manager is frozen when its stop request is published,
 *     so the first `down` reports the stop unknown and the manager record stays `stopping` under that
 *     request. While the manager runs, `down` refuses `LIFECYCLE_BLOCKED` naming the instance and the
 *     request, and `service start` refuses before any readiness probe and keeps the record. After it
 *     is killed `down` still refuses and nothing is stopped or cleaned up; `up` refuses the same way
 *     and launches no manager. `down --abandon-stop <request> --yes` refuses while the manager runs,
 *     without `--yes` and for another request. Once the manager is gone it abandons the request,
 *     records the manager failed with a warning and stops the stack, which `up` starts again. In a
 *     second stack the unconfirmed stop is a `--with-agents` one, and abandoning it also removes the
 *     shutdown intent that stop armed, so a later `down` stops the restarted manager.
 *  7. A native manager stop that completes after `down` stopped waiting. The manager is frozen once
 *     it publishes its accepted receipt, so the first `down` reports the stop unknown, then resumed,
 *     so it records the stop completed and exits. The next bare `down` settles the record `stopped`
 *     from that receipt, releases the stop reservation and stops the rest of the stack; in a second
 *     stack the next bare `up` settles it the same way and starts a manager that a later `down` stops.
 *     In a third, the manager is frozen once its stop request appears and resumed after that `down`
 *     exited, so it refuses the request and keeps running. The next bare `up` settles the refusal and
 *     reuses that manager, and the next `down` stops the stack.
 *  6. An interrupted redefinition. An `up` whose `--max-sessions` redefines the manager is killed
 *     while the replacement manager is frozen before its readiness is recorded. The next bare `down`
 *     adopts the journaled replacement and stops it; in a second stack the next bare `up` adopts it
 *     and reuses it, and its notice says the earlier up was interrupted with every member running.
 *     After a `down`, a bare `up` there keeps the `--max-sessions` that redefined it.
 *  8. An upgrade. Each member record pins its built-in adapter at the release that wrote it. With
 *     every pin set to an earlier release and the declarations unchanged, `down` stops the running
 *     stack, `up` starts it again and a later `down` stops it.
 *  9. A `down` killed mid-stop. Killed while the broker's record is `stopping`, it leaves a broker
 *     that is gone under an unconfirmed request: `status` names that member and request, the next
 *     `down` refuses and names `down --abandon-stop <request> --yes`, which records the broker failed
 *     with a warning, and
 *     `up` then `down` cycle the stack. Killed while the manager's record is `stopping` and before
 *     its request is published, the next bare `down` stops the stack and releases the reservation
 *     that killed `down` took.
 * 10. A repeated `down --with-agents --yes`. After one that completed it is a no-op, exit 0. After a
 *     `down` without `--with-agents` it still refuses `LIFECYCLE_BLOCKED`.
 * 11. A first `up` under `ulimit -n 32`. Its broker cannot create the space's streams, so the `up`
 *     stops that broker again and fails `OPERATION_FAILED`, naming the open-file limit. The next `up`
 *     under the normal limit starts the stack.
 * 12. A `down --yes` in a folder whose `.cotal` this account cannot write refuses `PERMISSION_DENIED`
 *     before the plan, naming the folder, and stops nothing. Once it is writable, `down` stops it.
 * 13. An `up` interrupted while its broker readies, before it registers the space. It exits 130
 *     naming the broker's pid and `cotal down --yes`. The broker keeps running unregistered, so the
 *     next `up` refuses `LIFECYCLE_BLOCKED` naming its pid and `cotal down --yes`, and starts
 *     nothing; following it, `down --yes` then `up` start the stack. A `down` interrupted while it
 *     waits on a frozen manager exits 130 naming the members still running and `cotal down --yes`.
 * 14. An `up` stopped after it recorded its broker's launch and before it recorded the child. The
 *     `COTAL_SMOKE_HOLD_AFTER_LAUNCH_RECORD` hold keeps the launch in that window; a listener that
 *     holds the port is refused before any launch is recorded. Interrupted there by SIGINT or
 *     SIGHUP, the `up` exits 130 or 129 and records the launch failed, so `down --yes` settles it.
 *     Killed there, it leaves a record that names no process: `down --yes` refuses
 *     `LIFECYCLE_BLOCKED` naming `down --abandon-launch <instance> --yes`, which refuses without
 *     `--yes` and for another instance, then records the broker failed with a warning. Each stack
 *     then starts and stops.
 *
 * Sandboxes COTAL_HOME and every project root, and signals only pids its own stack records name.
 * Run: pnpm smoke:stack-settle:live
 */
import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, listenOn, recordSmokeSandbox, type SmokeSandboxAnchor } from "@cotal-ai/smoke-kit";
import { mintLifecycleUid } from "@cotal-ai/core";
import { agentLifecycleSecretFilePaths, canonicalLocalProcessPath, findMesh, isCommandFailure, MANAGER_DELIVERY_AWARE_MARKER, MANAGER_PIDFILE, MANAGER_SHUTDOWN_INTENT, readServiceStopRequest, stopReservationPath, acquireMaintenanceLock, releaseMaintenanceLock } from "@cotal-ai/workspace";

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
const { MIN_FILE_STORE } = await import("../src/commands/stack-up.js");
const { serviceDefinitionStore } = await import("../src/lib/service-definitions.js");
// Registers the broker adapter, which a definition saved from this process is checked against.
await import("../src/lib/broker-service.js");
const { definitionListeners, exposedPlaintext, listenerRow } = await import("../src/lib/stack-listeners.js");

const { check, finish } = createSuite();
const anchors = new Map<string, SmokeSandboxAnchor>();
const roots: string[] = [];
const owned = new Set<number>();

type Envelope = { outcome: string; target?: Record<string, unknown>; result?: Record<string, unknown>; warnings?: { code: string; message?: string; target?: Record<string, unknown> }[]; error?: { code: string; message: string; remedy?: string; cause?: { code?: string; detail?: string } } };
type Run = { status: number | null; signal: NodeJS.Signals | null; ms: number; stdout: string; stderr: string; env?: Envelope };
const cliAs = (childEnv: NodeJS.ProcessEnv, cwd: string, ...args: string[]): Run => {
  const options = { cwd, env: childEnv, encoding: "utf8" as const, timeout: 180_000 };
  assertSmokeSandboxDown(anchors.get(cwd), args, options);
  const began = Date.now();
  const run = spawnSync(process.execPath, ["--import", TSX_IMPORT, CLI, ...args], options);
  let parsed: Envelope | undefined;
  try { parsed = JSON.parse(run.stdout) as Envelope; } catch { parsed = undefined; }
  return { status: run.status, signal: run.signal, ms: Date.now() - began, stdout: run.stdout, stderr: run.stderr, env: parsed };
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
    done({ status, signal, ms: Date.now() - began, stdout, stderr, env: parsed });
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
    const half = cli(root, "status", "--json");
    const unfinished = (half.env?.result?.folder as { stackUnfinished?: { kind?: string; running?: string[]; stopped?: string[]; noManager?: boolean } | null } | undefined)?.stackUnfinished;
    check("status names the half-started stack: the broker runs and delivery did not start", half.status === 0 && unfinished?.kind === "up" && unfinished.running?.join() === "broker" && unfinished.stopped?.join() === "delivery" && unfinished.noManager === true, shown(half));
    const halfShown = cli(root, "status");
    const halfNext = halfShown.stdout.slice(halfShown.stdout.indexOf("\nNext\n") + 6).split("\n")[0] ?? "";
    check("its first Next finishes that up, keeping --no-manager", halfShown.stdout.includes("Half started · the last up ended before delivery started; broker runs") && halfNext.includes(`up --root ${root} --no-manager`) && halfNext.includes("Finish starting the stack: the last up ended before delivery started"), { next: halfNext, ...shown(halfShown) });

    const preview = cli(root, "down", "--dry-run", "--json");
    check("down --dry-run on the unsettled root exits 0 and names the settlement", preview.status === 0 && preview.env?.outcome === "ok" && preview.env.result?.settlesOperation !== null, shown(preview));
    const stopped = cli(root, "down", "--yes", "--json");
    const broker = pidOf(space, "stack-broker");
    check("down --yes settles the earlier operation and stops the live broker", stopped.status === 0 && Boolean(stopped.env?.warnings?.some((warning) => warning.code === "OPERATION_SETTLED")) && (broker === null || !alive(broker)), shown(stopped));
    const again = cli(root, "down", "--yes", "--json");
    check("a second down --yes is a no-op", again.status === 0 && again.env?.outcome === "no-op", shown(again));
    for (const [flag, name] of [["--open", "open"], ["--user-auth", "user auth"]] as const) {
      const pinned = cli(root, "up", flag, "--no-manager", "--json");
      check(`up ${flag} on the stopped static-auth root refuses CONFLICT, exit 2, and names another folder for ${name}`,
        pinned.status === 2 && pinned.env?.error?.code === "CONFLICT" && Boolean(pinned.env.error.remedy?.includes(`for ${name} run cotal space create <space>, then cotal up ${flag}, in another folder`)), shown(pinned));
    }

    // A bare up adds the manager, so the restart keeps --no-manager for the ps refusal.
    const restarted = cli(root, "up", "--no-manager", "--json");
    track(space);
    check("up --no-manager starts the settled stack again", restarted.status === 0, shown(restarted));
    const ps = cli(root, "ps", "--json");
    check("ps on a --no-manager stack refuses TARGET_UNAVAILABLE, exit 2", ps.status === 2 && ps.env?.error?.code === "TARGET_UNAVAILABLE" && !ps.env.error.message.includes("SPEC"), shown(ps));
    check("...and its native detail says the manager has no live instance, with no spec rule in it",
      ps.env?.error?.cause?.detail === 'failed-precondition: service "manager" has no live registered instances' && ps.env.error.remedy === "start the stack's manager with bare cotal up; a stack started with --no-manager has none", shown(ps));
    const noManager = () => (cli(root, "status", "--json").env?.result?.folder as { noManager?: boolean } | undefined)?.noManager;
    check("status on that stack reports that it runs no manager by choice", noManager() === true);
    const added = cli(root, "up", "--json");
    track(space);
    check("bare up adds the manager to the running stack", added.status === 0 && pidOf(space, "stack-manager") !== null, shown(added));
    // The rows followed the store's order, by random instance ID, so they moved whenever a member
    // started under a new one.
    const statusInstances = (cli(root, "status", "--json").env?.result?.services as { instances?: { definition: string; instanceId: string }[] } | undefined)?.instances ?? [];
    check("status lists the stack's instances by definition, then instance",
      JSON.stringify(statusInstances.map((row) => row.definition)) === JSON.stringify(["stack-broker", "stack-delivery", "stack-manager"]), statusInstances);
    // A service record folder this account cannot write left every member running after an unknown
    // first stop, and failed up with no cause. Both refuse before any effect now, naming it.
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const instancesDir = join(home, "services", Buffer.from(space).toString("hex"), "instances");
      chmodSync(instancesDir, 0o500);
      try {
        const stop = cli(root, "down", "--yes", "--json");
        const running = ["stack-broker", "stack-delivery", "stack-manager"].every((definition) => { const pid = pidOf(space, definition); return pid !== null && alive(pid); });
        check("down --yes with an unwritable instances folder refuses PERMISSION_DENIED, exit 2, naming it and chmod, and stops nothing",
          stop.status === 2 && stop.env?.error?.code === "PERMISSION_DENIED" && stop.env.error.message.includes(instancesDir) && Boolean(stop.env.error.remedy?.includes(`chmod u+w ${instancesDir}`)) && running, shown(stop));
        const start = cli(root, "up", "--json");
        check("up with it refuses the same way", start.status === 2 && start.env?.error?.code === "PERMISSION_DENIED" && Boolean(start.env.error.remedy?.includes(`chmod u+w ${instancesDir}`)), shown(start));
      } finally { chmodSync(instancesDir, 0o700); }
    }
    // The receipt and service status name every listener the stack opened: the broker's client and
    // websocket listeners and the manager's console, here all on loopback.
    type Listed = Parameters<typeof exposedPlaintext>[0];
    const listed = added.env?.result?.listeners as Listed | null | undefined;
    const brokerListed = cli(root, "service", "status", "stack-broker", "--space", space, "--json").env?.result?.listeners as Listed | undefined;
    const consoleListed = cli(root, "service", "status", "stack-manager", "--space", space, "--json").env?.result?.listeners as Listed | undefined;
    check("up's receipt and service status list the broker's client and websocket listeners and the manager's console, on loopback",
      JSON.stringify(listed?.map((l) => [l.name, l.host, l.name === "client" ? l.port : typeof l.port, l.reach, l.encrypted])) === JSON.stringify([["client", "127.0.0.1", port, "loopback", false], ["websocket", "127.0.0.1", "number", "loopback", false], ["console", "127.0.0.1", "object", "loopback", false]])
        && JSON.stringify(brokerListed) === JSON.stringify(listed?.slice(0, 2)) && JSON.stringify(consoleListed) === JSON.stringify(listed?.slice(2)), { listed, brokerListed, consoleListed });
    // A wildcard bind, as `up --host 0.0.0.0` renders it, reaches every interface, and the report says
    // which listeners are plaintext there. No socket is opened for this.
    const wildConfig = join(home, "wildcard-server.conf");
    writeFileSync(wildConfig, "host: 0.0.0.0\nport: 4999\nmax_control_line: 1\nwebsocket {\n  host: 0.0.0.0\n  port: 5000\n  no_tls: true\n}\n");
    const definitionOf = (adapter: string, options: Record<string, unknown>) => ({ name: "x", record: { revision: 1, value: { launch: { type: "adapter", adapter, options } } } }) as unknown as Parameters<typeof definitionListeners>[0];
    const wild = [...definitionListeners(definitionOf("nats-broker", { config: wildConfig })) ?? [], ...definitionListeners(definitionOf("manager-service", { "console-host": "0.0.0.0" })) ?? []];
    check("a wildcard bind lists every listener on every interface and names the plaintext ones",
      JSON.stringify(wild.map(listenerRow)) === JSON.stringify([["Broker client", "0.0.0.0:4999 · every interface · plaintext"], ["Broker websocket", "0.0.0.0:5000 · every interface · plaintext"], ["Manager console", "0.0.0.0, on a port the manager picks when it starts · every interface · plaintext HTTP"]])
        && exposedPlaintext(wild) === "The broker client, broker websocket and manager console listeners are plaintext and reachable from other machines, so what crosses them is not encrypted."
        && exposedPlaintext(listed ?? []) === undefined, wild);
    check("...and status no longer reports the stack as manager-less", noManager() === false);

    // A broker definition's address is checked when it is added, as its paths are. A start applied
    // the address rules only after it recorded an instance, and named neither the option nor the value.
    // The stack's own broker configuration and binary, which pass the path checks.
    const stackLaunch = serviceDefinitionStore(space).read("stack-broker")?.record.value.launch;
    const [brokerConfig, brokerBinary] = stackLaunch?.type === "adapter" ? [String(stackLaunch.options.config), String(stackLaunch.options.binary)] : ["", ""];
    const addBroker = (name: string, server: string) => cli(root, "service", "add", name, "--preset", "broker", "--root", root, "--config", brokerConfig, "--binary", brokerBinary, "--server", server, "--json");
    const word = addBroker("bad-word", "hallo welt");
    check('service add --preset broker refuses --server "hallo welt" USAGE_INVALID, exit 1, quoting it, and saves nothing',
      word.status === 1 && word.env?.error?.code === "USAGE_INVALID" && word.env.error.message === '--server "hallo welt": the broker address must be one nats:// or tls:// URL; nothing was saved' && serviceDefinitionStore(space).read("bad-word") === undefined, shown(word));
    const credential = addBroker("bad-cred", "nats://user:secret@127.0.0.1:4999");
    check("an address with a credential is refused without printing it",
      credential.status === 1 && credential.env?.error?.code === "USAGE_INVALID" && /^--server \(not printed/.test(credential.env.error.message) && !`${credential.stdout}${credential.stderr}`.includes("secret") && serviceDefinitionStore(space).read("bad-cred") === undefined, shown(credential));
    const brokerFile = (server: string) => ({ schemaVersion: 1 as const, space, launch: { type: "adapter" as const, adapter: "nats-broker", options: { root, config: brokerConfig, binary: brokerBinary, server } }, readiness: { type: "adapter" as const, timeoutMs: 30_000 } });
    const badFile = join(home, "bad-server.json");
    writeFileSync(badFile, JSON.stringify(brokerFile("nats://127.0.0.1:4999x")));
    const imported = cli(root, "service", "add", "bad-file", "--file", badFile, "--json");
    check("service add --file refuses that address SCHEMA_INVALID, exit 1, naming launch.options.server and the value",
      imported.status === 1 && imported.env?.error?.code === "SCHEMA_INVALID" && imported.env.error.message.startsWith(`the definition's launch.options.server "nats://127.0.0.1:4999x": `) && serviceDefinitionStore(space).read("bad-file") === undefined, shown(imported));
    // Saved as an older CLI saved it, before the check.
    serviceDefinitionStore(space).commit("old-broker", undefined, brokerFile("hallo welt"));
    const oldStart = cli(root, "service", "start", "old-broker", "--json");
    check("starting a definition saved before the check refuses UNSUPPORTED, exit 2, naming its server option and value and how to add it again",
      oldStart.status === 2 && oldStart.env?.error?.code === "UNSUPPORTED" && oldStart.env.error.message.includes(`the definition's server option "hallo welt": the broker address must be one nats:// or tls:// URL`)
        && Boolean(oldStart.env.error.remedy?.startsWith(`remove it with cotal service remove old-broker --space ${space} --yes, then add it again`)), shown(oldStart));
    const oldRemoved = cli(root, "service", "remove", "old-broker", "--yes", "--json");
    check("rig: the old definition and its failed instance are removed", oldRemoved.status === 0 && serviceDefinitionStore(space).read("old-broker") === undefined, shown(oldRemoved));

    const crashed = pidOf(space, "stack-broker");
    if (crashed !== null) process.kill(crashed, "SIGKILL");
    await until(() => gone(space, "stack-broker"), 10_000);
    const repaired = cli(root, "up", "--json");
    track(space);
    const replacement = pidOf(space, "stack-broker");
    check("up after a broker crash restarts the broker from its records", repaired.status === 0 && replacement !== null && replacement !== crashed && alive(replacement), shown(repaired));
    // A killed manager leaves its pidfile behind; the relaunched one claims the slot once that
    // process is proven gone.
    const crashedManager = pidOf(space, "stack-manager");
    if (crashedManager !== null) process.kill(crashedManager, "SIGKILL");
    await until(() => gone(space, "stack-manager"), 10_000);
    const relaunched = cli(root, "up", "--json");
    track(space);
    const manager = pidOf(space, "stack-manager");
    check("up after a manager crash relaunches the manager over the pidfile its process left", crashedManager !== null && relaunched.status === 0 && relaunched.env?.outcome === "ok" && manager !== null && manager !== crashedManager && alive(manager), { ...shown(relaunched), crashedManager, manager });
    // A killed delivery daemon cannot release shard 0, so its ready row, which names this folder's
    // credential, outlives it until the bucket TTL. Status reads that row as the dead daemon's.
    const responder = () => (cli(root, "status", "--json").env?.result?.selected as { deliveryResponder?: string } | undefined)?.deliveryResponder;
    const liveResponder = responder();
    const killedDelivery = pidOf(space, "stack-delivery");
    if (killedDelivery !== null) process.kill(killedDelivery, "SIGKILL");
    await until(() => gone(space, "stack-delivery"), 10_000);
    const deadResponder = responder();
    check("status reads the live daemon's ready row as bound and a killed daemon's as stale", killedDelivery !== null && liveResponder === "bound" && deadResponder === "stale", { killedDelivery, liveResponder, deadResponder });
    const finalDown = cli(root, "down", "--yes", "--plain");
    check("down --yes stops the repaired stack", finalDown.status === 0 && (replacement === null || !alive(replacement)), shown(finalDown));
    // The receipt names the mesh once, lists the members in the stop order with their results, and
    // ends with one Next; --yes prints no plan, impact or broker scope ahead of it.
    const rows = finalDown.stdout.split("\n").filter((line) => /^ {2}(manager|delivery|broker) /.test(line)).map((line) => line.trim().split(/\s+/));
    check("down --yes prints one receipt: the mesh once, members in stop order with results, and cotal up as the Next",
      finalDown.stdout.startsWith(`Mesh: ${space}\n`) && finalDown.stdout.split("Mesh: ").length === 2 && !/stop plan|stop impact|stop scope/.test(finalDown.stdout)
        && JSON.stringify(rows.map((row) => [row[0], row.slice(2).join(" ")])) === JSON.stringify([["manager", "stopped"], ["delivery", "already stopped"], ["broker", "stopped"]])
        && finalDown.stdout.trimEnd().endsWith("Next\n  cotal up  Start the stack again from its journal and saved definitions"), finalDown.stdout);
  }

  // 2b. A ps while an up is still starting the manager. Delivery is frozen once pinned, so the up
  // waits on its readiness with the manager planned.
  {
    const space = "starting";
    const root = prepare(space);
    const port = await freePort();
    const child = spawn(process.execPath, ["--import", TSX_IMPORT, CLI, "up", "--server", `nats://127.0.0.1:${port}`, "--json"], { cwd: root, env, stdio: "ignore" });
    const pinned = await until(() => pidOf(space, "stack-delivery") !== null, 120_000);
    const delivery = pidOf(space, "stack-delivery");
    if (delivery !== null) process.kill(delivery, "SIGSTOP");
    track(space);
    const manager = () => readStackJournal(root)?.journal.members.find((row) => row.role === "manager")?.state;
    const starting = cli(root, "ps", "--space", space, "--json");
    check("ps while an up starts the stack says its manager is starting, TARGET_UNAVAILABLE, exit 2",
      pinned && child.exitCode === null && manager() === "planned" && starting.status === 2 && starting.env?.error?.code === "TARGET_UNAVAILABLE" &&
        starting.env.error.message === "the stack's manager is starting, so it has no managed agents to list yet", { ...shown(starting), manager: manager() });
    child.kill("SIGKILL");
    await exited(child);
    const dead = cli(root, "ps", "--space", space, "--json");
    check("...and once that up is killed, ps says no manager is running", dead.status === 2 && dead.env?.error?.message === "no manager is running for this space, so it has no managed agents to list", shown(dead));
    if (delivery !== null) process.kill(delivery, "SIGKILL");
    await until(() => gone(space, "stack-delivery"), 10_000);
    const stopped = cli(root, "down", "--yes", "--json");
    check("down --yes settles that up and stops its broker", stopped.status === 0, shown(stopped));
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
    // Another stack's broker answers at the address: a second space's first up refuses before its
    // broker is prepared. That stack never launched a member, so its journal pins nothing.
    const other = "heldport";
    const second = prepare(other);
    const blocked = cli(second, "up", "--server", `nats://127.0.0.1:${port}`, "--no-manager", "--json");
    check("a first up where another stack's broker answers refuses CONFLICT, exit 2, naming the address and its space", blocked.status === 2 && blocked.env?.error?.code === "CONFLICT" && blocked.env.error.message.includes(`something already answers at the stack's broker address nats://127.0.0.1:${port}, where space ${space} is registered`), shown(blocked));
    check("its next step is another --server, or stopping that space", Boolean(blocked.env?.error?.remedy?.includes("cotal up --server nats://127.0.0.1:<port>") && blocked.env.error.remedy.includes(`stop space ${space} with cotal down from `)), shown(blocked));
    const nothing = cli(second, "down", "--yes", "--json");
    check("down of that never-started stack stops nothing and exits 0", nothing.status === 0 && nothing.env?.outcome === "no-op", shown(nothing));
    const reset = cli(second, "reset", "space", other, "--dry-run", "--json");
    check("reset space finds nothing to reset there and names cotal up", reset.status === 2 && reset.env?.error?.code === "TARGET_NOT_FOUND" && Boolean(reset.env.error.remedy?.includes("cotal up")), shown(reset));
    // A space with neither a registration nor a stopped stack, as a legacy root's down leaves one, is
    // cleared with clean from its root, and each reset names its own clean route.
    for (const [kind, clean] of [["space", "cotal clean all --force"], ["store", "cotal clean store --force"]] as const) {
      const unregistered = cli(second, "reset", kind, "neverregistered", "--dry-run", "--json");
      check(`reset ${kind} of a space with no registration or stack names ${clean} from its root`, unregistered.status === 2 && unregistered.env?.error?.code === "TARGET_NOT_FOUND" && Boolean(unregistered.env.error.remedy?.includes(`run ${clean} from that root`)), shown(unregistered));
    }
    const movedPort = await freePort();
    const moved = cli(second, "up", "--server", `nats://127.0.0.1:${movedPort}`, "--no-manager", "--json");
    track(other);
    check("its next up starts at another address", moved.status === 0, shown(moved));
    check("down --yes stops the moved stack", cli(second, "down", "--yes", "--json").status === 0);
    // Once it ran, it keeps that address, so a broker another space started there must stop first.
    const third = "takenport";
    const taker = prepare(third);
    const took = cli(taker, "up", "--server", `nats://127.0.0.1:${movedPort}`, "--no-manager", "--json");
    track(third);
    const keeps = cli(second, "up", "--no-manager", "--json");
    check("a stack that ran names stopping the space at its address and keeps that address", took.status === 0 && keeps.status === 2 && keeps.env?.error?.code === "CONFLICT" && keeps.env.error.message.includes(`where space ${third} is registered`) && Boolean(keeps.env.error.remedy?.startsWith(`stop space ${third} with cotal down from `) && keeps.env.error.remedy.endsWith("; this stack keeps its recorded address")), { took: shown(took), keeps: shown(keeps) });
    check("down --yes stops the space that took the address", cli(taker, "down", "--yes", "--json").status === 0);
    const back = cli(second, "up", "--no-manager", "--json");
    track(other);
    check("bare up then starts the moved stack at its recorded address", back.status === 0, shown(back));
    check("down --yes stops the moved stack again", cli(second, "down", "--yes", "--json").status === 0);
    const stopped = cli(root, "down", "--yes", "--json");
    check("down --yes stops it", stopped.status === 0, shown(stopped));
  }

  // 3c. A recorded file store cap too small for the space's streams, as an earlier release accepted.
  {
    const space = "smallcap";
    const root = prepare(space);
    const first = cli(root, "up", "--server", `nats://127.0.0.1:${await freePort()}`, "--no-manager", "--max-file-store", "134217728", "--json");
    track(space);
    check("up with a 128 MiB cap starts", first.status === 0, shown(first));
    const running = cli(root, "up", "--no-manager", "--max-file-store", "268435456", "--json");
    check("a running broker keeps its cap: CONFLICT, naming the stop that lets a new one apply", running.status === 2 && running.env?.error?.code === "CONFLICT" && Boolean(running.env.error.remedy?.includes("a new --max-file-store applies once the broker is stopped with cotal down --yes")), shown(running));
    check("down --yes stops it", cli(root, "down", "--yes", "--json").status === 0);
    const path = join(root, ".cotal", "stack-controller.json");
    const journal = JSON.parse(readFileSync(path, "utf8")) as { broker: Record<string, unknown> };
    writeFileSync(path, JSON.stringify({ ...journal, broker: { ...journal.broker, maxFileStore: 1 } }));
    const failed = cli(root, "up", "--no-manager", "--json");
    track(space);
    check("bare up with a 1-byte recorded cap fails OPERATION_FAILED, exit 5, naming the cap and the flag that replaces it", failed.status === 5 && failed.env?.error?.code === "OPERATION_FAILED" && failed.env.error.message.includes("its JetStream file store cap (--max-file-store 1) has too little room for them") && Boolean(failed.env.error.remedy?.includes(`run cotal up --max-file-store <bytes> from ${root}`)), shown(failed));
    const fixed = cli(root, "up", "--no-manager", "--max-file-store", "134217728", "--json");
    track(space);
    check("up with a new cap on the stopped broker records it and starts", fixed.status === 0 && (JSON.parse(readFileSync(path, "utf8")) as { broker: { maxFileStore?: number } }).broker.maxFileStore === 134217728, shown(fixed));
    check("down --yes stops it", cli(root, "down", "--yes", "--json").status === 0);
    // The membership bucket's reservation alone leaves no byte free, and the broker refuses the next stream.
    const recorded = JSON.parse(readFileSync(path, "utf8")) as { broker: Record<string, unknown> };
    writeFileSync(path, JSON.stringify({ ...recorded, broker: { ...recorded.broker, maxFileStore: MIN_FILE_STORE - 1 } }));
    const reserved = cli(root, "up", "--no-manager", "--json");
    track(space);
    check(`a recorded cap of ${MIN_FILE_STORE - 1}, the membership bucket's reservation, fails OPERATION_FAILED, exit 5, naming ${MIN_FILE_STORE} as the least`, reserved.status === 5 && reserved.env?.error?.code === "OPERATION_FAILED" && Boolean(reserved.env.error.remedy?.includes(`with at least ${MIN_FILE_STORE} bytes`)), shown(reserved));
    const floor = cli(root, "up", "--no-manager", "--max-file-store", String(MIN_FILE_STORE), "--json");
    track(space);
    check(`up --max-file-store ${MIN_FILE_STORE} starts the stack`, floor.status === 0, shown(floor));
    check("down --yes stops it", cli(root, "down", "--yes", "--json").status === 0);
  }

  // 3e. A journal removed after `down` dropped the registration, as the way out of a damaged one
  // says. The saved broker definition names the address; with none, a root that ran refuses.
  {
    const space = "unjournaled";
    const root = prepare(space);
    const server = `nats://127.0.0.1:${await freePort()}`;
    const first = cli(root, "up", "--server", server, "--no-manager", "--json");
    track(space);
    check("up --no-manager starts the stack to unjournal", first.status === 0, shown(first));
    check("down --yes stops it", cli(root, "down", "--yes", "--json").status === 0);
    const journalPath = join(root, ".cotal", "stack-controller.json");
    rmSync(journalPath);
    const recovered = cli(root, "up", "--no-manager", "--json");
    track(space);
    check("bare up with no journal or registration starts at the address its saved broker definition names, and warns STACK_ADDRESS_RECOVERED",
      recovered.status === 0 && readStackJournal(root)?.journal.server === server && Boolean(recovered.env?.warnings?.some((warning) => warning.code === "STACK_ADDRESS_RECOVERED")), shown(recovered));
    check("down --yes stops it", cli(root, "down", "--yes", "--json").status === 0);
    rmSync(journalPath);
    const records = join(home, "services", Buffer.from(space).toString("hex"));
    for (const row of serviceInstances(space, "stack-broker")) rmSync(join(records, "instances", `${Buffer.from(row.record.value.instanceId).toString("hex")}.json`));
    rmSync(join(records, "definitions", `${Buffer.from("stack-broker").toString("hex")}.json`));
    const refused = cli(root, "up", "--no-manager", "--json");
    check("with no saved broker definition either, bare up refuses USAGE_INVALID, exit 1, and asks for --server",
      refused.status === 1 && refused.env?.error?.code === "USAGE_INVALID" && refused.env.error.remedy === "run cotal up --server <url> with the address it ran at" && !existsSync(journalPath), shown(refused));
    const named = cli(root, "up", "--server", server, "--no-manager", "--json");
    track(space);
    check("up --server with that address starts it", named.status === 0, shown(named));
    check("down --yes stops it", cli(root, "down", "--yes", "--json").status === 0);
  }

  // 3d. A project folder renamed while its stack runs.
  {
    const space = "renamed";
    const root = prepare(space);
    const started = cli(root, "up", "--server", `nats://127.0.0.1:${await freePort()}`, "--json");
    track(space);
    check("up starts the stack", started.status === 0, shown(started));
    check("its broker configuration names the store relative to the root", readFileSync(join(root, ".cotal", "auth", "server.conf"), "utf8").includes(`jetstream { store_dir: ${JSON.stringify(join(".cotal", "nats"))}`));
    const moved = `${root}-renamed`;
    renameSync(root, moved);
    const send = cli(moved, "send", "--space", space, "-c", "general", "after the move", "--json");
    check("send from the renamed folder refuses CONFLICT, naming the move and the way back", send.status === 2 && send.env?.error?.code === "CONFLICT" && send.env.error.message.includes(`was started in ${root}`) && send.env.error.message.endsWith("so this folder was moved from there") && send.env.error.remedy === `move this folder back to ${root}, then run the command again there`, shown(send));
    const up = cli(moved, "up", "--json");
    check("up there refuses CONFLICT, saying the folder was moved", up.status === 2 && up.env?.error?.code === "CONFLICT" && up.env.error.message.includes(`recorded at ${root}, so this folder was moved from there`), shown(up));
    const running = cli(moved, "status", "--space", space, "--json"), bare = cli(moved, "status", "--json");
    const selected = running.env?.result?.selected as { code?: string; message?: string } | undefined, hints = (running.env?.result?.hints as string[] | undefined) ?? [];
    check("status --space there says the folder was moved and names the way back", selected?.code === "moved-folder" && Boolean(selected.message?.endsWith("so this folder was moved from there")) && hints.includes(`move this folder back to ${root}, then run the command again there`), { selected, hints });
    check("status there offers no clean store, which refuses in a moved folder", bare.status === 0 && !((bare.env?.result?.hints as string[] | undefined) ?? []).some((hint) => hint.includes("clean store")), bare.env?.result?.hints);
    // The stack's own clients create consumers within seconds; a broker that named its store by the
    // old absolute path created that path again for them.
    await sleep(10_000);
    check("the running broker did not create the old path again", !existsSync(root), existsSync(root) ? readdirSync(root, { recursive: true }) : []);
    renameSync(moved, root);
    check("after the move back, down --yes stops it", cli(root, "down", "--yes", "--json").status === 0);
    // Stopped and moved again: this machine records the stack's instances, so every command from the
    // moved folder names the one way back.
    renameSync(root, moved);
    const way = `move this folder back to ${root}, then run the command again there`;
    const routes = [cli(moved, "up", "--json"), cli(moved, "send", "--space", space, "-c", "general", "after the stop", "--json"), cli(moved, "history", "general", "--space", space, "--json")];
    const status = cli(moved, "status", "--space", space, "--json");
    renameSync(moved, root);
    // A copy keeps the journal too. Clean store refuses in both, so status does not offer it there.
    const copy = `${root}-copy`;
    spawnSync("cp", ["-a", root, copy]);
    const copyStatus = cli(copy, "status", "--space", space, "--json");
    rmSync(copy, { recursive: true, force: true });
    check("stopped and moved, up, send and history there all name moving the folder back", routes.every((r) => r.status === 2 && r.env?.error?.remedy === way), routes.map(shown));
    check("status --space there names the same step", ((status.env?.result?.hints as string[] | undefined) ?? []).includes(way), shown(status));
    const offersNoReset = (r: Run) => {
      const result = r.env?.result as { folder?: { storedState?: boolean }; hints?: string[] } | undefined;
      return result?.folder?.storedState === false && Array.isArray(result.hints) && !result.hints.some((hint) => hint.includes("clean store"));
    };
    check("status in the moved folder and in a copy offers no clean store for the stack's store", offersNoReset(status) && offersNoReset(copyStatus), { moved: shown(status), copy: shown(copyStatus) });
  }

  // 3b. A first up refused at a port another program holds pins nothing.
  {
    const space = "heldfirst";
    const root = prepare(space);
    const holder = createServer();
    const port = await listenOn(holder, await freePort());
    const refused = cli(root, "up", "--server", `nats://127.0.0.1:${port}`, "--no-manager", "--json");
    track(space);
    check("a first up at a port another program holds refuses CONFLICT, exit 2, naming the address and bind error", refused.status === 2 && refused.env?.error?.code === "CONFLICT" && refused.env.error.message.includes(`127.0.0.1:${port}`) && refused.env.error.message.includes("address already in use"), shown(refused));
    check("the refusal says the stack started no member", Boolean(refused.env?.error?.message.startsWith("the controller stack started no member (broker: ")) && !refused.env?.error?.message.includes("started members were kept"), shown(refused));
    check("its next step is another --server, or stopping that program", Boolean(refused.env?.error?.remedy?.includes("cotal up --server nats://127.0.0.1:<port>") && refused.env.error.remedy.includes(`stop the process listening on 127.0.0.1:${port}`)), shown(refused));
    check("no broker instance was recorded", serviceInstances(space, "stack-broker").length === 0, serviceInstances(space, "stack-broker").map((row) => row.record.value.state));
    const nothing = cli(root, "down", "--yes", "--json");
    check("down --yes there stops nothing and exits 0", nothing.status === 0 && nothing.env?.outcome === "no-op", shown(nothing));
    // Nor a mode: the refused up asked for static auth, and the next one may ask for an open stack.
    const moved = cli(root, "up", "--server", `nats://127.0.0.1:${await freePort()}`, "--open", "--no-manager", "--json");
    track(space);
    check("the next up starts at another address while the program still holds the first", moved.status === 0, shown(moved));
    check("and in the open mode it asked for, which the refused up did not pin", moved.env?.result !== undefined && JSON.stringify(moved.env.result).includes('"mode":"open"'), shown(moved));
    check("down --yes stops it", cli(root, "down", "--yes", "--json").status === 0);
    await new Promise<void>((done) => holder.close(() => done()));
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

    // A named stop resolves the selected space, and an earlier section's stopped space stays selected.
    const legacyName = cli(root, "down", "manager", "--space", space, "--yes", "--json");
    check("down manager on a controller stack names stack-manager", legacyName.status === 2 && legacyName.env?.error?.code === "TARGET_NOT_FOUND" && Boolean(legacyName.env.error.remedy?.includes("stack-manager")), shown(legacyName));
    const brokerFirst = cli(root, "down", "stack-broker", "--space", space, "--yes", "--json");
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
    // A suspended broker takes the connection and sends nothing; down reads its stopped state instead.
    if (broker !== null) process.kill(broker, "SIGSTOP");
    const hungAt = Date.now();
    const hung = cli(root, "down", "--yes", "--json");
    const hungMs = Date.now() - hungAt;
    if (broker !== null) process.kill(broker, "SIGCONT");
    check("down with a suspended broker refuses within 10s, before any read through it", hungMs < 10_000, { hungMs });
    check("down with a suspended broker refuses naming its pid and kill -CONT, and stops nothing", hung.status === 2 && hung.env?.error?.code === "TARGET_UNAVAILABLE" && Boolean(hung.env.error.message.includes(`pid ${broker}`)) && Boolean(hung.env.error.remedy?.includes(`kill -CONT ${broker}`)) && broker !== null && alive(broker) && manager !== null && alive(manager), shown(hung));
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
    // That down recorded every crashed member as already stopped, so the reset, which removes the
    // store rather than keeps it, is offered without a restart.
    const afterCrash = cli(root, "reset", "store", space, "--dry-run", "--json");
    const verdict = afterCrash.env?.result?.applyVerdict as { offered?: boolean; remedy?: string | null } | undefined;
    check("reset store --dry-run after crashes and down --yes offers the apply", afterCrash.status === 0 && verdict?.offered === true, shown(afterCrash));
    // A reset that finds the root's maintenance lock held, as by an `up` started at the same time,
    // names the holder's pid as whole-stack commands do, and removes nothing.
    const held = acquireMaintenanceLock(root);
    try {
      for (const verb of ["store", "space"]) {
        const raced = cli(root, "reset", verb, space, "--yes", "--json");
        check(`reset ${verb} refuses a held maintenance lock by its holder's pid`, raced.status === 2 && raced.env?.error?.code === "LIFECYCLE_BLOCKED" && Boolean(raced.env.error.message.includes(`(pid ${process.pid})`)) && raced.env.target?.holderPid === process.pid, shown(raced));
      }
    } finally { releaseMaintenanceLock(held); }
    const stillOffered = cli(root, "reset", "store", space, "--dry-run", "--json");
    check("...and those refusals removed nothing", stillOffered.status === 0 && (stillOffered.env?.result?.applyVerdict as { offered?: boolean } | undefined)?.offered === true, shown(stillOffered));
    // The killed daemon never released shard 0. That down kept its credential, so the repair up
    // recognises the row as the dead daemon's, waits out its TTL and starts delivery.
    check("down --yes after a delivery crash keeps the delivery credential", settled.env?.result?.cleanup === "registration-removed-delivery-credential-kept", settled.env?.result?.cleanup);
    const recovered = cli(root, "up");
    track(space);
    const delivery = pidOf(space, "stack-delivery");
    check("up after the crash and down waits out the dead daemon's lease and starts delivery", recovered.status === 0 && recovered.stderr.includes("shard 0 is still leased to this folder's previous delivery daemon") && delivery !== null && alive(delivery), shown(recovered));
    const recoveredDown = cli(root, "down", "--yes", "--json");
    check("down --yes stops the recovered stack and removes the credential", recoveredDown.status === 0 && recoveredDown.env?.result?.cleanup === "delivery-credential-and-registration-removed", shown(recoveredDown));
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
    const abandonLive = cli(root, "down", "--abandon-stop", request ?? "none", "--yes", "--json");
    check("while the frozen manager runs, down --abandon-stop refuses and abandons nothing", abandonLive.status === 2 && abandonLive.env?.error?.code === "LIFECYCLE_BLOCKED" && Boolean(abandonLive.env.error.message.includes("still runs")) && pid !== null && alive(pid) && held(), shown(abandonLive));
    if (pid !== null) process.kill(pid, "SIGKILL");
    await until(() => gone(space, "stack-manager"), 10_000);
    const afterExit = cli(root, "down", "--yes", "--json");
    check("after the manager exits, down still refuses naming its instance and request", names(afterExit) && held(), shown(afterExit));
    check("its remedy names the abandon command for that request", Boolean(afterExit.env?.error?.remedy?.includes(`cotal down --abandon-stop ${request} --yes`)), shown(afterExit));
    check("no member was stopped and no registration was removed", delivery !== null && alive(delivery) && broker !== null && alive(broker) && findMesh(space) !== undefined, { delivery, broker, registered: findMesh(space) !== undefined });
    const restart = cli(root, "up", "--json");
    check("after the manager exits, up refuses the same way and launches no manager", names(restart) && held(), shown(restart));
    const unacknowledged = cli(root, "down", "--abandon-stop", request ?? "none", "--json");
    check("down --abandon-stop without --yes is a usage error, exit 1, and abandons nothing", unacknowledged.status === 1 && unacknowledged.env?.error?.code === "USAGE_INVALID" && held(), shown(unacknowledged));
    const another = cli(root, "down", "--abandon-stop", randomUUID(), "--yes", "--json");
    check("down --abandon-stop naming another request refuses TARGET_NOT_FOUND and abandons nothing", another.status === 2 && another.env?.error?.code === "TARGET_NOT_FOUND" && held() && alive(delivery!) && alive(broker!), shown(another));
    const marker = stopReservationPath(canonicalLocalProcessPath(MANAGER_PIDFILE, { root, space }));
    const markerHeld = () => { try { return lstatSync(marker).isFile(); } catch { return false; } };
    const abandoned = cli(root, "down", "--abandon-stop", request ?? "none", "--yes", "--json");
    const after = serviceInstances(space, "stack-manager")[0]?.record.value;
    const requestGone = states !== undefined && !readdirSync(states).some((name) => name.endsWith(".stop.json"));
    const warned = abandoned.env?.warnings?.find((warning) => warning.code === "STOP_ABANDONED");
    check("down --abandon-stop abandons the request, records the manager failed with a warning and stops the stack", abandoned.status === 0 && abandoned.env?.outcome === "ok" && warned?.target?.requestId === request && !markerHeld() && requestGone && after?.state === "failed" && gone(space, "stack-delivery") && gone(space, "stack-broker") && findMesh(space) === undefined, { ...shown(abandoned), warned, marker: markerHeld(), requestGone, state: after?.state });
    const again = cli(root, "up", "--json");
    const relaunched = pidOf(space, "stack-manager");
    check("up then starts the stack with a new manager", again.status === 0 && again.env?.outcome === "ok" && relaunched !== null && relaunched !== pid && alive(relaunched), { ...shown(again), relaunched });
    const stopped = cli(root, "down", "--yes", "--json");
    check("and down stops it", stopped.status === 0 && stopped.env?.outcome === "ok" && gone(space, "stack-manager") && findMesh(space) === undefined, shown(stopped));
  }
  {
    // The unconfirmed stop is a --with-agents one, so it also armed the manager's shutdown intent.
    const space = "unconfirmedagents";
    const root = prepare(space);
    const port = await freePort();
    const started = cli(root, "up", "--server", `nats://127.0.0.1:${port}`, "--json");
    track(space);
    const manager = serviceInstances(space, "stack-manager")[0];
    const pid = manager?.record.value.process?.pid ?? null;
    const states = serviceInstanceStore(space).directory();
    let frozen = false;
    const watcher = states && pid !== null ? watch(states, (_event, name) => {
      if (frozen || !String(name ?? "").endsWith(".stop.json")) return;
      frozen = true;
      try { process.kill(pid, "SIGSTOP"); } catch { /* the checks below report it */ }
    }) : undefined;
    const first = await cliAsync(root, "down", "--with-agents", "--yes", "--json");
    watcher?.close();
    let request: string | undefined;
    try { request = manager && states ? readServiceStopRequest({ space, instanceId: manager.name, launchRequestId: manager.record.value.launchRequestId, stateDirectory: states })?.requestId : undefined; } catch { request = undefined; }
    const intent = canonicalLocalProcessPath(MANAGER_SHUTDOWN_INTENT, { root, space });
    const armed = () => { try { return lstatSync(intent).isFile(); } catch { return false; } };
    if (pid !== null) process.kill(pid, "SIGKILL");
    await until(() => gone(space, "stack-manager"), 10_000);
    check(`${space}: the unconfirmed --with-agents stop leaves its shutdown intent armed after the manager exits`, started.status === 0 && frozen && first.env?.outcome === "unknown" && request !== undefined && armed(), { up: shown(started), frozen, first: shown(first), request, armed: armed() });
    const abandoned = cli(root, "down", "--abandon-stop", request ?? "none", "--yes", "--json");
    check(`${space}: down --abandon-stop removes that intent with the request and stops the stack`, abandoned.status === 0 && abandoned.env?.outcome === "ok" && !armed() && gone(space, "stack-broker") && findMesh(space) === undefined, { ...shown(abandoned), armed: armed() });
    const again = cli(root, "up", "--json");
    const stopped = cli(root, "down", "--yes", "--json");
    check(`${space}: up starts a new manager, and down stops it with no earlier intent in the way`, again.status === 0 && stopped.status === 0 && stopped.env?.outcome === "ok" && gone(space, "stack-manager"), { up: shown(again), down: shown(stopped) });
  }

  // 7. A native manager stop the manager completes after `down` stopped waiting for it. It is frozen
  //    once its accepted receipt appears, past the first down's wait, then resumed.
  const lateReceipt = async (space: string, freezeOn: ".accepted.json" | ".stop.json") => {
    const root = prepare(space);
    const port = await freePort();
    const started = cli(root, "up", "--server", `nats://127.0.0.1:${port}`, "--json");
    track(space);
    const manager = serviceInstances(space, "stack-manager")[0];
    const pid = manager?.record.value.process?.pid ?? null;
    const states = serviceInstanceStore(space).directory();
    let frozen = false;
    const watcher = states && pid !== null ? watch(states, (_event, name) => {
      if (frozen || !String(name ?? "").endsWith(freezeOn)) return;
      frozen = true;
      try { process.kill(pid, "SIGSTOP"); } catch { /* the checks below report it */ }
    }) : undefined;
    const first = await cliAsync(root, "down", "--yes", "--json");
    watcher?.close();
    let request: string | undefined;
    try { request = manager && states ? readServiceStopRequest({ space, instanceId: manager.name, launchRequestId: manager.record.value.launchRequestId, stateDirectory: states })?.requestId : undefined; } catch { request = undefined; }
    const marker = stopReservationPath(canonicalLocalProcessPath(MANAGER_PIDFILE, { root, space }));
    const markerHeld = () => { try { return lstatSync(marker).isFile(); } catch { return false; } };
    check(`${space}: the first down reports the manager stop unknown and keeps its reservation`, started.status === 0 && frozen && first.env?.outcome === "unknown" && first.env.error?.code === "OPERATION_UNKNOWN" && request !== undefined && markerHeld(), { up: shown(started), frozen, first: shown(first), request, marker: markerHeld() });
    if (pid !== null) process.kill(pid, "SIGCONT");
    const receipt = (phase: string) => states !== undefined && readdirSync(states).some((name) => name.endsWith(`.${phase}.json`));
    if (freezeOn === ".accepted.json") {
      // A resumed manager's stop has taken over 30 s while another stack suite ran alongside.
      const exitedLate = pid !== null && await until(() => !alive(pid), 90_000);
      check(`${space}: the resumed manager records its stop completed and exits`, exitedLate && receipt("completed"), { exitedLate, completed: receipt("completed") });
    } else {
      const refused = await until(() => receipt("refused"), 30_000);
      check(`${space}: the resumed manager refuses the request its exited down published and keeps running`, refused && !receipt("accepted") && pid !== null && alive(pid), { refused, accepted: receipt("accepted"), alive: pid !== null && alive(pid) });
    }
    const settled = (row = serviceInstances(space, "stack-manager").find((entry) => entry.name === manager?.name)) => row?.record.value.state === "stopped" && row.record.value.nativeStop?.requestId === request && row.record.value.nativeStop?.nativeStop === "returned";
    return { root, pid, markerHeld, settled };
  };
  {
    const { root, markerHeld, settled } = await lateReceipt("latedown", ".accepted.json");
    const recovered = cli(root, "down", "--yes", "--json");
    check("bare down settles the late-completed manager stop from its receipt and stops the rest of the stack", recovered.status === 0 && recovered.env?.outcome === "ok" && settled() && !markerHeld() && gone("latedown", "stack-delivery") && gone("latedown", "stack-broker") && findMesh("latedown") === undefined, { ...shown(recovered), settled: settled(), marker: markerHeld() });
  }
  {
    const { root, pid, markerHeld } = await lateReceipt("lateup", ".accepted.json");
    const recovered = cli(root, "up", "--json");
    track("lateup");
    // The up relaunches the settled instance, so its record is running again; the settlement shows
    // as the earlier operation settled, the released reservation and a manager under a new pid.
    const relaunched = pidOf("lateup", "stack-manager");
    check("bare up settles the late-completed manager stop from its receipt and starts a manager", recovered.status === 0 && recovered.env?.outcome === "ok" && Boolean(recovered.env.warnings?.some((warning) => warning.code === "OPERATION_SETTLED")) && !markerHeld() && relaunched !== null && relaunched !== pid && alive(relaunched), { ...shown(recovered), warnings: recovered.env?.warnings, marker: markerHeld(), relaunched, pid });
    const stopped = cli(root, "down", "--yes", "--json");
    check("down then stops the relaunched manager under a new reservation", stopped.status === 0 && stopped.env?.outcome === "ok" && gone("lateup", "stack-manager") && !markerHeld(), shown(stopped));
  }
  {
    const { root, pid, markerHeld } = await lateReceipt("laterefused", ".stop.json");
    const states = serviceInstanceStore("laterefused").directory();
    const requestGone = () => states !== undefined && !readdirSync(states).some((name) => name.endsWith(".stop.json"));
    const reused = cli(root, "up", "--json");
    const row = serviceInstances("laterefused", "stack-manager")[0]?.record.value;
    check("bare up settles the refused manager stop, removes its request and reuses the running manager", reused.status === 0 && ["ok", "no-op"].includes(reused.env?.outcome ?? "") && !markerHeld() && requestGone() && row?.state === "running" && row.process?.pid === pid && pid !== null && alive(pid), { ...shown(reused), marker: markerHeld(), requestGone: requestGone(), state: row?.state, pid: row?.process?.pid, frozenPid: pid });
    const stopped = cli(root, "down", "--yes", "--json");
    check("down then stops that manager and the rest of the stack", stopped.status === 0 && stopped.env?.outcome === "ok" && gone("laterefused", "stack-manager") && !markerHeld() && findMesh("laterefused") === undefined, shown(stopped));
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
    const notice = recovered.env?.warnings?.find((warning) => warning.code === "OPERATION_SETTLED")?.message ?? "";
    check("its notice says the earlier up was interrupted with every member running, not that it failed", /^the earlier up \S+ was interrupted before it recorded an outcome; every member is running \(broker, delivery, manager\)$/.test(notice), recovered.env?.warnings);
    check("bare up after the interrupted redefinition adopts the journaled replacement and reuses it", recovered.status === 0 && row?.instanceId === replacement && row?.state === "reused" && journal?.operation.phase === "completed" && serviceInstances("redefup", "stack-manager").length === 1, shown(recovered));
    const stopped = cli(root, "down", "--yes", "--json");
    check("down then stops the recovered stack", stopped.status === 0 && gone("redefup", "stack-manager"), shown(stopped));
    // The session ceiling stays with the manager's saved definition, so a bare up does not drop it.
    const again = cli(root, "up", "--json");
    track("redefup");
    const launch = serviceDefinitionStore("redefup").read("stack-manager")?.record.value.launch;
    check("a bare up after down keeps the --max-sessions 32 an earlier up set, in the definition and the registration",
      again.status === 0 && launch?.type === "adapter" && launch.options["max-sessions"] === 32 && findMesh("redefup")?.maxSessions === 32 &&
        serviceInstances("redefup", "stack-manager").some((row) => observeServiceProcess(row.record.value) === "running"),
      { ...shown(again), options: launch?.type === "adapter" ? launch.options : undefined, registered: findMesh("redefup")?.maxSessions });
    const last = cli(root, "down", "--yes", "--json");
    check("down stops it again", last.status === 0 && gone("redefup", "stack-manager"), shown(last));
  }

  // 8. An upgrade: this release controls member records an earlier release wrote.
  {
    const root = prepare("upgraded");
    const port = await freePort();
    const started = cli(root, "up", "--server", `nats://127.0.0.1:${port}`, "--json");
    track("upgraded");
    const pinEarlier = () => {
      let pinned = 0;
      for (const row of serviceInstances("upgraded")) {
        const adapter = row.record.value.adapter;
        if (!adapter) continue;
        serviceInstanceStore("upgraded").commit(row.name, row, { ...row.record.value, adapter: { ...adapter, version: "0.0.1" } });
        pinned++;
      }
      return pinned;
    };
    check("upgraded: every running member's record now pins an earlier release", started.status === 0 && pinEarlier() >= 3, shown(started));
    const stopped = cli(root, "down", "--yes", "--json");
    check("down stops a running stack whose member records an earlier release wrote", stopped.status === 0 && gone("upgraded", "stack-manager") && gone("upgraded", "stack-broker"), shown(stopped));
    check("upgraded: the stopped members' records pin an earlier release again", pinEarlier() >= 3, serviceInstances("upgraded").map((row) => row.record.value.adapter?.version));
    const restarted = cli(root, "up", "--json");
    track("upgraded");
    check("up starts that stopped stack again", restarted.status === 0 && serviceInstances("upgraded", "stack-manager").some((row) => observeServiceProcess(row.record.value) === "running"), shown(restarted));
    const final = cli(root, "down", "--yes", "--json");
    check("a later down stops it", final.status === 0 && gone("upgraded", "stack-manager"), shown(final));
  }

  // 9. A down killed mid-stop, once the named member's record reads `stopping`.
  const killDownAt = async (root: string, space: string, definition: string): Promise<string | undefined> => {
    assertSmokeSandboxDown(anchors.get(root), ["down", "--yes", "--json"], { cwd: root, env });
    const child = spawn(process.execPath, ["--import", TSX_IMPORT, CLI, "down", "--yes", "--json"], { cwd: root, env, stdio: "ignore" });
    // A read that meets down's own write of the record refuses CONFLICT; the poll takes that as not yet.
    const read = () => {
      try { return serviceInstances(space, definition)[0]?.record.value; }
      catch (error) { if (isCommandFailure(error) && error.code === "CONFLICT") return undefined; throw error; }
    };
    const end = Date.now() + 120_000;
    let seen = read();
    while (Date.now() < end && child.exitCode === null && seen?.state !== "stopping") { await sleep(2); seen = read(); }
    const request = seen?.state === "stopping" ? seen.requestId : undefined;
    child.kill("SIGKILL");
    await exited(child);
    return request;
  };
  {
    const space = "killedbroker";
    const root = prepare(space);
    const port = await freePort();
    const started = cli(root, "up", "--server", `nats://127.0.0.1:${port}`, "--json");
    track(space);
    check(`${space}: up starts the stack`, started.status === 0, shown(started));
    const request = await killDownAt(root, space, "stack-broker");
    await until(() => gone(space, "stack-broker"), 10_000);
    check(`${space}: the killed down left the broker stopping under its request, with its process gone`, request !== undefined && serviceInstances(space, "stack-broker")[0]?.record.value.state === "stopping" && gone(space, "stack-broker"), { request });
    const status = cli(root, "status", "--space", space, "--json");
    const block = (status.env?.result?.folder as { stackBlock?: { definition?: string; reason?: string; route?: { kind?: string; requestId?: string } } | null } | undefined)?.stackBlock;
    check(`${space}: status names the broker as what keeps up and down from settling, with that request to abandon`, (status.status === 0 || status.status === 4) && block?.definition === "stack-broker" && block.route?.kind === "abandon" && block.route.requestId === request && Boolean(block.reason?.includes("process is gone")), { ...shown(status), block });
    const refused = cli(root, "down", "--yes", "--json");
    check(`${space}: the next down refuses and names the abandon command for that request`, refused.status === 2 && refused.env?.error?.code === "LIFECYCLE_BLOCKED" && Boolean(refused.env.error.remedy?.includes(`cotal down --abandon-stop ${request} --yes`)), shown(refused));
    const abandoned = cli(root, "down", "--abandon-stop", request ?? "none", "--yes", "--json");
    const warned = abandoned.env?.warnings?.find((warning) => warning.code === "STOP_ABANDONED");
    check(`${space}: down --abandon-stop records the broker failed with a warning`, abandoned.status === 0 && warned?.target?.requestId === request && serviceInstances(space, "stack-broker")[0]?.record.value.state === "failed", { ...shown(abandoned), warned });
    const restarted = cli(root, "up", "--json");
    track(space);
    const final = cli(root, "down", "--yes", "--json");
    check(`${space}: up then down cycle the stack`, restarted.status === 0 && final.status === 0 && gone(space, "stack-broker") && gone(space, "stack-manager"), { up: shown(restarted), down: shown(final) });
  }
  {
    const space = "killedmanager";
    const root = prepare(space);
    const port = await freePort();
    const started = cli(root, "up", "--server", `nats://127.0.0.1:${port}`, "--json");
    track(space);
    check(`${space}: up starts the stack`, started.status === 0, shown(started));
    const manager = serviceInstances(space, "stack-manager")[0], states = serviceInstanceStore(space).directory();
    const request = await killDownAt(root, space, "stack-manager");
    let published: boolean;
    try { published = manager !== undefined && states !== undefined && readServiceStopRequest({ space, instanceId: manager.name, launchRequestId: manager.record.value.launchRequestId, stateDirectory: states }) !== undefined; } catch { published = true; }
    check(`${space}: the killed down left the manager stopping with no request published`, request !== undefined && !published && serviceInstances(space, "stack-manager")[0]?.record.value.state === "stopping", { request, published });
    const marker = stopReservationPath(canonicalLocalProcessPath(MANAGER_PIDFILE, { root, space }));
    const stopped = cli(root, "down", "--yes", "--json");
    let reserved = true;
    try { lstatSync(marker); } catch { reserved = false; }
    check(`${space}: the next bare down stops the stack and releases that down's reservation`, stopped.status === 0 && gone(space, "stack-manager") && gone(space, "stack-broker") && !reserved, { ...shown(stopped), reserved });
    const restarted = cli(root, "up", "--json");
    track(space);
    const final = cli(root, "down", "--yes", "--json");
    check(`${space}: up then down cycle the stack`, restarted.status === 0 && final.status === 0 && gone(space, "stack-manager"), { up: shown(restarted), down: shown(final) });
  }

  // 10. A repeated down --with-agents.
  {
    const space = "repeatreap";
    const root = prepare(space);
    const port = await freePort();
    const started = cli(root, "up", "--server", `nats://127.0.0.1:${port}`, "--json");
    track(space);
    const reaped = cli(root, "down", "--with-agents", "--yes", "--json");
    const again = cli(root, "down", "--with-agents", "--yes", "--json");
    check(`${space}: a repeat of a completed down --with-agents is a no-op, exit 0`, started.status === 0 && reaped.status === 0 && again.status === 0 && again.env?.outcome === "no-op", { up: shown(started), first: shown(reaped), again: shown(again) });
    const restarted = cli(root, "up", "--json");
    track(space);
    const spared = cli(root, "down", "--yes", "--json");
    const refused = cli(root, "down", "--with-agents", "--yes", "--json");
    check(`${space}: after a down without --with-agents it still refuses LIFECYCLE_BLOCKED`, restarted.status === 0 && spared.status === 0 && refused.status === 2 && refused.env?.error?.code === "LIFECYCLE_BLOCKED", { up: shown(restarted), down: shown(spared), refused: shown(refused) });
  }

  // 11. A first up whose broker cannot create the space's streams.
  {
    const space = "fewfiles";
    const root = prepare(space);
    const port = await freePort();
    const limited = spawnSync("/bin/sh", ["-c", 'ulimit -n 32 && exec "$@"', "sh", process.execPath, "--import", TSX_IMPORT, CLI, "up", "--server", `nats://127.0.0.1:${port}`, "--json"], { cwd: root, env, encoding: "utf8", timeout: 180_000 });
    let failed: Envelope | undefined;
    try { failed = JSON.parse(limited.stdout) as Envelope; } catch { failed = undefined; }
    track(space);
    check(`${space}: under ulimit -n 32 the up stops the broker it started, fails OPERATION_FAILED, exit 5, and names the open-file limit`,
      limited.status === 5 && failed?.error?.code === "OPERATION_FAILED" && /ran out of open files/.test(failed.error.message) && (failed.error.remedy ?? "").includes("ulimit -n") && gone(space, "stack-broker"),
      { status: limited.status, envelope: failed, stderr: limited.stderr.slice(-1500) });
    const recovered = cli(root, "up", "--json");
    track(space);
    const stopped = cli(root, "down", "--yes", "--json");
    check(`${space}: the next up under the normal limit starts the stack, and down stops it`, recovered.status === 0 && stopped.status === 0 && gone(space, "stack-broker"), { up: shown(recovered), down: shown(stopped) });
  }

  // 12. A down in a folder whose .cotal this account cannot write. Root bypasses the mode.
  if (process.getuid?.() !== 0) {
    const space = "readonly";
    const root = prepare(space);
    const port = await freePort();
    const started = cli(root, "up", "--server", `nats://127.0.0.1:${port}`, "--no-manager", "--json");
    track(space);
    const dir = join(root, ".cotal"), journal = readFileSync(join(dir, "stack-controller.json"), "utf8");
    chmodSync(dir, 0o500);
    let refused: Run;
    try { refused = cli(root, "down", "--yes", "--json"); }
    finally { chmodSync(dir, 0o700); }
    check(`${space}: down --yes with an unwritable .cotal refuses PERMISSION_DENIED, exit 2, naming it, and stops nothing`,
      started.status === 0 && refused.status === 2 && refused.env?.error?.code === "PERMISSION_DENIED" && (refused.env.error.message ?? "").includes(dir) &&
        (refused.env.error.remedy ?? "").includes(`chmod u+w ${dir}`) && !gone(space, "stack-broker") && readFileSync(join(dir, "stack-controller.json"), "utf8") === journal,
      { up: shown(started), down: shown(refused) });
    const stopped = cli(root, "down", "--yes", "--json");
    check(`${space}: once it is writable, down --yes stops the stack`, stopped.status === 0 && gone(space, "stack-broker"), shown(stopped));
  }

  // 13. An up interrupted before it registers the space leaves its broker running unregistered.
  {
    const space = "stranded";
    const root = prepare(space);
    const port = await freePort();
    const child = spawn(process.execPath, ["--import", TSX_IMPORT, CLI, "up", "--server", `nats://127.0.0.1:${port}`, "--json"], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
    let upErr = "";
    child.stderr!.on("data", (chunk: Buffer) => { upErr += chunk.toString(); });
    // Freeze the broker once its process is pinned, so the up is provably waiting on it when it dies.
    const pinned = await until(() => pidOf(space, "stack-broker") !== null, 120_000);
    const broker = pidOf(space, "stack-broker");
    if (broker !== null) process.kill(broker, "SIGSTOP");
    track(space);
    check("the up still waits on broker readiness when it is interrupted", pinned && child.exitCode === null, { pinned, exitCode: child.exitCode });
    child.kill("SIGINT");
    await exited(child);
    check("the interrupted up exits 130 naming its unregistered broker's pid and cotal down --yes", child.exitCode === 130 && upErr.includes(`its broker keeps running as pid ${broker}`) && upErr.includes("cotal down --yes"), { exitCode: child.exitCode, stderr: upErr.slice(-400) });
    if (broker !== null) process.kill(broker, "SIGCONT");
    check("the killed up left its broker running and the space unregistered", broker !== null && alive(broker) && findMesh(space) === undefined, { broker, registered: findMesh(space) !== undefined });
    const blocked = cli(root, "up", "--json");
    check("the next up refuses LIFECYCLE_BLOCKED naming the broker's pid and down --yes, and starts nothing",
      blocked.status === 2 && blocked.env?.error?.code === "LIFECYCLE_BLOCKED" && Boolean(blocked.env.error.message.includes(`pid ${broker}`)) && Boolean(blocked.env.error.remedy?.includes("cotal down --yes")) && pidOf(space, "stack-delivery") === null && broker !== null && alive(broker), shown(blocked));
    const stopped = cli(root, "down", "--yes", "--json");
    check("down --yes stops that broker", stopped.status === 0 && await until(() => broker === null || !alive(broker), 10_000), shown(stopped));
    const started = cli(root, "up", "--json");
    track(space);
    check("up then starts the whole stack", started.status === 0 && pidOf(space, "stack-manager") !== null, shown(started));
    // A frozen manager holds the down in its impact read, which holds the root's maintenance lock.
    const manager = pidOf(space, "stack-manager");
    if (manager !== null) process.kill(manager, "SIGSTOP");
    assertSmokeSandboxDown(anchors.get(root), ["down", "--yes"], { cwd: root, env });
    const stopping = spawn(process.execPath, ["--import", TSX_IMPORT, CLI, "down", "--yes"], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
    let downErr = "";
    stopping.stderr!.on("data", (chunk: Buffer) => { downErr += chunk.toString(); });
    // Node dies on a SIGINT that lands before a listener exists. The down installs its handler right
    // after it takes the lock, so this waits for a lock this down owns, and a margin, before signalling.
    const lockFile = join(root, ".cotal", "maintenance", "lock.json");
    const held = await until(() => { try { return JSON.parse(readFileSync(lockFile, "utf8")).owner?.pid === stopping.pid; } catch { return false; } }, 60_000);
    await sleep(200);
    stopping.kill("SIGINT");
    await exited(stopping);
    if (manager !== null) process.kill(manager, "SIGCONT");
    check("a down interrupted on a frozen manager exits 130 naming the members still running and cotal down --yes", held && stopping.exitCode === 130 && downErr.includes("broker, delivery, manager are still running") && downErr.includes("cotal down --yes"), { held, exitCode: stopping.exitCode, stderr: downErr.slice(-400) });
    const last = cli(root, "down", "--yes", "--json");
    check("and down --yes stops it", last.status === 0, shown(last));
  }

  // 14. An up stopped between recording its broker's launch and recording the child.
  for (const [signal, code] of [["SIGINT", 130], ["SIGHUP", 129], ["SIGKILL", null]] as const) {
    const space = `launch-${signal.slice(3).toLowerCase()}`;
    const root = prepare(space);
    // The smoke hold keeps the recorded launch from starting its child until the signal lands.
    const port = await freePort();
    const child = spawn(process.execPath, ["--import", TSX_IMPORT, CLI, "up", "--server", `nats://127.0.0.1:${port}`, "--no-manager", "--json"], { cwd: root, env: { ...env, COTAL_SMOKE_HOLD_AFTER_LAUNCH_RECORD: "1" }, stdio: ["ignore", "ignore", "pipe"] });
    let upErr = "";
    child.stderr!.on("data", (chunk: Buffer) => { upErr += chunk.toString(); });
    const broker = () => { try { return serviceInstances(space, "stack-broker")[0]; } catch { return undefined; } };
    const unpinned = await until(() => { const row = broker(); return row !== undefined && row.record.value.state === "starting" && row.record.value.process === undefined; }, 120_000);
    child.kill(signal);
    await exited(child);
    const row = broker();
    const record = { state: row?.record.value.state, process: row?.record.value.process ?? null, exitCode: child.exitCode, signal: child.signalCode, stderr: upErr.slice(-400) };
    if (code !== null) {
      check(`${signal} after the broker launch is recorded: up exits ${code} and records that launch failed, with no process`, unpinned && child.exitCode === code && row?.record.value.state === "failed" && row.record.value.process === undefined && upErr.includes("Interrupted before any member"), record);
      const settled = cli(root, "down", "--yes", "--json");
      check(`${signal}: down --yes settles the earlier up`, settled.status === 0 && Boolean(settled.env?.warnings?.some((warning) => warning.code === "OPERATION_SETTLED")), shown(settled));
    } else {
      check("a kill after the broker launch is recorded leaves a broker record that names no process", unpinned && child.signalCode === "SIGKILL" && row !== undefined && observeServiceProcess(row.record.value) === "unresolved-launch", record);
      const instance = row?.name ?? "none";
      const refused = cli(root, "down", "--yes", "--json");
      check("down --yes refuses LIFECYCLE_BLOCKED, exit 2, naming down --abandon-launch for that instance", refused.status === 2 && refused.env?.error?.code === "LIFECYCLE_BLOCKED" && Boolean(refused.env.error.remedy?.includes(`cotal down --abandon-launch ${instance} --yes`)), shown(refused));
      const unacknowledged = cli(root, "down", "--abandon-launch", instance, "--json");
      check("down --abandon-launch without --yes is a usage error, exit 1, and records nothing", unacknowledged.status === 1 && unacknowledged.env?.error?.code === "USAGE_INVALID" && broker()?.record.value.state === "starting", shown(unacknowledged));
      const another = cli(root, "down", "--abandon-launch", randomUUID(), "--yes", "--json");
      check("down --abandon-launch naming another instance refuses TARGET_NOT_FOUND and records nothing", another.status === 2 && another.env?.error?.code === "TARGET_NOT_FOUND" && broker()?.record.value.state === "starting", shown(another));
      const abandoned = cli(root, "down", "--abandon-launch", instance, "--yes", "--json");
      check("down --abandon-launch records the broker failed with a LAUNCH_ABANDONED warning", abandoned.status === 0 && Boolean(abandoned.env?.warnings?.some((warning) => warning.code === "LAUNCH_ABANDONED" && warning.target?.instanceId === instance)) && broker()?.record.value.state === "failed", shown(abandoned));
    }
    const started = cli(root, "up", "--no-manager", "--json");
    track(space);
    check(`${signal}: up then starts the stack`, started.status === 0 && pidOf(space, "stack-delivery") !== null, shown(started));
    const last = cli(root, "down", "--yes", "--json");
    check(`${signal}: and down --yes stops it`, last.status === 0, shown(last));
  }
} finally {
  for (const root of roots) cli(root, "down", "--yes", "--json");
}
finish();
