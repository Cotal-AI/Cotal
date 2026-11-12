import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { taskStageMarkers, taskStageScript } from "./windows-task-stage-script.mjs";

/** Three independent observations, never a retry of a failed product operation. */
export function measureTaskStages({ sourcePath, receiptPath, output, phase, env, expected }) {
  assert.equal(process.platform, "win32", "stage measurements require native Windows");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted", "stage measurements require a disposable runner");
  assert.ok(["enabled", "disabled"].includes(phase));
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.mechanism, "scheduled-task");
  assert.match(receipt.unit, /^cotal-daemon-[A-Za-z0-9-]+$/);
  const { script, comparison, sourceSha256 } = taskStageScript(readFileSync(sourcePath, "utf8"));
  const powershell = join(env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const results = [];
  for (let sample = 1; sample <= 3; sample++) {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`${script}\n${comparison}`, "utf16le").toString("base64")], {
      env: { ...env, COTAL_DAEMON_TASK: receipt.unit, COTAL_DAEMON_TASK_INSTANCES: "1" },
      cwd: env.HOME, encoding: "utf8", windowsHide: true, timeout: 180_000, maxBuffer: 128 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const markers = taskStageMarkers(result.stderr ?? "");
    const firstMarker = markers.find(m => m.stage === "powershell" && m.edge === "start");
    const approximateStartupMs = firstMarker ? Date.parse(firstMarker.at) - Date.parse(startedAt) : null;
    const sidMarker = /^COTAL_PRINCIPAL_SID (True|False)\r?$/m.exec(result.stderr ?? "");
    const translateEnd = markers.some(m => m.stage === "principal-translate" && m.edge === "end");
    const principalTranslate = sidMarker ? sidMarker[1] === "True" ? "skipped-sid" : translateEnd ? "completed" : "entered-unresolved" : "not-reached";
    const durations = markers.filter(m => m.edge === "end" && !["absence-branch", "instance-branch", "instance-end"].includes(m.stage)).map(end => {
      const start = markers.find(m => m.stage === end.stage && m.edge === "start");
      return { stage: end.stage, elapsedMs: start ? end.elapsedMs - start.elapsedMs : null };
    });
    let task = null;
    try {
      const value = JSON.parse((result.stdout ?? "").replace(/^\uFEFF/, "").trim());
      task = { identityMatches: value.present === true && value.actions === 1 && value.execute === expected.execute && value.arguments === expected.arguments && value.workingDirectory === expected.workingDirectory && value.userId === expected.userId && value.logonType === 3 && value.runLevel === 0, present: value.present === true ? true : value.present === false ? false : null, state: ["Running", "Ready", "Disabled", "Queued", "Unknown"].includes(value.state) ? value.state : null, enabled: typeof value.enabled === "boolean" ? value.enabled : null, instances: Number.isSafeInteger(value.instances) ? value.instances : null };
    } catch { /* Incomplete output stays unknown, never a task-absence verdict. */ }
    results.push({ phase, sample, temperature: phase === "enabled" && sample === 1 ? "cold-first-harness-controlled-powershell-after-checkout" : "warm", sourceSha256, instancesRequested: true, approximateStartupMs, principalTranslate, timeoutMs: 180_000, startedAt, completedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), status: result.status, signal: result.signal, code: ["ETIMEDOUT", "ENOBUFS", "ENOENT", "EACCES"].includes(result.error?.code) ? result.error.code : result.error ? "NATIVE_TOOL_FAILED" : null, markers, durations, task });
    writeFileSync(output, JSON.stringify(results, null, 2));
  }
  return results;
}
