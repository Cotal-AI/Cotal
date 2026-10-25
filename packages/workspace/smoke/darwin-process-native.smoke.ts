/** Native macOS process identity through the shipped binding. Run only on a macOS runner. */
import { strict as assert } from "node:assert";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { darwinProcessBinding } from "../src/darwin-process.js";
import { processStartToken as lstartReader } from "../src/advisory-lock.js";
import { assertRecordIdentity, defaultStartToken, identityPinPath, processGroupMembers, processGroupOf, processStopped, verifyIdentityPin, writePidPair } from "../src/pid.js";

assert.equal(process.platform, "darwin", "this suite requires a native macOS runner");
const native = darwinProcessBinding();
const root = mkdtempSync(join(tmpdir(), "darwin-process-identity-"));
const children: ChildProcess[] = [];
let checks = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  if (!condition) console.error(`FAIL ${name}`, detail ?? "");
  assert.ok(condition, name);
  checks++;
  console.log(`PASS ${name}`);
};
const tool = (path: string, args: string[]) => execFileSync(path, args, { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const self = native.processInfo(process.pid);
  check("D1 this process reads a microsecond start token, its group and a running state",
    self !== undefined && /^\d{16,20}$/.test(self.token) && self.pgid === Number(tool("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)])) && !self.stopped, self);
  const lstart = tool("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)]);
  check("D2 the token's second is the start second ps reports", BigInt(self!.token) / 1_000_000n === BigInt(Date.parse(lstart) / 1000), { token: self!.token, lstart });
  check("D3 repeated reads keep the same start token", Array.from({ length: 1000 }, () => native.processInfo(process.pid)?.token).every((token) => token === self!.token));

  const a = spawn("/bin/sleep", ["30"], { stdio: "ignore" }), b = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  children.push(a, b);
  const [ta, tb] = [native.processInfo(a.pid!)?.token, native.processInfo(b.pid!)?.token];
  check("D4 two children started back to back carry different start tokens", ta !== undefined && tb !== undefined && ta !== tb && ta !== self!.token, { ta, tb });

  const done = spawn("/usr/bin/true", [], { stdio: "ignore" });
  await once(done, "exit");
  await sleep(200);
  check("D5 an exited and reaped process reads as absent", native.processInfo(done.pid!) === undefined);

  // A detached start leads its own group; its backgrounded child stays in it.
  const leader = spawn("/bin/sh", ["-c", "/bin/sleep 300 & exec /bin/sleep 300"], { detached: true, stdio: "ignore" });
  children.push(leader);
  let members: number[] | undefined = [];
  for (let i = 0; i < 50 && (members?.length ?? 0) < 2; i++) { await sleep(100); members = native.groupMembers(leader.pid!); }
  const other = members?.find((pid) => pid !== leader.pid);
  check("D6 a detached start's group lists the leader and its backgrounded child",
    members?.length === 2 && members.includes(leader.pid!) && other !== undefined && native.processInfo(other)?.pgid === leader.pid && native.processInfo(leader.pid!)?.pgid === leader.pid, members);
  check("D7 a group with no process reads empty", JSON.stringify(native.groupMembers(done.pid!)) === "[]");
  process.kill(leader.pid!, "SIGSTOP");
  let stopped = false;
  for (let i = 0; i < 50 && !stopped; i++) { await sleep(50); stopped = native.processInfo(leader.pid!)?.stopped === true; }
  process.kill(leader.pid!, "SIGCONT");
  let resumed = false;
  for (let i = 0; i < 50 && !resumed; i++) { await sleep(50); resumed = native.processInfo(leader.pid!)?.stopped === false; }
  check("D8 a stopped process reads stopped, and running again after SIGCONT", stopped && resumed);
  process.kill(-leader.pid!, "SIGKILL");
  let emptied = false;
  for (let i = 0; i < 50 && !emptied; i++) { await sleep(100); emptied = native.groupMembers(leader.pid!)?.length === 0; }
  check("D9 a killed group reads empty once its members are reaped or gone", emptied, native.groupMembers(leader.pid!));

  const host = native.hostIdentity();
  const platformUuid = /"IOPlatformUUID" = "([0-9A-F-]{36})"/.exec(tool("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]))?.[1];
  check("D10 the machine identity is the platform UUID, lower case", platformUuid !== undefined && host.machine === platformUuid.toLowerCase(), { host, platformUuid });
  const boot = tool("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]);
  check("D11 the boot identity is this boot's session UUID, the same on a second read",
    /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(host.boot) && host.boot === boot && native.hostIdentity().boot === boot, { host, boot });
  check("D12 arguments that are not process IDs read as absent",
    [0, -1, 1.5, NaN, Infinity, 0x80000000].every((pid) => native.processInfo(pid) === undefined && native.groupMembers(pid) === undefined));

  // The identity contract every stop path uses reads the native microsecond token on macOS.
  check("D16 the default start token is the native microsecond token", defaultStartToken(process.pid) === self!.token);
  const pidPath = join(root, "self.pid");
  writePidPair(pidPath, process.pid);
  const pin = verifyIdentityPin(pidPath);
  check("D17 a pin written now matches its process, and a changed token is a mismatch",
    pin.kind === "match" && pin.record.token === self!.token && assertRecordIdentity({ pid: process.pid, token: String(BigInt(self!.token) + 1n) }).kind === "mismatch", pin);
  const lstartToken = lstartReader(process.pid);
  const legacyPath = join(root, "legacy.pid");
  writeFileSync(legacyPath, String(process.pid));
  writeFileSync(identityPinPath(legacyPath), `${process.pid} ${lstartToken}\n`);
  const legacy = verifyIdentityPin(legacyPath);
  check("D18 a pin an earlier release wrote with the lstart date still matches its process", lstartToken !== undefined && !/^\d+$/.test(lstartToken) && legacy.kind === "match", { lstartToken, legacy });
  const group = spawn("/bin/sh", ["-c", "/bin/sleep 300 & exec /bin/sleep 300"], { detached: true, stdio: "ignore" });
  children.push(group);
  let listed: number[] = [];
  for (let i = 0; i < 50 && listed.length < 2; i++) { await sleep(100); listed = processGroupMembers(group.pid!); }
  process.kill(group.pid!, "SIGSTOP");
  let paused = false;
  for (let i = 0; i < 50 && !paused; i++) { await sleep(50); paused = processStopped(group.pid!); }
  process.kill(group.pid!, "SIGCONT");
  check("D19 the shared group and stopped readers answer on macOS",
    processGroupOf(group.pid!) === group.pid && listed.length === 2 && listed.includes(group.pid!) && paused && processGroupOf(done.pid!) === undefined, { listed, paused });
  process.kill(-group.pid!, "SIGKILL");

  const workspace = fileURLToPath(new URL("..", import.meta.url));
  const relocated = join(root, "installation with spaces");
  mkdirSync(join(relocated, "dist"), { recursive: true });
  const module = join(relocated, "dist", "darwin-process.mjs");
  copyFileSync(join(workspace, "dist", "darwin-process.js"), module);
  const probe = () => spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { darwinProcessBinding as load } from ${JSON.stringify(pathToFileURL(module).href)}; console.log(load().processInfo(process.pid).token);`],
    { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
  const missing = probe();
  check("D13 a missing native binding is a loud installation failure", missing.status !== 0 && missing.stderr.includes("could not load the shipped macOS process identity binding"), missing.stderr);
  const nativeDir = join(relocated, "build", "Release", `darwin-${process.arch}`);
  mkdirSync(nativeDir, { recursive: true });
  writeFileSync(join(nativeDir, "process.node"), "not a macOS binding");
  const corrupt = probe();
  check("D14 a corrupt native binding is a loud installation failure", corrupt.status !== 0 && corrupt.stderr.includes("could not load the shipped macOS process identity binding"), corrupt.stderr);
  copyFileSync(join(workspace, "build", "Release", `darwin-${process.arch}`, "process.node"), join(nativeDir, "process.node"));
  const valid = probe();
  check("D15 the shipped binding loads from an installation path with spaces", valid.status === 0 && /^\d{16,20}$/.test(valid.stdout.trim()), valid);
  console.log(`MACOS PROCESS IDENTITY OK (${checks} checks; ${process.arch}, ${process.version})`);
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) try { process.kill(child.pid!, "SIGKILL"); } catch { /* already gone */ }
  rmSync(root, { recursive: true, force: true });
}
