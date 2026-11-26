/** The built-in pty runtime inside a Windows service job. A host process runs under a custodian, as a
 *  prepared manager does, and launches a fixture through the pty runtime (ConPTY). The fixture must
 *  run inside the same no-breakaway job and end when that job is stopped. Run only on a Windows runner. */
import { strict as assert } from "node:assert";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { custodyRequest, custodyStatus, probeLiveness, startWin32Custodian, win32ProcessBinding } from "@cotal-ai/workspace";

assert.equal(process.platform, "win32", "this suite requires a native Windows runner");
const root = mkdtempSync(join(tmpdir(), "windows-pty-job-"));
let checks = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  if (!condition) console.error(`FAIL ${name}`, detail ?? "");
  assert.ok(condition, name);
  checks++;
  console.log(`PASS ${name}`);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const native = win32ProcessBinding();
const key = randomBytes(32), instanceId = randomUUID();
let custody: Awaited<ReturnType<typeof startWin32Custodian>> | undefined;
let fixturePin: { pid: number; token: string } | undefined;
const gone = (pin: { pid: number; token: string }) => {
  const current = native.creationToken(pin.pid);
  return probeLiveness(pin.pid) === "dead" || current !== undefined && current !== pin.token;
};
const ask = async (request: Parameters<typeof custodyRequest>[3]) => custodyStatus(await custodyRequest(custody!.pipe, key, instanceId, request), custody!.custodian);

try {
  const manager = pathToFileURL(join(import.meta.dirname, "..", "dist", "index.js")).href;
  const host = join(root, "host.mjs"), stopFile = join(root, "stop");
  const fixture = "process.stdout.write('__READY__' + process.pid + '__END__'); setInterval(() => {}, 1000)";
  writeFileSync(host, `import { existsSync } from "node:fs";
import { createRuntime } from ${JSON.stringify(manager)};
const env = Object.fromEntries(["PATH", "SystemRoot", "TEMP", "TMP", "USERPROFILE"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
const runtime = createRuntime("pty", "jobsmoke");
function launch() {
  const handle = runtime.spawn("jobsmoke", { command: process.execPath, args: ["-e", ${JSON.stringify(fixture)}], env }, process.cwd());
  let output = "", reported = false;
  handle.attach().onData((bytes) => {
    output += bytes.toString("utf8");
    const ready = /__READY__(\\d+)__END__/.exec(output);
    if (ready && !reported) { reported = true; console.log(JSON.stringify({ ptyPid: handle.pid, fixturePid: Number(ready[1]) })); }
  });
  return handle;
}
const first = launch();
const poll = setInterval(async () => {
  if (!existsSync(${JSON.stringify(stopFile)})) return;
  clearInterval(poll);
  first.stop({ graceful: false });
  await first.waitForExit();
  const restart = setInterval(() => {
    if (!existsSync(${JSON.stringify(join(root, "restart"))})) return;
    clearInterval(restart);
    launch();
  }, 100);
}, 100);
setInterval(() => {}, 1000);
`);
  const log = join(root, "host.log");
  writeFileSync(log, "");
  custody = await startWin32Custodian({ program: process.execPath, args: [host], cwd: root, env: { PATH: process.env.PATH }, log, instanceId }, key);

  const launch = async (index: number) => {
    for (const deadline = Date.now() + 30_000; Date.now() < deadline; await sleep(200)) {
      const line = readFileSync(log, "utf8").split(/\r?\n/).filter((row) => row.startsWith("{"))[index];
      if (!line) continue;
      const seen = JSON.parse(line) as { ptyPid: number; fixturePid: number };
      const token = native.creationToken(seen.fixturePid);
      assert.ok(token, "the fixture has a readable creation pin");
      fixturePin = { pid: seen.fixturePid, token };
      return seen;
    }
    throw new Error(`the fixture did not start: ${readFileSync(log, "utf8").slice(-2000)}`);
  };
  const seen = await launch(0);
  const held = await ask({ op: "status" });
  console.log(JSON.stringify({ host: custody.process.pid, ...seen, members: held.members }));
  check("P1 the ConPTY fixture runs inside the host's no-breakaway job", held.members.includes(custody.process.pid) && held.members.includes(seen.fixturePid) && held.members.includes(seen.ptyPid), held);
  writeFileSync(stopFile, "stop");
  let afterStop = await ask({ op: "status" });
  for (const deadline = Date.now() + 10_000; (afterStop.members.length !== 1 || !gone(fixturePin!)) && Date.now() < deadline;) {
    await sleep(100);
    afterStop = await ask({ op: "status" });
  }
  check("P2 stopping the seat releases its console host and leaves only the manager", afterStop.members.length === 1 && afterStop.members[0] === custody.process.pid && gone(fixturePin!), afterStop);
  writeFileSync(join(root, "restart"), "restart");
  await launch(1);
  const ended = await ask({ op: "terminate", code: 1 });
  for (const deadline = Date.now() + 10_000; !gone(fixturePin!) && Date.now() < deadline; await sleep(100));
  check("P3 stopping the job ends the host and its ConPTY fixture", ended.members.length === 0 && ended.root.exit !== null && gone(fixturePin!), ended);
  console.log(`WINDOWS PTY JOB OK (${checks} checks; ${process.arch}, ${process.version})`);
} finally {
  if (custody) {
    // A failed assertion must still stop this fixture's own job before removing its working directory.
    if (!gone(custody.custodian)) {
      try { await ask({ op: "terminate", code: 1 }); }
      catch (error) { if (!gone(custody.custodian)) throw error; }
    }
    const down = () => gone(custody!.custodian) && gone(custody!.process) && (!fixturePin || gone(fixturePin));
    for (const deadline = Date.now() + 10_000; !down() && Date.now() < deadline; await sleep(100));
    assert.ok(down(), `the fixture job still runs; retained ${root}`);
  }
  await sleep(250);
  rmSync(root, { recursive: true, force: true });
}
