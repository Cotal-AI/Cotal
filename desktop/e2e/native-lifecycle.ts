import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export type LifecycleAction = "describe" | "close-window" | "settings" | "quit" | "login-entry" | "connected-view" | "settings-back" | "disable-login";
export interface NativeObservation { pid: number; visible: boolean; path?: string; args?: string[]; title?: string; label?: string }

/** Run native desktop automation asynchronously so the fixture provider keeps answering. */
export async function nativeLifecycle(binary: string, action: LifecycleAction, env: NodeJS.ProcessEnv): Promise<NativeObservation> {
  const windows = process.platform === "win32";
  assert.ok(windows || process.platform === "linux", "native lifecycle helper requires Linux or Windows");
  const command = windows ? `${process.env.SystemRoot}/System32/WindowsPowerShell/v1.0/powershell.exe` : "/usr/bin/python3";
  const helper = fileURLToPath(new URL(windows ? "./lifecycle-windows.ps1" : "./lifecycle-linux.py", import.meta.url));
  const args = windows ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", helper, "-Binary", binary, "-Action", action] : [helper, binary, action];
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(command, args, { env, encoding: "utf8", windowsHide: true, timeout: 45_000, maxBuffer: 512 * 1024 }, (error, out, stderr) => {
      if (error) reject(new Error(`${action}: ${error.message}\n${stderr}\n${out}`));
      else resolve(out);
    });
  });
  return JSON.parse(stdout.trim()) as NativeObservation;
}
