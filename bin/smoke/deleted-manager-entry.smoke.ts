// Opt-in Linux acceptance fixture. Supply a private, self-contained installed cotal-ai
// directory and an approved nats-server. No workspace package is substituted into it.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { createServer } from "node:net";

assert.equal(process.platform, "linux", "this fixture requires Linux process identity");
assert.ok(process.env.COTAL_DELETED_MANAGER_INSTALL, "set COTAL_DELETED_MANAGER_INSTALL to a self-contained installed cotal-ai directory");
assert.ok(process.env.COTAL_DELETED_MANAGER_BROKER, "set COTAL_DELETED_MANAGER_BROKER to the approved nats-server binary");
const installation = realpathSync(process.env.COTAL_DELETED_MANAGER_INSTALL);
const brokerBinary = realpathSync(process.env.COTAL_DELETED_MANAGER_BROKER);
assert.ok(existsSync(join(installation, "dist/cotal.js")));
process.umask(0o022);
const root = mkdtempSync(join(realpathSync(tmpdir()), "deleted-manager-entry-"));
// Keep the entire fixture private. The harness is the only launch-tree writer and
// starts no seats or other processes in it. Deletion below is the requested fault.
mkdirSync(join(root, "private"), { mode: 0o700 });
const home = join(root, "private");
for (const name of ["home", "config", "cache", "data", "state", "runtime", "cotal/.cotal", SMOKE_BROKER_TOKEN])
  mkdirSync(join(home, name), { recursive: true });
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: join(home, "home"), COTAL_HOME: join(home, "cotal/.cotal"),
  XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
  XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"),
  XDG_RUNTIME_DIR: join(home, "runtime"), TMPDIR: realpathSync(tmpdir()),
  COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", DO_NOT_TRACK: "1",
  npm_config_registry: "http://127.0.0.1:9", npm_config_offline: "true", npm_config_cache: join(home, "cache"),
};
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
type Running = { child: ChildProcess; text: () => string; exit: Promise<number | null> };
function start(command: string, args: string[], cwd: string, name: string): Running {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  for (const stream of [child.stdout!, child.stderr!]) stream.on("data", chunk => {
    text += String(chunk);
    writeFileSync(join(root, `${name}.log`), text);
  });
  const exit = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  return { child, text: () => text, exit };
}
async function finish(run: Running): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([run.exit, new Promise<never>((_, reject) => { timer = setTimeout(() => { run.child.kill("SIGTERM"); reject(new Error("owned CLI timed out")); }, 30_000); })]); }
  finally { clearTimeout(timer); }
}
async function stop(run: Running | undefined) {
  if (!run || run.child.exitCode !== null || run.child.signalCode !== null) return;
  run.child.kill("SIGTERM");
  await finish(run);
}
async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
function proof(pid: number) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const token = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
  return { pid, token, stat, cwd: readlinkSync(`/proc/${pid}/cwd`), argv: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean), btime: readFileSync("/proc/stat", "utf8").split("\n").find(line => line.startsWith("btime ")), auxv: readFileSync("/proc/self/auxv").toString("hex") };
}
let broker: Running | undefined;
let manager: Running | undefined;
try {
  const updater = join(home, "updater");
  cpSync(installation, updater, { recursive: true });
  const port = await freePort();
  broker = start(brokerBinary, ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", join(home, SMOKE_BROKER_TOKEN)], home, "broker");
  teardownOnSignal(broker.child, join(home, SMOKE_BROKER_TOKEN));
  for (let i = 0; !broker.text().includes("Server is ready"); i++) { assert.ok(i < 100, "broker did not become ready"); assert.equal(broker.child.exitCode, null); await pause(100); }
  // Run both physical missing-entry and missing-symlink cases. The latter keeps
  // the owning installation intact, so a deleted alias never proves ownership.
  for (const symlink of [false, true]) {
    const name = symlink ? "symlink" : "physical";
    const launch = symlink ? updater : join(home, `${name}-launch`);
    if (!symlink) cpSync(installation, launch, { recursive: true });
    const entry = symlink ? join(home, "cotal-alias.js") : join(launch, "dist/cotal.js");
    if (symlink) symlinkSync(join(launch, "dist/cotal.js"), entry);
    const space = `deleted-${name}`;
    const args = ["meshes", "add", space, "--mode", "open", "--root", launch, "--server", `nats://127.0.0.1:${port}`];
    const register = start(process.execPath, [join(updater, "dist/cotal.js"), ...args], home, `${name}-register`);
    assert.equal(await finish(register), 0, register.text());
    const lower = Date.now();
    manager = start(process.execPath, [entry, "__daemon-manager", "--space", space, "--server", `nats://127.0.0.1:${port}`, "--runtime", "pty", "--console-port", "0"], launch, `${name}-manager`);
    for (let i = 0; !manager.text().includes("✓ manager up"); i++) { assert.ok(i < 200, manager.text()); assert.equal(manager.child.exitCode, null, manager.text()); await pause(100); }
    const upper = Date.now();
    const before = proof(manager.child.pid!);
    const consoleUrl = manager.text().match(/http:\/\/127\.0\.0\.1:\d+/)![0];
    writeFileSync(join(root, `${name}-before.json`), JSON.stringify({ lower, upper, before }, null, 2));
    assert.equal(before.cwd, launch);
    if (symlink) rmSync(entry);
    else rmSync(launch, { recursive: true });
    const after = proof(manager.child.pid!);
    assert.equal(after.token, before.token);
    assert.equal(after.cwd, symlink ? launch : `${launch} (deleted)`);
    assert.equal(existsSync(entry), false);
    const response = await fetch(consoleUrl, { signal: AbortSignal.timeout(5000) });
    writeFileSync(join(root, `${name}-after.json`), JSON.stringify({ after, consoleStatus: response.status }, null, 2));
    for (const self of [false, true]) {
      const update = start(process.execPath, [join(updater, "dist/cotal.js"), "update", ...(self ? ["--self"] : [])], home, `${name}-update${self ? "-self" : ""}`);
      assert.notEqual(await finish(update), 0, "deleted entry must refuse");
      const text = update.text();
      assert.ok(text.includes(`Manager pid ${before.pid} has no proven CLI entry`), text);
      assert.ok(text.includes(`start token ${before.token}`), text);
      assert.ok(text.includes(`working directory ${JSON.stringify(after.cwd)}`), text);
      assert.ok(text.includes(`${JSON.stringify(entry)} (path is gone)`), text);
      const started = text.match(/started (\S+) \(approximate, start token/);
      assert.ok(started, text);
      assert.ok(Math.abs(Date.parse(started[1]!) - lower) < 2000, text);
      assert.ok(Date.parse(started[1]!) <= upper + 1000, text);
      assert.ok(text.includes("stop this process if it is a leftover"), text);
      assert.ok(text.includes("run the update from the installation that owns it"), text);
      assert.ok(!text.includes("restore its identity record"), text);
      assert.equal(proof(manager.child.pid!).token, before.token);
    }
    await stop(manager);
    manager = undefined;
    const released = start(process.execPath, [join(updater, "dist/cotal.js"), "update"], home, `${name}-released`);
    await finish(released);
    assert.ok(released.text().includes("Built-in connectors"), released.text());
    assert.ok(!released.text().includes("local Manager continuity cannot be established"), released.text());
  }
  console.log(`PASS real Manager deleted-entry diagnostics. Retained fixture: ${root}`);
} finally {
  await stop(manager);
  await stop(broker);
  console.log(`Evidence retained: ${root}`);
}
