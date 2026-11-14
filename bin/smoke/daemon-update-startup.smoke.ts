/** A daemon restarted by a verified update must answer before its updater releases the closure. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { claimUpdateClosureAccess, updateClosureOwner, writeUpdateRecovery, readUpdateRecovery, clearUpdateRecovery, liveUpdateClosureOwner } from "@cotal-ai/workspace";
import { queryDaemon } from "../daemon/client.js";
import { daemonPaths } from "../daemon/endpoint.js";
import { skipSuite } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux") skipSuite("daemon-update-startup: Linux only");
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const version = (JSON.parse(readFileSync(join(repo, "bin/package.json"), "utf8")) as { version: string }).version;
const root = mkdtempSync(join(tmpdir(), "us-"));
let passed = 0;
for (const phase of ["replacing", "verified-ready", "paused"] as const) {
  const directory = join(root, phase);
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))),
    HOME: join(directory, "home"), COTAL_HOME: join(directory, "home", ".cotal"),
    XDG_CONFIG_HOME: join(directory, "config"), XDG_RUNTIME_DIR: join(directory, "run"), TMPDIR: join(directory, "tmp"),
    DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off", COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_UPDATE_CHECK: "1",
  };
  for (const key of ["HOME", "COTAL_HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "TMPDIR"] as const) {
    process.env[key] = env[key];
    mkdirSync(env[key]!, { recursive: true, mode: 0o700 });
  }
  const snapshot = join(env.XDG_CONFIG_HOME!, "cotal", ".update-snapshot-startup");
  mkdirSync(snapshot, { recursive: true, mode: 0o700 });
  const release = claimUpdateClosureAccess();
  writeUpdateRecovery({ previous: version, target: version, installed: version, phase, reason: "live startup regression", owner: updateClosureOwner(), preparedRestart: true, snapshot });
  const recovery = readUpdateRecovery()!;
  assert.equal(liveUpdateClosureOwner(recovery), true);
  assert.equal(liveUpdateClosureOwner({ ...recovery, owner: { ...recovery.owner!, nonce: "wrong-nonce" } }), false);
  assert.equal(liveUpdateClosureOwner({ ...recovery, owner: { ...recovery.owner!, start: "wrong-start" } }), false);
  assert.equal(liveUpdateClosureOwner(recovery, () => { throw new Error("unreadable process identity"); }), false);
  // Native service restarts do not inherit the updater's closure capability.
  const child = spawn(process.execPath, [join(repo, "bin/dist/cotal.js"), "daemon", "serve"], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  let output = "";
  child.stdout.on("data", bytes => { output += String(bytes); });
  child.stderr.on("data", bytes => { output += String(bytes); });
  try {
    const paths = daemonPaths(env, env.COTAL_HOME!);
    const deadline = Date.now() + 5000;
    while (!existsSync(paths.socket) && child.exitCode === null && Date.now() < deadline) await delay(25);
    assert.equal(existsSync(paths.socket), true, `${phase}: the replacement daemon must publish its endpoint while the live updater holds the closure, instead of waiting for the updater that is waiting for it. ${output}`);
    const reply = await queryDaemon({ paths, timeoutMs: 2000 });
    assert.equal(reply.ok, true, `${phase}: authenticated status must answer`);
    if (reply.ok) {
      assert.equal(reply.result.pid, child.pid);
      assert.equal(reply.result.version, version);
    }
    assert.equal(readUpdateRecovery()?.phase, phase, "startup must not restore or retire a live owner's transaction");
    console.log(`  ✓ ${phase}: real daemon answers while live updater owns closure`);
    passed++;
  } finally {
    // Unblock unchanged-code startup before asking this exact owned process to exit.
    clearUpdateRecovery();
    release();
    const shutdownReady = Date.now() + 3000;
    while (!output.includes("daemon ready at") && child.exitCode === null && Date.now() < shutdownReady) await delay(25);
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    const exit = await ended;
    clearTimeout(timer);
    assert.equal(exit.signal, null, `daemon failed graceful cleanup: ${output}`);
    assert.equal(exit.code, 0, output);
  }
}
for (const phase of ["replacing", "verified-ready", "paused"] as const) {
  const directory = join(root, `k-${phase.slice(0, 1)}`);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(directory, "home"), COTAL_HOME: join(directory, "home/.cotal"), XDG_CONFIG_HOME: join(directory, "config"), XDG_RUNTIME_DIR: join(directory, "run"), TMPDIR: join(directory, "tmp"), COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_UPDATE_CHECK: "1" };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_UPDATE_CLOSURE_")) delete env[key];
  for (const key of ["HOME", "COTAL_HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "TMPDIR"] as const) mkdirSync(env[key]!, { recursive: true, mode: 0o700 });
  const ownerScript = `import {claimUpdateClosureAccess,updateClosureOwner,writeUpdateRecovery} from ${JSON.stringify(new URL("../../packages/workspace/dist/index.js", import.meta.url).href)};import{mkdirSync}from'node:fs';import{join}from'node:path';const snapshot=join(process.env.XDG_CONFIG_HOME,'cotal/.update-snapshot-killed');mkdirSync(snapshot,{recursive:true,mode:0o700});claimUpdateClosureAccess();writeUpdateRecovery({previous:'0.0.1',target:'0.0.2',installed:'0.0.2',phase:${JSON.stringify(phase)},reason:'killed updater regression',owner:updateClosureOwner(),preparedRestart:true,snapshot});console.log('owner ready');setInterval(()=>{},1000);`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", ownerScript], { env, stdio: ["ignore", "pipe", "pipe"] });
  const ownerEnded = new Promise(resolve => owner.once("close", resolve));
  await new Promise<void>((resolve, reject) => { owner.stdout.once("data", () => resolve()); owner.once("error", reject); owner.once("exit", code => { if (code !== null) reject(new Error(`owner exited ${code}`)); }); });
  const child = spawn(process.execPath, [join(repo, "bin/dist/cotal.js"), "daemon", "serve"], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  const ended = new Promise(resolve => child.once("close", resolve));
  let output = ""; child.stdout.on("data", b => { output += String(b); }); child.stderr.on("data", b => { output += String(b); });
  const paths = daemonPaths(env, env.COTAL_HOME!);
  try {
    const ready = Date.now() + 5000;
    while (!existsSync(paths.socket) && child.exitCode === null && Date.now() < ready) await delay(25);
    assert.equal(existsSync(paths.socket), true, output);
    owner.kill("SIGKILL"); await ownerEnded;
    const recovered = Date.now() + 5000;
    while (!/guarded interrupted-update recovery refused|interrupted update remains paused/.test(output) && Date.now() < recovered) await delay(25);
    assert.match(output, /daemon: observed updater ended; checking guarded interrupted-update recovery/);
    assert.match(output, phase === "paused" ? /interrupted update remains paused/ : /guarded interrupted-update recovery refused/);
    const reply = await queryDaemon({ paths, timeoutMs: 2000 });
    assert.equal(reply.ok, true, "the same daemon keeps answering after guarded recovery refuses");
    if (reply.ok) {
      assert.equal(reply.result.pid, child.pid);
      assert.equal(reply.result.update?.automatic, false);
      assert.match(reply.result.update?.lastResult ?? "", /automatic updates paused/);
    }
    console.log(`  ✓ killed ${phase} updater: same daemon reports guarded recovery refusal and pause`);
    passed++;
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    await ownerEnded;
    child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5000); await ended; clearTimeout(timer);
  }
}
console.log(`COTAL_SMOKE_SENTINEL cells=${passed} passed=${passed} failed=0`);
