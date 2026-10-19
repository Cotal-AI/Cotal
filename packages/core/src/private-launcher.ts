/** What a private launcher starts: the child's command line, its whole environment and the
 *  directory it runs in. */
export interface PrivateLauncherPayload {
  cwd: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * The source of the private Node launcher a runtime writes owner-only when its backend must not
 * see the agent's env on a command line or in its own records. The script removes its own
 * directory as soon as it has loaded, starts the child in `payload.cwd` with `payload.env` as its
 * whole environment, forwards SIGINT and SIGTERM to it, and exits with the child's code, or 128
 * when a signal ended the child. A command that cannot start writes `[<label>] <command>: <error>`
 * to stderr and exits 127. The runtime keeps its own temp-dir prefix and the command or argv its
 * backend runs the script with.
 */
export function privateLauncherSource(label: string, payload: PrivateLauncherPayload): string {
  return `import { spawn } from "node:child_process";\n` +
    `import { rmSync } from "node:fs";\n` +
    `const launch = ${JSON.stringify(payload)};\n` +
    `try { rmSync(new URL(".", import.meta.url), { recursive: true, force: true }); } catch {}\n` +
    `process.chdir(launch.cwd);\n` +
    `const child = spawn(launch.command, launch.args, { env: launch.env, stdio: "inherit", windowsHide: false });\n` +
    `let exiting = false;\n` +
    `const forward = (signal) => { if (!exiting && child.pid) child.kill(signal); };\n` +
    `process.on("SIGINT", () => forward("SIGINT"));\n` +
    `process.on("SIGTERM", () => forward("SIGTERM"));\n` +
    `child.on("error", (err) => { console.error(${JSON.stringify(`[${label}] `)} + launch.command + ": " + err.message); process.exit(127); });\n` +
    `child.on("exit", (code, signal) => { exiting = true; if (signal) process.exit(128); process.exit(code ?? 0); });\n`;
}
