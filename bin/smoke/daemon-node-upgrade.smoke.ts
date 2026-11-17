/** Built CLI regression for a distribution Node symlink changing targets. No host service runs. */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSuite, killAndAwaitExit } from "@cotal-ai/smoke-kit";

const suite = createSuite();
if (process.platform !== "linux") {
  console.log("daemon Node upgrade smoke: Linux systemd source regression only");
  suite.finish();
} else {
  const repo = resolve(import.meta.dirname, "../..");
  const cli = join(repo, "bin/dist/cotal.js");
  const root = mkdtempSync(join(tmpdir(), "dnu-"));
  console.log(`Retained daemon Node upgrade fixture: ${root}`);
  const native = join(root, "native");
  mkdirSync(native, { mode: 0o700 });
  // Every native service call ends here. Start only tests the recorded executable's availability.
  const tool = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NATIVE_CALLS, JSON.stringify({ tool: path.basename(process.argv[1]), args }) + "\\n");
if (args.includes("show-environment")) console.log("HOME=" + process.env.HOME + "\\nXDG_CONFIG_HOME=" + process.env.XDG_CONFIG_HOME);
if (args.includes("show-user")) console.log("Linger=yes");
if (args.includes("start")) {
  const unit = args[args.indexOf("start") + 1];
  const source = fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME, "systemd/user", unit), "utf8");
  const executable = /^ExecStart="((?:\\\\.|[^"\\\\])*)"/m.exec(source)[1].replace(/\\\\([\\\\"])/g, "$1").replaceAll("%%", "%").replaceAll("$$", "$");
  try { fs.accessSync(executable, fs.constants.X_OK); } catch { process.exit(1); }
}
`;
  for (const name of ["systemctl", "loginctl"]) writeFileSync(join(native, name), tool, { mode: 0o700 });

  function fixture(name: string) {
    const dir = join(root, name);
    mkdirSync(dir, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "COTAL_HOME"]) {
      env[key] = join(dir, key === "XDG_RUNTIME_DIR" ? "r" : key.toLowerCase());
      mkdirSync(env[key]!, { mode: 0o700 });
    }
    const home = join(dir, "daemon");
    const nodebin = join(dir, "nodebin");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(nodebin, { mode: 0o700 });
    const oldNode = join(nodebin, "node-22");
    const newNode = join(nodebin, "node-24");
    const node = join(nodebin, "node");
    copyFileSync(process.execPath, oldNode);
    copyFileSync(process.execPath, newNode);
    symlinkSync(oldNode, node);
    Object.assign(env, { PATH: `${native}:${nodebin}:/usr/bin:/bin`, USER: "repro", LOGNAME: "repro", NATIVE_CALLS: join(dir, "native-calls.jsonl"), DO_NOT_TRACK: "1", NO_COLOR: "1", COTAL_SKIP_CONNECTOR_SEED: "1" });
    let index = 0;
    function run(executable: string, op: string, ...flags: string[]) {
      const result = spawnSync(executable, [cli, "daemon", op, "--daemon-home", home, ...flags], { cwd: dir, env, encoding: "utf8", timeout: 20_000 });
      writeFileSync(join(dir, `${index++}-${op}.json`), JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr }, null, 2));
      return { ...result, text: `${result.stdout}\n${result.stderr}` };
    }
    function unit() {
      const units = join(env.XDG_CONFIG_HOME!, "systemd/user");
      const files = readdirSync(units).filter(name => name.endsWith(".service"));
      if (files.length !== 1) throw new Error(`expected one private unit, found ${files.length}`);
      return join(units, files[0]!);
    }
    return { dir, env, home, node, oldNode, newNode, nodebin, run, unit };
  }

  const stable = fixture("stable");
  const installed = stable.run(stable.node, "install", "--plain");
  suite.check("positive control: install through Node symlink succeeds", installed.status === 0, installed.text);
  const source = readFileSync(stable.unit(), "utf8");
  suite.check("unit keeps the stable Node symlink instead of its versioned target", source.includes(`ExecStart="${stable.node}"`), source);
  const before = stable.run(stable.node, "install", "--plain");
  suite.check("positive control: unchanged service is already installed", before.status === 0 && before.text.includes("Already installed"), before.text);
  suite.check("positive control: native start accepts the available executable", stable.run(stable.node, "start", "--plain").status === 0);
  // The target removed by a distribution stream switch is retained under another private name.
  symlinkSync(stable.newNode, `${stable.node}.next`);
  renameSync(`${stable.node}.next`, stable.node);
  renameSync(stable.oldNode, `${stable.oldNode}.retired`);
  const after = stable.run(stable.node, "install", "--plain");
  suite.check("stream switch: unchanged service still belongs to this installation", after.status === 0 && after.text.includes("Already installed"), after.text);
  suite.check("stream switch: native start still finds the executable", stable.run(stable.node, "start", "--plain").status === 0);
  suite.check("stream switch does not rewrite the unit", readFileSync(stable.unit(), "utf8") === source);

  // Run the actual recorded command in the foreground under the private environment, not systemd.
  const line = /^ExecStart=(.*)$/m.exec(source)![1]!;
  const argv = [...line.matchAll(/"((?:\\.|[^"\\])*)"/g)].map(match => match[1]!.replace(/\\([\\"])/g, "$1").replaceAll("%%", "%").replaceAll("$$", "$"));
  if (existsSync(argv[0]!)) {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: stable.dir, env: stable.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    try {
      const ready = await new Promise<boolean>(resolveReady => {
        const timer = setTimeout(() => resolveReady(false), 20_000);
        const finish = (value: boolean) => { clearTimeout(timer); resolveReady(value); };
        child.stdout.on("data", chunk => { stdout += String(chunk); if (stdout.includes("daemon ready at ")) finish(true); });
        child.once("error", () => finish(false));
        child.once("exit", () => finish(false));
      });
      suite.check("stream switch: recorded command reaches real daemon readiness", ready, { stdout, stderr });
      const status = stable.run(stable.node, "status", "--json");
      const body = JSON.parse(status.stdout) as { result?: { state?: string; pid?: number } };
      suite.check("stream switch: shipped status identifies the real serving child", status.status === 0 && body.result?.state === "ready" && body.result.pid === child.pid, status.text);
    } finally {
      if (child.pid && child.exitCode === null && child.signalCode === null) await killAndAwaitExit(child, "SIGTERM");
      writeFileSync(join(stable.dir, "serve.log"), `${stdout}\n${stderr}`);
      suite.check("owned foreground daemon has exited", child.exitCode !== null || child.signalCode !== null);
    }
  } else {
    suite.check("stream switch: recorded executable is still launchable", false, argv[0]);
  }

  // An explicit versioned Node that is not the PATH Node must remain explicit. This also creates
  // a real old-style installed unit for the recovery guidance checks, without editing its bytes.
  const legacy = fixture("legacy");
  legacy.env.PATH = `${native}:/usr/bin:/bin`;
  suite.check("explicit runtime control: install succeeds", legacy.run(legacy.oldNode, "install", "--plain").status === 0);
  const oldSource = readFileSync(legacy.unit(), "utf8");
  suite.check("an unrelated PATH Node does not replace the explicitly selected runtime", oldSource.includes(`ExecStart="${legacy.oldNode}"`));
  renameSync(legacy.oldNode, `${legacy.oldNode}.retired`);
  for (const format of ["--plain", "--json"]) {
    const retry = legacy.run(process.execPath, "install", format);
    suite.check(`legacy missing runtime ${format}: refusal names uninstall and reinstall`, retry.status === 2 && retry.text.includes("CONFLICT") && retry.text.includes("cotal daemon uninstall") && retry.text.includes("--yes") && retry.text.includes("cotal daemon install") && retry.text.includes(legacy.home), retry.text);
    const stopped = legacy.run(process.execPath, "status", format);
    suite.check(`legacy missing runtime ${format}: status names native service inspection`, stopped.status === 2 && stopped.text.includes("NOT_RUNNING") && stopped.text.includes("systemctl --user status") && stopped.text.includes("cotal daemon start") && !stopped.text.includes("cotal daemon serve"), stopped.text);
  }
  suite.check("legacy diagnosis preserves source and receipt", readFileSync(legacy.unit(), "utf8") === oldSource && existsSync(join(legacy.home, "service-unit.json")));
  suite.finish();
}
