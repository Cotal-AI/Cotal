import { lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { win32ProcessBinding } from "./win32-process.js";

/** Compare the file-security owner's SID with this process's native token SID. Unknown ownership throws. */
export function windowsSetOwnedByCurrentUser(path: string): boolean {
  if (process.platform !== "win32") throw new Error("Windows set ownership requires Windows");
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("connector set root must be a real directory");
  const script = "$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + Buffer.from(path).toString("base64") + "'));$i=Get-Item -LiteralPath $p -Force;if(($i.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){throw 'connector set root is a reparse point'};$a=Get-Acl -LiteralPath $p;$a.GetOwner([Security.Principal.SecurityIdentifier]).Value";
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", timeout: 30000, windowsHide: true, maxBuffer: 64 * 1024 });
  if (result.status !== 0 || result.signal || result.error) throw new Error(`Windows connector set ownership could not be read: ${result.stderr?.trim() || result.error?.message || result.status}`);
  const sid = result.stdout.trim();
  if (!/^S-1-[0-9-]+$/.test(sid)) throw new Error("Windows connector set owner query returned no valid SID");
  const after = lstatSync(path);
  if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.birthtimeMs !== after.birthtimeMs) throw new Error("connector set root changed during Windows ownership query");
  return sid === win32ProcessBinding().userSid();
}
