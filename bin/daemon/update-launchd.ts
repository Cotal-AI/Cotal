import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeSecretFileAtomic } from "@cotal-ai/core";
import { assertSystemdSource, createSystemdSource } from "@cotal-ai/cli";
import { darwinLaunchdJob } from "@cotal-ai/seat";
import { homeCotalDir, readLocalRecordSource, UPDATE_HOUR_MS } from "@cotal-ai/workspace";
import { daemonStartedByOwnedService } from "./install.js";
import { daemonPaths } from "./endpoint.js";
import { processBirth } from "./lifetime.js";
import { xmlText } from "./install-darwin.js";

interface LaunchUpdate {
  label: string;
  source: string;
  sha256: string;
  argv: string[];
  failures: number;
}
export interface LaunchUpdateResult { pid: number; start: string; done: boolean; }
const receiptPath = () => join(homeCotalDir(), "update-launchd.json");
export const launchUpdateResultPath = () => join(homeCotalDir(), "update-launchd-result.json");
const run = (args: string[]) => execFileSync("/bin/launchctl", args, { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
const domain = () => {
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) throw new Error("automatic launchd updates require a signed-in non-root user");
  return `gui/${uid}`;
};

/** A separate non-restarting job, never a child in the daemon's native stop boundary. */
export function renderUpdateLaunchAgent(label: string, argv: string[], env: NodeJS.ProcessEnv): string {
  const str = (value: string) => `<string>${xmlText(value)}</string>`;
  const keys = ["PATH", "HOME", "COTAL_HOME", "XDG_CONFIG_HOME", "TMPDIR", "npm_config_prefix", "npm_config_registry", "DO_NOT_TRACK", "COTAL_TELEMETRY", "COTAL_SKIP_CONNECTOR_SEED"];
  const environment = keys.filter(key => env[key] !== undefined).map(key => `<key>${key}</key>${str(env[key]!)}`).join("");
  const text = ['<?xml version="1.0" encoding="UTF-8"?>', '<plist version="1.0"><dict>',
    `<key>Label</key>${str(label)}`, `<key>ProgramArguments</key><array>${argv.map(str).join("")}</array>`,
    `<key>EnvironmentVariables</key><dict>${environment}</dict>`,
    "<key>RunAtLoad</key><true/>", "<key>KeepAlive</key><false/>", "<key>Umask</key><integer>63</integer>", "</dict></plist>", ""].join("\n");
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error("automatic update LaunchAgent exceeds its bounded source size");
  return text;
}

function receipt(): LaunchUpdate | undefined {
  const source = readLocalRecordSource(receiptPath(), 64 * 1024, true);
  if (!source) return undefined;
  const value = JSON.parse(source.toString("utf8")) as LaunchUpdate;
  if (!/^ai\.cotal\.update\.[a-f0-9]{32}$/.test(value.label) || value.source !== join(homeCotalDir(), `${value.label}.plist`) || !/^[a-f0-9]{64}$/.test(value.sha256) || !Array.isArray(value.argv) || value.argv.some(arg => typeof arg !== "string") || !Number.isInteger(value.failures) || value.failures < 0) throw new Error("automatic update launchd receipt is invalid");
  assertSystemdSource(value.source, value.sha256, true);
  return value;
}

export function readLaunchUpdateResult(): LaunchUpdateResult | undefined {
  const source = readLocalRecordSource(launchUpdateResultPath(), 4096, true);
  if (!source) return undefined;
  const value = JSON.parse(source.toString("utf8")) as LaunchUpdateResult;
  if (!Number.isSafeInteger(value.pid) || value.pid <= 1 || typeof value.start !== "string" || !value.start || typeof value.done !== "boolean") throw new Error("automatic update launchd result is invalid");
  return value;
}

/** Only the documented legacy list columns are parsed, never the non-API print output. */
export function launchUpdatePid(list: string, label: string): number | undefined {
  const rows = list.trim().split(/\r?\n/);
  if (!/^PID\s+Status\s+Label$/.test(rows.shift() ?? "")) throw new Error("launchd job list has no documented column header");
  const matches = rows.filter(row => row.trim().split(/\s+/)[2] === label);
  if (!matches.length) return undefined;
  const match = /^(\d+|-)\s+(-?\d+)\s+(\S+)$/.exec(matches[0]!.trim());
  if (matches.length > 1 || !match || match[3] !== label) throw new Error("launchd updater PID observation is ambiguous");
  if (match[1] === "-") return 0;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("launchd updater PID is invalid");
  return pid;
}

/** Pure recovery decision shared by native observation and state regression cells. */
export function launchUpdateDisposition(jobPid: number | undefined, runnerAlive: boolean, done: boolean): "pending" | "failed" | "completed" {
  if (jobPid !== undefined && jobPid > 0 || runnerAlive) return "pending";
  return done ? "completed" : "failed";
}

export function launchUpdateFailureCount(current: number, beforeHandoff: number): number {
  if (![current, beforeHandoff].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("automatic update failure budget is invalid");
  return Math.max(current, beforeHandoff + 1);
}

/** Retire only the unchanged, stopped updater job. Unknown custody always throws and stays fenced. */
export function cleanLaunchUpdate(): "pending" | "failed" | "completed" | "absent" {
  const recorded = receipt();
  if (!recorded) {
    if (readLaunchUpdateResult()) throw new Error("automatic update result has no custody receipt");
    return "absent";
  }
  const result = readLaunchUpdateResult();
  const observed = darwinLaunchdJob(recorded.label);
  if (observed.state === "unavailable") throw new Error(`cannot inspect updater job: ${observed.reason}`);
  if (observed.state === "loaded" && (observed.job.label !== recorded.label || observed.job.program !== recorded.argv[0] || JSON.stringify(observed.job.programArguments) !== JSON.stringify(recorded.argv))) throw new Error("loaded updater job differs from its recorded source");
  const pid = launchUpdatePid(run(["list"]), recorded.label);
  if ((observed.state === "absent") !== (pid === undefined)) throw new Error("launchd updater observations disagree");
  const disposition = launchUpdateDisposition(pid, result !== undefined && processBirth(result.pid) === result.start, result?.done === true);
  if (disposition === "pending") return disposition;
  if (observed.state === "loaded") {
    assertSystemdSource(recorded.source, recorded.sha256, true);
    run(["bootout", `${domain()}/${recorded.label}`]);
    if (launchUpdatePid(run(["list"]), recorded.label) !== undefined || darwinLaunchdJob(recorded.label).state !== "absent") throw new Error("launchd updater removal is not yet confirmed");
  }
  if (result && processBirth(result.pid) === result.start) throw new Error("updater runner is still present after native removal");
  if (disposition === "failed") {
    const attemptPath = join(homeCotalDir(), "update-attempt.json");
    const source = readLocalRecordSource(attemptPath, 64 * 1024, true);
    if (!source) throw new Error("automatic update attempt record is missing");
    const attempt = JSON.parse(source.toString("utf8"));
    if (!Number.isInteger(attempt.failures) || attempt.failures < 0) throw new Error("automatic update failure budget is invalid");
    // The receipt captures the prior count. Repeating after a partial cleanup cannot count twice.
    writeSecretFileAtomic(attemptPath, `${JSON.stringify({ ...attempt, failures: launchUpdateFailureCount(attempt.failures, recorded.failures), result: "launchd updater exited without confirming completion; retrying automatically", next: Date.now() + UPDATE_HOUR_MS })}\n`);
  }
  assertSystemdSource(recorded.source, recorded.sha256, true);
  rmSync(launchUpdateResultPath(), { force: true });
  rmSync(receiptPath());
  rmSync(recorded.source);
  return disposition;
}

/** A nonzero or uncertain bootstrap is never retried as a detached child. */
export function startLaunchUpdate(failures: number): void {
  if (process.platform !== "darwin") throw new Error("launchd update handoff requires macOS");
  if (daemonStartedByOwnedService(daemonPaths()).state !== "owned") throw new Error("automatic update does not own the recorded launchd daemon");
  if (cleanLaunchUpdate() === "pending") throw new Error("previous launchd updater still has native custody");
  const label = `ai.cotal.update.${randomBytes(16).toString("hex")}`;
  const argv = [process.execPath, fileURLToPath(new URL("./update-launchd-runner.js", import.meta.url)), label];
  const source = join(homeCotalDir(), `${label}.plist`);
  const text = renderUpdateLaunchAgent(label, argv, process.env);
  const sha256 = createHash("sha256").update(text).digest("hex");
  createSystemdSource(source, text, sha256, true);
  writeSecretFileAtomic(receiptPath(), `${JSON.stringify({ label, source, sha256, argv, failures })}\n`);
  run(["bootstrap", domain(), source]);
}

/** The runner accepts only the freshly recorded launchd entry, not arbitrary command arguments. */
export function admitLaunchUpdate(label: string): void {
  const recorded = receipt();
  if (process.platform !== "darwin" || process.ppid !== 1 || !recorded || label !== recorded.label || JSON.stringify(process.argv) !== JSON.stringify(recorded.argv)) throw new Error("automatic update runner does not match its launchd receipt");
  if (readLaunchUpdateResult()) throw new Error("automatic update runner already started; refusing a second execution");
  const start = processBirth(process.pid);
  if (!start) throw new Error("automatic update runner birth is unavailable");
  writeSecretFileAtomic(launchUpdateResultPath(), `${JSON.stringify({ pid: process.pid, start, done: false })}\n`);
}
