import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeSecretFileAtomic } from "@cotal-ai/core";
import { assertSystemdSource, createSystemdSource } from "@cotal-ai/cli";
import { darwinLaunchdJob } from "@cotal-ai/seat";
import { homeCotalDir, readLocalRecordSource } from "@cotal-ai/workspace";
import { daemonStartedByOwnedService } from "./install.js";
import { daemonPaths } from "./endpoint.js";
import { processBirth } from "./lifetime.js";
import { xmlText } from "./install-darwin.js";

interface LaunchUpdate {
  label: string;
  source: string;
  sha256: string;
  argv: string[];
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
  if (!/^ai\.cotal\.update\.[a-f0-9]{32}$/.test(value.label) || value.source !== join(homeCotalDir(), `${value.label}.plist`) || !/^[a-f0-9]{64}$/.test(value.sha256) || !Array.isArray(value.argv) || value.argv.some(arg => typeof arg !== "string")) throw new Error("automatic update launchd receipt is invalid");
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

/** Boot out only a completed, exited updater whose exact source and loaded argv still match. */
export function cleanLaunchUpdate(): void {
  const recorded = receipt();
  if (!recorded) return;
  const result = readLaunchUpdateResult();
  if (!result?.done || processBirth(result.pid) === result.start) throw new Error("previous launchd update has not confirmed completion and exit");
  const observed = darwinLaunchdJob(recorded.label);
  if (observed.state === "unavailable") throw new Error(`cannot inspect updater job: ${observed.reason}`);
  if (observed.state === "loaded") {
    if (observed.job.label !== recorded.label || observed.job.program !== recorded.argv[0] || JSON.stringify(observed.job.programArguments) !== JSON.stringify(recorded.argv)) throw new Error("loaded updater job differs from its recorded source");
    run(["bootout", `${domain()}/${recorded.label}`]);
  }
  assertSystemdSource(recorded.source, recorded.sha256, true);
  rmSync(recorded.source);
  rmSync(receiptPath());
  rmSync(launchUpdateResultPath());
}

/** A nonzero or uncertain bootstrap is never retried as a detached child. */
export function startLaunchUpdate(): void {
  if (process.platform !== "darwin") throw new Error("launchd update handoff requires macOS");
  if (daemonStartedByOwnedService(daemonPaths()).state !== "owned") throw new Error("automatic update does not own the recorded launchd daemon");
  cleanLaunchUpdate();
  const label = `ai.cotal.update.${randomBytes(16).toString("hex")}`;
  const argv = [process.execPath, fileURLToPath(new URL("./update-launchd-runner.js", import.meta.url)), label];
  const source = join(homeCotalDir(), `${label}.plist`);
  const text = renderUpdateLaunchAgent(label, argv, process.env);
  const sha256 = createHash("sha256").update(text).digest("hex");
  createSystemdSource(source, text, sha256, true);
  writeSecretFileAtomic(receiptPath(), `${JSON.stringify({ label, source, sha256, argv })}\n`);
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
