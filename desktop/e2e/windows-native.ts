import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "win32", "Windows native query measurements require Windows");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = join(process.env.RUNNER_TEMP ?? tmpdir(), "desktop-windows-native");
mkdirSync(output, { recursive: true });
// Bind the measurement to the shipped script, not a hand-maintained approximation.
const source = readFileSync(join(repo, "bin/daemon/install-win32.ts"), "utf8");
const match = /const READ_TASK = (\[[\s\S]*?\])\.join\("\\n"\);/.exec(source);
assert.ok(match, "shipped READ_TASK source is available");
const script = (JSON.parse(match[1].replace(/,\s*\]$/, "]")) as string[]).join("\n");
const nativeSource = readFileSync(join(repo, "desktop/src-tauri/src/lib.rs"), "utf8");
const allowlist = /pub fn daemon_env_key\(key: &str\) -> bool \{([\s\S]*?)\n\}/.exec(nativeSource);
assert.ok(allowlist, "native adapter environment allowlist is available");
const allowed = new Set([...allowlist[1].matchAll(/"([A-Z_]+)"/g)].map(match => match[1]));
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
const system32 = join(process.env.SystemRoot!, "System32");
const powershell = join(system32, "WindowsPowerShell/v1.0/powershell.exe");
const variants = [
  { name: "shipped", command: powershell, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] },
  { name: "explicit-import", command: powershell, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`Import-Module ScheduledTasks\n${script}`, "utf16le").toString("base64")] },
  { name: "schtasks-xml", command: join(system32, "schtasks.exe"), args: ["/query", "/tn", "cotal-e2e-measure-absent", "/xml"] },
];
const results: unknown[] = [];
for (const variant of variants) {
  const root = mkdtempSync(join(tmpdir(), `cotal-native-${variant.name}-`));
  const env: NodeJS.ProcessEnv = { ...baseEnv, COTAL_DAEMON_TASK: "cotal-e2e-measure-absent" };
  for (const [key, leaf] of Object.entries({ HOME: "home", USERPROFILE: "home", APPDATA: "roaming", LOCALAPPDATA: "local", TEMP: "tmp", TMP: "tmp", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state", XDG_RUNTIME_DIR: "rt" })) {
    env[key] = join(root, leaf); mkdirSync(env[key], { recursive: true });
  }
  for (const temperature of ["cold", "warm"]) {
    const started = Date.now();
    const measured = spawnSync(variant.command, variant.args, { env, cwd: env.HOME, encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const error = measured.error as NodeJS.ErrnoException | undefined;
    const row = { variant: variant.name, temperature, elapsedMs: Date.now() - started, status: measured.status, signal: measured.signal, error: error ? { code: error.code, message: error.message } : null, stdout: measured.stdout, stderr: measured.stderr };
    results.push(row); console.log(JSON.stringify(row));
    writeFileSync(join(output, "results.json"), JSON.stringify(results, null, 2));
  }
  // A separate empty profile keeps Measure-Command's cold sample independent of the direct pair.
  const measureRoot = mkdtempSync(join(tmpdir(), `cotal-measure-${variant.name}-`));
  const measureEnv = { ...env };
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) {
    measureEnv[key] = join(measureRoot, key); mkdirSync(measureEnv[key], { recursive: true });
  }
  const quoted = [variant.command, ...variant.args].map(value => `'${value.replaceAll("'", "''")}'`).join(" ");
  const measure = `$m = Measure-Command { & ${quoted} | Out-Host; $script:result = $LASTEXITCODE }; Write-Output ('MEASURE_MS=' + $m.TotalMilliseconds); exit $script:result`;
  for (const temperature of ["cold", "warm"]) {
    const timed = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(measure, "utf16le").toString("base64")], { env: measureEnv, cwd: measureEnv.HOME, encoding: "utf8", timeout: 40_000, windowsHide: true });
    writeFileSync(join(output, `${variant.name}-measure-command-${temperature}.json`), JSON.stringify({ status: timed.status, signal: timed.signal, error: timed.error ? { code: (timed.error as NodeJS.ErrnoException).code, message: timed.error.message } : null, stdout: timed.stdout, stderr: timed.stderr }, null, 2));
  }
}
