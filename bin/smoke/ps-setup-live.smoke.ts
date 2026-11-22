import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { freePort, killAndAwaitExit } from "@cotal-ai/smoke-kit";
import { resolveOnPath } from "@cotal-ai/workspace";
import { clean, ptySpawn } from "../../implementations/cli/smoke/_console-pty.js";

const entry = resolve(import.meta.dirname, "../dist/cotal.js");
assert.ok(existsSync(entry), "build the CLI before running the ps setup smoke");
const nats = resolveOnPath("nats-server");
assert.ok(nats, "the ps setup smoke needs nats-server on PATH");

const root = mkdtempSync(join(tmpdir(), "cotal-ps-setup-"));
const home = join(root, "home"), project = join(root, "project"), bin = join(root, "bin");
const config = join(root, "config"), runtime = join(root, "runtime");
const extensions = join(config, "cotal", "extensions");
for (const dir of [home, join(project, ".cotal"), bin, runtime, extensions]) mkdirSync(dir, { recursive: true, mode: 0o700 });
for (const [name, target] of Object.entries({ node: process.execPath, "nats-server": nats, sh: "/bin/sh" })) {
  symlinkSync(target, join(bin, name));
}
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
const stack = spawn(process.execPath, [built, "up", "--foreground", "--open", "--space", "ps-setup", "--server", server], {
  ...options, stdio: ["ignore", "pipe", "pipe"],
});
let stackOutput = "";
stack.stdout.on("data", (chunk) => { stackOutput += String(chunk); });
stack.stderr.on("data", (chunk) => { stackOutput += String(chunk); });
let passed = false;
try {
  const deadline = Date.now() + 30_000;
  let plain = run(["ps", "--plain"]);
  while (plain.status !== 0 && Date.now() < deadline && stack.exitCode === null && stack.signalCode === null) {
    await delay(250);
    plain = run(["ps", "--plain"]);
  }
  assert.equal(plain.status, 0, `${plain.stderr}\n${stackOutput}`);
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
  passed = true;
} finally {
  await killAndAwaitExit(stack, "SIGINT", 30_000);
  if (passed) {
    assert.equal(stack.exitCode, 130, stackOutput);
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
    });
    rmSync(root, { recursive: true });
  }
}
