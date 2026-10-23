import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fchmodSync, linkSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync, fsyncSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { acquireLock } from "@cotal-ai/core";
import { LOAD_NOW, SCRIPTS } from "./completion-scripts.js";
import { CommandFailure } from "@cotal-ai/workspace";

interface Snapshot { bytes: Buffer; hash: string; dev: number; ino: number; mode: number }
interface Ownership { schemaVersion: 1; shell: string; stub: string; stubHash: string; wiring: { path: string; block: string } | null }
interface Paths { stub: string; rc?: string }
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
export const completionSourceLine = (path: string, shell = "bash"): string => shell === "powershell" ? `. '${path.replaceAll("'", "''")}'` : `source ${quote(path)}`;
const blockFor = (path: string, shell: string) => `# >>> cotal completion >>>\n${completionSourceLine(path, shell)}\n# <<< cotal completion <<<\n`;
const recordPath = (paths: Paths) => `${paths.stub}.ownership.json`;

/** Ask the installed shell for its current-user all-hosts profile; profile directories vary by host. */
function powershellProfile(): string | undefined {
  if (process.platform === "win32") return undefined;
  const read = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::Out.Write($PROFILE.CurrentUserAllHosts)"], { encoding: "utf8", timeout: 3000, maxBuffer: 4096, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  if ((read.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
  const path = read.stdout;
  if (read.error || read.signal || read.status !== 0 || !path || path.length > 4096 || !isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path) || path.split(/[\\/]/u).at(-1)?.toLowerCase() !== "profile.ps1") throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the installed PowerShell did not identify one bounded current-user all-hosts profile; no profile path was guessed");
  return path;
}

/** Paths are local user settings, never a mesh selector or authority source. */
export function completionPaths(shell: string): Paths | undefined {
  const xdg = process.env.XDG_CONFIG_HOME;
  const config = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config");
  if (shell === "fish") return { stub: join(config, "fish", "completions", "cotal.fish") };
  if (shell === "bash") return { stub: join(config, "cotal", "completion.bash"), rc: join(homedir(), ".bashrc") };
  if (shell === "zsh") return { stub: join(config, "cotal", "completion.zsh"), rc: resolve(process.env.ZDOTDIR || homedir(), ".zshrc") };
  if (shell === "powershell") { const rc = powershellProfile(); return rc ? { stub: join(config, "cotal", "completion.ps1"), rc } : undefined; }
  return undefined;
}

function supported(): void {
  if (process.platform === "win32" || process.getuid === undefined || constants.O_NOFOLLOW === undefined || constants.O_NONBLOCK === undefined) throw new CommandFailure("refused", "UNSUPPORTED", "owned shell-file installation is not supported on this platform; use completion script explicitly instead of a weaker writer");
}
function safeParents(path: string, create = false): void {
  supported();
  if (/[\u0000-\u001f\u007f]/u.test(path)) throw new CommandFailure("refused", "USAGE_INVALID", "completion paths cannot contain terminal controls or newlines");
  const parent = dirname(path);
  if (parent !== path) safeParents(parent, create);
  let info;
  try { info = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!create) return;
    mkdirSync(path, { mode: 0o700 }); info = lstatSync(path);
  }
  const sticky = info.uid === 0 && (info.mode & 0o1000) !== 0;
  const writable = "is writable by group or others";
  const problem = info.isSymbolicLink() ? "is a symlink" : !info.isDirectory() ? "is not a directory"
    : info.uid !== 0 && info.uid !== process.getuid!() ? "is owned by another user" : (info.mode & 0o022) !== 0 && !sticky ? writable : undefined;
  if (problem) throw new CommandFailure("refused", "PERMISSION_DENIED", `the completion path ${path} ${problem}; custom shell wiring was not changed`, {
    target: { path },
    remedy: problem === writable
      ? `remove group and other write permission (chmod go-w ${path}) and run the command again, or wire completion yourself from cotal completion script <shell>`
      : "wire completion yourself from cotal completion script <shell>",
  });
}
function read(path: string, privateFile = false): Snapshot | undefined {
  safeParents(dirname(path));
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP") throw new CommandFailure("refused", "PERMISSION_DENIED", `${path} is a symlink, which completion does not follow; its contents were not printed`, { target: { path } });
    throw new CommandFailure("refused", "PERMISSION_DENIED", "the shell integration file could not be opened safely; its contents were not printed", { target: { path } });
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== process.getuid!() || (before.mode & (privateFile ? 0o077 : 0o022)) !== 0 || before.size > 2 * 1024 * 1024) throw new CommandFailure("refused", "PERMISSION_DENIED", "shell integration needs an owned, bounded regular file without group/other write access", { target: { path } });
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count; }
    const after = fstatSync(fd);
    if (length > 2 * 1024 * 1024 || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new CommandFailure("refused", "CONFLICT", "the shell file changed while it was read; no replacement was made", { target: { path } });
    const content = bytes.subarray(0, length);
    return { bytes: content, hash: hash(content), dev: before.dev, ino: before.ino, mode: before.mode & 0o777 };
  } finally { closeSync(fd); }
}
function same(path: string, expected: Snapshot | undefined): void {
  const current = read(path);
  if (expected ? !current || current.hash !== expected.hash || current.dev !== expected.dev || current.ino !== expected.ino || current.mode !== expected.mode : current !== undefined) throw new CommandFailure("refused", "CONFLICT", "the shell file changed since review; no other writer's content was replaced", { target: { path } });
}
function write(path: string, expected: Snapshot | undefined, bytes: Buffer | string, mode: number): void {
  same(path, expected);
  safeParents(dirname(path), true);
  const temporary = join(dirname(path), `.cotal-completion-${randomUUID()}`);
  let created = false;
  let attempted = false;
  let published = false;
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    created = true;
    try { writeFileSync(fd, bytes); fchmodSync(fd, mode); fsyncSync(fd); } finally { closeSync(fd); }
    same(path, expected);
    attempted = true;
    if (expected) { renameSync(temporary, path); published = true; created = false; }
    else { linkSync(temporary, path); published = true; }
  } catch (error) {
    if (attempted) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the shell-file publication outcome is unconfirmed; no replacement was retried", { target: { path }, remedy: "inspect this file and its ownership record before another change" });
    throw error;
  } finally {
    if (created) {
      try { unlinkSync(temporary); }
      catch {
        if (published) throw new CommandFailure("partial", "OPERATION_PARTIAL", "the shell file was written, but its owned temporary link could not be removed", { target: { path }, changed: [path], remedy: "inspect the completion file and its temporary link before proceeding" });
      }
    }
  }
}
function remove(path: string, expected: Snapshot): void {
  same(path, expected);
  try { unlinkSync(path); }
  catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "shell-file removal was submitted but its outcome is unconfirmed; no removal was retried", { target: { path } }); }
}
function text(snapshot: Snapshot | undefined): string | undefined {
  if (!snapshot) return undefined;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the shell integration file is not UTF-8; its contents were not rewritten or printed"); }
}
function ownership(paths: Paths, shell: string): { record?: Ownership; snapshot?: Snapshot } {
  const snapshot = read(recordPath(paths), true);
  if (!snapshot) return {};
  let value: unknown;
  try { value = JSON.parse(text(snapshot)!); } catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the completion ownership record is invalid; it was not reset"); }
  const record = value as Ownership;
  if (!record || typeof record !== "object" || Object.keys(record).some((key) => !["schemaVersion", "shell", "stub", "stubHash", "wiring"].includes(key)) || record.schemaVersion !== 1 || record.shell !== shell || record.stub !== paths.stub || typeof record.stubHash !== "string" || !/^[0-9a-f]{64}$/.test(record.stubHash)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the completion ownership record does not match this shell and path");
  if (record.wiring !== null && (!record.wiring || typeof record.wiring !== "object" || Object.keys(record.wiring).some((key) => !["path", "block"].includes(key)) || record.wiring.path !== paths.rc || typeof record.wiring.block !== "string" || ![blockFor(paths.stub, shell), "\n" + blockFor(paths.stub, shell)].includes(record.wiring.block))) throw new CommandFailure("refused", "SCHEMA_INVALID", "the completion ownership record contains unknown startup wiring; it was not used to rewrite a shell file");
  return { record, snapshot };
}

export function completionOwnership(shell: string, paths: Paths): "managed" | "unrecorded" | "modified" {
  const { record } = ownership(paths, shell);
  if (!record) return "unrecorded";
  const stub = read(paths.stub);
  if (stub?.hash !== record.stubHash) return "modified";
  if (record.wiring) {
    const startup = text(read(record.wiring.path)) ?? "";
    if (startup.split(record.wiring.block).length !== 2) return "modified";
  }
  return "managed";
}

export function readCompletionText(path: string): string | undefined {
  return text(read(path));
}

/** Hold one writer lock and change only the recorded stub and unchanged owned startup block. */
export function changeCompletion(operation: "install" | "uninstall", shell: string, paths: Paths, script: string) {
  supported();
  if (paths.rc) {
    safeParents(dirname(paths.rc));
    try { lstatSync(dirname(paths.rc)); }
    catch { throw new CommandFailure("refused", "TARGET_NOT_FOUND", "the shell startup directory must exist before completion installation"); }
    // A startup file linked from elsewhere, as a dotfile manager such as stow links it, is never
    // written through. The load line needs no stub, so it works from the file the link points to.
    if (lstatSync(paths.rc, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new CommandFailure("refused", "PERMISSION_DENIED", `${paths.rc} is a symlink, and completion does not write through one; nothing was changed`, {
        target: { shell, path: paths.rc },
        remedy: operation === "install" ? `add this line to the file it points to yourself: ${LOAD_NOW[shell]}` : "remove the cotal completion lines from the file it points to yourself",
      });
  }
  safeParents(dirname(paths.stub), true);
  const held = acquireLock(`${recordPath(paths)}.lock`, { label: "shell completion ownership", waitMs: 0, onTimeout: () => new CommandFailure("refused", "CONFLICT", "another completion writer holds this shell integration") });
  const changed: string[] = [];
  try {
    const owned = ownership(paths, shell), stub = read(paths.stub), startup = paths.rc ? read(paths.rc) : undefined;
    const current = text(startup) ?? "";
    let record = owned.record;
    if (!record && operation === "uninstall") {
      if (stub) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this completion file has no recorded ownership; it and custom startup wiring were left unchanged", { remedy: "review and explicitly install the recognized generated integration before uninstalling it" });
      return { operation, shell, changed, noOp: true, stub: paths.stub, startup: paths.rc ?? null, parentShellUnloaded: false };
    }
    if (!record && stub) throw new CommandFailure("refused", "CONFLICT", "the existing completion stub has no recorded ownership; it was not adopted or overwritten", { target: { shell, path: paths.stub }, remedy: "review the existing integration manually; completion script prints the supported replacement without editing it" });
    if (record && stub && stub.hash !== record.stubHash) throw new CommandFailure("refused", "CONFLICT", "the recorded completion stub was modified; it and startup content were left unchanged", { target: { shell, path: paths.stub } });
    if (!record) {
      record = { schemaVersion: 1, shell, stub: paths.stub, stubHash: hash(script), wiring: null };
    }
    let nextStartup = current;
    let installedBlock = blockFor(paths.stub, shell);
    if (record.wiring) {
      const count = current.split(record.wiring.block).length - 1;
      if (count > 1 || count === 0 && (current.includes(paths.stub) || current.includes("# >>> cotal completion >>>") || current.includes("# cotal shell completion"))) throw new CommandFailure("refused", "CONFLICT", "the recorded startup block is modified or ambiguous; custom startup content was not rewritten");
      if (count === 1) {
        installedBlock = (record.wiring.block.startsWith("\n") ? "\n" : "") + blockFor(paths.stub, shell);
        nextStartup = current.replace(record.wiring.block, operation === "install" ? installedBlock : "");
      }
      else record.wiring = null;
    }
    // A startup file its owner made read-only is never replaced. Asked once its next content is known.
    const readOnly = () => paths.rc !== undefined && nextStartup !== current && startup !== undefined && (startup.mode & 0o200) === 0;
    if (operation === "uninstall") {
      if (paths.rc && nextStartup.includes(paths.stub)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an unowned startup reference still names this stub; removing the file would break custom wiring", { remedy: "review and remove that custom reference manually before uninstalling" });
      if (readOnly()) throw new CommandFailure("refused", "PERMISSION_DENIED", `${paths.rc} is read-only, so its completion line was not removed; nothing was changed`, { target: { shell, path: paths.rc }, remedy: `remove the line ${completionSourceLine(paths.stub, shell)} from ${paths.rc} yourself, then run cotal completion uninstall ${shell} again` });
      if (paths.rc && nextStartup !== current) { write(paths.rc, startup, nextStartup, startup?.mode ?? 0o644); changed.push(paths.rc); }
      if (stub) { remove(paths.stub, stub); changed.push(paths.stub); }
      if (owned.snapshot) { remove(recordPath(paths), owned.snapshot); changed.push(recordPath(paths)); }
    } else {
      if (paths.rc && !record.wiring) {
        if (current.includes(paths.stub) || current.includes("# >>> cotal completion >>>") || current.includes("# cotal shell completion")) throw new CommandFailure("refused", "CONFLICT", "custom startup wiring already refers to this stub; it was not adopted or rewritten", { remedy: "keep custom wiring and use completion script, or review it before managed installation" });
        installedBlock = (current && !current.endsWith("\n") ? "\n" : "") + blockFor(paths.stub, shell);
        nextStartup = current + installedBlock;
      }
      if (!stub || text(stub) !== script) { write(paths.stub, stub, script, stub?.mode ?? 0o644); changed.push(paths.stub); }
      if (paths.rc && nextStartup !== current && !readOnly()) { write(paths.rc, startup, nextStartup, startup?.mode ?? 0o644); changed.push(paths.rc); }
      record.stubHash = hash(script);
      // A read-only startup file keeps the wiring it had, so the record keeps naming that.
      if (!readOnly()) record.wiring = paths.rc ? { path: paths.rc, block: installedBlock } : null;
      const serialized = JSON.stringify(record, null, 2) + "\n";
      if (text(owned.snapshot) !== serialized) { write(recordPath(paths), owned.snapshot, serialized, 0o600); changed.push(recordPath(paths)); }
      if (readOnly()) throw new CommandFailure("failed", "OPERATION_FAILED", `${changed.includes(paths.stub) ? "wrote" : "kept the current"} ${paths.stub} but could not add its line to ${paths.rc}, which is read-only; that file was not changed`, { target: { shell, path: paths.rc }, changed: [...changed], remedy: `add this line to ${paths.rc} yourself: ${completionSourceLine(paths.stub, shell)}` });
    }
    return { operation, shell, changed, noOp: !changed.length, stub: paths.stub, startup: paths.rc ?? null, parentShellUnloaded: false };
  } catch (error) {
    const confirmed = [...changed, ...(error instanceof CommandFailure ? error.changed ?? [] : [])];
    if (error instanceof CommandFailure && error.outcome === "unknown") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", error.message, { target: { shell, detail: error.target }, changed: confirmed, remedy: error.remedy });
    // Only the read-only startup file fails this way, after its stub was written as intended.
    if (error instanceof CommandFailure && error.outcome === "failed") throw error;
    if (confirmed.length) throw new CommandFailure("partial", "OPERATION_PARTIAL", "some owned completion material changed, but the remaining integration was preserved after a refusal", { target: { shell }, changed: confirmed, remedy: "inspect completion status and the named paths; do not overwrite modified startup content" });
    if (error instanceof CommandFailure) throw error;
    throw new CommandFailure("refused", "PERMISSION_DENIED", "the owned shell-file operation could not complete; file contents were not printed", { target: { shell }, remedy: "review file access and completion status before another attempt" });
  } finally { held.release(); }
}

/** The updated CLI refreshes only existing recorded stubs. It never adds startup wiring. */
export function refreshOwnedCompletions(): { changed: string[]; preserved: { shell: string; reason: string }[] } {
  const changed: string[] = [], preserved: { shell: string; reason: string }[] = [];
  for (const [shell, script] of Object.entries(SCRIPTS)) {
    let paths: Paths | undefined;
    try { paths = completionPaths(shell); }
    catch { preserved.push({ shell, reason: "the shell did not return a usable current-user profile" }); continue; }
    if (!paths) continue;
    try { lstatSync(recordPath(paths)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; preserved.push({ shell, reason: "ownership record unavailable" }); continue; }
    let held: ReturnType<typeof acquireLock> | undefined;
    try {
      safeParents(dirname(paths.stub));
      held = acquireLock(`${recordPath(paths)}.lock`, { label: "shell completion refresh", waitMs: 0 });
      const owned = ownership(paths, shell);
      if (!owned.record || !owned.snapshot) { preserved.push({ shell, reason: "ownership changed before refresh" }); continue; }
      const stub = read(paths.stub);
      if (!stub) { preserved.push({ shell, reason: "recorded stub was removed; not reinstalled" }); continue; }
      if (stub.hash !== owned.record.stubHash) { preserved.push({ shell, reason: "recorded stub was modified; not overwritten" }); continue; }
      if (text(stub) === script) continue;
      write(paths.stub, stub, script, stub.mode); changed.push(paths.stub);
      const updated = { ...owned.record, stubHash: hash(script) };
      write(recordPath(paths), owned.snapshot, JSON.stringify(updated, null, 2) + "\n", 0o600); changed.push(recordPath(paths));
    } catch (error) {
      if (error instanceof CommandFailure && error.outcome === "unknown") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "completion refresh outcome is unconfirmed; the update must not blindly repeat it", { changed, target: { shell }, remedy: "inspect the owned completion stub and record" });
      if (error instanceof CommandFailure && error.changed) changed.push(...error.changed.filter((path): path is string => typeof path === "string"));
      preserved.push({ shell, reason: "guarded refresh could not complete; inspect completion status" });
    } finally { held?.release(); }
  }
  return { changed, preserved };
}
