/** The small Windows observer keeps the installer's fresh source, task and identity refusals. */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeWindowsOwnedService } from "../daemon/ownership-win32.js";
import { renderScheduledTask, scheduledTaskName } from "../daemon/install-win32.js";

const root = mkdtempSync(join(tmpdir(), "owr-"));
const originalSpawn = childProcess.spawnSync;
const savedMarker = process.env.COTAL_DAEMON_NATIVE_SERVICE;
const sid = "S-1-5-21-1-2-3-1001";
const entry = "C:\\cotal\\dist\\cotal.js";
const expected = ["C:\\node.exe", entry, "daemon", "serve"];
const rendered = renderScheduledTask({ sid, argv: expected, workingDirectory: "C:\\Users\\test" });
const unitPath = join(root, "service-task.xml");
const receiptPath = join(root, "service-unit.json");
const receipt = { v: 1, mechanism: "scheduled-task", unit: scheduledTaskName(undefined, sid), unitPath, unitSha256: rendered.sha256, installedAt: "2026-11-14T00:00:00Z" };
const validTask = { present: true, state: "Running", actions: 1, execute: rendered.command, arguments: rendered.arguments, workingDirectory: "C:\\Users\\test", userId: sid, logonType: 3, runLevel: 0 };
let task: Record<string, unknown> = { ...validTask };
let nativeCalls = 0;
let whoamiSid = sid;
let nativeFailure = false;
const record = (value: unknown = receipt) => writeFileSync(receiptPath, JSON.stringify(value), { mode: 0o600 });
const source = (bytes: Buffer = rendered.bytes) => writeFileSync(unitPath, bytes, { mode: 0o600 });
let cells = 0;
const same = (reason: string, state: string) => { assert.deepEqual(observeWindowsOwnedService({ state: root }, expected), { state, reason }); cells++; };
try {
  childProcess.spawnSync = ((file: string) => {
    nativeCalls++;
    const stdout = file.endsWith("whoami.exe") ? `"host\\user","${whoamiSid}"\r\n` : JSON.stringify(task);
    return { status: nativeFailure ? 1 : 0, stdout, stderr: "", signal: null, pid: 1, output: [] };
  }) as unknown as typeof childProcess.spawnSync;
  syncBuiltinESMExports();
  process.env.COTAL_DAEMON_NATIVE_SERVICE = "1";
  record(); source();
  same("verified", "owned");
  const firstCalls = nativeCalls;
  same("verified", "owned");
  assert.equal(nativeCalls - firstCalls, 2, "each observation rereads SID and registered task"); cells++;
  for (const changed of [{ execute: "C:\\foreign.exe" }, { arguments: "foreign" }, { actions: 2 }, { workingDirectory: "C:\\foreign" }, { userId: "S-1-5-18" }, { logonType: 5 }, { runLevel: 1 }]) {
    task = { ...validTask, ...changed };
    same("observation-failed", "unknown");
  }
  task = { ...validTask };
  whoamiSid = "S-1-5-21-9-9-9-1002";
  same("observation-failed", "unknown"); whoamiSid = sid;
  record({ ...receipt, unitSha256: "0".repeat(64) }); same("observation-failed", "unknown"); record();
  record({ ...receipt, unitPath: join(root, "foreign.xml") }); same("observation-failed", "unknown"); record();
  nativeFailure = true; same("observation-failed", "unknown"); nativeFailure = false;
  task = { ...validTask, execute: undefined }; same("observation-failed", "unknown"); task = { ...validTask };
  assert.deepEqual(observeWindowsOwnedService({ state: root }, [expected[0]!, "C:\\other\\cotal.js", "daemon", "serve"]), { state: "not-owned", reason: "identity-differs" }); cells++;
  const unmarked = renderScheduledTask({ sid, argv: [expected[0]!, "C:\\cotal\\dist\\custom.js", "daemon", "serve"], workingDirectory: "C:\\Users\\test" });
  source(unmarked.bytes); record({ ...receipt, unitSha256: createHash("sha256").update(unmarked.bytes).digest("hex") });
  task = { ...validTask, arguments: unmarked.arguments };
  assert.deepEqual(observeWindowsOwnedService({ state: root }, [expected[0]!, "C:\\cotal\\dist\\custom.js", "daemon", "serve"]), { state: "not-owned", reason: "source-marker-absent" }); cells++;
  source(); record(); task = { ...validTask };
  process.env.COTAL_DAEMON_NATIVE_SERVICE = "0";
  const before = nativeCalls; same("marker-absent", "not-owned"); assert.equal(nativeCalls, before); cells++;
  assert.ok(readFileSync(unitPath).equals(rendered.bytes)); cells++;
  console.log(`PASS Windows ownership leaf refusals: ${cells} checks, fresh native reads and unchanged evidence`);
} finally {
  childProcess.spawnSync = originalSpawn; syncBuiltinESMExports();
  if (savedMarker === undefined) delete process.env.COTAL_DAEMON_NATIVE_SERVICE; else process.env.COTAL_DAEMON_NATIVE_SERVICE = savedMarker;
  rmSync(root, { recursive: true, force: true });
}
