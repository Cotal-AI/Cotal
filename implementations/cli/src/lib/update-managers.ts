import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { endianness } from "node:os";
import { assertLifecycleToken } from "@cotal-ai/core";
import {
  assertRecordIdentity, brokerAddressKey, commandIsCotalSupervisor, identityRecord,
  MANAGER_PIDFILE, readMeshRegistry, readProcessCommand, recordedLocalProcessPaths,
  readProcessRecord, spaceKey, spaceSegment, type ProcessIdentityRecord,
} from "@cotal-ai/workspace";
import { entryScript } from "../seed/paths.js";
import { observeServiceProcess, serviceInstances } from "./service-instances.js";
import { isCliEntry } from "./manager-proc.js";
import { serviceDefinitionStore } from "./service-definitions.js";

export interface UpdateManager {
  readonly pid: number;
  readonly root: string;
  readonly space: string;
  readonly server: string;
  readonly instanceId: string;
  readonly process?: ProcessIdentityRecord;
}

function blocked(detail: string): never {
  throw new Error(`local Manager continuity cannot be established: ${detail}; inspect the named local process and restore its identity record before retrying; no Manager instance was guessed`);
}

/** Read identity coordinates only. Unlike startup readers this never migrates or creates state. */
export function readUpdateManagerIdentity(root: string, space: string): string {
  const files = [join(root, ".cotal", `remote-manager.${spaceKey(space)}.json`),
    join(root, ".cotal", spaceSegment(space), "manager-instance.json"),
    join(root, ".cotal", "auth", `manager-instance.${spaceKey(space)}.json`)];
  const found: string[] = [];
  for (const file of files) {
    let stat;
    try { stat = lstatSync(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; return blocked(`cannot inspect ${file}`); }
    if (!stat.isFile() || stat.isSymbolicLink()) blocked(`identity is not a regular file: ${file}`);
    let value: { v?: unknown; instanceId?: unknown; space?: unknown; lifecycleUid?: unknown; identities?: Record<string, unknown>; serveIdentity?: unknown };
    try { value = JSON.parse(readFileSync(file, "utf8")); }
    catch { return blocked(`unreadable identity ${file}`); }
    if (!value || typeof value.instanceId !== "string" || value.space !== undefined && value.space !== space) blocked(`invalid identity ${file}`);
    const identity = (input: unknown): boolean => {
      const key = input as { id?: unknown; seed?: unknown } | null;
      return Boolean(key && typeof key.id === "string" && key.id && typeof key.seed === "string" && key.seed);
    };
    if (file === files[0]) {
      if (value.v !== 1 || value.space !== space || typeof value.lifecycleUid !== "string" || !value.identities || !["supervisor", "executor", "serve", "goalWriter", "sessionLedger"].every(key => identity(value.identities![key]))) blocked(`invalid remote identity ${file}`);
    } else if (!identity(value.serveIdentity)) blocked(`invalid local identity ${file}`);
    try { assertLifecycleToken(value.instanceId); } catch { return blocked(`invalid instance ID in ${file}`); }
    found.push(value.instanceId);
  }
  if (!found.length) blocked(`missing identity for space ${space} in ${root}: expected ${files.join(" or ")}`);
  if (new Set(found).size !== 1) blocked(`conflicting identities in ${files.join(", ")}`);
  return found[0]!;
}

function option(argv: readonly string[], key: string): string | undefined {
  const index = argv.indexOf(`--${key}`);
  return index >= 0 ? argv[index + 1] : argv.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3);
}

/** Render the pinned Linux start time using the kernel's clock frequency, without requiring ps. */
function managerStarted(token: string | undefined): string {
  if (token === undefined) return "unavailable (no process creation pin)";
  try {
    const aux = readFileSync("/proc/self/auxv");
    const width = process.arch === "ia32" || process.arch === "arm" ? 4 : 8;
    const word = (offset: number): number => width === 8
      ? Number(endianness() === "LE" ? aux.readBigUInt64LE(offset) : aux.readBigUInt64BE(offset))
      : endianness() === "LE" ? aux.readUInt32LE(offset) : aux.readUInt32BE(offset);
    let ticksPerSecond: number | undefined;
    for (let offset = 0; offset + 2 * width <= aux.length; offset += 2 * width) {
      if (word(offset) === 17) { ticksPerSecond = word(offset + width); break; } // AT_CLKTCK
    }
    const boot = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1];
    if (!boot || !ticksPerSecond || !Number.isSafeInteger(ticksPerSecond) || !/^\d+$/.test(token)) throw new Error("unreadable kernel clock");
    return `${new Date((Number(boot) + Number(token) / ticksPerSecond) * 1000).toISOString()} (approximate, start token ${token})`;
  } catch {
    return `unavailable (start token ${token} clock ticks since boot)`;
  }
}

function unprovenManagerEntry(pid: number, argv: readonly string[], cwd: string | undefined, pin: ProcessIdentityRecord | { pid: number }): never {
  const command = argv.findIndex(arg => ["supervise", "__daemon-manager", "__service-manager", "__machine-manager"].includes(arg));
  // Report observed launch arguments, not an invented canonical target for a deleted symlink.
  const paths = argv.slice(1, command < 0 ? undefined : command).filter(arg => !arg.startsWith("-"));
  const entries = paths.map(arg => {
    const path = isAbsolute(arg) ? arg : cwd && !cwd.endsWith(" (deleted)") ? resolve(cwd, arg) : undefined;
    if (!path) return `${JSON.stringify(arg)} (cannot resolve from working directory)`;
    try { realpathSync(path); return `${JSON.stringify(arg)} (exists)`; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return `${JSON.stringify(arg)} (${code === "ENOENT" || code === "ENOTDIR" ? "path is gone" : `cannot inspect: ${code ?? "unknown error"}`})`;
    }
  });
  throw new Error(`local Manager continuity cannot be established: Manager pid ${pid} has no proven CLI entry for this installation; started ${managerStarted("token" in pin ? pin.token : undefined)}; working directory ${JSON.stringify(cwd ?? "unavailable")}; launch entry arguments: ${entries.join(", ") || "unavailable"}; stop this process if it is a leftover, or run the update from the installation that owns it (restore that installation first if its launch entry is gone); a missing path does not prove another installation because it may have been a symlink into this one; no Manager instance was guessed`);
}

/** Install-wide candidates, independent of the selected mesh. Records supply roots, not liveness. */
export function localUpdateManagers(
  flags: { space?: unknown; server?: unknown; on?: unknown } = {},
  installedEntry: string = entryScript(),
): UpdateManager[] {
  if (process.platform !== "linux") throw new Error("install-wide Manager process census is supported only on Linux");
  const registry = readMeshRegistry();
  if (registry.unusable.length) throw registry.unusable[0];
  const entries = registry.entries;
  const matches = (space: string, server: string) =>
    (typeof flags.space !== "string" || flags.space === space) &&
    (typeof flags.server !== "string" || brokerAddressKey(flags.server) === brokerAddressKey(server));
  const known = new Map<number, { root: string; space: string; server: string }>();
  for (const entry of entries) {
    if (!matches(entry.space, entry.server)) continue;
    for (const path of recordedLocalProcessPaths(MANAGER_PIDFILE, entry.root)) {
      if (path.space && typeof flags.space === "string" && path.space !== flags.space) continue;
      if (path.unread) blocked(`${path.path}: ${path.unread}`);
      const record = readProcessRecord(path.path, commandIsCotalSupervisor);
      if (record.state === "unknown" || record.state === "unattributable") blocked(`unresolved process record ${path.path}`);
      if (record.state === "alive" && path.space) {
        const owner = entries.find(candidate => candidate.space === path.space);
        if (!owner) blocked(`Manager pid ${record.pid} in ${path.path} has no registered broker for ${path.space}`);
        known.set(record.pid, { root: entry.root, space: path.space, server: owner.server });
      }
    }
    for (const row of serviceInstances(entry.space)) {
      const instance = row.record.value;
      const definition = serviceDefinitionStore(entry.space).read(instance.definition)?.record.value;
      if (definition?.launch.type !== "adapter" || definition.launch.adapter !== "manager-service") continue;
      const state = observeServiceProcess(instance);
      if (["unreadable", "unresolved-launch", "members-running"].includes(state)) blocked(`unresolved Manager service ${instance.instanceId} in ${entry.space}`);
      if (state !== "running" || !instance.process) continue;
      const root = definition.root ?? definition.launch.options.root;
      if (typeof root !== "string") blocked(`Manager service ${instance.instanceId} has no root`);
      const server = definition.launch.options.server;
      known.set(instance.process.pid, { root, space: entry.space, server: typeof server === "string" ? server : entry.server });
    }
  }
  const pids = new Set(known.keys());
  {
    // `ps` is missing from slim images and narrow PATHs; /proc is always there.
    let entries: string[];
    try { entries = readdirSync("/proc"); }
    catch { blocked("the process table could not be listed"); }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      let command: string;
      try { command = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean).join(" "); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ESRCH") continue;
        try { if (lstatSync(`/proc/${entry}`).uid !== process.getuid?.()) continue; }
        catch { continue; }
        blocked(`cannot read the command of pid ${entry}`);
      }
      if (commandIsCotalSupervisor(command) || /(?:^|\s)__machine-manager(?:\s|$)/.test(command)) pids.add(Number(entry));
    }
  }
  const ownEntry = realpathSync(installedEntry);
  const result = new Map<string, UpdateManager>();
  for (const pid of pids) {
    if (process.platform === "linux" && process.getuid) {
      try { if (lstatSync(`/proc/${pid}`).uid !== process.getuid()) continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; blocked(`cannot inspect process owner for pid ${pid}`); }
    }
    const pin = identityRecord(pid);
    const command = readProcessCommand(pid);
    if (command.kind === "gone") continue;
    if (command.kind !== "command") blocked(`cannot read argv for Manager pid ${pid}`);
    let argv = command.command.split(/\s+/), cwd: string | undefined;
    let env: Record<string, string> = {};
    if (process.platform === "linux") {
      try {
        argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
        cwd = readlinkSync(`/proc/${pid}/cwd`);
        env = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(value => value.includes("=")).map(value => { const split = value.indexOf("="); return [value.slice(0, split), value.slice(split + 1)]; }));
      } catch { if ("token" in pin && assertRecordIdentity(pin).kind === "gone") continue; blocked(`cannot read launch coordinates for Manager pid ${pid}`); }
    }
    if (process.platform === "linux" && !argv.some(arg => ["supervise", "__daemon-manager", "__service-manager", "__machine-manager"].includes(arg))) continue;
    let loaded = false;
    for (const arg of argv) {
      if (!isAbsolute(arg) && !cwd) continue;
      try { if (realpathSync(isAbsolute(arg) ? arg : resolve(cwd!, arg)) === ownEntry) loaded = true; } catch { /* Non-path argv is not install evidence. */ }
    }
    if (!loaded) {
      // A different resolvable cotal entry is affirmative evidence of another installation.
      const other = argv.some(arg => {
        if (!isAbsolute(arg) && !cwd) return false;
        try { const path = realpathSync(cwd ? resolve(cwd, arg) : arg); return path !== ownEntry && isCliEntry(path); }
        catch { return false; }
      });
      if (other) continue;
      unprovenManagerEntry(pid, argv, cwd, pin);
    }
    const recorded = known.get(pid);
    const hostedHome = argv.includes("__machine-manager") ? option(argv, "session-directory") : undefined;
    const hostedSpace = option(argv, "space");
    const root = hostedHome && hostedSpace ? join(hostedHome, "daemon", spaceSegment(hostedSpace), "manager") : option(argv, "root") ?? recorded?.root ?? cwd;
    const space = option(argv, "space") ?? env.COTAL_SPACE ?? recorded?.space;
    if (space && typeof flags.space === "string" && flags.space !== space) continue;
    if (!root || !space) blocked(`Manager pid ${pid} has no proven root or space`);
    const entry = entries.find(value => value.space === space);
    const server = option(argv, "server") ?? env.COTAL_SERVER ?? recorded?.server ?? entry?.server;
    if (!server) blocked(`Manager pid ${pid}, root ${root}, space ${space} has no broker address`);
    if (!matches(space, server)) continue;
    if (!("token" in pin) || assertRecordIdentity(pin).kind !== "match") blocked(`Manager pid ${pid} changed or has no process creation identity`);
    const instanceId = readUpdateManagerIdentity(root, space);
    if (typeof flags.on === "string" && instanceId !== flags.on) continue;
    const candidate = { pid, root, space, server, instanceId, process: pin };
    result.set(JSON.stringify([brokerAddressKey(server) ?? server, space, instanceId]), candidate);
  }
  return [...result.values()];
}
