import { existsSync } from "node:fs";
import { extname, win32 } from "node:path";
import { resolveOnPath } from "@cotal-ai/workspace";

/**
 * Windows launch adapter for the PtyRuntime — imported ONLY by `pty.ts`. node-pty hands the command
 * to `CreateProcessW` directly (no shell). A real `.exe`/`.com` launches directly; a `.cmd`/`.bat`
 * shim is run THROUGH cmd.exe — node-pty-direct on a batch file is the CVE-2024-24576 class (node-pty
 * only does `CommandLineToArgvW` quoting, NOT cmd's metachar parser, so `& | < > ^` break out of /
 * inject into the implicit cmd re-parse), so wrapping is the secure, no-fallback mechanism, not polish.
 *
 * The hard part is argument fidelity. A `.cmd` arg passes through TWO+ parsers — cmd.exe's `/c`
 * command-line parse, the shim's own `%*` re-expansion, then the target program's `CommandLineToArgvW`.
 * `quoteCmdArg` PORTS Rust std `append_bat_arg`'s quote/backslash rules (the CVE fix) but deliberately
 * DIVERGES on `%`: rather than neutralise every `%VAR%` (Rust's `%%cd:~,%` trick, brittle across the
 * shim's double-parse) it REJECTS, fail-closed, an argument cmd would expand (a defined/dynamic
 * `%VAR%`) plus the bytes that can't survive a cmd command line at all (newline/NUL) — never silently
 * launching a mutated value. The same expansion check guards the resolved script path, and the
 * interpreter is the system cmd.exe (never `spec.env`'s `%ComSpec%`).
 *
 * Pure OS plumbing: no Cotal protocol types. `quoteCmdArg` / `buildCmdCommandLine` / `resolveComspec`
 * are exported so the byte-for-byte contract is unit-testable off-Windows (they don't gate on
 * `process.platform`).
 */

/** What the runtime hands node-pty: a resolved command plus either an argv array (POSIX, and a direct
 *  `.exe` launch — node-pty quotes it for `CommandLineToArgvW`) or a pre-escaped command-line STRING
 *  (the `.cmd`/`.bat` path — node-pty's documented "pre-escaped CommandLine" form, appended verbatim
 *  after the program, which is what lets us own every byte cmd.exe sees). */
export interface PreparedLaunch {
  command: string;
  args: string[] | string;
}

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

/** Case-insensitive env lookup (see the copy in `bin-path.ts` for why `env` may be a plain object). */
function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) if (key.toLowerCase() === lower) return env[key];
  return undefined;
}

/** Throw (fail closed) if `s` carries a `%NAME%` cmd.exe would expand before exec — a defined env var
 *  or a cmd dynamic pseudo-variable — since there's no lossless escape. A lone `%` and an UNdefined
 *  `%NAME%` are left untouched by cmd and pass. Guards BOTH argv values and the resolved script path
 *  (anything embedded in the `/c` command line). */
function rejectCmdExpansion(s: string, env: NodeJS.ProcessEnv, what: string): void {
  for (const m of s.matchAll(/%([^%]+)%/g)) {
    const base = m[1].split(":")[0]; // %VAR:~s,l% / %VAR:a=b% substring/replace forms expand VAR too
    if (CMD_DYNAMIC_VARS.has(base.toUpperCase()) || envGet(env, base) !== undefined) {
      throw new Error(
        `cannot pass ${what} through cmd.exe — %${m[1]}% would be expanded (unsupported on Windows): ${JSON.stringify(s)}`,
      );
    }
  }
}

/** The cmd.exe that runs a batch shim — ALWAYS the system interpreter built from a TRUSTED env (the
 *  manager/operator env, default `process.env`), NEVER the child `spec.env`'s `%ComSpec%`. Always-wrap
 *  makes this the executable that runs every `.cmd`/`.bat`, so honoring a launch-env `%ComSpec%` would
 *  let a poisoned env turn a `.cmd` launch into an arbitrary-executable launch. The child's PATH still
 *  resolves the COMMAND (P3 isolation); the interpreter is a system invariant: absolute
 *  `%SystemRoot%\System32\cmd.exe` (`win32.join` so it's backslash-correct even in off-Windows tests). */
export function resolveComspec(operatorEnv: NodeJS.ProcessEnv = process.env): string {
  const sysRoot = envGet(operatorEnv, "SystemRoot") ?? envGet(operatorEnv, "windir") ?? "C:\\Windows";
  return win32.join(sysRoot, "System32", "cmd.exe");
}

/**
 * Escape one argument for a cmd.exe `/c` command line so the launched program receives it
 * byte-for-byte. PORTS Rust std `append_bat_arg`'s quote/backslash mechanics; throws (fail closed)
 * for an argument cmd cannot preserve: a newline (`\r`/`\n`) or NUL (can't exist on a cmd command
 * line — Rust rejects these too), or a `%NAME%` cmd would expand (see {@link rejectCmdExpansion} — a
 * deliberate divergence from Rust's `%%cd:~,%` neutralisation). A lone `%` / undefined `%NAME%` pass.
 */
export function quoteCmdArg(arg: string, env: NodeJS.ProcessEnv): string {
  if (/[\r\n\0]/.test(arg)) {
    throw new Error(
      `cannot pass argument through cmd.exe — contains a newline or NUL (unsupported on Windows): ${JSON.stringify(arg)}`,
    );
  }
  rejectCmdExpansion(arg, env, "argument");

  // Quote/escape per the cmd-batch rules (Rust std `append_bat_arg`, the CVE-2024-24576 fix). Wrap in
  // quotes when empty, space/tab-bearing, ending in a backslash, or carrying a non-(alnum|UNQUOTED)
  // ASCII byte or any control char. Double the backslash run before each `"` and before a quoted
  // close. Emit each embedded `"` as `""` so cmd's quote state stays balanced (so `& | < > ^ ( )`
  // stay quoted) AND `CommandLineToArgvW` decodes it back to a single `"`.
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
        out += "\\".repeat(backslashes); // double the pending run (each `\` was already emitted below)
        out += '"'; // the partner quote → `""` once the original `"` is appended
      }
      backslashes = 0;
    }
    out += ch;
  }
  if (quote) {
    out += "\\".repeat(backslashes); // double a trailing run so it can't escape the closing quote
    out += '"';
  }
  return out;
}

/**
 * The cmd.exe argument string that launches `scriptPath` (a `.cmd`/`.bat`) with `args`, ready to be
 * appended verbatim by node-pty. Shape: `/e:ON /v:OFF /d /s /c "<invocation>"` where `<invocation>`
 * is `"<script>" <arg>…`. The OUTER quote pair is stripped by cmd's `/s` rule (strip the first and
 * last quote of the post-`/c` string), revealing `"<script>" <args>` which cmd runs. `/v:OFF` makes
 * `!x!` LITERAL regardless of the ambient registry default (not merely assumed-off); `/e:ON` keeps
 * command extensions on so a real shim's `%~dp0` resolves; `/d` skips any AutoRun command. The script
 * path is fail-closed against cmd `%VAR%` expansion too — a resolved path with a defined `%VAR%`
 * segment would otherwise be expanded inside the quotes and launch a different file.
 */
export function buildCmdCommandLine(
  scriptPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): string {
  if (scriptPath.includes('"')) {
    throw new Error(`cannot launch script with a quote in its path: ${JSON.stringify(scriptPath)}`);
  }
  rejectCmdExpansion(scriptPath, env, "script path");
  const invocation = [`"${scriptPath}"`, ...args.map((a) => quoteCmdArg(a, env))].join(" ");
  return `/e:ON /v:OFF /d /s /c "${invocation}"`;
}

/**
 * Resolve and adapt a launch for the PtyRuntime. POSIX is a passthrough (node-pty's own exec resolves
 * the bare name via PATH — no behavior change). On win32: resolve the EXACT file, then by kind —
 * `.exe`/`.com` launch directly (node-pty quotes argv for `CommandLineToArgvW`); `.cmd`/`.bat` run
 * through the system cmd.exe with the pre-escaped command line above.
 */
export function preparePtyLaunch(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): PreparedLaunch {
  if (process.platform !== "win32") return { command, args: [...args] };

  const resolved = resolveOnPath(command, env);
  if (resolved === undefined) {
    throw new Error(`cannot launch "${command}": not found on PATH`);
  }
  const ext = extname(resolved).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    // Interpreter from the TRUSTED operator env (process.env); command/args quoted against the child
    // `spec.env` — so a poisoned spec.env can't reselect the interpreter (B1). Fail loud if the
    // system cmd.exe isn't actually on disk (no silent fallback).
    const comspec = resolveComspec();
    if (!existsSync(comspec)) {
      throw new Error(`cannot launch "${command}": system cmd.exe not found at ${comspec}`);
    }
    return { command: comspec, args: buildCmdCommandLine(resolved, args, env) };
  }
  return { command: resolved, args: [...args] };
}
