/** Drive setup with the real Desktop Code binary, without a standalone claude command or login
 * state. Usage: tsx smoke/desktop-only-setup-live.smoke.ts /path/to/Desktop/bundled/claude */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const binary = process.argv[2];
if (!binary) throw new Error("pass the actual Desktop app's bundled Claude Code executable");
const actual = realpathSync(binary);
const version = spawnSync(actual, ["--version"], { encoding: "utf8" });
assert.equal(version.status, 0, version.stderr);
const number = /\b(\d+\.\d+\.\d+)\b/.exec(version.stdout)?.[1];
assert.ok(number, version.stdout);
const oldUmask = process.umask(0o077);
const root = realpathSync(mkdtempSync(join(tmpdir(), "cotal-desktop-setup-")));
const app = process.platform === "darwin" ? join(root, "Library", "Application Support", "Claude")
  : process.platform === "win32" ? join(root, "AppData", "Roaming", "Claude") : join(root, ".config", "Claude");
const cache = join(app, "claude-code", number, "fixture");
const binDir = process.platform === "darwin" ? join(cache, "claude.app", "Contents", "MacOS") : cache;
mkdirSync(binDir, { recursive: true });
const installedBinary = join(binDir, process.platform === "win32" ? "claude.exe" : "claude");
if (process.platform === "win32") copyFileSync(actual, installedBinary);
else symlinkSync(actual, installedBinary);
const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !name.startsWith("COTAL_") && !name.startsWith("CLAUDE_") && name !== "CLAUDECODE"));
Object.assign(env, {
  HOME: root,
  XDG_CONFIG_HOME: join(root, ".config"),
  XDG_DATA_HOME: join(root, ".local", "share"),
  XDG_CACHE_HOME: join(root, ".cache"),
  CLAUDE_CONFIG_DIR: join(root, ".claude"),
  COTAL_HOME: join(root, ".cotal"),
  APPDATA: join(root, "AppData", "Roaming"),
  LOCALAPPDATA: join(root, "AppData", "Local"),
  PATH: process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32") : "/usr/bin:/bin",
});
const tools = join(root, "bin");
mkdirSync(tools);
if (process.platform !== "win32") {
  symlinkSync(process.execPath, join(tools, "node"));
  symlinkSync(join(dirname(process.execPath), "npm"), join(tools, "npm"));
  env.PATH = [tools, env.PATH].join(delimiter);
} else env.PATH = [dirname(process.execPath), env.PATH].join(delimiter);
const command = fileURLToPath(new URL("../../../bin/dist/cotal.js", import.meta.url));
const project = join(root, "project");
mkdirSync(project);
try {
  assert.notEqual(spawnSync("claude", ["--version"], { env }).status, 0, "fixture must have no standalone Claude CLI");
  const seeded = spawnSync(process.execPath, [command, "ext", "seed"], {
    env: { ...env, COTAL_ALLOW_CHECKOUT_SEED: "1" }, encoding: "utf8", timeout: 180_000,
  });
  assert.equal(seeded.status, 0, `${seeded.stdout}\n${seeded.stderr}`);
  const installed = spawnSync(process.execPath, [command, "setup", "--destination", "local", "--harness", "claude", "--project", project, "--space", "desktop-setup", "--configure-only", "--no-input", "--json"], {
    env: { ...env, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_SKIP_ASSIST: "1" }, cwd: project, encoding: "utf8", timeout: 180_000,
  });
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
  const result = JSON.parse(installed.stdout) as { result: { harness: { missing: string[]; failed: unknown }; actions: { action: string }[]; startup: { state: string } } };
  assert.deepEqual(result.result.harness.missing, []);
  assert.equal(result.result.harness.failed, null);
  assert.deepEqual(result.result.actions.map((action) => action.action), ["claude-plugin", "claude-mcp-servers", "claude-skills-plugin"]);
  assert.equal(result.result.startup.state, "not-requested");
  const plugin = join(root, ".cotal", "claude-plugin", "cotal");
  const hooks = JSON.parse(readFileSync(join(plugin, "hooks", "hooks.json"), "utf8")) as { modules: string[] };
  assert.deepEqual(hooks.modules, ["./native-wake.js"]);
  const validate = spawnSync(actual, ["plugin", "validate", plugin], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(validate.status, 0, `${validate.stdout}\n${validate.stderr}`);
  assert.match(validate.stdout, /native-wake\.js/);
  const health = spawnSync(actual, ["mcp", "list"], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(health.status, 0, `${health.stdout}\n${health.stderr}`);
  const cotalServer = `${health.stdout}${health.stderr}`.split("\n").find((line) => line.startsWith("plugin:cotal:cotal:"));
  assert.ok(cotalServer, "native MCP discovery must include the installed Cotal server");
  assert.match(cotalServer, /Connected/, "the server must start with the app's minimal PATH");
  console.log(`Desktop bundled Code ${number}, sha256 ${createHash("sha256").update(readFileSync(actual)).digest("hex")}`);
  console.log("DESKTOP-ONLY SETUP PASSED: no standalone Claude CLI, copied login, manual MCP config or launch flags");
} finally {
  rmSync(root, { recursive: true, force: true });
  process.umask(oldUmask);
}
