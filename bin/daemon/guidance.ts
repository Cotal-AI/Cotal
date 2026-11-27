import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalRoot, codeSpan, CommandFailure, homeCotalDir, resolveOnPath, shellPath, windowsShellWord } from "@cotal-ai/workspace";
import { nativeRun } from "./install-native-run.js";

/** An unavailable systemd installation is different from an unreachable systemd user manager. A default
 * install whose shell home the service cannot see is refused before either check writes anything. */
export function daemonServiceRequirement(home?: string): CommandFailure | undefined {
  if (home === undefined) {
    const mismatch = serviceHomeMismatch();
    if (mismatch) return mismatch;
  }
  if (process.platform !== "linux" || (existsSync("/run/systemd/system") && resolveOnPath("systemctl"))) return undefined;
  return new CommandFailure("refused", "UNSUPPORTED", "The Linux background service requires systemd. This environment does not provide both a running systemd and systemctl on PATH.", {
    remedy: `Manage an existing systemd service from an environment with systemd and systemctl on PATH as the same user. If no daemon is installed or running, run ${codeSpan(daemonCommandCopy("serve", home))} under your own supervisor. Use \`cotal update --self\` for manual updates.`,
  });
}

/** The Cotal directory the background service resolves with the account's own environment. The service
 * definition carries no shell home, so a shell `COTAL_HOME` or Windows `LOCALAPPDATA` never reaches it. */
function serviceAccountHome(): string {
  if (process.platform !== "win32") return join(homedir(), ".cotal");
  return join(accountProfilePath(), "AppData", "Local", "Cotal");
}

/** The signed-in account's profile directory, read from the account record rather than this shell. */
function accountProfilePath(): string {
  const system = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const out = nativeRun(join(system, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
  const sid = out.status === 0 ? out.stdout.trim().split(",").pop()?.replace(/^"|"$/g, "").trim() : undefined;
  if (!sid || !/^S-1-[0-9]+(?:-[0-9]+)+$/.test(sid)) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the account profile could not be read; nothing was registered");
  const listed = nativeRun(join(system, "System32", "reg.exe"), ["query", `HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\${sid}`, "/v", "ProfileImagePath"]);
  const profile = listed.status === 0 ? /REG_EXPAND_SZ\s+(\S.*)$/m.exec(listed.stdout)?.[1]?.trim() : undefined;
  if (!profile || !/^[A-Za-z]:\\/.test(profile)) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the account profile could not be read; nothing was registered");
  return profile;
}

/** Refuse a default install when this command and the service resolve different Cotal directories. */
function serviceHomeMismatch(): CommandFailure | undefined {
  const shellHome = homeCotalDir();
  const serviceHome = serviceAccountHome();
  if (canonicalRoot(resolve(shellHome)) === canonicalRoot(resolve(serviceHome))) return undefined;
  return new CommandFailure("refused", "CONFLICT", `this shell resolves the daemon home to ${shellHome}, but the background service resolves it to ${serviceHome}, so the service would not find this installation`, {
    remedy: "unset the home override, or install with --daemon-home <directory>. Nothing was registered.",
  });
}

export const NON_USER_AUTH_MESSAGE = "this space does not use user sign-in. The machine service hosts Managers only for user-auth participant spaces";
export const NON_USER_AUTH_REMEDY = "run `cotal up` in the folder that hosts the local space. Its stack runs the Manager";

export function foreignDaemonUpdateReport(entry: string): string {
  return `machine daemon: the background service belongs to another Cotal installation (${entry}). This update did not start or stop it.`;
}

export const windowsDaemonHomeAccess = "its owner must be you, SYSTEM or Administrators, and its Windows ACL may grant access only to those accounts";

/** Name PowerShell when its quoting is needed to copy the daemon home unchanged. */
export function windowsDaemonRemedy(op: "install" | "serve" | "start", home?: string): string {
  const shell = home !== undefined && home !== homeCotalDir() && windowsShellWord(home) === undefined ? " in PowerShell" : "";
  return `${codeSpan(daemonCommandCopy(op, home))}${shell}`;
}

export function windowsDaemonFirstStart(home?: string): string {
  return `install a scheduled task with ${windowsDaemonRemedy("install", home)}, or run the daemon in the foreground with ${windowsDaemonRemedy("serve", home)}`;
}

/** A copyable command for this daemon. Tuples keep option values distinct from boolean flags;
 *  leading-hyphen values need `=` even when shell-quoted. */
export function daemonCommandCopy(op: string, home?: string, args: readonly (string | readonly [string, string])[] = []): string {
  const quote = process.platform === "win32"
    ? (value: string) => windowsShellWord(value) ?? `'${value.replaceAll("'", "''")}'`
    : shellPath;
  const words: (string | readonly [string, string])[] = ["cotal", "daemon", op, ...args];
  if (home !== undefined && home !== homeCotalDir()) words.push(["--daemon-home", home]);
  return words.map(word => typeof word === "string" ? quote(word)
    : `${word[0]}${word[1].startsWith("-") ? "=" : " "}${quote(word[1])}`).join(" ");
}
