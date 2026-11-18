/** Static spaces keep their stack Manager and never acquire machine-service hosting intent. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { killAndAwaitExit, skipSuite } from "@cotal-ai/smoke-kit";
import { spaceSegment } from "@cotal-ai/workspace";

if (process.platform !== "linux") skipSuite("daemon-static-setup smoke: Linux only");
const root = mkdtempSync(join(tmpdir(), "cd-static-"));
const home = join(root, "h"), config = join(root, "c"), runtime = join(root, "r"), native = join(root, "n"), project = join(root, "p");
for (const dir of [home, config, runtime, native, project]) mkdirSync(dir, { mode: 0o700 });
const cli = resolve("bin/dist/cotal.js");
const env = { PATH: `${native}:${process.env.PATH}`, HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: config,
  XDG_RUNTIME_DIR: runtime, XDG_DATA_HOME: join(root, "d"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
  TMPDIR: root, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", DO_NOT_TRACK: "1", NO_COLOR: "1" };
const nativeLog = join(root, "native.log");
writeFileSync(join(native, "systemctl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${nativeLog}'\n[ "$*" = '--user show-environment' ] || exit 89\nprintf '%s\\n' 'XDG_CONFIG_HOME=${config}'\n`, { mode: 0o700 });
for (const name of ["loginctl", "launchctl", "schtasks"]) writeFileSync(join(native, name), `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${nativeLog}'\nexit 89\n`, { mode: 0o700 });
const unitPath = join(config, "systemd/user/cotal-daemon.service");
mkdirSync(join(config, "systemd/user"), { recursive: true, mode: 0o700 });
const unit = `[Unit]\nDescription=Cotal machine daemon\n\n[Service]\nType=simple\nExecStart="${process.execPath}" "${cli}" daemon serve\nRestart=always\n\n[Install]\nWantedBy=default.target\n`;
writeFileSync(unitPath, unit, { mode: 0o600 });
mkdirSync(join(home, "daemon"), { mode: 0o700 });
writeFileSync(join(home, "daemon/service-unit.json"), JSON.stringify({ v: 1, unit: "cotal-daemon.service", unitPath,
  unitSha256: createHash("sha256").update(unit).digest("hex"), installedAt: new Date().toISOString() }), { mode: 0o600 });
let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (ok) passed++; else failures.push(name);
}
async function run(...args: string[]) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", data => { out += String(data); });
  child.stderr.on("data", data => { err += String(data); });
  const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
  let code: number | null;
  try { code = await new Promise<number | null>((done, reject) => { child.once("exit", done); child.once("error", reject); }); }
  finally { clearTimeout(timer); }
  console.log(JSON.stringify({ args, code, out, err }));
  return { code, out, err };
}
const doc = (result: Awaited<ReturnType<typeof run>>) => JSON.parse(result.out) as Record<string, any>;
let daemon: ReturnType<typeof spawn> | undefined;
async function startDaemon() {
  daemon = spawn(process.execPath, [cli, "daemon", "serve"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  daemon.stdout!.on("data", data => { output += String(data); });
  daemon.stderr!.on("data", data => { output += String(data); });
  for (let i = 0; i < 200 && !output.includes("daemon ready") && daemon.exitCode === null; i++) await new Promise(done => setTimeout(done, 50));
  assert.ok(output.includes("daemon ready"), `foreground daemon must answer: ${output}`);
}
const space = "static-setup";
const stateDir = join(home, "daemon", spaceSegment(space));
const localGuidance = (text: string) => text.includes("cotal up") && !/cotal daemon (setup|register)|cotal manager start/.test(text);
try {
  assert.equal((await run("space", "create", space, "--root", project)).code, 0);
  assert.equal((await run("up", "--space", space, "--root", project, "--detach")).code, 0);
  const control = await run("manager", "start", "--space", space);
  assert.equal(control.code, 0);
  assert.ok(control.out.includes("Already running; nothing was started"), "local stack Manager must already answer");
  console.log("PASS positive control: static stack Manager answers before setup");
  await startDaemon();
  const setup = await run("daemon", "setup", "--space", space, "--json");
  const failure = doc(setup).error;
  check("setup refuses UNSUPPORTED / NOT_USER_AUTH at the connection check", setup.code === 2 && failure?.code === "UNSUPPORTED" && failure?.cause?.code === "NOT_USER_AUTH");
  check("setup explains local stack ownership and user-auth-only hosting", String(failure?.message).includes("user-auth") && localGuidance(String(failure?.remedy)));
  check("setup never reports enabling or starting the host", !setup.err.includes("turning on the space") && !setup.err.includes("starting the agent host"));
  check("setup writes no per-space daemon records", !existsSync(stateDir));
  const serviceOnly = await run("daemon", "setup", "--no-manager", "--space", space, "--wait", "0", "--json");
  check("service-only setup refuses before persisting records", serviceOnly.code === 2 && doc(serviceOnly).error?.code === "UNSUPPORTED" && doc(serviceOnly).error?.cause?.code === "NOT_USER_AUTH" && !existsSync(stateDir));
  const status = await run("daemon", "service-status", "--space", space, "--json");
  check("service-status refuses unsupported rather than suggesting registration", status.code === 2 && doc(status).error?.code === "UNSUPPORTED" && localGuidance(String(doc(status).error?.remedy)));
  const connected = await run("daemon", "service-connect", "--space", space, "--json");
  check("service-connect refuses unsupported with local stack guidance", connected.code === 2 && doc(connected).error?.code === "UNSUPPORTED" && localGuidance(String(doc(connected).error?.remedy)));
  check("service-connect also leaves no persisted intent", !existsSync(stateDir));
  const registered = await run("daemon", "register", "--space", space, "--json");
  check("register keeps its unsupported diagnosis and actionable guidance", registered.code === 2 && doc(registered).error?.code === "UNSUPPORTED" && localGuidance(String(doc(registered).error?.remedy)));
  // Older setup releases persisted this refusal. Explicit disconnect must still clear it.
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir, "manager-refusal.json"), JSON.stringify({ space, state: "refused", restarts: 0,
    reason: "hosted Managers require a registered user-auth participant space", lastRefusal: "hosted Managers require a registered user-auth participant space",
    next: "use `cotal manager start` from the folder that hosts the space" }), { mode: 0o600 });
  await killAndAwaitExit(daemon!, "SIGTERM");
  daemon = undefined;
  await startDaemon();
  const disconnected = await run("daemon", "service-disconnect", "--space", space, "--json");
  check("disconnect clears a legacy refusal without pointing back to setup", disconnected.code === 0 && localGuidance(String(doc(disconnected).result?.manager?.next)) && !existsSync(join(stateDir, "manager-refusal.json")));
  await killAndAwaitExit(daemon!, "SIGTERM");
  daemon = undefined;
  await startDaemon();
  const restarted = await run("daemon", "status", "--space", space, "--json");
  check("restart retains no refused hosted Manager", restarted.code === 0 && !(doc(restarted).result?.managers ?? []).some((row: { state: string }) => row.state === "refused"));
  const after = await run("manager", "start", "--space", space);
  check("positive control: local stack Manager still answers after daemon operations", after.code === 0 && after.out.includes("Already running; nothing was started"));
  check("no native service mutation was attempted", !existsSync(nativeLog) || readFileSync(nativeLog, "utf8").trim().split("\n").every(line => line === "--user show-environment"));
} finally {
  if (daemon) await killAndAwaitExit(daemon, "SIGTERM");
  const down = await run("down", "--space", space, "--yes");
  assert.equal(down.code, 0, "owned static stack must stop before the smoke exits");
  console.log(`Evidence retained at ${root}`);
}
console.log(`${passed} passed, ${failures.length} failed`);
assert.deepEqual(failures, []);
