import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync, closeSync, ftruncateSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { openPrivateAppend, writeSecretFileAtomic } from "@cotal-ai/core";
import { checkForUpdate, homeCotalDir, newerUpdate, readUpdateCheck, readUpdateRecovery, readUpdateSettings, UPDATE_DAY_MS, UPDATE_HOUR_MS } from "@cotal-ai/workspace";
import type { DaemonUpdateStatus } from "./protocol.js";

interface Attempt { version?: string; failures: number; result: string; next: number; }
interface UpdateHost {
  version: string;
  eligible(): boolean;
  prepare(): Promise<void>;
  abort(): Promise<void>;
  report(line: string): void;
}

/** Schedule only the existing updater. Manager preparation holds its native empty-seat admission fence. */
export function automaticUpdates(host: UpdateHost): { status(): DaemonUpdateStatus; close(): Promise<void> } {
  const desktop = existsSync(fileURLToPath(new URL("../../desktop-runtime.json", import.meta.url)));
  const file = join(homeCotalDir(), "update-attempt.json");
  let state: Attempt = { failures: 0, result: "not checked", next: Date.now() + Math.random() * UPDATE_HOUR_MS };
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (!value || !Number.isInteger(value.failures) || value.failures < 0 || typeof value.result !== "string" || !Number.isFinite(value.next)) throw new Error("invalid automatic update attempt record");
    state = value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") state = { ...state, result: "automatic updates paused: unreadable attempt record", next: Number.MAX_SAFE_INTEGER };
  }
  let child: ChildProcess | undefined, busy: Promise<void> | undefined, closed = false;
  const persist = () => writeSecretFileAtomic(file, `${JSON.stringify(state)}\n`);
  try { persist(); } catch (error) { host.report(`automatic updates paused: ${String(error)}`); state.next = Number.MAX_SAFE_INTEGER; }
  const status = (): DaemonUpdateStatus => {
    if (!busy) {
      try {
        const recorded = JSON.parse(readFileSync(file, "utf8"));
        if (recorded && Number.isInteger(recorded.failures) && typeof recorded.result === "string" && Number.isFinite(recorded.next)) state = recorded;
      } catch { /* The last validated state remains visible if a read fails. */ }
    }
    const cached = readUpdateCheck();
    let automatic = false, reason = state.result;
    try {
      automatic = process.platform === "linux" && !desktop && readUpdateSettings().auto && process.env.COTAL_NO_UPDATE_CHECK !== "1" && host.eligible();
      const recovery = readUpdateRecovery();
      if (recovery) { automatic = false; reason = `automatic updates paused: installed ${recovery.installed}; ${recovery.reason}; run \`cotal update --self\``; }
    } catch (error) { automatic = false; reason = `automatic updates paused: ${String(error)}`; }
    if (process.platform !== "linux") reason = `${reason}. Automatic installation is available on Linux in this release. Run \`cotal update --self\` here`;
    if (desktop) reason = "update the desktop app with its signed platform installer";
    return { channel: desktop ? "desktop" : "npm", current: host.version, latest: cached?.latest, lastCheck: cached?.checkedAt ? new Date(cached.checkedAt).toISOString() : undefined, automatic, failures: state.failures, lastResult: reason, ...(state.next < Number.MAX_SAFE_INTEGER ? { nextAttempt: new Date(state.next).toISOString() } : {}) };
  };
  const tick = async (): Promise<void> => {
    if (closed) return;
    const settings = readUpdateSettings();
    const cached = process.env.COTAL_NO_UPDATE_CHECK !== "1" && (settings.auto || settings.notify) ? await checkForUpdate() : readUpdateCheck();
    if (closed || Date.now() < state.next) return;
    if (desktop) {
      state = { ...state, next: Date.now() + UPDATE_DAY_MS + Math.random() * UPDATE_HOUR_MS };
      persist();
      return;
    }
    if (!status().automatic) return;
    if (closed) return;
    if (!cached?.latest || cached.error) { state = { ...state, result: cached?.error ?? "registry check unavailable", next: Date.now() + UPDATE_HOUR_MS }; persist(); return; }
    if (state.version !== cached.latest) state = { version: cached.latest, failures: 0, result: "new release observed", next: 0 };
    if (state.failures >= 2) { state = { ...state, result: `version ${cached.latest} failed twice; waiting for a newer version or manual update`, next: Date.now() + UPDATE_DAY_MS }; persist(); return; }
    if (!newerUpdate(cached.latest, host.version)) { state = { ...state, result: "up to date", next: Date.now() + UPDATE_DAY_MS + Math.random() * UPDATE_HOUR_MS }; persist(); return; }
    if (Date.now() - (cached.firstSeenAt ?? Date.now()) < UPDATE_HOUR_MS) { state = { ...state, result: "waiting for release hold", next: (cached.firstSeenAt ?? Date.now()) + UPDATE_HOUR_MS }; persist(); return; }
    try { await host.prepare(); }
    catch (error) { state = { ...state, result: `waiting for idle Managers: ${error instanceof Error ? error.message : String(error)}`, next: Date.now() + 60_000 }; persist(); return; }
    try {
      if (closed || !status().automatic) return;
      state = { ...state, failures: state.failures, result: `updating to ${cached.latest}`, next: Date.now() + UPDATE_HOUR_MS };
      persist();
      await new Promise<{ code: number | null; output: string }>(resolve => {
        const logPath = join(homeCotalDir(), "update-attempt.log");
        const outputFd = openPrivateAppend(logPath);
        ftruncateSync(outputFd, 0);
        child = spawn(process.execPath, [fileURLToPath(new URL("../cotal.js", import.meta.url)), "update", "--self"], { env: { ...process.env, COTAL_NO_UPDATE_CHECK: "1", COTAL_AUTO_UPDATE: "1" }, stdio: ["ignore", outputFd, outputFd], detached: true, windowsHide: true });
        closeSync(outputFd);
        const readOutput = () => { try { return readFileSync(logPath, "utf8").slice(-4000); } catch { return "update log unavailable"; } };
        child.once("error", error => resolve({ code: null, output: error.message }));
        child.once("close", code => resolve({ code, output: readOutput() }));
      });
      child = undefined;
      const recorded = JSON.parse(readFileSync(join(homeCotalDir(), "update-attempt.json"), "utf8")) as Attempt;
      state = recorded;
      persist(); host.report(state.result);
    } finally { if (!closed) await host.abort(); }
  };
  const timer = setInterval(() => {
    if (busy || closed) return;
    busy = tick().catch(error => { host.report(`automatic update: ${String(error)}`); }).finally(() => { busy = undefined; });
  }, 30_000);
  timer.unref();
  return { status, async close() {
    closed = true; clearInterval(timer);
    if (child) {
      child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
    } else await busy;
  } };
}
