import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";

export const WINDOWS_JOB_REFUSAL =
  "this Windows process is in a job that does not allow process breakaway, so it cannot host a detached stack. Run `cotal up --foreground` in this terminal, or start the mesh from a session that is not job-bound";

export interface WindowsJobState {
  inJob: boolean;
  breakawayAllowed: boolean;
}

export interface WindowsDetachedLauncher {
  jobState(): WindowsJobState;
  spawn(command: string, args: readonly string[], opts: SpawnOptions): ChildProcess;
}

export function assertWindowsDetachAllowed(state: WindowsJobState): boolean {
  if (state.inJob && !state.breakawayAllowed) throw new Error(WINDOWS_JOB_REFUSAL);
  return state.inJob;
}

export interface DetachedSpawnOptions extends SpawnOptions {
  windowsLogPath?: string;
}

export type SignalProcess = (pid: number, signal?: NodeJS.Signals | number) => boolean;

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

/** The ChildProcess-shaped handle returned after the native Windows launcher closes its process
 * handle. Kept as a seam because the contract must be testable without spawning or signalling a
 * real process on a Windows host. */
export function windowsDetachedChild(pid: number, signalProcess: SignalProcess = process.kill): ChildProcess {
  return {
    pid,
    exitCode: null,
    signalCode: null,
    unref() {},
    kill(signal: NodeJS.Signals | number = "SIGTERM") {
      try { return signalProcess(pid, signal); }
      catch (error) {
        // ChildProcess.kill reports an already-gone child as `false`; keep that caller contract even
        // though the pid-only Windows implementation reaches process.kill, which throws ESRCH.
        if (isNoSuchProcess(error)) return false;
        throw error;
      }
    },
  } as unknown as ChildProcess;
}

/** A detached child may be signalable without being observable. Waiting code must reject that
 * shape instead of treating absent event methods as evidence the process exited. */
export function assertDetachedChildExitObservable(child: ChildProcess): void {
  if (typeof child.once !== "function" || typeof child.off !== "function")
    throw new Error(`detached child process ${child.pid ?? "unknown"} cannot have its exit observed`);
}

/** Run detached-process cleanup without letting its failure replace the operation that made cleanup
 * necessary. The primary Error remains the thrown object; a cleanup failure is attached as `cause`. */
export async function rethrowAfterDetachedCleanup(primary: unknown, cleanup: () => void | Promise<void>): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    if (primary instanceof Error) {
      Object.defineProperty(primary, "cause", { value: cleanupError, configurable: true });
      throw primary;
    }
    throw new Error(String(primary), { cause: cleanupError });
  }
  throw primary;
}

const windowsScript = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class CotalDetachedProcess {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount; public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length, IntPtr returnedLength);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, string commandLine, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  public static int JobFlags() { bool inside; if (!IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out inside)) throw new Win32Exception(); if (!inside) return 0; JOBOBJECT_EXTENDED_LIMIT_INFORMATION info; if (!QueryInformationJobObject(IntPtr.Zero, 9, out info, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)), IntPtr.Zero)) throw new Win32Exception(); return (int)(info.BasicLimitInformation.LimitFlags | 0x40000000u); }
  public static int Spawn(string app, string line, string cwd, string log, string[] env, bool breakaway) { var si=new STARTUPINFO(); si.cb=Marshal.SizeOf(si); si.dwFlags=0x100; si.hStdInput=GetStdHandle(-10); IntPtr output=String.IsNullOrEmpty(log)?GetStdHandle(-11):CreateFile(log,0x40000000u,3u,IntPtr.Zero,4u,0x80u,IntPtr.Zero); if(output==new IntPtr(-1)) throw new Win32Exception(); si.hStdOutput=output; si.hStdError=output; string block=String.Join("\0",env)+"\0\0"; IntPtr environment=Marshal.StringToHGlobalUni(block); PROCESS_INFORMATION pi; uint flags=0x8u|0x200u|0x400u|(breakaway?0x01000000u:0u); try { if (!CreateProcess(app,line,IntPtr.Zero,IntPtr.Zero,true,flags,environment,cwd,ref si,out pi)) throw new Win32Exception(); } finally { Marshal.FreeHGlobal(environment); } CloseHandle(pi.hThread); CloseHandle(pi.hProcess); if(!String.IsNullOrEmpty(log)) CloseHandle(output); return pi.dwProcessId; }
}`;

function ps(command: string, stdio?: SpawnOptions["stdio"]): string {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true, ...(stdio ? { stdio } : {}) });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Windows detached-process probe failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function quoteWindowsArg(value: string): string {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/gu, "$1$1\\\"").replace(/(\\+)$/u, "$1$1")}"`;
}

const nativeWindowsLauncher: WindowsDetachedLauncher = {
  jobState() {
    const flags = Number(ps(`Add-Type -TypeDefinition @'\n${windowsScript}\n'@; [CotalDetachedProcess]::JobFlags()`));
    if (!Number.isInteger(flags)) throw new Error("Windows detached-process probe returned an invalid job limit value");
    return { inJob: (flags & 0x40000000) !== 0, breakawayAllowed: (flags & (0x800 | 0x1000)) !== 0 };
  },
  spawn(command, args, opts: DetachedSpawnOptions) {
    if (opts.stdio !== "ignore" && !opts.windowsLogPath) throw new Error("Windows detached spawn requires a durable log path");
    const state = this.jobState();
    const breakaway = assertWindowsDetachAllowed(state);
    const line = [command, ...args].map(quoteWindowsArg).join(" ");
    const environment = Object.entries(opts.env ?? process.env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
    const payload = Buffer.from(JSON.stringify({ command, line, cwd: opts.cwd ?? process.cwd(), breakaway, log: opts.windowsLogPath, environment }), "utf8").toString("base64");
    const source = `$x=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json; Add-Type -TypeDefinition @'\n${windowsScript}\n'@; [CotalDetachedProcess]::Spawn($x.command,$x.line,$x.cwd,$x.log,[string[]]$x.environment,$x.breakaway)`;
    const pid = Number(ps(source));
    return windowsDetachedChild(pid);
  },
};

export function spawnDetached(command: string, args: readonly string[], opts: DetachedSpawnOptions, windows: WindowsDetachedLauncher = nativeWindowsLauncher): ChildProcess {
  if (process.platform === "win32") return windows.spawn(command, args, opts);
  const child = spawn(command, [...args], { ...opts, detached: true, windowsHide: true });
  child.unref();
  return child;
}
