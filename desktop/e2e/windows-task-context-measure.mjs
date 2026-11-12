import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { openSync, closeSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { taskStageMarkers, taskStageScript } from "./windows-task-stage-script.mjs";

export function daemonEnvironmentKeys(source) {
  const body = /pub fn daemon_env_key\(key: &str\) -> bool \{([^}]+)\}/g;
  const matches = [...source.matchAll(body)];
  assert.equal(matches.length, 1, "daemon environment function shape changed");
  const match = /^\s*matches!\(\s*key\.to_ascii_uppercase\(\)\.as_str\(\),\s*((?:"[A-Z_]+"\s*(?:\|\s*)?)+)\s*\)\s*$/.exec(matches[0][1]);
  assert.ok(match, "daemon environment allowlist shape changed");
  const keys = [...match[1].matchAll(/"([A-Z_]+)"/g)].map(m => m[1]);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(match[1].replace(/"[A-Z_]+"/g, "").replace(/\s/g, ""), "|".repeat(keys.length - 1));
  return keys;
}

export const contextVariants = Object.freeze([
  "main-thread", "worker-thread", "worker-thread-daemon-env",
  ...["machine-identity", "system-paths", "profile", "powershell"].map(group => `worker-thread-daemon-env-${group}`),
]);
export const contextVariantCount = contextVariants.length;

const environmentGroups = {
  "machine-identity": ["COMPUTERNAME", "USERNAME", "USERDOMAIN", "LOGONSERVER"],
  "system-paths": ["SystemDrive", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432", "ALLUSERSPROFILE", "PUBLIC"],
  profile: ["HOMEDRIVE", "HOMEPATH"],
  powershell: ["PSModulePath", "PSModuleAnalysisCachePath"],
};

export function strippedDaemonEnvironment(env, keys, group) {
  assert.ok(group === undefined || Object.hasOwn(environmentGroups, group), "unknown environment group");
  const allowed = new Set([...keys, ...(environmentGroups[group] ?? [])].map(key => key.toUpperCase()));
  const result = Object.fromEntries(Object.entries(env).filter(([key, value]) => allowed.has(key.toUpperCase()) && value !== undefined));
  result.DO_NOT_TRACK = "1";
  return result;
}

export function safeEnvironment(env) {
  const names = Object.keys(env).filter(key => env[key] !== undefined).sort();
  const paths = {};
  for (const key of ["USERPROFILE", "LOCALAPPDATA", "TEMP", "PSModulePath"]) {
    const name = names.find(name => name.toUpperCase() === key.toUpperCase());
    paths[key] = { present: name !== undefined, value: name === undefined ? null : env[name] };
  }
  return { names, paths };
}

/** Called inside the actual worker too, so metadata reflects that worker's environment copy. */
export function nativeContextSample(options) {
  const env = options.stripped ? strippedDaemonEnvironment(process.env, options.keys, options.group) : { ...process.env };
  // Fixture controls are supplied after env_clear filtering, just as the task reader supplies them.
  for (const key of Object.keys(env)) if (["COTAL_DAEMON_TASK", "COTAL_DAEMON_TASK_INSTANCES"].includes(key.toUpperCase())) delete env[key];
  env.COTAL_DAEMON_TASK = options.unit;
  env.COTAL_DAEMON_TASK_INSTANCES = "1";
  const environment = safeEnvironment(env);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const result = spawnSync(options.executable, options.args, { env, cwd: options.cwd, encoding: "utf8", windowsHide: true, timeout: 180_000, maxBuffer: 128 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const markers = taskStageMarkers(result.stderr ?? "");
  const firstMarker = markers.find(marker => marker.stage === "powershell" && marker.edge === "start");
  const approximateStartupMs = firstMarker ? Date.parse(firstMarker.at) - Date.parse(startedAt) : null;
  const durations = markers.filter(marker => marker.edge === "end").map(end => {
    const start = markers.find(marker => marker.stage === end.stage && marker.edge === "start");
    return { stage: end.stage, elapsedMs: start ? end.elapsedMs - start.elapsedMs : null };
  });
  let task = null;
  try {
    const value = JSON.parse((result.stdout ?? "").replace(/^\uFEFF/, "").trim());
    task = {
      identityMatches: value.present === true && value.actions === 1 && ["execute", "arguments", "workingDirectory", "userId"].every(key => value[key] === options.expected[key]) && value.logonType === 3 && value.runLevel === 0,
      present: typeof value.present === "boolean" ? value.present : null,
      enabled: typeof value.enabled === "boolean" ? value.enabled : null,
      state: ["Running", "Ready", "Disabled", "Queued", "Unknown"].includes(value.state) ? value.state : null,
      instances: Number.isSafeInteger(value.instances) && value.instances >= 0 ? value.instances : null,
    };
  } catch { /* Native failures remain observations, not absence verdicts. */ }
  return { environment, startedAt, completedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), timeoutMs: 180_000, status: result.status, signal: ["SIGTERM", "SIGKILL", "SIGINT"].includes(result.signal) ? result.signal : null, code: ["ETIMEDOUT", "ENOBUFS", "ENOENT", "EACCES"].includes(result.error?.code) ? result.error.code : result.error ? "NATIVE_TOOL_FAILED" : null, approximateStartupMs, markers, durations, task };
}

/** Resolve only after exit, draining both worker streams without retaining their content. */
export function workerContextSample(options, boundMs = 190_000) {
  return new Promise(resolveResult => {
    const env = options.stripped ? strippedDaemonEnvironment(process.env, options.keys, options.group) : { ...process.env };
    for (const key of Object.keys(env)) if (["COTAL_DAEMON_TASK", "COTAL_DAEMON_TASK_INSTANCES"].includes(key.toUpperCase())) delete env[key];
    const worker = new Worker(`const {workerData,parentPort}=require('node:worker_threads'); import(workerData.module).then(m=>parentPort.postMessage({...m.nativeContextSample(workerData.options),workerEnvironment:m.safeEnvironment(process.env)})).catch(()=>{process.exitCode=1});`, { eval: true, workerData: { module: import.meta.url, options }, env, stdout: true, stderr: true });
    worker.stdout.resume();
    worker.stderr.resume();
    let sample = null;
    let failed = false;
    let exceeded = false;
    worker.on("message", value => { sample = value; });
    worker.on("error", () => { failed = true; });
    const timer = setTimeout(() => { exceeded = true; void worker.terminate().catch(() => { failed = true; }); }, boundMs);
    worker.on("exit", code => {
      clearTimeout(timer);
      resolveResult({ ...(sample ?? {}), worker: { exitConfirmed: true, exitCode: code, boundMs, boundExceeded: exceeded, failed }, code: exceeded ? "WORKER_BOUND_EXCEEDED" : failed || code !== 0 || !sample ? "WORKER_FAILED" : sample.code });
    });
  });
}

export async function measureTaskContext(config, context, outputPath) {
  assert.equal(process.platform, "win32", "native context measurements require Windows");
  assert.ok(["harness", "scheduled-task"].includes(context));
  assert.deepEqual(Object.keys(config).sort(), ["sourcePath", "rustSourcePath", "unit", "expected", "cwd"].sort(), "config must contain no environment snapshot");
  assert.match(config.unit, /^cotal-daemon-[A-Za-z0-9-]+$/);
  assert.deepEqual(Object.keys(config.expected ?? {}).sort(), ["execute", "arguments", "workingDirectory", "userId"].sort());
  for (const key of ["execute", "arguments", "workingDirectory", "userId"]) assert.equal(typeof config.expected?.[key], "string");
  assert.equal(typeof config.cwd, "string");
  const { script, sourceSha256 } = taskStageScript(readFileSync(config.sourcePath, "utf8"));
  const keys = daemonEnvironmentKeys(readFileSync(config.rustSourcePath, "utf8"));
  const rootKey = Object.keys(process.env).sort().find(key => key.toUpperCase() === "SYSTEMROOT");
  assert.ok(rootKey && process.env[rootKey]);
  const options = { executable: join(process.env[rootKey], "System32/WindowsPowerShell/v1.0/powershell.exe"), args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], cwd: config.cwd, unit: config.unit, expected: config.expected, keys };
  const expectedTaskIdentitySha256 = createHash("sha256").update(JSON.stringify([config.unit, ...["execute", "arguments", "workingDirectory", "userId"].map(key => config.expected[key])])).digest("hex");
  const fd = openSync(outputPath, "wx", 0o600);
  const rows = [];
  try {
    writeFileSync(fd, "[]\n");
    for (const variant of contextVariants) {
      const group = variant.startsWith("worker-thread-daemon-env-") ? variant.slice("worker-thread-daemon-env-".length) : undefined;
      const sample = variant === "main-thread" ? nativeContextSample(options) : await workerContextSample({ ...options, stripped: variant.startsWith("worker-thread-daemon-env"), group });
      rows.push({ context, variant, sourceSha256, expectedTaskIdentitySha256, instancesRequested: true, nodeVersion: process.version, valid: sample.status === 0 && sample.task?.identityMatches === true && (!sample.worker || (sample.worker.exitConfirmed && sample.worker.exitCode === 0 && !sample.worker.boundExceeded && !sample.worker.failed)), ...sample });
      // Same exclusively opened file, rewritten at offset zero without reopening a possibly replaced path.
      const data = Buffer.from(JSON.stringify(rows, null, 2) + "\n");
      // Rows only grow, so no stale suffix can survive.
      let offset = 0;
      while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset, offset);
    }
  } finally { closeSync(fd); }
  return rows;
}

export function renderContextTable(rows) {
  const contexts = new Set(["harness", "scheduled-task"]);
  const variants = new Set(contextVariants);
  const number = value => Number.isFinite(value) ? String(value) : "unknown";
  const stages = ["import-module", "enumerate-all", "principal-translate", "com-create", "com-connect", "com-get-task", "com-get-instances"];
  return [
    `| Context | Variant | Elapsed ms | Startup ms | ${stages.map(stage => `${stage} ms`).join(" | ")} | Status | Valid |`,
    `| ${Array(6 + stages.length).fill("---").join(" | ")} |`,
    ...rows.map(row => {
      const durations = stages.map(stage => number(Array.isArray(row.durations) ? row.durations.find(duration => duration?.stage === stage)?.elapsedMs : undefined));
      return `| ${contexts.has(row.context) ? row.context : "unknown"} | ${variants.has(row.variant) ? row.variant : "unknown"} | ${number(row.elapsedMs)} | ${number(row.approximateStartupMs)} | ${durations.join(" | ")} | ${number(row.status)} | ${row.valid === true ? "yes" : "no"} |`;
    }),
    "",
  ].join("\n");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 6 || process.argv[2] !== "run") process.exitCode = 1;
  else {
    try { await measureTaskContext(JSON.parse(readFileSync(process.argv[3], "utf8")), process.argv[4], process.argv[5]); }
    catch { console.error("Context measurement failed; inspect sanitized incremental records if created."); process.exitCode = 1; }
  }
}
