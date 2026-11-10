/** The scheduled-task entry belongs to the stock build and starts the same real daemon as the CLI. */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkSecretDir } from "@cotal-ai/core";
import { createSuite, killAndAwaitExit } from "@cotal-ai/smoke-kit";
import { renderScheduledTask } from "../daemon/install-win32.js";

const suite = createSuite();
const repo = resolve(import.meta.dirname, "../..");
const cli = join(repo, "bin/dist/cotal.js");
const native = join(repo, "bin/dist/daemon-native.js");
const root = mkdtempSync(join(tmpdir(), "dne-"));
mkSecretDir(root);
const task = renderScheduledTask({ sid: "S-1-5-21-1", argv: ["C:\\node\\node.exe", "C:\\cotal\\dist\\cotal.js", "daemon", "serve"], workingDirectory: "C:\\cotal" });
suite.check("the stock scheduled task selects the native entry", task.arguments.startsWith("C:\\cotal\\dist\\daemon-native.js "));

// The compiler's effective inputs catch an omitted entry even when a developer has stale dist files.
const compiler = spawnSync(process.execPath, [createRequire(import.meta.url).resolve("typescript/bin/tsc"), "-p", "bin/tsconfig.json", "--showConfig"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
const files = compiler.status === 0 ? (JSON.parse(compiler.stdout) as { files: string[] }).files : [];
suite.check("the stock compiler includes the native entry", compiler.status === 0 && files.some((file) => resolve(repo, "bin", file) === join(repo, "bin/daemon-native.ts")), { code: compiler.status });

for (const [label, entry] of [["native", native], ["ordinary", cli]] as const) {
  const fixture = join(root, label === "native" ? "n" : "c");
  mkSecretDir(fixture);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  delete env.NODE_OPTIONS;
  for (const [key, name] of Object.entries({ HOME: "home", USERPROFILE: "home", XDG_RUNTIME_DIR: "r", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_STATE_HOME: "state", XDG_CACHE_HOME: "cache", APPDATA: "appdata", LOCALAPPDATA: "localappdata" })) {
    const dir = join(fixture, name);
    mkSecretDir(dir);
    env[key] = dir;
  }
  const home = join(fixture, "daemon");
  mkSecretDir(home);
  const cotalHome = join(fixture, "operator");
  mkSecretDir(cotalHome);
  Object.assign(env, { COTAL_HOME: cotalHome, COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", NO_COLOR: "1" });
  const status = () => {
    const result = spawnSync(process.execPath, [cli, "daemon", "status", "--daemon-home", home, "--json"], { cwd: fixture, env, encoding: "utf8", timeout: 15_000 });
    let body: { result?: { state?: string; pid?: number }; error?: { cause?: { code?: string } } } | undefined;
    try { body = JSON.parse(result.stdout); } catch { /* The named checks below report an invalid response. */ }
    return { code: result.status, state: body?.result?.state, pid: body?.result?.pid, cause: body?.error?.cause?.code };
  };
  suite.check(`${label}: built entry exists`, existsSync(entry));
  const child = spawn(process.execPath, [entry, "daemon", "serve", "--daemon-home", home], { cwd: fixture, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", spawnError: string | undefined;
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  try {
    const ready = await new Promise<boolean>((resolveReady) => {
      const timer = setTimeout(() => resolveReady(false), 20_000);
      const finish = (value: boolean) => { clearTimeout(timer); resolveReady(value); };
      child.stdout.on("data", (chunk) => { stdout += String(chunk); if (stdout.includes("daemon ready at ")) finish(true); });
      child.once("error", (error) => { spawnError = error.message; finish(false); });
      child.once("exit", () => finish(false));
    });
    suite.check(`${label}: built entry reaches daemon readiness`, ready, { code: child.exitCode, signal: child.signalCode, spawnError });
    const observed = status();
    suite.check(`${label}: CLI status identifies the answering child`, observed.code === 0 && observed.state === "ready" && observed.pid === child.pid, observed);
    writeFileSync(join(fixture, "startup.json"), JSON.stringify({ ready, observed, pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, spawnError }, null, 2));
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) await killAndAwaitExit(child, "SIGTERM");
    suite.check(`${label}: owned child is stopped`, child.exitCode !== null || child.signalCode !== null || Boolean(spawnError));
    const stopped = status();
    suite.check(`${label}: stopped endpoint refuses NOT_RUNNING`, stopped.code === 2 && stopped.cause === "NOT_RUNNING", stopped);
    writeFileSync(join(fixture, "stdout.log"), stdout);
    writeFileSync(join(fixture, "stderr.log"), stderr);
  }
}
console.log(`Retained daemon entry fixture: ${root}`);
suite.finish();
