/** Application discovery for GUI launches. Only PATH is retained from the account's shell. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { CommandFailure } from "@cotal-ai/workspace";
import { pinnedPath } from "./install.js";

const run = (command: string, args: string[]) => new Promise<string>((resolve, reject) => {
  execFile(command, args, { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
    if (error) reject(new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the account's application PATH could not be read; no service was changed", { remedy: "check that your login shell starts successfully, then choose Check again" }));
    else resolve(stdout);
  });
});

/** Windows tasks do not pin PATH. Read the current machine and user values on each native start. */
export async function windowsApplicationPath(): Promise<string> {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!root || !win32.isAbsolute(root)) throw new CommandFailure("refused", "UNSUPPORTED", "the Windows system directory is unavailable; no application PATH was guessed");
  const script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ErrorActionPreference = 'Stop'; $p = @([Environment]::GetEnvironmentVariable('Path','Machine'), [Environment]::GetEnvironmentVariable('Path','User')) | Where-Object { $_ }; [Console]::Write([Environment]::ExpandEnvironmentVariables(($p -join ';')))";
  const value = await run(join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]);
  return pinnedPath(`${value};${dirname(process.execPath)}`, win32);
}

/** No renderer-supplied executable, argument, shell or environment is accepted. */
export async function desktopApplicationPath(): Promise<string> {
  if (process.platform === "win32") return windowsApplicationPath();
  if (process.platform !== "linux" && process.platform !== "darwin") throw new CommandFailure("refused", "UNSUPPORTED", "this OS has no desktop application discovery");
  const shell = userInfo().shell;
  if (!shell || !posix.isAbsolute(shell)) throw new CommandFailure("refused", "UNSUPPORTED", "the account has no absolute login shell; no application PATH was guessed");
  const marker = `cotal_path_${randomUUID().replaceAll("-", "")}`;
  const output = await run(shell, ["-ilc", `printf '\\n${marker}%s${marker}\\n' "$PATH"`]);
  const parts = output.split(marker);
  if (parts.length !== 3) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the login shell returned no bounded application PATH; no service was changed");
  return pinnedPath(`${parts[1]}:${dirname(process.execPath)}`, posix);
}
