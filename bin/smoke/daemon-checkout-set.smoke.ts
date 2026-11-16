import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "dcs-"));
const binary = fileURLToPath(new URL("..", import.meta.url));
for (const name of ["home", "config", "runtime"]) mkdirSync(join(root, name), { mode: 0o700 });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
Object.assign(env, { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), APPDATA: join(root, "config"), XDG_RUNTIME_DIR: join(root, "runtime"), COTAL_HOME: join(root, "home/.cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1" });
async function start(entry: string, ready: boolean): Promise<void> {
  const child = spawn(process.execPath, [entry, "daemon", "serve"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
  try {
    if (ready) {
      for (let attempt = 0; attempt < 100 && !stdout.includes("daemon ready at") && child.exitCode === null; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
      assert(stdout.includes("daemon ready at"), `daemon must serve before its first connector reconciliation: ${stderr}`);
      child.kill("SIGTERM");
      assert.deepEqual(await ended, { code: 0, signal: null });
    } else {
      const result = await ended;
      assert.notEqual(result.code, 0);
      assert.match(stderr, /connector set.*missing or incomplete.*cotal ext seed --repair/s);
      assert(!stdout.includes("daemon ready at"));
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await ended;
    clearTimeout(timer);
  }
}
try {
  await start(join(binary, "dist/cotal.js"), true);
  assert.equal(existsSync(join(root, "config/cotal/installs")), false, "checkout startup does not create installed connector state");
  const installed = join(root, "prefix", "lib", "node_modules", "cotal-ai");
  mkdirSync(installed, { recursive: true, mode: 0o700 });
  cpSync(join(binary, "dist"), join(installed, "dist"), { recursive: true });
  cpSync(join(binary, "package.json"), join(installed, "package.json"));
  symlinkSync(join(binary, "node_modules"), join(installed, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await start(join(installed, "dist/cotal.js"), true);
  const canonicalInstalled = realpathSync.native(installed);
  const identity = process.platform === "win32" ? canonicalInstalled.toLowerCase() : canonicalInstalled;
  const id = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  const store = join(root, "config", process.platform === "win32" ? "Cotal" : "cotal", "installs", id);
  mkdirSync(store, { recursive: true, mode: 0o700 });
  const version = (JSON.parse(readFileSync(join(installed, "package.json"), "utf8")) as { version: string }).version;
  writeFileSync(join(store, "install.json"), JSON.stringify({ installRoot: canonicalInstalled, current: version, versions: [version] }), { mode: 0o600 });
  await start(join(installed, "dist/cotal.js"), false);
  console.log("daemon set admission: checkout and new installation serve before seeding; a missing committed own set still refuses with repair");
} finally { rmSync(root, { recursive: true, force: true }); }
