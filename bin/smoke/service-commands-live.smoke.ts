/**
 * The manager and a person's own service with the short commands, over a real broker. A broker-only
 * open stack lists every built-in preset before any is added, each with the command that starts it.
 * `cotal manager start` with no flags saves the manager from its preset's defaults and starts it; a
 * second start starts nothing; `status` and `logs` read it; a start naming another runtime while it
 * runs refuses; `stop` stops it. A program of your own is added with one `service add --exec`, then
 * started, read and stopped by its name. Started from a shell that stays, as an app's agent does, it
 * outlives that shell: with no systemd user manager it leads a session and process group of its own,
 * so the group signal an app sends its agent misses it, and with one it runs in a user scope of its
 * own, so stopping the scope it was started from leaves it running. A retry under the IDs of an
 * attempt whose leftover descendant still holds that attempt's scope gets a scope of its own. In a
 * sandbox of its own, the manager a plain `cotal up`
 * starts has no saved service: `manager logs` and `service logs stack-manager` read its log, a
 * `--follow --json` writes one record per line and ends when `cotal down` stops it, a plain `--follow`
 * ends with a sentence instead of a JSON line, and `manager stop` and `install --dry-run` still refuse
 * it with the stack advice. After that `down`, `manager logs` reads the log it left, marked stopped
 * with `cotal up` next, and `install --dry-run` names the `ExecStart=` line. A plain follow of your
 * own service ends with a sentence too. A broker saved with the broker preset and a --log-file, in a
 * space `space create` prepared, stops when its log file was moved away while it ran.
 * A controller stack refuses manager overrides with a broker-only alternative. When both the stack
 * manager and a stopped standalone manager are saved, an unpinned stop follows the live manager.
 *
 * Linux only: the native manager child is Linux-only. Every directory is a sandbox this suite
 * removes; teardown stops what still runs, then `cotal down` stops the stack it started.
 *
 * Run: pnpm smoke:service-commands:live
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { SMOKE_BROKER_TOKEN, assertSmokeSandboxDown, createSuite, freePort, killAndAwaitExit, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { readManagerSeatCap, spaceKey } from "@cotal-ai/workspace";
import { inOwnScope } from "../../implementations/cli/src/lib/service-scope.js";

const WT = join(import.meta.dirname, "..", "..");
const TSX_LOADER = import.meta.resolve("tsx");
const BIN = join(WT, "bin", "cotal.ts");
const home = mkdtempSync(join(tmpdir(), "cotal-service-commands-live-home-"));
const root = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}service-commands-root-`));
const xdg = join(home, "xdg");
for (const dir of [join(root, ".cotal"), join(home, ".cotal"), xdg]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const anchor = recordSmokeSandbox({ root, cotalHome: join(home, ".cotal"), xdgConfigHome: xdg });

const { check, finish } = createSuite();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SPACE = "servicecommandslive";
const SERVER = `nats://127.0.0.1:${await freePort()}`;
const env: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_") || key === "INVOCATION_ID") delete env[key];
Object.assign(env, { HOME: home, USERPROFILE: home, COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: xdg, COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", NO_COLOR: "1", COLUMNS: "200" });
function cotal(args: string[], timeout = 180_000, at = { root, env, anchor }) {
  const options = { cwd: at.root, env: at.env, encoding: "utf8" as const, timeout };
  assertSmokeSandboxDown(at.anchor, args, options);
  return spawnSync(process.execPath, ["--import", TSX_LOADER, BIN, ...args], options);
}
// The plain `cotal up` stack, with its own root and HOME so nothing the first stack saved reaches it.
const upHome = mkdtempSync(join(tmpdir(), "cotal-service-commands-live-uphome-"));
const upRoot = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}service-commands-uproot-`));
const upXdg = join(upHome, "xdg");
// The project folder is named after its space, so `down` keeps the space registered and a read after
// it still reaches this folder.
const UP_SPACE = "servicecommandsup";
const upProject = join(upRoot, UP_SPACE);
for (const dir of [join(upProject, ".cotal"), join(upHome, ".cotal"), upXdg]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const upAt = { root: upProject, env: { ...env, HOME: upHome, USERPROFILE: upHome, COTAL_HOME: join(upHome, ".cotal"), XDG_CONFIG_HOME: upXdg }, anchor: recordSmokeSandbox({ root: upProject, cotalHome: join(upHome, ".cotal"), xdgConfigHome: upXdg }) };
const UP_SERVER = `nats://127.0.0.1:${await freePort()}`;
// A space `space create` prepares and nothing starts, for a broker saved with the broker preset. Its
// configuration path carries the token, so the reaper can claim that broker.
const presetRoot = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}service-commands-presetbroker-`));
const PRESET_SPACE = "servicecommandspreset";
const upCotal = (args: string[]) => cotal(args, 180_000, upAt);
const out = (run: ReturnType<typeof cotal>) => `${run.stdout ?? ""}${run.stderr ?? ""}`;
async function checkForegroundManagerLog(): Promise<void> {
  const args = ["supervise", "--space", SPACE, "--server", SERVER, "--console-port", String(await freePort()), "--console-host", "127.0.0.1"];
  const manager = spawn(process.execPath, ["--import", TSX_LOADER, BIN, ...args], { cwd: root, env, stdio: "ignore" });
  try {
    const status = () => cotal(["manager", "status", "--space", SPACE, "--json"]);
    let running = status();
    for (let i = 0; i < 30 && running.status !== 0 && manager.exitCode === null; i++) {
      await sleep(250);
      running = status();
    }
    const observed = JSON.parse(running.stdout).result;
    check("a standalone foreground manager is running without a saved service",
      running.status === 0 && observed?.observedProcess === "running" && observed.recordedProcess?.savedService === false
        && observed.recordedProcess.pid === manager.pid, out(running));
    const tail = ["manager", "logs", "--space", SPACE, "--tail", "2"];
    const remedy = (cli: string) => `If you started the manager with \`${cli} supervise\`, read its output in the terminal where you started it.`;
    const json = cotal([...tail, "--json"]), report = JSON.parse(json.stdout);
    const path = join(realpathSync(root), ".cotal", `manager.${spaceKey(SPACE)}.log`);
    check("a missing foreground manager log keeps the JSON refusal and directs the user to its terminal",
      json.status === 2 && json.stderr === "" && report.outcome === "refused" && report.completeness === "not-checked"
        && report.result === null && report.target?.path === path && report.error?.code === "TARGET_NOT_FOUND"
        && report.error.remedy === remedy("cotal") && !existsSync(path), out(json));
    for (const flags of [[], ["--plain"]]) {
      const human = cotal([...tail, ...flags]);
      check(`the ${flags.length ? "plain" : "default"} refusal directs the user to the foreground manager terminal under Next`,
        human.status === 2 && human.stderr.includes("TARGET_NOT_FOUND") && human.stderr.includes("Next")
          && ["cotal", "pnpm cotal"].some((cli) => human.stderr.includes(remedy(cli))), out(human));
    }
    const after = status(), remaining = JSON.parse(after.stdout).result;
    check("reading a missing log leaves the same foreground manager running",
      after.status === 0 && remaining?.observedProcess === "running" && remaining.recordedProcess?.pid === manager.pid, out(after));
  } finally { await killAndAwaitExit(manager, "SIGTERM"); }
}

function checkRecordedManagerTail(path: string): void {
  const saved = `${path}.saved`;
  renameSync(path, saved);
  try {
    const commands = [["manager", "logs"], ["service", "logs", "stack-manager"]];
    const tail = (args: string[]) => upCotal([...args, "--space", UP_SPACE, "--tail", "2", "--json"]);
    for (const args of commands) {
      const run = tail(args), report = JSON.parse(run.stdout);
      check(`cotal ${args.join(" ")} refuses a missing log while the manager runs`,
        run.status === 2 && run.stderr === "" && report.outcome === "refused" && report.error?.code === "TARGET_NOT_FOUND"
          && report.completeness === "not-checked" && report.result === null && report.target?.path === path
          && report.error.message.includes(path) && !existsSync(path), out(run));
    }
    writeFileSync(path, "", { flag: "wx", mode: 0o600 });
    for (const args of commands) {
      const run = tail(args), report = JSON.parse(run.stdout);
      check(`cotal ${args.join(" ")} reads an existing empty log successfully`,
        run.status === 0 && run.stderr === "" && report.outcome === "ok" && report.completeness === "complete"
          && report.result?.path === path && Array.isArray(report.result.lines) && report.result.lines.length === 0, out(run));
    }
  } finally { renameSync(saved, path); }
}

function checkBlankServiceCwd(): void {
  const add = ["service", "add", "cwd-check", "--space", PRESET_SPACE, "--exec", "/bin/sleep 600"];
  const show = ["service", "show", "cwd-check", "--space", PRESET_SPACE, "--json"];
  const blank = cotal([...add, "--cwd", " ", "--json"]);
  const refusal = JSON.parse(blank.stdout);
  const plain = cotal([...add, "--cwd", " ", "--plain"]);
  const missing = cotal(show);
  check("blank --cwd refuses without saving and explains both retries in JSON and plain output",
    blank.status === 1 && refusal.error?.code === "USAGE_INVALID" && missing.status === 2
    && JSON.parse(missing.stdout).error?.code === "TARGET_NOT_FOUND" && plain.status === 1
    && [refusal.error.message, out(plain)].every((text) => text.includes("Omit --cwd to use the directory where you run the command") && text.includes("pass --cwd <dir> to use another directory")),
    { blank: out(blank), plain: out(plain), missing: out(missing) });
  const retry = cotal([...add, "--json"]);
  const saved = cotal(show);
  check("omitting --cwd saves the invoking directory without starting the service",
    retry.status === 0 && JSON.parse(retry.stdout).result?.started === false
    && saved.status === 0 && JSON.parse(saved.stdout).result?.launch?.cwd === realpathSync(root), { retry: out(retry), saved: out(saved) });
}

function checkBrokerForegroundPreview(): void {
  const start = ["service", "start", "b0", "--space", PRESET_SPACE, "--dry-run"];
  const foreground = cotal([...start, "--foreground", "--json"]);
  const refusal = JSON.parse(foreground.stdout);
  const plain = cotal([...start, "--foreground", "--plain"]);
  const retry = "Retry without --foreground, keeping --dry-run and the rest of the command unchanged.";
  check("the broker foreground preview names the flag to drop and preserves --dry-run in its guidance",
    foreground.status === 2 && refusal.error?.code === "UNSUPPORTED" && refusal.error.message.includes(retry)
    && !refusal.error.message.includes("--new-instance") && plain.status === 2 && out(plain).includes(retry),
    { foreground: out(foreground), plain: out(plain) });
  const preview = cotal([...start, "--json"]);
  const result = JSON.parse(preview.stdout).result;
  const status = cotal(["service", "status", "b0", "--space", PRESET_SPACE, "--plain"]);
  check("dropping --foreground previews the broker without loading it or starting an instance",
    preview.status === 0 && result?.kind === "service-operation-preview" && result.dryRun === true
    && result.allocated === false && result.providerCodeLoaded === false
    && status.status === 0 && /Recorded state:\s+not started/.test(out(status)), { preview: out(preview), status: out(status) });
}

function checkControllerBrokerRestart(controller: (args: string[]) => ReturnType<typeof cotal>, root: string, space: string): void {
  const restart = ["service", "restart", "stack-broker", "--space", space];
  const status = () => JSON.parse(controller(["service", "status", "stack-broker", "--space", space, "--json"]).stdout).result;
  const before = status();
  const preview = controller([...restart, "--dry-run", "--json"]);
  const receipt = JSON.parse(preview.stdout);
  const down = `down --dry-run --json --space ${space}`;
  check("a running controller broker restart preview suggests only the read-only stop preview",
    preview.status === 2 && preview.stderr === "" && receipt.outcome === "refused" && receipt.error?.code === "LIFECYCLE_BLOCKED"
    && receipt.error.remedy === `change to the project folder with \`cd '${root}'\`, then run \`cotal ${down}\`. This previews only the stop part of a restart.`, out(preview));
  const plain = controller([...restart, "--dry-run", "--plain"]);
  check("the controller broker restart preview preserves plain output",
    plain.status === 2 && ["cotal", "pnpm cotal"].some((cli) => out(plain).includes(`\`${cli} down --dry-run --plain --space ${space}\``)), out(plain));
  const inspected = controller(down.split(" "));
  const inspection = JSON.parse(inspected.stdout);
  check("the suggested whole-stack preview only inspects the same running broker",
    inspected.status === 0 && inspection.target?.space === space && inspection.result?.kind === "controller-stack-stop-preview"
    && inspection.result.signalled === false && inspection.result.members.some((member: { instanceId: string; process: string }) =>
      member.instanceId === before?.instanceId && member.process === "running"), out(inspected));
  const apply = controller([...restart, "--yes", "--json"]);
  const refusal = JSON.parse(apply.stdout);
  const after = status();
  check("an applied controller broker restart still names the stop and start and leaves the broker running",
    apply.status === 2 && refusal.error?.code === "LIFECYCLE_BLOCKED" && refusal.error.remedy?.includes("`cotal down`")
    && refusal.error.remedy.includes(`\`cotal up --root '${root}' --space ${space}\``)
    && after?.observedProcess === "running" && after.instanceId === before?.instanceId && after.pid === before?.pid, out(apply));
}

/** A plain `logs --follow` in `at`, read until it exits. */
function followText(args: string[], at = { root, env }) {
  const child = spawn(process.execPath, ["--import", TSX_LOADER, BIN, ...args, "--follow"], { cwd: at.root, env: at.env, stdio: ["ignore", "pipe", "pipe"] });
  const view = { text: "", exit: new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code))), child };
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { view.text += chunk; });
  return view;
}
/** The last line a follow wrote. */
const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";
type Row = { name: string; preset: string | null; definition: string | null; state: string; needs: string[]; next: string };
/** `cotal service --json`: the services rows and the saved definition names. */
function inventory(): { services: Row[]; definitions: string[]; running: string[] } {
  const run = cotal(["service", "--json"]);
  try {
    const result = (JSON.parse(run.stdout) as { result: { services: Row[]; definitions: { name: string }[]; instances: { definition: string; observedProcess: string }[] } }).result;
    return { services: result.services, definitions: result.definitions.map((row) => row.name), running: result.instances.filter((row) => row.observedProcess === "running").map((row) => row.definition) };
  } catch { return { services: [], definitions: [out(run)], running: [] }; }
}
const row = (rows: readonly Row[], name: string) => rows.find((entry) => entry.name === name);

/** The process group, session and cgroup of `pid`. */
function processPlace(pid: number): { pgid: number; sid: number; cgroup: string } {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { pgid: Number(fields[2]), sid: Number(fields[3]), cgroup: readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().split(":").at(-1) ?? "" };
}
type Started = { pid: number; instanceId: string; launchRequestId: string };
/** Whether `outlive`'s recorded process still runs. */
function outliveRuns(service: Started | undefined): boolean {
  const status = cotal(["service", "status", "outlive", "--json"]);
  try { return service !== undefined && JSON.parse(status.stdout).result?.observedProcess === "running" && process.kill(service.pid, 0); }
  catch { return false; }
}
/** Run `service start outlive` from a shell that leads its own process group and stays after the
 *  start, as an app's agent does, inside the user scope `scope` when given. Resolves once it runs. */
async function startFromStarter(startEnv: NodeJS.ProcessEnv, scope?: string): Promise<{ starter: ChildProcess; service?: Started }> {
  const shell = ["/bin/sh", "-c", '"$@"; exec sleep 120', "starter", process.execPath, "--import", TSX_LOADER, BIN, "service", "start", "outlive"];
  const argv = scope ? ["systemd-run", "--user", "--scope", "--quiet", "--collect", `--unit=${scope}`, "--", ...shell] : shell;
  const starter = spawn(argv[0]!, argv.slice(1), { cwd: root, env: startEnv, detached: true, stdio: "ignore" });
  starters.push(starter);
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    try {
      const result = JSON.parse(cotal(["service", "status", "outlive", "--json"]).stdout).result;
      if (result?.recordedState === "running" && result.observedProcess === "running") return { starter, service: { pid: result.pid, instanceId: result.instanceId, launchRequestId: result.launchRequestId } };
    } catch { /* not recorded yet */ }
  }
  return { starter };
}
const starters: ChildProcess[] = [];
const STARTER_SCOPE = `cotal-smoke-starter-${process.pid}.scope`;
let outliveUp = false;
/** A background service outlives the app that started it. With no systemd user manager, as on macOS,
 *  it leads a session and process group of its own, which the group signal T3 Code sends an agent
 *  there does not reach. With one, it runs in a user scope of its own, which stopping the agent's
 *  scope, as T3 Code does on Linux, leaves running. */
async function checkServiceOutlivesStarter(): Promise<void> {
  const added = cotal(["service", "add", "outlive", "--exec", "/bin/sleep 600"]);
  check("service add outlive saves a program to start from an app's agent", added.status === 0, out(added));
  const unmanaged: NodeJS.ProcessEnv = { ...env };
  delete unmanaged.XDG_RUNTIME_DIR;
  const plain = await startFromStarter(unmanaged);
  outliveUp = plain.service !== undefined;
  const pid = plain.service?.pid, placed = pid === undefined ? undefined : processPlace(pid), starter = processPlace(plain.starter.pid!);
  check("with no user manager a background service leads a session and process group apart from its starter's, in no scope of its own",
    placed?.pgid === pid && placed?.sid === pid && placed?.pgid !== starter.pgid && placed?.sid !== starter.sid && placed?.cgroup.includes("/cotal-") === false, { placed, starter });
  try { process.kill(-plain.starter.pid!, "SIGTERM"); } catch { /* the starter already ended */ }
  await sleep(1500);
  check("  and the signal to the starter's process group does not reach it", outliveRuns(plain.service), plain.service);
  check("  and it stops", cotal(["service", "stop", "outlive", "--yes"]).status === 0 && !outliveRuns(plain.service));
  const answers = spawnSync("systemctl", ["--user", "show", "--property=Version", "--value"], { env, encoding: "utf8" });
  if (!env.XDG_RUNTIME_DIR || answers.status !== 0 || !answers.stdout.trim()) console.log("  - SKIP the scope cells: no systemd user manager answers here");
  else {
    const scoped = await startFromStarter(env, STARTER_SCOPE);
    outliveUp = scoped.service !== undefined;
    const own = scoped.service && { ...scoped.service, ...processPlace(scoped.service.pid) };
    check("with a user manager it runs in a user scope of its own, named for its space, instance and launch",
      own !== undefined && /\/cotal-[0-9a-f]{12}-/.test(own.cgroup) && new RegExp(`-${own.instanceId}-${own.launchRequestId}-[0-9a-f]{8}\\.scope$`).test(own.cgroup), { own, starter: STARTER_SCOPE });
    spawnSync("systemctl", ["--user", "stop", STARTER_SCOPE]);
    await sleep(1500);
    check("  and stopping the scope it was started from leaves it running", outliveRuns(scoped.service), scoped.service);
    check("  and it stops", cotal(["service", "stop", "outlive", "--yes"]).status === 0 && !outliveRuns(scoped.service));
  }
  outliveUp = false;
  check("  and its definition is removed", cotal(["service", "remove", "outlive", "--yes"]).status === 0);
  if (env.XDG_RUNTIME_DIR && answers.status === 0 && answers.stdout.trim()) checkRetryScope();
}

/** The scope unit named in a launch `inOwnScope` wrapped. */
const unitOf = (launch: { args: readonly string[] }) => launch.args.find((arg) => arg.startsWith("--unit="))?.slice("--unit=".length) ?? "";
const retryScopes: string[] = [];
/** A retry under the IDs a journal already names, after an attempt that failed but left a
 *  descendant of its own running, as one that called setsid does: that descendant keeps the earlier
 *  scope loaded, and the retry still gets a scope of its own. */
function checkRetryScope(): void {
  const ids = { space: "scope-retry", instanceId: randomUUID(), launchRequestId: randomUUID() };
  const first = inOwnScope({ program: "/bin/sh", args: ["-c", "setsid sleep 60 </dev/null >/dev/null 2>&1 & exit 1"], cwd: root }, env, ids);
  retryScopes.push(unitOf(first));
  const failed = spawnSync(first.program, [...first.args], { cwd: first.cwd, env, encoding: "utf8" });
  const held = spawnSync("systemctl", ["--user", "show", "--property=ActiveState", "--value", unitOf(first)], { env, encoding: "utf8" }).stdout.trim();
  check("an attempt that exits and leaves a descendant keeps its scope loaded", failed.status === 1 && held === "active", { status: failed.status, held, unit: unitOf(first) });
  const retry = inOwnScope({ program: "/bin/true", args: [], cwd: root }, env, ids);
  retryScopes.push(unitOf(retry));
  const again = spawnSync(retry.program, [...retry.args], { cwd: retry.cwd, env, encoding: "utf8" });
  check("  and a retry under its instance and launch IDs starts in a scope of its own, named for the same IDs",
    again.status === 0 && unitOf(retry) !== unitOf(first) && [first, retry].every((launch) => unitOf(launch).includes(`-${ids.instanceId}-${ids.launchRequestId}-`)), { status: again.status, stderr: again.stderr.trim(), first: unitOf(first), retry: unitOf(retry) });
  spawnSync("systemctl", ["--user", "stop", ...retryScopes], { env, stdio: "ignore" });
}

let stackUp = false;
let managerUp = false;
let helloUp = false;
let upStackUp = false;
let presetBrokerUp = false;
let customBrokerUp = false;
let controllerAt: Parameters<typeof cotal>[2] | undefined;

// #7346: the note a preset start prints when it saves a definition names the space the caller named
// with --space. The spaces below are open, and the preset that saves at start here (web) needs a
// static-auth space's web.creds, so the note is read from its renderer.
const { announcePresetTarget } = await import("../../implementations/cli/src/commands/service-registry.js");
const presetNote = (named: boolean): string => {
  let text = "";
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { text += String(chunk); return true; }) as typeof process.stderr.write;
  try { announcePresetTarget({ requested: "web", name: "web", preset: "web", saved: { kind: "created", options: [] } }, "p2", "rich", named); }
  finally { process.stderr.write = write; }
  return text;
};
check("a preset start that named its space says `cotal service show web --space p2` reads it", presetNote(true).includes("`cotal service show web --space p2` reads it"), presetNote(true));
check("  and one that named no space keeps the bare show", presetNote(false).includes("`cotal service show web` reads it"), presetNote(false));

try {
  if (process.platform !== "linux") console.log("  - SKIP every cell: the native manager child is Linux-only");
  else {
    const up = cotal(["up", "--detach", "--open", "--no-manager", "--space", SPACE, "--server", SERVER]);
    stackUp = up.status === 0;
    check("a broker-only open stack starts", stackUp, out(up));
    const brokerOnlyStatus = cotal(["manager", "status", "--space", SPACE, "--json"]);
    const brokerOnlyError = JSON.parse(brokerOnlyStatus.stdout).error;
    check("manager status suggests a manager-only start when the broker is running",
      brokerOnlyStatus.status === 2 && brokerOnlyError?.code === "TARGET_NOT_FOUND"
      && brokerOnlyError.remedy === `start it with \`cotal manager start --space ${SPACE}\``, out(brokerOnlyStatus));

    // ---- Every built-in preset is listed before it is added ------------------------------------
    const before = inventory();
    const manager = row(before.services, "manager"), intake = row(before.services, "feedback-intake"), endpoint = row(before.services, "exec-endpoint");
    check("cotal service lists the manager before it is added, with cotal manager start as its next step",
      manager?.preset === "manager" && manager.definition === null && manager.state === "not started" && manager.next === "cotal manager start", before.services);
    check("  and a preset that needs files with the flags that start it",
      intake?.state === "not started" && intake.next === "cotal service start feedback-intake --keys <file> --creds <file>", intake);
    check("  and a preset that runs many instances with the add that names one", endpoint?.next.startsWith("cotal service add <name> --preset exec-endpoint") === true, endpoint);
    check("  and nothing is saved by listing", before.definitions.length === 0, before.definitions);

    const preview = ["manager", "start", "--dry-run", "--new-instance"];
    const freshPreview = cotal(preview);
    check("a fresh manager preview refuses a new instance without saving a definition",
      freshPreview.status === 2 && out(freshPreview).includes("UNSUPPORTED") && !inventory().definitions.includes("manager"), out(freshPreview));
    await checkForegroundManagerLog();

    // ---- The manager: start, start again, status, logs, a conflicting start, stop ---------------
    const dry = cotal(["manager", "start", "--dry-run"]);
    check("cotal manager start --dry-run previews and saves nothing", dry.status === 0 && inventory().definitions.length === 0, out(dry));
    const wrongServer = `nats://127.0.0.1:${await freePort()}`;
    for (const [flag, value, code, message] of [
      ["--server", wrongServer, "CONFLICT", `registered at ${SERVER}, not ${wrongServer}`],
      ["--runtime", "definitely-unknown", "DEPENDENCY_UNAVAILABLE", 'unknown runtime "definitely-unknown"'],
    ] as const) {
      for (const mode of ["--dry-run", "--foreground"]) {
        const refused = cotal(["manager", "start", mode, flag, value, ...(mode === "--dry-run" ? ["--json"] : [])]);
        const records = inventory();
        check(`manager start ${mode} refuses ${flag} without saving or starting a manager`,
          refused.status === 2 && out(refused).includes(code) && out(refused).replaceAll('\\"', '"').includes(message) && records.definitions.length === 0 && records.running.length === 0, out(refused));
      }
    }
    const start = cotal(["manager", "start"]);
    managerUp = start.status === 0;
    check("cotal manager start with no flags saves the manager from its defaults and starts it",
      managerUp && out(start).includes(`saved manager in space ${SPACE} from the manager preset with its defaults`) && /Readiness observation:\s+endpoint-serving/.test(out(start)), out(start));
    const started = inventory();
    check("  and the listing shows it running, with cotal manager status next",
      row(started.services, "manager")?.state === "running" && row(started.services, "manager")?.next === "cotal manager status" && started.definitions.includes("manager"), started.services);
    const again = cotal(["manager", "start"]);
    check("a second cotal manager start starts nothing", again.status === 0 && out(again).includes("Already running; nothing was started") && inventory().running.filter((name) => name === "manager").length === 1, out(again));
    // #7642: a start that named its space suggests the logs and stop in that space.
    const named = cotal(["manager", "start", "--space", SPACE]);
    check("a cotal manager start with --space suggests cotal manager logs and stop with the same --space",
      named.status === 0 && new RegExp(`cotal manager logs --space ${SPACE}\\s+Read`).test(out(named)) && new RegExp(`cotal manager stop --space ${SPACE}\\s+Stop it`).test(out(named)), out(named));
    const status = cotal(["manager", "status"]);
    check("cotal manager status reads it", status.status === 0 && /Recorded state:\s+running/.test(out(status)), out(status));
    const logs = cotal(["manager", "logs", "--tail", "20"]);
    check("cotal manager logs reads its log", logs.status === 0 && out(logs).length > 0, out(logs));
    for (const [flag, value, code] of [["--runtime", "nosuchruntime", "DEPENDENCY_UNAVAILABLE"], ["--server", wrongServer, "CONFLICT"]] as const) {
      const invalid = cotal(["manager", "start", "--space", SPACE, "--dry-run", "--json", flag, value], 180_000, { root: home, env, anchor });
      check(`a running manager preview diagnoses invalid ${flag} without advising a stop`,
        invalid.status === 2 && JSON.parse(invalid.stdout).error?.code === code && !out(invalid).includes("manager stop"), out(invalid));
    }
    for (const preview of [true, false]) {
      const other = cotal(["manager", "start", "--max-sessions", "5", ...(preview ? ["--dry-run"] : []), "--json"]);
      const { error } = JSON.parse(other.stdout);
      check(`a running manager refuses changed settings and suggests a scoped ${preview ? "stop preview" : "stop"} in JSON`,
        other.status === 2 && error?.code === "LIFECYCLE_BLOCKED" && error.message.includes("manager is running with another --max-sessions")
        && error.remedy.includes(`\`cotal manager stop --space ${SPACE}${preview ? " --dry-run" : ""} --json\``)
        && inventory().running.filter((name) => name === "manager").length === 1, out(other));
    }

    // ---- A program of your own: add with --exec, start, status, logs, stop -----------------------
    const script = join(root, "hello.sh");
    writeFileSync(script, "#!/bin/sh\necho \"hello $1\"\nexec sleep 600\n");
    chmodSync(script, 0o700);
    const add = cotal(["service", "add", "hello", "--exec", `${script} 'big world'`]);
    check("service add hello --exec saves your program in one command", add.status === 0 && inventory().definitions.includes("hello"), out(add));
    const manual = cotal(["service", "start", "hello", "--no-open", "--dry-run", "--json"]);
    check("a saved non-dashboard service still refuses --no-open", manual.status === 1 && JSON.parse(manual.stdout).error?.code === "USAGE_INVALID", out(manual));
    const notStartedJson = cotal(["service", "status", "hello", "--json"]);
    const notStartedReceipt = JSON.parse(notStartedJson.stdout) as { outcome: string; completeness: string; result: { definition: string; instanceId: string | null; recordedState: string } | null };
    check("service status reports a saved service with no instance as not started in JSON",
      notStartedJson.status === 0 && notStartedReceipt.outcome === "ok" && notStartedReceipt.completeness === "complete" && notStartedReceipt.result?.definition === "hello" && notStartedReceipt.result.instanceId === null && notStartedReceipt.result.recordedState === "not started", out(notStartedJson));
    const notStartedText = cotal(["service", "status", "hello"]);
    const afterStatus = cotal(["service", "--json"]);
    const { instances } = (JSON.parse(afterStatus.stdout) as { result: { instances: { definition: string }[] } }).result;
    check("service status shows not started in text and leaves the service without an instance",
      notStartedText.status === 0 && /Recorded state:\s+not started/.test(notStartedText.stdout) && !instances.some((instance) => instance.definition === "hello"), { text: out(notStartedText), instances });
    const missingInstance = cotal(["service", "status", "hello", "--instance", "00000000-0000-4000-8000-000000000000", "--json"]);
    check("service status still refuses an explicitly named instance that does not exist",
      missingInstance.status === 2 && (JSON.parse(missingInstance.stdout) as { error?: { code: string } }).error?.code === "TARGET_NOT_FOUND", out(missingInstance));
    const helloStart = cotal(["service", "start", "hello"]);
    helloUp = helloStart.status === 0;
    check("service start hello starts it", helloUp && /Recorded state:\s+running/.test(out(helloStart)), out(helloStart));
    check("  and a start that named no space suggests the bare stop", /cotal service stop hello\s+Stop it/.test(out(helloStart)) && !/cotal service stop hello --space/.test(out(helloStart)), out(helloStart));
    const helloStatus = cotal(["service", "status", "hello"]);
    check("service status hello reads it", helloStatus.status === 0 && /Recorded state:\s+running/.test(out(helloStatus)), out(helloStatus));
    let helloLogs = cotal(["service", "logs", "hello"]);
    for (let i = 0; i < 20 && !out(helloLogs).includes("hello big world"); i++) { await sleep(500); helloLogs = cotal(["service", "logs", "hello"]); }
    check("service logs hello shows what it printed, with its quoted argument as one word", helloLogs.status === 0 && out(helloLogs).includes("hello big world"), out(helloLogs));
    const helloFollow = followText(["service", "logs", "hello"]);
    for (let i = 0; i < 40 && !helloFollow.text.includes("hello big world"); i++) await sleep(250);
    const helloStop = cotal(["service", "stop", "hello", "--yes"]);
    helloUp = helloStop.status !== 0;
    check("service stop hello stops it", helloStop.status === 0 && !inventory().running.includes("hello"), out(helloStop));
    const helloCode = await Promise.race([helloFollow.exit, sleep(15_000).then(() => "timeout" as const)]);
    if (helloCode === "timeout") helloFollow.child.kill("SIGINT");
    check("  and a plain service logs hello --follow ends with a sentence, not a raw end record",
      helloCode === 0 && lastLine(helloFollow.text) === "hello is no longer running, so the follow ended." && !/^end: /m.test(helloFollow.text), { helloCode, text: helloFollow.text });

    const helloLog = JSON.parse(cotal(["service", "logs", "hello", "--json"]).stdout) as { result: { path: string } };
    const helloPath = helloLog.result.path;
    const foregroundScript = join(root, "foreground.mjs");
    writeFileSync(foregroundScript, "process.on('SIGTERM', () => process.exit(0));\nsetInterval(() => {}, 1_000);\n");
    const foregroundAdd = cotal(["service", "add", "foreground", "--exec", `${process.execPath} ${foregroundScript}`]);
    check("the graceful foreground service is saved", foregroundAdd.status === 0, out(foregroundAdd));
    const foreground = spawn(process.execPath, ["--import", TSX_LOADER, BIN, "service", "start", "foreground", "--foreground"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let foregroundOutput = "";
    foreground.stdout.on("data", (chunk: Buffer) => { foregroundOutput += chunk.toString(); });
    foreground.stderr.on("data", (chunk: Buffer) => { foregroundOutput += chunk.toString(); });
    const foregroundExit = new Promise<number | null>((resolve, reject) => {
      foreground.once("error", reject);
      foreground.once("close", resolve);
    });
    try {
      for (const deadline = Date.now() + 60_000; !foregroundOutput.includes("Owned service process running") && foreground.exitCode === null && Date.now() < deadline;) await sleep(100);
      check("the direct service is running in the foreground", foregroundOutput.includes("Owned service process running"), foregroundOutput);
      const stopped = cotal(["service", "stop", "foreground", "--yes", "--json"]);
      const code = await Promise.race([foregroundExit, sleep(15_000).then(() => "timeout" as const)]);
      const status = cotal(["service", "status", "foreground", "--json"]);
      const result = JSON.parse(status.stdout).result;
      check("external stop and the foreground CLI both finish and keep the stop receipt and exit status",
        stopped.status === 0 && code === 0 && result?.recordedState === "stopped" && result.observedProcess === "gone" && result.exit?.code === 0 && result.processStop?.requestId === result.requestId && result.processStop?.signal === "SIGTERM", { stop: out(stopped), status: out(status), code, foregroundOutput });
    } finally {
      if (foreground.exitCode === null && foreground.signalCode === null) {
        foreground.kill("SIGTERM");
        await foregroundExit;
      }
    }
    writeFileSync(`${helloPath}.1`, "previous output\n");
    check("stopping a service keeps its current log and rotation", existsSync(helloPath) && existsSync(`${helloPath}.1`));
    const removedHello = cotal(["service", "remove", "hello", "--yes"]);
    check("removing the definition deletes its stopped instance's log and rotation",
      removedHello.status === 0 && !existsSync(helloPath) && !existsSync(`${helloPath}.1`) &&
        out(removedHello).includes("Deleted logs:") && out(removedHello).includes(helloPath), out(removedHello));
    await checkServiceOutlivesStarter();

    const refused = cotal(["manager", "stop", "--space", SPACE, "--with-agents", "--json"]);
    const refusal = JSON.parse(refused.stdout);
    const retryStop = /`([^`]+)`/.exec(refusal.error?.remedy ?? "")?.[1];
    const expectedStop = `cotal svc stop manager --space ${SPACE} --with-agents --yes --json`;
    check("manager stop confirmation keeps the selected space, agent policy, and JSON output",
      refused.status === 1 && refusal.outcome === "refused" && refusal.error?.code === "USAGE_INVALID" && retryStop === expectedStop && inventory().running.includes("manager"), out(refused));
    if (retryStop !== expectedStop) throw new Error(`unexpected manager stop confirmation: ${retryStop}`);
    const stop = cotal(retryStop.split(" ").slice(1));
    managerUp = stop.status !== 0;
    const stopReceipt = JSON.parse(stop.stdout);
    check("the confirmation command stops the same manager and returns a JSON receipt", stop.status === 0 &&
      stopReceipt.outcome === "ok" && stopReceipt.result?.kind === "service-stop" && stopReceipt.result.instanceId === refusal.target?.instanceId &&
      stopReceipt.result.recordedState === "stopped" && !inventory().running.includes("manager"), out(stop));
    const after = row(inventory().services, "manager");
    check("  and the listing shows it stopped, with cotal manager start next", after?.state === "stopped" && after.next === "cotal manager start", after);
    const savedPreview = cotal(preview);
    check("a saved manager preview refuses the same unsupported new instance", savedPreview.status === 2 && out(savedPreview).includes("UNSUPPORTED"), out(savedPreview));

    const showManager = () => cotal(["service", "show", "manager", "--space", SPACE, "--json"]);
    const stoppedManager = () => {
      const status = cotal(["manager", "status", "--space", SPACE, "--json"]);
      const { instanceId, revision, recordedState, pid } = JSON.parse(status.stdout).result ?? {};
      return { status: status.status, instanceId, revision, recordedState, pid };
    };
    const saved = showManager(), stoppedBefore = stoppedManager();
    const invalidHost = cotal(["manager", "start", "--space", SPACE, "--console-host", "127.0.0.1 junk", "--plain"]);
    check("an invalid console host is refused without saving a replacement",
      invalidHost.status === 1 && out(invalidHost).includes("USAGE_INVALID") && out(invalidHost).includes("--console-host contains whitespace or controls") && !out(invalidHost).includes("saved manager again"), out(invalidHost));
    const invalidName = cotal(["manager", "start", "--foreground", "--space", SPACE, "--name", "abcdefghijklmnopqrstuvwxyz", "--plain"]);
    check("an instance-shaped manager name is refused without saving a replacement",
      invalidName.status === 1 && out(invalidName).includes("USAGE_INVALID") && out(invalidName).includes("has the shape of an instance id") && !out(invalidName).includes("saved manager again"), out(invalidName));
    const kept = showManager(), stoppedAfter = stoppedManager();
    check("the refused overrides leave the definition and stopped instance unchanged",
      saved.status === 0 && kept.status === 0 && saved.stdout === kept.stdout
      && stoppedBefore.status === 0 && stoppedAfter.status === 0 && stoppedBefore.recordedState === "stopped"
      && typeof stoppedBefore.instanceId === "string" && typeof stoppedBefore.revision === "string" && JSON.stringify(stoppedBefore) === JSON.stringify(stoppedAfter),
      { saved: out(saved), kept: out(kept), before: stoppedBefore, after: stoppedAfter });
    const retry = cotal(["manager", "start", "--space", SPACE, "--plain"]);
    managerUp = retry.status === 0;
    check("a start without the refused override still starts the manager", managerUp && inventory().running.includes("manager"), out(retry));
    const stopRetry = cotal(["manager", "stop", "--space", SPACE, "--yes"]);
    managerUp = stopRetry.status !== 0;
    check("the manager started by the retry stops normally", !managerUp, out(stopRetry));

    const previous = stoppedManager();
    const brokerOnlyDown = cotal(["down", "--yes"]);
    const stackRestart = cotal(["up", "--detach", "--open", "--space", SPACE, "--server", SERVER]);
    const liveStatus = cotal(["manager", "status", "--json"]);
    const liveResult = JSON.parse(liveStatus.stdout).result;
    const live = liveResult?.recordedProcess;
    check("manager status reports the running stack manager over a stopped saved manager",
      previous.recordedState === "stopped" && typeof previous.pid === "number" && brokerOnlyDown.status === 0 && stackRestart.status === 0
      && liveStatus.status === 0 && live?.savedService === false && typeof live.pid === "number" && live.pid !== previous.pid,
      { previous, down: out(brokerOnlyDown), up: out(stackRestart), status: out(liveStatus) });
    check("manager status JSON reports the observed running state of the PID-only stack manager",
      liveStatus.status === 0 && liveResult?.kind === "service-status" && liveResult.observedProcess === "running", out(liveStatus));
    if (typeof previous.instanceId === "string") {
      const pinned = cotal(["manager", "status", "--instance", previous.instanceId, "--json"]);
      const owned = JSON.parse(pinned.stdout).result;
      check("a pin still reads the stopped owned manager rather than the running PID-only manager",
        pinned.status === 0 && owned?.instanceId === previous.instanceId && owned?.recordedState === "stopped", out(pinned));
    }

    // ---- The manager a plain cotal up starts: logs reads it, stop and install still refuse -------
    const plainUp = upCotal(["up", "--detach", "--open", "--space", UP_SPACE, "--server", UP_SERVER, "--seat-cap", "3"]);
    upStackUp = plainUp.status === 0;
    check("a plain cotal up starts a stack with its manager", upStackUp, out(plainUp));
    const unpinned = upCotal(["manager", "status", "--plain"]);
    check("unpinned manager status reports the running PID-only manager",
      unpinned.status === 0 && out(unpinned).includes("The manager is running") && /PID:\s+\d+/.test(out(unpinned)), out(unpinned));
    const missingId = "11111111-1111-4111-8111-111111111111";
    const missingInstanceMessage = "the full instance ID does not belong to this selected definition and space";
    const pinned = upCotal(["manager", "status", "--instance", missingId, "--plain"]);
    check("pinned manager status cannot select a PID-only manager",
      pinned.status === 2 && out(pinned).includes("TARGET_NOT_FOUND") && out(pinned).includes(missingInstanceMessage) && !out(pinned).includes("The manager is running"), out(pinned));
    for (const args of [["manager", "status"], ["service", "status", "manager"], ["manager", "logs"], ["service", "logs", "stack-manager"]]) {
      const run = upCotal([...args, "--instance", missingId, "--json"]);
      const report = JSON.parse(run.stdout);
      check(`cotal ${args.join(" ")} refuses an unowned pin in JSON`,
        run.status === 2 && report.outcome === "refused" && report.error?.code === "TARGET_NOT_FOUND"
        && report.error.message === missingInstanceMessage && report.target?.instanceId === missingId, out(run));
    }
    const isManagerLog = (path?: string): path is string => path !== undefined && dirname(path) === join(realpathSync(upProject), ".cotal") && /^manager\.[0-9a-f]+\.log$/.test(basename(path));
    let upLogs = upCotal(["manager", "logs"]);
    for (let i = 0; i < 30 && !out(upLogs).includes("manager up"); i++) { await sleep(500); upLogs = upCotal(["manager", "logs"]); }
    check("cotal manager logs reads the log of the manager up started, exit 0",
      upLogs.status === 0 && out(upLogs).includes("Manager log tail") && out(upLogs).includes("manager up") && !out(upLogs).includes("UNSUPPORTED"), out(upLogs));
    const cap = readManagerSeatCap({ root: upProject, space: UP_SPACE });
    check("the retained launcher records the cap after its manager starts", cap === 3, cap);
    type LogsEnvelope = { outcome?: string; result?: { kind?: string; lines?: string[]; path?: string; recordedProcess?: { savedService?: boolean; state?: string } } };
    const envelope = (run: ReturnType<typeof cotal>): LogsEnvelope => { try { return JSON.parse(run.stdout) as LogsEnvelope; } catch { return {}; } };
    const json = envelope(upCotal(["manager", "logs", "--json", "--tail", "5"]));
    check("  and --json returns its records from <root>/.cotal/manager.<spaceKey>.log, with no saved service",
      json.outcome === "ok" && json.result?.kind === "service-logs" && json.result.lines?.length === 5 && isManagerLog(json.result.path) && json.result.recordedProcess?.savedService === false, json);
    const stackManager = envelope(upCotal(["service", "logs", "stack-manager", "--json", "--tail", "5"]));
    check("  and cotal service logs stack-manager reads the same file", stackManager.outcome === "ok" && stackManager.result?.path === json.result?.path && stackManager.result?.lines?.length === 5, stackManager);
    if (isManagerLog(json.result?.path)) checkRecordedManagerTail(json.result.path);
    const refusedStop = envelope(upCotal(["manager", "stop", "--dry-run", "--json"])) as LogsEnvelope & { error?: { code?: string; remedy?: string } };
    check("cotal manager stop still refuses it UNSUPPORTED with the stack advice",
      refusedStop.outcome === "refused" && refusedStop.error?.code === "UNSUPPORTED" && refusedStop.error.remedy?.includes(`run \`cotal down --dry-run --space=${UP_SPACE} --json\` in ${realpathSync(upProject)}`) === true && !refusedStop.error.remedy.includes("`cotal down`"), refusedStop);
    const refusedInstall = envelope(upCotal(["manager", "install", "--dry-run", "--json"])) as LogsEnvelope & { error?: { code?: string; remedy?: string } };
    check("  and so does cotal manager install --dry-run while it runs, with the same advice",
      refusedInstall.outcome === "refused" && refusedInstall.error?.code === "UNSUPPORTED" && refusedInstall.error.remedy === refusedStop.error?.remedy, refusedInstall);
    for (const name of ["nats", "broker", "stack-broker"]) {
      const brokerSet = envelope(upCotal(["down", name, "delivery", "--dry-run", "--json"])) as LogsEnvelope & { error?: { code?: string; message?: string; remedy?: string } };
      check(`cotal down ${name} delivery refuses the whole set and names a preview in its project`,
        brokerSet.outcome === "refused" && brokerSet.error?.code === "TARGET_NOT_FOUND" && brokerSet.error.message === `${name} matches no service a set of names can stop in space ${UP_SPACE}; no service was stopped`
          && brokerSet.error.remedy === `a set of names never stops the broker; to preview stopping the whole stack, run \`cotal down --dry-run --space=${UP_SPACE} --json\` in ${realpathSync(upProject)}`, brokerSet);
    }

    // A follow is a read-only view: it writes one JSON record per line and ends when down stops the manager.
    const follow = spawn(process.execPath, ["--import", TSX_LOADER, BIN, "manager", "logs", "--follow", "--json", "--tail", "3"], { cwd: upProject, env: upAt.env, stdio: ["ignore", "pipe", "pipe"] });
    const textFollow = followText(["manager", "logs", "--tail", "3"], upAt);
    let followed = "";
    follow.stdout.setEncoding("utf8").on("data", (chunk: string) => { followed += chunk; });
    const followExit = new Promise<number | null>((resolve) => follow.on("exit", (code) => resolve(code)));
    for (let i = 0; i < 60 && !followed.includes('"type":"event"'); i++) await sleep(250);
    const down = upCotal(["down", "--yes"]);
    upStackUp = down.status !== 0;
    check("cotal down stops the plain stack while the follow reads its manager's log", down.status === 0, out(down));
    const code = await Promise.race([followExit, sleep(15_000).then(() => "timeout" as const)]);
    if (code === "timeout") follow.kill("SIGINT");
    const records = followed.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line) as { stream?: string; type?: string; data?: { reason?: string } }; } catch { return { type: `unparsed: ${line}` }; } });
    check("cotal manager logs --follow --json writes one logs record per line: a snapshot, its events, then an end",
      records.length >= 3 && records.every((row) => row.stream === "logs") && records[0]?.type === "snapshot" && records.some((row) => row.type === "event") && records.at(-1)?.type === "end", followed);
    check("  and it ends with exit 0 once that manager's process is gone", code === 0 && records.at(-1)?.data?.reason === "original-process-no-longer-present", { code, last: records.at(-1) });
    const textCode = await Promise.race([textFollow.exit, sleep(15_000).then(() => "timeout" as const)]);
    if (textCode === "timeout") textFollow.child.kill("SIGINT");
    check("a plain cotal manager logs --follow ends with a sentence, not a raw end record",
      textCode === 0 && lastLine(textFollow.text) === "manager is no longer running, so the follow ended." && !/^end: /m.test(textFollow.text), { textCode, text: textFollow.text });

    // ---- After down: the log it left, and install names the unit line ---------------------------
    const stoppedStatus = upCotal(["manager", "status", "--space", UP_SPACE, "--json"]);
    const report = JSON.parse(stoppedStatus.stdout);
    const stackStart = `cotal up --root ${realpathSync(upProject)} --space ${UP_SPACE}`;
    check("manager status after down reports the PID-only manager gone without changing the JSON shape",
      stoppedStatus.status === 0 && report.outcome === "ok" && report.result?.kind === "service-status" && report.result.observedProcess === "gone"
      && report.result.recordedProcess?.savedService === false && !Object.hasOwn(report.result, "next"), out(stoppedStatus));
    const stoppedPlain = upCotal(["manager", "status", "--space", UP_SPACE, "--plain"]);
    check("plain manager status says stopped and offers the stack start", stoppedPlain.status === 0
      && out(stoppedPlain).includes("The manager is stopped") && out(stoppedPlain).includes(stackStart), out(stoppedPlain));
    const stoppedLogs = upCotal(["manager", "logs", "--tail", "3"]);
    check("cotal manager logs after down reads the log it left, marked stopped, with cotal up next",
      stoppedLogs.status === 0 && out(stoppedLogs).includes("Manager log tail, from a stopped manager") && /State:\s+stopped/.test(out(stoppedLogs)) && /Next\s+cotal up\s/.test(out(stoppedLogs)), out(stoppedLogs));
    const stoppedJson = envelope(upCotal(["manager", "logs", "--json", "--tail", "3"]));
    check("  and --json carries recordedProcess in the stopped state, from the same file",
      stoppedJson.outcome === "ok" && stoppedJson.result?.recordedProcess?.state === "stopped" && stoppedJson.result.recordedProcess.savedService === false && stoppedJson.result.path === json.result?.path && stoppedJson.result.lines?.length === 3, stoppedJson);
    const stoppedInstall = envelope(upCotal(["manager", "install", "--dry-run", "--json"])) as LogsEnvelope & { error?: { code?: string; message?: string; remedy?: string } };
    check("cotal manager install --dry-run after down names the ExecStart= line of a unit of your own",
      stoppedInstall.outcome === "refused" && stoppedInstall.error?.code === "UNSUPPORTED" && Boolean(stoppedInstall.error.remedy?.includes(`manager start --foreground --space ${UP_SPACE} and KillMode=mixed`)) && Boolean(stoppedInstall.error.remedy?.includes("ExecStart=")), stoppedInstall);
    check("  and says the manager runs through the manager-service adapter, with no doubled service",
      Boolean(stoppedInstall.error?.message?.includes("manager runs through the manager-service adapter, whose stop is a native request")) && !stoppedInstall.error?.message?.includes("service service"), stoppedInstall.error?.message);

    // ---- With the log it left removed, the read says the log is gone ----------------------------
    const goneLog = stoppedJson.result?.path;
    if (isManagerLog(goneLog)) rmSync(goneLog);
    const gone = upCotal(["manager", "logs"]);
    const goneJson = envelope(upCotal(["manager", "logs", "--json"])) as LogsEnvelope & { target?: { path?: string }; error?: { code?: string; message?: string; remedy?: string } };
    const restart = `start the stack again with \`cotal up --root ${upProject} --space ${UP_SPACE}\``;
    check("cotal manager logs with that log removed says the log is gone and names only cotal up",
      goneJson.outcome === "refused" && goneJson.error?.code === "TARGET_NOT_FOUND" && goneJson.error.message === `the manager log at ${goneLog} is no longer there; nothing was read`
        && goneJson.error.remedy === restart && goneJson.target?.path === goneLog, goneJson);
    check("  and its text says so, with no cotal manager start and no claim that none was started",
      gone.status === 2 && out(gone).includes("is no longer there; nothing was read") && out(gone).trimEnd().endsWith(restart)
        && !out(gone).includes("cotal manager start") && !out(gone).includes("no manager has been started"), out(gone));

    // ---- A preset broker stops even when its log file was moved away -----------------------------
    const presetSpace = cotal(["space", "create", PRESET_SPACE, "--root", presetRoot]);
    check("space create prepares a space for a preset broker", presetSpace.status === 0, out(presetSpace));
    checkBlankServiceCwd();
    const neverStarted = cotal(["manager", "status", "--space", PRESET_SPACE, "--json"]);
    const neverStartedError = JSON.parse(neverStarted.stdout).error;
    check("manager status still distinguishes a space with no manager history", neverStarted.status === 2
      && neverStartedError?.code === "TARGET_NOT_FOUND" && neverStartedError.message.includes("no manager has been started")
      && neverStartedError.remedy === `start it with \`cotal up\` in ${realpathSync(presetRoot)}`, out(neverStarted));
    const neverStartedPlain = cotal(["manager", "status", "--space", PRESET_SPACE, "--plain"]);
    check("plain manager status also names the stack start in the prepared project",
      neverStartedPlain.status === 2 && ["cotal", "pnpm cotal"].some((cli) =>
        out(neverStartedPlain).includes(`start it with \`${cli} up\` in ${realpathSync(presetRoot)}`)), out(neverStartedPlain));
    const custom = cotal(["service", "add", "stack-broker", "--exec", "/bin/sleep 600", "--space", PRESET_SPACE]);
    check("a never-started space accepts a process service named stack-broker", custom.status === 0, out(custom));
    const foregroundStart = ["service", "start", "stack-broker", "--space", PRESET_SPACE, "--foreground", "--json"];
    for (const args of [["service", "start", "--help"], ["help", "service", "start"]]) {
      const help = cotal(args);
      check(`${args.join(" ")} lists the foreground and dry-run switches separately`, help.status === 0
        && /\[--foreground\]\s+\[--dry-run\]/.test(help.stdout), out(help));
    }
    const previewStart = cotal([...foregroundStart, "--dry-run"]);
    const previewReceipt = JSON.parse(previewStart.stdout);
    check("a foreground dry-run returns one JSON preview without allocating or signalling a process",
      previewStart.status === 0 && previewReceipt.outcome === "ok" && previewReceipt.result?.kind === "service-operation-preview"
        && previewReceipt.result.operation === "start" && previewReceipt.result.allocated === false && previewReceipt.result.signalled === false, out(previewStart));
    const refusedStart = cotal(foregroundStart);
    check("a live foreground start still refuses JSON", refusedStart.status === 1 && JSON.parse(refusedStart.stdout).error?.code === "USAGE_INVALID", out(refusedStart));
    const afterPreview = cotal(["service", "status", "stack-broker", "--space", PRESET_SPACE, "--json"]);
    check("the preview and refusal leave the service without an instance", afterPreview.status === 0 && JSON.parse(afterPreview.stdout).result?.instanceId === null, out(afterPreview));
    // #7642: an add that named its space suggests the start and show in that space.
    check("  and its Next starts and shows it with the same --space",
      new RegExp(`cotal svc start stack-broker --space ${PRESET_SPACE}\\s+Start it`).test(out(custom)) && new RegExp(`cotal svc show stack-broker --space ${PRESET_SPACE}\\s+Read`).test(out(custom)), out(custom));
    const customList = cotal(["service", "--space", PRESET_SPACE, "--json"]);
    const customRows = (JSON.parse(customList.stdout) as { result: { services: Row[] } }).result.services;
    check("that custom service's Next starts the service rather than a controller stack, in the space the list named", row(customRows, "stack-broker")?.next === `cotal service start stack-broker --space ${PRESET_SPACE}`, customRows);
    customBrokerUp = true;
    const customStart = cotal(["service", "start", "stack-broker", "--space", PRESET_SPACE]);
    check("a matching stack name does not refuse a direct-process start", customStart.status === 0 && /Recorded state:\s+running/.test(out(customStart)), out(customStart));
    // #7346: a start that named its space suggests a stop in that space, not in whatever a bare one selects.
    check("a start with --space suggests the stop with the same --space",
      new RegExp(`cotal service stop stack-broker --space ${PRESET_SPACE}\\s+Stop it`).test(out(customStart)), out(customStart));
    const customRestart = cotal(["service", "restart", "stack-broker", "--space", PRESET_SPACE, "--yes"]);
    check("a matching stack name does not refuse a direct-process restart", customRestart.status === 0, out(customRestart));
    const customStop = cotal(["service", "stop", "stack-broker", "--space", PRESET_SPACE, "--yes"]);
    customBrokerUp = customStop.status !== 0;
    check("the direct-process control stops through its own service record", customStop.status === 0, out(customStop));

    const controllerRoot = realpathSync(mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}service commands controller-`)));
    const controllerSpace = "servicecommandscontroller";
    const prepared = cotal(["space", "create", controllerSpace, "--root", controllerRoot]);
    check("a separate space is prepared for the real controller-member control", prepared.status === 0, out(prepared));
    controllerAt = { root: controllerRoot, env, anchor: recordSmokeSandbox({ root: controllerRoot, cotalHome: join(home, ".cotal"), xdgConfigHome: xdg }) };
    const controller = (args: string[]) => cotal(args, 180_000, controllerAt);
    const controllerServer = `nats://127.0.0.1:${await freePort()}`;
    const controllerUp = controller(["up", "--open", "--space", controllerSpace, "--server", controllerServer, "--seat-cap", "2", "--max-sessions", "3"]);
    check("the controller control starts its broker and manager", controllerUp.status === 0, out(controllerUp));
    checkControllerBrokerRestart(controller, controllerRoot, controllerSpace);
    const controllerDown = controller(["down", "--yes"]);
    check("the controller control stops its whole stack", controllerDown.status === 0, out(controllerDown));
    const brokerLog = controller(["service", "logs", "stack-broker", "--space", controllerSpace, "--tail", "5"]);
    check("the prepared stack's broker shutdown log is available through service logs",
      brokerLog.status === 0 && brokerLog.stdout.includes("Initiating JetStream Shutdown") &&
      brokerLog.stdout.includes("Server Exiting") && !existsSync(join(controllerRoot, ".cotal", "nats.log")), out(brokerLog));
    const controllerList = cotal(["service", "--space", controllerSpace, "--json"]);
    const controllerRows = (JSON.parse(controllerList.stdout) as { result: { services: Row[] } }).result.services;
    const upCommand = `cotal up --root '${controllerRoot}' --space ${controllerSpace}`;
    check("a stopped controller member listed from another project names its own stack root and space", row(controllerRows, "stack-broker")?.next === upCommand, controllerRows);
    for (const action of ["start", "restart"]) {
      const refused = controller(["service", action, "stack-broker", "--space", controllerSpace, "--json", ...(action === "restart" ? ["--yes"] : [])]);
      const refusal = JSON.parse(refused.stdout) as { error?: { code?: string } };
      check(`a real controller member still refuses an individual ${action}`, refused.status === 2 && refusal.error?.code === "LIFECYCLE_BLOCKED", refusal);
    }

    // #8301: no command in the remedy should try to start a stopped stack member directly or
    // pass its preset-only options to up. The root has spaces and the caller named the space.
    const consolePort = String(await freePort());
    const stackManagerStatus = () => controller(["service", "status", "stack-manager", "--space", controllerSpace, "--json"]);
    const savedManagerIdentity = (status: ReturnType<typeof cotal>) => {
      const { instanceId, definitionRevision, revision, recordedState, observedProcess } = JSON.parse(status.stdout).result ?? {};
      return { instanceId, definitionRevision, revision, recordedState, observedProcess };
    };
    const beforeOverride = stackManagerStatus();
    const overridePreview = controller(["manager", "start", "--space", controllerSpace, "--dry-run", "--console-port", consolePort, "--json"]);
    const override = JSON.parse(overridePreview.stdout);
    check("a stack manager override names working stack commands and the separate manager preset",
      overridePreview.status === 2 && override.error?.code === "CONFLICT" && override.target?.name === "stack-manager"
      && override.error.remedy?.includes(`\`${upCommand}\``) && override.error.remedy?.includes(`\`${upCommand} --no-manager\``)
      && override.error.remedy?.includes("`cotal service add custom-manager --preset manager --help`")
      && !/--console-port|service start stack-manager/.test(override.error.remedy), override);
    const afterOverride = stackManagerStatus();
    const beforeIdentity = savedManagerIdentity(beforeOverride), afterIdentity = savedManagerIdentity(afterOverride);
    check("the refusal leaves the saved stack manager and its stopped instance unchanged",
      beforeOverride.status === 0 && afterOverride.status === 0 && beforeIdentity.recordedState === "stopped"
      && beforeIdentity.observedProcess === "gone" && typeof beforeIdentity.revision === "string"
      && JSON.stringify(beforeIdentity) === JSON.stringify(afterIdentity), { beforeIdentity, afterIdentity });
    const brokerOnly = controller(["up", "--root", controllerRoot, "--space", controllerSpace, "--no-manager"]);
    const addStandalone = controller(["service", "add", "manager", "--preset", "manager", "--space", controllerSpace, "--console-port", consolePort, "--name", "standalone"]);
    const startStandalone = controller(["service", "start", "manager", "--space", controllerSpace, "--json"]);
    const standalone = JSON.parse(startStandalone.stdout).result;
    check("the broker-only route starts a separately configured manager",
      brokerOnly.status === 0 && addStandalone.status === 0 && startStandalone.status === 0
      && standalone?.definition === "manager" && standalone.observedProcess === "running",
      { brokerOnly: out(brokerOnly), add: out(addStandalone), start: out(startStandalone) });
    const startHelp = controller(["manager", "start", "--help"]);
    const helpText = out(startHelp).replace(/\s+/g, " ");
    check("manager start help limits name selection to user-auth spaces and points open and static spaces to cotal ps",
      startHelp.status === 0 && helpText.includes("--name <name> select by name with --on only on user-auth spaces") &&
      helpText.includes("--name <string> manager name for presence and, on user-auth spaces only, --on. On open and static spaces, use the instance ID from `cotal ps`"), out(startHelp));
    const listed = controller(["ps", "--space", controllerSpace, "--plain"]);
    const managerId = listed.stdout.match(/^\s*instance:\s+([a-z0-9]{26,32})\b/m)?.[1];
    const byName = controller(["ps", "--space", controllerSpace, "--on", "standalone", "--plain"]);
    const byId = managerId ? controller(["ps", "--space", controllerSpace, "--on", managerId, "--plain"]) : undefined;
    check("on the open space, the printed instance ID works and the manager name does not",
      listed.status === 0 && byName.status === 1 && out(byName).includes("USAGE_INVALID") && byId?.status === 0,
      { listed: out(listed), byName: out(byName), byId: byId && out(byId) });
    const stopStandalone = controller(["manager", "stop", "--space", controllerSpace, "--yes", "--json"]);
    check("the standalone manager stops before the stack starts its own",
      stopStandalone.status === 0 && JSON.parse(stopStandalone.stdout).outcome === "ok", out(stopStandalone));
    const secondDown = controller(["down", "--yes"]);
    const secondUp = controller(["up", "--open", "--space", controllerSpace, "--server", controllerServer]);
    check("the stack restarts with its own manager", secondDown.status === 0 && secondUp.status === 0, { down: out(secondDown), up: out(secondUp) });

    // #8297: explicitly pinning the older instance still reaches it, but the bare stop follows
    // manager status to the live stack manager without stopping the broker.
    const pinnedRun = controller(["manager", "stop", "--instance", standalone.instanceId, "--yes", "--json"]);
    const pinnedStop = JSON.parse(pinnedRun.stdout);
    check("a pinned stop still targets the older stopped standalone manager",
      pinnedRun.status === 0 && pinnedStop.outcome === "no-op" && pinnedStop.target?.name === "manager", pinnedStop);
    const liveRun = controller(["manager", "status", "--json"]);
    const liveManager = JSON.parse(liveRun.stdout).result;
    const brokerBefore = JSON.parse(controller(["service", "status", "stack-broker", "--json"]).stdout).result;
    const stopRun = controller(["manager", "stop", "--yes", "--json"]);
    const controllerStop = JSON.parse(stopRun.stdout);
    const afterStop = JSON.parse(stackManagerStatus().stdout).result;
    const brokerAfter = JSON.parse(controller(["service", "status", "stack-broker", "--json"]).stdout).result;
    check("an unpinned stop follows manager status to the live stack manager and keeps the broker running",
      liveRun.status === 0 && liveManager?.definition === "stack-manager" && liveManager.observedProcess === "running"
      && stopRun.status === 0 && controllerStop.outcome === "ok" && controllerStop.target?.name === "stack-manager" && controllerStop.target?.instanceId === liveManager.instanceId
      && afterStop?.recordedState === "stopped" && afterStop.observedProcess === "gone"
      && brokerBefore?.observedProcess === "running" && brokerAfter?.observedProcess === "running" && brokerAfter.pid === brokerBefore.pid,
      { liveManager, stop: controllerStop, afterStop, brokerBefore, brokerAfter });

    const { findNatsServer } = await import("../../implementations/cli/src/lib/nats-bin.js");
    const presetServer = `nats://127.0.0.1:${await freePort()}`, log = join(presetRoot, "logs", "broker.log"), config = join(presetRoot, ".cotal", "broker.conf");
    mkdirSync(dirname(log), { mode: 0o700 });
    writeFileSync(config, `listen: ${new URL(presetServer).host}\nlog_file: ${JSON.stringify(log)}\n`, { mode: 0o600 });
    const presetAdd = cotal(["service", "add", "b0", "--preset", "broker", "--space", PRESET_SPACE, "--config", config, "--binary", realpathSync((await findNatsServer()).path), "--server", presetServer, "--log-file", log]);
    check("service add b0 --preset broker saves it with a --log-file", presetAdd.status === 0, out(presetAdd));
    checkBrokerForegroundPreview();
    const presetStart = cotal(["service", "start", "b0", "--space", PRESET_SPACE]);
    presetBrokerUp = presetStart.status === 0;
    check("  and service start b0 starts it", presetBrokerUp, out(presetStart));
    renameSync(log, `${log}.moved`);
    const presetStop = cotal(["service", "stop", "b0", "--space", PRESET_SPACE, "--yes"]);
    presetBrokerUp = presetStop.status !== 0;
    check("  and with its log file moved away, service stop b0 --yes still stops it", presetStop.status === 0 && out(presetStop).includes("Original broker process exited"), out(presetStop));
  }
} catch (e) {
  check(`suite ran without throwing: ${e instanceof Error ? e.message : String(e)}`, false, e instanceof Error ? e.stack : e);
} finally {
  if (controllerAt) {
    const down = cotal(["down", "--yes"], 180_000, controllerAt);
    check("teardown confirms the controller control is stopped", down.status === 0, out(down));
    if (down.status !== 0) throw new Error(`controller cleanup did not confirm a stop; retained ${controllerAt.root}`);
    rmSync(controllerAt.root, { recursive: true, force: true });
  }
  if (customBrokerUp) {
    const stop = cotal(["service", "stop", "stack-broker", "--space", PRESET_SPACE, "--yes"]);
    check("teardown stops the custom service with a stack member name", stop.status === 0, out(stop));
    if (stop.status !== 0) throw new Error(`custom service cleanup did not confirm a stop; retained ${presetRoot}`);
  }
  if (presetBrokerUp) {
    const stop = cotal(["service", "stop", "b0", "--space", PRESET_SPACE, "--yes"]);
    check("teardown stops the preset broker", stop.status === 0, out(stop));
  }
  if (upStackUp) {
    const down = upCotal(["down", "--yes"]);
    check("teardown stops the plain stack", down.status === 0, out(down));
  }
  if (stackUp) {
    if (helloUp) {
      const stop = cotal(["service", "stop", "hello", "--yes"]);
      check("teardown stops hello", stop.status === 0, out(stop));
    }
    if (outliveUp) check("teardown stops outlive", cotal(["service", "stop", "outlive", "--yes"]).status === 0);
    spawnSync("systemctl", ["--user", "stop", STARTER_SCOPE, ...retryScopes], { stdio: "ignore" });
    for (const starter of starters) try { process.kill(-starter.pid!, "SIGKILL"); } catch { /* already gone */ }
    if (managerUp) {
      const stop = cotal(["service", "stop", "manager", "--yes"]);
      check("teardown stops the manager", stop.status === 0, out(stop));
    }
    const down = cotal(["down", "--yes"]);
    check("cotal down stops the sandboxed stack", down.status === 0, out(down));
  }
  check("service commands leave both test homes without telemetry state", [home, upHome].every((dir) => !existsSync(join(dir, ".cotal", "telemetry.json"))));
  for (const dir of [home, root, upHome, upRoot, presetRoot]) rmSync(dir, { recursive: true, force: true });
  finish();
  process.exit(process.exitCode ?? 0);
}
