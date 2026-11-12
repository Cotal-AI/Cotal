import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { contextVariants, contextVariantCount, daemonEnvironmentKeys, strippedDaemonEnvironment, safeEnvironment, nativeContextSample, workerContextSample, measureTaskContext, renderContextTable } from "./windows-task-context-measure.mjs";
import { taskStageScript } from "./windows-task-stage-script.mjs";

const rust = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const source = readFileSync(new URL("../../bin/daemon/install-win32.ts", import.meta.url), "utf8");

test("extracts exact source allowlist and rejects changed grammar", () => {
  const keys = daemonEnvironmentKeys(rust);
  assert.equal(keys.length, 27);
  assert.ok(keys.includes("SYSTEMROOT"));
  assert.ok(!keys.includes("PSMODULEPATH"));
  assert.throws(() => daemonEnvironmentKeys("pub fn daemon_env_key(key: &str) -> bool { true }"));
  assert.throws(() => daemonEnvironmentKeys(rust + rust));
});

test("case insensitive env_clear filter adds only DO_NOT_TRACK", () => {
  assert.deepEqual(strippedDaemonEnvironment({ Path: "one", PATH: "two", temp: "tmp", SECRET: "secret", DO_NOT_TRACK: "0", UNDEFINED: undefined }, ["PATH", "TEMP"]), { Path: "one", PATH: "two", temp: "tmp", DO_NOT_TRACK: "1" });
});

test("metadata exposes sorted names and only four path values", () => {
  const metadata = safeEnvironment({ SECRET: "secret-value", PATH: "hidden-path", UserProfile: "profile", TEMP: "temp", PSModulePath: "module", LOCALAPPDATA: "local", absent: undefined });
  assert.deepEqual(metadata.names, ["LOCALAPPDATA", "PATH", "PSModulePath", "SECRET", "TEMP", "UserProfile"]);
  assert.equal(metadata.paths.USERPROFILE.value, "profile");
  assert.ok(!JSON.stringify(metadata).includes("secret-value"));
  assert.ok(!JSON.stringify(metadata).includes("hidden-path"));
  assert.deepEqual(safeEnvironment({}).paths.TEMP, { present: false, value: null });
});

test("instrumentation is reconstructed from shipped source, not copied", () => {
  const generated = taskStageScript(source);
  const original = JSON.parse(/const READ_TASK = (\[[\s\S]*?\])\.join\("\\n"\);/.exec(source)[1].replace(/,\s*\]$/, "]")).join("\n");
  assert.equal(generated.script.split("\n").filter(line => !line.startsWith("[Console]::Error.WriteLine('COTAL_") && !line.startsWith("$cotalStageClock=")).join("\n"), original);
  assert.match(generated.sourceSha256, /^[a-f0-9]{64}$/);
});

const childOptions = { executable: process.execPath, args: ["-e", "process.stdout.write('private stdout');process.stderr.write('private stderr');process.exitCode=7"], cwd: process.cwd(), unit: "cotal-daemon-test", expected: {}, keys: daemonEnvironmentKeys(rust) };

test("real child failure remains sanitized without Windows success claims", () => {
  const result = nativeContextSample(childOptions);
  assert.equal(result.status, 7);
  assert.equal(result.task, null);
  assert.deepEqual(result.markers, []);
  assert.ok(!JSON.stringify(result).includes("private stdout"));
  assert.ok(!JSON.stringify(result).includes("private stderr"));
  const missing = nativeContextSample({ ...childOptions, executable: "/no-such-cotal-measure-executable" });
  assert.equal(missing.code, "ENOENT");
  assert.ok(!JSON.stringify(missing).includes("no-such"));
});

test("real eval workers report their chosen environment and confirmed exit", async () => {
  process.env.COTAL_CONTEXT_TEST_SECRET = "do-not-retain-this-value";
  try {
    for (const stripped of [false, true]) {
      const result = await workerContextSample({ ...childOptions, stripped });
      assert.equal(result.status, 7);
      assert.equal(result.worker.exitConfirmed, true);
      assert.equal(result.worker.exitCode, 0);
      assert.equal(result.worker.boundExceeded, false);
      assert.equal(result.environment.names.includes("COTAL_CONTEXT_TEST_SECRET"), !stripped);
      assert.equal(result.workerEnvironment.names.includes("COTAL_CONTEXT_TEST_SECRET"), !stripped);
      if (stripped) {
        assert.ok(result.workerEnvironment.names.includes("DO_NOT_TRACK"));
        assert.ok(!result.workerEnvironment.names.includes("COTAL_DAEMON_TASK"));
      }
      assert.ok(!JSON.stringify(result).includes("do-not-retain-this-value"));
      if (stripped) assert.ok(result.environment.names.includes("DO_NOT_TRACK"));
    }
  } finally { delete process.env.COTAL_CONTEXT_TEST_SECRET; }
});

test("worker bound waits for confirmed exit and retains sanitized failure", async () => {
  const result = await workerContextSample({ ...childOptions, args: ["-e", "setTimeout(()=>{},100)"] }, 1);
  assert.equal(result.worker.exitConfirmed, true);
  assert.equal(result.worker.boundExceeded, true);
  assert.equal(result.code, "WORKER_BOUND_EXCEEDED");
});

test("table renders only bounded labels and numeric fields", () => {
  const table = renderContextTable([{ context: "secret", variant: "secret", elapsedMs: "secret", status: "secret", valid: false }]);
  assert.ok(!table.includes("secret"));
  assert.ok(table.includes("unknown"));
});

test("table includes fixed stage durations in order with unknown for unsafe values", () => {
  const table = renderContextTable([{ context: "harness", variant: "worker-thread", elapsedMs: 99, approximateStartupMs: 4, status: 0, valid: true, durations: [{ stage: "import-module", elapsedMs: 12 }, { stage: "enumerate-all", elapsedMs: 23 }, { stage: "principal-translate", elapsedMs: "secret" }, { stage: "com-create", elapsedMs: Infinity }, { stage: "com-connect", elapsedMs: 34 }, { stage: "com-get-task", elapsedMs: 45 }, { stage: "com-get-instances", elapsedMs: 56 }, { stage: "private-stage", elapsedMs: "private-value" }] }]);
  assert.ok(table.includes("| 99 | 4 | 12 | 23 | unknown | unknown | 34 | 45 | 56 | 0 | yes |"));
  for (const stage of ["import-module", "enumerate-all", "principal-translate", "com-create", "com-connect", "com-get-task", "com-get-instances"]) assert.ok(table.includes(`${stage} ms`));
  assert.ok(!/secret|private-stage|private-value|Infinity/.test(table));
});

test("native measurement is gated on Windows", { skip: process.platform === "win32" }, async () => {
  await assert.rejects(measureTaskContext({}, "harness", "not-created.json"), /require Windows/);
});

const groups = {
  "machine-identity": ["COMPUTERNAME", "USERNAME", "USERDOMAIN", "LOGONSERVER"],
  "system-paths": ["SystemDrive", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432", "ALLUSERSPROFILE", "PUBLIC"],
  profile: ["HOMEDRIVE", "HOMEPATH"],
  powershell: ["PSModulePath", "PSModuleAnalysisCachePath"],
};

test("groups restore only exact OS keys case insensitively and independently", () => {
  const env = Object.fromEntries(Object.values(groups).flat().map(key => [key.toLowerCase(), `private-${key}`]));
  Object.assign(env, { Path: "base", ProgramFilesSecret: "secret", CommonProgramFilesToken: "secret", PSModulePathSecret: "secret", COTAL_DAEMON_TASK: "secret" });
  for (const [group, keys] of Object.entries(groups)) {
    const restored = strippedDaemonEnvironment(env, ["PATH"], group);
    assert.deepEqual(Object.keys(restored).sort(), [...keys.map(key => key.toLowerCase()), "Path", "DO_NOT_TRACK"].sort());
    for (const key of keys) assert.equal(restored[key.toLowerCase()], env[key.toLowerCase()]);
  }
  assert.throws(() => strippedDaemonEnvironment(env, [], "unknown"));
});

test("actual Worker and native child retain each selected group without leaking private values", async () => {
  const names = [...Object.values(groups).flat(), "ProgramFilesSecret", "COTAL_CONTEXT_TEST_SECRET", "COTAL_DAEMON_TASK", "COTAL_DAEMON_TASK_INSTANCES"];
  const saved = { ...process.env };
  try {
    for (const name of names) process.env[name] = `private-value-${name}`;
    for (const [group, keys] of Object.entries(groups)) {
      const checks = Object.fromEntries(keys.map(key => [key, process.env[key]]));
      const args = ["-e", `const expected=${JSON.stringify(checks)};const env=Object.fromEntries(Object.entries(process.env).map(([k,v])=>[k.toUpperCase(),v]));process.exitCode=Object.entries(expected).every(([k,v])=>env[k.toUpperCase()]===v)&&env.COTAL_DAEMON_TASK==='cotal-daemon-test'&&env.COTAL_DAEMON_TASK_INSTANCES==='1'?7:9`];
      const result = await workerContextSample({ ...childOptions, args, stripped: true, group });
      assert.equal(result.status, 7);
      assert.equal(result.worker.exitCode, 0);
      for (const field of ["environment", "workerEnvironment"]) {
        const actual = result[field].names.map(key => key.toUpperCase());
        for (const key of Object.values(groups).flat()) assert.equal(actual.includes(key.toUpperCase()), keys.includes(key), `${group}: ${field}: ${key}`);
        assert.ok(!actual.includes("PROGRAMFILESSECRET"));
        assert.ok(!actual.includes("COTAL_CONTEXT_TEST_SECRET"));
      }
      assert.ok(!result.workerEnvironment.names.includes("COTAL_DAEMON_TASK"));
      const sanitized = JSON.stringify(result);
      for (const key of names.filter(key => key !== "PSModulePath")) assert.ok(!sanitized.includes(`private-value-${key}`));
      assert.equal(result.environment.paths.PSModulePath.present, group === "powershell");
      assert.equal(result.timeoutMs, 180_000);
      assert.equal(result.worker.boundMs, 190_000);
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(saved, key)) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) process.env[key] = value;
  }
});

test("seven fixed variants render fourteen context rows and retain incremental bounded execution", () => {
  assert.equal(contextVariantCount, 7);
  assert.deepEqual(contextVariants, ["main-thread", "worker-thread", "worker-thread-daemon-env", ...Object.keys(groups).map(group => `worker-thread-daemon-env-${group}`)]);
  const rows = ["scheduled-task", "harness"].flatMap(context => contextVariants.map(variant => ({ context, variant })));
  const table = renderContextTable(rows);
  assert.equal(table.trim().split("\n").length, 16);
  for (const { context, variant } of rows) assert.ok(table.includes(`| ${context} | ${variant} |`));
  const implementation = readFileSync(new URL("./windows-task-context-measure.mjs", import.meta.url), "utf8");
  assert.match(implementation, /for \(const variant of contextVariants\)/);
  assert.match(implementation, /rows\.push\([\s\S]*?writeSync\(fd, data, offset, data\.length - offset, offset\)/);
});
