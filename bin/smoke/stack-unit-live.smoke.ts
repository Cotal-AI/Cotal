import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { processGroupMembers, processGroupOf } from "@cotal-ai/workspace";

if (process.platform !== "linux") throw new Error("this live cell exercises the Linux systemd unit");
const { check, finish } = createSuite();
const base = realpathSync(mkdtempSync(join(tmpdir(), "cotal-stack-unit-")));
const [root, home, xdg, runtime, native, store] = ["mesh %% $thing 'quoted'", "home", "config", "runtime", "native", "state"].map((name) => join(base, name)) as [string, string, string, string, string, string];
for (const dir of [root, home, xdg, runtime, native, store]) mkdirSync(dir, { mode: 0o700 });
const control = join(home, "machine"), entry = resolve(import.meta.dirname, "../dist/cotal.js");
const space = "stack-unit-smoke", server = `nats://127.0.0.1:${await freePort()}`;
const env = { PATH: [native, ...(process.env.PATH ?? "").split(delimiter).filter(isAbsolute)].join(delimiter), HOME: home, COTAL_HOME: control, XDG_CONFIG_HOME: xdg, XDG_RUNTIME_DIR: runtime,
  XDG_CACHE_HOME: join(base, "cache"), XDG_DATA_HOME: join(base, "data"), XDG_STATE_HOME: join(base, "xdg-state"),
  TMPDIR: tmpdir(), COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off" };
const anchor = recordSmokeSandbox({ root, cotalHome: control, xdgConfigHome: xdg });
const effects = join(base, "native-calls.log");
const shell = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
for (const command of ["systemctl", "systemd-run", "launchctl", "schtasks"]) {
  const readOnly = command === "systemctl" ? '[ "$*" = "--user show --property=Version --value" ] || exit 98\nprintf "256\\n"' : "exit 98";
  writeFileSync(join(native, command), `#!/bin/sh\nprintf '%s %s\\n' '${command}' "$*" >> ${shell(effects)}\n${readOnly}\n`, { mode: 0o700 });
}
const linger = (value: "no" | "yes" | "unknown") => writeFileSync(join(native, "loginctl"), `#!/bin/sh\n[ "$1" = show-user ] || exit 98\n${value === "unknown" ? "exit 1" : `printf '%s\\n' '${value}'`}\n`, { mode: 0o700 });
linger("no");
console.log(`stack unit proof retained in ${base}`);

function command(...args: string[]) {
  const options = { cwd: root, env, encoding: "utf8" as const, timeout: 120_000 };
  assertSmokeSandboxDown(anchor, args, options);
  const result = spawnSync(process.execPath, [entry, ...args], options);
  if (result.error) throw result.error;
  return result;
}
function ok(...args: string[]) {
  const r = command(...args);
  assert.equal(r.status, 0, `${args[0]}: ${r.stdout}${r.stderr}`);
  return r;
}

function parseUnit(source: string): { argv: string[]; env: Record<string, string> } {
  // The renderer emits a whole quoted word. Don't interpret the service as shell input.
  const unquote = (word: string) => JSON.parse(word.replaceAll("%%", "%")) as string;
  const exec = source.split("\n").find((line) => line.startsWith("ExecStart="))!;
  const words = exec.slice("ExecStart=".length).match(/"(?:\\.|[^"\\])*"/g)!;
  return { argv: words.map((word) => unquote(word).replaceAll("$$", "$")), env: Object.fromEntries(source.split("\n")
    .filter((line) => line.startsWith("Environment="))
    .map((line) => unquote(line.slice("Environment=".length)))
    .map((value) => [value.slice(0, value.indexOf("=")), value.slice(value.indexOf("=") + 1)])) };
}

type Member = { definition: string; pid: number; instanceId: string; observedProcess: string };
function members(): Member[] {
  return (JSON.parse(ok("service", "--space", space, "--json").stdout).result.instances as Member[]).filter((row) => row.observedProcess === "running");
}

function start(argv: string[], unitEnv: Record<string, string>, name: string) {
  const log = join(base, name + ".log"), fd = openSync(log, "wx", 0o600);
  let child: ChildProcess;
  try { child = spawn(argv[0]!, argv.slice(1), { cwd: home, env: { ...env, ...unitEnv }, detached: true, stdio: ["ignore", fd, fd] }); }
  finally { closeSync(fd); }
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, exit, log };
}

async function ready(run: ReturnType<typeof start>): Promise<Member[]> {
  const deadline = Date.now() + 110_000;
  while (Date.now() < deadline) {
    const log = readFileSync(run.log, "utf8");
    if (log.includes("Controller stack started")) return members();
    if (run.child.exitCode !== null || run.child.signalCode !== null) throw new Error(log);
    await delay(100);
  }
  throw new Error(`stack did not become ready: ${readFileSync(run.log, "utf8")}`);
}

async function exited(run: ReturnType<typeof start>) {
  const timer = setTimeout(() => run.child.kill("SIGKILL"), 120_000);
  try { return await run.exit; }
  finally { clearTimeout(timer); }
}

async function settleGroup(run: ReturnType<typeof start>, original: Member[]) {
  const group = run.child.pid!;
  const owned = new Set(original.map((row) => row.pid));
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const surviving = processGroupMembers(group);
    assert.ok(surviving.every((pid) => owned.has(pid)), "no foreign process may be signalled");
    for (const pid of surviving) {
      try { process.kill(pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    for (let i = 0; i < 50 && processGroupMembers(group).length; i++) await delay(100);
    if (!processGroupMembers(group).length) return;
  }
  throw new Error("the old unit still holds a live process");
}

const generate = () => ok("stack-unit", "--root", root, "--space", space);
let running: ReturnType<typeof start> | undefined;
let ownsStack = false;
try {
  ok("space", "create", space);
  const neverStarted = command("stack-unit", "--root", root, "--space", space);
  check("a prepared project without a recorded stack receives no unit", neverStarted.status !== 0 && neverStarted.stdout === "", neverStarted.stderr);
  ownsStack = true;
  // Prevent these ordinary launchers from taking real scopes or reaching the test's simulated unit.
  env.XDG_RUNTIME_DIR = "";
  ok("up", "--detach", "--space", space, "--server", server, "--store-dir", store);
  const unit = generate();
  const unitFile = join(base, "stack.service");
  writeFileSync(unitFile, unit.stdout, { mode: 0o600 });
  const syntax = spawnSync("systemd-analyze", ["--user", "verify", "--man=no", "--generators=no", unitFile], {
    env: { ...env, XDG_RUNTIME_DIR: runtime, SYSTEMD_UNIT_PATH: `/usr/lib/systemd/user:${base}` }, encoding: "utf8", timeout: 10_000,
  });
  if ((syntax.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") console.log("  - systemd-analyze unavailable; no unit parser check");
  else check("systemd accepts the generated unit in offline verification", syntax.status === 0, syntax.stderr || syntax.error);
  check("the produced unit restarts only on failure and stops the main process first", /^Restart=on-failure$/m.test(unit.stdout) && /^KillMode=mixed$/m.test(unit.stdout) && /^OOMPolicy=continue$/m.test(unit.stdout));
  check("disabled linger is reported without claiming boot or installation", /Linger is disabled.*Boot without login is not established.*No service was installed or started/.test(unit.stderr), unit.stderr);
  for (const value of ["yes", "unknown"] as const) {
    linger(value);
    const rendered = generate();
    check(`linger ${value} changes only the note`, rendered.stdout === unit.stdout && (value === "yes" ? /Linger is enabled/.test(rendered.stderr) : /could not be determined/.test(rendered.stderr)), rendered.stderr);
  }
  const plan = parseUnit(unit.stdout);
  check("the supervisor receives the exact special-character project and pinned environment", plan.argv.includes(root) && plan.env.COTAL_HOME === control && plan.env.XDG_CONFIG_HOME === xdg && !Object.hasOwn(plan.env, "XDG_RUNTIME_DIR"));
  const occupied = start(plan.argv, plan.env, "refuse-live");
  check("the entry refuses to take over the live detached stack", (await exited(occupied)).code !== 0 && readFileSync(occupied.log, "utf8").includes("the unit did not adopt it"));
  ok("send", "-c", "general", "retained across native restart");
  ok("down", "--space", space, "--yes");
  env.XDG_RUNTIME_DIR = runtime;
  running = start(plan.argv, plan.env, "initial");
  const initial = await ready(running);
  assert.equal(initial.length, 3, JSON.stringify(initial));
  check("all stack members stay inside the native owner's process group", initial.every(({ pid }) => processGroupOf(pid) === running!.child.pid), initial);
  const broker = initial.find(({ definition }) => definition === "stack-broker")!;
  assert.ok(broker);
  process.kill(broker.pid, "SIGKILL");
  const crash = await exited(running), crashLog = readFileSync(running.log, "utf8");
  check("an unexpected broker exit returns a native restartable failure and keeps the records", crash.code === 5 && crashLog.includes("The stack records were kept. Check the native service manager for the restart outcome."), crashLog);
  // Stand in for the native supervisor's cleanup before it invokes the same unit again.
  await settleGroup(running, initial);
  assert.equal(members().length, 0, "the old unit's members stopped before restart");
  await delay(5000);
  running = start(plan.argv, plan.env, "restarted");
  const recovered = await ready(running);
  check("native relaunch restarts the same recorded stack with new process IDs", recovered.length === 3 && recovered.every((row) => initial.some((old) => old.definition === row.definition && old.pid !== row.pid)), recovered);
  const history = ok("history", "general");
  check("the original durable store still serves its history", history.stdout.includes("retained across native restart"), history.stdout);
  ok("down", "--space", space, "--yes");
  check("an intentional down releases the unit cleanly without requesting restart", (await exited(running)).code === 0 && members().length === 0);
  running = undefined;
  renameSync(store, store + "-original");
  mkdirSync(store, { mode: 0o700 });
  const replaced = start(plan.argv, plan.env, "refuse-replaced-store");
  check("the unit refuses a replacement store rather than starting an empty mesh", (await exited(replaced)).code !== 0 && readFileSync(replaced.log, "utf8").includes("recorded broker store was replaced") && !members().length);
  renameSync(store, store + "-replacement");
  renameSync(store + "-original", store);
  ownsStack = false;
  let nativeCalls = "";
  try { nativeCalls = readFileSync(effects, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  check("the supervised entry used no native service or scope command", nativeCalls === "", nativeCalls);
} finally {
  if (running && running.child.exitCode === null && running.child.signalCode === null) { running.child.kill("SIGTERM"); await exited(running); }
  if (ownsStack) ok("down", "--space", space, "--yes");
}
finish();
