/**
 * `cotal daemon stop` is a real subcommand. It turns off automatic start and then stops
 * the recorded service, leaving the installation in place. `cotal daemon start` turns
 * automatic start back on.
 *
 * The shipped command table is the `subcommands` array in `bin/daemon/command.ts`, the same
 * table dispatch reads. The first five checks count that entry from the source the binary
 * ships, not a copy of the table.
 *
 * On Linux the rest drive the built CLI through the recording systemd stand-in. That stand-in
 * never calls the host service manager. macOS and Windows were not run.
 *
 * Run: pnpm smoke:daemon-stop
 */
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSuite } from "@cotal-ai/smoke-kit";
import { CommandFailure } from "@cotal-ai/workspace";
import { ptySpawn } from "../../implementations/cli/smoke/_console-pty.js";
import { daemonPathsFor } from "../daemon/endpoint.js";
import { processBirth } from "../daemon/lifetime.js";

const { check, finish } = createSuite();
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../daemon/command.ts"), "utf8");
const tableStart = source.indexOf("subcommands: [");
const runEnd = source.indexOf("prepareMeshTarget: false,\n  examples:", tableStart);
const table = tableStart >= 0 && runEnd > tableStart ? source.slice(tableStart, runEnd) : "";
const names = [...table.matchAll(/\{ name: "([a-z0-9-]+)"/g)].map((match) => match[1]!);
const stop = /\{ name: "stop", usage: "([^"]+)"[\s\S]*?flagNames: \[([^\]]+)\]/.exec(table);
const flags = stop?.[2]?.match(/"([a-z-]+)"/g)?.map((flag) => flag.slice(1, -1)) ?? [];
const parentUsage = /usage: "([^"]*daemon[^"]*)"/.exec(source)?.[1] ?? "";

check("the shipped command table was read", names.includes("start") && names.includes("install") && names.includes("uninstall"), names);
check("daemon stop is one entry in that table", names.filter((name) => name === "stop").length === 1, names);
check("daemon stop takes --daemon-home, --yes, --dry-run, --json and --plain",
  ["daemon-home", "yes", "dry-run", "json", "plain"].every((flag) => flags.includes(flag)), flags);
check("daemon stop usage names the command", stop?.[1]?.startsWith("cotal daemon stop") === true, stop?.[1]);
check("the parent usage lists stop beside start", parentUsage.includes("<name|") && parentUsage.includes("|stop|") && parentUsage.includes("|start|"), parentUsage);

if (process.platform === "linux") {
  await (async () => {
  const root = mkdtempSync(join(tmpdir(), "daemon-stop-"));
  const daemon = fileURLToPath(new URL("../dist/cotal.js", import.meta.url));
  const fixture = readFileSync(new URL("fixtures/daemon-systemd-tool.mjs", import.meta.url), "utf8");
  const cotal = join(root, "cotal");
  const home = join(cotal, "daemon");
  const config = join(root, "config");
  const unitDir = join(config, "systemd", "user");
  const calls = join(root, "calls.jsonl");
  const contextFile = join(root, "context.json");
  for (const leaf of [join(root, "home"), cotal, config, join(root, "rt"), join(root, "native"), join(root, "state"), home, unitDir]) mkdirSync(leaf, { recursive: true, mode: 0o700 });
  const resolvedHome = realpathSync(home);
  const resolvedConfig = realpathSync(config);
  const unitName = `cotal-daemon-${createHash("sha256").update(resolvedHome).digest("hex").slice(0, 16)}.service`;
  const unitPath = join(resolvedConfig, "systemd", "user", unitName);
  const node = process.execPath;
  const unitBytes = `[Unit]\nDescription=Cotal daemon smoke\n[Service]\nEnvironment=PATH="/usr/bin"\nEnvironment=COTAL_DAEMON_NATIVE_SERVICE=1\nExecStart="${node}" "${node}" daemon serve --daemon-home "${resolvedHome}"\n[Install]\nWantedBy=default.target\n`;
  writeFileSync(unitPath, unitBytes, { mode: 0o600 });
  const receipt = {
    v: 1,
    mechanism: "systemd-user",
    unit: unitName,
    unitPath,
    unitSha256: createHash("sha256").update(unitBytes).digest("hex"),
    installedAt: "2026-01-01T00:00:00.000Z",
    daemonHome: resolvedHome,
  };
  writeFileSync(join(home, "service-unit.json"), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  const context = { home: realpathSync(join(root, "home")), config: resolvedConfig, calls, units: [unitName], unitFileState: "enabled", environmentOutput: `HOME=${realpathSync(join(root, "home"))}\nXDG_CONFIG_HOME=${resolvedConfig}` };
  writeFileSync(contextFile, `${JSON.stringify(context)}\n`, { mode: 0o600 });
  for (const tool of ["systemctl", "loginctl"]) writeFileSync(join(root, "native", tool), `#!${process.execPath}\n${fixture}`, { mode: 0o700 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !["NODE_OPTIONS", "NODE_PATH"].includes(key)));
  Object.assign(env, {
    HOME: context.home, USER: "smoke", LOGNAME: "smoke", COTAL_HOME: join(root, "cotal"),
    XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: join(root, "rt"), XDG_STATE_HOME: join(root, "state"),
    PATH: `${join(root, "native")}:/usr/bin:/bin`, DAEMON_UNIT_FIXTURE: contextFile, DO_NOT_TRACK: "1", NO_COLOR: "1",
  });
  const operations = (): string[] => existsSync(calls)
    ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { operation: string }).operation)
    : [];
  const run = (verb: string, extra: string[] = []) => {
    const result = spawnSync(process.execPath, [daemon, "daemon", verb, "--daemon-home", home, "--json", ...extra], {
      cwd: root, env, encoding: "utf8", timeout: 30_000,
    });
    const doc = result.stdout ? JSON.parse(result.stdout) as { result?: { state?: string }; error?: { message?: string; remedy?: string } } : undefined;
    return { status: result.status, doc, stderr: result.stderr, error: result.error?.message };
  };
  const before = operations().length;
  const dry = run("stop", ["--dry-run"]);
  const dryOps = operations().slice(before);
  check("dry-run stop changes nothing", dry.status === 0 && dry.doc?.result?.state === "would-stop" && !dryOps.some((op) => op === "disable" || op === "stop" || op === "enable" || op === "start") && existsSync(unitPath) && existsSync(join(home, "service-unit.json")), dry);
  const stopped = run("stop", ["--yes"]);
  const stoppedOps = operations().slice(before);
  check("stop disables automatic start and then stops", stopped.status === 0 && stopped.doc?.result?.state === "stopped"
    && stoppedOps.indexOf("disable") >= 0 && stoppedOps.indexOf("disable") < stoppedOps.lastIndexOf("stop"), stoppedOps);
  check("stop keeps the unit and the receipt", existsSync(unitPath) && readFileSync(unitPath, "utf8") === unitBytes && existsSync(join(home, "service-unit.json")));
  const status = run("status");
  const remedy = status.doc?.error?.remedy ?? "";
  const message = status.doc?.error?.message ?? "";
  check("status says the service was stopped and names cotal daemon start, not systemctl",
    status.status === 2 && message.includes("You stopped the background service") && remedy.includes("cotal daemon start") && !remedy.includes("systemctl") && !message.includes("systemctl"),
    status.doc?.error);
  const resumed = run("start");
  const resumedOps = operations().slice(stoppedOps.length + before);
  const resumedMarker = join(resolvedHome, "service-stopped-by-you");
  check("start turns automatic start back on and then starts", resumed.status === 0
    && resumedOps.indexOf("enable") >= 0 && resumedOps.indexOf("enable") < resumedOps.lastIndexOf("start") && !existsSync(resumedMarker), resumedOps);
  const desktop = (body: Record<string, unknown>) => {
    const result = spawnSync(process.execPath, [daemon, "daemon", "desktop", "--daemon-home", home], {
      cwd: root, env, encoding: "utf8", timeout: 30_000, input: `${JSON.stringify(body)}\n`,
    });
    const frames = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { event?: string; ok?: boolean; result?: { state?: string; agents?: string[] }; error?: { code?: string; detail?: { installed?: boolean; stopped?: string } } });
    return { status: result.status, frame: frames.at(-1), stderr: result.stderr };
  };
  writeFileSync(contextFile, `${JSON.stringify({ ...JSON.parse(readFileSync(contextFile, "utf8")), unitFileState: "enabled" })}\n`);
  const asked = operations().length;
  const plainStop = desktop({ op: "stop" });
  const plainOps = operations().slice(asked);
  check("the app stop request disables and then stops when no agent is running", plainStop.status === 0 && plainStop.frame?.ok === true && plainStop.frame.result?.state === "stopped"
    && plainOps.indexOf("disable") >= 0 && plainOps.indexOf("disable") < plainOps.lastIndexOf("stop") && existsSync(unitPath), plainStop.frame);
  const afterStop = desktop({ op: "status" });
  check("status after an intentional stop says stopped by you", afterStop.frame?.ok === false && afterStop.frame?.error?.code === "NOT_RUNNING" && afterStop.frame.error.detail?.installed === true && afterStop.frame.error.detail.stopped === "by-you", afterStop.frame);
  const marker = join(resolvedHome, "service-stopped-by-you");
  check("an intentional stop writes the person-stop marker", existsSync(marker));
  const watched = desktop({ op: "status-watch" });
  check("status-watch after an intentional stop says stopped by you", watched.frame?.ok === false && watched.frame?.error?.code === "NOT_RUNNING" && watched.frame.error.detail?.installed === true && watched.frame.error.detail.stopped === "by-you", watched.frame);
  const appStart = desktop({ op: "start" });
  const appStartOps = operations().slice(asked + plainOps.length);
  check("the app start request enables and then starts", appStart.status === 0 && appStart.frame?.ok === true && appStart.frame.result?.state === "start-requested"
    && appStartOps.indexOf("enable") >= 0 && appStartOps.indexOf("enable") < appStartOps.lastIndexOf("start"), appStart.frame);
  const extra = desktop({ op: "stop", confirm: true, extra: true });
  check("the app stop request rejects a field it does not take", extra.frame?.ok === false && extra.frame?.error?.code === "BAD_REQUEST", extra.frame);
  writeFileSync(contextFile, `${JSON.stringify({ ...JSON.parse(readFileSync(contextFile, "utf8")), unitFileState: "enabled" })}\n`);
  const unexpected = desktop({ op: "status" });
  check("status of an unexpected stop has no by-you marker", unexpected.frame?.ok === false && unexpected.frame?.error?.code === "NOT_RUNNING" && unexpected.frame.error.detail?.installed === true && unexpected.frame.error.detail.stopped === undefined, unexpected.frame);
  check("an unexpected stop leaves no person-stop marker", !existsSync(marker));
  const askedAgain = operations().length;
  const confirmAlone = desktop({ op: "stop", confirm: true });
  check("confirm without the agent list does not stop", confirmAlone.frame?.result?.state === "needs-confirm" && !operations().slice(askedAgain).some((op) => op === "disable" || op === "stop"), confirmAlone.frame);
  const changed = desktop({ op: "stop", confirm: true, agents: ["someone-else"] });
  check("a different agent list does not stop", changed.frame?.result?.state === "needs-confirm" && !operations().slice(askedAgain).includes("stop"), changed.frame);
  const noTerminal = run("stop");
  check("no terminal and no --yes stops nothing", noTerminal.status !== 0 && (noTerminal.doc?.error?.message ?? "").includes("There is no terminal") && !operations().slice(askedAgain).includes("disable"), noTerminal.doc?.error);
  writeFileSync(contextFile, `${JSON.stringify({ ...JSON.parse(readFileSync(contextFile, "utf8")), unitFileState: "enabled", failStop: true })}\n`);
  const beforeHalf = operations().length;
  const markerBeforeHalf = existsSync(marker);
  const half = run("stop", ["--yes"]);
  const halfOps = operations().slice(beforeHalf);
  check("a stop that fails after automatic start is off says so and names cotal daemon start", !markerBeforeHalf && half.status !== 0 && (half.doc?.error?.message ?? "").includes("automatic start is already off") && (half.doc?.error?.message ?? "").includes("cotal daemon start") && JSON.stringify(halfOps) === JSON.stringify(["directory-read", "directory-read", "disable", "autostart-read", "stop"]) && !existsSync(marker), { error: half.doc?.error, halfOps });
  writeFileSync(contextFile, `${JSON.stringify({ ...JSON.parse(readFileSync(contextFile, "utf8")), failStop: false })}\n`);
  const units = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { unit?: string }).unit).filter((unit): unit is string => !!unit) : [];
  const saved = JSON.parse(readFileSync(contextFile, "utf8")) as { units?: string[]; unitFileState?: string };
  check("the fixture recorded one service", saved.units?.length === 1 && saved.units[0] === unitName && saved.unitFileState === "disabled" && units.every((unit) => unit === unitName), saved);
  writeFileSync(contextFile, `${JSON.stringify({ ...JSON.parse(readFileSync(contextFile, "utf8")), unitFileState: "enabled" })}\n`);
  const marked = run("stop", ["--yes"]);
  const markedStatus = run("status");
  check("a stop writes a private marker and status reads it", marked.status === 0 && existsSync(marker) && (lstatSync(marker).mode & 0o777) === 0o600 && (markedStatus.doc?.error?.message ?? "").includes("You stopped the background service"), markedStatus.doc?.error);
  const removed = run("uninstall", ["--yes"]);
  check("uninstall removes the person-stop marker", removed.status === 0 && !existsSync(marker), removed.doc);
  writeFileSync(marker, "\n", { mode: 0o600 });
  const reinstalled = run("install");
  check("install clears a marker left from a service that was removed", reinstalled.status === 0 && !existsSync(marker), reinstalled.doc);
  writeFileSync(contextFile, `${JSON.stringify({ ...JSON.parse(readFileSync(contextFile, "utf8")), unitFileState: "disabled" })}\n`);
  writeFileSync(marker, "stopped\n", { mode: 0o600 });
  const alreadyInstalled = run("install");
  check("install on an already-installed service leaves the stop marker", alreadyInstalled.status === 0 && existsSync(marker) && (alreadyInstalled.doc?.error?.message ?? "") === "", { status: alreadyInstalled.status, error: alreadyInstalled.doc?.error, marker: existsSync(marker) });
  writeFileSync(marker, "stopped\n", { mode: 0o600 });
  const beforeSetup = operations().length;
  const setupStart = spawnSync(process.execPath, ["--input-type=module", "-e", "import { readFileSync } from 'node:fs'; import { runSetup } from './bin/dist/daemon/setup.js'; import { daemonPathsFor } from './bin/dist/daemon/endpoint.js'; const home = process.argv[1]; const calls = JSON.parse(readFileSync(process.env.DAEMON_UNIT_FIXTURE, 'utf8')).calls; const watch = setInterval(() => { const rows = readFileSync(calls, 'utf8'); if (rows.includes('\"start\"')) { clearInterval(watch); process.exit(0); } }, 100); await runSetup({ space: 'smoke', version: 'test', waitSeconds: 0, paths: daemonPathsFor(home, process.env), daemonHome: home, report() {} });", resolvedHome], { cwd: join(here, "../.."), env, encoding: "utf8", timeout: 30_000 });
  const setupOps = operations().slice(beforeSetup);
  check("setup after a stop enables before it starts and clears the marker", setupStart.status === 0 && setupOps.indexOf("enable") >= 0 && setupOps.indexOf("enable") < setupOps.lastIndexOf("start") && !existsSync(marker), { status: setupStart.status, stderr: setupStart.stderr, setupOps });
  writeFileSync(contextFile, `${JSON.stringify({ ...JSON.parse(readFileSync(contextFile, "utf8")), unitFileState: "disabled" })}\n`);
  writeFileSync(marker, "stopped\n", { mode: 0o600 });
  const beforeDirectInstall = operations().length;
  const appScript = [
    "import { readFileSync } from 'node:fs';",
    "import { registerHooks } from 'node:module';",
    "import { Readable, Writable } from 'node:stream';",
    "registerHooks({ load(url, context, next) {",
    "  const loaded = next(url, context);",
    "  const source = Buffer.isBuffer(loaded.source) ? loaded.source.toString('utf8') : loaded.source;",
    "  if (String(url).endsWith('/daemon/desktop-path.js') && typeof source === 'string') {",
    "    return { format: loaded.format, shortCircuit: true, source: source.replace('[\"-l\", \"-i\", \"-c\", print]', '[\"-c\", print]') };",
    "  }",
    "  return loaded;",
    "}});",
    "const { runDesktopBridge } = await import('./bin/dist/daemon/desktop.js');",
    "const { daemonPathsFor } = await import('./bin/dist/daemon/endpoint.js');",
    "const home = process.argv[1];",
    "const calls = JSON.parse(readFileSync(process.env.DAEMON_UNIT_FIXTURE, 'utf8')).calls;",
    "const watch = setInterval(() => {",
    "  if (readFileSync(calls, 'utf8').includes('\"start\"')) { clearInterval(watch); process.exit(0); }",
    "}, 100);",
    "const input = Readable.from(['{\"op\":\"install\"}\\n']);",
    "const output = new Writable({ write(chunk, _e, done) { process.stderr.write(chunk); done(); } });",
    "await runDesktopBridge({ version: 'test', resolveTarget: () => ({ paths: daemonPathsFor(home, process.env), home }), input, output });",
  ].join("\n");
  const direct = spawnSync(process.execPath, ["--input-type=module", "-e", appScript, resolvedHome], { cwd: join(here, "../.."), env, encoding: "utf8", timeout: 30_000 });
  const directOps = operations().slice(beforeDirectInstall);
  check("the app install start after a stop enables before it starts and clears the marker", direct.status === 0 && directOps.indexOf("enable") >= 0 && directOps.indexOf("enable") < directOps.lastIndexOf("start") && !existsSync(marker), { status: direct.status, stderr: direct.stderr, directOps });
  writeFileSync(marker, "\n", { mode: 0o600 });
  writeFileSync(contextFile, `${JSON.stringify({ ...JSON.parse(readFileSync(contextFile, "utf8")), unitFileState: "disabled", failStart: true })}\n`);
  const startFailed = run("start");
  check("a start that fails after turning automatic start back on says so and clears the marker",
    startFailed.status !== 0 && (startFailed.doc?.error?.message ?? "").includes("Automatic start is on again") && !existsSync(marker), startFailed.doc?.error);
  writeFileSync(contextFile, `${JSON.stringify({ ...JSON.parse(readFileSync(contextFile, "utf8")), failStart: false })}\n`);

  const runtime = mkdtempSync(join("/tmp", "cotal-rt-"));
  chmodSync(runtime, 0o700);
  const liveEnv = { ...env, XDG_RUNTIME_DIR: runtime };
  const livePaths = daemonPathsFor(resolvedHome, liveEnv);
  mkdirSync(livePaths.dir!, { recursive: true, mode: 0o700 });
  chmodSync(livePaths.parent!, 0o700);
  chmodSync(livePaths.dir!, 0o700);
  const birth = processBirth(process.pid);
  writeFileSync(livePaths.lock, `${JSON.stringify({ v: 1, pid: process.pid, start: birth, startedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  let answers = 0;
  let thirdChanges = false;
  const statusFor = (which: number) => {
    const managers = (thirdChanges ? which < 2 : which < 3) ? [{ space: "acme", state: "starting", restarts: 0 }] : [];
    const agents = thirdChanges
      ? (which < 2 ? [] : [{ space: "s", state: "read", observedAt: "t", agents: [{ name: "ada", application: "app", cwd: "/", startedAt: "t", state: "running" }, { name: "bev", application: "app", cwd: "/", startedAt: "t", state: "running" }] }])
      : which < 3 ? [] : which === 3 ? [{ space: "s", state: "read", observedAt: "t", agents: [{ name: "ada", application: "app", cwd: "/", startedAt: "t", state: "running" }] }]
      : [{ space: "s", state: "read", observedAt: "t", agents: [{ name: "ada", application: "app", cwd: "/", startedAt: "t", state: "running" }, { name: "bev", application: "app", cwd: "/", startedAt: "t", state: "running" }] }];
    return { state: "ready", protocol: 1, version: "test", pid: process.pid, startedAt: "t", uptimeMs: 1, managers, agents };
  };
  const server = createServer((socket: Socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end)) as { id?: string; op?: string };
      buffer = buffer.slice(end + 1);
      const result = request.op === "daemon-stop" ? { version: "test" } : statusFor(answers++);
      socket.write(`${JSON.stringify({ v: 1, id: request.id ?? null, ok: true, result })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(livePaths.socket, resolve));
  chmodSync(livePaths.socket, 0o600);
  const live = (verb: string, extra: string[] = []) => new Promise<{ status: number | null; doc?: { result?: { state?: string; agents?: string[] }; error?: { message?: string; native?: { code?: string; detail?: { agents?: string[] } } } }; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [daemon, "daemon", verb, "--daemon-home", home, "--json", ...extra], { cwd: root, env: liveEnv });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("close", (status) => resolve({ status, doc: stdout ? JSON.parse(stdout) : undefined, stderr }));
  });
  writeFileSync(contextFile, `${JSON.stringify({ ...JSON.parse(readFileSync(contextFile, "utf8")), unitFileState: "enabled" })}\n`);
  const disables = () => operations().filter((op) => op === "disable").length;
  const beforeDisables = disables();
  const named = await live("stop", ["--yes"]);
  check("a starting Manager is named and the stop includes it", named.status === 0 && named.doc?.result?.agents?.includes("Manager for acme") === true && named.stderr.includes("Stopping these: Manager for acme.") && disables() === beforeDisables + 1, named);
  const conflicted = await live("stop", ["--yes"]);
  check("a changed agent list refuses and disables nothing", conflicted.status !== 0 && conflicted.doc?.error?.message === "the running agents changed to: ada, bev. Nothing was stopped" && disables() === beforeDisables + 1, conflicted.doc?.error);
  const confirmed = await new Promise<{ frame?: { result?: { state?: string } } }>((resolve) => {
    const child = spawn(process.execPath, [daemon, "daemon", "desktop", "--daemon-home", home], { cwd: root, env: liveEnv });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stdin.end(`${JSON.stringify({ op: "stop", confirm: true, agents: ["ada", "bev"] })}\n`);
    child.on("close", () => { const frames = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { result?: { state?: string } }); resolve({ frame: frames.at(-1) }); });
  });
  check("the app stop with the matching list stops", confirmed.frame?.result?.state === "stopped" && disables() === beforeDisables + 2, confirmed.frame);
  answers = 0;
  thirdChanges = true;
  const changedUnderLock = await new Promise<{ frame?: { result?: { state?: string; agents?: string[] }; error?: { native?: { code?: string } } } }>((resolve) => {
    const child = spawn(process.execPath, [daemon, "daemon", "desktop", "--daemon-home", home], { cwd: root, env: liveEnv });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stdin.end(`${JSON.stringify({ op: "stop", confirm: true, agents: ["Manager for acme"] })}\n`);
    child.on("close", () => { const frames = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { result?: { state?: string; agents?: string[] }; error?: { native?: { code?: string } } }); resolve({ frame: frames.at(-1) }); });
  });
  check("a list that changes under the lock is not stopped", changedUnderLock.frame?.result?.state === "needs-confirm" && changedUnderLock.frame.result.agents?.includes("ada") === true && changedUnderLock.frame.result.agents?.includes("bev") === true && disables() === beforeDisables + 2, changedUnderLock.frame);
  thirdChanges = false;
  answers = 0;
  const confirmedYes = await new Promise<{ code: number; text: string }>((resolve) => {
    let text = "";
    const pty = ptySpawn(process.execPath, [daemon, "daemon", "stop", "--daemon-home", home, "--yes", "--json"], { name: "xterm-256color", cols: 100, rows: 30, cwd: root, env: liveEnv as Record<string, string> });
    pty.onData((data) => { text += data; });
    pty.onExit((event) => resolve({ code: event.exitCode, text }));
  });
  const yesLine = confirmedYes.text.indexOf("Stopping these: Manager for acme.");
  const yesJson = confirmedYes.text.indexOf('"state":"stopped"');
  check("--yes on a terminal names the agents before the stop", confirmedYes.code === 0 && yesLine >= 0 && yesJson > yesLine, { code: confirmedYes.code, text: confirmedYes.text });
  answers = 0;
  const declined = await new Promise<{ code: number; text: string }>((resolve) => {
    let text = "";
    const pty = ptySpawn(process.execPath, [daemon, "daemon", "stop", "--daemon-home", home], { name: "xterm-256color", cols: 100, rows: 30, cwd: root, env: liveEnv as Record<string, string> });
    let open = true;
    pty.onData((data) => { text += data; if (open && text.includes("[y/N]")) { open = false; pty.write("n\n"); } });
    pty.onExit((event) => resolve({ code: event.exitCode, text }));
  });
  check("a declined prompt names the Manager, says nothing was stopped, and exits 0", declined.code === 0 && declined.text.includes("Manager for acme") && declined.text.includes("Nothing was stopped.") && !declined.text.includes("90 seconds") && !declined.text.includes("start again with the service"), { code: declined.code, text: declined.text });
  let handshake: ((request: { op?: string; commit?: boolean }) => { ok: true; result: { version: string } } | { ok: false; error: { code: string; message: string } } | undefined) | undefined;
  const prior = server.listeners("connection").slice();
  server.removeAllListeners("connection");
  server.on("connection", (socket: Socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end)) as { id?: string; op?: string; commit?: boolean };
      buffer = buffer.slice(end + 1);
      const directed = handshake?.(request);
      if (directed === undefined && handshake) return;
      const result = directed ?? (request.op === "daemon-stop" ? { version: "test" } : statusFor(answers++));
      const ok = directed && "ok" in directed ? directed.ok : true;
      const body = ok ? { result: "result" in result ? result.result : result } : { error: "error" in result ? result.error : undefined };
      socket.write(`${JSON.stringify({ v: 1, id: request.id ?? null, ok, ...body })}\n`);
    });
  });
  const probeStop = (mode: string, timeout = 20_000) => new Promise<{ status: number | null; stderr: string; doc?: { failed?: { message: string; code?: string; native?: string; cause?: string }; calls: string[]; enabled: boolean; started: boolean; marker: boolean } }>((resolve) => {
    const script = [
      "import { existsSync, rmSync } from 'node:fs';",
      "import { stopInstalled, startInstalled } from './bin/dist/daemon/install.js';",
      "import { daemonPathsFor } from './bin/dist/daemon/endpoint.js';",
      "const mode = process.argv[1];",
      "const home = process.argv[2];",
      "const calls = [];",
      "let enabled = false;",
      "let started = false;",
      "const service = {",
      "  mechanism: 'launchd-agent',",
      "  prepareStop() { calls.push('prepare'); enabled = false; },",
      "  finishStop() { calls.push('finish'); },",
      "  enable() { calls.push('enable'); enabled = true; },",
      "  plan() { throw new Error('unused'); }, publish() {}, register() {}, check() {},",
      "  stopped() { return !enabled; },",
      "  start(_receipt, resume) { started = true; if (resume) enabled = true; },",
      "  isEnabled() { throw new Error('print-disabled failed'); },",
      "  stop() {}, restart() {}, remove() {},",
      "};",
      "let failed;",
      "try {",
      "  if (mode === 'unread') await startInstalled({ state: home }, home, undefined, undefined, true, { service });",
      "  else { rmSync(home + '/service-stopped-by-you', { force: true }); await stopInstalled(daemonPathsFor(home, process.env), home, [], undefined, service); }",
      "} catch (error) {",
      "  failed = { message: error instanceof Error ? error.message : String(error), code: error && error.code, native: error && error.native && error.native.code, cause: error && error.cause && (error.cause.message || String(error.cause)), causeNative: error && error.cause && error.cause.native && error.cause.native.code };",
      "}",
      "console.log(JSON.stringify({ failed, calls, enabled, started, marker: existsSync(home + '/service-stopped-by-you') }));",
    ].join("\n");
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, mode, resolvedHome], { cwd: join(here, "../.."), env: liveEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("close", (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const doc = stdout.trim() ? JSON.parse(stdout) as { failed?: { message: string; code?: string; native?: string; cause?: string; causeNative?: string }; calls: string[]; enabled: boolean; started: boolean; marker: boolean } : undefined;
      resolve({ status, stderr, doc });
    });
  });
  handshake = (request) => request.op === "daemon-stop" && !request.commit ? { ok: false, error: { code: "DEPENDENCY_UNAVAILABLE", message: "provenance is unknown" } } : undefined;
  const refused = await probeStop("refuse", 100_000);
  check("a refused prepare turns automatic start back on and does not end the task", refused.doc?.failed?.native === "STOP_NOT_SENT" && refused.doc.failed.code === "OPERATION_UNKNOWN" && refused.doc.failed.message === "the background service was not stopped. Automatic start is still on. Run `cotal daemon stop` again." && refused.doc.enabled && !refused.doc.calls.includes("finish") && refused.doc.marker === false, refused);
  handshake = () => undefined;
  const silent = await probeStop("silent", 100_000);
  check("a prepare that is not answered turns automatic start back on", silent.doc?.failed?.message === "the background service was not stopped. Automatic start is still on. Run `cotal daemon stop` again." && silent.doc.failed.code === "OPERATION_UNKNOWN" && silent.doc.enabled && !silent.doc.calls.includes("finish") && silent.doc.marker === false, silent);
  handshake = (request) => request.commit ? { ok: false, error: { code: "OPERATION_UNKNOWN", message: "commit failed" } } : { ok: true, result: { version: "test" } };
  const commitFailed = await probeStop("commit", 100_000);
  check("a failed commit leaves automatic start off and names another stop", commitFailed.doc?.enabled === false && !commitFailed.doc?.calls.includes("finish") && commitFailed.doc?.marker === false && commitFailed.doc?.failed?.code === "OPERATION_UNKNOWN" && commitFailed.doc.failed.message.includes("automatic start is already off") && commitFailed.doc.failed.message.includes("cotal daemon stop"), commitFailed);
  handshake = undefined;
  const missingAction = new Error("the replacement does not have one enabled native task instance");
  writeFileSync(marker, "stopped\n", { mode: 0o600 });
  const { startInstalled } = await import("../daemon/install.js");
  let enabledState = false;
  let disabledRead = "";
  let disabledCode = "";
  const failingStart = () => { enabledState = true; throw missingAction; };
  try { await startInstalled(livePaths, resolvedHome, undefined, undefined, true, { windowsFailure: failingStart, enabled: () => enabledState, setEnabled: (next) => { enabledState = next; } }); }
  catch (error) { disabledRead = error instanceof Error ? error.message : String(error); disabledCode = error instanceof CommandFailure ? error.code : ""; }
  check("a failed start of a disabled task ends disabled, keeps the marker, exits 3, and names another start", disabledCode === "OPERATION_UNKNOWN" && disabledRead.includes("Nothing was started") && disabledRead.includes("Automatic start is off") && disabledRead.includes("cotal daemon start") && !disabledRead.includes("the task was not enabled") && !disabledRead.includes("Automatic start is on again") && existsSync(marker) && enabledState === false, { disabledCode, disabledRead, enabledState });
  const enabledTask: { on: boolean } = { on: true };
  let enabledRead = "";
  let enabledCode = "";
  try { await startInstalled(livePaths, resolvedHome, undefined, undefined, true, { windowsFailure: missingAction, enabled: () => enabledTask.on, setEnabled: (next) => { enabledTask.on = next; } }); }
  catch (error) { enabledRead = error instanceof Error ? error.message : String(error); enabledCode = error instanceof CommandFailure ? error.code : ""; }
  check("a failed start of a task that was already enabled ends disabled, keeps the marker, and exits 3", enabledCode === "OPERATION_UNKNOWN" && enabledRead.includes("Nothing was started") && enabledRead.includes("Automatic start is off") && enabledRead.includes("cotal daemon start") && !enabledRead.includes("the task was not enabled") && !enabledRead.includes("Automatic start is on again") && existsSync(marker) && enabledTask.on === false, { enabledCode, enabledRead, enabledState: enabledTask.on });
  writeFileSync(marker, "stopped\n", { mode: 0o600 });
  enabledState = false;
  let unreadableReads = 0;
  let unreadableRead = "";
  let unreadableCode = "";
  const unreadableStart = () => { enabledState = true; throw missingAction; };
  try {
    await startInstalled(livePaths, resolvedHome, undefined, undefined, true, {
      windowsFailure: unreadableStart,
      enabled: () => { unreadableReads += 1; if (unreadableReads > 1) throw new Error("unreadable"); return enabledState; },
      setEnabled: (next) => { enabledState = next; },
    });
  } catch (error) { unreadableRead = error instanceof Error ? error.message : String(error); unreadableCode = error instanceof CommandFailure ? error.code : ""; }
  check("an unreadable Windows start of a stopped task ends disabled, keeps the marker, and exits 3", unreadableCode === "OPERATION_UNKNOWN" && unreadableRead.includes("Nothing was started") && unreadableRead.includes("Automatic start is off") && existsSync(marker) && enabledState === false, { unreadableCode, unreadableRead, enabledState });
  writeFileSync(marker, "stopped\n", { mode: 0o600 });
  const readFailure = await probeStop("unread");
  check("a macOS start whose automatic start cannot be read says the service started and leaves no stop marker", readFailure.doc?.started === true && readFailure.doc.enabled === true && readFailure.doc.failed?.code === "TARGET_UNAVAILABLE" && readFailure.doc.failed.message === "the service started, but automatic start could not be read" && readFailure.doc.marker === false, readFailure);
  for (const listener of prior) server.on("connection", listener as (socket: Socket) => void);
  server.close();
  writeFileSync(contextFile, `${JSON.stringify({ ...JSON.parse(readFileSync(contextFile, "utf8")), unitFileState: "enabled" })}\n`);
  const lockPath = join(resolvedHome, "service-repair.lock");
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const { processStartToken } = await import("@cotal-ai/core");
  writeFileSync(lockPath, `${JSON.stringify({ pid: holder.pid, start: processStartToken(holder.pid!), nonce: "held", ts: Date.now() })}\n`, { mode: 0o600 });
  const held = live("stop", ["--yes"]);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const waiting = existsSync(lockPath);
  holder.kill();
  const released = await held;
  check("a stop waits for the service-repair lock and then stops", waiting && released.status === 0 && !existsSync(lockPath), { waiting, status: released.status, error: released.doc?.error });
  })();
} else {
  console.log(`  ○ Linux stop/start fixture not run on ${process.platform}`);
}

finish();
if (process.exitCode) process.exit(process.exitCode);
