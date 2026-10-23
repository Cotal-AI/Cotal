import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync, statSync, unlinkSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { acquireLock, ensureDirNoSymlink, hardenPrivate, mkSecretDir, realDirNoSymlink, writeSecretFileAtomic } from "@cotal-ai/core";
import { CommandFailure } from "./output.js";
import { homeCotalDir } from "./mesh-registry.js";
import { spaceKey } from "./auth-paths.js";

export const LOCAL_INPUT_LIMIT = 256 * 1024;
const RECORD_LIMIT = LOCAL_INPUT_LIMIT + 8192;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface SavedLocalRecord<T> { recordVersion: 1; revision: string; value: T }
export interface LocalRecordSnapshot<T> { name: string; path: string; record: SavedLocalRecord<T>; hash: string }

export function localRecordName(name: string): string {
  if (!NAME.test(name)) throw new CommandFailure("refused", "USAGE_INVALID", "local record names are case-sensitive segments of 1 to 64 letters, digits, underscores or dashes, beginning with a letter or digit");
  return name;
}

/**
 * How local records are protected. `posix` checks the owner and the mode and refuses links, and
 * opens without following a link or blocking. `windows-acl` is the model Cotal already uses for
 * private files on Windows: a private file or directory gets an access list for this user, SYSTEM
 * and Administrators when Cotal creates it (core `hardenPrivate`). Windows has no POSIX owner or
 * mode, so that model checks neither and does not refuse a link.
 */
export type LocalRecordAccess = "posix" | "windows-acl";

/** The model for `platform`, or undefined when a POSIX host lacks the owner id or the no-follow
 *  and nonblocking opens the POSIX checks need. It is the one place the platform is decided;
 *  `platform` is a parameter so a suite can select the Windows model off Windows. */
export function localRecordAccess(platform: NodeJS.Platform = process.platform): LocalRecordAccess | undefined {
  if (platform === "win32") return "windows-acl";
  return process.getuid !== undefined && constants.O_NOFOLLOW !== undefined && constants.O_NONBLOCK !== undefined ? "posix" : undefined;
}

/** Whether this platform has a protection model for local records. */
export function protectedFileAccessAvailable(): boolean {
  return localRecordAccess() !== undefined;
}

/** This platform's model, refusing where there is none. */
function requireLocalRecordAccess(): LocalRecordAccess {
  const access = localRecordAccess();
  if (!access) throw new CommandFailure("refused", "UNSUPPORTED", "protected workstation file access is not available on this platform in this author preview; no weaker file access was substituted");
  return access;
}

export function assertProtectedFileAccess(): void {
  requireLocalRecordAccess();
}

function privateDirectory(path: string, access: LocalRecordAccess): void {
  if (access === "windows-acl") {
    if (!statSync(path).isDirectory()) throw new CommandFailure("refused", "PERMISSION_DENIED", "the local-record store must use directories", { target: { path } });
    return;
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0)
    throw new CommandFailure("refused", "PERMISSION_DENIED", "the local-record store must use owned private directories without symlinks", { target: { path } });
}

/** Establish a regular descriptor, then read only bounded bytes. POSIX opens nonblocking and
 *  without following a link, and checks a private file's owner and mode; Windows does neither. */
export function readLocalRecordSource(path: string, limit = LOCAL_INPUT_LIMIT, privateFile = false): Buffer | undefined {
  const access = requireLocalRecordAccess();
  const posix = access === "posix";
  let fd: number;
  try { fd = openSync(path, posix ? constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK : constants.O_RDONLY); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CommandFailure("refused", "PERMISSION_DENIED", posix ? "the local record source could not be opened without following links" : "the local record source could not be opened", { target: { path } });
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new CommandFailure("refused", "SCHEMA_INVALID", "local record input must be a regular file", { target: { path } });
    if (privateFile && posix && (before.uid !== process.getuid!() || (before.mode & 0o077) !== 0)) throw new CommandFailure("refused", "PERMISSION_DENIED", "the saved local record is not owned and private", { target: { path } });
    if (before.size > limit) throw new CommandFailure("refused", "SCHEMA_INVALID", "local record input exceeds its byte limit", { target: { path } });
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count; }
    const after = fstatSync(fd);
    if (length > limit) throw new CommandFailure("refused", "SCHEMA_INVALID", "local record input exceeds its byte limit", { target: { path } });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new CommandFailure("refused", "CONFLICT", "the local record source changed while it was read", { target: { path } });
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}

export function localRecordObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((field) => !fields.includes(field))) throw new CommandFailure("refused", "SCHEMA_INVALID", "local record input has an invalid object shape or unknown field; document values are not echoed");
  return value as Record<string, unknown>;
}

export function localRecordText(value: unknown, limit: number): string {
  if (typeof value !== "string" || !value || value.length > limit) throw new CommandFailure("refused", "SCHEMA_INVALID", "local record input has an invalid string field");
  return value;
}

/** The account-database reads behind the private-group proof, as raw text. Each one throws with
 *  its reason when the read is unavailable. */
export interface AccountDatabase {
  /** `/etc/nsswitch.conf`, which names the sources behind the lookups below */
  readonly nameServices: () => string;
  /** `getent passwd <uid>` */
  readonly user: (uid: number) => string;
  /** `getent group <gid>` */
  readonly group: (gid: number) => string;
  /** `getent passwd`: every account the name service enumerates */
  readonly users: () => string;
}

/** Who may write a protected path besides its owner: only a group proven to be the caller's
 *  user private group, on an entry with no extended ACL. */
export interface ProtectedPathPolicy {
  readonly uid: number;
  /** Why `gid` is not proven to be the caller's user private group, or undefined when it is. */
  readonly privateGroupGap: (gid: number) => string | undefined;
  /** `getfacl --skip-base --absolute-names -- <path>` output, empty when the path has only base
   *  ACL entries. Throws with its reason when the read is unavailable. */
  readonly extendedAcl: (path: string) => string;
}

const ACCOUNT_ID = /^(0|[1-9][0-9]{0,9})$/;
const accountLines = (text: string) => text.split("\n").filter((line) => line !== "");

function passwdRows(text: string): { name: string; uid: number; gid: number }[] {
  return accountLines(text).map((line) => {
    const [name, , uid, gid, ...rest] = line.split(":");
    if (!name || rest.length !== 3 || !ACCOUNT_ID.test(uid ?? "") || !ACCOUNT_ID.test(gid ?? "")) throw new Error("getent passwd output cannot be parsed");
    return { name, uid: Number(uid), gid: Number(gid) };
  });
}

function groupMembers(text: string, gid: number): string[] {
  const rows = accountLines(text);
  const [name, , id, members, ...rest] = rows.length === 1 ? rows[0]!.split(":") : [];
  if (!name || rest.length || members === undefined || id !== String(gid)) throw new Error("getent group output cannot be parsed");
  return members ? members.split(",") : [];
}

const LOCAL_SOURCES = new Set(["files", "systemd"]);

/** A clean `getent passwd` exit proves a complete account list only when every passwd and group
 *  source is local. A directory source such as LDAP or SSSD can enumerate part of its accounts and
 *  still exit 0, so any other source, a missing line or a line that cannot be parsed throws.
 *  Bracketed action items are ignored. */
function assertLocalNameServices(text: string): void {
  const unparsable = () => new Error("/etc/nsswitch.conf has a line that cannot be parsed");
  const sources = new Map<string, string[]>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const match = /^([A-Za-z0-9_]+)\s*:(.*)$/.exec(line);
    if (!match) throw unparsable();
    const database = match[1]!.toLowerCase();
    if (database !== "passwd" && database !== "group") continue;
    const services = match[2]!.replace(/\[[^[\]]*\]/g, " ");
    if (/[[\]]/.test(services) || sources.has(database)) throw unparsable();
    sources.set(database, services.split(/\s+/).filter(Boolean));
  }
  for (const database of ["passwd", "group"]) {
    const named = sources.get(database) ?? [];
    if (!named.length) throw new Error(`/etc/nsswitch.conf names no source for ${database}`);
    const other = named.find((source) => !LOCAL_SOURCES.has(source));
    if (other) throw new Error(`/etc/nsswitch.conf names ${other} for ${database}, which may list only part of its accounts`);
  }
}

/** Debian OpenSSH's user-private-group rule (user-group-modes.patch): the group is the caller's
 *  primary group, it lists no other member, and no other account has it as its primary group.
 *  The account list counts only when /etc/nsswitch.conf names local sources alone.
 *  Returns why that is not proven, or undefined when it is. */
export function privateGroupGap(accounts: AccountDatabase, uid: number, gid: number): string | undefined {
  try {
    assertLocalNameServices(accounts.nameServices());
    const self = passwdRows(accounts.user(uid));
    if (self.length !== 1 || self[0]!.uid !== uid) throw new Error("getent passwd did not return your account");
    const { name, gid: primary } = self[0]!;
    if (primary !== gid) return "its group is not your primary group";
    if (groupMembers(accounts.group(gid), gid).some((member) => member !== name)) return "its group has other members";
    const all = passwdRows(accounts.users());
    if (!all.some((row) => row.uid === uid && row.name === name)) throw new Error("getent passwd does not enumerate your account, so its account list may be partial");
    if (all.some((row) => row.gid === gid && row.uid !== uid)) return "another account has its group as its primary group";
    return undefined;
  } catch (error) {
    return `the private-group proof is unavailable: ${(error as Error).message}`;
  }
}

/** A proven private group holds for the life of the policy, which for the system policy is the
 *  process. Every other verdict is read again on the next check, so a transient lookup failure
 *  does not stick in a long-lived service. */
export function protectedPathPolicy(accounts: AccountDatabase, extendedAcl: (path: string) => string, uid: number): ProtectedPathPolicy {
  const proven = new Set<number>();
  return {
    uid,
    privateGroupGap: (gid) => {
      if (proven.has(gid)) return undefined;
      const gap = privateGroupGap(accounts, uid, gid);
      if (gap === undefined) proven.add(gid);
      return gap;
    },
    extendedAcl,
  };
}

/** Runs a system read from PATH with a 2 second limit and a 4 MiB output limit. Proving a group
 *  takes up to three `getent` reads, and each group-writable path one `getfacl` read. */
function boundedRead(label: string, command: "getent" | "getfacl", args: readonly string[]): string {
  if (process.platform !== "linux") throw new Error("it is checked only on Linux");
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 2000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") throw new Error(`${command} is not installed`);
  if (code === "ETIMEDOUT") throw new Error(`${label} timed out`);
  if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== "string") throw new Error(`${label} failed or exceeded its output limit`);
  return result.stdout;
}

const NSSWITCH = "/etc/nsswitch.conf";

/** Reads /etc/nsswitch.conf bounded to 64 KiB. It follows a symlink, as glibc does, because only
 *  root can place one in /etc. */
function readNameServices(): string {
  if (process.platform !== "linux") throw new Error("it is checked only on Linux");
  let fd: number;
  try { fd = openSync(NSSWITCH, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (error) { throw new Error((error as NodeJS.ErrnoException).code === "ENOENT" ? `${NSSWITCH} is missing` : `${NSSWITCH} cannot be read`); }
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${NSSWITCH} is not a regular file`);
    const limit = 64 * 1024;
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count; }
    if (length > limit) throw new Error(`${NSSWITCH} exceeds its size limit`);
    return bytes.subarray(0, length).toString("utf8");
  } finally { closeSync(fd); }
}

const systemAccounts: AccountDatabase = {
  nameServices: readNameServices,
  user: (uid) => boundedRead("getent passwd", "getent", ["passwd", String(uid)]),
  group: (gid) => boundedRead("getent group", "getent", ["group", String(gid)]),
  users: () => boundedRead("getent passwd", "getent", ["passwd"]),
};
const systemAcl = (path: string) => boundedRead("getfacl", "getfacl", ["--skip-base", "--absolute-names", "--", path]);

let processPolicy: ProtectedPathPolicy | undefined;
const systemPolicy = (): ProtectedPathPolicy => processPolicy ??= protectedPathPolicy(systemAccounts, systemAcl, process.getuid!());

type EntryStat = Pick<Stats, "uid" | "gid" | "mode" | "isDirectory" | "isSymbolicLink">;

const shellPath = (path: string) => /^[A-Za-z0-9_./+-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;

/** One entry another local account could replace or write, and the kind of change that fixes it. */
type ProtectionGap = { path: string; reason: string; fix: "physical" | "o-w" | "g-w" | "g-w-or-acl" };

/** Why an existing entry is not protected against other local writers, or nothing when it is. Root
 *  or the caller must own it. Group write needs the caller's proven user private group and no
 *  extended ACL, whose named entries the group bits only mask. World write is never accepted. An
 *  `ancestor` walk also accepts a root-owned sticky directory such as /tmp. */
function protectionGap(path: string, stat: EntryStat, options: { ancestor?: boolean; policy?: ProtectedPathPolicy }): ProtectionGap | undefined {
  const gap = (reason: string, fix: ProtectionGap["fix"]): ProtectionGap => ({ path, reason, fix });
  if (stat.isSymbolicLink()) return gap("is a symbolic link", "physical");
  if (stat.uid !== 0 && stat.uid !== (options.policy?.uid ?? process.getuid!())) return gap("is owned by another account", "physical");
  if (options.ancestor && stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o1000) !== 0) return undefined;
  if ((stat.mode & 0o002) !== 0) return gap("is writable by every local account", "o-w");
  if ((stat.mode & 0o020) === 0) return undefined;
  const policy = options.policy ?? systemPolicy();
  const group = stat.uid === policy.uid ? policy.privateGroupGap(stat.gid) : "it is not owned by you";
  if (group) return gap(`is group-writable and ${group}`, "g-w");
  let acl: string;
  try { acl = policy.extendedAcl(path); }
  catch (error) { return gap(`is group-writable and the private-group proof is unavailable: ${(error as Error).message}`, "g-w-or-acl"); }
  return acl === "" ? undefined : gap("is group-writable and has an extended ACL", "g-w");
}

/** One refusal naming every gap, so a single change fixes them all. Paths that share a reason are
 *  listed together, and each kind of fix is one command over its paths. */
function protectionRefusal(what: string, gaps: readonly ProtectionGap[]): CommandFailure {
  const reasons = [...new Set(gaps.map((gap) => gap.reason))].map((reason) => {
    const paths = gaps.filter((gap) => gap.reason === reason).map((gap) => gap.path);
    return paths.length === 1 ? `${paths[0]} ${reason}` : `${paths.slice(0, -1).join(", ")} and ${paths.at(-1)} ${reason.replace(/^is /, "are ")}`;
  });
  const remedies = [...new Set(gaps.map((gap) => gap.fix))].map((fix) => {
    const paths = gaps.filter((gap) => gap.fix === fix).map((gap) => shellPath(gap.path)).join(" ");
    return fix === "physical" ? "use a physical path owned by you or root, without symlinks" : fix === "o-w" ? `chmod o-w ${paths}` : fix === "g-w" ? `chmod g-w ${paths}` : `chmod g-w ${paths}, or install acl`;
  });
  const path = gaps[0]!.path;
  return new CommandFailure("refused", "PERMISSION_DENIED", `${what} is not protected against other local writers: ${reasons.join("; ")}`, { remedy: remedies.join("; "), target: gaps.length === 1 ? { path } : { path, paths: gaps.map((gap) => gap.path) } });
}

/** Refuse an existing entry that another local account could replace or write; see
 *  {@link protectionGap} for the rule. `what` names the path the caller checks, for the refusal.
 *  These are POSIX owner, mode and link checks, so the Windows model skips them. */
export function assertProtectedEntry(what: string, path: string, stat: EntryStat, options: { ancestor?: boolean; policy?: ProtectedPathPolicy } = {}): void {
  if (localRecordAccess() === "windows-acl") return;
  const gap = protectionGap(path, stat, options);
  if (gap) throw protectionRefusal(what, [gap]);
}

/** Verify an existing physical directory chain before using a protected private output path. The
 *  whole chain is read, and one refusal names every entry in it that is not protected. `what` names
 *  the path for the refusal, such as "the project root". */
export function protectedLocalDirectory(path: string, what = "the path", policy?: ProtectedPathPolicy): void {
  const gaps = directoryChainGaps(path, what, policy);
  if (gaps.length) throw protectionRefusal(what, gaps);
}

/** {@link protectedLocalDirectory} for an existing file or directory and every directory above it,
 *  read together so one refusal names each gap in both. The entry itself is not accepted for being
 *  a root-owned sticky directory, as an ancestor is. */
export function protectedLocalEntry(path: string, what = "the path", policy?: ProtectedPathPolicy): void {
  const entry = lstatSync(path);
  const gap = requireLocalRecordAccess() === "posix" ? protectionGap(path, entry, { policy }) : undefined;
  const gaps = [...(gap ? [gap] : []), ...directoryChainGaps(dirname(path), what, policy)];
  if (gaps.length) throw protectionRefusal(what, gaps);
}

/** Every gap on `path` and the directories above it, deepest first. */
function directoryChainGaps(path: string, what: string, policy?: ProtectedPathPolicy): ProtectionGap[] {
  const posix = requireLocalRecordAccess() === "posix";
  const gaps: ProtectionGap[] = [];
  let parent = path;
  for (;;) {
    const directory = lstatSync(parent);
    if (!directory.isDirectory() && !directory.isSymbolicLink()) throw new CommandFailure("refused", "PERMISSION_DENIED", `${what} is not protected against other local writers: ${parent} is not a directory`, { target: { path: parent } });
    const gap = posix ? protectionGap(parent, directory, { ancestor: true, policy }) : undefined;
    if (gap) gaps.push(gap);
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  return gaps;
}

export function protectedCredentialReference(path: string): void {
  const access = requireLocalRecordAccess();
  try {
    if (access === "windows-acl") {
      if (!statSync(path).isFile()) throw new CommandFailure("refused", "PERMISSION_DENIED", "the referenced credential must be a regular file; its bytes were not read");
    } else {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) throw new CommandFailure("refused", "PERMISSION_DENIED", "the referenced credential must be an owned private regular file; its bytes were not read");
    }
    protectedLocalDirectory(dirname(path), "the credential reference");
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the protected credential reference is missing or unreadable; its bytes were not read");
  }
}

/** Why a credential file is not private to this user, and the command that makes it private, or
 *  undefined when it is. The rule is {@link protectedCredentialReference}'s: an owned file with no
 *  group or other access. The Windows model has no POSIX owner or mode, so it reports nothing. */
export function credentialFileExposure(path: string, stat: Pick<Stats, "uid" | "mode">): { reason: string; remedy: string } | undefined {
  if (localRecordAccess() !== "posix") return undefined;
  if (stat.uid !== process.getuid!()) return { reason: "is owned by another account", remedy: `copy it to a file you own and run chmod 600 on the copy` };
  if ((stat.mode & 0o077) !== 0) return { reason: `is not private to you (mode ${(stat.mode & 0o777).toString(8).padStart(4, "0")})`, remedy: `chmod 600 ${shellPath(path)}` };
  return undefined;
}

/** Explicit exports stay outside managed state; canonical credentials use their declared store kind. */
export function assertExternalCredentialExport(path: string, roots: readonly string[]): void {
  const output = resolve(path);
  if (output.split(sep).some((part) => part.toLowerCase() === ".cotal")) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "explicit credential exports cannot create or replace managed .cotal files; choose a separate private output path");
  for (const managed of [homeCotalDir(), ...roots.map((root) => join(root, ".cotal"))]) {
    const child = relative(resolve(managed), output);
    if (child === "" || child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "explicit credential exports cannot write inside managed workstation state; choose a separate private output path");
  }
}

export function decodeLocalJson(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "local record input is not valid UTF-8 JSON; document contents are not echoed"); }
}

/** Workstation records only. Providers are never imported and revisions confer no native authority. */
export class ProtectedRecordStore<T> {
  constructor(
    readonly namespace: "endpoints" | "services",
    readonly space: string,
    readonly validate: (value: unknown, checkReferences: boolean) => T,
    readonly family?: "definitions" | "instances" | "supervisors" | "install-intents" | "uninstall-intents" | "unit-actions",
  ) {}

  directory(create = false): string | undefined {
    const access = requireLocalRecordAccess();
    const home = homeCotalDir();
    try { privateDirectory(home, access); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) return undefined;
      mkSecretDir(home); privateDirectory(home, access);
    }
    const segments = [this.namespace, spaceKey(this.space), ...(this.family ? [this.family] : [])];
    const paths = segments.map((_, index) => join(home, ...segments.slice(0, index + 1)));
    // Windows has no create mode, so each store directory made here gets the private access list.
    const created = create && access === "windows-acl" ? paths.filter((path) => !existsSync(path)) : [];
    const found = create ? ensureDirNoSymlink(home, ...segments) : realDirNoSymlink(home, ...segments);
    if (!found) return undefined;
    for (const path of created) hardenPrivate(path, "dir");
    for (const path of paths) privateDirectory(path, access);
    return found;
  }

  read(name: string): LocalRecordSnapshot<T> | undefined {
    localRecordName(name);
    const dir = this.directory();
    if (!dir) return undefined;
    const path = join(dir, `${spaceKey(name)}.json`);
    const bytes = readLocalRecordSource(path, RECORD_LIMIT, true);
    if (!bytes) return undefined;
    const wrapper = localRecordObject(decodeLocalJson(bytes), ["recordVersion", "revision", "value"]);
    if (wrapper.recordVersion !== 1) throw new CommandFailure("refused", "SCHEMA_INVALID", "saved local record version is unsupported; it was not reset");
    const revision = localRecordText(wrapper.revision, 200);
    const value = this.validate(wrapper.value, false);
    return { name, path, record: { recordVersion: 1, revision, value }, hash: createHash("sha256").update(bytes).digest("hex") };
  }

  list(): LocalRecordSnapshot<T>[] {
    const dir = this.directory();
    if (!dir) return [];
    const result: LocalRecordSnapshot<T>[] = [];
    for (const file of readdirSync(dir).sort()) {
      if (file.startsWith(".") || !file.endsWith(".json")) continue;
      const key = file.slice(0, -5);
      const name = Buffer.from(key, "hex").toString("utf8");
      if (!NAME.test(name) || spaceKey(name) !== key) throw new CommandFailure("refused", "SCHEMA_INVALID", "the local-record directory contains an invalid record name; it was not silently omitted");
      const row = this.read(name);
      if (!row) throw new CommandFailure("refused", "CONFLICT", "a local record disappeared during enumeration; a complete empty inventory was not inferred");
      result.push(row);
    }
    return result;
  }

  /** Hold the cooperative writer lock while a native action uses this exact local revision. */
  pin(expected: LocalRecordSnapshot<T>): { check(): void; release(): void } {
    const dir = this.directory();
    if (!dir) throw new CommandFailure("refused", "CONFLICT", "the selected local-record store disappeared");
    const lock = acquireLock(join(dir, `.${spaceKey(expected.name)}.lock`), { label: "pinned local record", onTimeout: () => new CommandFailure("refused", "CONFLICT", "another writer holds the selected local record") });
    const check = () => {
      const current = this.read(expected.name);
      if (!current || current.record.revision !== expected.record.revision || current.hash !== expected.hash) throw new CommandFailure("refused", "CONFLICT", "the selected local record changed; no new native request was submitted");
    };
    try { check(); } catch (error) { lock.release(); throw error; }
    return { check, release: () => lock.release() };
  }

  /** Cooperative CLI writers compare revision and exact bytes under the private per-name lock. */
  commit(name: string, expected: LocalRecordSnapshot<T> | undefined, value: T | undefined, beforeCommit?: () => void): SavedLocalRecord<T> | undefined {
    localRecordName(name);
    if (value !== undefined) this.validate(value, true);
    const dir = this.directory(value !== undefined);
    if (!dir) throw new CommandFailure("refused", "CONFLICT", "the local-record store disappeared before commit");
    const path = join(dir, `${spaceKey(name)}.json`);
    const lock = acquireLock(join(dir, `.${spaceKey(name)}.lock`), { label: "local record write", onTimeout: () => new CommandFailure("refused", "CONFLICT", "another writer holds the selected local record") });
    try {
      const current = this.read(name);
      if (expected ? !current || expected.record.revision !== current.record.revision || expected.hash !== current.hash : current !== undefined) throw new CommandFailure("refused", "CONFLICT", "the local record changed; nothing was replaced or removed");
      beforeCommit?.();
      if (value === undefined) { if (!current) throw new CommandFailure("refused", "CONFLICT", "the local record no longer exists"); unlinkSync(path); return undefined; }
      const record: SavedLocalRecord<T> = { recordVersion: 1, revision: randomUUID(), value };
      writeSecretFileAtomic(path, JSON.stringify(record, null, 2) + "\n");
      return record;
    } finally { lock.release(); }
  }
}
