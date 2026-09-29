import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processStartToken, reapSeat } from "../src/index.js";

if (process.platform !== "linux") throw new Error("group identity proof requires Linux process identities");
const root = mkdtempSync(join(tmpdir(), "seat-group-identity-"));
const pidFile = join(root, "descendant.pid");
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!test() && Date.now() < end) await wait(20);
  return test();
}
function groupOf(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[2]);
}
let checks = 0;
function check(name: string, value: boolean): void {
  assert.ok(value, name); checks++; console.log(`  ✓ ${name}`);
}
const leader = spawn(process.execPath, ["-e", `
const fs = require("node:fs");
const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setTimeout(() => process.exit(0), 250);
`], { detached: true, stdio: "ignore", env: { PATH: process.env.PATH } });
assert.ok(leader.pid);
const leaderStart = processStartToken(leader.pid);
assert.ok(leaderStart);
const exited = new Promise<void>((resolve) => leader.once("exit", () => resolve()));
let descendant = 0;
let descendantStart: string | undefined;
const realKill = process.kill;
const attempted: number[] = [];
try {
  check("owned leader publishes its descendant", await until(() => existsSync(pidFile)));
  descendant = Number(readFileSync(pidFile, "utf8"));
  descendantStart = processStartToken(descendant);
  check("owned descendant has a kernel identity in the actual group", Boolean(descendantStart) && groupOf(descendant) === leader.pid);
  await exited;
  check("group leader has departed the kernel", await until(() => processStartToken(leader.pid!) === undefined));
  check("descendant remains in the dead leader's numeric group", groupOf(descendant) === leader.pid);
  const id = "f".repeat(32), dir = join(root, id), record = join(dir, "record.json");
  mkdirSync(dir, { mode: 0o700 });
  // The older generation is simulated; the live descendant and group are real.
  // This does not claim a naturally recycled PID. Intercept all prospective signals.
  writeFileSync(record, JSON.stringify({ version: 1, id, name: "simulated-prior-generation",
    socket: join(dir, "seat.sock"), token: "fixture-only", custodianPid: leader.pid,
    custodianStart: "1", childPid: leader.pid, childStart: "1",
    bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() }) + "\n", { mode: 0o600 });
  process.kill = ((pid: number) => {
    attempted.push(pid);
    throw Object.assign(new Error("fixture intercepted prospective signal"), { code: "EPERM" });
  }) as typeof process.kill;
  let refusal = "";
  try { await reapSeat(root, id, { graceMs: 400 }); } catch (error) { refusal = (error as Error).message; }
  finally { process.kill = realKill; }
  check("dead-leader numeric group cannot authorize a signal", attempted.length === 0);
  check("unverified group descendant retains its exact identity", processStartToken(descendant) === descendantStart);
  check("ambiguous group ownership refuses reaping", /group ownership is unproved/.test(refusal));
  check("ambiguous group retains the custody record", existsSync(record));
  assert.equal(checks, 8);
  console.log(`SEAT GROUP IDENTITY (${checks} passed, 0 failed; simulated stale record, real kernel group)`);
} finally {
  process.kill = realKill;
  if (descendantStart && processStartToken(descendant) === descendantStart) realKill(descendant, "SIGKILL");
  if (processStartToken(leader.pid!) === leaderStart) realKill(leader.pid!, "SIGKILL");
  await exited;
  assert.ok(await until(() => !descendantStart || processStartToken(descendant) !== descendantStart), "owned descendant departs before fixture deletion");
  rmSync(root, { recursive: true, force: true });
}
