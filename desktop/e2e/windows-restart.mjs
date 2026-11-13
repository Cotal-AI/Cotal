import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { readStopReply } from "./windows-stop-reply.mjs";

// The parent's private stdin pipe is the only control channel. No pathname reconnect.
async function awaitNativePause(input, ready) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    const next = lines[Symbol.asyncIterator]().next();
    await ready();
    const command = await next;
    assert.equal(command.done, false, "parent must authorize native pause before closing stdin");
    assert.deepEqual(JSON.parse(command.value), { op: "pause" }, "only native pause is accepted");
  } finally { lines.close(); }
}

// Run only as a companion to the real app journey on a disposable Windows runner.
assert.equal(process.platform, "win32", "native restart proof requires Windows");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted", "native restart proof requires a disposable runner");
const [repo, machineHome, artifact, runtime, preparation] = process.argv.slice(2);
assert.ok(preparation === undefined || preparation === "prepare-disabled" || preparation === "prepare-disabled-staged" || preparation === "verify-recovered", "only explicit native fixture modes are supported");
assert.ok(repo && machineHome && artifact && runtime, "repo, private machine home, artifact and installed runtime are required");
// Ownership checks must compare the installed launch vector, not this test helper's filename.
process.argv = [process.execPath, join(runtime, "dist/cotal.js")];
const requestedVersion = JSON.parse(readFileSync(join(runtime, "package.json"), "utf8")).version;
assert.equal(typeof requestedVersion, "string", "installed runtime declares its actual version");
assert.equal(realpathSync(process.env.COTAL_HOME), realpathSync(machineHome), "use the app's private COTAL_HOME");
const load = name => import(pathToFileURL(join(repo, "bin/dist/daemon", `${name}.js`)).href);
const { daemonPaths, EndpointRefusal, DAEMON_PROTOCOL_VERSION, MAX_LINE_BYTES } = await load("endpoint");
const { encode } = await load("protocol");
const { scheduledTaskService } = await load("install-win32");
const { restartInstalled, planUninstall, unitReceiptFile } = await load("install");
const { queryDaemon, managerViaDaemon, openVerified, readLine } = await load("client");
const { readLifetimeRecord, processBirth } = await load("lifetime");
const paths = daemonPaths();
assert.equal(realpathSync(paths.state), realpathSync(join(machineHome, "daemon")));
const evidence = { scope: "direct shared restartInstalled, not an npm upgrade", module: join(repo, "bin/dist/daemon/install.js"), requestedVersion, startedAt: new Date().toISOString(), checks: [] };
const check = (name, value) => { assert.ok(value, name); evidence.checks.push(name); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const installation = () => {
  const plan = planUninstall(paths, undefined); // Checks the recorded source AND the registered native job.
  assert.equal(plan.mechanism, "scheduled-task");
  const receipt = readFileSync(unitReceiptFile(paths));
  const record = JSON.parse(receipt);
  assert.equal(record.daemonHome, undefined, "the app installed the default endpoint under its private machine home");
  const source = readFileSync(plan.unitPath);
  assert.equal(hash(source), record.unitSha256);
  return { plan, receiptSha256: hash(receipt), sourceSha256: hash(source) };
};
const snapshot = async () => {
  const reply = await queryDaemon({ paths }); // Authenticates the pipe peer against the kernel lifetime owner.
  assert.ok(reply.ok, "real daemon answers status");
  const lifetime = readLifetimeRecord(paths.lock);
  assert.ok(lifetime?.start, "daemon has an exact kernel start token");
  const kernelStart = processBirth(lifetime.pid);
  assert.equal(kernelStart, lifetime.start, "kernel process birth matches lifetime record");
  assert.equal(reply.result.pid, lifetime.pid, "answering daemon owns the lifetime");
  assert.equal(reply.result.state, "ready", "installed daemon is ready");
  return { lifetime, kernelStart, status: { pid: reply.result.pid, state: reply.result.state, version: reply.result.version, protocol: reply.result.protocol }, managers: reply.result.managers ?? [] };
};
const taskState = unit => new Promise((resolve, reject) => {
  // A single recorded task, no process census, command lines or foreign environments.
  const script = "$ErrorActionPreference='Stop'; $t=@(Get-ScheduledTask | Where-Object { $_.TaskPath -ceq '\\' -and $_.TaskName -ceq $env:COTAL_E2E_RESTART_TASK }); if($t.Count -ne 1){throw 'recorded task is not unique'}; [Console]::Write([string]$t[0].State)";
  execFile(join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { env: { ...process.env, COTAL_E2E_RESTART_TASK: unit }, encoding: "utf8", windowsHide: true, timeout: 30_000 },
    (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
});
const taskInstances = unit => new Promise((resolve, reject) => {
  const script = "$ErrorActionPreference='Stop'; $s=New-Object -ComObject 'Schedule.Service'; $s.Connect(); $t=$s.GetFolder('\\').GetTask($env:COTAL_E2E_RESTART_TASK); ConvertTo-Json -Compress -InputObject @{ enabled=[bool]$t.Enabled; instances=[int]$t.GetInstances(0).Count; state=[int]$t.State }";
  execFile(join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { env: { ...process.env, COTAL_E2E_RESTART_TASK: unit }, encoding: "utf8", windowsHide: true, timeout: 30_000 },
    (error, stdout) => { if (error) reject(error); else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } } });
});
try {
  if (preparation === "verify-recovered") {
    evidence.installation = installation();
    evidence.answering = await snapshot();
    evidence.native = await taskInstances(evidence.installation.plan.unit);
    assert.equal(evidence.native.enabled, true, "recovered task remains enabled for next logon");
    assert.ok(evidence.native.instances > 0, "recovered task has a native running instance");
    assert.equal(evidence.native.state, 4, "recovered native task is Running");
    evidence.outcome = "passed";
  } else {
  evidence.installationBefore = installation();
  evidence.before = await snapshot();
  check("requested version is the actual installed runtime version", evidence.before.status.version === requestedVersion);
  evidence.taskBefore = await taskState(evidence.installationBefore.plan.unit);
  check("app-installed recorded task is Running before restart", evidence.taskBefore === "Running");
  await managerViaDaemon({ paths }, { op: "managers-prepare-restart" });
  evidence.preparedAt = new Date().toISOString();
  try {
    evidence.calledAt = new Date().toISOString();
    evidence.restartPlan = await restartInstalled(paths, undefined, false, requestedVersion);
    evidence.returnedAt = new Date().toISOString();
    assert.deepEqual(evidence.restartPlan, evidence.installationBefore.plan, "shared API restarted the recorded task");
  } catch (error) {
    // The shared API owns rollback and retained fences. An ambiguous native outcome
    // must not reconnect by pathname and release a possibly different generation's fence.
    evidence.restartError = String(error);
    throw error;
  }
  const deadline = Date.now() + 90_000;
  while (true) {
    try {
      const after = await snapshot();
      assert.notEqual(after.lifetime.pid, evidence.before.lifetime.pid, "fresh daemon PID");
      assert.notEqual(after.kernelStart, evidence.before.kernelStart, "fresh kernel lifetime");
      assert.notEqual(processBirth(evidence.before.lifetime.pid), evidence.before.kernelStart, "old exact kernel lifetime ended");
      evidence.after = after;
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(500);
    }
  }
  check("shared restart returns a fresh answering PID and kernel lifetime", true);
  check("new daemon answers the same real version and protocol", evidence.after.status.version === evidence.before.status.version && evidence.after.status.protocol === evidence.before.status.protocol);
  evidence.installationAfter = installation();
  assert.deepEqual(evidence.installationAfter, evidence.installationBefore, "restart preserves installation source and receipt");
  check("recorded installation source and receipt are unchanged", true);
  evidence.taskAfter = await taskState(evidence.installationAfter.plan.unit);
  check("recorded task is Running after restart", evidence.taskAfter === "Running");
  if (preparation === "prepare-disabled" || preparation === "prepare-disabled-staged") {
    // Test preparation only. Recovery must come from the parent's actual app Check again.
    const fixture = evidence.disabledFixture = { phase: "manager-fence", startedAt: new Date().toISOString() };
    await managerViaDaemon({ paths }, { op: "managers-prepare-restart" });
    fixture.installation = installation();
    assert.deepEqual(fixture.installation, evidence.installationAfter);
    fixture.before = await snapshot();
    fixture.phase = "pin-listener";
    const socket = await openVerified({ paths });
    socket.on("error", () => {});
    const request = async commit => {
      const id = randomUUID().replaceAll("-", "");
      socket.write(encode({ v: DAEMON_PROTOCOL_VERSION, id, op: "daemon-stop", ...(commit ? { commit: true } : {}) }));
      return readStopReply({
        read: () => readLine(socket, commit ? 5000 : 70_000), fixture, id, commit,
        version: DAEMON_PROTOCOL_VERSION, maxBytes: MAX_LINE_BYTES,
        persist: () => writeFileSync(artifact, JSON.stringify(evidence, null, 2)),
        allowUnknownPreparation: !commit,
      });
    };
    try {
      assert.deepEqual(readLifetimeRecord(paths.lock), fixture.before.lifetime, "lifetime unchanged while opening listener");
      assert.equal(processBirth(fixture.before.lifetime.pid), fixture.before.kernelStart);
      fixture.phase = "stop-prepare";
      // server.ts deliberately refuses an unknown provenance observation without preparing
      // this connection. The fixture's receipt-verified native pause still ends the task.
      const prepared = await request(false);
      fixture.stopPrepared = prepared.ok === true;
      assert.deepEqual(installation(), fixture.installation, "owned native provenance unchanged before pause");
      const receipt = JSON.parse(readFileSync(unitReceiptFile(paths), "utf8"));
      if (preparation === "prepare-disabled-staged") {
        fixture.phase = "await-native-pause";
        fixture.readyAt = new Date().toISOString();
        await awaitNativePause(process.stdin, () => {
          writeFileSync(artifact, JSON.stringify(evidence, null, 2));
          process.stdout.write(`${JSON.stringify({ phase: "prepared", at: fixture.readyAt })}\n`);
        });
        fixture.authorizedAt = new Date().toISOString();
        writeFileSync(artifact, JSON.stringify(evidence, null, 2));
        // Waiting must not turn the pinned listener into permission to stop a replacement.
        assert.deepEqual(readLifetimeRecord(paths.lock), fixture.before.lifetime, "pinned lifetime unchanged after parent authorization");
        assert.equal(processBirth(fixture.before.lifetime.pid), fixture.before.kernelStart);
        assert.ok(!socket.destroyed, "prepared listener remains connected");
      }
      fixture.phase = "native-pause";
      const task = scheduledTaskService((file, args, env) => {
        const result = spawnSync(file, args, { env, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 256 * 1024 });
        assert.ifError(result.error);
        assert.equal(result.signal, null, "native preparation tool was not signalled");
        return { status: result.status, stdout: result.stdout, detail: result.stderr || result.stdout };
      });
      await task.pause(receipt);
      fixture.phase = "stop-commit";
      if (fixture.stopPrepared && processBirth(fixture.before.lifetime.pid) === fixture.before.kernelStart) {
        try { await request(true); }
        catch (error) {
          if (!["EPIPE", "ECONNRESET"].includes(error.code) && error.message !== "daemon closed the connection without a reply") throw error;
        }
      }
    } finally { socket.destroy(); } // Never release a fence through a replacement connection.
    fixture.phase = "observe-absence";
    const deadline = Date.now() + 130_000;
    while (true) {
      let absent = false;
      try { const probe = await openVerified({ paths, timeoutMs: 1000 }); probe.destroy(); }
      catch (error) {
        if (error instanceof EndpointRefusal && error.code === "NOT_RUNNING") absent = true;
        else if (error.code !== "ECONNRESET") throw error;
      }
      if (absent && processBirth(fixture.before.lifetime.pid) !== fixture.before.kernelStart) break;
      assert.ok(Date.now() < deadline, "disabled fixture old lifetime and endpoint end within 130s");
      await delay(100);
    }
    assert.deepEqual(installation(), fixture.installation, "disabled fixture retains owned source and receipt");
    fixture.native = await taskInstances(fixture.installation.plan.unit);
    assert.equal(fixture.native.enabled, false);
    assert.equal(fixture.native.instances, 0);
    fixture.phase = "disabled-zero-confirmed";
    fixture.completedAt = new Date().toISOString();
    check("owned disabled task has zero instances and no answering old lifetime", true);
  }
  evidence.outcome = "passed";
  }
} catch (error) {
  evidence.outcome = "failed";
  const stopError = evidence.disabledFixture?.stopReplies?.at(-1)?.error;
  evidence.error = stopError && (error instanceof SyntaxError || error.message === "pinned daemon acknowledges stop" || error.code === stopError.code && error.code !== undefined)
    ? stopError : { name: error.name, message: error.message, stack: error.stack };
  throw error;
} finally {
  evidence.completedAt = new Date().toISOString();
  writeFileSync(artifact, JSON.stringify(evidence, null, 2));
}
