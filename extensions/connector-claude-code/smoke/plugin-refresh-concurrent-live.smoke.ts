/** Real Claude Code updates in one isolated profile must not overwrite each other's plugin generation. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(mkdtempSync(join(tmpdir(), "cotal-plugin-concurrent-")));
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_") || key.startsWith("CLAUDE_") || key === "CLAUDECODE") delete process.env[key];
Object.assign(process.env, {
  HOME: root, CLAUDE_CONFIG_DIR: join(root, ".claude"), COTAL_HOME: join(root, ".cotal"),
  XDG_CONFIG_HOME: join(root, ".config"), XDG_DATA_HOME: join(root, ".local", "share"), XDG_CACHE_HOME: join(root, ".cache"),
});
const project = join(root, "project");
for (const path of [project, process.env.CLAUDE_CONFIG_DIR!, process.env.COTAL_HOME!]) mkdirSync(path, { recursive: true });
const { acquireLock } = await import("@cotal-ai/core");
const { claudeSetupProvider } = await import("../dist/index.js");
const plugin = "cotal@cotal-mesh";
const cli = [process.execPath, fileURLToPath(new URL("../../../bin/cotal.ts", import.meta.url))];
const manifest = join(process.env.COTAL_HOME!, "claude-plugin", "cotal", ".claude-plugin", "plugin.json");
const version = () => (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
const runClaude = (...args: string[]) => {
  const result = spawnSync("claude", args, { cwd: project, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
let checks = 0;
function check(label: string, test: () => void): void { test(); checks++; console.log(`  ✓ ${label}`); }

try {
  runClaude("--version");
  claudeSetupProvider.connector!.run({ cotal: cli });
  runClaude("plugin", "uninstall", plugin, "--scope", "user");
  runClaude("plugin", "install", plugin, "--scope", "local");
  runClaude("plugin", "disable", plugin, "--scope", "local");
  const initial = version();
  const runner = join(root, "refresh.mjs");
  writeFileSync(runner, `const { claudeSetupProvider: p } = await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});
process.stdout.write("ready\\n");
try { const result = p.refresh.run({ cotal: JSON.parse(process.env.TEST_CLI) }); console.log(JSON.stringify({ok:true,result})); }
catch (error) { console.log(JSON.stringify({ok:false,error:error.message})); process.exitCode=1; }
`);
  const launch = (args: string[]) => {
    const child = spawn(process.execPath, [runner], { cwd: project, env: { ...process.env, TEST_CLI: JSON.stringify(args) }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", stderr = "";
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.includes("ready\n")) ready(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const done = new Promise<{ code: number | null; output: string; stderr: string }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => { ready(); resolve({ code, output, stderr }); });
    });
    return { child, started, done };
  };
  const lock = acquireLock(join(process.env.COTAL_HOME!, "claude-plugin", ".setup.lock"), { label: "concurrent update fixture" });
  const first = launch([process.execPath, "--no-warnings", cli[1]!]);
  const second = launch([process.execPath, "--trace-warnings", cli[1]!]);
  try {
    await Promise.all([first.started, second.started]);
    await new Promise((resolve) => setTimeout(resolve, 350));
    check("both real refresh processes wait before changing the shared generation", () => {
      assert.equal(first.child.exitCode, null);
      assert.equal(second.child.exitCode, null);
      assert.equal(version(), initial);
    });
  } finally { lock.release(); }
  const results = await Promise.all([first.done, second.done]);
  check("both different-generation refreshes finish successfully after serialization", () => {
    for (const result of results) assert.equal(result.code, 0, `${result.output}\n${result.stderr}`);
  });
  const entries = JSON.parse(runClaude("plugin", "list", "--json")) as Array<{ id: string; scope: string; projectPath?: string; version: string; enabled: boolean; readFromFolder?: string }>;
  const entry = entries.find((e) => e.id === plugin && e.scope === "local" && e.projectPath === project);
  check("the native local registration resolves the final materialized generation", () => {
    assert.ok(entry);
    assert.equal(entry.readFromFolder, join(process.env.COTAL_HOME!, "claude-plugin", "cotal"));
    const resolved = JSON.parse(readFileSync(join(entry.readFromFolder!, ".claude-plugin", "plugin.json"), "utf8")) as { version: string };
    assert.equal(resolved.version, version());
    assert.notEqual(resolved.version, initial);
    assert.equal(entry.enabled, false);
  });
  check("the resolved payload still matches the built connector", () => {
    const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    assert.equal(hash(join(entry!.readFromFolder!, "dist", "mcp.cjs")), hash(fileURLToPath(new URL("../dist/mcp.cjs", import.meta.url))));
  });
  console.log(`plugin-refresh-concurrent-live.smoke: ${checks} checks passed`);
} finally {
  console.log(`Isolated native plugin evidence retained at ${root}`);
}
