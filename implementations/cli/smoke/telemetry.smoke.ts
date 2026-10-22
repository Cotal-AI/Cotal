/**
 * The CLI's anonymous usage telemetry, driven through the built binary against a local HTTP intake
 * in a sandboxed home: one `command` event per command and one `install` event per UTC day at
 * `regular`, the exact `minimal` shape, nothing at `off` and under the environment opt-outs, no
 * argument or flag value in any body, the typed error code of a refusal, `cotal telemetry` itself
 * silent, an intake that never answers adding no more than its timeout and changing no exit code,
 * the refusals of a bad `COTAL_TELEMETRY` and a malformed settings file, and the one-time notice
 * under a real pty. No broker is started.
 *
 * Run: pnpm smoke:telemetry
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite, listenOn, onFreePort } from "@cotal-ai/smoke-kit";
import { clean, cotalPty, wait } from "./_console-pty.js";

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
const received: Body[] = [];
const intake = createServer((req, res) => {
  let text = "";
  req.on("data", (chunk) => (text += chunk));
  req.on("end", () => {
    if (req.method === "POST" && req.headers["content-type"] === "application/json") received.push(JSON.parse(text) as Body);
    res.statusCode = 204;
    res.end();
  });
});
servers.push(intake);
const port = await onFreePort((p) => listenOn(intake, p));
const url = `http://127.0.0.1:${port}/v1/telemetry`;
// A black hole: it accepts the connection and never answers, so the client's timeout is what ends the send.
const blackHole = createServer(() => {});
servers.push(blackHole);
const blackHolePort = await onFreePort((p) => listenOn(blackHole, p));

/** A fresh sandboxed home with its own project dir; `run` executes the built binary in it. */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "cotal-telemetry-"));
  homes.push(home);
  const project = join(home, "project");
  mkdirSync(project);
  const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1", COTAL_TELEMETRY_URL: url, SHELL: "/bin/zsh", TERM_PROGRAM: "smoke-term" };
  const settingsPath = join(home, ".cotal", "telemetry.json");
  // Asynchronous, so the intake in this process keeps answering while the child runs.
  const run = async (args: string[], extra: Record<string, string | undefined> = {}) => {
    const before = received.length;
    const started = Date.now();
    const child = spawn(process.execPath, [BIN, ...args], { cwd: project, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
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
const REGULAR = [...MINIMAL, "subcommand", "flags", "errorCode", "interactive", "shell", "terminal"];
const INSTALL = [...COMMON, "osRelease", "packageManager", "installMethod", "connectors", "extensions", "runtimes", "meshes", "hostedMesh", "uptimeDays"];

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
  check("the command event names the command and its outcome", command?.command === "version" && command?.outcome === "ok" && command?.exitCode === 0 && command?.errorCode === null && command?.subcommand === null && Array.isArray(command?.flags) && (command?.flags as unknown[]).length === 0, command);
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
  const usage = await s.run(["ext", "frobnicate"]);
  await settled();
  check("a usage refusal is an event too: refused, USAGE_INVALID, exit 1", usage.status === 1 && usage.sent.length === 1 && usage.sent[0]?.outcome === "refused" && usage.sent[0]?.errorCode === "USAGE_INVALID" && usage.sent[0]?.subcommand === null, { ...shown(usage), sent: usage.sent });
  const unknown = await s.run(["frobnicate"]);
  await settled();
  check("an unknown command word names no command and sends nothing", unknown.status === 1 && unknown.sent.length === 0, shown(unknown));
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
  await settled();
  const result = status.envelope?.result as Body | undefined;
  check("cotal telemetry under DO_NOT_TRACK reports off by that variable with no install id, and sends nothing", status.status === 0 && status.sent.length === 0 && result?.level === "off" && result?.source === "DO_NOT_TRACK" && result?.installId === null && result?.url === url, { ...shown(status), result });

  const off = await s.run(["telemetry", "off"]);
  await settled();
  const after = await s.run(["version"]);
  await settled();
  check("cotal telemetry off writes level off", off.status === 0 && off.sent.length === 0 && s.settings().level === "off", shown(off));
  check("after cotal telemetry off, a command sends nothing", after.status === 0 && after.sent.length === 0, shown(after));
  const again = await s.run(["telemetry", "off", "--json"]);
  check("setting the level the file already holds is a no-op", again.status === 0 && again.envelope?.outcome === "no-op", shown(again));
  const on = await s.run(["telemetry", "on", "--json"]);
  const onResult = on.envelope?.result as Body | undefined;
  check("cotal telemetry on is regular, and reports the file as the source with the install id", on.status === 0 && onResult?.level === "regular" && onResult?.source === "file" && onResult?.installId === s.settings().installId, { ...shown(on), onResult });
  const status2 = await s.run(["telemetry"]);
  await settled();
  check("the bare report prints the level, its source and the URL, and sends nothing", status2.status === 0 && status2.sent.length === 0 && /regular/.test(status2.stdout) && /settings file/.test(status2.stdout) && status2.stdout.includes(url), shown(status2));
}

// ---- refusals: a bad COTAL_TELEMETRY and a malformed settings file ----
{
  const s = sandbox();
  const bogus = await s.run(["version", "--json"], { COTAL_TELEMETRY: "bogus" });
  await settled();
  check("COTAL_TELEMETRY=bogus refuses USAGE_INVALID before the command runs, sending nothing", bogus.status === 1 && bogus.sent.length === 0 && bogus.envelope?.outcome === "refused" && (bogus.envelope?.error as Body | undefined)?.code === "USAGE_INVALID" && /COTAL_TELEMETRY must be off, minimal or regular/.test(bogus.stderr), shown(bogus));
  const bogusTelemetry = await s.run(["telemetry"], { COTAL_TELEMETRY: "bogus" });
  check("…and cotal telemetry itself refuses it the same way", bogusTelemetry.status === 1 && /COTAL_TELEMETRY must be off, minimal or regular/.test(bogusTelemetry.stderr), shown(bogusTelemetry));
  mkdirSync(join(s.home, ".cotal"), { recursive: true });
  writeFileSync(s.settingsPath, '{"v":1,"level":"loud"}');
  const malformed = await s.run(["version"]);
  await settled();
  check("a malformed telemetry.json refuses SCHEMA_INVALID, sends nothing, and is left as it was", malformed.status === 1 && malformed.sent.length === 0 && /telemetry settings file .* is invalid/.test(malformed.stderr) && readFileSync(s.settingsPath, "utf8") === '{"v":1,"level":"loud"}', shown(malformed));
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

finish();
process.exit(process.exitCode ?? 0);
