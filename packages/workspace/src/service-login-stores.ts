import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { loginRecoveryCommand } from "./cloud-login.js";
import { homeCotalDir } from "./cotal-home.js";
import { isAbsolute, join, resolve } from "node:path";

/** A proven same-user Manager unit and its explicit private sign-in directory. */
export interface ServiceLoginStore {
  readonly service: string;
  readonly directory: string;
  readonly unitPath: string;
}
const proofs = new WeakMap<ServiceLoginStore, () => void>();
const cap = 128 * 1024;
function refuse(): never { throw new Error("Manager service sign-in discovery refused an ambiguous or unprotected unit/store; use an explicit protected COTAL_HOME after inspecting the service configuration"); }

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
    for (const [i, part] of parts.entries()) {
      const last = i === parts.length - 1;
      fd = openSync(`/proc/self/fd/${fd}/${part}`, constants.O_RDONLY | constants.O_NOFOLLOW | (last && !directory ? constants.O_NONBLOCK : constants.O_DIRECTORY));
      fds.push(fd);
      const st = fstatSync(fd);
      if ((!last || directory) ? !st.isDirectory() : !st.isFile()) refuse();
      if (last ? st.uid !== uid : st.uid !== uid && st.uid !== 0) refuse();
      if (!(candidate && last && !directory) && (st.mode & 0o022) !== 0 && !(st.uid === 0 && st.isDirectory() && (st.mode & 0o1000))) refuse();
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
  const legacy = /^cotal-manager@[a-f0-9]+\.service$/.test(service);
  // Aliased unrelated units are not discovery roots. A legacy alias is ambiguous.
  if (lstatSync(unitPath).isSymbolicLink()) { if (legacy) refuse(); return undefined; }
  const candidate = file(unitPath, true);
  const unit = candidate;
  if (!legacy && !/^\s*ExecStart\s*=.*\bcotal(?:\.ts|\.js)?(?:["']?\s).*\bsupervise\b/m.test(unit.text)) return undefined;
  if (file(unitPath).pin !== unit.pin) refuse();
  const sources = new Map([[unitPath, unit.pin]]);
  const noDropins: string[] = [];
  for (const root of roots) {
    for (const name of ["service.d", `${service}.d`, ...(service.includes("@") ? [`${service.split("@")[0]}@.service.d`] : []), ...service.slice(0, -8).split("-").slice(0, -1).map((_, i, a) => `${a.slice(0, i + 1).join("-")}-.service.d`)]) {
      const p = join(root, name); if (!absent(p)) refuse(); noDropins.push(p);
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

/** Discover only explicit Manager stores in this user's standard unit directories. Never reads sessions. */
export function serviceLoginStores(): ServiceLoginStore[] {
  if (process.platform !== "linux") return [];
  const roots = [...new Set([join(homedir(), ".config/systemd/user"), ...(process.env.XDG_CONFIG_HOME ? [join(process.env.XDG_CONFIG_HOME, "systemd/user")] : [])])];
  const stores: ServiceLoginStore[] = [];
  const names = new Set<string>();
  for (const root of roots) {
    if (absent(root)) continue;
    const entries = physical(root, true, (fd) => readdirSync(`/proc/self/fd/${fd}`));
    if (entries.length > 1024) refuse();
    for (const service of entries.sort()) {
      if (!/^[A-Za-z0-9_.@:-]+\.service$/.test(service)) continue;
      const store = inspect(join(root, service), service, roots);
      if (!store) continue;
      if (names.has(service)) refuse(); names.add(service); stores.push(store);
    }
  }
  return stores;
}

/** Revalidate this exact discovery result immediately before writing an auth session. */
export function assertServiceLoginStore(store: ServiceLoginStore): void {
  const check = proofs.get(store); if (!check) refuse(); check();
}

/** Recovery text names a service only when its current protected unit proves the store. */
export function serviceLoginRecovery(idp: string, directory?: string): string {
  const command = loginRecoveryCommand(idp);
  if (directory === undefined) return `run \`${command}\` to sign in again`;
  try {
    const store = serviceLoginStores().find((s) => s.directory === directory);
    if (store) { assertServiceLoginStore(store); return `Manager service ${JSON.stringify(store.service)} uses a separate sign-in store; run \`${command}\``; }
  } catch { /* Unproven service names must not appear in recovery advice. */ }
  return directory !== homeCotalDir() ? `run \`COTAL_HOME='${directory.replaceAll("'", "'\\''")}' ${command}\` to sign in again` : `run \`${command}\` to sign in again`;
}
