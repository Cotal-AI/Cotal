import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalRoot, codeSpan, CommandFailure, homeCotalDir, resolveOnPath, shellPath, windowsShellWord } from "@cotal-ai/workspace";
import { nativeRun } from "./install-native-run.js";

/** An unavailable systemd installation is different from an unreachable systemd user manager. */
export function daemonServiceRequirement(home?: string): CommandFailure | undefined {
  if (process.platform !== "linux" || (existsSync("/run/systemd/system") && resolveOnPath("systemctl"))) return undefined;
  return new CommandFailure("refused", "UNSUPPORTED", "The Linux background service requires systemd. This environment does not provide both a running systemd and systemctl on PATH.", {
    remedy: `Manage an existing systemd service from an environment with systemd and systemctl on PATH as the same user. If no daemon is installed or running, run ${codeSpan(daemonCommandCopy("serve", home))} under your own supervisor. Use \`cotal update --self\` for manual updates.`,
  });
}

/** A default install whose shell home the service will not resolve. An unreadable service
 *  environment is left to the install's own refusal. */
export function serviceHomeMismatch(): CommandFailure | undefined {
  if (!process.env.COTAL_HOME && !(process.platform === "win32" && process.env.LOCALAPPDATA)) return undefined;
  const serviceHome = serviceResolvedHome();
  if (serviceHome === undefined) return undefined;
  const shellHome = homeCotalDir();
  if (sameDirectory(shellHome, serviceHome)) return undefined;
  return new CommandFailure("refused", "CONFLICT", `this shell resolves the daemon home to ${shellHome}, but the background service resolves it to ${serviceHome}. Nothing was registered.`, {
    remedy: serviceHomeRemedy(),
  });
}

/** The Cotal directory a default service resolves from the environment it will actually start with. */
function serviceResolvedHome(): string | undefined {
  if (process.platform === "linux") return linuxServiceHome();
  if (process.platform === "win32") return windowsServiceHome();
  return undefined;
}

/** HOME, `COTAL_HOME` and `XDG_CONFIG_HOME` of the systemd user manager. A manager that cannot be
 *  read returns undefined, so the existing systemd refusal stays the one the command reports. */
function linuxServiceHome(): string | undefined {
  const systemctl = resolveOnPath("systemctl");
  if (!systemctl) return undefined;
  const out = nativeRun(systemctl, ["--user", "show-environment"], undefined, 2_000);
  if (out.status !== 0) return undefined;
  const values = new Map<string, string>();
  for (const line of out.stdout.split("\n")) {
    if (!line) continue;
    const index = line.indexOf("=");
    if (index < 1) return undefined;
    const name = line.slice(0, index);
    if (name !== "HOME" && name !== "COTAL_HOME" && name !== "XDG_CONFIG_HOME") continue;
    if (values.has(name)) return undefined;
    values.set(name, decodeSystemdValue(line.slice(index + 1)));
  }
  const home = values.get("HOME");
  const override = values.get("COTAL_HOME");
  if (override !== undefined) return absoluteServicePath(override) ? override : undefined;
  if (!home || !absoluteServicePath(home)) return undefined;
  return join(home, ".cotal");
}

/** The account profile's local app data, which is the environment Task Scheduler starts with.
 *  A profile that cannot be read returns undefined rather than a second refusal. */
function windowsServiceHome(): string | undefined {
  const system = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const out = nativeRun(join(system, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"], undefined, 2_000);
  const sid = out.status === 0 ? out.stdout.trim().split(",").pop()?.replace(/^"|"$/g, "").trim() : undefined;
  if (!sid || !/^S-1-[0-9]+(?:-[0-9]+)+$/.test(sid)) return undefined;
  const listed = nativeRun(join(system, "System32", "reg.exe"), ["query", `HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\${sid}`, "/v", "ProfileImagePath"], undefined, 2_000);
  const recorded = listed.status === 0 ? /REG_(?:EXPAND_)?SZ\s+(\S.*)$/m.exec(listed.stdout)?.[1]?.trim() : undefined;
  const drive = process.env.SystemDrive && /^[A-Za-z]:$/.test(process.env.SystemDrive) ? process.env.SystemDrive : "C:";
  const expanded = recorded?.replace(/^%SystemDrive%/i, drive);
  const profileDrive = /^[A-Za-z]:/.exec(expanded ?? "")?.[0] ?? drive;
  const account: { drive: string; local?: string } = { drive: profileDrive };
  const profile = expanded ? expandWindowsPath(expanded, account) : undefined;
  if (!profile || !/^[A-Za-z]:\\/.test(profile)) return undefined;
  const local = join(profile, "AppData", "Local");
  account.local = local;
  const override = readUserEnvironment("COTAL_HOME", account);
  if (override !== undefined) return absoluteServicePath(override) ? override : undefined;
  const localAppData = readUserEnvironment("LOCALAPPDATA", account);
  return join(localAppData && absoluteServicePath(localAppData) ? localAppData : local, "Cotal");
}

/** One value from the account environment Task Scheduler starts with, not this shell. */
function readUserEnvironment(name: string, account: { drive: string; local?: string }): string | undefined {
  const system = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const listed = nativeRun(join(system, "System32", "reg.exe"), ["query", "HKCU\\Environment", "/v", name], undefined, 2_000);
  if (listed.status !== 0) return undefined;
  const value = /REG_(?:EXPAND_)?SZ\s+(\S.*)$/m.exec(listed.stdout)?.[1]?.trim();
  return value ? expandWindowsPath(value, account) : undefined;
}

/** Expand the account variables a profile path may contain. The profile supplies the drive and
 *  the account environment supplies the rest, so a shell override cannot rewrite the record. */
function expandWindowsPath(value: string, account: { drive: string; local?: string }): string {
  return value.replace(/%(SystemDrive|SystemRoot|USERPROFILE|LOCALAPPDATA|HOMEDRIVE|HOMEPATH)%/gi, (token, name: string) => {
    const key = name.toUpperCase();
    if (key === "SYSTEMDRIVE" || key === "HOMEDRIVE") return account.drive;
    if (key === "SYSTEMROOT") return `${account.drive}\\Windows`;
    if (key === "USERPROFILE" || key === "HOMEPATH") return "";
    return account.local ?? "";
  });
}

/** Decode systemctl's POSIX shell quoting. A value it cannot decode is not a home. */
function decodeSystemdValue(value: string): string {
  if (!value.startsWith("$'")) return value;
  if (!value.endsWith("'")) return "";
  const escapes: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"' };
  const bytes: Buffer[] = [];
  const body = value.slice(2, -1);
  for (let i = 0; i < body.length;) {
    if (body[i] !== "\\") {
      const end = body.indexOf("\\", i);
      const text = body.slice(i, end < 0 ? undefined : end);
      bytes.push(Buffer.from(text));
      i += text.length;
      continue;
    }
    const escaped = body[++i];
    if (escaped !== undefined && Object.hasOwn(escapes, escaped)) { bytes.push(Buffer.from(escapes[escaped]!)); i++; }
    else {
      const octal = body.slice(i, i + 3);
      if (!/^[0-3][0-7]{2}$/.test(octal)) return "";
      bytes.push(Buffer.from([Number.parseInt(octal, 8)]));
      i += 3;
    }
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(bytes)); }
  catch { return ""; }
}

function absoluteServicePath(value: string): boolean {
  return isAbsolute(value) && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function sameDirectory(left: string, right: string): boolean {
  try { return canonicalRoot(resolve(left)) === canonicalRoot(resolve(right)); }
  catch { return resolve(left) === resolve(right); }
}

/** A remedy the person can run and that then installs. A shell override the service environment does
 *  not hold is unset in the shell. An account override needs the same value there, so the named
 *  route is an explicit daemon home. */
function serviceHomeRemedy(): string {
  if (process.env.COTAL_HOME && !serviceEnvironmentHolds("COTAL_HOME")) return "unset COTAL_HOME, or pass --daemon-home <directory>";
  if (process.platform === "win32" && process.env.LOCALAPPDATA && !process.env.COTAL_HOME && !serviceEnvironmentHolds("LOCALAPPDATA")) return "unset LOCALAPPDATA, or pass --daemon-home <directory>";
  return "pass --daemon-home <directory>";
}

/** Whether the environment the service starts with names this variable. An unreadable environment
 *  is not treated as holding it. */
function serviceEnvironmentHolds(name: string): boolean {
  if (process.platform === "linux") {
    const systemctl = resolveOnPath("systemctl");
    if (!systemctl) return false;
    const out = nativeRun(systemctl, ["--user", "show-environment"], undefined, 2_000);
    return out.status === 0 && out.stdout.split("\n").some((line) => line.startsWith(`${name}=`) && line.slice(name.length + 1) !== "");
  }
  if (process.platform !== "win32") return false;
  const system = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const listed = nativeRun(join(system, "System32", "reg.exe"), ["query", "HKCU\\Environment", "/v", name], undefined, 2_000);
  return listed.status === 0 && /REG_(?:EXPAND_)?SZ\s+\S/.test(listed.stdout);
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
