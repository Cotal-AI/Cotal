/** Application discovery for GUI launches. Only PATH is retained from the account's shell. */
import { execFile, type ExecFileException } from "node:child_process";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { CommandFailure } from "@cotal-ai/workspace";
import { pinnedPath } from "./install.js";

/** The last few lines a failed PATH read printed to stderr, bounded and with tokens and control characters removed.
 *  Its own quote marks become ’ so the caller's quotes hold the whole tail: telemetry masks quoted values. */
function lastErrorOutput(stderr: string): string {
  const lines = stderr.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/eyJ[A-Za-z0-9_.-]*/g, "<redacted>")
    .split(/\r?\n/).map((line) => line.replace(/[\u0000-\u001f\u007f]/g, "").replace(/["'`]/g, "’").trim()).filter(Boolean);
  const tail = lines.slice(-3).join(" / ");
  return tail.length > 300 ? `…${tail.slice(-299)}` : tail;
}

/** Say what the PATH reader did when it failed, so the person can fix that exact startup step. */
function readFailure(error: ExecFileException, stderr: string, reader: string): string {
  const what = error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? `${reader} printed more than 64 KiB while starting`
    : typeof error.code === "number" ? `${reader} exited with status ${error.code}`
    : error.signal ? `${reader} was stopped by ${error.signal}`
    : `${reader} could not be started${error.code ? ` (${error.code})` : ""}`;
  const output = lastErrorOutput(stderr);
  return `the account's application PATH could not be read: ${what}${output ? `; its last error output was "${output}"` : ""}; no service was changed`;
}

const run = (command: string, args: string[], reader: string, remedy: string, timeoutRemedy = remedy) => new Promise<string>((resolve, reject) => {
  execFile(command, args, { timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
    if (!error) resolve(stdout);
    else if (error.killed) reject(new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "reading the account's application PATH timed out after 30 seconds; no service was changed", { remedy: timeoutRemedy }));
    else reject(new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", readFailure(error, stderr, reader), { remedy }));
  });
});

interface DiscoveredApplicationPath {
  readonly path: string;
  readonly omittedRelativeEntries: readonly string[];
}

/** Keep only absolute POSIX entries for the desktop service and name any relative entries left out, in order and without duplicates. */
export function filterDesktopApplicationPath(raw: string, nodeDir: string): DiscoveredApplicationPath {
  const entries = `${raw}${posix.delimiter}${nodeDir}`.split(posix.delimiter).filter((entry) => entry !== "");
  const kept: string[] = [];
  const omitted: string[] = [];
  for (const entry of entries) {
    if (posix.isAbsolute(entry)) kept.push(entry);
    else if (!omitted.includes(entry)) omitted.push(entry);
  }
  return { path: pinnedPath(kept.join(posix.delimiter), posix), omittedRelativeEntries: omitted };
}

/** Windows tasks do not pin PATH. Read the current machine and user values on each native start. */
export async function windowsApplicationPath(): Promise<string> {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!root || !win32.isAbsolute(root)) throw new CommandFailure("refused", "UNSUPPORTED", "the Windows system directory is unavailable; no application PATH was guessed");
  const script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ErrorActionPreference = 'Stop'; $p = @([Environment]::GetEnvironmentVariable('Path','Machine'), [Environment]::GetEnvironmentVariable('Path','User')) | Where-Object { $_ }; [Console]::Write([Environment]::ExpandEnvironmentVariables(($p -join ';')))";
  const value = await run(join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], "PowerShell", "choose Try again, or run `cotal daemon install` in a terminal for diagnostics", "wait a moment and choose Try again");
  return pinnedPath(`${value};${dirname(process.execPath)}`, win32);
}

/** Discover the desktop application PATH and any relative entries left out of it. No renderer-supplied executable, argument, shell or environment is accepted. */
export async function discoverDesktopApplicationPath(): Promise<DiscoveredApplicationPath> {
  if (process.platform === "win32") return { path: await windowsApplicationPath(), omittedRelativeEntries: [] };
  if (process.platform !== "linux" && process.platform !== "darwin") throw new CommandFailure("refused", "UNSUPPORTED", "this OS has no desktop application discovery");
  const shell = userInfo().shell;
  if (!shell || !posix.isAbsolute(shell)) throw new CommandFailure("refused", "UNSUPPORTED", "the account has no absolute login shell; no application PATH was guessed");
  const marker = `cotal_path_${randomUUID().replaceAll("-", "")}`;
  // The login shell only builds the environment; /bin/sh prints PATH, so a non-POSIX shell such as nushell works.
  // The flags stay separate because nushell before 0.111 refuses `-ilc` as "flag missing string argument".
  const output = await run(shell, ["-i", "-l", "-c", `/bin/sh -c 'printf "\\n${marker}%s${marker}\\n" "$PATH"'`], `the login shell ${shell}`, "check that your login shell starts successfully, then choose Check again");
  const parts = output.split(marker);
  if (parts.length !== 3) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the login shell returned no bounded application PATH; no service was changed");
  return filterDesktopApplicationPath(parts[1]!, dirname(process.execPath));
}
