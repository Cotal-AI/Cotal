/** Application discovery for GUI launches. Only PATH is retained from the account's shell. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";
import { CommandFailure } from "@cotal-ai/workspace";
import { serviceAgentAppBinDirs } from "./desktop-agent-apps.js";
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
interface ReadError { readonly code?: number | string; readonly signal?: NodeJS.Signals | null }
function readFailure(error: ReadError, stderr: string, reader: string): string {
  const what = error.code === "MAXBUFFER" ? `${reader} printed more than 64 KiB while starting`
    : typeof error.code === "number" ? `${reader} exited with status ${error.code}`
    : error.signal ? `${reader} was stopped by ${error.signal}`
    : `${reader} could not be started${error.code ? ` (${error.code})` : ""}`;
  const output = lastErrorOutput(stderr);
  return `the account's application PATH could not be read: ${what}${output ? `; its last error output was "${output}"` : ""}; no service was changed`;
}

/** Run a PATH reader with no terminal. Its input is empty (or `input`), so a startup file that waits for a key reads end of file.
 *  On POSIX it leads its own process group. When the reader exits, the group is killed, so a job its startup files left
 *  behind neither holds the output open nor outlives the read. The 30 seconds are a hard limit: a timeout settles at once,
 *  even while something outside the group still holds the output. */
const run = (command: string, args: string[], reader: string, remedy: string, timeoutRemedy = remedy, input?: string) => new Promise<string>((resolve, reject) => {
  const posixGroup = process.platform !== "win32";
  const child = spawn(command, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], detached: posixGroup, windowsHide: true });
  let stdout = "", stderr = "", bytes = 0, settled = false;
  let stopped: "timeout" | "MAXBUFFER" | undefined, exit: ReadError | undefined, drain: NodeJS.Timeout | undefined;
  const killGroup = () => { try { if (posixGroup && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* the group already ended */ } };
  const settle = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer); clearTimeout(drain);
    child.stdout!.destroy(); child.stderr!.destroy();
    if (stopped === "timeout") reject(new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "reading the account's application PATH timed out after 30 seconds; no service was changed", { remedy: timeoutRemedy }));
    else if (stopped || exit?.code !== 0) reject(new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", readFailure(stopped ? { code: stopped } : exit ?? {}, stderr, reader), { remedy }));
    else resolve(stdout);
  };
  const stop = (why: "timeout" | "MAXBUFFER") => { stopped ??= why; killGroup(); settle(); };
  const timer = setTimeout(() => stop("timeout"), 30_000);
  const collect = (into: "out" | "err") => (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 64 * 1024) return stop("MAXBUFFER");
    if (into === "out") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
  };
  child.stdout!.on("data", collect("out"));
  child.stderr!.on("data", collect("err"));
  if (input !== undefined) child.stdin!.end(input);
  child.once("error", (error: NodeJS.ErrnoException) => { exit = { code: error.code }; settle(); });
  child.once("exit", (code, signal) => {
    exit = { code: code ?? undefined, signal };
    killGroup();
    // What the reader wrote is already in the pipe; give it a moment to arrive if a process outside the group holds the pipe open.
    drain = setTimeout(settle, 1_000);
  });
  child.once("close", () => { if (exit) settle(); });
});

interface DiscoveredApplicationPath {
  readonly path: string;
  readonly omittedRelativeEntries: readonly string[];
}

/** Append the per-user installer folders of this OS's connectors after the caller's PATH when missing. */
export function serviceApplicationPath(value = process.env.PATH ?? "", os: "darwin" | "linux" = process.platform === "darwin" ? "darwin" : "linux", home = process.env.HOME || homedir()): string {
  const caller = pinnedPath(value, posix).split(posix.delimiter);
  const appended = serviceAgentAppBinDirs(os, home);
  return pinnedPath([...new Set([...caller, ...appended])].join(posix.delimiter), posix);
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
  const print = `/bin/sh -c 'printf "\\n${marker}%s${marker}\\n" "$PATH"'`;
  // tcsh and csh take `-l` only as their sole flag, so they read the command as a login shell from standard input.
  // Elsewhere `-l` comes first because PowerShell honours it only there, and the flags stay separate because
  // nushell before 0.111 refuses `-ilc` as "flag missing string argument".
  const csh = ["tcsh", "csh"].includes(basename(shell));
  const output = await run(shell, csh ? ["-l"] : ["-l", "-i", "-c", print], `the login shell ${shell}`, "check that your login shell starts successfully, then choose Check again", undefined, csh ? `${print}\n` : undefined);
  const parts = output.split(marker);
  if (parts.length !== 3) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the login shell returned no bounded application PATH; no service was changed");
  return filterDesktopApplicationPath(parts[1]!, dirname(process.execPath));
}
