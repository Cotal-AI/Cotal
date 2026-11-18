import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginGlobalUpdateChild, claimGlobalNpmUpdateLock } from "@cotal-ai/workspace";

const helper = process.env.COTAL_LAUNCH_CUSTODY_HELPER;
if (helper) {
  beginGlobalUpdateChild(helper, "install", true);
  writeFileSync(join(helper, "ready"), "pending");
  // A real owner dies while its gated launch has not published a child PID.
  setInterval(() => {}, 1000);
  await new Promise(() => {});
} else if (process.platform === "linux" || process.platform === "darwin") {
  const root = mkdtempSync(join(tmpdir(), "update-launch-custody-"));
  // Keep crash evidence for inspection. No service or broker is started by this suite.
  const pending = join(root, "pending");
  mkdirSync(pending);
  const owner = spawn(process.execPath, [...process.execArgv, import.meta.filename], {
    env: { ...process.env, COTAL_LAUNCH_CUSTODY_HELPER: pending }, stdio: "ignore",
  });
  const exited = new Promise<void>((resolve, reject) => { owner.once("error", reject); owner.once("exit", () => resolve()); });
  const deadline = Date.now() + 10000;
  while (!existsSync(join(pending, "ready"))) {
    if (Date.now() > deadline) { owner.kill("SIGKILL"); await exited; throw new Error("pending helper did not start"); }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  try {
    assert.throws(() => claimGlobalNpmUpdateLock(pending), /still running under its launch custody/);
  } finally { owner.kill("SIGKILL"); await exited; }
  claimGlobalNpmUpdateLock(pending)();
  assert.equal(existsSync(join(pending, ".cotal-update-child")), false, "a dead gated owner is recoverable before spawn");

  for (const status of [0, 1] as const) {
    const group = join(root, `group-${status}`);
    mkdirSync(group);
    const mutation = beginGlobalUpdateChild(group, "reconcile", true);
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
    const closed = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
    try {
      mutation.markLive(child.pid!);
      assert.throws(() => mutation.complete(status, status === 1 ? "SIGKILL" : null, "group has not drained"), /process group has not exited/);
      const marker = join(group, ".cotal-update-child");
      assert.equal(JSON.parse(readFileSync(marker, "utf8")).phase, "ambiguous");
      const before = readFileSync(marker);
      assert.throws(() => claimGlobalNpmUpdateLock(group), /still running under its launch custody/);
      assert.deepEqual(readFileSync(marker), before, "a live group keeps its original custody record");
      child.kill("SIGKILL");
      await closed;
      claimGlobalNpmUpdateLock(group)();
      assert.equal(existsSync(marker), false, "a drained ambiguous group is reclaimed");
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; }
  }

  const legacy = join(root, "legacy");
  mkdirSync(legacy);
  const marker = join(legacy, ".cotal-update-child");
  for (const record of [
    { phase: "pending", owner: 2147483647, intermediary: false, nonce: "0".repeat(24), operation: "global install" },
    { phase: "ambiguous", owner: 2147483647, nonce: "0".repeat(24), operation: "global reconcile", reason: "unproven descendants" },
    { phase: "pending", owner: 2147483647, intermediary: false, nonce: "0".repeat(24), operation: "global install", custody: { kind: "process-group", pid: 2147483647 } },
  ]) {
    writeFileSync(marker, JSON.stringify(record));
    assert.throws(() => claimGlobalNpmUpdateLock(legacy), /orphaned|ambiguously|invalid/);
    assert.equal(readFileSync(marker, "utf8"), JSON.stringify(record), "legacy or malformed evidence cannot be auto-cleared");
  }
  // An unarmed shell sees EOF and cannot execute even when its parent disappears before publication.
  const touched = join(root, "must-not-run");
  const unarmed = spawnSync("/bin/sh", ["-c", 'IFS= read -r arm <&3 && [ "$arm" = run ] && exec 3<&- && exec "$@"', "gate", process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(touched)},'bad')`], { stdio: ["ignore", "pipe", "pipe", "ignore"] });
  assert.notEqual(unarmed.status, 0);
  assert.equal(existsSync(touched), false);
  console.log(`update launch custody: pending owner crash, drained groups and legacy refusals passed; evidence ${root}`);
}
