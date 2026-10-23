/**
 * The manager service preset with a roster, and in the foreground. The first cells need no broker:
 * the adapter declaration, the roster path protection, the native child's launch argv and its
 * one-time roster parse. On Linux the live cell then saves the preset over a broker-only open stack,
 * runs `service start --foreground`, waits for the roster boot, sends SIGINT to the CLI alone and
 * requires exit 130 with the native stop recorded on the instance.
 *
 * Bare `cotal down` on that legacy root then stops the saved service through the service controller
 * before the broker: its dry run lists the running manager and changes nothing, an unreadable
 * service record refuses with the manager and broker still running, a real stop takes the manager
 * then the broker, and after a second `up` the stopped manager is skipped and its definition kept.
 *
 * Every directory is a sandbox this suite removes; `cotal down` stops the stack it started.
 *
 * Run: pnpm smoke:manager-preset:live
 */
import { spawn as spawnProc, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMOKE_BROKER_TOKEN, assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const WT = join(import.meta.dirname, "..", "..");
const TSX_LOADER = import.meta.resolve("tsx");
const BIN = join(WT, "bin", "cotal.ts");
const home = mkdtempSync(join(tmpdir(), "cotal-manager-preset-home-"));
const root = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}manager-preset-root-`));
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

    // ---- Bare down stops the space's services through the controller, then the stack ----------
    const start = cotal(["service", "start", "mgr", "--space", SPACE]);
    const live = serviceInstances(SPACE, "mgr")[0];
    const liveState = () => live ? serviceInstanceStore(SPACE).read(live.name)?.record.value.state : undefined;
    check("service start runs the saved manager in the background", start.status === 0 && liveState() === "running", out(start));
    const preview = cotal(["down", "--dry-run", "--json"]);
    let stops: { definition?: string; instanceId?: string; action?: string }[] = [];
    try { stops = (JSON.parse(preview.stdout) as { result?: { serviceStops?: typeof stops } }).result?.serviceStops ?? []; } catch { /* the cell reports the output */ }
    check("bare down --dry-run lists the running service it would stop and changes nothing",
      preview.status === 4 && stops.length === 1 && stops[0]?.definition === "mgr" && stops[0].instanceId === live?.name && stops[0].action === "stop"
        && liveState() === "running" && await isReachable(SERVER), out(preview));
    planted = join(serviceInstanceStore(SPACE).directory()!, `${spaceKey("planted")}.json`);
    writeFileSync(planted, "not a record\n", { mode: 0o600 });
    const blocked = cotal(["down"]);
    check("bare down refuses an unreadable service record with the service and the broker still running",
      blocked.status === 1 && out(blocked).includes("SCHEMA_INVALID") && out(blocked).includes(`cotal service list --space ${SPACE}`)
        && liveState() === "running" && await isReachable(SERVER), out(blocked));
    rmSync(planted);
    planted = undefined;
    const down = cotal(["down"]);
    const downOut = out(down);
    stackUp = down.status !== 0;
    check("bare down stops the running service through the controller, then the broker",
      down.status === 0 && liveState() === "stopped" && downOut.includes("Service stopped") && downOut.indexOf("Service stopped") < downOut.indexOf("✓ stopped nats-server")
        && !(await isReachable(SERVER)) && findMesh(SPACE) === undefined, downOut);
    check("  and keeps the saved definition", serviceDefinitionStore(SPACE).read("mgr") !== undefined);
    const again = cotal(["up", "--detach", "--open", "--no-manager", "--space", SPACE, "--server", SERVER]);
    stackUp = again.status === 0;
    check("the stack starts again with the stopped service saved", stackUp, out(again));
    const second = cotal(["down"]);
    stackUp = second.status !== 0;
    check("bare down skips the stopped service and stops the broker",
      second.status === 0 && out(second).includes("already stopped, skipped") && !out(second).includes("Service stopped")
        && !out(second).includes("Service was not running") && liveState() === "stopped"
        && serviceDefinitionStore(SPACE).read("mgr") !== undefined && !(await isReachable(SERVER)), out(second));
  }
} catch (e) {
  check(`suite ran without throwing: ${e instanceof Error ? e.message : String(e)}`, false, e instanceof Error ? e.stack : e);
} finally {
  for (const child of started) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  if (planted) rmSync(planted, { force: true });
  if (stackUp) {
    // Bare down stops the saved manager, if it still runs, then the stack recorded at this root; it
    // takes no --space.
    const down = cotal(["down"]);
    check("cotal down stops the sandboxed stack", down.status === 0, out(down));
  }
  for (const dir of [home, root]) rmSync(dir, { recursive: true, force: true });
  finish();
  process.exit(process.exitCode ?? 0);
}
