import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { SharedManagerIdentity } from "./shared-control-server.js";
import { isSharedScope, recordedProcess } from "./shared-record.js";

const run = promisify(execFile);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const seatRoot = () => resolve(process.env.COTAL_SEAT_ROOT ?? join(homedir(), ".cotal", "seats"));
export const sharedPtyLineage = (entry: string, space: string): string =>
  join(seatRoot(), `p-${digest([entry, process.getuid?.(), space])}`);

// Cross-release custody contract. Later Managers must still recognize these installation tags,
// unit names, Description records and cgroups to find and drain hosts from this release.
// The daemon home separates installations' unit authority. The calling shell's seat-root
// override is not inherited by hosted Managers and must not affect which units a drain sees.
export const sharedInstallationTag = (entry: string, uid: number | undefined, daemonHome: string): string =>
  digest([entry, uid, daemonHome]);

export const sharedPtyInstallation = (entry: string, daemonHome = join(homedir(), ".cotal")): string =>
  sharedInstallationTag(entry, process.getuid?.(), resolve(daemonHome));

export const sharedUnitPrefix = (tag: string): string => `cotal-pty-${tag.slice(0, 16)}`;

export function sharedUnitDescription(tag: string, lineage: string, owner: SharedManagerIdentity): string {
  return `Cotal shared PTY ${tag} ${basename(lineage)} ${owner.pid} ${owner.start} ${owner.bootId}`;
}

export function parseSharedUnitDescription(text: string): { tag: string; lineage: string; owner: SharedManagerIdentity } | undefined {
  const match = /^Cotal shared PTY ([a-f0-9]{64}) (p-[a-f0-9]{64}) (\d+) (\d+) ([a-f0-9-]{36})$/.exec(text);
  const pid = Number(match?.[3]);
  if (!match) return undefined;
  return { tag: match[1]!, lineage: match[2]!, owner: { pid, start: match[4]!, bootId: match[5]! } };
}

export function sharedUnitCgroup(scope: string, uid = process.getuid?.()): string {
  return `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${scope}`;
}

function isAbsent(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
class SharedPtyOwnerPresent extends Error {}

const userUnitCgroup = () => `/sys/fs/cgroup/user.slice/user-${process.getuid?.()}.slice/user@${process.getuid?.()}.service`;

/** Read-only fallback for a stopped daemon or a gap in its Manager process inventory. */
export function linuxSharedPtyMayBeActive(entry: string, home: string): boolean {
  if (process.platform !== "linux") return false;
  const prefix = sharedUnitPrefix(sharedPtyInstallation(entry, home));
  try { return readdirSync(`${userUnitCgroup()}/app.slice`).some(scope => isSharedScope(scope) && scope.startsWith(prefix) && sharedUnitPopulated(scope)); }
  catch (error) { if (isAbsent(error)) return false; throw error; }
}

export function sharedUnitPopulated(scope: string): boolean {
  try {
    const lines = readFileSync(`/sys/fs/cgroup${sharedUnitCgroup(scope)}/cgroup.events`, "utf8").split("\n");
    if (lines.includes("populated 0")) return false;
    if (lines.includes("populated 1")) return true;
    throw new Error("shared PTY unit population is unknown");
  } catch (error) { if (isAbsent(error)) return false; throw error; }
}

async function systemctl(args: string[]): Promise<string> {
  return (await run("/usr/bin/systemctl", ["--user", "--no-pager", "--no-ask-password", ...args], { encoding: "utf8", timeout: 6_000 })).stdout;
}

async function observeUnit(scope: string, tag: string, lineage?: string): Promise<SharedManagerIdentity | undefined> {
  let values: Map<string, string>;
  try {
    const output = await systemctl(["show", "-p", "Description", "-p", "Transient", "-p", "LoadState", "-p", "ControlGroup", "--", scope]);
    values = new Map(output.trimEnd().split("\n").map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  } catch (error) {
    if (!sharedUnitPopulated(scope)) return undefined;
    throw error;
  }
  if (values.get("LoadState") === "not-found" && !sharedUnitPopulated(scope)) return undefined;
  const description = parseSharedUnitDescription(values.get("Description") ?? "");
  const cgroup = values.get("ControlGroup");
  if (!description) {
    if (sharedUnitPopulated(scope)) throw new Error("shared PTY unit identity is unknown");
    return undefined;
  }
  if (description.tag !== tag || (lineage !== undefined && description.lineage !== basename(lineage))) return undefined;
  if (values.get("Transient") !== "yes" || (cgroup && cgroup !== sharedUnitCgroup(scope)) || !Number.isSafeInteger(description.owner.pid) || description.owner.pid <= 1)
    throw new Error("shared PTY unit identity is unknown");
  return description.owner;
}

async function drainUnit(scope: string): Promise<void> {
  await systemctl(["stop", "--", scope]).catch(error => { if (sharedUnitPopulated(scope)) throw error; });
  const deadline = performance.now() + 3_000;
  while (sharedUnitPopulated(scope)) {
    if (performance.now() >= deadline) throw new Error("shared PTY unit still holds local processes");
    await delay(25);
  }
}

/** Drain only matching transient units. An unproved or still-live predecessor blocks admission. */
export async function drainLinuxSharedPty(entry: string | undefined, space?: string, stop = false, knownManagers?: ReadonlySet<number>, daemonHome?: string): Promise<void> {
  if (!entry || process.platform !== "linux") return;
  const tag = sharedPtyInstallation(entry, daemonHome), lineage = space === undefined ? undefined : sharedPtyLineage(entry, space);
  const userCgroup = userUnitCgroup();
  if (!lstatSync(userCgroup, { throwIfNoEntry: false })) return;
  const prefix = sharedUnitPrefix(tag);
  const scopeMatches = (scope: unknown): scope is string => isSharedScope(scope) && scope.startsWith(prefix);
  let groups: string[];
  try { groups = readdirSync(`${userCgroup}/app.slice`).filter(scopeMatches); }
  catch (error) { if (!isAbsent(error)) throw error; groups = []; }
  let listed: string;
  try { listed = await systemctl(["list-units", "--all", "--plain", "--no-legend", `${prefix}*.service`]); }
  catch (error) {
    // With no user manager cgroup there is no independent service to drain.
    if (!groups.some(sharedUnitPopulated)) return;
    throw error;
  }
  const scopes = new Set([...groups, ...listed.trim().split("\n").map(line => line.trim().split(/\s+/, 1)[0]).filter(scopeMatches)]);
  await Promise.all([...scopes].map(async scope => {
    const owner = await observeUnit(scope, tag, lineage);
    if (!owner || (!stop && knownManagers?.has(owner.pid) && recordedProcess(owner.pid, owner.start, owner.bootId) === "live")) return;
    const life = recordedProcess(owner.pid, owner.start, owner.bootId);
    if (life !== "gone" && (!stop || life !== "live" || owner.pid !== process.pid))
      throw new SharedPtyOwnerPresent("a previous Manager's shared PTY unit has not stopped");
    await drainUnit(scope);
  }));
}

/** A surviving Manager may still be performing orderly teardown after parent disconnect. */
export async function awaitLinuxSharedPtyPredecessor(entry: string | undefined, space: string, home: string): Promise<void> {
  const deadline = performance.now() + 15_000;
  for (;;) {
    try { await drainLinuxSharedPty(entry, space, false, undefined, home); return; }
    catch (error) {
      if (!(error instanceof SharedPtyOwnerPresent) || performance.now() >= deadline) throw error;
      await delay(250);
    }
  }
}

export function linuxSharedCustodyAvailable(): boolean {
  if (process.platform !== "linux") return false;
  try {
    if (!lstatSync("/usr/bin/systemd-run").isFile() || !/^0::/m.test(readFileSync("/proc/self/cgroup", "utf8"))) return false;
    const check = spawnSync("/usr/bin/systemctl", ["--user", "show", "--property=Version", "--value"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    return check.status === 0 && /^\d/.test(check.stdout);
  } catch { return false; }
}
