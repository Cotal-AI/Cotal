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
  check("start turns automatic start back on and then starts", resumed.status === 0
    && resumedOps.indexOf("enable") >= 0 && resumedOps.indexOf("enable") < resumedOps.lastIndexOf("start"), resumedOps);
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
  const half = run("stop", ["--yes"]);
  check("a stop that fails after automatic start is off says so and names cotal daemon start", half.status !== 0 && (half.doc?.error?.message ?? "").includes("automatic start is already off") && (half.doc?.error?.message ?? "").includes("cotal daemon start"), half.doc?.error);
  writeFileSync(contextFile, `${JSON.stringify({ ...JSON.parse(readFileSync(contextFile, "utf8")), failStop: false })}\n`);
  const units = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { unit?: string }).unit).filter((unit): unit is string => !!unit) : [];
  check("the fixture recorded one service", context.units.length === 1 && context.units[0] === unitName && units.every((unit) => unit === unitName), context.units);
  writeFileSync(contextFile, `${JSON.stringify({ ...JSON.parse(readFileSync(contextFile, "utf8")), unitFileState: "enabled" })}\n`);
  const marked = run("stop", ["--yes"]);
  const markedStatus = run("status");
  check("a stop writes a private marker and status reads it", marked.status === 0 && existsSync(marker) && (lstatSync(marker).mode & 0o777) === 0o600 && (markedStatus.doc?.error?.message ?? "").includes("You stopped the background service"), markedStatus.doc?.error);
  const removed = run("uninstall", ["--yes"]);
  check("uninstall removes the person-stop marker", removed.status === 0 && !existsSync(marker), removed.doc);
  writeFileSync(marker, "\n", { mode: 0o600 });
  const reinstalled = run("install");
  check("install clears a marker left from a service that was removed", reinstalled.status === 0 && !existsSync(marker), reinstalled.doc);
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
  const statusFor = (which: number) => {
    const managers = which < 3 ? [{ space: "acme", state: "starting", restarts: 0 }] : [];
    const agents = which < 3 ? [] : which === 3 ? [{ space: "s", state: "read", observedAt: "t", agents: [{ name: "ada", application: "app", cwd: "/", startedAt: "t", state: "running" }] }]
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
  check("a starting Manager is named and the stop includes it", named.status === 0 && named.doc?.result?.agents?.includes("acme") === true && disables() === beforeDisables + 1, named);
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
  const confirmedYes = await new Promise<{ code: number; text: string }>((resolve) => {
    let text = "";
    const pty = ptySpawn(process.execPath, [daemon, "daemon", "stop", "--daemon-home", home, "--yes", "--json"], { name: "xterm-256color", cols: 100, rows: 30, cwd: root, env: liveEnv as Record<string, string> });
    pty.onData((data) => { text += data; });
    pty.onExit((event) => resolve({ code: event.exitCode, text }));
  });
  const yesLine = confirmedYes.text.indexOf("Stopping these agents: acme.");
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
  check("a declined prompt names the agents, says nothing was stopped, and exits 0", declined.code === 0 && declined.text.includes("acme") && declined.text.includes("Nothing was stopped."), { code: declined.code, text: declined.text });
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
