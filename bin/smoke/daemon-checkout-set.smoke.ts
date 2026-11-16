import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "dcs-"));
for (const name of ["home", "config", "runtime"]) mkdirSync(join(root, name), { mode: 0o700 });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
Object.assign(env, { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_RUNTIME_DIR: join(root, "runtime"), COTAL_HOME: join(root, "home/.cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1" });
const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/cotal.js", import.meta.url)), "daemon", "serve"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
let stdout = "", stderr = "";
child.stdout.on("data", chunk => { stdout += String(chunk); });
child.stderr.on("data", chunk => { stderr += String(chunk); });
const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
try {
  for (let attempt = 0; attempt < 100 && !stdout.includes("daemon ready at") && child.exitCode === null; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert(stdout.includes("daemon ready at"), `checkout daemon must serve without an installed connector set: ${stderr}`);
  assert.equal(existsSync(join(root, "config/cotal/installs")), false, "checkout startup does not create installed connector state");
  child.kill("SIGTERM");
  assert.deepEqual(await ended, { code: 0, signal: null });
  console.log("checkout daemon: empty installed connector state does not prevent startup, endpoint ready and shutdown confirmed");
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await ended;
  clearTimeout(timer);
  rmSync(root, { recursive: true, force: true });
}
