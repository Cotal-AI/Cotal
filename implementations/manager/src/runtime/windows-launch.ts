import { extname, win32 } from "node:path";
import { resolveOnPath } from "@cotal-ai/workspace";

/**
 * Windows launch adapter for the PtyRuntime — imported ONLY by `pty.ts`. node-pty hands the command
 * to `CreateProcessW` directly (no shell), so it can launch a real `.exe`/`.com` but NOT a `.cmd`/
 * `.bat`: a batch shim must run THROUGH cmd.exe. This is the spawn fix #128 missed (it handed the
 * resolved `.cmd` straight to node-pty).
 *
 * The hard part is argument fidelity. A `.cmd` arg passes through TWO+ parsers — cmd.exe's `/c`
 * command-line parse, the shim's own `%*` re-expansion, then the target program's `CommandLineToArgvW`
 * — so naive quoting silently mutates or, worse, lets `& | < > ^` break out of the argument (the
 * CVE-2024-24576 class of bug). `quoteCmdArg` is a faithful port of Rust's std `append_bat_arg`
 * (the CVE fix), with one deliberate divergence: rather than neutralise `%VAR%` (Rust's `%%cd:~,%`
 * trick, brittle across the shim's double-parse) we REJECT an argument that cmd would expand, and
 * reject the handful of bytes (newline/NUL) that can't survive a cmd command line at all. Fail
 * closed, never silently launch a mutated value.
 *
 * Pure OS plumbing: no Cotal protocol types. `quoteCmdArg` / `buildCmdCommandLine` are exported so
 * the byte-for-byte contract is unit-testable off-Windows (they don't gate on `process.platform`).
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
 *  are absent from the process env. An arg containing `%NAME%` for one of these (or a real env var)
 *  would be expanded on the command line, so it cannot be preserved byte-for-byte. */
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

/** The cmd.exe to run a batch shim through: `%ComSpec%`, else the absolute
 *  `%SystemRoot%\System32\cmd.exe` (never a bare `cmd.exe` — that would re-enter PATH resolution).
 *  `win32.join` so the path is backslash-correct even when this is exercised off-Windows in tests. */
export function resolveComspec(env: NodeJS.ProcessEnv): string {
  const comspec = envGet(env, "ComSpec");
  if (comspec) return comspec;
  const sysRoot = envGet(env, "SystemRoot") ?? envGet(env, "windir") ?? "C:\\Windows";
  return win32.join(sysRoot, "System32", "cmd.exe");
}

/**
 * Escape one argument for a cmd.exe `/c` command line so the launched program receives it
 * byte-for-byte. Throws (fail closed) for an argument that cmd cannot preserve:
 *   - a newline (`\r`/`\n`) or NUL — cannot exist on a cmd command line (Rust rejects these too);
 *   - `%NAME%` where NAME is a defined env var or a cmd dynamic variable — cmd expands it pre-exec,
 *     even inside quotes. A lone `%` and an UNdefined `%NAME%` are left untouched by cmd and pass.
 */
export function quoteCmdArg(arg: string, env: NodeJS.ProcessEnv): string {
  if (/[\r\n\0]/.test(arg)) {
    throw new Error(
      `cannot pass argument through cmd.exe — contains a newline or NUL (unsupported on Windows): ${JSON.stringify(arg)}`,
    );
  }
  for (const m of arg.matchAll(/%([^%]+)%/g)) {
    const base = m[1].split(":")[0]; // %VAR:~s,l% / %VAR:a=b% substring/replace forms expand VAR too
    if (CMD_DYNAMIC_VARS.has(base.toUpperCase()) || envGet(env, base) !== undefined) {
      throw new Error(
        `cannot pass argument through cmd.exe — %${m[1]}% would be expanded (unsupported on Windows): ${JSON.stringify(arg)}`,
      );
    }
  }

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
 * appended verbatim by node-pty. Shape: `/d /s /c "<invocation>"` where `<invocation>` is
 * `"<script>" <arg>…`. The OUTER quote pair is stripped by cmd's `/s` rule (strip the first and last
 * quote of the post-`/c` string), revealing `"<script>" <args>` which cmd then runs. `/d` skips any
 * AutoRun command. Delayed expansion is assumed OFF (the Windows default) so `!x!` is literal.
 */
export function buildCmdCommandLine(
  scriptPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): string {
  if (scriptPath.includes('"')) {
    throw new Error(`cannot launch script with a quote in its path: ${JSON.stringify(scriptPath)}`);
  }
  const invocation = [`"${scriptPath}"`, ...args.map((a) => quoteCmdArg(a, env))].join(" ");
  return `/d /s /c "${invocation}"`;
}

/**
 * Resolve and adapt a launch for the PtyRuntime. POSIX is a passthrough (node-pty's own exec resolves
 * the bare name via PATH — no behavior change). On win32: resolve the EXACT file, then by kind —
 * `.exe`/`.com` launch directly (node-pty quotes argv for `CommandLineToArgvW`); `.cmd`/`.bat` run
 * through cmd.exe with the pre-escaped command line above.
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
    return { command: resolveComspec(env), args: buildCmdCommandLine(resolved, args, env) };
  }
  return { command: resolved, args: [...args] };
}
