import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
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
  throw new Error(`local Manager continuity cannot be established: ${detail}; inspect this local Manager and retry with --on <instanceId> after restoring its identity record`);
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

/** Install-wide candidates, independent of the selected mesh. Records supply roots, not liveness. */
export function localUpdateManagers(): UpdateManager[] {
  const registry = readMeshRegistry();
  if (registry.unusable.length) throw registry.unusable[0];
  const entries = registry.entries;
  const known = new Map<number, { root: string; space: string; server: string }>();
  for (const entry of entries) {
    for (const path of recordedLocalProcessPaths(MANAGER_PIDFILE, entry.root)) {
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
  if (process.platform !== "win32") {
    const ps = spawnSync("ps", ["-A", "-ww", "-o", "pid=,args="], { encoding: "utf8" });
    if (ps.error || ps.status !== 0) blocked("the process table could not be listed");
    for (const line of ps.stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (match && (commandIsCotalSupervisor(match[2]!) || /(?:^|\s)__machine-manager(?:\s|$)/.test(match[2]!))) pids.add(Number(match[1]));
    }
  }
  const ownEntry = realpathSync(entryScript());
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
      blocked(`Manager pid ${pid} has no proven CLI entry for this installation`);
    }
    const recorded = known.get(pid);
    const hostedHome = argv.includes("__machine-manager") ? option(argv, "session-directory") : undefined;
    const hostedSpace = option(argv, "space");
    const root = hostedHome && hostedSpace ? join(hostedHome, "daemon", spaceSegment(hostedSpace), "manager") : option(argv, "root") ?? recorded?.root ?? cwd;
    const space = option(argv, "space") ?? env.COTAL_SPACE ?? recorded?.space;
    if (!root || !space) blocked(`Manager pid ${pid} has no proven root or space`);
    const entry = entries.find(value => value.space === space);
    const server = option(argv, "server") ?? env.COTAL_SERVER ?? recorded?.server ?? entry?.server;
    if (!server) blocked(`Manager pid ${pid}, root ${root}, space ${space} has no broker address`);
    if (!("token" in pin) || assertRecordIdentity(pin).kind !== "match") blocked(`Manager pid ${pid} changed or has no process creation identity`);
    const instanceId = readUpdateManagerIdentity(root, space);
    const candidate = { pid, root, space, server, instanceId, process: pin };
    result.set(JSON.stringify([brokerAddressKey(server) ?? server, space, instanceId]), candidate);
  }
  return [...result.values()];
}
