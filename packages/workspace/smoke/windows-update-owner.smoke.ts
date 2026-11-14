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
