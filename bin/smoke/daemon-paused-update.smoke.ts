/**
 * Unusable abandoned update records retire on startup. Unknown owners keep serving while paused.
 * Every path is private to this suite.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { countedAssert, emitSentinel } from "./sentinel.mjs";

const root = mkdtempSync(join(tmpdir(), "dpu-"));
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))),
  HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), COTAL_HOME: join(root, "cotal"), XDG_RUNTIME_DIR: join(root, "rt"),
  DO_NOT_TRACK: "1", COTAL_NO_UPDATE_CHECK: "1" };
for (const dir of [env.HOME, env.XDG_CONFIG_HOME, env.COTAL_HOME, env.XDG_RUNTIME_DIR]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const machineHome = join(root, "machine"); mkdirSync(machineHome, { mode: 0o700 });
const journal = join(env.COTAL_HOME, "update-recovery.json");
// An owner that cannot be a live process: the journal belongs to an update that has ended.
const record = (phase: string) => ({ v: 1, previous: "0.0.1", target: "0.0.2", installed: "0.0.2", phase, reason: "interrupted update restore failed: fixture",
  owner: { pid: 2 ** 22 - 3, start: "1", nonce: "0123456789abcdef01234567" }, preparedRestart: false, recordedAt: new Date().toISOString() });

function serve(): { child: ChildProcess; output: () => string; ready: Promise<boolean>; exited: Promise<number | null> } {
  const child = spawn(process.execPath, ["--import", "tsx", "bin/cotal.ts", "daemon", "serve", "--daemon-home", machineHome], { env, stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  const ready = new Promise<boolean>(resolve => {
    const read = (chunk: Buffer) => { text += String(chunk); if (text.includes("daemon ready at")) resolve(true); };
    child.stdout!.on("data", read); child.stderr!.on("data", read);
    void exited.then(() => resolve(false));
  });
  return { child, output: () => text, ready, exited };
}
async function cli(...args: string[]): Promise<{ code: number | null; out: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "bin/cotal.ts", "daemon", ...args, "--daemon-home", machineHome], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", chunk => out += chunk); child.stderr.on("data", chunk => out += chunk);
  return { code: await new Promise<number | null>(resolve => child.once("exit", resolve)), out };
}

const counted = countedAssert(assert);
const check = (value: unknown, label: string) => counted.assert.ok(value, label);
let running: ReturnType<typeof serve> | undefined;
try {
  const bytes = JSON.stringify(record("replacing"));
  writeFileSync(journal, bytes, { mode: 0o600 });
  running = serve();
  check(await running.ready === true, `an unusable dead-owner record retires and the daemon serves: ${running.output().slice(-400)}`);
  check(!existsSync(journal), "retirement removes the active recovery record");
  const retained = readdirSync(env.COTAL_HOME).filter(name => name.startsWith("update-recovery-retained-"));
  check(retained.length === 1 && readFileSync(join(env.COTAL_HOME, retained[0]!, "update-recovery.json"), "utf8") === bytes, "retirement retains the original recovery bytes");
  check(running.output().includes("Retained unusable interrupted-update records in"), "startup reports the retained folder");
  running.child.kill("SIGTERM"); await running.exited;

  // An unowned record starts its observation bound without preventing daemon service.
  const { owner: _owner, ...unowned } = record("paused");
  const unownedBytes = JSON.stringify(unowned);
  writeFileSync(journal, unownedBytes, { mode: 0o600 });
  running = serve();
  check(await running.ready === true, `an unowned update does not stop the daemon: ${running.output().slice(-400)}`);
  const status = await cli("status", "--json");
  const doc = JSON.parse(status.out);
  check(status.code === 0 && doc.result.state === "ready", "status answers while the update is paused");
  check(doc.result.update.automatic === false, "automatic updates are off while paused");
  check(String(doc.result.update.lastResult).includes("automatic updates paused") && String(doc.result.update.lastResult).includes("seconds remaining"), "status names the observation wait and time remaining");
  check(readFileSync(journal, "utf8") === unownedBytes, "serving does not rewrite the unowned journal bytes");
  check(running.child.exitCode === null, "the daemon is still running");
} finally {
  if (running?.child.exitCode === null) { running.child.kill("SIGTERM"); await running.exited; }
  rmSync(root, { recursive: true, force: true });
}
emitSentinel({ passed: counted.cells(), failed: 0 });
