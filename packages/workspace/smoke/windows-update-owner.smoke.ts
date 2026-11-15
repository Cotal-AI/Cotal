import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsOwnerPredatesRecord, liveWindowsUpdateClosureOwner } from "../src/update-closure-win32.js";
import { win32ProcessBinding } from "../src/win32-process.js";
import { acquireLock } from "../src/advisory-lock.js";
import type { UpdateRecovery } from "../src/updates.js";
import { emitSentinel } from "@cotal-ai/smoke-kit";

let passed = 0;
const check = (condition: boolean) => { assert.ok(condition); passed++; };
const epoch = 116444736000000000n;
const birth = 1700000000000000000n;
const older = epoch + birth / 100n - 1n;
check(windowsOwnerPredatesRecord(String(older), "2023-11-14T22:13:21.000Z", birth));
check(!windowsOwnerPredatesRecord(String(older + 2n), "2023-11-14T22:13:21.000Z", birth));
check(!windowsOwnerPredatesRecord(String(older), "2023-11-14T22:13:19.000Z", birth));
check(!windowsOwnerPredatesRecord("bad", "2023-11-14T22:13:21.000Z", birth));
check(!windowsOwnerPredatesRecord(String(older), "bad", birth));
check(!windowsOwnerPredatesRecord(String(older), "2023-11-14T22:13:21.000Z", 0n));

if (process.platform === "win32") {
  const root = mkdtempSync(join(tmpdir(), "cotal-owner-pin-")), path = join(root, "closure.lock");
  const binding = win32ProcessBinding();
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
  const pid = child.pid!;
  const pin = binding.pinProcess(pid);
  try {
    check(!pin.exited());
    check(pin.token === binding.creationToken(pid));
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    child.kill(); await closed;
    check(pin.exited()); check(pin.exited());
    pin.close(); pin.close();
    assert.throws(() => pin.exited(), /closed/); passed++;
  } finally { pin.close(); child.kill(); }
  const treeScript = `const { spawn } = require("node:child_process");
    const sub = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
    console.log(String(sub.pid));
    setInterval(()=>{},1000);`;
  const treeRoot = spawn(process.execPath, ["-e", treeScript], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const rootPin = binding.pinProcess(treeRoot.pid!);
  try {
    const subPid = await new Promise<number>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error("tree child did not report grandchild pid")), 5000);
      treeRoot.stdout.on("data", (d: Buffer) => {
        out += d.toString("utf8");
        const line = out.trim();
        if (/^\d+$/.test(line)) { clearTimeout(timer); resolve(Number(line)); }
      });
    });
    assert.throws(() => binding.processTree(0, rootPin.token), /processTree requires a PID and creation token/); passed++;
    assert.throws(() => binding.processTree(treeRoot.pid!, `${rootPin.token}0`), /process tree root identity/); passed++;
    const tree = binding.processTree(treeRoot.pid!, rootPin.token);
    try {
      check(tree.some((m) => m.pid === treeRoot.pid! && m.token === rootPin.token));
      check(tree.some((m) => m.pid === subPid && m.token === binding.creationToken(subPid)));
      for (const m of [...tree].reverse()) m.terminate();
      const deadline = Date.now() + 5000;
      while (!tree.every((m) => m.exited()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      check(tree.every((m) => m.exited()));
    } finally {
      for (const m of tree) m.close();
    }
  } finally {
    rootPin.close();
    treeRoot.kill();
  }
  const held = acquireLock(path);
  try {
    const original = readFileSync(path, "utf8");
    const record: UpdateRecovery = { v: 1, previous: "A", target: "B", installed: "A", phase: "replacing", reason: "test", recordedAt: new Date().toISOString(), owner: { pid: process.pid, start: "", nonce: held.nonce } };
    check(liveWindowsUpdateClosureOwner(record, path));
    check(liveWindowsUpdateClosureOwner(record, path));
    check(!liveWindowsUpdateClosureOwner({ ...record, owner: { ...record.owner!, nonce: "foreign" } }, path));
    check(!liveWindowsUpdateClosureOwner({ ...record, owner: { ...record.owner!, start: "1" } }, path));
    check(!liveWindowsUpdateClosureOwner({ ...record, recordedAt: "1970-01-01T00:00:00.000Z" }, path));
    writeFileSync(path, JSON.stringify({ ...JSON.parse(original), nonce: "replaced" }));
    check(!liveWindowsUpdateClosureOwner(record, path));
    writeFileSync(path, original);
  } finally { held.release(); }
} else console.log("UNRUN retained-process and legacy-owner native cases: Windows required");
emitSentinel({ passed, failed: 0 });
