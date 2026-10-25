import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** What one job launch starts: an absolute executable, its full command line (see
 *  {@link windowsCommandLine}), its directory, its environment block (see
 *  {@link windowsEnvironmentBlock}) and the existing log file its output appends to. */
export interface Win32JobLaunch { application: string; commandLine: string; cwd: string; environment: string; log: string }

/** The shipped Windows binding. `launch` starts one process inside a new job that kills every
 *  member when its last handle closes and allows no breakaway; the job and the launched process
 *  stay held until this process exits, so a process launches at most once. */
export interface Win32ProcessBinding {
  creationToken(pid: number): string | undefined;
  userSid(): string;
  launch(options: Win32JobLaunch): { pid: number; token: string };
  rootExit(): number | undefined;
  jobProcesses(): number[];
  inJob(pid: number): boolean | undefined;
  terminate(code: number): void;
}

const require = createRequire(import.meta.url);
let binding: Win32ProcessBinding | undefined;

/** Load the shipped Node-API binding once. A broken installation is a loud failure, not an unreadable process. */
export function win32ProcessBinding(): Win32ProcessBinding {
  if (process.platform !== "win32" || (process.arch !== "x64" && process.arch !== "arm64"))
    throw new Error(`Windows creation identity is unsupported on ${process.platform}/${process.arch}`);
  if (binding === undefined) {
    const path = new URL(`../build/Release/win32-${process.arch}/creation.node`, import.meta.url);
    let loaded: unknown;
    try { loaded = require(fileURLToPath(path)); }
    catch (cause) { throw new Error("could not load the shipped Windows creation identity binding; reinstall this version", { cause }); }
    if (loaded === null || typeof loaded !== "object" || !["creationToken", "userSid", "launch", "rootExit", "jobProcesses", "inJob", "terminate"].every((name) => typeof (loaded as Record<string, unknown>)[name] === "function"))
      throw new Error("the shipped Windows creation identity binding is missing a reader");
    binding = loaded as Win32ProcessBinding;
  }
  return binding;
}

/** Read through the shipped Node-API binding. A broken installation is not an unreadable PID. */
export function nativeWin32CreationToken(pid: number): string | undefined {
  return win32ProcessBinding().creationToken(pid);
}

/** One argument as the Microsoft C runtime parses it back, quoted the way libuv quotes a spawn's
 *  arguments, so a job launch passes the same argv a Node spawn did. */
function quoteArgument(arg: string): string {
  if (arg === "") return '""';
  if (!/[ \t"]/.test(arg)) return arg;
  if (!/["\\]/.test(arg)) return `"${arg}"`;
  let quoted = '"', backslashes = 0;
  for (const char of arg) {
    if (char === "\\") { backslashes++; continue; }
    quoted += char === '"' ? `${"\\".repeat(backslashes * 2 + 1)}"` : `${"\\".repeat(backslashes)}${char}`;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

/** The command line for `program` and `args`. A NUL cannot cross the call, so it is refused. */
export function windowsCommandLine(program: string, args: readonly string[]): string {
  if ([program, ...args].some((part) => part.includes("\0"))) throw new Error("a Windows command line cannot carry a NUL character");
  return [program, ...args].map(quoteArgument).join(" ");
}

/** Variables a Windows child needs, which libuv copies from the parent when an environment omits them. */
const REQUIRED = ["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR"];

/** `env` as a Windows environment block, sorted by name without regard to case, with the variables
 *  Windows needs filled from `parent` as libuv does. Two names that differ only in case are refused. */
export function windowsEnvironmentBlock(env: NodeJS.ProcessEnv, parent: NodeJS.ProcessEnv = process.env): string {
  const entries = new Map<string, [string, string]>();
  const add = (name: string, value: string | undefined) => {
    if (value === undefined) return;
    if (!/^=?[^=\0]+$/.test(name) || value.includes("\0")) throw new Error(`invalid environment variable ${JSON.stringify(name)} for a Windows launch`);
    const key = name.toUpperCase();
    if (entries.has(key)) throw new Error(`the environment names ${key} more than once`);
    entries.set(key, [name, value]);
  };
  for (const [name, value] of Object.entries(env)) add(name, value);
  for (const name of REQUIRED) {
    if (entries.has(name)) continue;
    const found = Object.keys(parent).find((key) => key.toUpperCase() === name);
    if (found !== undefined) add(found, parent[found]);
  }
  const sorted = [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted.map(([, [name, value]]) => `${name}=${value}\0`).join("");
}
