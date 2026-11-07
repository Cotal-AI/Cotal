/** Real CLI/native-manager readiness on Linux. A saved manager-adapter definition uses a short
 * observation window; SIGSTOP delays only its owned child, without replacing production methods.
 * The default manager preset's 60-second window is also exercised by the installed-package hand test.
 * Run after building the CLI closure: pnpm probe:manager-foreground-readiness. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertRecordIdentity, type ProcessIdentityRecord } from "@cotal-ai/workspace";
import { createSuite, freePort } from "@cotal-ai/smoke-kit";
import { requireProcessIdentity } from "../src/lib/service-instances.js";

assert.equal(process.platform, "linux", "this native scheduling-pause probe requires Linux");
const bin = join(import.meta.dirname, "../../../bin/dist/cotal.js");
assert.ok(existsSync(bin), "build the CLI closure first");
const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-manager-readiness-"));
const root = join(home, "project");
mkdirSync(join(root, ".cotal"), { recursive: true, mode: 0o700 });
const space = `readiness-${randomUUID().slice(0, 8)}`;
// Source-build fixture only: the separate installed-package hand test exercises normal seeding.
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_"))), HOME: home, USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", NO_COLOR: "1" };
let sequence = 0;
const controllers = new Map<ChildProcess, ProcessIdentityRecord>();
const owned: ProcessIdentityRecord[] = [];
let paused: ProcessIdentityRecord | undefined;
let up = false;

function start(args: string[]) {
  const child = spawn(process.execPath, [bin, ...args, "--no-input"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  if (child.pid) controllers.set(child, requireProcessIdentity(child.pid));
  let output = "", code: number | null | undefined;
  child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
  child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
  const exit = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", (value) => { code = value; resolve(); }); });
  return { child, exit, output: () => output, code: () => code };
}
async function run(args: string[]) {
  const call = start(args);
  const timeout = setTimeout(() => {
    const identity = controllers.get(call.child);
    if (identity && assertRecordIdentity(identity).kind === "match") signalOwned(identity, "SIGTERM");
  }, 90000);
  try { await call.exit; } finally { clearTimeout(timeout); }
  writeFileSync(join(home, `command-${sequence++}.log`), call.output());
  return { code: call.code(), output: call.output() };
}
async function until<T>(fn: () => T | Promise<T>, ms = 30000): Promise<T> {
  const end = Date.now() + ms;
  do { const result = await fn(); if (result) return result; await delay(10); } while (Date.now() < end);
  throw new Error("native readiness probe did not reach its expected state");
}
function findChild(parent: number): ProcessIdentityRecord | undefined {
  let children: string[];
  try { children = readFileSync(`/proc/${parent}/task/${parent}/children`, "utf8").trim().split(/\s+/); } catch { return undefined; }
  for (const pid of children.filter(Boolean)) {
    try {
      // Match only our controller's direct child. Never print the command line.
      if (readFileSync(`/proc/${pid}/cmdline`).toString().split("\0").includes("__service-manager")) return requireProcessIdentity(Number(pid));
    } catch { /* A child may exit before observation. */ }
  }
  return undefined;
}
function signalOwned(identity: ProcessIdentityRecord, signal: NodeJS.Signals) {
  assert.equal(assertRecordIdentity(identity).kind, "match", "signal only the creation-pinned fixture process");
  process.kill(identity.pid, signal);
}

try {
  const server = `nats://127.0.0.1:${await freePort()}`;
  const boot = await run(["up", "--open", "--no-manager", "--space", space, "--server", server]);
  check("ordinary broker-only fixture starts", boot.code === 0, boot.code);
  assert.equal(boot.code, 0, boot.output);
  up = true;
  const file = join(home, "manager.json");
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, space,
    launch: { type: "adapter", adapter: "manager-service", options: { root, server, runtime: "pty" } },
    readiness: { type: "adapter", timeoutMs: 2000 } }));
  const added = await run(["service", "add", "slow-manager", "--file", file, "--space", space]);
  check("a native manager definition accepts its explicit observation window", added.code === 0, added.code);
  assert.equal(added.code, 0);

  for (const foreground of [false, true]) {
    const name = foreground ? "foreground" : "background";
    const call = start(["service", "start", "slow-manager", "--space", space, ...(foreground ? ["--foreground", "--plain"] : ["--json"])]);
    assert.ok(call.child.pid);
    const identity = await until(() => findChild(call.child.pid!));
    assert.ok(identity);
    owned.push(identity);
    signalOwned(identity, "SIGSTOP");
    paused = identity;
    await delay(3500);
    check(`${name}: the same native child remains owned past the window`, assertRecordIdentity(identity).kind === "match");
    if (foreground) check("foreground pending readiness does not end its controller", call.code() === undefined, call.code());
    else {
      await until(() => call.code() !== undefined);
      check("background startup still has a bounded unknown outcome", call.code() === 3 && call.output().includes("OPERATION_UNKNOWN"), call.code());
    }
    signalOwned(identity, "SIGCONT");
    paused = undefined;
    await until(async () => {
      const output = foreground ? call.output() : (await run(["service", "logs", "slow-manager", "--space", space])).output;
      return output.includes("manager session plane standing");
    });
    check(`${name}: the unchanged child finishes native startup`, assertRecordIdentity(identity).kind === "match");
    if (foreground) {
      await until(() => call.output().includes("endpoint-serving") || call.code() !== undefined);
      check("foreground records native readiness and still owns the terminal lifetime", call.code() === undefined && call.output().includes("endpoint-serving"));
    }
    const stopped = await run(["service", "stop", "slow-manager", "--space", space, "--yes"]);
    check(`${name}: native stop succeeds`, stopped.code === 0, stopped.code);
    await until(() => assertRecordIdentity(identity).kind !== "match");
    await call.exit;
    writeFileSync(join(home, `${name}.log`), call.output());
    check(`${name}: the creation-pinned child is gone`, assertRecordIdentity(identity).kind !== "match");
  }
  finish();
} finally {
  if (paused && assertRecordIdentity(paused).kind === "match") signalOwned(paused, "SIGCONT");
  if (up) {
    await run(["service", "stop", "slow-manager", "--space", space, "--yes"]).catch(() => {});
    const down = await run(["down", "--yes"]);
    assert.equal(down.code, 0, "the owned fixture stack must stop");
  }
  for (const identity of owned) assert.notEqual(assertRecordIdentity(identity).kind, "match", "no native manager child may survive the probe");
  for (const [controller, identity] of controllers) if (controller.exitCode === null && controller.signalCode === null && assertRecordIdentity(identity).kind === "match") signalOwned(identity, "SIGTERM");
  rmSync(home, { recursive: true, force: true });
}
