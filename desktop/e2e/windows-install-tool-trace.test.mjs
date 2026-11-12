import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { installWindowsInstallToolTrace } from "./windows-install-tool-trace.mjs";

const source = readFileSync(new URL("../../bin/daemon/install-win32.ts", import.meta.url), "utf8");
const readTask = JSON.parse(/const READ_TASK = (\[[\s\S]*?\])\.join\("\\n"\);/.exec(source)[1].replace(/,\s*\]$/, "]")).join("\n");
const psArgs = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(readTask, "utf16le").toString("base64")];
function harness(original, record) {
  const events = [];
  const childProcess = { spawnSync: original };
  installWindowsInstallToolTrace({ childProcess, record: record ?? (event => events.push(event)) });
  return { childProcess, events };
}
test("preserves receiver, argument identity, return identity and exact basename filtering", () => {
  const result = { status: 0, stdout: "private output", stderr: "" }, args = ["/user", "/fo", "csv", "/nh"], options = { env: { PASSWORD: "hidden" } };
  const receiver = {};
  const { childProcess, events } = harness(function (...received) {
    assert.equal(this, receiver); assert.equal(received[1], args); assert.equal(received[2], options); return result;
  });
  assert.equal(childProcess.spawnSync.call(receiver, "C:\\Windows\\System32\\WHOAMI.EXE", args, options), result);
  assert.equal(events[0].stage, "sid"); assert.equal(events[1].stdoutBytes, 14);
  for (const command of ["not-whoami.exe", "whoami.exe.cmd", "powershell", "schtasks.exe.more"]) childProcess.spawnSync.call(receiver, command, args, options);
  assert.equal(events.length, 2);
  assert.doesNotMatch(JSON.stringify(events), /hidden|private output|PASSWORD/);
});
test("captures timeout and native reason without retaining sensitive lines", () => {
  const result = { status: null, signal: "SIGTERM", error: Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT", syscall: "spawnSync powershell.exe" }), stdout: Buffer.from("private"),
    stderr: Buffer.from("Import-Module : Access is denied.\nhttps://private.example/key\neyJabc.def.ghi\npassword=hidden\nTOKEN: short\n" + "x".repeat(60)) };
  const { childProcess, events } = harness(() => result);
  assert.equal(childProcess.spawnSync("powershell.exe", []), result);
  const end = events[1];
  assert.equal(end.errorCode, "ETIMEDOUT"); assert.equal(end.syscall, "spawnSync powershell.exe");
  assert.equal(end.nativeError, "Import-Module : Access is denied.");
  assert.equal(end.stderrBytes, result.stderr.length); assert.equal(end.signal, "SIGTERM"); assert.ok(end.durationMs >= 0);
  assert.doesNotMatch(JSON.stringify(events), /private|eyJ|hidden|short/);
});
test("parses only READ_TASK allowlist, never other PowerShell output", () => {
  const task = { present: true, state: "Ready", actions: 1, execute: "C:\\Node\\node.exe", arguments: "daemon serve", workingDirectory: "C:\\Cotal", userId: "S-1-5-21", logonType: 3, runLevel: 0, enabled: true, instances: 0, extra: "never retain" };
  const result = { status: 0, stdout: JSON.stringify(task), stderr: "" };
  const { childProcess, events } = harness(() => result);
  childProcess.spawnSync("C:/Windows/powershell.exe", psArgs);
  const { extra, ...expected } = task;
  assert.equal(extra, "never retain"); assert.deepEqual(events[1].task, expected);
  childProcess.spawnSync("powershell.exe", ["-Command", "unrelated"]);
  assert.equal(events[3].task, undefined);
  result.stdout = JSON.stringify({ present: true, arguments: "--token=hidden", execute: "https://secret.example" });
  childProcess.spawnSync("powershell.exe", psArgs);
  assert.equal(events[5].task.arguments, ""); assert.equal(events[5].task.execute, "");
  result.stdout = "not json"; childProcess.spawnSync("powershell.exe", psArgs); assert.equal(events[7].task, null);
});
test("bounded native errors, thrown identity, hostile getters and logging failures stay passive", () => {
  const failure = Object.assign(new Error("Access denied"), { code: "EACCES" });
  const { childProcess, events } = harness(() => { throw failure; });
  assert.throws(() => childProcess.spawnSync("schtasks.exe", ["/Delete"]), error => error === failure);
  assert.equal(events[1].stage, "task-delete"); assert.equal(events[1].errorCode, "EACCES");
  const result = { status: 1, stderr: Array(100).fill("Access denied.").join("\n") };
  const bounded = harness(() => result); bounded.childProcess.spawnSync("powershell.exe", []);
  assert.equal(bounded.events[1].nativeError.length, 512);
  const hostile = { get error() { throw failure; } };
  const silent = harness(() => hostile, () => { throw failure; });
  assert.equal(silent.childProcess.spawnSync("whoami.exe", []), hostile);
  const throwing = harness(() => { throw failure; }, () => { throw new Error("logging failed"); });
  assert.throws(() => throwing.childProcess.spawnSync("whoami.exe", []), error => error === failure);
});
