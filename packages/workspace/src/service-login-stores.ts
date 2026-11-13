import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spaceFromKey } from "./auth-paths.js";
import { homedir } from "node:os";
import { loginRecoveryCommand } from "./cloud-login.js";
import { privateGroupWriteGap, shellPath } from "./protected-records.js";
import { userCotalDir } from "./cotal-home.js";
import { isAbsolute, join, resolve } from "node:path";

/** A proven same-user Manager unit and its explicit private sign-in directory. */
export interface ServiceLoginStore {
  readonly service: string;
  readonly directory: string;
  readonly unitPath: string;
}
export interface SkippedServiceLoginStore {
  readonly service?: string;
  readonly reason: "local-overrides" | "unproven";
  /** A mode change or package that would let discovery prove this directory. */
  readonly remedy?: string;
}
export interface ServiceLoginStoresReport {
  readonly stores: ServiceLoginStore[];
  readonly skipped: SkippedServiceLoginStore[];
}
class LocalOverrides extends Error {}
class ServiceDiscoveryRefusal extends Error {
  readonly remedy?: string;
  constructor(remedy?: string) {
    super("Manager service sign-in discovery refused an ambiguous or unprotected unit/store; use an explicit protected COTAL_HOME after inspecting the service configuration");
    this.name = "ServiceDiscoveryRefusal";
    this.remedy = remedy;
  }
}
const proofs = new WeakMap<ServiceLoginStore, () => void>();
const cap = 128 * 1024;
function refuse(remedy?: string): never { throw new ServiceDiscoveryRefusal(remedy); }
function unproven(error: unknown, service?: string): SkippedServiceLoginStore {
  const remedy = error instanceof ServiceDiscoveryRefusal ? error.remedy : undefined;
  return { ...(service ? { service } : {}), reason: "unproven", ...(remedy ? { remedy } : {}) };
}

// Walk physical components through pinned directory descriptors. Only root-owned ancestors
// (including the sticky temporary root used by isolated tests) may belong to another uid.
function physical<T>(path: string, directory: boolean, use: (fd: number) => T, candidate = false): T {
  if (!isAbsolute(path) || path !== resolve(path) || /[\x00-\x1f\x7f]/.test(path)) return refuse();
  const uid = process.getuid!();
  const fds: number[] = [];
  try {
    let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY);
    fds.push(fd);
    const parts = path.split("/").filter(Boolean);
    let walked = "";
    for (const [i, part] of parts.entries()) {
      const last = i === parts.length - 1;
      walked += `/${part}`;
      fd = openSync(`/proc/self/fd/${fd}/${part}`, constants.O_RDONLY | constants.O_NOFOLLOW | (last && !directory ? constants.O_NONBLOCK : constants.O_DIRECTORY));
      fds.push(fd);
      const st = fstatSync(fd);
      if ((!last || directory) ? !st.isDirectory() : !st.isFile()) refuse();
      if (last ? st.uid !== uid : st.uid !== uid && st.uid !== 0) refuse();
      // A caller-owned directory that is group-writable only by that user's private group, with no
      // extended ACL, is the same proof the config root uses. World write stays refused. A missing
      // ACL inspection names the mode change or the acl package instead of a bare skip.
      const stickyRoot = st.uid === 0 && st.isDirectory() && (st.mode & 0o1000) !== 0;
      if (!(candidate && last && !directory) && !stickyRoot) {
        if ((st.mode & 0o002) !== 0) refuse();
        if ((st.mode & 0o020) !== 0) {
          if (st.uid !== uid) refuse();
          const gap = privateGroupWriteGap(walked, st.gid);
          if (gap?.includes("getfacl")) refuse(`chmod g-w ${shellPath(walked)}, or install acl`);
          if (gap) refuse();
        }
      }
    }
    return use(fd);
  } finally { for (const fd of fds.reverse()) closeSync(fd); }
}
function identity(fd: number): string {
  const st = fstatSync(fd, { bigint: true });
  return `${st.dev}:${st.ino}:${st.mode}:${st.uid}`;
}
function file(path: string, candidate = false): { text: string; pin: string } {
  return physical(path, false, (fd) => {
    if (fstatSync(fd).size > cap) refuse();
    const bytes = Buffer.alloc(cap + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, null);
      if (!n) break;
      count += n;
    }
    if (count > cap) refuse();
    const content = bytes.subarray(0, count).toString("utf8");
    return { text: content, pin: `${identity(fd)}:${createHash("sha256").update(content).digest("hex")}` };
  }, candidate);
}
function words(value: string): string[] {
  if (/[\\$%\x00-\x1f\x7f]/.test(value)) refuse();
  const result: string[] = [];
  let current = "", quote = "", active = false;
  for (const ch of value) {
    if (quote) { if (ch === quote) quote = ""; else current += ch; }
    else if (ch === '"' || ch === "'") { quote = ch; active = true; }
    else if (/\s/.test(ch)) { if (active) { result.push(current); current = ""; active = false; } }
    else { current += ch; active = true; }
  }
  if (quote) refuse();
  if (active) result.push(current);
  return result;
}
function absent(path: string): boolean { return lstatSync(path, { throwIfNoEntry: false }) === undefined; }
function inspect(unitPath: string, service: string, roots: string[]): ServiceLoginStore | undefined {
  const key = /^cotal-manager@([a-f0-9]+)\.service$/.exec(service)?.[1];
  const space = key ? spaceFromKey(key) : undefined;
  if (!space) return undefined;
  if (lstatSync(unitPath).isSymbolicLink()) refuse();
  const candidate = file(unitPath, true);
  const unit = candidate;
  if (!unit.text.startsWith("# installed by `cotal service install`\n") || !unit.text.includes(`# cotal-mesh: ${space}\n`)) refuse();
  if (file(unitPath).pin !== unit.pin) refuse();
  const sources = new Map([[unitPath, unit.pin]]);
  const noDropins: string[] = [];
  for (const root of roots) {
    for (const name of ["service.d", `${service}.d`, ...(service.includes("@") ? [`${service.split("@")[0]}@.service.d`] : []), ...service.slice(0, -8).split("-").slice(0, -1).map((_, i, a) => `${a.slice(0, i + 1).join("-")}-.service.d`)]) {
      const p = join(root, name); if (!absent(p)) throw new LocalOverrides(); noDropins.push(p);
    }
  }
  let section = "";
  const directives = new Map<string, string[]>();
  for (const raw of unit.text.split("\n")) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    if (/^\[[^\]]+\]$/.test(line)) { section = line; continue; }
    if (section !== "[Service]") continue;
    const match = /^([A-Za-z]+)=(.*)$/.exec(line); if (!match) refuse();
    const list = directives.get(match[1]!) ?? []; list.push(match[2]!); directives.set(match[1]!, list);
  }
  const start = directives.get("ExecStart");
  if (!start || start.length !== 1) refuse();
  const argv = words(start[0]!);
  if (argv.some((arg) => arg === "--session-directory" || arg.startsWith("--session-directory="))) refuse();
  const executable = argv[0] ?? "";
  if (!/(?:^|\/)(?:cotal|node|nodejs)(?:\.ts|\.js)?$/.test(executable)) refuse();
  if (!argv.includes("supervise") || !argv.some((a) => /(?:^|\/)cotal(?:\.ts|\.js)?$/.test(a)) || argv.some((a) => /(?:^|\/)(?:sh|bash|env)$/.test(a))) refuse();
  for (const key of ["User", "DynamicUser", "RootDirectory", "RootImage", "BindPaths", "BindReadOnlyPaths", "TemporaryFileSystem", "UnsetEnvironment", "PassEnvironment", "PAMName", "EnvironmentDirectory", "ExecStartPre", "ExecCondition"]) if (directives.has(key)) refuse();
  let directory: string | undefined;
  const assign = (entry: string) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(entry); if (!m) refuse();
    if (m[1] === "COTAL_HOME") { if (directory !== undefined) refuse(); directory = m[2]!; }
  };
  for (const value of directives.get("Environment") ?? []) { if (!value) refuse(); for (const entry of words(value)) assign(entry); }
  for (const value of directives.get("EnvironmentFile") ?? []) {
    const paths = words(value); if (paths.length !== 1) refuse();
    const path = paths[0]!; if (!isAbsolute(path) || /[*?\[\]]/.test(path)) refuse();
    const env = file(path); sources.set(path, env.pin);
    for (const raw of env.text.split("\n")) {
      const line = raw.trim(); if (!line || /^[#;]/.test(line)) continue;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line); if (!m) refuse();
      if (m[1] !== "COTAL_HOME") continue;
      const values = words(m[2]!); if (values.length !== 1) refuse(); assign(`COTAL_HOME=${values[0]}`);
    }
  }
  if (!directory || directory === "/") refuse();
  const pin = physical(directory, true, identity);
  const store = Object.freeze({ service, directory, unitPath });
  proofs.set(store, () => {
    for (const [path, expected] of sources) if (file(path).pin !== expected) refuse();
    if (physical(store.directory, true, identity) !== pin || noDropins.some((p) => !absent(p))) refuse();
  });
  return store;
}

/** Discover proven stores independently, reporting optional units that could not be proved. Never reads sessions. */
export function serviceLoginStoresReport(): ServiceLoginStoresReport {
  if (process.platform !== "linux") return { stores: [], skipped: [] };
  const roots = [...new Set([join(homedir(), ".config/systemd/user"), ...(process.env.XDG_CONFIG_HOME ? [join(process.env.XDG_CONFIG_HOME, "systemd/user")] : [])])];
  const stores: ServiceLoginStore[] = [];
  const skipped: SkippedServiceLoginStore[] = [];
  const names = new Set<string>();
  const candidates: { root: string; entries: string[] }[] = [];
  try {
    for (const root of roots) {
      if (absent(root)) continue;
      const entries = physical(root, true, (fd) => readdirSync(`/proc/self/fd/${fd}`));
      if (entries.length > 1024) refuse();
      candidates.push({ root, entries });
    }
  } catch (error) {
    // An unreadable search root could conceal an override of any candidate.
    return { stores: [], skipped: [unproven(error)] };
  }
  for (const { root, entries } of candidates) {
    for (const service of entries.sort()) {
      if (!/^cotal-manager@[a-f0-9]+\.service$/.test(service)) continue;
      if (names.has(service)) {
        const previous = stores.findIndex(store => store.service === service);
        if (previous !== -1) stores.splice(previous, 1);
        skipped.push({ service, reason: "unproven" });
        continue;
      }
      names.add(service);
      try {
        const store = inspect(join(root, service), service, roots);
        if (store) stores.push(store);
      } catch (error) {
        skipped.push(error instanceof LocalOverrides ? { service, reason: "local-overrides" } : unproven(error, service));
      }
    }
  }
  return { stores, skipped };
}

/** Strict discovery refuses if any candidate or search root cannot be proved. */
export function serviceLoginStores(): ServiceLoginStore[] {
  const report = serviceLoginStoresReport();
  if (report.skipped.length) refuse();
  return report.stores;
}

/** Revalidate this exact discovery result immediately before writing an auth session. */
export function assertServiceLoginStore(store: ServiceLoginStore): void {
  const check = proofs.get(store); if (!check) refuse(); check();
}

/** Execute credential IO relative to a pinned physical private directory. Replacing its path
 * cannot redirect the transaction to another account's store. */
export function withServiceLoginStore<T>(store: ServiceLoginStore, run: (directory: string) => T): T {
  assertServiceLoginStore(store);
  return physical(store.directory, true, fd => {
    assertServiceLoginStore(store);
    return run(`/proc/self/fd/${fd}`);
  });
}

/** Recovery text names a service only when its current protected unit proves the store. */
export function serviceLoginRecovery(idp: string, directory?: string, manager = process.argv.includes("supervise")): string {
  const command = loginRecoveryCommand(idp);
  if (directory === undefined) return `run \`${command}\` to sign in again`;
  try {
    const store = serviceLoginStoresReport().stores.find((s) => s.directory === directory);
    if (store) { assertServiceLoginStore(store); return `Manager service ${JSON.stringify(store.service)} uses a separate sign-in store; run \`${command}\``; }
  } catch { /* Unproven service names must not appear in recovery advice. */ }
  return manager && directory !== userCotalDir() ? `Manager sign-in store ${JSON.stringify(directory)}: run \`COTAL_HOME='${directory.replaceAll("'", "'\\''")}' ${command}\` to sign in again` : `run \`${command}\` to sign in again`;
}
