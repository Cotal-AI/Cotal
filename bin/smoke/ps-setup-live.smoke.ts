import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { clean, ptySpawn } from "../../implementations/cli/smoke/_console-pty.js";

const entry = resolve(import.meta.dirname, "../dist/cotal.js");
assert.ok(existsSync(entry), "build the CLI before running the ps setup smoke");

const root = mkdtempSync(join(tmpdir(), "cotal-ps-setup-"));
const home = join(root, "home"), project = join(root, "project"), bin = join(root, "bin");
const config = join(root, "config"), runtime = join(root, "runtime");
const extensions = join(config, "cotal", "extensions");
for (const dir of [home, join(project, ".cotal"), bin, runtime, extensions]) mkdirSync(dir, { recursive: true, mode: 0o700 });
symlinkSync(process.execPath, join(bin, "node"));
const built = join(root, "package", "dist", "cotal.js");
mkdirSync(dirname(built), { recursive: true });
cpSync(dirname(entry), dirname(built), { recursive: true });
chmodSync(built, 0o700);
for (const name of ["package.json", "node_modules"]) symlinkSync(resolve(dirname(entry), "..", name), join(root, "package", name));
const launcher = join(bin, "cotal");
symlinkSync(built, launcher);

// A cached connector declaration is sufficient for inventory. No application or package need run.
writeFileSync(join(extensions, "extensions.json"), JSON.stringify({ extensions: [{
  pkg: "@fixture/missing", spec: "@fixture/missing@1.0.0", version: "1.0.0", commands: [],
  provides: [{ kind: "connector", name: "missing" }],
  connectors: [{ name: "missing", requires: ["fixture-agent"], eventPlane: false, setup: null }],
}] }));

const env = {
  HOME: home, USERPROFILE: home, COTAL_HOME: home, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime,
  TMPDIR: root, PATH: bin, TERM: "xterm", NO_COLOR: "1", DO_NOT_TRACK: "1", COTAL_SKIP_CONNECTOR_SEED: "1",
};
const options = { cwd: project, env };
const run = (args: string[]) => spawnSync(launcher, args, {
  ...options, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"],
});

function nextCommand(stdout: string): string {
  assert.match(stdout, /^\s*No managed agents\.$/m);
  assert.match(stdout, /^Manager\n\s+instance:/m);
  return stdout.split("\nNext\n")[1]?.split("\n")[0]?.trim().split(/ {2,}/)[0] ?? "";
}

function terminalPs(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const pty = ptySpawn(process.execPath, [built, "ps", ...args], { ...options, name: env.TERM, cols: 120, rows: 32 });
    let out = "";
    const timeout = setTimeout(() => pty.kill(), 15_000);
    pty.onData((data) => { out += data; });
    pty.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (exitCode !== 0) reject(new Error(`terminal ps exited ${exitCode}: ${out}`));
      else resolve(clean(out).replaceAll("\r\n", "\n"));
    });
  });
}

const port = await freePort();
const server = `nats://127.0.0.1:${port}`;
const space = "ps-setup";
const store = join(root, `${SMOKE_BROKER_TOKEN}ps-setup`);
const mesh = run(["meshes", "add", space, "--mode", "open", "--root", project, "--server", server, "--force"]);
assert.ifError(mesh.error);
assert.equal(mesh.status, 0, mesh.stderr);

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
// Keep both handles: foreground `up` can leave detached children if it dies before teardown.
const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", store], {
  cwd: project, env: { ...env, PATH: process.env.PATH }, stdio: ["ignore", "ignore", "pipe"],
});
let brokerOutput = "";
broker.stderr.on("data", (chunk) => { brokerOutput += String(chunk); });
broker.on("error", (error) => { brokerOutput += `${error.message}\n`; });
let releaseBroker: (() => void) | undefined;
let manager: ChildProcess | undefined;
let releaseManager: (() => void) | undefined;
let managerOutput = "";
try {
  releaseBroker = teardownOnSignal(broker, store);
  await awaitBrokerReady(async () => !exited(broker) && brokerOutput.includes("Server is ready"), {
    servers: server, attempts: 100, delayMs: 100, output: () => brokerOutput,
  });
  const child = spawn(process.execPath, [built, "__daemon-manager", "--space", space, "--server", server], {
    ...options, stdio: ["ignore", "pipe", "pipe"],
  });
  manager = child;
  child.on("error", (error) => { managerOutput += `${error.message}\n`; });
  releaseManager = teardownOnSignal(child);
  child.stdout.on("data", (chunk) => { managerOutput += String(chunk); });
  child.stderr.on("data", (chunk) => { managerOutput += String(chunk); });
  const deadline = Date.now() + 30_000;
  let plain = run(["ps", "--plain"]);
  while (plain.status !== 0 && Date.now() < deadline && !exited(child) && !exited(broker)) {
    await delay(250);
    plain = run(["ps", "--plain"]);
  }
  assert.ifError(plain.error);
  assert.equal(plain.status, 0, `${plain.stderr}\n${managerOutput}`);
  const command = nextCommand(plain.stdout);
  assert.equal(command, "cotal setup --help", plain.stdout);
  const help = run(command.split(" ").slice(1));
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--destination/);
  console.log("PASS headless plain ps recommends runnable setup help");

  const headless = run(["ps"]);
  assert.equal(headless.status, 0, headless.stderr);
  assert.equal(nextCommand(headless.stdout), command);
  assert.equal(nextCommand(await terminalPs([])), "cotal setup");
  assert.equal(nextCommand(await terminalPs(["--no-input"])), command);
  assert.equal(nextCommand(await terminalPs(["--plain"])), command);
  console.log("PASS default output and prompt opt-outs offer help, while a promptable terminal offers guided setup");
} finally {
  if (manager) await killAndAwaitExit(manager);
  await killAndAwaitExit(broker);
  releaseManager?.();
  releaseBroker?.();
  assert.ok(!manager?.pid || exited(manager), "owned manager did not exit");
  assert.ok(!broker.pid || exited(broker), "owned broker did not exit");
}
assert.equal(manager?.exitCode, 0, managerOutput);
assert.equal(broker.exitCode, 0, brokerOutput);
const probe = createServer();
await new Promise<void>((resolve, reject) => {
  probe.once("error", reject);
  probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
});
rmSync(root, { recursive: true });
