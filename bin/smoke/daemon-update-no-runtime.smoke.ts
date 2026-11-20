/** The real update entrypoint must not forget a daemon receipt when runtime discovery fails. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { skipSuite } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux") skipSuite("daemon receipt without runtime: Linux runtime discovery only");
const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "dnr-")));
const version = JSON.parse(readFileSync(join(repo, "bin/package.json"), "utf8")).version as string;
const registry = createServer((_request, response) => response.end(JSON.stringify({ name: "cotal-ai", "dist-tags": { latest: version }, versions: { [version]: { name: "cotal-ai", version } } })));
await new Promise<void>(resolve => registry.listen(0, "127.0.0.1", resolve));
try {
  for (const kind of ["present", "dangling", "absent", "runtime", "unsafe-runtime"] as const) {
    const directory = join(root, kind);
    for (const part of ["home", "cotal/daemon", "config", "cache", "data", "state", "tmp"]) mkdirSync(join(directory, part), { recursive: true, mode: 0o700 });
    const receipt = join(directory, "cotal/daemon/service-unit.json");
    if (kind === "present") writeFileSync(receipt, "{}", { mode: 0o600 });
    if (kind === "dangling") symlinkSync(join(directory, "missing-receipt"), receipt);
    const managesUnit = kind === "runtime" || kind === "unsafe-runtime";
    const entry = join(repo, "bin/dist/cotal.js");
    const runtime = `/run/user/${process.geteuid!()}`;
    const privateRuntime = join(directory, "runtime");
    const native = join(directory, "native");
    const calls = join(directory, "native.log");
    const preload = join(directory, "runtime.mjs");
    if (managesUnit) {
      mkdirSync(privateRuntime, { mode: kind === "runtime" ? 0o700 : 0o755 });
      mkdirSync(native, { mode: 0o700 });
      const unitPath = join(directory, "config/systemd/user/cotal-daemon.service");
      mkdirSync(dirname(unitPath), { recursive: true, mode: 0o700 });
      const source = `[Service]\nExecStart="${process.execPath}" "${entry}" daemon serve\n`;
      writeFileSync(unitPath, source, { mode: 0o600 });
      writeFileSync(receipt, JSON.stringify({ v: 1, unit: "cotal-daemon.service", unitPath, unitSha256: createHash("sha256").update(source).digest("hex"), installedAt: new Date().toISOString() }), { mode: 0o600 });
      const seed = join(directory, "config/cotal/seed");
      mkdirSync(seed, { recursive: true, mode: 0o700 });
      for (const file of ["authority.json", "authority.bak.json"]) writeFileSync(join(seed, file), JSON.stringify({ everSeeded: ["claude", "opencode", "codex", "hermes", "jcode", "pi", "web"] }), { mode: 0o600 });
      writeFileSync(join(seed, "witness.json"), JSON.stringify({ initialized: true, firstGeneration: version }), { mode: 0o600 });
      // Redirect only runtime stat calls. The user-manager probe must receive the real default path.
      writeFileSync(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const { lstatSync, readdirSync } = fs;
// Keep the private checkout census independent of unrelated Managers on the test machine.
fs.readdirSync = (file, ...args) => file === '/proc' ? [] : readdirSync(file, ...args);
const runtime = ${JSON.stringify(runtime)}, fixture = ${JSON.stringify(privateRuntime)};
fs.lstatSync = (path, ...args) => lstatSync(typeof path === 'string' && (path === runtime || path.startsWith(runtime + '/')) ? fixture + path.slice(runtime.length) : path, ...args);
syncBuiltinESMExports();\n`);
      writeFileSync(join(native, "systemctl"), `#!${process.execPath}
const runtime = process.env.XDG_RUNTIME_DIR;
require('node:fs').appendFileSync(${JSON.stringify(calls)}, (runtime ?? '<unset>') + '\\n');
if (process.argv.slice(2).join(' ') !== '--user show-environment' || runtime !== ${JSON.stringify(runtime)}) process.exit(1);
console.log(${JSON.stringify(`XDG_CONFIG_HOME=${join(directory, "config")}`)});\n`, { mode: 0o700 });
    }
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: join(directory, "home"), COTAL_HOME: join(directory, "cotal"),
      XDG_CONFIG_HOME: join(directory, "config"), XDG_CACHE_HOME: join(directory, "cache"),
      XDG_DATA_HOME: join(directory, "data"), XDG_STATE_HOME: join(directory, "state"), TMPDIR: join(directory, "tmp"),
      npm_config_registry: `http://127.0.0.1:${(registry.address() as AddressInfo).port}`,
      COTAL_ALLOW_CHECKOUT_SEED: "1", DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1",
    };
    if (managesUnit) {
      env.PATH = `${native}:${env.PATH}`;
      env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
    }
    const child = spawn(process.execPath, managesUnit ? [entry, "update"] : ["--import", join(repo, "node_modules/tsx/dist/loader.mjs"), join(repo, "bin/cotal.ts"), "update", "--self"], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => output += String(chunk));
    child.stderr.on("data", chunk => output += String(chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    let code: number | null;
    try { code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }); }
    finally { clearTimeout(timer); }
    if (kind === "runtime") {
      assert.equal(code, 0, output);
      assert.doesNotMatch(output, /installed daemon preflight/);
      assert.match(output, /connector integrations refreshed/);
      assert.equal(readFileSync(calls, "utf8"), `${runtime}\n`);
    } else if (kind === "unsafe-runtime") {
      assert.equal(code, 1, output);
      assert.match(output, /has mode 0755, not 0700/);
      assert.equal(existsSync(calls), false);
    } else if (kind !== "absent") {
      assert.equal(code, 1, output);
      assert.match(output, /installed daemon preflight.*no installed unit recorded/);
      assert.doesNotMatch(output, /XDG_RUNTIME_DIR is not set/);
      assert.doesNotMatch(output, /Built-in connectors|wrote operator-global seed store payload/);
      assert.equal(existsSync(join(directory, "config/cotal/seed")), false, output);
      assert.equal(existsSync(join(directory, "config/cotal/extensions.json")), false, output);
    } else {
      // The local registry serves version discovery, not package archives. Admission must reach
      // real seed writes, then fail on the intentionally unavailable Jcode package dependency.
      assert.equal(code, 1, output);
      assert.match(output, /ETARGET.*No matching version found for cotal-ai@\^1\.1\.0/s);
      assert.doesNotMatch(output, /installed daemon preflight/);
      assert.match(output, /wrote operator-global seed store payload/);
      assert.equal(existsSync(join(directory, "config/cotal/seed")), true, output);
    }
    console.log(`PASS real update without runtime: ${kind} receipt`);
  }
} finally { await new Promise<void>((resolve, reject) => registry.close(error => error ? reject(error) : resolve())); }
