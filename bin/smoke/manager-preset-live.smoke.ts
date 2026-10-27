/**
 * The manager service preset with a roster, and in the foreground. The first cells need no broker:
 * the adapter declaration, the roster path protection, the native child's launch argv and its
 * one-time roster parse, and the private `.cotal` a launch makes in a registered root that has none,
 * which a refused launch does not make and a link standing there does not lose. On Linux the live
 * cell then saves the preset over a broker-only open stack,
 * runs `service start --foreground`, waits for the roster boot, sends SIGINT to the CLI alone and
 * requires exit 130 with the native stop recorded on the instance.
 *
 * Bare `cotal down` on that legacy root then refuses while the saved service runs: its dry run lists
 * the running manager, warns with the refusal and changes nothing, `down --preserve-state` and bare
 * `down` refuse and name the running manager and its stop, and an unreadable service record refuses
 * with the manager and broker still running. After the named `service stop`, bare `down` skips the
 * stopped manager, stops the broker and keeps its definition.
 *
 * Every directory is a sandbox this suite removes; teardown stops the manager if it still runs, then
 * `cotal down` stops the stack it started.
 *
 * Run: pnpm smoke:manager-preset:live
 */
import { spawn as spawnProc, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMOKE_BROKER_TOKEN, assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const WT = join(import.meta.dirname, "..", "..");
const TSX_LOADER = import.meta.resolve("tsx");
const BIN = join(WT, "bin", "cotal.ts");
const home = mkdtempSync(join(tmpdir(), "cotal-manager-preset-home-"));
const root = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}manager-preset-root-`));
// Two roots a registration names before any command wrote there: one with no `.cotal`, and one
// whose `.cotal` is a link to the main root's.
const fresh = mkdtempSync(join(tmpdir(), "cotal-manager-preset-fresh-"));
const linkedRoot = mkdtempSync(join(tmpdir(), "cotal-manager-preset-linked-"));
const xdg = join(home, "xdg");
for (const dir of [join(root, ".cotal"), xdg]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const anchor = recordSmokeSandbox({ root, cotalHome: join(home, ".cotal"), xdgConfigHome: xdg });
process.env.COTAL_HOME = join(home, ".cotal");
process.env.XDG_CONFIG_HOME = xdg;
const { isReachable, parseCommandArgs, registry } = await import("@cotal-ai/core");
type Command = import("@cotal-ai/core").Command;
type LocalProcess = import("@cotal-ai/workspace").LocalProcess;
const { findMesh, isCommandFailure, recordMesh, removeMesh, spaceKey, validateServiceAdapterPaths } = await import("@cotal-ai/workspace");
const { managerServiceChild } = await import("../../implementations/manager/src/service-child.js");
const { serviceInstanceStore, serviceInstances } = await import("../../implementations/cli/src/lib/service-instances.js");
const { serviceDefinitionStore } = await import("../../implementations/cli/src/lib/service-definitions.js");
await import("@cotal-ai/manager");

const { check, finish } = createSuite();
const skip = (what: string, why: string) => console.log(`  - SKIP ${what}: ${why}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const describe = (error: unknown) => isCommandFailure(error) ? `${error.code}: ${error.message}` : `thrown: ${String(error)}`;
/** The refusal a call throws, as `CODE: message`, or undefined when it returns. */
const refusal = (fn: () => unknown): string | undefined => {
  try { fn(); return undefined; }
  catch (error) { return describe(error); }
};
/** The refusal an async call rejects with, or undefined when it resolves. */
const rejection = async (fn: () => unknown): Promise<string | undefined> => {
  try { await fn(); return undefined; }
  catch (error) { return describe(error); }
};

const rosters = join(root, "rosters");
mkdirSync(rosters, { mode: 0o700 });
// One entry whose connector is not installed: its boot fails by name, which proves the manager read it.
const roster = join(rosters, "roster.yaml");
writeFileSync(roster, "agents:\n  - { name: ghost, agent: nosuchconnector }\n");
chmodSync(roster, 0o644);
const misspelt = join(rosters, "misspelt.yaml");
writeFileSync(misspelt, "agents:\n  - { name: ghost, agent: claude, share_tools: [] }\n");
chmodSync(misspelt, 0o644);
const loose = join(rosters, "loose.yaml");
writeFileSync(loose, "agents: []\n");
chmodSync(loose, 0o666);
const link = join(rosters, "link.yaml");
symlinkSync(roster, link);

// ---- The adapter declares the roster path and the foreground mode ------------------------------
const adapter = registry.all<LocalProcess>("local-process").find((row) => row.name === "manager-service");
const declaration = adapter?.service;
const properties = (declaration?.optionsSchema as { properties?: Record<string, { type?: string }> } | undefined)?.properties ?? {};
check("the manager adapter declares the foreground mode", declaration?.capabilities.foreground === true, declaration?.capabilities);
check("the manager adapter declares roster as a protected file option", declaration?.paths?.roster === "file" && properties.roster?.type === "string", declaration?.paths);

if (process.platform !== "linux" || !adapter || !declaration) skip("the roster path, launch and child cells", "the native manager child is Linux-only");
else {
  check("a protected absolute roster file is accepted", refusal(() => validateServiceAdapterPaths(declaration, { root, roster })) === undefined);
  const relative = refusal(() => validateServiceAdapterPaths(declaration, { root, roster: "roster.yaml" }));
  check("a relative roster path is refused", relative?.includes("absolute") === true, relative);
  const writable = refusal(() => validateServiceAdapterPaths(declaration, { root, roster: loose }));
  check("a roster others can write is refused", writable?.startsWith("PERMISSION_DENIED") === true, writable);
  const linked = refusal(() => validateServiceAdapterPaths(declaration, { root, roster: link }));
  check("a symlinked roster is refused as a link", linked?.startsWith("PERMISSION_DENIED") === true && linked.includes("crosses a symlink"), linked);
  const missing = refusal(() => validateServiceAdapterPaths(declaration, { root, roster: join(rosters, "missing.yaml") }));
  check("a missing roster is refused", missing?.startsWith("DEPENDENCY_UNAVAILABLE") === true, missing);

  // A registered offline space for the launch and child cells; it is forgotten before the live cell.
  const OFFLINE = "managerpresetoffline";
  const offlineServer = `nats://127.0.0.1:${await freePort()}`;
  recordMesh({ space: OFFLINE, server: offlineServer, root, mode: "open", ts: new Date().toISOString() });
  const stateDirectory = join(root, "state");
  mkdirSync(stateDirectory, { mode: 0o700 });
  const context = {
    space: OFFLINE, definition: "mgr", definitionRevision: "1", instanceId: randomUUID(), launchRequestId: randomUUID(), stateDirectory,
    cliInvocation: [process.execPath, BIN], options: { root, runtime: "pty", roster },
  };
  const built = await Promise.resolve().then(() => adapter.buildServiceLaunch!(context)).then((plan) => plan.args, describe);
  const args = typeof built === "string" ? [] : built;
  const at = args.indexOf("--roster");
  check("the launch passes the roster to the native child", args.includes("__service-manager") && at > 0 && args[at + 1] === roster, built);
  const resumed = await rejection(() => adapter.buildServiceLaunch!({ ...context, attempt: { kind: "maintenance-resume", attemptId: "resume1" } }));
  check("a resumed launch takes no roster", resumed?.includes("boots no roster") === true, resumed);

  const child = registry.resolve<Command>("command", "__service-manager");
  const childArgs = (extra: string[]) => parseCommandArgs(child, [
    "--root", root, "--space", OFFLINE, "--server", offlineServer, "--runtime", "pty",
    "--service-instance", randomUUID(), "--launch-request", randomUUID(), "--state-directory", stateDirectory, ...extra,
  ]);
  const parsed = (() => { try { return managerServiceChild(childArgs(["--roster", roster])).roster ?? []; } catch (error) { return describe(error); } })();
  check("the native child parses the roster once at validation",
    typeof parsed !== "string" && JSON.stringify(parsed.map((entry) => [entry.name, entry.agent])) === JSON.stringify([["ghost", "nosuchconnector"]]), parsed);
  const invalid = refusal(() => managerServiceChild(childArgs(["--roster", misspelt])));
  check("a roster with an unknown key is refused by name", invalid?.startsWith("SCHEMA_INVALID") === true && invalid.includes("share_tools is not a roster key"), invalid);
  const relativeChild = refusal(() => managerServiceChild(childArgs(["--roster", "roster.yaml"])));
  check("the native child refuses a relative roster", relativeChild?.startsWith("USAGE_INVALID") === true, relativeChild);
  const resumedChild = refusal(() => managerServiceChild(childArgs(["--roster", roster, "--resume-attempt", "resume1"])));
  check("the native child refuses a roster on a resumed launch", resumedChild?.startsWith("USAGE_INVALID") === true && resumedChild.includes("boots no roster"), resumedChild);
  removeMesh(OFFLINE);

  // A root that only `space add --root` registered has no `.cotal`. The launch makes it, private,
  // only after its refusals, and never replaces a link that stands there.
  const FRESH = "managerpresetfresh", LINKED = "managerpresetlinked";
  recordMesh({ space: FRESH, server: offlineServer, root: fresh, mode: "open", ts: new Date().toISOString() });
  recordMesh({ space: LINKED, server: offlineServer, root: linkedRoot, mode: "open", ts: new Date().toISOString() });
  const freshContext = { ...context, space: FRESH, instanceId: randomUUID(), launchRequestId: randomUUID(), options: { root: fresh, runtime: "pty" } };
  const refusedFresh = await rejection(() => adapter.buildServiceLaunch!({ ...freshContext, options: { ...freshContext.options, roster }, attempt: { kind: "maintenance-resume", attemptId: "resume1" } }));
  check("a refused launch in a root with no .cotal makes none", refusedFresh?.includes("boots no roster") === true && !existsSync(join(fresh, ".cotal")), refusedFresh);
  const freshBuilt = await rejection(() => adapter.buildServiceLaunch!(freshContext));
  const made = lstatSync(join(fresh, ".cotal"), { throwIfNoEntry: false });
  check("a launch in a registered root with no .cotal makes it, a directory private to you", freshBuilt === undefined && made?.isDirectory() === true && (made.mode & 0o777) === 0o700, { freshBuilt, mode: made?.mode.toString(8) });
  const freshArgs = (space: string, at: string) => parseCommandArgs(child, [
    "--root", at, "--space", space, "--server", offlineServer, "--runtime", "pty",
    "--service-instance", randomUUID(), "--launch-request", randomUUID(), "--state-directory", stateDirectory,
  ]);
  const freshChild = refusal(() => managerServiceChild(freshArgs(FRESH, fresh)));
  check("  and the native child then accepts that root", freshChild === undefined, freshChild);
  symlinkSync(join(root, ".cotal"), join(linkedRoot, ".cotal"));
  await rejection(() => adapter.buildServiceLaunch!({ ...freshContext, space: LINKED, options: { root: linkedRoot, runtime: "pty" } }));
  const linkedChild = refusal(() => managerServiceChild(freshArgs(LINKED, linkedRoot)));
  check("a root whose .cotal is a link keeps it, and the native child refuses it as a link",
    lstatSync(join(linkedRoot, ".cotal")).isSymbolicLink() && linkedChild?.startsWith("PERMISSION_DENIED") === true && linkedChild.includes("is a symbolic link"), linkedChild);
  removeMesh(FRESH);
  removeMesh(LINKED);
}

// ---- A foreground manager with a roster stops on SIGINT through its native stop ----------------
const SPACE = "managerpreset";
const SERVER = `nats://127.0.0.1:${await freePort()}`;
const env: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_") || key === "INVOCATION_ID") delete env[key];
Object.assign(env, { HOME: home, USERPROFILE: home, COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: xdg, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" });
function cotal(args: string[], timeout = 120_000) {
  const options = { cwd: root, env, encoding: "utf8" as const, timeout };
  assertSmokeSandboxDown(anchor, args, options);
  return spawnSync(process.execPath, ["--import", TSX_LOADER, BIN, ...args], options);
}
const out = (r: ReturnType<typeof cotal>) => `${r.stdout ?? ""}${r.stderr ?? ""}`;
const started: ChildProcess[] = [];
let stackUp = false;
/** An unreadable instance record a cell plants; teardown removes it so the final down can run. */
let planted: string | undefined;
/** The background manager instance; teardown stops it if it still runs, since bare down refuses then. */
let liveInstance: string | undefined;
try {
  if (process.platform !== "linux") skip("the foreground manager cell", "the native manager child is Linux-only");
  else {
    const up = cotal(["up", "--detach", "--open", "--no-manager", "--space", SPACE, "--server", SERVER]);
    stackUp = up.status === 0;
    check("a broker-only open stack starts", stackUp, out(up));
    const add = cotal(["service", "add", "mgr", "--preset", "manager", "--space", SPACE, "--root", root, "--runtime", "pty", "--roster", roster]);
    check("service add saves the manager preset with its roster", add.status === 0, out(add));
    const fg = spawnProc(process.execPath, ["--import", TSX_LOADER, BIN, "service", "start", "mgr", "--space", SPACE, "--foreground"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    started.push(fg);
    const exited = new Promise<number | null>((resolve) => fg.once("exit", (code) => resolve(code)));
    let text = "";
    fg.stdout.on("data", (chunk) => { text += chunk; });
    fg.stderr.on("data", (chunk) => { text += chunk; });
    const running = () => serviceInstances(SPACE, "mgr")[0]?.record.value.state === "running";
    for (let i = 0; i < 240 && fg.exitCode === null && !(running() && text.includes("✗ ghost: ")); i++) await sleep(500);
    check("the foreground manager reaches native readiness and stays in the foreground", running() && fg.exitCode === null, text.slice(-1500));
    check("the foreground manager boots the roster it was given", text.includes("✗ ghost: "), text.slice(-1500));
    fg.kill("SIGINT");
    const code = await Promise.race([exited, sleep(90_000).then(() => "timeout" as const)]);
    check("SIGINT to the CLI stops the foreground manager with exit 130", code === 130, { code, tail: text.slice(-1500) });
    const row = serviceInstances(SPACE, "mgr")[0]?.record.value;
    check("the instance records the native stop the manager returned", row?.state === "stopped" && row.nativeStop?.nativeStop === "returned", row);

    // ---- Bare down refuses while the space's service runs, and skips it once stopped -------------
    const start = cotal(["service", "start", "mgr", "--space", SPACE]);
    const live = serviceInstances(SPACE, "mgr")[0];
    liveInstance = live?.name;
    const liveState = () => live ? serviceInstanceStore(SPACE).read(live.name)?.record.value.state : undefined;
    check("service start runs the saved manager in the background", start.status === 0 && liveState() === "running", out(start));
    // The controller starts the preset's native child under the daemon node flag: it is among the
    // node flags before the entry script, which is what the child's own process.execArgv holds.
    const childPid = live ? serviceInstanceStore(SPACE).read(live.name)?.record.value.process?.pid : undefined;
    const childArgv = childPid ? readFileSync(`/proc/${childPid}/cmdline`, "utf8").split("\0").filter(Boolean) : [];
    const childEntry = childArgv.indexOf(BIN);
    check("the controller runs the manager preset under node --max-semi-space-size=1", childEntry > 0 && childArgv.slice(1, childEntry).includes("--max-semi-space-size=1"), childArgv);
    const stopCommand = `cotal service stop mgr --instance ${live?.name} --space ${SPACE} --yes`;
    const preview = cotal(["down", "--dry-run", "--json"]);
    let checks: { definition?: string; instanceId?: string; action?: string }[] = [], warnings: { code?: string; message?: string }[] = [];
    try {
      const doc = JSON.parse(preview.stdout) as { result?: { serviceChecks?: typeof checks }; warnings?: typeof warnings };
      checks = doc.result?.serviceChecks ?? []; warnings = doc.warnings ?? [];
    } catch { /* the cell reports the output */ }
    check("bare down --dry-run lists the running service, warns that the real stop would refuse, and changes nothing",
      preview.status === 4 && checks.length === 1 && checks[0]?.definition === "mgr" && checks[0].instanceId === live?.name && checks[0].action === "stop-first"
        && warnings.some((w) => w.code === "LIFECYCLE_BLOCKED" && w.message?.startsWith("the real stop would refuse: ") && w.message.includes(stopCommand))
        && liveState() === "running" && await isReachable(SERVER), out(preview));
    const preserve = cotal(["down", "--preserve-state"]);
    check("down --preserve-state refuses while the service runs, names it and its stop, and stops nothing",
      preserve.status === 2 && out(preserve).includes("LIFECYCLE_BLOCKED") && out(preserve).includes(`mgr instance ${live?.name}: running`)
        && out(preserve).includes(stopCommand)
        && liveState() === "running" && await isReachable(SERVER), out(preserve));
    planted = join(serviceInstanceStore(SPACE).directory()!, `${spaceKey("planted")}.json`);
    writeFileSync(planted, "not a record\n", { mode: 0o600 });
    const blocked = cotal(["down"]);
    check("bare down refuses an unreadable service record with the service and the broker still running",
      blocked.status === 1 && out(blocked).includes("SCHEMA_INVALID") && out(blocked).includes(`cotal service list --space ${SPACE}`)
        && liveState() === "running" && await isReachable(SERVER), out(blocked));
    rmSync(planted);
    planted = undefined;
    const refused = cotal(["down"]);
    check("bare down refuses while the service runs, names its stop then down, and stops nothing",
      refused.status === 2 && out(refused).includes("LIFECYCLE_BLOCKED") && out(refused).includes(`mgr instance ${live?.name}: running`)
        && out(refused).includes(`${stopCommand}, then run cotal down again`) && !out(refused).includes("Service stopped")
        && liveState() === "running" && await isReachable(SERVER) && findMesh(SPACE) !== undefined, out(refused));
    const stop = cotal(stopCommand.split(" ").slice(1));
    check("the stop the refusal names stops the service", stop.status === 0 && liveState() === "stopped", out(stop));
    const down = cotal(["down"]);
    stackUp = down.status !== 0;
    check("bare down skips the stopped service and stops the broker",
      down.status === 0 && !out(down).includes("Service stopped") && !out(down).includes("Service was not running") && liveState() === "stopped"
        && !(await isReachable(SERVER)) && findMesh(SPACE) === undefined, out(down));
    check("  and keeps the saved definition", serviceDefinitionStore(SPACE).read("mgr") !== undefined);
  }
} catch (e) {
  check(`suite ran without throwing: ${e instanceof Error ? e.message : String(e)}`, false, e instanceof Error ? e.stack : e);
} finally {
  for (const child of started) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  if (planted) rmSync(planted, { force: true });
  if (stackUp) {
    if (liveInstance && serviceInstanceStore(SPACE).read(liveInstance)?.record.value.state === "running") {
      const stop = cotal(["service", "stop", "mgr", "--instance", liveInstance, "--space", SPACE, "--yes"]);
      check("teardown stops the background manager", stop.status === 0, out(stop));
    }
    // Bare down stops the stack recorded at this root; it takes no --space.
    const down = cotal(["down"]);
    check("cotal down stops the sandboxed stack", down.status === 0, out(down));
  }
  for (const dir of [home, root, fresh, linkedRoot]) rmSync(dir, { recursive: true, force: true });
  finish();
  process.exit(process.exitCode ?? 0);
}
