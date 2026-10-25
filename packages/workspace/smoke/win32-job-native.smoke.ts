/** Native Windows job custody through the shipped binding. Run only on a Windows runner. */
import { strict as assert } from "node:assert";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nativeWin32CreationToken, win32ProcessBinding, windowsCommandLine, windowsEnvironmentBlock } from "../src/win32-process.js";
import { probeLiveness } from "../src/pid.js";

assert.equal(process.platform, "win32", "this suite requires a native Windows runner");
const root = mkdtempSync(join(tmpdir(), "win32-job-"));
const helpers: ChildProcessWithoutNullStreams[] = [];
let checks = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  if (!condition) console.error(`FAIL ${name}`, detail ?? "");
  assert.ok(condition, name);
  checks++;
  console.log(`PASS ${name}`);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => boolean, ms = 10_000) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(100)) if (condition()) return true;
  return condition();
};
// A retained Windows process handle can keep its creation time readable after exit.
const alive = (pid: number, token: string) => nativeWin32CreationToken(pid) === token && probeLiveness(pid) !== "dead";

// A helper process holds one job, as a custodian does, and answers one JSON request per line.
const dist = pathToFileURL(join(fileURLToPath(new URL("..", import.meta.url)), "dist", "win32-process.js")).href;
const helperScript = `import { createInterface } from "node:readline"; import { win32ProcessBinding } from ${JSON.stringify(dist)};
const native = win32ProcessBinding();
for await (const line of createInterface({ input: process.stdin })) {
  const { op, arg } = JSON.parse(line);
  try { console.log(JSON.stringify({ value: native[op](arg) ?? null })); }
  catch (error) { console.log(JSON.stringify({ error: String(error.message) })); }
}`;
type Reply = { value?: unknown; error?: string };
function helper() {
  const child = spawn(process.execPath, ["--input-type=module", "-e", helperScript], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  helpers.push(child);
  const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return {
    pid: child.pid!,
    async call(op: string, arg?: unknown): Promise<Reply> {
      child.stdin.write(JSON.stringify({ op, arg }) + "\n");
      const next = await Promise.race([replies.next(), sleep(15_000).then(() => undefined)]);
      assert.ok(next && !next.done, `helper did not answer ${op}`);
      return JSON.parse(next.value) as Reply;
    },
  };
}

// The launched program: it starts a detached and an attached child, reports what it received, then waits.
const rootScript = (exitCode?: number) => `const { spawn } = require("node:child_process");
const detached = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }); detached.unref();
const attached = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log(JSON.stringify({ argv: process.argv.slice(1), marker: process.env.COTAL_JOB_TEST, systemRoot: Boolean(process.env.SystemRoot), detached: detached.pid, attached: attached.pid }));
${exitCode === undefined ? "setInterval(() => {}, 1000);" : `setTimeout(() => process.exit(${exitCode}), 500);`}`;
const awkward = ["a b", 'quote"inside', "trailing\\", 'back\\\\slash"q', "", "tab\there", "plain"];
const launchOptions = (log: string, exitCode?: number) => ({
  application: process.execPath,
  commandLine: windowsCommandLine(process.execPath, ["-e", rootScript(exitCode), ...awkward]),
  cwd: root,
  environment: windowsEnvironmentBlock({ PATH: process.env.PATH, COTAL_JOB_TEST: "job marker" }),
  log,
});
const report = async (log: string) => {
  let line: string | undefined;
  await until(() => (line = readFileSync(log, "utf8").split(/\r?\n/).find((row) => row.startsWith("{"))) !== undefined);
  assert.ok(line, `the launched program reported nothing in ${log}`);
  return JSON.parse(line) as { argv: string[]; marker: string; systemRoot: boolean; detached: number; attached: number };
};

try {
  const sid = win32ProcessBinding().userSid();
  const whoami = execFileSync(join(process.env.SystemRoot!, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }).trim();
  check("J1 the user SID is this account's token SID", /^S-1-5-21(-\d+)+$/.test(sid) && whoami.endsWith(`"${sid}"`), { sid, whoami });
  // A test-only oracle: the CIM product UUID is the same SMBIOS field.
  const machine = win32ProcessBinding().machineUuid();
  const cim = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_ComputerSystemProduct).UUID"], { encoding: "utf8", timeout: 30_000 }).trim();
  check("J17 the machine identity is the SMBIOS system UUID, stable across reads",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(machine) && machine === cim.toLowerCase() && win32ProcessBinding().machineUuid() === machine, { machine, cim });

  const one = helper();
  check("J2 a job reader before any launch refuses", (await one.call("jobProcesses")).error === "this process holds no launched job");
  const missing = await one.call("launch", { ...launchOptions(join(root, "absent", "one.log")) });
  check("J3 a launch whose log cannot be opened fails and holds no job", missing.error?.startsWith("CreateFileW(log) failed") === true && (await one.call("rootExit")).error === "this process holds no launched job", missing);
  const malformed: Reply[] = [];
  for (const change of [{ cwd: undefined }, { application: `${process.execPath}\0x` }, { environment: "A=1" }, { environment: "A=1\0\0B=2\0" }])
    malformed.push(await one.call("launch", { ...launchOptions(join(root, "one.log")), ...change }));
  check("J4 malformed launch options are refused before any process starts", malformed.every((reply) => reply.error?.startsWith("launch needs") === true), malformed);

  const log = join(root, "one.log");
  writeFileSync(log, "");
  const launched = (await one.call("launch", launchOptions(log))).value as { pid: number; token: string };
  check("J5 the launch pins the process it created", launched !== undefined && /^\d{1,20}$/.test(launched.token) && nativeWin32CreationToken(launched.pid) === launched.token, launched);
  const seen = await report(log);
  check("J6 the command line round-trips every argument", JSON.stringify(seen.argv) === JSON.stringify(awkward), seen.argv);
  check("J7 the environment block carries the given and the required variables", seen.marker === "job marker" && seen.systemRoot, seen);
  const members = (await one.call("jobProcesses")).value as number[];
  check("J8 the job holds the program and both its children from creation",
    [launched.pid, seen.detached, seen.attached].every((pid) => members.includes(pid)) &&
    (await Promise.all([launched.pid, seen.detached, seen.attached].map((pid) => one.call("inJob", pid)))).every((reply) => reply.value === true), { members, seen });
  check("J9 the holder and this suite are outside the job", (await one.call("inJob", one.pid)).value === false && (await one.call("inJob", process.pid)).value === false);
  check("J10 the output goes to the log alone", readFileSync(log, "utf8").includes(String(seen.detached)));
  check("J11 a second launch from one holder is refused", (await one.call("launch", launchOptions(log))).error === "this process already holds a launched job");
  check("J12 a running program has no exit code", (await one.call("rootExit")).value === null);
  const tokens = new Map([seen.detached, seen.attached].map((pid) => [pid, nativeWin32CreationToken(pid)!]));
  await one.call("terminate", 7);
  // The holder keeps the program's handle, so an exited program may stay listed under its own PID.
  let left: number[] = [], rootExit: unknown = null;
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await sleep(100)) {
    left = (await one.call("jobProcesses")).value as number[];
    rootExit = (await one.call("rootExit")).value;
    if (rootExit !== null && left.every((pid) => pid === launched.pid)) break;
  }
  console.log(JSON.stringify({ exitedProgramListed: left.includes(launched.pid) }));
  const descendants = [...tokens].map(([pid, token]) => ({ pid, token, current: nativeWin32CreationToken(pid), liveness: probeLiveness(pid) }));
  console.log(JSON.stringify({ rootExit, descendants }));
  check("J13 terminate empties the job and the program exits with its code",
    left.every((pid) => pid === launched.pid) && rootExit === 7 && [...tokens].every(([pid, token]) => !alive(pid, token)), { left, rootExit, descendants });

  const two = helper();
  const secondLog = join(root, "two.log");
  writeFileSync(secondLog, "");
  const second = (await two.call("launch", launchOptions(secondLog, 3))).value as { pid: number; token: string };
  const secondSeen = await report(secondLog);
  const secondTokens = new Map([secondSeen.detached, secondSeen.attached].map((pid) => [pid, nativeWin32CreationToken(pid)!]));
  let exit: Reply = {};
  for (const deadline = Date.now() + 10_000; Date.now() < deadline && (exit = await two.call("rootExit")).value === null; await sleep(100));
  const remaining = (await two.call("jobProcesses")).value as number[];
  check("J14 the program's own exit leaves its children in the job", exit.value === 3 && remaining.includes(secondSeen.detached) && remaining.includes(secondSeen.attached), { exit, remaining });
  console.log(JSON.stringify({ exitedProgramListed: remaining.includes(second.pid) }));
  process.kill(two.pid);
  check("J15 the holder's death ends every member, so no member holds the job",
    await until(() => [...secondTokens].every(([pid, token]) => !alive(pid, token)) && !alive(second.pid, second.token)), [...secondTokens]);

  const three = helper();
  const thirdLog = join(root, "three.log");
  writeFileSync(thirdLog, "");
  const third = (await three.call("launch", launchOptions(thirdLog))).value as { pid: number; token: string };
  const thirdSeen = await report(thirdLog);
  const thirdTokens = new Map([[third.pid, third.token], ...[thirdSeen.detached, thirdSeen.attached].map((pid) => [pid, nativeWin32CreationToken(pid)!] as [number, string])]);
  process.kill(three.pid);
  check("J16 the holder's death ends a running program and its children", await until(() => [...thirdTokens].every(([pid, token]) => !alive(pid, token))), [...thirdTokens]);
  console.log(`WINDOWS JOB CUSTODY OK (${checks} checks; ${process.arch}, ${process.version})`);
} finally {
  for (const child of helpers) if (child.exitCode === null && child.signalCode === null) try { child.kill(); } catch { /* already gone */ }
  await sleep(500);
  rmSync(root, { recursive: true, force: true });
}
