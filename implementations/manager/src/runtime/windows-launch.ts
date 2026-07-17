import { existsSync } from "node:fs";
import { extname } from "node:path";
import { buildCmdCommandLine, resolveComspec, resolveOnPath } from "@cotal-ai/workspace";

/**
 * Windows launch adapter for the PtyRuntime — imported ONLY by `pty.ts`. node-pty hands the command
 * to `CreateProcessW` directly (no shell). A real `.exe`/`.com` launches directly; a `.cmd`/`.bat`
 * shim is run THROUGH cmd.exe — node-pty-direct on a batch file is the CVE-2024-24576 class (node-pty
 * only does `CommandLineToArgvW` quoting, NOT cmd's metachar parser, so `& | < > ^` break out of /
 * inject into the implicit cmd re-parse), so wrapping is the secure, no-fallback mechanism, not polish.
 *
 * The cmd-quoting primitives (`quoteCmdArg` / `buildCmdCommandLine` / `resolveComspec`, the Rust
 * `append_bat_arg` port) now live in `@cotal-ai/workspace` so BOTH this launcher and the CLI's `npm`
 * invocation share the one tested contract; re-exported here for the manager's existing smoke.
 */
export { buildCmdCommandLine, quoteCmdArg, resolveComspec } from "@cotal-ai/workspace";

/** What the runtime hands node-pty: a resolved command plus either an argv array (POSIX, and a direct
 *  `.exe` launch — node-pty quotes it for `CommandLineToArgvW`) or a pre-escaped command-line STRING
 *  (the `.cmd`/`.bat` path — node-pty's documented "pre-escaped CommandLine" form, appended verbatim
 *  after the program, which is what lets us own every byte cmd.exe sees). */
export interface PreparedLaunch {
  command: string;
  args: string[] | string;
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
