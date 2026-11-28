/**
 * The manager service preset with a roster, and in the foreground. The first cells need no broker:
 * the adapter declaration, the roster path protection, the native child's launch argv and its
 * one-time roster parse, and the private `.cotal` a launch makes in a registered root that has none,
 * which a refused launch does not make and a link standing there does not lose. On Linux the live
 * cell then saves the preset over a broker-only open stack,
 * runs `service start --foreground`, waits for the roster boot, sends SIGINT to the CLI alone and
 * requires exit 130 with the native stop recorded on the instance. A corrupt seat-cap record then
 * fails the native child at boot: the line it logs last names the record and the one step that
 * clears it, the background refusal quotes that line and its log holds it, and a foreground start
 * prints that line on stderr after its Mesh heading and lifetime notice and says its output went
 * there. On an 80-column pty that line wraps at 80 columns, each continuation under the text.
 *
 * A start with `--idle-exit` records it on the instance and never in the saved definition, and with
 * no agents the manager stops itself: status shows the stop and the next start, and the log says why.
 * A later start without the flag runs with none. The flag is refused off start and on another service.
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
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SMOKE_BROKER_TOKEN, assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { clean, cotalPty } from "../../implementations/cli/smoke/_console-pty.js";

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
const { findMesh, identityRecord, isCommandFailure, MAX_IDLE_EXIT_SECONDS, publishServiceIdleExit, readServiceIdleExit, recordMesh, removeMesh, spaceKey, validateServiceAdapterPaths } = await import("@cotal-ai/workspace");
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
symlinkSync("roster.yaml", link);

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
  check("a symlinked roster is refused without link paths in the diagnostic message", linked?.startsWith("PERMISSION_DENIED") === true && linked.includes("crosses a symlink") && !linked.includes(link) && !linked.includes("roster.yaml"), linked);
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
  const idleBuilt = await Promise.resolve().then(() => adapter.buildServiceLaunch!({ ...context, managerIdleExit: 600 })).then((plan) => plan.args, describe);
  const idleArgs = typeof idleBuilt === "string" ? [] : idleBuilt;
  check("a start with --idle-exit passes it to the native child, and one without passes none", idleArgs[idleArgs.indexOf("--idle-exit") + 1] === "600" && !args.includes("--idle-exit"), idleBuilt);

  const child = registry.resolve<Command>("command", "__service-manager");
  const childArgs = (extra: string[]) => parseCommandArgs(child, [
    "--root", root, "--space", OFFLINE, "--server", offlineServer, "--runtime", "pty",
    "--service-instance", randomUUID(), "--launch-request", randomUUID(), "--state-directory", stateDirectory, ...extra,
  ]);
  const parsed = (() => { try { return managerServiceChild(childArgs(["--roster", roster])).roster ?? []; } catch (error) { return describe(error); } })();
  check("the native child parses the roster once at validation",
    typeof parsed !== "string" && JSON.stringify(parsed.map((entry) => [entry.name, entry.agent])) === JSON.stringify([["ghost", "nosuchconnector"]]), parsed);
  const idleChild = (() => { try { return managerServiceChild(childArgs(["--idle-exit", "600"])).idleExitSeconds; } catch (error) { return describe(error); } })();
  check("the native child reads its idle exit in seconds", idleChild === 600, idleChild);
  const badIdle = ["0", "1.5", "-1", String(MAX_IDLE_EXIT_SECONDS + 1)].map((value) => refusal(() => managerServiceChild(childArgs(["--idle-exit", value]))));
  check("the native child refuses an idle exit that is not a whole number of seconds in range", badIdle.every((r) => r?.startsWith("USAGE_INVALID") === true), badIdle);
  const receipt = { space: OFFLINE, instanceId: context.instanceId, launchRequestId: context.launchRequestId, stateDirectory };
  const self = identityRecord(process.pid) as { pid: number; token: string };
  publishServiceIdleExit(receipt, 600);
  check("an idle-exit receipt reads back for its own launch and process", readServiceIdleExit(receipt, self)?.idleSeconds === 600);
  check("  and is refused for another process, never read as this one's", refusal(() => readServiceIdleExit(receipt, { pid: self.pid, token: "0" }))?.startsWith("SCHEMA_INVALID") === true);
  check("  and a launch that left none reads as none", readServiceIdleExit({ ...receipt, launchRequestId: randomUUID() }, self) === undefined);
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
function launchPreview(space: string): void {
  for (const args of [["manager", "start", "--help"], ["help", "manager", "start"]]) {
    const help = cotal(args);
    check(`${args.join(" ")} lists the foreground and dry-run switches separately`, help.status === 0
      && /\[--foreground\]\s+\[--dry-run\]/.test(help.stdout), out(help));
  }
  const preview = ["manager", "start", "--space", space, "--dry-run", "--json"];
  const hostPreview = [...preview, "--console-port", "0"];
  const badHost = cotal([...hostPreview, "--console-host", "bad host"]);
  const hostError = JSON.parse(badHost.stdout).error;
  check("a fresh manager preview refuses an invalid --console-host and gives a replacement",
    badHost.status === 1 && hostError?.code === "USAGE_INVALID" && hostError.message.includes("--console-host")
      && hostError.remedy?.includes("`--console-host 127.0.0.1`")
      && !serviceDefinitionStore(space).read("manager") && !serviceInstances(space, "manager").length, out(badHost));
  const hostRetry = cotal([...hostPreview, "--console-host", "127.0.0.1"]);
  const hostResult = JSON.parse(hostRetry.stdout).result;
  check("the replacement host previews the same start without saving or allocating",
    hostRetry.status === 0 && hostResult?.dryRun === true && hostResult.saved === false && hostResult.allocated === false
      && !serviceDefinitionStore(space).read("manager") && !serviceInstances(space, "manager").length, out(hostRetry));
  const args = [...preview, "--foreground"];
  const launch = join(root, "absent-launch.json");
  const spec = JSON.stringify({ apiVersion: "cotal-launch/v1", space, runId: "preview", agents: [] });
  const digest = createHash("sha256").update(spec).digest("hex");
  for (const [supplied, required] of [[["--launch", launch], "--launch-sha256"], [["--launch-sha256", digest], "--launch"]] as const) {
    const run = cotal([...args, ...supplied]);
    const { error } = JSON.parse(run.stdout);
    check(`manager preview with only ${supplied[0]} names ${required} before checking the file`,
      run.status === 1 && error?.code === "USAGE_INVALID" && error.message.startsWith(`${supplied[0]} requires ${required} `), out(run));
  }
  const retryArgs = [...args, "--launch", launch, "--launch-sha256", digest];
  const missing = cotal(retryArgs);
  const { error } = JSON.parse(missing.stdout);
  check("manager preview names the missing launch specification and how to correct both flags",
    missing.status === 2 && error?.code === "TARGET_NOT_FOUND" && error.message.includes(`the --launch specification ${launch} does not exist`)
      && error.remedy?.includes("absolute path") && error.remedy.includes("matching SHA-256 in `--launch-sha256`")
      && error.remedy.includes("keeping all other arguments and flags unchanged"), out(missing));
  check("refused previews neither save the manager nor allocate an instance", !serviceDefinitionStore(space).read("manager") && !serviceInstances(space, "manager").length);
  writeFileSync(launch, spec, { mode: 0o600 });
  const retry = cotal([...retryArgs, "--console-host", "127.0.0.1"]);
  const { result } = JSON.parse(retry.stdout);
  check("the corrected launch preview succeeds without saving or starting a manager",
    retry.status === 0 && result?.dryRun === true && result.saved === false && result.allocated === false
      && !serviceDefinitionStore(space).read("manager") && !serviceInstances(space, "manager").length, out(retry));
  const status = cotal(["manager", "status", "--space", space, "--json"]);
  const receipt = JSON.parse(status.stdout);
  check("launch previews leave no manager history in the broker-only space", status.status === 2
    && receipt.error?.code === "TARGET_NOT_FOUND" && receipt.error.message.includes("no manager has been started"), out(status));
}
const ptyEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
function malformedRosterStart(space: string): void {
  const start = ["manager", "start", "--foreground", "--space", space, "--runtime", "pty", "--roster", misspelt];
  const untouched = () => !serviceDefinitionStore(space).read("manager") && !serviceInstances(space, "manager").length;
  const preview = cotal([...start, "--dry-run", "--json"]);
  const { result, warnings } = JSON.parse(preview.stdout);
  check("a malformed roster preview reports the invalid key and no planned save, without writing or allocating",
    preview.status === 0 && result?.definitionWouldBeSaved === false && result.allocated === false
      && warnings?.some((warning: { code: string; message: string }) => warning.code === "SCHEMA_INVALID" && warning.message.includes("share_tools is not a roster key"))
      && untouched(), out(preview));
  const attempt = cotal(start);
  check("a malformed roster start fails before saving a definition or launching the native child",
    attempt.status === 5 && out(attempt).includes("share_tools is not a roster key")
      && !out(attempt).includes("Foreground service lifetime") && untouched(), out(attempt));
  const show = cotal(["service", "show", "manager", "--space", space, "--json"]);
  check("service show still finds no definition after the malformed start", show.status === 2 && JSON.parse(show.stdout).error?.code === "TARGET_NOT_FOUND", out(show));
}

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
    launchPreview(SPACE);
    malformedRosterStart(SPACE);
    const manager = ["manager", "start", "--space", SPACE, "--json"];
    const stopManager = ["manager", "stop", "--space", SPACE, "--yes", "--with-agents"];
    const launch = join(root, "absent-launch.json");
    const digest = createHash("sha256").update(readFileSync(launch)).digest("hex");
    try {
      const initial = cotal([...manager, "--launch", launch, "--launch-sha256", digest]);
      check("a manager starts with the correct launch digest", initial.status === 0, out(initial));
      const stopped = cotal(stopManager);
      check("the manager stops before the override", stopped.status === 0, out(stopped));
      const definition = () => serviceDefinitionStore(SPACE).read("manager");
      const instances = () => serviceInstances(SPACE, "manager");
      const before = definition(), stoppedBefore = instances();
      const malformed = cotal([...manager, "--roster", misspelt]);
      check("a malformed roster override preserves the saved definition and stopped instance",
        malformed.status === 5 && JSON.parse(malformed.stdout).error?.message.includes("share_tools is not a roster key")
          && before !== undefined && stoppedBefore.length === 1
          && JSON.stringify(definition()?.record) === JSON.stringify(before.record)
          && JSON.stringify(instances().map((row) => row.record)) === JSON.stringify(stoppedBefore.map((row) => row.record)), out(malformed));
      const wrong = cotal([...manager, "--launch", launch, "--launch-sha256", "0".repeat(64)]);
      const { error } = JSON.parse(wrong.stdout);
      check("a mismatched digest refuses without replacing the definition or stopped instance",
        wrong.status === 2 && error?.code === "CONFLICT"
          && before !== undefined && stoppedBefore.length === 1 && stoppedBefore[0]?.record.value.state === "stopped"
          && JSON.stringify(definition()?.record) === JSON.stringify(before.record)
          && JSON.stringify(instances().map((row) => row.record)) === JSON.stringify(stoppedBefore.map((row) => row.record)), out(wrong));
      check("the digest refusal explains how to keep the saved launch or apply the override",
        error?.remedy?.includes("omit both `--launch` and `--launch-sha256`") === true
          && error.remedy.includes("matching SHA-256 in `--launch-sha256`"), out(wrong));
      const retry = cotal(manager);
      check("plain start still uses the saved launch digest and reaches readiness", retry.status === 0 && instances()[0]?.record.value.state === "running", out(retry));
    } finally {
      cotal(stopManager);
      cotal(["service", "remove", "manager", "--space", SPACE, "--yes"]);
    }
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

    // ---- A manager that fails at boot names its cause ---------------------------------------------
    const capRecord = join(root, ".cotal", `manager.${spaceKey(SPACE)}.seat-cap.json`);
    writeFileSync(capRecord, JSON.stringify({ version: 1, seatCap: 0 }), { mode: 0o600 });
    const supervise = cotal(["supervise", "--space", SPACE, "--server", SERVER, "--runtime", "pty"]);
    check("supervise names the invalid saved seat cap and how to recover",
      supervise.status === 1 && supervise.stderr.includes(`✗ the manager seat-cap record ${capRecord} holds neither a positive integer nor "unlimited"\n  Next: remove or repair that record, then start the manager again`), out(supervise));

    // The controller does not read the recorded seat cap, so a corrupt record fails the native child
    // inside its own startup, with a classified failure that wraps the record's refusal.
    writeFileSync(capRecord, "not a record\n", { mode: 0o600 });
    // The line names the record and ends in the one step that clears it.
    const cause = `✗ the manager did not start: OPERATION_UNKNOWN: the native manager child did not confirm startup; cause: SCHEMA_INVALID: the manager seat-cap record ${capRecord} is not valid JSON; next: remove or repair that record, then start the manager again\n`;
    const failed = cotal(["service", "start", "mgr", "--space", SPACE]);
    check("a manager that fails at boot logs its cause and next step last, and the refusal quotes it",
      failed.status === 5 && out(failed).includes(`exited before readiness was established (exit code 3, signal none); the last line it logged is: ${cause}`), out(failed));
    const failedId = /cotal service logs mgr --instance (\S+) --space /.exec(out(failed))?.[1];
    const failedLog = cotal(["service", "logs", "mgr", "--instance", failedId ?? "none", "--space", SPACE]);
    check("  and the log the refusal names holds that line", failedLog.status === 0 && out(failedLog).includes(cause), out(failedLog));
    const fgFailed = cotal(["service", "start", "mgr", "--space", SPACE, "--foreground"]);
    check("a foreground manager that fails at boot prints its cause here, and the refusal says its output went here, not to its log",
      fgFailed.status === 5 && fgFailed.stderr.includes(cause)
        && out(fgFailed).includes("exited before readiness was established (exit code 3, signal none); its output went to this terminal and was not captured in its log")
        && !out(fgFailed).includes("its log records the cause") && !out(fgFailed).includes("cotal service logs"), out(fgFailed));
    // The parent's Mesh header and lifetime notice come before the child starts, on the stream its line and the refusal use.
    const order = [`Mesh: ${SPACE}\n`, "Foreground service lifetime", cause, `Mesh: ${SPACE}\n`, "exited before readiness was established"]
      .reduce<number[]>((at, text) => [...at, fgFailed.stderr.indexOf(text, (at.at(-1) ?? -1) + 1)], []);
    check("  and its stderr reads the Mesh header and lifetime notice, then the child's line, then the refusal",
      order.every((at) => at >= 0), fgFailed.stderr);
    // On a terminal the child wraps that line as the CLI wraps its own: at the terminal's width, each
    // continuation under the text, a word wider than the line kept whole.
    const tty = cotalPty(["service", "start", "mgr", "--space", SPACE, "--foreground"], { cwd: root, env: { ...ptyEnv, LC_ALL: "C.UTF-8" }, cols: 80, rows: 40 });
    let screen = "";
    tty.onData((data) => { screen += data; });
    const ttyCode = await Promise.race([new Promise<number>((resolve) => tty.onExit((e) => resolve(e.exitCode))), sleep(120_000).then(() => { tty.kill(); return "timeout" as const; })]);
    const shown = clean(screen).replace(/\r/g, "").split("\n");
    const first = shown.findIndex((line) => line.startsWith("✗ the manager did not start: "));
    const end = shown.findIndex((line, i) => i > first && !line.startsWith("  "));
    const wrapped = first < 0 ? [] : shown.slice(first, end < 0 ? undefined : end);
    check("on an 80-column terminal a foreground manager's line wraps at 80 columns, each continuation under the text",
      ttyCode === 5 && wrapped.length > 1 && wrapped.every((line) => line.length <= 80 || !line.trim().includes(" ")) && wrapped.slice(1).every((line) => /^ {2}\S/.test(line))
        && wrapped.map((line) => line.trim()).join(" ") === cause.trim(), { ttyCode, screen: clean(screen) });
    rmSync(capRecord);

    // ---- --idle-exit applies to one start: the manager stops itself once it holds no agents --------
    const misplaced = cotal(["service", "stop", "mgr", "--space", SPACE, "--idle-exit", "5", "--yes"]);
    check("--idle-exit on anything but start is a usage refusal", misplaced.status !== 0 && out(misplaced).includes("--idle-exit belongs to start"), out(misplaced));
    const other = cotal(["service", "add", "idleother", "--exec", "sleep 30", "--space", SPACE]);
    const otherStart = cotal(["service", "start", "idleother", "--space", SPACE, "--idle-exit", "5"]);
    check("--idle-exit on another service is refused before anything launches",
      other.status === 0 && otherStart.status !== 0 && out(otherStart).includes("--idle-exit belongs to the manager") && serviceInstances(SPACE, "idleother").length === 0, out(otherStart));
    cotal(["service", "remove", "idleother", "--space", SPACE, "--yes"]);
    const idle = cotal(["service", "start", "mgr", "--space", SPACE, "--idle-exit", "2"]);
    const idleRow = serviceInstances(SPACE, "mgr")[0]?.record.value;
    const saved = serviceDefinitionStore(SPACE).read("mgr")?.record.value.launch;
    check("a start with --idle-exit records it on the instance only, never in the saved definition",
      idle.status === 0 && idleRow?.managerIdleExit === 2 && saved?.type === "adapter" && !("idle-exit" in saved.options), { out: out(idle), saved });
    check("  and its status shows it", out(idle).includes("after 2 s with no agents"), out(idle));
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 60 && idleRow?.process && alive(idleRow.process.pid); i++) await sleep(500);
    const idleStatus = cotal(["service", "status", "mgr", "--space", SPACE]);
    check("a manager that holds no agents stops itself, and status says so and names the next start",
      idleStatus.status === 0 && /Stopped:\s+by itself at \S+, after 2 s with no agents/.test(out(idleStatus)) && out(idleStatus).includes(`cotal service start mgr --space ${SPACE}`) && !out(idleStatus).includes("no recorded stop"), out(idleStatus));
    const idleLog = cotal(["service", "logs", "mgr", "--space", SPACE]);
    check("  and its log says why", out(idleLog).includes("manager: no agents for 2 s; stopping"), out(idleLog));
    const stopping = cotal(["service", "start", "mgr", "--space", SPACE, "--idle-exit", "600"]);
    const stoppedEarly = cotal(["service", "stop", "mgr", "--space", SPACE, "--yes"]);
    const stoppedStatus = cotal(["service", "status", "mgr", "--space", SPACE]);
    check("a manager stopped before its idle exit shows no idle exit row once stopped",
      stopping.status === 0 && out(stopping).includes("after 600 s with no agents") && stoppedEarly.status === 0 && !out(stoppedStatus).includes("Idle exit") && !out(stoppedStatus).includes("by itself"), out(stoppedStatus));

    // ---- Bare down refuses while the space's service runs, and skips it once stopped -------------
    // This start's manager reads spawn.env: a name set where it starts reaches it, while an
    // Object.prototype member, which a seat never gets, does not.
    const spawnConfig = join(xdg, "cotal", "config.json");
    mkdirSync(dirname(spawnConfig), { recursive: true, mode: 0o700 });
    writeFileSync(spawnConfig, JSON.stringify({ spawn: { env: ["SMOKE_SPAWN_PROBE", "constructor", "toString"] } }), { mode: 0o600 });
    env.SMOKE_SPAWN_PROBE = "1";
    const start = cotal(["service", "start", "mgr", "--space", SPACE]);
    delete env.SMOKE_SPAWN_PROBE;
    rmSync(spawnConfig);
    const live = serviceInstances(SPACE, "mgr")[0];
    liveInstance = live?.name;
    const liveState = () => live ? serviceInstanceStore(SPACE).read(live.name)?.record.value.state : undefined;
    check("service start runs the saved manager in the background", start.status === 0 && liveState() === "running", out(start));
    check("  and a start without --idle-exit after an idle exit runs with none", live?.record.value.managerIdleExit === undefined && !out(start).includes("Idle exit"), out(start));
    // The controller starts the preset's native child under the daemon node flag: it is among the
    // node flags before the entry script, which is what the child's own process.execArgv holds.
    const childPid = live ? serviceInstanceStore(SPACE).read(live.name)?.record.value.process?.pid : undefined;
    const childArgv = childPid ? readFileSync(`/proc/${childPid}/cmdline`, "utf8").split("\0").filter(Boolean) : [];
    const childEntry = childArgv.indexOf(BIN);
    check("the controller runs the manager preset under node --max-semi-space-size=1", childEntry > 0 && childArgv.slice(1, childEntry).includes("--max-semi-space-size=1"), childArgv);
    const childNames = childPid ? readFileSync(`/proc/${childPid}/environ`, "utf8").split("\0").map((entry) => entry.slice(0, entry.indexOf("="))) : [];
    check("the started manager gets a spawn.env name set where it starts, and no Object.prototype member it lists",
      childNames.includes("SMOKE_SPAWN_PROBE") && !childNames.some((name) => ["constructor", "toString"].includes(name)), childNames);
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
        && out(refused).includes(`\`${stopCommand}\`, then run \`cotal down\` again`) && !out(refused).includes("Service stopped")
        && liveState() === "running" && await isReachable(SERVER) && findMesh(SPACE) !== undefined, out(refused));
    const stop = cotal(stopCommand.split(" ").slice(1));
    check("the stop the refusal names stops the service", stop.status === 0 && liveState() === "stopped", out(stop));
    const down = cotal(["down", "--yes"]);
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
    const down = cotal(["down", "--yes"]);
    check("cotal down stops the sandboxed stack", down.status === 0, out(down));
  }
  for (const dir of [home, root, fresh, linkedRoot]) rmSync(dir, { recursive: true, force: true });
  finish();
  process.exit(process.exitCode ?? 0);
}
