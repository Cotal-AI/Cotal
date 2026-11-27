import { randomUUID } from "node:crypto";
import { closeSync, realpathSync, statSync } from "node:fs";
import { Socket } from "node:net";
import { dirname, join, win32 } from "node:path";
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

type LaunchOptions = {
  runtime: string; executable: string; args: readonly string[]; cwd: string;
  env: Readonly<Record<string, string | undefined>>; cols: number; rows: number;
};

export const WINDOWS_SEAT_LAUNCH_UNKNOWN = "COTAL_WINDOWS_SEAT_LAUNCH_UNKNOWN";

/** Compatibility path for callers that do not publish a staged custody record. */
export function launchWindowsJobConPty(options: LaunchOptions) {
  const { resume, abort, ...terminal } = prepareWindowsJobConPty(options);
  try { resume(); }
  catch (error) { abort(); throw error; }
  return terminal;
}

/** Adopt the streams while the real command is still suspended in its private job. */
export function prepareWindowsJobConPty(options: LaunchOptions) {
  const { runtime, executable, args, cwd, env, cols, rows } = options;
  const arch = `win32-${process.arch}`;
  if (process.platform !== "win32" || (arch !== "win32-x64" && arch !== "win32-arm64")) throw new Error("Windows ConPTY custody is unavailable");
  const launch = windowsSeatCommandLine(executable, args, cwd, env);
  const environment = windowsSeatEnvironmentBlock(env);
  if (!statSync(launch.executable).isFile() || (launch.executable !== executable && !statSync(executable).isFile()))
    throw new Error("Windows seat launch target is not a file");
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
  const row = binding.seatPtyLaunch(dll, launch.executable, launch.commandLine, cwd,
    environment, `${nonce}-in`, `${nonce}-out`, cols, rows);
  let input: Socket | undefined, output: Socket | undefined;
  try {
    input = new Socket({ fd: row.input, readable: false, writable: true });
    output = new Socket({ fd: row.output, readable: true, writable: false });
    // Do not let a terminal stream error become an uncaught host-wide error.
    input.on("error", () => {});
    output.on("error", () => {});
  } catch (error) {
    try {
      try { if (input) input.destroy(); else closeSync(row.input); }
      finally { if (output) output.destroy(); else closeSync(row.output); }
    } finally { abortSuspended(binding, row.handle); }
    throw error;
  }
  const terminal = { input, output };
  let disposed = false;
  let resumed = false;
  return {
    pid: row.pid, start: row.start, ...terminal,
    resume: () => {
      if (disposed || resumed) throw new Error("Windows seat is not suspended");
      binding.seatPtyResume(row.handle);
      resumed = true;
    },
    abort: () => {
      if (disposed) return;
      if (resumed) throw new Error("Windows seat is no longer suspended");
      terminal.input.destroy();
      terminal.output.destroy();
      abortSuspended(binding, row.handle);
      disposed = true;
    },
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

function abortSuspended(binding: Native, handle: object): void {
  try { binding.seatPtyAbort(handle); }
  catch (cause) {
    throw Object.assign(new Error("suspended Windows seat rollback was not confirmed", { cause }), {
      code: WINDOWS_SEAT_LAUNCH_UNKNOWN,
    });
  }
}

function quoteWindowsArgument(arg: string): string {
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, "$&$&")}"`;
}

// Reject drive-relative/root-relative and device paths, none of which identify an ordinary file
// independently of the executing process. Extended UNC and drive paths still work for native exes.
function absoluteWindowsPath(path: string): boolean {
  const volume = /^(?:[a-z]:[\\/]|\\\\\?\\(?:[a-z]:\\|UNC\\[^:\\]+\\[^:\\]+(?:\\|$))|\\\\[^?.:\\][^:\\]*\\[^:\\]+(?:\\|$))/i.exec(path);
  return !!volume && !/[\x00-\x1f"]/.test(path) && !path.slice(volume[0].length).includes(":");
}

/** Only structured target + argv enters here. Never accept a caller-supplied raw /c string. */
export function windowsSeatCommandLine(executable: string, args: readonly string[], cwd: string,
  env: Readonly<Record<string, string | undefined>> = {},
  systemRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows") {
  if (!absoluteWindowsPath(executable) || !absoluteWindowsPath(cwd) || args.some(arg => typeof arg !== "string" || arg.includes("\0")))
    throw new Error("invalid Windows seat launch path or argument");
  const ext = win32.extname(executable).toLowerCase();
  if (ext === ".exe" || ext === ".com")
    return { executable, commandLine: [executable, ...args].map(quoteWindowsArgument).join(" ") };
  if (ext !== ".bat" && ext !== ".cmd") throw new Error("unsupported Windows seat executable extension");
  // cmd silently changes a UNC cwd. Restrict batch paths to ordinary absolute drive paths.
  const drivePath = /^[a-z]:\\/i;
  if (![executable, cwd, systemRoot].every(path => drivePath.test(path) && absoluteWindowsPath(path)))
    throw new Error("Windows batch seats require absolute drive paths");
  const interpreter = win32.join(systemRoot, "System32", "cmd.exe");
  // /s removes the outer pair, /d disables AutoRun and /v:OFF keeps ! literal. The script itself
  // must still use its arguments safely. Neither the wire nor the env can supply cmd switches.
  const invocation = [`"${executable}"`, ...args.map(quoteWindowsBatchArgument)].join(" ");
  const defined = windowsEnvironmentEntries(env);
  // Inspect the assembled invocation too: an env name can contain spaces or quotes, so checking
  // each argv slot alone would miss a %...% reference spanning two slots.
  for (const text of [executable, ...args, invocation]) {
    for (const match of text.matchAll(/%(?=([^%]+)%)/g)) {
      const name = match[1].split(":")[0].toUpperCase();
      if (CMD_IMPLICIT_ENV.has(name) || defined.has(name)) throw new Error("Windows batch seat argument would expand in cmd.exe");
    }
  }
  const commandLine = `${quoteWindowsArgument(interpreter)} /e:ON /v:OFF /d /s /c "${invocation}"`;
  if (commandLine.length >= 8191) throw new Error("Windows batch seat command line is too long");
  return { executable: interpreter, commandLine };
}

const CMD_IMPLICIT_ENV = new Set(["CD", "DATE", "TIME", "RANDOM", "ERRORLEVEL", "CMDEXTVERSION", "CMDCMDLINE",
  "HIGHESTNUMANODENUMBER", "COMSPEC", "PATHEXT", "PROMPT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR"]);

/** Mirrors workspace/win-cmd.ts's Rust append_bat_arg port. This package is standalone. */
function quoteWindowsBatchArgument(arg: string): string {
  if (/[\r\n\0]/.test(arg)) throw new Error("Windows batch seat argument contains a newline or NUL");
  const unquoted = "#$*+-./:?@\\_";
  let quote = !arg || arg.endsWith("\\");
  for (const ch of arg) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) ||
        (code < 0x80 && !(/[A-Za-z0-9]/.test(ch) || unquoted.includes(ch)))) quote = true;
  }
  if (!quote) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1""').replace(/\\+$/, "$&$&")}"`;
}

function windowsEnvironmentEntries(env: Readonly<Record<string, string | undefined>>) {
  const entries = new Map<string, { key: string; value: string }>();
  // Node's documented Windows child env rule: the lexicographically first defined alias wins.
  // In particular an explicit PATH override wins over inherited Path, independent of key order.
  for (const key of Object.keys(env).sort()) {
    const value = env[key];
    if (value === undefined) continue;
    if (!key || /[=\0]/.test(key) || typeof value !== "string" || value.includes("\0")) throw new Error("invalid Windows seat environment");
    const canonical = key.toUpperCase();
    if (!entries.has(canonical)) entries.set(canonical, { key, value });
  }
  return entries;
}

export function windowsSeatEnvironmentBlock(env: Readonly<Record<string, string | undefined>>): string {
  const entries = windowsEnvironmentEntries(env);
  return `${[...entries.keys()].sort().map(canonical => {
    const { key, value } = entries.get(canonical)!;
    return `${key}=${value}`;
  }).join("\0")}\0\0`;
}
