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
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSuite } from "@cotal-ai/smoke-kit";

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
} else {
  console.log(`  ○ Linux stop/start fixture not run on ${process.platform}`);
}

finish();
if (process.exitCode) process.exit(process.exitCode);
