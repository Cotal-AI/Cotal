/** Native Windows cold-profile creation identity. Run only on a Windows runner. */
import { strict as assert } from "node:assert";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nativeWin32CreationToken } from "../src/win32-process.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertRecordIdentity, defaultStartToken, verifyIdentityPin, writePidPair } from "../src/pid.js";
import { coldOsEnvironment } from "../../../scripts/release-cold-environment.mjs";

assert.equal(process.platform, "win32", "this suite requires a native Windows runner");
const root = mkdtempSync(join(tmpdir(), "win32-cold-identity-"));
const before = { ...process.env };
const check = (name: string, condition: boolean): void => {
  if (!condition) console.error(`FAIL ${name}`);
  assert.ok(condition, name);
  console.log(`PASS ${name}`);
};
try {
  const cold = coldOsEnvironment(before);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, cold);
  for (const name of ["home", "local", "roaming", "tmp"]) mkdirSync(join(root, name));
  Object.assign(process.env, { HOME: join(root, "home"), USERPROFILE: join(root, "home"), LOCALAPPDATA: join(root, "local"), APPDATA: join(root, "roaming"), TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp") });
  const started = performance.now();
  const token = defaultStartToken(process.pid);
  console.log(JSON.stringify({ firstReadMs: Math.round(performance.now() - started), tokenPresent: token !== undefined }));
  check("W1 a cold Windows process has a native creation token", token !== undefined && /^\d{1,20}$/.test(token));
  const path = join(root, "self.pid");
  writePidPair(path, process.pid);
  const pin = verifyIdentityPin(path);
  check("W2 a cold native Windows pin matches its process", pin.kind === "match" && pin.record.token === token);
  check("W3 native Windows creation identity still refuses a changed token", assertRecordIdentity({ pid: process.pid, token: `${token}0` }).kind === "mismatch");
  // This independent compatibility oracle runs only after the first cold production read.
  // Its startup allowance is not a production timeout, retry or qualification waiver.
  const reference = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `$p=[System.Diagnostics.Process]::GetProcessById(${process.pid}); $p.StartTime.ToUniversalTime().ToFileTimeUtc(); $p.HandleCount`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 }).trim().split(/\r?\n/);
  check("W4 native FILETIME matches the prior reader without rounding", reference.length === 2 && reference[0] === token && /^\d+$/.test(reference[1]!));
  check("W5 invalid pids are refused by the actual native binding",
    [0, -1, 1.5, NaN, Infinity, 0x80000000, 0x100000000 + process.pid].every((pid) => nativeWin32CreationToken(pid) === undefined));
  const workspace = fileURLToPath(new URL("..", import.meta.url));
  const fixture = join(workspace, "build", "test", `win32-${process.arch}`, "query-control.exe");
  const target = spawn(fixture, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const exited = new Promise<void>((resolve) => target.once("exit", () => resolve()));
  target.stdin.on("error", () => {}); // A failed fixture may close stdin before cleanup.
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("query-denied fixture did not become ready")), 5000);
      const done = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
      target.once("error", done);
      target.once("exit", () => done(new Error("query-denied fixture exited before its control completed")));
      target.stdout.on("data", (data: Buffer) => {
        output += data.toString("utf8");
        if (output === "ready\r\n" || output === "ready\n") done();
        else if (output.length > 32) done(new Error("invalid query-denied fixture output"));
      });
    });
    const denied = spawnSync(fixture, ["--probe", String(target.pid)], { encoding: "utf8", timeout: 5000 });
    const native = nativeWin32CreationToken(target.pid!);
    console.log(JSON.stringify({ scope: "diagnostic only, no qualification", denialProbeStatus: denied.status,
      denialProbeSignal: denied.signal, denialProbeError: denied.error?.message, denialProbeOutput: denied.stdout.trim().slice(0, 1024), nativeTokenPresent: native !== undefined }));
    check("W6 an independently verified query denial stays unverified",
      denied.status === 0 && JSON.parse(denied.stdout).error === 5 && native === undefined);
  } finally {
    target.stdin.end();
    const killer = setTimeout(() => target.kill("SIGKILL"), 5000);
    try { await Promise.race([exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("query-denied fixture exit was not confirmed")), 10_000).unref())]); }
    finally { clearTimeout(killer); }
    assert.equal(target.exitCode, 0, "query-denied fixture did not exit cleanly");
  }
  const repeated = performance.now();
  check("W7 repeated native reads keep the same creation identity", Array.from({ length: 1000 }, () => defaultStartToken(process.pid)).every((value) => value === token));
  console.log(JSON.stringify({ repeatedNativeReads: 1000, elapsedMs: Math.round(performance.now() - repeated) }));
  const relocated = join(root, "installation with spaces");
  mkdirSync(join(relocated, "dist"), { recursive: true });
  const module = join(relocated, "dist", "win32-process.mjs");
  copyFileSync(join(workspace, "dist", "win32-process.js"), module);
  const probe = () => spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { nativeWin32CreationToken as read } from ${JSON.stringify(pathToFileURL(module).href)}; console.log(read(process.pid));`],
    { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
  const missing = probe();
  check("W8 a missing native binding is a loud installation failure", missing.status !== 0 && missing.stderr.includes("could not load the shipped Windows creation identity binding"));
  const nativeDir = join(relocated, "build", "Release", `win32-${process.arch}`);
  mkdirSync(nativeDir, { recursive: true });
  writeFileSync(join(nativeDir, "creation.node"), "not a Windows binding");
  const corrupt = probe();
  check("W9 a corrupt native binding is a loud installation failure", corrupt.status !== 0 && corrupt.stderr.includes("could not load the shipped Windows creation identity binding"));
  copyFileSync(join(workspace, "build", "Release", `win32-${process.arch}`, "creation.node"), join(nativeDir, "creation.node"));
  const valid = probe();
  check("W10 the shipped binding loads from an installation path with spaces", valid.status === 0 && /^\d{1,20}$/.test(valid.stdout.trim()));
  const handlesAfter = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `[System.Diagnostics.Process]::GetProcessById(${process.pid}).HandleCount`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 }).trim();
  check("W11 repeated native identity reads do not retain process handles", /^\d+$/.test(handlesAfter) && Number(handlesAfter) - Number(reference[1]) <= 16);
  console.log("WINDOWS COLD CREATION OK (11 checks; native Windows only)");
} finally {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, before);
  rmSync(root, { recursive: true, force: true });
}
