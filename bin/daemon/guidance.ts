import { existsSync } from "node:fs";
import { codeSpan, CommandFailure, homeCotalDir, resolveOnPath, shellPath } from "@cotal-ai/workspace";

/** An unavailable systemd installation is different from an unreachable systemd user manager. */
export function daemonServiceRequirement(home?: string): CommandFailure | undefined {
  if (process.platform !== "linux" || (existsSync("/run/systemd/system") && resolveOnPath("systemctl"))) return undefined;
  return new CommandFailure("refused", "UNSUPPORTED", "The Linux background service requires systemd. This environment does not provide both a running systemd and systemctl on PATH.", {
    remedy: `Manage an existing systemd service from an environment with systemd and systemctl on PATH as the same user. If no daemon is installed or running, run ${codeSpan(daemonCommandCopy("serve", home))} under your own supervisor. Use \`cotal update --self\` for manual updates.`,
  });
}

export const NON_USER_AUTH_MESSAGE = "this space does not use user sign-in. The machine service hosts Managers only for user-auth participant spaces";
export const NON_USER_AUTH_REMEDY = "run `cotal up` in the folder that hosts the local space. Its stack runs the Manager";

export function foreignDaemonUpdateReport(entry: string): string {
  return `machine daemon: the background service belongs to another Cotal installation (${entry}). This update did not start or stop it.`;
}

/** A copyable command for this daemon. Tuples keep option values distinct from boolean flags;
 *  leading-hyphen values need `=` even when shell-quoted. Windows copy targets PowerShell. */
export function daemonCommandCopy(op: string, home?: string, args: readonly (string | readonly [string, string])[] = []): string {
  const quote = process.platform === "win32"
    ? (value: string) => /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replaceAll("'", "''")}'`
    : shellPath;
  const words: (string | readonly [string, string])[] = ["cotal", "daemon", op, ...args];
  if (home !== undefined && home !== homeCotalDir()) words.push(["--daemon-home", home]);
  return words.map(word => typeof word === "string" ? quote(word)
    : `${word[0]}${word[1].startsWith("-") ? "=" : " "}${quote(word[1])}`).join(" ");
}
