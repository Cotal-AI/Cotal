/**
 * The CLI's anonymous usage telemetry, driven through the built binary against a local HTTP intake
 * in a sandboxed home: one `command` event per command and one `install` event per UTC day at
 * `regular`, the exact `minimal` shape, nothing at `off` and under the environment opt-outs, no
 * argument or flag value in any body, the typed error code of a refusal, `cotal telemetry` itself
 * silent, an intake that never answers adding no more than its timeout and changing no exit code,
 * the refusals of a bad `COTAL_TELEMETRY` and a malformed settings file, `ci` false under `CI=false`
 * and `CI=0`, and the one-time notice under a real pty. No broker is started.
 *
 * Run: pnpm smoke:telemetry
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "@cotal-ai/core";
import { assertSmokeSandboxDown, createSuite, listenOn, onFreePort } from "@cotal-ai/smoke-kit";
import { acquireMaintenanceLock, CommandFailure, releaseMaintenanceLock } from "@cotal-ai/workspace";
import { telemetryErrorText } from "../src/telemetry.js";
import { liveServicesRefusal } from "../src/commands/down-services.js";
import { recordedProcessRefusal } from "../src/commands/service-registry.js";
import { membershipConversionRefusal } from "../src/commands/up-stores.js";
import { clean, cotalPty, wait } from "./_console-pty.js";
import { openTelemetryIntake } from "./_telemetry-intake.js";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

const { check, finish } = createSuite();
const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR" && k !== "DO_NOT_TRACK" && k !== "CI"));
const homes: string[] = [];
const servers: Server[] = [];
process.on("exit", () => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true });
  for (const server of servers) server.close();
});

type Body = Record<string, unknown>;
const { server: intake, received, url } = await openTelemetryIntake();
servers.push(intake);
// A black hole: it accepts the connection and never answers, so the client's timeout is what ends the send.
const blackHole = createServer(() => {});
servers.push(blackHole);
const blackHolePort = await onFreePort((p) => listenOn(blackHole, p));

/** A fresh sandboxed home with its own project dir; `run` executes the built binary in it. */
function sandbox(projectName = "project") {
  const home = mkdtempSync(join(tmpdir(), "cotal-telemetry-"));
  homes.push(home);
  const project = join(home, projectName);
  mkdirSync(project);
  const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1", COTAL_TELEMETRY_URL: url, SHELL: "/bin/zsh", TERM_PROGRAM: "smoke-term" };
  const settingsPath = join(home, ".cotal", "telemetry.json");
  // Asynchronous, so the intake in this process keeps answering while the child runs.
  const run = async (args: string[], extra: Record<string, string | undefined> = {}) => {
    const before = received.length;
    const started = Date.now();
    const options = { cwd: project, env: { ...env, ...extra } };
    // This suite owns no stack. It inspects shutdown diagnostics but must never run a shutdown.
    assertSmokeSandboxDown(undefined, args, options);
    const child = spawn(process.execPath, [BIN, ...args], { ...options, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const status = await new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
    let envelope: Body | undefined;
    try { envelope = JSON.parse(stdout) as Body; } catch { envelope = undefined; }
    return { status, stdout, stderr, envelope, elapsed: Date.now() - started, sent: received.slice(before) };
  };
  const settings = () => JSON.parse(readFileSync(settingsPath, "utf8")) as Body;
  return { home, project, env, settingsPath, run, settings };
}
const shown = (r: { status: number | null; stdout: string; stderr: string }) => ({ status: r.status, stdout: r.stdout.slice(0, 400), stderr: r.stderr.slice(0, 400) });
const keysOf = (body: Body | undefined) => (body ? Object.keys(body).sort().join(",") : "");
const sameKeys = (body: Body | undefined, keys: readonly string[]) => keysOf(body) === [...keys].sort().join(",");

// Settle: the intake records a body when the request ends, which can land a tick after the child exits.
const settled = () => wait(150);

const COMMON = ["v", "installId", "level", "event", "version", "os", "arch", "node", "ci"];
const MINIMAL = [...COMMON, "command", "outcome", "exitCode", "durationMs"];
const REGULAR = [...MINIMAL, "account", "subcommand", "flags", "errorCode", "errorMessage", "errorStack", "interactive", "shell", "terminal"];
const INSTALL = [...COMMON, "account", "osRelease", "packageManager", "installMethod", "connectors", "extensions", "runtimes", "meshes", "hostedMesh", "uptimeDays"];

// ---- regular: the first command of the day sends the install event, then its own ----
{
  const s = sandbox();
  const first = await s.run(["version"]);
  await settled();
  const file = s.settings();
  check("a fresh home runs the command and creates telemetry.json at regular with a uuid id", first.status === 0 && file.level === "regular" && /^[0-9a-f-]{36}$/.test(String(file.installId)), { ...shown(first), file });
  check("the first run sends the install event, then the command event", first.sent.length === 2 && first.sent[0]!.event === "install" && first.sent[1]!.event === "command", first.sent.map((b) => b.event));
  const install = first.sent[0], command = first.sent[1];
  check("the install event has exactly the documented keys", sameKeys(install, INSTALL), keysOf(install));
  check("the install event reports this install", install?.installId === file.installId && install?.level === "regular" && install?.installMethod === "unknown" && Array.isArray(install?.connectors) && install?.meshes === 0 && install?.hostedMesh === false && install?.uptimeDays === 0, install);
  check("the command event has exactly the regular keys", sameKeys(command, REGULAR), keysOf(command));
  check("the command event names the command and its outcome", command?.command === "version" && command?.outcome === "ok" && command?.exitCode === 0 && command?.errorCode === null && command?.errorMessage === null && command?.errorStack === null && command?.subcommand === null && Array.isArray(command?.flags) && (command?.flags as unknown[]).length === 0, command);
  check("…with the platform facts", command?.os === process.platform && command?.arch === process.arch && command?.node === Number.parseInt(process.versions.node, 10) && command?.ci === false && command?.interactive === false && command?.shell === "zsh" && command?.terminal === "smoke-term" && typeof command?.version === "string" && typeof command?.durationMs === "number", command);
  check("the file records the install event's day and no notice (stderr was not a terminal)", typeof file.lastInstallEventAt === "string" && file.noticeShownAt === undefined, file);
  check("no notice is printed when stderr is not a terminal", !first.stderr.includes("Cotal collects"), shown(first));

  const second = await s.run(["ext", "list", "--json"]);
  await settled();
  check("the second command of the day sends only its command event", second.status === 0 && second.sent.length === 1 && second.sent[0]!.event === "command", second.sent.map((b) => b.event));
  check("…naming the registered subcommand and the flag", second.sent[0]?.subcommand === "list" && JSON.stringify(second.sent[0]?.flags) === JSON.stringify(["--json"]), second.sent[0]);

  // A day later, the install event is due again.
  writeFileSync(s.settingsPath, JSON.stringify({ ...s.settings(), lastInstallEventAt: new Date(Date.now() - 86_400_000).toISOString() }));
  const nextDay = await s.run(["version"]);
  await settled();
  check("a stale lastInstallEventAt sends the install event again", nextDay.sent.length === 2 && nextDay.sent[0]!.event === "install", nextDay.sent.map((b) => b.event));
}

// The desktop metadata request waits for stdin after reading the settings. A second command
// can finish first and claim today's install event without changing the desktop request's outcome.
{
  const s = sandbox();
  const before = received.length;
  const desktop = spawn(process.execPath, [BIN, "daemon", "desktop"], { cwd: s.project, env: s.env, stdio: ["pipe", "ignore", "ignore"], timeout: 30_000 });
  const exited = new Promise<number | null>((resolve, reject) => { desktop.once("error", reject); desktop.once("close", resolve); });
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(s.settingsPath) && desktop.exitCode === null && Date.now() < deadline) await wait(10);
    check("the pending desktop request read a fresh telemetry identity", existsSync(s.settingsPath) && s.settings().lastInstallEventAt === undefined && desktop.exitCode === null);
    const version = await s.run(["version"]);
    check("version claims the daily report while desktop is waiting", version.status === 0 && version.sent.some((body) => body.event === "install"));
  } finally { desktop.stdin.end('{"op":"about"}\n'); }
  const code = await exited;
  const rows = received.slice(before);
  check("overlapping commands send one install and both command events for the same id", code === 0 && rows.length === 3 && rows.filter((body) => body.event === "install").length === 1 && rows.some((body) => body.command === "version") && rows.some((body) => body.command === "daemon" && body.subcommand === "desktop") && rows.every((body) => body.installId === s.settings().installId), rows.map((body) => body.event));
}

{
  const s = sandbox();
  const prepared = await s.run(["space", "create", "lock-test", "--root", s.project, "--json"]);
  check("prepare the project for the maintenance lock refusal", prepared.status === 0);
  const held = acquireMaintenanceLock(s.project, { operation: "fixture" });
  try {
    const busy = await s.run(["up", "--space", "lock-test", "--no-manager", "--json"]);
    const event = busy.sent.find((body) => body.event === "command");
    check("a contended stack lock names the holder PID only locally", busy.status === 2 && busy.stdout.includes(`(pid ${process.pid})`)
      && event?.errorCode === "LIFECYCLE_BLOCKED" && event.errorMessage === null && event.errorStack === null);
  } finally { releaseMaintenanceLock(held); }
}

{
  const s = sandbox();
  const firstUse = acquireLock(`${s.settingsPath}.lock`);
  try {
    const busy = await s.run(["version"]);
    check("a busy first-use identity does not fail the command or mint a second id", busy.status === 0 && busy.sent.length === 0 && !existsSync(s.settingsPath));
  } finally { firstUse.release(); }
  await s.run(["telemetry", "regular"]);
  const held = acquireLock(`${s.settingsPath}.lock`);
  try {
    const busy = await s.run(["version"]);
    check("a busy daily claim leaves the command event and exit unchanged", busy.status === 0 && busy.sent.length === 1 && busy.sent[0]?.command === "version" && s.settings().lastInstallEventAt === undefined);
  } finally { held.release(); }
  const next = await s.run(["version"]);
  check("the next eligible command can claim the deferred day", next.status === 0 && next.sent.length === 2 && next.sent[0]?.event === "install");
}

{
  const s = sandbox();
  const docs = await s.run(["docs", "--json"]);
  await settled();
  check("bundled docs sends command telemetry without collecting the install inventory",
    docs.status === 0 && docs.stderr === "" && docs.envelope?.outcome === "ok" && docs.sent.length === 1 &&
    docs.sent[0]?.event === "command" && docs.sent[0]?.command === "docs" && s.settings().lastInstallEventAt === undefined,
    { ...shown(docs), events: docs.sent.map((event) => event.event) });
  const version = await s.run(["version"]);
  await settled();
  check("another command still sends the deferred install event",
    version.status === 0 && version.sent.length === 2 && version.sent[0]?.event === "install" &&
    version.sent[1]?.event === "command", version.sent.map((event) => event.event));
}

for (const level of ["regular", "minimal"]) {
  const s = sandbox();
  const replay = await s.run(["ext", "__update-add", "expected-package", "actual-package"], { COTAL_TELEMETRY: level });
  check(`an internal extension replay at ${level} keeps its refusal local and creates no install id`,
    replay.status === 1 && replay.stderr.includes("must be launched by its recorded parent") && replay.sent.length === 0 && !existsSync(s.settingsPath), shown(replay));
}

for (const level of ["regular", "minimal"]) {
  const s = sandbox();
  const r = await s.run(["ext", "remove", "not-installed"], {
    COTAL_SKIP_CONNECTOR_SEED: undefined, COTAL_ALLOW_CHECKOUT_SEED: "1", COTAL_TELEMETRY: level,
    PATH: s.project, APPDATA: s.home, LOCALAPPDATA: s.home,
  });
  const commands = r.sent.filter((body) => body.event === "command");
  check(`a seed child failed before removal at ${level}`, r.status === 1 && r.stderr.includes("failed to seed connector") && r.stderr.includes("npm install failed"), shown(r));
  check(`only the operator's command reports at ${level}`, commands.length === 1 && commands[0]?.command === "ext" && commands[0]?.exitCode === 1 && commands[0]?.outcome === "error" && (level === "minimal" ? sameKeys(commands[0], MINIMAL) : commands[0]?.subcommand === "remove"), commands.map((body) => body.subcommand));
  check(`the seed child sends no install event at ${level}`, r.sent.filter((body) => body.event === "install").length === (level === "regular" ? 1 : 0));
}

{
  const r = await sandbox().run(["ext", "add", "./missing-extension"]);
  const commands = r.sent.filter((body) => body.event === "command");
  check("an explicit extension add still reports its own failure", r.status === 1 && commands.length === 1 && commands[0]?.subcommand === "add" && commands[0]?.outcome === "error");
}

{
  const marker = "fixture-cwd-marker", s = sandbox(`working ${marker}`);
  const r = await s.run(["backup", "create", "artifact", "--store-dir=~/stores", "--json"]), event = r.sent.find(row => row.event === "command");
  const config = join(s.home, `config ${marker}`);
  mkdirSync(config); writeFileSync(join(config, "cotal"), "unchanged");
  const blocked = await s.run(["backup", "verify", "artifact", "--json"], { XDG_CONFIG_HOME: config });
  const configEvent = blocked.sent.find(row => row.event === "command");
  check("a blocked config folder stays in the local diagnostic", blocked.status === 1 && blocked.stdout.includes(marker) && readFileSync(join(config, "cotal"), "utf8") === "unchanged" &&
    configEvent?.errorCode === "SCHEMA_INVALID" && configEvent.errorMessage === null && configEvent.errorStack === null && !JSON.stringify(blocked.sent).includes(marker), shown(blocked));
  check("an unexpanded store path names the working folder only locally", r.status === 1 && r.stdout.includes(marker) && !existsSync(join(s.project, "artifact")) &&
    event?.errorCode === "USAGE_INVALID" && event.errorMessage === null && event.errorStack === null && !JSON.stringify(r.sent).includes(marker), shown(r));
}

{
  const s = sandbox(), marker = "fixture-credential-name", file = join(s.home, `ordinary ${marker}`);
  writeFileSync(file, "invalid fixture text", { mode: 0o600 });
  for (const [path, code, status] of [[file, "SCHEMA_INVALID", 1], [`${file}-missing`, "TARGET_NOT_FOUND", 2]] as const) {
    const r = await s.run(["send", "--to", "fixture", "fixture", "--server", "nats://127.0.0.1:1", "--creds", path, "--json"]);
    const event = r.sent.find(row => row.event === "command");
    check(`a credential file refusal keeps its path local for ${code}`, r.status === status && r.stdout.includes(marker) &&
      event?.errorCode === code && event.errorMessage === null && event.errorStack === null && !JSON.stringify(r.sent).includes(marker), shown(r));
  }
}

{
  const s = sandbox(), marker = "fixture-service-reference", ref = join(s.home, `sample ${marker}`);
  const executable = join(s.home, "unused.exe"), spec = join(s.project, "service.json");
  writeFileSync(executable, "fixture", { mode: 0o700 });
  writeFileSync(ref, "fixture", { mode: 0o600 });
  writeFileSync(spec, JSON.stringify({ schemaVersion: 1, space: "refcheck", launch: { type: "process", executable, args: [], cwd: s.project },
    readiness: { type: "process", timeoutMs: 10000 }, credentialRef: { kind: "file", path: ref } }));
  const created = await s.run(["space", "create", "refcheck", "--root", s.project, "--json"]);
  const added = await s.run(["service", "add", "idle", "--file", spec, "--space", "refcheck", "--json"]);
  renameSync(ref, `${ref}.saved`);
  const r = await s.run(["service", "start", "idle", "--space", "refcheck", "--json"]), event = r.sent.find(row => row.event === "command");
  check("a missing saved service credential reference names its file only locally", created.status === 0 && added.status === 0 && r.status === 2 &&
    r.stdout.includes(marker) && event?.errorCode === "TARGET_NOT_FOUND" && event.errorMessage === null && event.errorStack === null && !JSON.stringify(r.sent).includes(marker), shown(r));
}

// ---- no argument or flag value leaks, and a refusal carries its code ----
{
  const s = sandbox();
  await s.run(["version"]); // the day's install event
  await settled();
  const leak = await s.run(["status", "--space", "zq8leak", "--server=nats://wv7host:4222/xk3path"]);
  await settled();
  const body = JSON.stringify(leak.sent);
  check("a command with argument values sends one event whose body holds none of them", leak.sent.length === 1 && !/zq8leak|wv7host|xk3path|4222|nats:/.test(body), { status: leak.status, body });
  check("…only the flag names, values stripped", JSON.stringify(leak.sent[0]?.flags) === JSON.stringify(["--space", "--server"]), leak.sent[0]?.flags);
  const ps = await s.run(["ps", "--json"]);
  await settled();
  const error = ps.envelope?.error as Body | undefined;
  check("control: ps with no mesh is refused with a typed code", ps.status === 2 && ps.envelope?.outcome === "refused" && typeof error?.code === "string", shown(ps));
  check("a refused command's event carries the outcome and the typed error code", ps.sent.length === 1 && ps.sent[0]?.outcome === "refused" && ps.sent[0]?.errorCode === error?.code && ps.sent[0]?.exitCode === 2, ps.sent[0]);
  check("…and the refusal's message, with no path in it", typeof ps.sent[0]?.errorMessage === "string" && (ps.sent[0]!.errorMessage as string).length > 0 && !(ps.sent[0]!.errorMessage as string).includes(s.home) && !/\/[\w.-]+\/[\w.-]+/.test(ps.sent[0]!.errorMessage as string), ps.sent[0]?.errorMessage);
  check("…and a stack whose frames name no directory outside node_modules", typeof ps.sent[0]?.errorStack === "string" && /^at /.test(ps.sent[0]!.errorStack as string) && !(ps.sent[0]!.errorStack as string).includes(s.home) && !/\(\/|\(file:/.test(ps.sent[0]!.errorStack as string), ps.sent[0]?.errorStack);
  const marker = "fixture-setup-value", file = join(s.project, `ordinary ${marker}`);
  writeFileSync(file, "unchanged");
  for (const flag of ["destination", "runtime", "project"] as const) {
    const options = { destination: "local", runtime: "pty", project: s.project, harness: "codex", space: "setup-check", [flag]: flag === "project" ? file : marker };
    const r = await s.run(["setup", "--json", ...Object.entries(options).flatMap(([key, value]) => [`--${key}`, value])]);
    const event = r.sent.find(body => body.event === "command");
    check(`setup keeps the rejected --${flag} value local`, r.status === 1 && r.stdout.includes(marker) && event?.errorCode === "USAGE_INVALID" &&
      event.errorMessage === null && event.errorStack === null && !JSON.stringify(r.sent).includes(marker) && readFileSync(file, "utf8") === "unchanged", shown(r));
  }
  const watch = await s.run(["watch", "--json", "--space", "absent-watch-fixture"]);
  const records = watch.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const event = watch.sent[0];
  check("the JSON watch refusal reports its stream code without sending the stream diagnostic",
    watch.status === 2 && records.length === 2 && records[0]?.type === "error" && records[0]?.data?.code === "TARGET_NOT_FOUND" && records[1]?.type === "end"
    && watch.sent.length === 1 && event?.command === "watch" && event.outcome === "refused" && event.errorCode === records[0].data.code
    && event.errorMessage === null && event.errorStack === null && !JSON.stringify(event).includes("absent-watch-fixture"));
  const usage = await s.run(["ext", "frobnicate"]);
  await settled();
  check("a usage refusal is an event too: refused, USAGE_INVALID, exit 1", usage.status === 1 && usage.sent.length === 1 && usage.sent[0]?.outcome === "refused" && usage.sent[0]?.errorCode === "USAGE_INVALID" && usage.sent[0]?.subcommand === null, { ...shown(usage), sent: usage.sent });
  check("…whose message masks the unknown word the user typed", typeof usage.sent[0]?.errorMessage === "string" && !(usage.sent[0]!.errorMessage as string).includes("frobnicate") && (usage.sent[0]!.errorMessage as string).includes("<value>"), usage.sent[0]?.errorMessage);
  for (const path of [[], ["ext"]]) {
    const help = await s.run(["help", ...path, "frobnicate"]);
    await settled();
    const event = help.sent[0];
    check(`unknown ${path.length ? "subcommand" : "command"} in help keeps the requested topic local`,
      help.status === 1 && help.stderr.includes(path.length ? 'no subcommand "frobnicate"' : "unknown command: frobnicate") && help.sent.length === 1
      && event?.command === "help" && event.outcome === "refused" && event.errorCode === "USAGE_INVALID" && event.errorMessage === null && event.errorStack === null
      && !JSON.stringify(help.sent).includes("frobnicate"), shown(help));
  }
  const channels = ["fixture-news", "fixture-sales", "fixture-finance"];
  const outside = await s.run(["spawn", "--dry-run", "--json", "--subscribe", channels[0]!, "--allow-subscribe", channels.slice(1).join(",")]);
  const reported = outside.sent[0];
  check("a rejected subscription shows the channels locally but sends only the reason",
    outside.status === 1 && channels.every(name => outside.stdout.includes(name) && !JSON.stringify(outside.sent).includes(name)) &&
    outside.sent.length === 1 && reported?.errorCode === "USAGE_INVALID" && reported.errorMessage === "subscription is not within allowSubscribe", shown(outside));
  const prompt = "private `prompt` text";
  const spawn = await s.run(["spawn", "-d", "--on=", "--prompt", prompt]);
  await settled();
  check("a spawn pin refusal shows its retry locally but sends neither its message nor its stack",
    spawn.status === 1 && spawn.stderr.includes(prompt) && spawn.sent.length === 1 && spawn.sent[0]?.errorCode === "USAGE_INVALID"
    && spawn.sent[0]?.errorMessage === null && spawn.sent[0]?.errorStack === null, { ...shown(spawn), sent: spawn.sent });
  const terminalText = "fixture-terminal-text";
  const inputArgs = ["input", "--name", "fixture-agent", "--no-enter", "--json"];
  const empty = await s.run(inputArgs);
  const emptyEvent = empty.sent.find(body => body.event === "command");
  check("unpinned missing text reports the equals form for a dash-leading value", empty.status === 1 && empty.stdout.includes("--text=<value>") &&
    emptyEvent?.errorCode === "USAGE_INVALID" && String(emptyEvent.errorMessage).includes("--text=<value>"));
  const input = await s.run([...inputArgs, `--text=--${terminalText}`, "--on="]);
  const inputEvent = input.sent.find(body => body.event === "command");
  check("an input pin retry keeps the terminal text local", input.status === 1 && input.stdout.includes(`--text=--${terminalText}`) &&
    inputEvent?.errorCode === "USAGE_INVALID" && inputEvent.errorMessage === null && inputEvent.errorStack === null && !JSON.stringify(input.sent).includes(terminalText), shown(input));
  const unknown = await s.run(["frobnicate"]);
  await settled();
  check("an unknown command word names no command and sends nothing", unknown.status === 1 && unknown.sent.length === 0, shown(unknown));
}

{
  const s = sandbox(), space = "private-preset-fixture";
  const marker = "private-root-fixture", file = join(s.project, `regular file ${marker}`);
  writeFileSync(file, "original");
  if (process.platform !== "win32") {
    const link = join(s.project, `contract ${marker}.json`);
    symlinkSync(file, link);
    const denied = await s.run(["endpoint", "check", link, "--json"]), event = denied.sent.find(body => body.event === "command");
    check("a refused contract link is named only locally", denied.status === 2 && denied.stdout.includes(marker) && readFileSync(file, "utf8") === "original"
      && event?.errorCode === "PERMISSION_DENIED" && event.errorMessage === null && event.errorStack === null && !JSON.stringify(denied.sent).includes(marker), shown(denied));
  }
  const incomplete = join(s.project, `unfinished ${marker}`);
  mkdirSync(incomplete); writeFileSync(join(incomplete, "checkpoints.json"), "[]");
  for (const mode of ["inspect", "verify"]) {
    for (const path of [file, join(s.project, `missing ${marker}`), incomplete]) {
      const r = await s.run(["backup", mode, path, "--json"]), event = r.sent.find(body => body.event === "command");
      check(`backup ${mode} keeps its rejected artifact path local`, r.status === (path === incomplete ? 1 : 2) && r.stdout.includes(marker) &&
        event?.errorCode === (path === incomplete ? "SCHEMA_INVALID" : "TARGET_NOT_FOUND") && event.errorMessage === null && event.errorStack === null && !JSON.stringify(r.sent).includes(marker), shown(r));
    }
  }
  const invalid = await s.run(["space", "create", space, "--root", file, "--json"]);
  const commands = invalid.sent.filter(body => body.event === "command");
  check("a non-directory project root stays in the local remedy", invalid.status === 1 && invalid.stdout.includes(marker) && readFileSync(file, "utf8") === "original"
    && commands.length === 1 && commands[0]?.errorCode === "USAGE_INVALID" && commands[0]?.errorMessage === "the project root is not a directory" && !JSON.stringify(invalid.sent).includes(marker), shown(invalid));
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const root = join(s.project, `read-only ${marker}`);
    mkdirSync(root, { mode: 0o500 });
    const denied = await s.run(["space", "create", space, "--root", root, "--json"]), event = denied.sent.find(body => body.event === "command");
    check("an unwritable project is named only in the local preparation refusal", denied.status === 2 && denied.stdout.includes(root) && !existsSync(join(root, ".cotal")) &&
      event?.errorCode === "PERMISSION_DENIED" && event.errorMessage === null && event.errorStack === null && !JSON.stringify(denied.sent).includes(marker), shown(denied));
    const store = join(root, "store");
    for (const args of [["up"], ["backup", "restore", "artifact"]]) {
      const r = await s.run([...args, "--store-dir", store, "--json"]), reported = r.sent.find(body => body.event === "command");
      check(`${args.join(" ")} keeps an unwritable store parent local`, r.status === 2 && r.stdout.includes(store) && !existsSync(store) &&
        reported?.errorCode === "PERMISSION_DENIED" && reported.errorMessage === null && reported.errorStack === null && !JSON.stringify(r.sent).includes(marker), shown(r));
    }
  }
  const add = await s.run(["space", "add", space, "--server", "nats://127.0.0.1:1", "--root", file, "--json"]);
  const addEvent = add.sent.find(body => body.event === "command");
  check("a refused registration root stays local", add.status === 1 && add.stdout.includes(marker) && addEvent?.errorCode === "USAGE_INVALID" && addEvent.errorMessage === "--root must name an existing directory" && !JSON.stringify(add.sent).includes(marker), shown(add));
  for (const path of [file, join(file, "child")]) {
    const r = await s.run(["up", "--store-dir", path, "--server", "nats://127.0.0.1:1", "--json"]), event = r.sent.find(body => body.event === "command");
    check("a file in the requested store path is named only locally", r.status === 1 && r.stdout.includes(marker) && readFileSync(file, "utf8") === "original"
      && event?.errorCode === "USAGE_INVALID" && event.errorMessage === null && event.errorStack === null && !JSON.stringify(r.sent).includes(marker), shown(r));
  }
  const blockedStore = join(s.project, `private ${marker}`, ".cotal", "data");
  for (const args of [["up"], ["backup", "restore", "artifact"], ["up", "--restore", "artifact"]]) {
    const r = await s.run([...args, "--store-dir", blockedStore, "--json"]), event = r.sent.find(body => body.event === "command");
    check(`${args.join(" ")} keeps a refused control-directory store local`, r.status === 1 && r.stdout.includes(marker) && !existsSync(blockedStore) &&
      event?.errorCode === "USAGE_INVALID" && event.errorMessage === null && event.errorStack === null && !JSON.stringify(r.sent).includes(marker), shown(r));
  }
  const records = join(s.home, ".cotal", "meshes"), record = join(records, "relative.json");
  mkdirSync(records, { recursive: true });
  const legacy = JSON.stringify({ space: "relative", root: `../folder ${marker}`, origin: "up", mode: "auth", server: "nats://127.0.0.1:4222", ts: new Date(0).toISOString() });
  writeFileSync(record, legacy, { mode: 0o600 });
  const claim = await s.run(["up", "--detach", "--no-manager", "--space", "relative", "--server", "nats://127.0.0.1:4222"]), claimEvent = claim.sent.find(body => body.event === "command");
  check("a relative registration path stays local and the claim leaves the record intact", claim.status === 2 && claim.stderr.includes(marker) && readFileSync(record, "utf8") === legacy
    && claimEvent?.errorCode === "CONFLICT" && claimEvent.errorMessage === null && claimEvent.errorStack === null && !JSON.stringify(claim.sent).includes(marker), shown(claim));
  const odd = join(s.project, `tab\tfolder ${marker}`);
  const refused = await s.run(["space", "create", space, "--root", odd, "--json"]);
  const reported = refused.sent.filter(body => body.event === "command");
  check("a project path with a control character is named only locally", refused.status === 1 && refused.stdout.includes(marker) && refused.stdout.includes("a tab") && !existsSync(odd)
    && reported.length === 1 && reported[0]?.errorCode === "USAGE_INVALID" && reported[0].errorMessage === null && reported[0].errorStack === null && !JSON.stringify(refused.sent).includes(marker), shown(refused));
  const prepared = await s.run(["space", "create", space, "--root", s.project, "--json"], { DO_NOT_TRACK: "1" });
  const badPersona = join(s.project, `sample ${marker}.md`);
  writeFileSync(badPersona, "---\nname: [unfinished\n---\n");
  const preview = await s.run(["spawn", "--foreground", "--dry-run", "--space", space, "--file", badPersona, "--json"]);
  const invalidPersona = preview.sent.find(body => body.event === "command");
  check("a malformed foreground persona stays in the local preview diagnostic", prepared.status === 0 && preview.status === 1 &&
    preview.stdout.includes(badPersona) && invalidPersona?.errorCode === "SCHEMA_INVALID" && invalidPersona.errorMessage === null &&
    invalidPersona.errorStack === null && !JSON.stringify(preview.sent).includes(marker), shown(preview));
  const other = "fixture-tenant-marker", store = join(s.project, `store ${marker}`), stream = `CHAT_${other}`;
  mkdirSync(join(store, "jetstream", "$G", "streams", stream), { recursive: true, mode: 0o700 });
  const occupied = await s.run(["up", "--space", space, "--store-dir", store, "--server", "nats://127.0.0.1:1", "--open", "--no-manager", "--json"]);
  const conflict = occupied.sent.find(body => body.event === "command");
  check("startup keeps the shared store and its other tenant local", occupied.status === 2 && occupied.stdout.includes(store) && occupied.stdout.includes(stream) &&
    conflict?.errorCode === "CONFLICT" && conflict.errorMessage === null && conflict.errorStack === null && ![marker, other].some(text => JSON.stringify(occupied.sent).includes(text)), shown(occupied));
  const absent = "private-absent-fixture", unknown = await s.run(["use", absent, "--plain"]);
  const event = unknown.sent.find(body => body.event === "command");
  check("a refused selection lists known spaces only on this machine", unknown.status === 2 && unknown.stderr.includes(space) && unknown.stderr.includes(absent)
    && event?.errorCode === "TARGET_NOT_FOUND" && event.errorMessage === null && event.errorStack === null && ![space, absent].some(name => JSON.stringify(unknown.sent).includes(name)), shown(unknown));
  for (const mode of ["status", "logs"]) {
    const r = await s.run(["manager", mode, "--space", space, "--json"], { COTAL_TELEMETRY: "regular" });
    const commands = r.sent.filter(body => body.event === "command"), event = commands[0];
    check(`an unstarted manager's ${mode} refusal keeps the space local`, prepared.status === 0 && r.status === 2 && r.stdout.includes(space)
      && commands.length === 1 && event?.outcome === "refused" && event.errorCode === "TARGET_NOT_FOUND" && event.errorMessage === null
      && event.errorStack === null && !JSON.stringify(r.sent).includes(space), shown(r));
  }
}

{
  const s = sandbox(), marker = "private-conflict-fixture", root = join(s.project, `folder ${marker}`);
  const made = await s.run(["space", "create", "existing", "--root", root], { DO_NOT_TRACK: "1" });
  for (const [name, at] of [["existing", s.project], ["another", root]] as const) {
    const r = await s.run(["space", "create", name, "--root", at, "--json"]), event = r.sent.find(body => body.event === "command");
    check(`preparation conflict for ${name} keeps the existing path local`, made.status === 0 && r.status === 2 && r.stdout.includes(marker) && r.stdout.includes("space show existing --json")
      && event?.errorCode === "CONFLICT" && event.errorMessage === null && event.errorStack === null && !JSON.stringify(r.sent).includes(marker), shown(r));
  }
  const nested = await s.run(["space", "create", "nested", "--root", join(root, ".cotal"), "--json"]), blocked = nested.sent.find(body => body.event === "command");
  check("a control folder is named locally without sending its path", nested.status === 2 && nested.stdout.includes(marker) && blocked?.errorCode === "CONFLICT"
    && blocked.errorMessage === null && blocked.errorStack === null && !JSON.stringify(nested.sent).includes(marker), shown(nested));
  const seed = await s.run(["space", "create", "checkout", "--root", root, "--json"], { XDG_CONFIG_HOME: join(s.home, `config ${marker}`), COTAL_SKIP_CONNECTOR_SEED: undefined, COTAL_ALLOW_CHECKOUT_SEED: undefined });
  const denied = seed.sent.find(body => body.event === "command");
  check("a refused checkout writer keeps the seed store and executable local", seed.status === 2 && seed.stdout.includes(marker) && denied?.errorCode === "DEPENDENCY_UNAVAILABLE"
    && denied.errorMessage === null && denied.errorStack === null && !JSON.stringify(seed.sent).includes(marker), shown(seed));
  const missing = await s.run(["spawn", "absent", "--dry-run", "--space", "existing", "--json"]), miss = missing.sent.find(body => body.event === "command");
  check("a missing launch persona shows the catalog only locally", missing.status === 2 && missing.stdout.includes(marker) && missing.stdout.includes("persona --space existing --json")
    && miss?.errorCode === "TARGET_NOT_FOUND" && miss.errorMessage === null && miss.errorStack === null && !JSON.stringify(missing.sent).includes(marker), shown(missing));
  const stopped = await s.run(["channel", "show", "general", "--space", "existing", "--json"]), target = stopped.sent.find(body => body.event === "command");
  check("a connection refusal for an unstarted project keeps the restart folder local", stopped.status === 2 && stopped.stdout.includes(marker)
    && target?.errorCode === "TARGET_UNAVAILABLE" && target.errorMessage === null && target.errorStack === null && !JSON.stringify(stopped.sent).includes(marker), shown(stopped));
  const selected = await s.run(["use", "existing"], { DO_NOT_TRACK: "1" });
  renameSync(root, `${root}-parked`);
  const moved = await s.run(["up", "--open", "--server", "nats://127.0.0.1:1", "--json"]), event = moved.sent.find(body => body.event === "command");
  check("an unavailable selected project is named locally but omitted from the startup event", selected.status === 0 && moved.status === 2 && moved.stdout.includes(marker)
    && event?.errorCode === "TARGET_UNAVAILABLE" && event.errorMessage === null && event.errorStack === null && !JSON.stringify(moved.sent).includes(marker), shown(moved));
}

for (const level of ["regular", "minimal"]) {
  const s = sandbox();
  const r = await s.run(["status", "--components", "--space", "missing-fixture-space"], { COTAL_TELEMETRY: level });
  const events = r.sent.filter((body) => body.event === "command");
  const event = events[0];
  check(`a refused component target reports refused at ${level}`, r.status === 3 && /target\s+refused/.test(r.stdout) && events.length === 1 && event?.outcome === "refused" && event.exitCode === 3);
  check(`component facts stay local at ${level}`, !JSON.stringify(events).includes("missing-fixture-space") && (level === "regular"
    ? sameKeys(event, REGULAR) && event?.errorCode === null && event.errorMessage === null && event.errorStack === null : sameKeys(event, MINIMAL)));
}

{
  const space = "private-project";
  for (const code of ["TARGET_NOT_FOUND", "TARGET_UNAVAILABLE"] as const) {
    const message = `no manager matches the pin in ${space}`;
    const failure = new CommandFailure("refused", code, message, { target: { space, requestedManagerInstance: "fixture-id" } });
    const text = telemetryErrorText("ps", failure);
    check(`a missing Manager pin keeps its ${code} diagnostic local`, text.message === null && text.stack === null && failure.message === message);
    const other = new CommandFailure("refused", code, "no available target", { target: { space } });
    check(`an unpinned ${code} diagnostic still reports its reason`, telemetryErrorText("ps", other).message === other.message);
  }
  const recorded = recordedProcessRefusal("manager", { pid: 3123, label: "Manager" }, space, "stop");
  const refused = telemetryErrorText("down", recorded);
  check("a service control refusal names the process locally only", recorded.code === "UNSUPPORTED" && recorded.message.includes(space) && recorded.message.includes("3123") && refused.message === null && refused.stack === null);
  const service = liveServicesRefusal(space, [{ definition: "fixture-worker", instanceId: "fixture-instance", host: "fixture-host", process: "running", recordedState: "running", action: "stop-first", reason: null, remedy: null }], "down --preserve-state");
  const blocked = telemetryErrorText("down", service);
  check("a service blocking shutdown is identified locally but not in telemetry", service?.code === "LIFECYCLE_BLOCKED" && service.message.includes("fixture-worker instance fixture-instance") && blocked.message === null && blocked.stack === null);
  const failure = membershipConversionRefusal(space);
  const text = telemetryErrorText("up", failure);
  check("a legacy membership refusal keeps the space in its local target but out of the reported diagnostic",
    JSON.stringify(failure.target) === JSON.stringify({ space }) && text.message?.includes("legacy File-backed membership store") === true && !JSON.stringify(text).includes(space));
}

// Native spawn diagnostics can contain arbitrary terminal output, even without quotes or paths.
{
  const message = "sample seat exited on launch: ordinary terminal output";
  const failure = new CommandFailure("failed", "OPERATION_FAILED", message, { native: { code: "failed" } });
  const text = telemetryErrorText("spawn", failure);
  check("native spawn messages and stacks stay local", text.message === null && text.stack === null && failure.message === message);
  const usage = telemetryErrorText("spawn", new CommandFailure("refused", "USAGE_INVALID", "expected a flag"));
  check("local spawn usage errors still carry masked diagnostics", usage.message === "expected a flag" && typeof usage.stack === "string");
}

{
  const message = 'no managed agent "fixture-agent" on manager fixture-instance';
  const failure = new CommandFailure("refused", "TARGET_NOT_FOUND", message, { native: { code: "not-found" } });
  const text = telemetryErrorText("attach", failure);
  check("an attach miss reported by a manager keeps the agent and instance local", text.message === null && text.stack === null && failure.message === message);
  const usage = telemetryErrorText("attach", new CommandFailure("refused", "USAGE_INVALID", "name the agent"));
  check("an attach usage refusal still reports its diagnostic", usage.message === "name the agent" && typeof usage.stack === "string");
}

// ---- minimal ----
{
  const s = sandbox();
  const r = await s.run(["version"], { COTAL_TELEMETRY: "minimal" });
  await settled();
  check("COTAL_TELEMETRY=minimal sends one command event and no install event", r.status === 0 && r.sent.length === 1 && r.sent[0]!.event === "command", r.sent.map((b) => b.event));
  check("…with exactly the minimal keys", sameKeys(r.sent[0], MINIMAL) && r.sent[0]?.level === "minimal", keysOf(r.sent[0]));
  check("…and the install id of the file the environment override still uses", r.sent[0]?.installId === s.settings().installId, r.sent[0]);
  const viaFile = sandbox();
  const set = await viaFile.run(["telemetry", "minimal"]);
  await settled();
  const then = await viaFile.run(["version"]);
  await settled();
  check("cotal telemetry minimal writes the file and sends nothing itself", set.status === 0 && set.sent.length === 0 && viaFile.settings().level === "minimal", shown(set));
  check("the next command sends the minimal shape", then.sent.length === 1 && sameKeys(then.sent[0], MINIMAL), keysOf(then.sent[0]));
}

// ---- off, by file and by environment ----
{
  const s = sandbox();
  for (const extra of [{ COTAL_TELEMETRY: "off" }, { DO_NOT_TRACK: "1" }, { DO_NOT_TRACK: "true" }, { COTAL_TELEMETRY_DISABLED: "1" }]) {
    const r = await s.run(["version"], extra);
    await settled();
    check(`${Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(" ")} sends nothing and creates no settings file`, r.status === 0 && r.sent.length === 0 && !existsSync(s.settingsPath), shown(r));
  }
  const status = await s.run(["telemetry", "--json"], { DO_NOT_TRACK: "1" });
  const plainStatus = await s.run(["telemetry", "--plain"], { DO_NOT_TRACK: "1" });
  await settled();
  const result = status.envelope?.result as Body | undefined;
  check("cotal telemetry under DO_NOT_TRACK reports off and preserves the valid intake URL in JSON and plain text without sending", status.status === 0 && status.sent.length === 0 && result?.level === "off" && result?.source === "DO_NOT_TRACK" && result?.installId === null && result?.url === url && plainStatus.status === 0 && plainStatus.sent.length === 0 && /level:\s+off/.test(plainStatus.stdout) && plainStatus.stdout.includes(url), { json: shown(status), plain: shown(plainStatus), result });

  // Under an environment opt-out the file is neither read nor created, so a level saves nothing.
  for (const extra of [{ DO_NOT_TRACK: "1" }, { COTAL_TELEMETRY_DISABLED: "1" }, { COTAL_TELEMETRY: "off" }]) {
    const [name] = Object.keys(extra);
    const r = await s.run(["telemetry", "minimal", "--json"], extra);
    await settled();
    const warning = (r.envelope?.warnings as Body[] | undefined)?.[0];
    check(`cotal telemetry minimal under ${name} saves nothing and creates no file: a no-op with ENVIRONMENT_OPT_OUT`,
      r.status === 0 && r.sent.length === 0 && r.envelope?.outcome === "no-op" && warning?.code === "ENVIRONMENT_OPT_OUT" && /minimal was not saved/.test(String(warning?.message)) && !existsSync(s.settingsPath), shown(r));
  }
  const text = await s.run(["telemetry", "regular"], { DO_NOT_TRACK: "1" });
  check("…and the text report says on stderr that the level was not saved", text.status === 0 && /DO_NOT_TRACK keeps telemetry off and the settings file untouched, so regular was not saved/.test(text.stderr) && !existsSync(s.settingsPath), shown(text));

  const off = await s.run(["telemetry", "off"]);
  await settled();
  const after = await s.run(["version"]);
  await settled();
  check("cotal telemetry off writes level off", off.status === 0 && off.sent.length === 0 && s.settings().level === "off", shown(off));
  check("after cotal telemetry off, a command sends nothing", after.status === 0 && after.sent.length === 0, shown(after));
  const again = await s.run(["telemetry", "off", "--json"]);
  check("setting the level the file already holds is a no-op", again.status === 0 && again.envelope?.outcome === "no-op", shown(again));
  const held = readFileSync(s.settingsPath, "utf8");
  const forced = await s.run(["telemetry", "regular", "--json"], { DO_NOT_TRACK: "1" });
  check("under DO_NOT_TRACK an existing settings file is left as it was", forced.status === 0 && forced.envelope?.outcome === "no-op" && readFileSync(s.settingsPath, "utf8") === held, shown(forced));
  const on = await s.run(["telemetry", "on", "--json"]);
  const onResult = on.envelope?.result as Body | undefined;
  check("cotal telemetry on is regular, and reports the file as the source with the install id", on.status === 0 && onResult?.level === "regular" && onResult?.source === "file" && onResult?.installId === s.settings().installId, { ...shown(on), onResult });
  const status2 = await s.run(["telemetry"]);
  await settled();
  check("the bare report prints the level, its source and the URL, and sends nothing", status2.status === 0 && status2.sent.length === 0 && /regular/.test(status2.stdout) && /settings file/.test(status2.stdout) && status2.stdout.includes(url), shown(status2));
}

// ---- the run that creates the settings file changed it, even at the default level ----
for (const { level, extra, name } of [
  { level: "regular", extra: {}, name: "cotal telemetry regular" },
  { level: "on", extra: {}, name: "cotal telemetry on" },
  { level: "regular", extra: { COTAL_TELEMETRY: "minimal" }, name: "cotal telemetry regular under COTAL_TELEMETRY=minimal" },
]) {
  const s = sandbox();
  const first = await s.run(["telemetry", level, "--json"], extra);
  check(`${name} with no settings file creates it at regular and reports ok, not no-op`, first.status === 0 && first.envelope?.outcome === "ok" && existsSync(s.settingsPath) && s.settings().level === "regular", shown(first));
  const again = await s.run(["telemetry", level, "--json"], extra);
  check(`…and ${name} again is a no-op`, again.status === 0 && again.envelope?.outcome === "no-op", shown(again));
}

// ---- refusals: a bad COTAL_TELEMETRY and a malformed settings file ----
{
  const s = sandbox();
  const bogus = await s.run(["version", "--json"], { COTAL_TELEMETRY: "bogus" });
  await settled();
  check("COTAL_TELEMETRY=bogus refuses USAGE_INVALID before the command runs, sending nothing", bogus.status === 1 && bogus.sent.length === 0 && bogus.envelope?.outcome === "refused" && (bogus.envelope?.error as Body | undefined)?.code === "USAGE_INVALID" && /COTAL_TELEMETRY must be off, minimal or regular/.test(String((bogus.envelope?.error as Body | undefined)?.message)) && bogus.stderr === "", shown(bogus));
  const bogusTelemetry = await s.run(["telemetry"], { COTAL_TELEMETRY: "bogus" });
  check("…and cotal telemetry itself refuses it the same way", bogusTelemetry.status === 1 && /COTAL_TELEMETRY must be off, minimal or regular/.test(bogusTelemetry.stderr), shown(bogusTelemetry));
  for (const intakeUrl of ["not-a-url", "ftp://127.0.0.1/v1/telemetry"]) {
    const badUrl = await s.run(["version", "--json"], { COTAL_TELEMETRY_URL: intakeUrl });
    check(`COTAL_TELEMETRY_URL=${intakeUrl} refuses USAGE_INVALID before the command runs`, badUrl.status === 1 && badUrl.envelope?.outcome === "refused" && (badUrl.envelope?.error as Body | undefined)?.code === "USAGE_INVALID" && /COTAL_TELEMETRY_URL must be an http or https URL/.test(JSON.stringify(badUrl.envelope)), shown(badUrl));
  }
  const unusedUrl = await s.run(["version"], { COTAL_TELEMETRY_URL: "not-a-url", DO_NOT_TRACK: "1" });
  check("a command runs with an invalid intake URL when nothing is sent to it", unusedUrl.status === 0, shown(unusedUrl));
  mkdirSync(join(s.home, ".cotal"), { recursive: true });
  writeFileSync(s.settingsPath, '{"v":1,"level":"loud"}');
  const malformed = await s.run(["version"]);
  await settled();
  check("a malformed telemetry.json refuses SCHEMA_INVALID, sends nothing, and is left as it was", malformed.status === 1 && malformed.sent.length === 0 && /telemetry settings file .* is invalid/.test(malformed.stderr) && readFileSync(s.settingsPath, "utf8") === '{"v":1,"level":"loud"}', shown(malformed));
  // An environment opt-out reads no settings file, so the malformed one stops nothing there.
  for (const extra of [{ DO_NOT_TRACK: "1" }, { COTAL_TELEMETRY: "off" }]) {
    const optedOut = await s.run(["version"], extra);
    await settled();
    check(`under ${Object.keys(extra)[0]} a malformed telemetry.json stops nothing, and is left as it was`, optedOut.status === 0 && optedOut.sent.length === 0 && readFileSync(s.settingsPath, "utf8") === '{"v":1,"level":"loud"}', shown(optedOut));
  }
}

// ---- an invalid intake cannot block off or a report of off ----
{
  const s = sandbox();
  const bad = { COTAL_TELEMETRY_URL: "ftp://localhost/telemetry" };
  const optedOut = { ...bad, DO_NOT_TRACK: "1" };
  const status = await s.run(["telemetry", "--plain"], optedOut);
  check("status under DO_NOT_TRACK reports off without displaying the invalid intake", status.status === 0 && /level:\s+off/.test(status.stdout) && !status.stdout.includes("sent to:") && !existsSync(s.settingsPath), shown(status));
  const noop = await s.run(["telemetry", "off", "--json"], optedOut);
  check("off under DO_NOT_TRACK is a no-op without creating a file even with an invalid intake", noop.status === 0 && noop.envelope?.outcome === "no-op" && (noop.envelope.warnings as Body[] | undefined)?.[0]?.code === "ENVIRONMENT_OPT_OUT" && !existsSync(s.settingsPath), shown(noop));

  const active = await s.run(["telemetry", "--json"], bad);
  check("status at the default active level refuses the invalid intake before creating settings", active.status === 1 && (active.envelope?.error as Body | undefined)?.code === "USAGE_INVALID" && !existsSync(s.settingsPath), shown(active));
  const off = await s.run(["telemetry", "off", "--json"], { ...bad, COTAL_TELEMETRY: "minimal" });
  const result = off.envelope?.result as Body | undefined;
  check("off saves the file despite an invalid intake and still reports the environment's level", off.status === 0 && result?.level === "minimal" && result?.source === "COTAL_TELEMETRY" && result?.url === null && s.settings().level === "off", shown(off));
  const savedOff = await s.run(["telemetry", "--json"], bad);
  const saved = savedOff.envelope?.result as Body | undefined;
  check("status also reports off from the file despite the invalid intake", savedOff.status === 0 && saved?.level === "off" && saved?.source === "file" && saved?.url === null, shown(savedOff));
  const enable = await s.run(["telemetry", "regular", "--json"], bad);
  check("enabling still refuses the invalid intake and leaves the file off", enable.status === 1 && (enable.envelope?.error as Body | undefined)?.code === "USAGE_INVALID" && s.settings().level === "off", shown(enable));
}

// ---- an intake that never answers, and one that is not there ----
{
  const s = sandbox();
  // The bound is the send timeout; the slack is for a loaded host, where a bare `version` itself
  // varies by seconds, so the baseline is the faster of two runs.
  const baseline = Math.min(...[await s.run(["version"], { COTAL_TELEMETRY: "off" }), await s.run(["version"], { COTAL_TELEMETRY: "off" })].map((r) => r.elapsed));
  const hole = await s.run(["version"], { COTAL_TELEMETRY_URL: `http://127.0.0.1:${blackHolePort}/v1/telemetry` });
  check("an intake that never answers changes no exit code and adds no more than the 1.5 s timeout (with slack)", hole.status === 0 && hole.elapsed - baseline < 4_000, { baseline, hole: hole.elapsed, status: hole.status });
  const refused = await s.run(["ext", "list", "--json"], { COTAL_TELEMETRY_URL: "http://127.0.0.1:9/v1/telemetry" });
  check("an intake that refuses the connection changes nothing: same exit code, same stdout document, silent stderr", refused.status === 0 && refused.envelope?.command === "ext" && refused.stderr === "", shown(refused));
}

// ---- the one-time notice, under a real pty ----
{
  const s = sandbox();
  const ptyRun = async (): Promise<string> => {
    let out = "";
    const p = cotalPty(["version"], { cwd: s.project, env: { ...s.env, PATH: process.env.PATH ?? "", TERM: "xterm-256color" } as Record<string, string> });
    p.onData((d) => (out += d));
    await new Promise<void>((resolve) => p.onExit(() => resolve()));
    return clean(out);
  };
  const first = await ptyRun();
  await settled();
  const notice = 'Cotal collects anonymous usage data at the "regular" level';
  check("the first interactive run prints the notice once, before the command's output", first.includes(notice) && first.indexOf(notice) < first.indexOf("cotal-ai ") && first.split("Cotal collects").length === 2, first.slice(0, 600));
  check("…and records it in the settings file", typeof s.settings().noticeShownAt === "string", s.settings());
  const second = await ptyRun();
  check("the second interactive run prints no notice", !second.includes("Cotal collects"), second.slice(0, 300));
  const minimal = sandbox();
  await minimal.run(["telemetry", "minimal"]);
  let out = "";
  const p = cotalPty(["version"], { cwd: minimal.project, env: { ...minimal.env, PATH: process.env.PATH ?? "", TERM: "xterm-256color" } as Record<string, string> });
  p.onData((d) => (out += d));
  await new Promise<void>((resolve) => p.onExit(() => resolve()));
  check("no notice at minimal", !clean(out).includes("Cotal collects") && minimal.settings().noticeShownAt === undefined, clean(out).slice(0, 300));
}

// ---- the ci field: CI set to anything but 0 or false, so a script that says CI=false is not CI ----
{
  const s = sandbox();
  await s.run(["version"]); // the day's install event
  await settled();
  for (const [value, ci] of [["true", true], ["1", true], ["woodpecker", true], ["false", false], ["FALSE", false], ["0", false], ["", false]] as const) {
    const r = await s.run(["version"], { CI: value });
    await settled();
    check(`CI=${JSON.stringify(value)} sends ci ${ci}`, r.status === 0 && r.sent.length === 1 && r.sent[0]?.ci === ci, r.sent[0]?.ci);
  }
}

// ---- one install id per OS user: COTAL_HOME does not move the settings file ----
{
  const s = sandbox();
  const first = await s.run(["version"]);
  await settled();
  const elsewhere = join(s.home, "workspace-home");
  const moved = await s.run(["version"], { COTAL_HOME: elsewhere });
  await settled();
  check("a command under another COTAL_HOME reads the home's settings file and sends the same install id", first.status === 0 && moved.status === 0 && moved.sent.length === 1 && moved.sent[0]?.installId === s.settings().installId, { first: first.sent[0]?.installId, moved: moved.sent[0]?.installId });
  check("…and writes no telemetry.json under that COTAL_HOME", !existsSync(join(elsewhere, "telemetry.json")), elsewhere);
  const status = await s.run(["telemetry", "--json"], { COTAL_HOME: elsewhere });
  const result = status.envelope?.result as Body | undefined;
  check("cotal telemetry under that COTAL_HOME names the home's file", status.status === 0 && result?.file === s.settingsPath && result?.installId === s.settings().installId, result);
}

// ---- the account hash: a cached sign-in's IdP URL and subject id, hashed, at regular only ----
{
  const s = sandbox();
  const none = await s.run(["version"]);
  await settled();
  check("without a cached sign-in the regular events carry account null", none.sent.length === 2 && none.sent[0]?.account === null && none.sent[1]?.account === null, none.sent.map((b) => b.account));
  const idp = "https://idp.example/api/auth";
  const sub = "user_0123456789";
  mkdirSync(join(s.home, ".cotal"), { recursive: true });
  writeFileSync(join(s.home, ".cotal", "idp-sessions.json"), JSON.stringify({ sessions: { [idp]: { token: "not-a-real-token", expiresAt: Date.now() + 3_600_000, sub } } }));
  const expected = createHash("sha256").update(`${idp}\n${sub}`).digest("hex").slice(0, 32);
  const signedIn = await s.run(["version"]);
  await settled();
  check("with a cached sign-in the command event carries the 32-character hash of the IdP URL and subject id, never either value", signedIn.sent.length === 1 && signedIn.sent[0]?.account === expected && !JSON.stringify(signedIn.sent).includes(sub) && !JSON.stringify(signedIn.sent).includes("not-a-real-token"), signedIn.sent[0]);
  const status = await s.run(["telemetry", "--json"]);
  check("cotal telemetry reports the same hash", status.status === 0 && (status.envelope?.result as Body | undefined)?.account === expected, status.envelope?.result);
  const minimal = await s.run(["version"], { COTAL_TELEMETRY: "minimal" });
  await settled();
  check("minimal sends no account field", minimal.sent.length === 1 && !("account" in (minimal.sent[0] ?? {})), keysOf(minimal.sent[0]));
}

finish();
process.exit(process.exitCode ?? 0);
