import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalRoot, codeSpan, CommandFailure, homeCotalDir, resolveOnPath, shellPath, windowsShellWord } from "@cotal-ai/workspace";
import { nativeRun } from "./install-native-run.js";
import type { NativeResult } from "./install.js";

/** An unavailable systemd installation is different from an unreachable systemd user manager. */
export function daemonServiceRequirement(home?: string): CommandFailure | undefined {
  if (process.platform !== "linux" || (existsSync("/run/systemd/system") && resolveOnPath("systemctl"))) return undefined;
  return new CommandFailure("refused", "UNSUPPORTED", "The Linux background service requires systemd. This environment does not provide both a running systemd and systemctl on PATH.", {
    remedy: `Manage an existing systemd service from an environment with systemd and systemctl on PATH as the same user. If no daemon is installed or running, run ${codeSpan(daemonCommandCopy("serve", home))} under your own supervisor. Use \`cotal update --self\` for manual updates.`,
  });
}

/** A default install whose shell home the service will not resolve. An unreadable or uncertain
 *  service environment changes nothing: the install keeps the refusal it already had. */
export function serviceHomeMismatch(env: NodeJS.ProcessEnv = process.env): CommandFailure | undefined {
  if (process.platform !== "linux" && process.platform !== "win32") return undefined;
  if (!env.COTAL_HOME && !(process.platform === "win32" && env.LOCALAPPDATA)) return undefined;
  const environment = readServiceEnvironment(env);
  if (environment === undefined) return undefined;
  const serviceHome = serviceResolvedHome(environment);
  if (serviceHome === undefined) return undefined;
  const shellHome = homeCotalDir();
  if (sameDirectory(shellHome, serviceHome)) return undefined;
  return new CommandFailure("refused", "CONFLICT", `this shell resolves the daemon home to ${shellHome}, but the background service resolves it to ${serviceHome}. Nothing was registered.`, {
    remedy: serviceHomeRemedy(environment),
  });
}

/** The environment a default service starts with, read once. Undefined means the read failed or a
 *  value could not be resolved with certainty, so this check adds no refusal. */
function readServiceEnvironment(env: NodeJS.ProcessEnv): Map<string, string> | undefined {
  try {
    if (process.platform === "linux") return linuxServiceEnvironment(env);
    if (process.platform === "win32") return windowsServiceEnvironment(env);
  } catch (error) {
    if (error instanceof CommandFailure) return undefined;
    throw error;
  }
  return undefined;
}

/** HOME, `COTAL_HOME` and `XDG_CONFIG_HOME` of the systemd user manager. */
function linuxServiceEnvironment(env: NodeJS.ProcessEnv): Map<string, string> | undefined {
  const systemctl = resolveOnPath("systemctl", env);
  if (!systemctl) return undefined;
  const out = serviceRead(systemctl, ["--user", "show-environment"], env);
  if (out === undefined || out.status !== 0) return undefined;
  const values = new Map<string, string>();
  for (const line of out.stdout.split("\n")) {
    if (!line) continue;
    const index = line.indexOf("=");
    if (index < 1) return undefined;
    const name = line.slice(0, index);
    if (name !== "HOME" && name !== "COTAL_HOME" && name !== "XDG_CONFIG_HOME") continue;
    if (values.has(name)) return undefined;
    const decoded = systemdDirectoryValue(line.slice(index + 1));
    if (decoded === undefined) return undefined;
    values.set(name, decoded);
  }
  return values;
}

/** The account profile and the account environment Task Scheduler starts with. Only `%SystemDrive%`
 *  in the profile path is expanded here. Any other expandable value is uncertain. */
function windowsServiceEnvironment(env: NodeJS.ProcessEnv): Map<string, string> | undefined {
  const system = windowsSystemRoot(env);
  const identity = serviceRead(join(system, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"], env);
  const sid = identity?.status === 0 ? identity.stdout.trim().split(",").pop()?.replace(/^"|"$/g, "").trim() : undefined;
  if (!sid || !/^S-1-[0-9]+(?:-[0-9]+)+$/.test(sid)) return undefined;
  const profile = windowsProfile(system, sid, env);
  if (profile === undefined) return undefined;
  const values = new Map<string, string>([["USERPROFILE", profile]]);
  const listed = serviceRead(join(system, "System32", "reg.exe"), ["query", "HKCU\\Environment"], env);
  if (listed === undefined) return undefined;
  if (listed.status === 0) {
    for (const match of listed.stdout.matchAll(/^\s{4}(\S+)\s{4}REG_(?:EXPAND_)?SZ\s{4}(\S.*)$/gm)) {
      const name = match[1]!;
      if (name !== "COTAL_HOME" && name !== "LOCALAPPDATA") continue;
      if (values.has(name)) return undefined;
      values.set(name, match[2]!.trim());
    }
  } else if (!/ERROR:\s+The system was unable to find the specified registry key or value/i.test(listed.detail)) return undefined;
  return windowsValuesResolved(values) ? values : undefined;
}

/** ProfileImagePath with only its `%SystemDrive%` prefix expanded. Anything else is uncertain. */
function windowsProfile(system: string, sid: string, env: NodeJS.ProcessEnv): string | undefined {
  const listed = serviceRead(join(system, "System32", "reg.exe"), ["query", `HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\${sid}`, "/v", "ProfileImagePath"], env);
  if (listed === undefined || listed.status !== 0) return undefined;
  const recorded = /^\s{4}ProfileImagePath\s{4}REG_(?:EXPAND_)?SZ\s{4}(\S.*)$/m.exec(listed.stdout)?.[1]?.trim();
  if (!recorded) return undefined;
  if (!recorded.includes("%")) return /^[A-Za-z]:\\/.test(recorded) ? recorded : undefined;
  const drive = env.SystemDrive && /^[A-Za-z]:$/.test(env.SystemDrive) ? env.SystemDrive : "C:";
  const expanded = recorded.replace(/^%SystemDrive%/i, drive);
  return expanded.includes("%") || !/^[A-Za-z]:\\/.test(expanded) ? undefined : expanded;
}

/** Account values Windows expands before creating the service process. A value that still names a
 *  variable, or that would expand to a rootless path, cannot be resolved with certainty. */
function windowsValuesResolved(values: Map<string, string>): boolean {
  const profile = values.get("USERPROFILE");
  if (!profile) return false;
  const variables = new Map<string, string>([
    ["USERPROFILE", profile],
    ["HOMEDRIVE", profile.slice(0, 2)],
    ["HOMEPATH", profile.slice(2)],
    ["SYSTEMDRIVE", profile.slice(0, 2)],
    ["SYSTEMROOT", `${profile.slice(0, 2)}\\Windows`],
  ]);
  for (const name of ["COTAL_HOME", "LOCALAPPDATA"]) {
    const raw = values.get(name);
    if (raw === undefined) continue;
    const expanded = expandWindowsAccountValue(raw, variables);
    if (expanded === undefined || !/^[A-Za-z]:\\/.test(expanded)) return false;
    values.set(name, expanded);
    variables.set(name, expanded);
  }
  return true;
}

/** One Windows expansion pass, in the order the process environment block uses. */
function expandWindowsAccountValue(value: string, variables: ReadonlyMap<string, string>): string | undefined {
  if (value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  let unresolved = false;
  const expanded = value.replace(/%[^%\r\n]+%/g, (token) => {
    const replacement = variables.get(token.slice(1, -1).toUpperCase());
    if (replacement === undefined) unresolved = true;
    return replacement ?? "";
  });
  return unresolved || expanded.includes("%") ? undefined : expanded;
}

/** The Cotal directory a default service resolves from the environment it will actually start with. */
function serviceResolvedHome(environment: ReadonlyMap<string, string>): string | undefined {
  const override = environment.get("COTAL_HOME");
  if (override !== undefined) return absoluteServicePath(override) ? override : undefined;
  if (process.platform === "linux") {
    const home = environment.get("HOME");
    return home && absoluteServicePath(home) ? join(home, ".cotal") : undefined;
  }
  const profile = environment.get("USERPROFILE");
  if (!profile) return undefined;
  const local = environment.get("LOCALAPPDATA") ?? join(profile, "AppData", "Local");
  return absoluteServicePath(local) ? join(local, "Cotal") : undefined;
}

/** One native read. A missing tool, a hang, or a failed start is unknown rather than a new refusal. */
function serviceRead(file: string, args: readonly string[], env: NodeJS.ProcessEnv): NativeResult | undefined {
  try { return nativeRun(file, args, env, 2_000); }
  catch (error) { if (error instanceof CommandFailure) return undefined; throw error; }
}

function windowsSystemRoot(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot || env.windir || "C:\\Windows";
}

/** Decode systemctl's shell_maybe_quote(..., SHELL_ESCAPE_POSIX), never shell evaluation. A value
 *  this cannot decode is uncertain, matching the user-manager directory read. */
function systemdDirectoryValue(value: string): string | undefined {
  if (!value.startsWith("$'")) return value;
  if (!value.endsWith("'")) return undefined;
  const bytes: Buffer[] = [];
  const escapes: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"' };
  const body = value.slice(2, -1);
  for (let i = 0; i < body.length;) {
    if (body[i] === "'") return undefined;
    if (body[i] !== "\\") {
      const end = body.indexOf("\\", i);
      const text = body.slice(i, end < 0 ? undefined : end);
      if (text.includes("'")) return undefined;
      bytes.push(Buffer.from(text));
      i += text.length;
      continue;
    }
    const escaped = body[++i];
    if (escaped !== undefined && Object.hasOwn(escapes, escaped)) { bytes.push(Buffer.from(escapes[escaped]!)); i++; }
    else {
      const octal = body.slice(i, i + 3);
      if (!/^[0-3][0-7]{2}$/.test(octal)) return undefined;
      bytes.push(Buffer.from([Number.parseInt(octal, 8)]));
      i += 3;
    }
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(bytes)); }
  catch { return undefined; }
}

function absoluteServicePath(value: string): boolean {
  return isAbsolute(value) && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function sameDirectory(left: string, right: string): boolean {
  try { return canonicalRoot(resolve(left)) === canonicalRoot(resolve(right)); }
  catch { return resolve(left) === resolve(right); }
}

/** A remedy the person can run in the shell that then installs. A shell-only override is cleared in
 *  that shell. An account value needs the explicit daemon home, which works in PowerShell and cmd. */
function serviceHomeRemedy(environment: ReadonlyMap<string, string>): string {
  if (process.env.COTAL_HOME && !environment.has("COTAL_HOME")) return process.platform === "win32"
    ? "Remove-Item Env:COTAL_HOME; or pass --daemon-home <directory>"
    : "unset COTAL_HOME, or pass --daemon-home <directory>";
  if (process.platform === "win32" && process.env.LOCALAPPDATA && !process.env.COTAL_HOME && !environment.has("LOCALAPPDATA")) {
    return "Remove-Item Env:LOCALAPPDATA; or pass --daemon-home <directory>";
  }
  return "pass --daemon-home <directory>";
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
