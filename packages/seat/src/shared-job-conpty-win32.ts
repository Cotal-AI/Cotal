import { randomUUID } from "node:crypto";
import { closeSync, realpathSync } from "node:fs";
import { Socket } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { checkWindowsCustodyPath, checkWindowsCustodyRoot } from "./shared-files-win32.js";
import { loadNativeHelper } from "./peercred.js";

type Launch = { handle: object; pid: number; start: string; input: number; output: number };
type Exit = { exitCode: number; active: number };
type Native = {
  seatPtyLaunch(dll: string, executable: string, commandLine: string, cwd: string, env: string, input: string, output: string, cols: number, rows: number): Launch;
  seatPtyResume(handle: object): void;
  seatPtyAbort(handle: object): void;
  seatPtyPoll(handle: object): Exit | undefined;
  seatPtyResize(handle: object, cols: number, rows: number): void;
  seatPtyDispose(handle: object): boolean;
  seatPtyStop(handle: object): void;
};

/** Open a verified retained ConPTY DLL and atomically launch the actual seat in a private job. */
export function launchWindowsJobConPty(options: {
  runtime: string; executable: string; args: readonly string[]; cwd: string;
  env: Readonly<Record<string, string | undefined>>; cols: number; rows: number;
}) {
  const { runtime, executable, args, cwd, env, cols, rows } = options;
  const arch = `win32-${process.arch}`;
  if (process.platform !== "win32" || (arch !== "win32-x64" && arch !== "win32-arm64")) throw new Error("Windows ConPTY custody is unavailable");
  if (!isAbsolute(executable) || !isAbsolute(cwd) || [executable, cwd, ...args].some(value => value.includes("\0")))
    throw new Error("invalid Windows seat launch path or argument");
  const dll = join(runtime, "node_modules", "@lydell", `node-pty-${arch}`, "prebuilds", arch, "conpty", "conpty.dll");
  checkWindowsCustodyRoot(dirname(dll));
  for (const path of [dll, join(dirname(dll), "OpenConsole.exe")]) {
    checkWindowsCustodyPath(path, false);
    if (realpathSync.native(path).toLowerCase() !== path.toLowerCase()) throw new Error("unknown retained ConPTY path");
  }
  const binding = loadNativeHelper<Native>();
  if (typeof binding.seatPtyLaunch !== "function" || typeof binding.seatPtyResume !== "function" || typeof binding.seatPtyPoll !== "function" || typeof binding.seatPtyAbort !== "function" ||
    typeof binding.seatPtyDispose !== "function" || typeof binding.seatPtyResize !== "function" || typeof binding.seatPtyStop !== "function")
    throw new Error("Windows ConPTY custody binding is unavailable");
  const nonce = `\\\\.\\pipe\\cotal-seat-io-${randomUUID()}`;
  const row = binding.seatPtyLaunch(dll, executable, [executable, ...args].map(quoteWindowsArgument).join(" "), cwd,
    environmentBlock(env), `${nonce}-in`, `${nonce}-out`, cols, rows);
  let input: Socket | undefined, output: Socket | undefined;
  try {
    input = new Socket({ fd: row.input, readable: false, writable: true });
    output = new Socket({ fd: row.output, readable: true, writable: false });
    // Do not let a terminal stream error become an uncaught host-wide error.
    input.on("error", () => {});
    output.on("error", () => {});
    binding.seatPtyResume(row.handle);
  } catch (error) {
    try { if (input) input.destroy(); else closeSync(row.input); }
    finally {
      try { if (output) output.destroy(); else closeSync(row.output); }
      finally { binding.seatPtyAbort(row.handle); }
    }
    throw error;
  }
  const terminal = { input, output };
  let disposed = false;
  return {
    pid: row.pid, start: row.start, ...terminal,
    resize: (width: number, height: number) => { if (!disposed) binding.seatPtyResize(row.handle, width, height); },
    poll: () => disposed ? undefined : binding.seatPtyPoll(row.handle),
    stop: () => { if (!disposed) binding.seatPtyStop(row.handle); },
    dispose: () => {
      if (disposed) return true;
      if (!binding.seatPtyDispose(row.handle)) return false;
      disposed = true;
      terminal.input.destroy();
      // Keep the output readable until the console peer sends EOF. Buffered final bytes belong to the seat.
      return true;
    },
  };
}

function quoteWindowsArgument(arg: string): string {
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, "$&$&")}"`;
}

function environmentBlock(env: Readonly<Record<string, string | undefined>>): string {
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!key || /[=\0]/.test(key) || value.includes("\0")) throw new Error("invalid Windows seat environment");
    const canonical = key.toUpperCase();
    if (entries.has(canonical)) throw new Error("duplicate Windows seat environment key");
    entries.set(canonical, `${key}=${value}`);
  }
  return `${[...entries.keys()].sort().map(key => entries.get(key)).join("\0")}\0\0`;
}
