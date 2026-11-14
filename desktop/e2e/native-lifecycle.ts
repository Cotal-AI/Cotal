import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type LifecycleAction = "describe" | "close-window" | "settings" | "quit" | "login-entry" | "connected-view" | "settings-back" | "disable-login";
export interface NativeObservation { pid: number; visible: boolean; path?: string; args?: string[]; title?: string; label?: string; candidates?: { pid: number; birth: string; path: string }[] }

/** Run native desktop automation asynchronously so the fixture provider keeps answering. */
export async function nativeLifecycle(binary: string, action: LifecycleAction, env: NodeJS.ProcessEnv, appPid?: number): Promise<NativeObservation> {
  const windows = process.platform === "win32";
  assert.ok(windows || process.platform === "linux", "native lifecycle helper requires Linux or Windows");
  const command = windows ? `${process.env.SystemRoot}/System32/WindowsPowerShell/v1.0/powershell.exe` : "/usr/bin/python3";
  const helper = fileURLToPath(new URL(windows ? "./lifecycle-windows.ps1" : "./lifecycle-linux.py", import.meta.url));
  const args = windows ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", helper, "-Binary", binary, "-Action", action] : [helper, binary, action];
  if (appPid !== undefined) {
    assert.ok(windows && Number.isSafeInteger(appPid) && appPid > 0, "Windows app PID must be launch-pinned");
    args.push("-AppPid", String(appPid));
  }
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(command, args, { env, encoding: "utf8", windowsHide: true, timeout: 45_000, maxBuffer: 512 * 1024 }, (error, out, stderr) => {
      if (windows && env.COTAL_DESKTOP_E2E_NATIVE_LOG) {
        try {
          const report = JSON.parse(out.trim());
          appendFileSync(join(dirname(env.COTAL_DESKTOP_E2E_NATIVE_LOG), "windows-lifecycle-candidates.jsonl"),
            `${JSON.stringify({ at: new Date().toISOString(), action, ok: report.ok, appPid, candidates: report.candidates })}\n`, { mode: 0o600 });
        } catch (diagnosticError) {
          reject(new Error(`${action}: candidate evidence unavailable: ${diagnosticError}\n${error?.message ?? ""}\n${stderr}\n${out}`));
          return;
        }
      }
      if (error) reject(new Error(`${action}: ${error.message}\n${stderr}\n${out}`));
      else resolve(out);
    });
  });
  return JSON.parse(stdout.trim()) as NativeObservation;
}
