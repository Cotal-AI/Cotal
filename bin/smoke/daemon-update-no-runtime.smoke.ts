/** The shipped updater reaches the recorded Linux user service from a non-login session. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { skipSuite } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux") skipSuite("daemon receipt without runtime: Linux runtime discovery only");
const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "dnr-")));
const entry = join(repo, "bin/dist/cotal.js");
const runtime = `/run/user/${process.geteuid!()}`;
const version = JSON.parse(readFileSync(join(repo, "bin/package.json"), "utf8")).version as string;
const newer = `${Number(version.split(".")[0]) + 1}.0.0`;
let latest = version;
const registry = createServer((_request, response) => response.end(JSON.stringify({ name: "cotal-ai", "dist-tags": { latest }, versions: { [latest]: { name: "cotal-ai", version: latest } } })));

async function run(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => stdout += String(chunk));
  child.stderr.on("data", chunk => stderr += String(chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    return { code, stdout, output: stdout + stderr };
  } finally { clearTimeout(timer); }
}

await new Promise<void>(resolve => registry.listen(0, "127.0.0.1", resolve));
try {
  for (const kind of ["malformed", "dangling", "absent", "discovered", "explicit", "bad-mode", "symlink", "unavailable", "newer", "target-check"] as const) {
    const directory = join(root, kind);
    for (const part of ["home", "cotal/daemon", "config", "cache", "data", "state", "tmp", "native", "explicit"]) mkdirSync(join(directory, part), { recursive: true, mode: 0o700 });
    const receipt = join(directory, "cotal/daemon/service-unit.json");
    const privateRuntime = join(directory, "runtime");
    const seed = join(directory, "config/cotal/seed");
    const log = join(directory, "systemctl.log");
    const legacy = kind === "malformed" || kind === "dangling" || kind === "absent";
    if (kind === "malformed") writeFileSync(receipt, "{}", { mode: 0o600 });
    if (kind === "dangling") symlinkSync(join(directory, "missing-receipt"), receipt);
    if (!legacy) {
      const unitPath = join(directory, "config/systemd/user/cotal-daemon.service");
      mkdirSync(dirname(unitPath), { recursive: true, mode: 0o700 });
      const source = `[Service]\nEnvironment=COTAL_DAEMON_NATIVE_SERVICE=1\nExecStart="${process.execPath}" "${entry}" daemon serve\nRestart=always\n`;
      writeFileSync(unitPath, source, { mode: 0o600 });
      writeFileSync(receipt, JSON.stringify({ v: 1, mechanism: "systemd-user", unit: "cotal-daemon.service", unitPath, unitSha256: createHash("sha256").update(source).digest("hex"), installedAt: new Date().toISOString() }), { mode: 0o600 });
      // Model an operator who removed every built-in, so reconciliation needs no downloads.
      mkdirSync(seed, { recursive: true, mode: 0o700 });
      for (const file of ["authority.json", "authority.bak.json"]) writeFileSync(join(seed, file), JSON.stringify({ everSeeded: ["claude", "opencode", "codex", "hermes", "jcode", "pi", "web"] }), { mode: 0o600 });
      writeFileSync(join(seed, "witness.json"), JSON.stringify({ initialized: true, firstGeneration: version }), { mode: 0o600 });
    }
    if (!legacy && kind !== "unavailable") {
      if (kind === "symlink") symlinkSync(join(directory, "explicit"), privateRuntime);
      else {
        mkdirSync(privateRuntime, { mode: 0o700 });
        if (kind === "bad-mode" || kind === "explicit") chmodSync(privateRuntime, 0o755);
      }
    }
    // Only redirect filesystem lookups under the default runtime. The CLI still has to validate
    // the fixture and give systemctl the real default path, without reaching the host's socket.
    const preload = join(directory, "runtime.mjs");
    writeFileSync(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const lstat = fs.lstatSync, runtime = ${JSON.stringify(runtime)}, fixture = ${JSON.stringify(privateRuntime)};
fs.lstatSync = (path, ...args) => lstat(typeof path === 'string' && (path === runtime || path.startsWith(runtime + '/')) ? fixture + path.slice(runtime.length) : path, ...args);
syncBuiltinESMExports();\n`);
    const expectedRuntime = kind === "explicit" ? join(directory, "explicit") : runtime;
    writeFileSync(join(directory, "native/systemctl"), `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2).join(' '), runtime = process.env.XDG_RUNTIME_DIR;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([args, runtime ?? null]) + '\\n');
if (args !== '--user show-environment' || runtime !== ${JSON.stringify(expectedRuntime)}) process.exit(1);
console.log(${JSON.stringify(`XDG_CONFIG_HOME=${join(directory, "config")}`)});\n`, { mode: 0o700 });
    for (const name of ["loginctl", "busctl"]) writeFileSync(join(directory, "native", name), "#!/bin/sh\nexit 95\n", { mode: 0o700 });
    const env: NodeJS.ProcessEnv = {
      PATH: `${join(directory, "native")}:${process.env.PATH}`, HOME: join(directory, "home"), COTAL_HOME: join(directory, "cotal"),
      XDG_CONFIG_HOME: join(directory, "config"), XDG_CACHE_HOME: join(directory, "cache"),
      XDG_DATA_HOME: join(directory, "data"), XDG_STATE_HOME: join(directory, "state"), TMPDIR: join(directory, "tmp"),
      npm_config_registry: `http://127.0.0.1:${(registry.address() as AddressInfo).port}`,
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      COTAL_ALLOW_CHECKOUT_SEED: "1", DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1",
    };
    latest = kind === "newer" ? newer : version;
    if (kind === "explicit") env.XDG_RUNTIME_DIR = expectedRuntime;
    const request = { v: 1, nonce: "a".repeat(32), installedEntry: entry, daemonArgv: [process.execPath, entry, "daemon", "serve"], flags: {} };
    const { code, stdout, output } = await run(kind === "target-check"
      ? [join(repo, "bin/dist/execution-preinstall.js"), JSON.stringify(request)]
      : [entry, "update", ...(legacy || kind === "newer" ? ["--self"] : [])], directory, env);
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
    if (kind === "malformed" || kind === "dangling") {
      assert.equal(code, 1, output);
      assert.match(output, /installed daemon preflight.*no installed unit recorded/);
      assert.doesNotMatch(output, /XDG_RUNTIME_DIR is not set/);
      assert.doesNotMatch(output, /Built-in connectors|wrote operator-global seed store payload/);
      assert.equal(existsSync(join(directory, "config/cotal/seed")), false, output);
      assert.equal(existsSync(join(directory, "config/cotal/extensions.json")), false, output);
      assert.deepEqual(calls, []);
    } else if (kind === "absent") {
      // The local registry serves version discovery, not package archives. Admission must reach
      // real seed writes, then fail on the intentionally unavailable Jcode package dependency.
      assert.equal(code, 1, output);
      assert.match(output, /ETARGET.*No matching version found for cotal-ai@\^1\.1\.0/s);
      assert.doesNotMatch(output, /installed daemon preflight/);
      assert.match(output, /wrote operator-global seed store payload/);
      assert.equal(existsSync(seed), true, output);
      assert.deepEqual(calls, []);
    } else if (kind === "bad-mode" || kind === "symlink" || kind === "unavailable") {
      assert.notEqual(code, 0, output);
      assert.match(output, kind === "bad-mode" ? /has mode 0755, not 0700/ : kind === "symlink" ? /is a symlink/ : /installed daemon preflight: the systemd user manager did not answer/);
      assert.deepEqual(calls, kind === "unavailable" ? [["--user show-environment", null]] : []);
      assert.equal(existsSync(join(seed, "stamp.json")), false, output);
      if (kind === "bad-mode") assert.equal(lstatSync(privateRuntime).mode & 0o777, 0o755);
      if (kind === "symlink") assert.ok(lstatSync(privateRuntime).isSymbolicLink());
      if (kind === "unavailable") assert.equal(existsSync(privateRuntime), false);
    } else if (kind === "newer") {
      // The newer tag is visible, but the fixture provides no release archive metadata.
      assert.equal(code, 1, output);
      assert.match(output, /Checking cotal-ai@.* release archives/);
      assert.match(output, /metadata .* is incomplete or invalid/);
      assert.doesNotMatch(output, /installed daemon preflight/);
      assert.deepEqual(calls, [["--user show-environment", runtime]]);
      assert.equal(existsSync(join(seed, "stamp.json")), false, output);
    } else if (kind === "target-check") {
      assert.equal(code, 0, output);
      assert.ok(stdout.startsWith("COTAL_PREINSTALL_RESULT "), output);
      assert.deepEqual(JSON.parse(stdout.slice("COTAL_PREINSTALL_RESULT ".length)).admission, { disposition: "restart-empty", occupied: 0, hostedSpaces: [] });
      assert.deepEqual(calls, [["--user show-environment", runtime], ["--user show-environment", runtime]]);
      assert.equal(existsSync(join(seed, "stamp.json")), false, output);
    } else {
      assert.equal(code, 0, output);
      assert.match(output, /connector integrations refreshed/);
      assert.equal(existsSync(join(seed, "stamp.json")), true, output);
      assert.deepEqual(calls, [["--user show-environment", expectedRuntime]]);
    }
    console.log(`PASS shipped update runtime: ${kind}`);
  }
} finally { await new Promise<void>((resolve, reject) => registry.close(error => error ? reject(error) : resolve())); }
