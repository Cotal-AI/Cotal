import { existsSync } from "node:fs";
import { extname, win32 } from "node:path";
import { resolveOnPath } from "./bin-path.js";

/**
 * Windows `.cmd`/`.bat` spawn adapter — pure OS plumbing, no Cotal protocol types. Node refuses to
 * spawn a `.cmd`/`.bat` without a shell (CVE-2024-27980), and a naive `shell: true` re-parses the
 * command line through cmd.exe's metachar grammar (`& | < > ^ …`), so a batch shim must be run THROUGH
 * cmd.exe with a byte-for-byte pre-escaped command line. `quoteCmdArg` PORTS Rust std `append_bat_arg`
 * (the CVE fix). Used by the manager's PtyRuntime launch AND the CLI's `npm` invocation (`npm` is
 * `npm.cmd` on Windows), so the seeding + `cotal ext add` paths spawn npm correctly on Windows.
 *
 * The three primitives are exported so their byte-for-byte contract is unit-testable off-Windows (they
 * do not gate on `process.platform`); {@link cmdSpawnSpec} is the `spawnSync`-shaped high-level adapter.
 */

/** cmd.exe dynamic pseudo-variables — always "defined" with command extensions on, even though they
 *  are absent from the process env. A `%NAME%` for one of these (or a real env var) would be expanded
 *  on the command line, so it cannot be preserved byte-for-byte. */
const CMD_DYNAMIC_VARS = new Set([
  "CD",
  "DATE",
  "TIME",
  "RANDOM",
  "ERRORLEVEL",
  "CMDEXTVERSION",
  "CMDCMDLINE",
  "HIGHESTNUMANODENUMBER",
]);

/** Case-insensitive env lookup (Windows env is case-insensitive; a plain object may hold either case). */
function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) if (key.toLowerCase() === lower) return env[key];
  return undefined;
}

/** Throw (fail closed) if `s` carries a `%NAME%` cmd.exe would expand before exec — a defined env var
 *  or a cmd dynamic pseudo-variable — since there's no lossless escape. A lone `%` and an UNdefined
 *  `%NAME%` are left untouched by cmd and pass. Guards BOTH argv values and the resolved script path. */
function rejectCmdExpansion(s: string, env: NodeJS.ProcessEnv, what: string): void {
  for (const m of s.matchAll(/%([^%]+)%/g)) {
    const base = m[1].split(":")[0]; // %VAR:~s,l% / %VAR:a=b% substring/replace forms expand VAR too
    if (CMD_DYNAMIC_VARS.has(base.toUpperCase()) || envGet(env, base) !== undefined) {
      throw new Error(
        `cannot pass ${what} through cmd.exe - %${m[1]}% would be expanded (unsupported on Windows): ${JSON.stringify(s)}`,
      );
    }
  }
}

/** The cmd.exe that runs a batch shim — ALWAYS the system interpreter built from a TRUSTED env, NEVER
 *  a child env's `%ComSpec%`: absolute `%SystemRoot%\System32\cmd.exe` (`win32.join` so it's
 *  backslash-correct even in off-Windows tests). */
export function resolveComspec(operatorEnv: NodeJS.ProcessEnv = process.env): string {
  const sysRoot = envGet(operatorEnv, "SystemRoot") ?? envGet(operatorEnv, "windir") ?? "C:\\Windows";
  return win32.join(sysRoot, "System32", "cmd.exe");
}

/**
 * Escape one argument for a cmd.exe `/c` command line so the launched program receives it
 * byte-for-byte. PORTS Rust std `append_bat_arg`'s quote/backslash mechanics; throws (fail closed) for
 * an argument cmd cannot preserve: a newline (`\r`/`\n`) or NUL, or a `%NAME%` cmd would expand. A lone
 * `%` / undefined `%NAME%` pass.
 */
export function quoteCmdArg(arg: string, env: NodeJS.ProcessEnv): string {
  if (/[\r\n\0]/.test(arg)) {
    throw new Error(
      `cannot pass argument through cmd.exe - contains a newline or NUL (unsupported on Windows): ${JSON.stringify(arg)}`,
    );
  }
  rejectCmdExpansion(arg, env, "argument");

  const UNQUOTED = "#$*+-./:?@\\_";
  let quote = arg.length === 0 || arg.endsWith("\\");
  for (const ch of arg) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) quote = true;
    else if (code < 0x80 && !(/[A-Za-z0-9]/.test(ch) || UNQUOTED.includes(ch))) quote = true;
  }

  let out = quote ? '"' : "";
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes++;
    } else {
      if (ch === '"') {
        out += "\\".repeat(backslashes);
        out += '"';
      }
      backslashes = 0;
    }
    out += ch;
  }
  if (quote) {
    out += "\\".repeat(backslashes);
    out += '"';
  }
  return out;
}

/**
 * The cmd.exe argument string that launches `scriptPath` (a `.cmd`/`.bat`) with `args`. Shape:
 * `/e:ON /v:OFF /d /s /c "<invocation>"` where `<invocation>` is `"<script>" <arg>…`. `/v:OFF` makes
 * `!x!` LITERAL; `/e:ON` keeps command extensions on so a shim's `%~dp0` resolves; `/d` skips AutoRun.
 * The script path is fail-closed against cmd `%VAR%` expansion too.
 */
export function buildCmdCommandLine(scriptPath: string, args: readonly string[], env: NodeJS.ProcessEnv): string {
  if (scriptPath.includes('"')) {
    throw new Error(`cannot launch script with a quote in its path: ${JSON.stringify(scriptPath)}`);
  }
  rejectCmdExpansion(scriptPath, env, "script path");
  const invocation = [`"${scriptPath}"`, ...args.map((a) => quoteCmdArg(a, env))].join(" ");
  return `/e:ON /v:OFF /d /s /c "${invocation}"`;
}

/** A `spawnSync`-shaped launch spec. On non-win32 (or a real `.exe`) it is a passthrough; a `.cmd`/
 *  `.bat` resolves to the system cmd.exe with a pre-escaped verbatim command line. */
export interface CmdSpawnSpec {
  readonly file: string;
  readonly args: string[];
  /** Pass to `spawnSync`/`spawn` opts so Node appends the pre-escaped command line verbatim. */
  readonly windowsVerbatimArguments: boolean;
}

/**
 * Resolve how to `spawnSync` `command` (a bare name like `npm`) with `args` on the current platform.
 * POSIX: passthrough. Windows: resolve the exact file on PATH; a `.cmd`/`.bat` runs THROUGH the system
 * cmd.exe with a byte-for-byte command line (so `spawnSync("npm.cmd", …)` no longer trips the
 * `.cmd`-without-shell refusal, and args survive cmd's metachar parse). Fails loud if not on PATH or
 * cmd.exe is missing — no silent fallback.
 */
export function cmdSpawnSpec(command: string, args: readonly string[], operatorEnv: NodeJS.ProcessEnv = process.env): CmdSpawnSpec {
  if (process.platform !== "win32") return { file: command, args: [...args], windowsVerbatimArguments: false };
  const resolved = resolveOnPath(command, operatorEnv);
  if (resolved === undefined) throw new Error(`cannot run "${command}": not found on PATH`);
  const ext = extname(resolved).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    const comspec = resolveComspec(operatorEnv);
    if (!existsSync(comspec)) throw new Error(`cannot run "${command}": system cmd.exe not found at ${comspec}`);
    return { file: comspec, args: [buildCmdCommandLine(resolved, args, operatorEnv)], windowsVerbatimArguments: true };
  }
  return { file: resolved, args: [...args], windowsVerbatimArguments: false };
}
