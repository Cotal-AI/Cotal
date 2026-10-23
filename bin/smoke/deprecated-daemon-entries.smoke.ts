/**
 * Deprecated daemon entries: `supervise`, `deliver`, `auth-service` and `feedback-intake` keep their
 * pre-cut argv for the units, scripts and containers written before the CLI redesign, hidden from
 * help and completion. Each run prints one stderr line naming its service preset and the removal
 * release, which is one value for all four and is recorded in docs/UPGRADING.md. Stdout and the run
 * itself stay the entry's own. `up` launches a hidden twin of `supervise`, `deliver` and
 * `auth-service` that has the same parser, validation and runner without the warning.
 *
 * The real binary runs each entry's pre-cut line from a sandboxed HOME, COTAL_HOME and project root
 * against a port nothing listens on. A run is stopped once its warning appears; no broker, manager
 * or agent is started by this suite, and it removes its directories.
 *
 * Run: pnpm smoke:deprecated-daemon-entries
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const WT = join(import.meta.dirname, "..", "..");
const TSX_LOADER = import.meta.resolve("tsx");
const BIN = join(WT, "bin", "cotal.ts");
const home = mkdtempSync(join(tmpdir(), "cotal-deprecated-entries-home-"));
const root = mkdtempSync(join(tmpdir(), "cotal-deprecated-entries-root-"));
const xdg = join(home, "xdg");
recordSmokeSandbox({ root, cotalHome: join(home, ".cotal"), xdgConfigHome: xdg });
process.env.COTAL_HOME = join(home, ".cotal");
process.env.XDG_CONFIG_HOME = xdg;
const { parseCommandArgs, registry } = await import("@cotal-ai/core");
type Command = import("@cotal-ai/core").Command;
const { DAEMON_ENTRY_REMOVAL_RELEASE, DAEMON_ENTRY_TWINS, DEPRECATED_DAEMON_PRESETS, deprecatedDaemonEntryWarning, warnDeprecatedDaemonEntry } = await import("@cotal-ai/workspace");
type DeprecatedDaemonEntry = import("@cotal-ai/workspace").DeprecatedDaemonEntry;
type ServicePreset = import("@cotal-ai/workspace").ServicePreset;
await import("@cotal-ai/cli");
await import("@cotal-ai/manager");
await import("@cotal-ai/delivery");
await import("@cotal-ai/auth");

const { check, finish } = createSuite();
const SPACE = "deprecatedentries";
const SERVER = `nats://127.0.0.1:${await freePort()}`;
const keys = join(root, "intake-keys.json");
writeFileSync(keys, JSON.stringify({ keys: [{ key: "k".repeat(32), tester: "t" }] }));

/** Each entry's pre-cut command line, as units, scripts and containers written before the cut carry it. */
const lines: Record<DeprecatedDaemonEntry, string[]> = {
  supervise: ["supervise", "--space", SPACE, "--server", SERVER],
  deliver: ["deliver", "--space", SPACE, "--server", SERVER],
  "deliver pending": ["deliver", "pending", "scout", "--space", SPACE, "--server", SERVER],
  "auth-service": ["auth-service", "--space", SPACE, "--server", SERVER],
  "feedback-intake": ["feedback-intake", "--keys", keys, "--creds", join(root, "missing.creds"), "--server", SERVER, "--port", String(await freePort())],
};

// ---- The warning names a real replacement and the one release ---------------------------------
const presets = new Set(registry.all<ServicePreset>("service-preset").map((preset) => preset.name));
for (const [entry, preset] of Object.entries(DEPRECATED_DAEMON_PRESETS) as [keyof typeof DEPRECATED_DAEMON_PRESETS, string][]) {
  const warning = deprecatedDaemonEntryWarning(entry);
  const command = registry.all<Command>("command").find((row) => row.name === entry);
  check(`${entry} is still a registered entry`, command !== undefined);
  check(`${entry} is hidden from help and completion`, command?.hidden === true);
  check(`${entry} keeps its pre-cut argv`, (() => { try { parseCommandArgs(command!, lines[entry].slice(1)); return true; } catch { return false; } })());
  check(`${entry} names the registered ${preset} preset`, presets.has(preset) && warning.includes(`--preset ${preset} `), warning);
  check(`${entry} names the shared removal release`, warning.includes(` removed in ${DAEMON_ENTRY_REMOVAL_RELEASE}.`), warning);
}
const pendingWarning = deprecatedDaemonEntryWarning("deliver pending");
check("deliver pending names the pending read", pendingWarning.includes("cotal pending <agent>") && registry.all<Command>("command").some((row) => row.name === "pending"), pendingWarning);

const upgrading = readFileSync(join(WT, "docs", "UPGRADING.md"), "utf8");
const start = upgrading.indexOf("\n### Deprecated daemon entries\n");
const section = start < 0 ? "" : upgrading.slice(start, upgrading.indexOf("\n#", start + 1));
check("docs/UPGRADING.md records the removal release", section.includes(`\`${DAEMON_ENTRY_REMOVAL_RELEASE}\``), section.slice(0, 200));
check("docs/UPGRADING.md maps each entry to its preset",
  Object.entries(DEPRECATED_DAEMON_PRESETS).every(([entry, preset]) => section.includes(`\`${entry}\``) && section.includes(`--preset ${preset}`)));

/** Run `fn` with stdout and stderr captured. */
async function captured(fn: () => unknown): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const writeOut = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { await fn(); }
  finally { process.stdout.write = writeOut; process.stderr.write = writeErr; }
  return { out: out.join(""), err: err.join("") };
}
const count = (text: string, line: string) => text.split(line).length - 1;

// ---- The warning leaves stdout and the exit code alone ----------------------------------------
{
  const exitCode = process.exitCode;
  const { out, err } = await captured(() => warnDeprecatedDaemonEntry("supervise"));
  check("the warning is one stderr line, nothing on stdout, no exit code",
    out === "" && count(err, deprecatedDaemonEntryWarning("supervise")) === 1 && process.exitCode === exitCode,
    { out, err, exitCode: process.exitCode });
}

// ---- `up` launches a twin with the entry's parser, validation and runner ----------------------
/** A pre-cut line per twinned entry that each runner refuses before it touches a broker. */
const refusals: Record<keyof typeof DAEMON_ENTRY_TWINS | "deliver pending", string[]> = {
  supervise: ["--space", SPACE, "--server", SERVER],
  deliver: ["--space", SPACE, "--server", SERVER, "--shard", "1"],
  "deliver pending": ["pending", "scout", "--limit", "0", "--space", SPACE, "--server", SERVER],
  "auth-service": ["--space", SPACE, "--server", SERVER, "--port", "99999"],
};
for (const [entry, twinName] of Object.entries(DAEMON_ENTRY_TWINS) as [keyof typeof DAEMON_ENTRY_TWINS, string][]) {
  const command = registry.resolve<Command>("command", entry);
  const twin = registry.all<Command>("command").find((row) => row.name === twinName);
  check(`${twinName} is registered and hidden`, twin?.hidden === true);
  if (!twin) continue;
  // Same flags, positionals, usage, validate, requiredExtensions, prepare and target policy, by reference.
  const fields = [...new Set([...Object.keys(command), ...Object.keys(twin)])].filter((key) => key !== "name" && key !== "run");
  const differ = fields.filter((key) => (command as unknown as Record<string, unknown>)[key] !== (twin as unknown as Record<string, unknown>)[key]);
  check(`${twinName} declares what ${entry} declares`, differ.length === 0, differ);
  const line = lines[entry].slice(1);
  check(`${twinName} parses ${entry}'s pre-cut line as ${entry} does`,
    JSON.stringify(parseCommandArgs(twin, line)) === JSON.stringify(parseCommandArgs(command, line)));
  const modes: [DeprecatedDaemonEntry, string[]][] = entry === "deliver" ? [["deliver", line], ["deliver pending", lines["deliver pending"].slice(1)]] : [[entry, line]];
  for (const [mode, argv] of modes) {
    const args = parseCommandArgs(command, argv);
    const run = twin.run;
    let seen: unknown;
    twin.run = async (received) => { seen = received; };
    const printed = await captured(() => command.run(args)).finally(() => { twin.run = run; });
    check(`${mode} warns once and then runs ${twinName}'s runner with its arguments`,
      seen === args && printed.out === "" && count(printed.err, deprecatedDaemonEntryWarning(mode)) === 1, printed);
  }
}

// ---- Each registered entry prints it when its pre-cut line runs --------------------------------
const env: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_") || key === "INVOCATION_ID") delete env[key];
Object.assign(env, { HOME: home, USERPROFILE: home, COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: xdg, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run one line until `done` holds for its stderr or it exits, then stop it if it still runs. */
async function runLine(argv: string[], done: (stderr: string) => boolean = () => false) {
  const child = spawn(process.execPath, ["--import", TSX_LOADER, BIN, ...argv], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const running = () => child.exitCode === null && child.signalCode === null;
  const deadline = Date.now() + 90_000;
  while (running() && !done(stderr) && Date.now() < deadline) await sleep(100);
  const stopped = running();
  if (stopped) {
    child.kill("SIGTERM");
    await Promise.race([exited, sleep(15_000)]);
    if (running()) { child.kill("SIGKILL"); await exited; }
  }
  return { stdout, stderr, status: child.exitCode, stopped };
}

/** stderr without the warning line and without the manager's per-line timestamps. */
const comparable = (stderr: string, warning: string) =>
  stderr.split("\n").filter((line) => !line.includes(warning)).map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, "")).join("\n");

try {
  for (const [entry, argv] of Object.entries(lines) as [DeprecatedDaemonEntry, string[]][]) {
    const warning = deprecatedDaemonEntryWarning(entry);
    const run = await runLine(argv, (stderr) => stderr.includes(warning));
    check(`the ${entry} line prints its warning once on stderr`, run.stderr.split(warning).length === 2, run.stderr.slice(-1500));
    check(`the ${entry} line keeps the warning off stdout`, !run.stdout.includes("is deprecated and will be removed"), run.stdout.slice(-600));
  }
  // The same refusal through the entry and through its twin: one exit code, one stdout, and stderr
  // that differs only by the entry's warning line.
  for (const [mode, argv] of Object.entries(refusals) as [keyof typeof refusals, string[]][]) {
    const entry = mode === "deliver pending" ? "deliver" : mode;
    const warning = deprecatedDaemonEntryWarning(mode);
    const [publicRun, twinRun] = [await runLine([entry, ...argv]), await runLine([DAEMON_ENTRY_TWINS[entry], ...argv])];
    check(`the ${mode} refusal exits on its own through both entries`, !publicRun.stopped && !twinRun.stopped && publicRun.status !== 0, { publicRun, twinRun });
    check(`the ${mode} twin refuses with the entry's exit code and stdout`, publicRun.status === twinRun.status && publicRun.stdout === twinRun.stdout, { publicRun, twinRun });
    check(`the ${mode} twin prints no warning and the entry prints it once`,
      count(publicRun.stderr, warning) === 1 && !twinRun.stderr.includes("is deprecated and will be removed"), { publicRun: publicRun.stderr.slice(-800), twinRun: twinRun.stderr.slice(-800) });
    check(`the ${mode} twin's stderr is the entry's without the warning`,
      comparable(publicRun.stderr, warning) === comparable(twinRun.stderr, warning), { publicRun: publicRun.stderr.slice(-800), twinRun: twinRun.stderr.slice(-800) });
  }
  // Without --server the intake credential goes only to the broker its space is registered at, and
  // this sandbox registers none, so the intake refuses before it dials.
  {
    const creds = join(root, "intake.creds");
    writeFileSync(creds, "placeholder\n", { mode: 0o600 });
    const run = await runLine(["feedback-intake", "--keys", keys, "--creds", creds, "--space", SPACE, "--port", String(await freePort())]);
    check("feedback-intake with no --server refuses an unregistered space before any dial",
      !run.stopped && run.status === 1 && run.stderr.includes(`--creds needs --server <url> or a registered --space: space "${SPACE}" is not registered here, so nothing was dialed`) && !/Can't reach/.test(run.stderr),
      run.stderr.slice(-800));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

finish();
