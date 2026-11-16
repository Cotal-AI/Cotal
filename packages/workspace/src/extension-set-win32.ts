import { lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { win32ProcessBinding } from "./win32-process.js";

/** Compare the file-security owner's SID with this process's native token SID. Unknown ownership throws. */
export function windowsSetOwnedByCurrentUser(path: string): boolean {
  if (process.platform !== "win32") throw new Error("Windows set ownership requires Windows");
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("connector set root must be a real directory");
  const script = "$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + Buffer.from(path).toString("base64") + "'));$i=Get-Item -LiteralPath $p -Force;if(($i.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){throw 'connector set root is a reparse point'};$a=Get-Acl -LiteralPath $p;$a.GetOwner([Security.Principal.SecurityIdentifier]).Value";
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env: environment, encoding: "utf8", timeout: 30000, windowsHide: true, maxBuffer: 64 * 1024 });
  if (result.status !== 0 || result.signal || result.error) throw new Error(`Windows connector set ownership could not be read: ${result.stderr?.trim() || result.error?.message || result.status}`);
  const sid = result.stdout.trim();
  if (!/^S-1-[0-9-]+$/.test(sid)) throw new Error("Windows connector set owner query returned no valid SID");
  const after = lstatSync(path);
  if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.birthtimeMs !== after.birthtimeMs) throw new Error("connector set root changed during Windows ownership query");
  if (sid === win32ProcessBinding().userSid()) return true;
  if (sid === "S-1-5-32-544" || sid === "S-1-5-18") throw new Error(`connector set directory ${path} is owned by ${sid}, not this account; run this installation's \`cotal ext seed --repair\` as its owning account`);
  return false;
}
