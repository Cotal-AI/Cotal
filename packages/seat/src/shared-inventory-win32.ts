import { lstatSync, opendirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { windowsUserSid } from "./host.js";
import { inspectWindowsAliasRecord } from "./shared-alias-win32.js";
import { windowsWriterProof } from "./shared-control-win32.js";
import { checkWindowsCustodyRoot } from "./shared-files-win32.js";
import { readWindowsAttempt, readWindowsBootstrap, readWindowsHostPlan, windowsHostPlanPath, windowsHostRuntime } from "./shared-host-win32.js";
import { readWindowsHost, readWindowsPrivateRecord, readWindowsSeat, readWindowsSeatExit, windowsSeatWasRefused, type WindowsHostRecord } from "./shared-record-win32.js";
import { deriveWindowsSeatSlot, WINDOWS_SEAT_STORE_LOCK, windowsLineageDescriptorPath, windowsSeatStoreAddress, windowsSeatStorePresent, type WindowsSeatSlot } from "./shared-slot-win32.js";
import { windowsCustodyTask } from "./shared-task-win32.js";

export type WindowsSeatOccupancy = "held" | "empty" | "unknown";
type CensusMode = "occupancy" | "retention";
export interface WindowsIdleTask { slot: WindowsSeatSlot; session: number }
const HEX32 = /^[a-f0-9]{32}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const LIMIT = 2048;
const object = (row: unknown): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row);
const merge = (a: WindowsSeatOccupancy, b: WindowsSeatOccupancy): WindowsSeatOccupancy => a === "held" || b === "held" ? "held" : a === "unknown" || b === "unknown" ? "unknown" : "empty";

function* entries(path: string, budget: { remaining: number }): Generator<string> {
  checkWindowsCustodyRoot(path);
  const dir = opendirSync(path);
  try {
    for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
      if (--budget.remaining < 0) throw new Error("Windows PTY inventory exceeds its bound");
      yield entry.name;
    }
  } finally { dir.closeSync(); }
}

function exists(path: string): boolean {
  checkWindowsCustodyRoot(dirname(path));
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function lineage(store: string, path: string, sid: string): WindowsSeatSlot | undefined {
  const result = readWindowsPrivateRecord(windowsLineageDescriptorPath(path), 8192);
  if (result.state !== "verified") return;
  const row = result.value;
  if (!object(row) || row.version !== 1 || row.sid !== sid || typeof row.installation !== "string" || !/^[a-z]:\\/.test(row.installation) ||
      row.installation !== row.installation.toLowerCase() || resolve(row.installation) !== row.installation ||
      typeof row.space !== "string" || !row.space || row.space.includes("\0")) return;
  const anchor = deriveWindowsSeatSlot(store, row.installation, sid, row.space, "0".repeat(64));
  return anchor.lineage === path ? anchor : undefined;
}

function aliasOccupancy(anchor: WindowsSeatSlot, budget: { remaining: number }): WindowsSeatOccupancy {
  const aliases = join(anchor.lineage, "aliases");
  if (!exists(aliases)) return "empty";
  let result: WindowsSeatOccupancy = "empty";
  for (const leaf of entries(aliases, budget)) {
    if (leaf === "aliases.lock") continue;
    const state = /^[a-f0-9]{32}\.json$/.test(leaf) ? inspectWindowsAliasRecord(join(aliases, leaf), anchor) : "unknown";
    result = merge(result, state === "clear" ? "empty" : state);
  }
  return result;
}

function seatOccupancy(slot: WindowsSeatSlot, id: string): WindowsSeatOccupancy {
  const directory = join(slot.root, id);
  const seat = readWindowsPrivateRecord(join(directory, "shared.json"));
  const refusal = readWindowsPrivateRecord(join(directory, "not-admitted.json"), 2048);
  const source = seat.state === "verified" ? seat.value : refusal.state === "verified" ? refusal.value : undefined;
  if (!object(source) || !object(source.host)) return "unknown";
  const host = source.host as unknown as WindowsHostRecord;
  if (seat.state === "verified" && refusal.state === "absent") {
    if (readWindowsSeatExit(slot, id, host).state === "verified") return "empty";
    const row = readWindowsSeat(slot, id, host);
    if (row.state === "verified" && windowsWriterProof.observe(row.value.child) === "live") return "held";
  }
  if (seat.state === "absent" && refusal.state === "verified" && windowsSeatWasRefused(slot, id, host).state === "verified") return "empty";
  return "unknown";
}

function hostOccupancy(slot: WindowsSeatSlot, budget: { remaining: number; tasks: number }, mode: CensusMode, idle?: WindowsIdleTask[]): WindowsSeatOccupancy {
  const host = readWindowsHost(slot), attempt = readWindowsAttempt(slot.root);
  const hostLife = host.state === "verified" ? windowsWriterProof.observe(host.value) : undefined;
  let result: WindowsSeatOccupancy = "empty";
  if (host.state === "verified") {
    if (hostLife === "live" && mode === "retention") return "held";
    if (hostLife === "unknown" || (hostLife === "live" && attempt.state !== "verified")) result = "unknown";
  } else if (host.state === "unknown") result = "unknown";
  if (attempt.state === "verified") {
    const receipt = readWindowsBootstrap(slot.root, attempt.value);
    if (!receipt) result = "unknown";
    else {
      const life = windowsWriterProof.observe(receipt.host);
      if (life === "live" && mode === "retention") return "held";
      if (life === "unknown" || (life === "live" && (receipt.outcome !== "ready" || host.state !== "verified" ||
          host.value.token !== receipt.host.token || !windowsWriterProof.same(host.value, receipt.host)))) result = "unknown";
      if (hostLife === "live" && life !== "live") result = "unknown";
    }
  } else if (attempt.state === "unknown") result = "unknown";
  const plan = readWindowsPrivateRecord(windowsHostPlanPath(slot.root), 4096);
  if (plan.state === "unknown" || (plan.state === "absent" && (host.state !== "absent" || attempt.state !== "absent" || exists(join(slot.root, "task.xml"))))) result = "unknown";
  if (plan.state === "verified") {
    const taskPlan = readWindowsHostPlan(slot.root, slot.name);
    if (taskPlan.slot.key !== slot.key || taskPlan.slot.generation !== slot.generation || taskPlan.slot.lineage !== slot.lineage) return "unknown";
    if (mode === "retention") {
      if (--budget.tasks < 0) return "unknown";
      const task = windowsCustodyTask(slot, windowsHostRuntime(slot), taskPlan.session).inspect();
      if (task.present && task.instances > 0) return "held";
      if (!task.present && exists(join(slot.root, "task.xml"))) result = "unknown";
      if (task.present && task.instances === 0) idle?.push({ slot, session: taskPlan.session });
    }
  }
  for (const leaf of entries(slot.root, budget)) {
    if (HEX32.test(leaf)) result = merge(result, seatOccupancy(slot, leaf));
    else if (!["host.json", "host.lock", "launch.json", "start.lock", "attempt.json", "bootstrap.json", "task.xml"].includes(leaf)) result = "unknown";
  }
  return result;
}

/** Point-in-time only. A destructive caller must fence producers and scan again under exclusion. */
export function inspectWindowsSeatOccupancy(installation: string, mode: CensusMode = "occupancy"): WindowsSeatOccupancy {
  return inspect(installation, mode);
}

/** Call under producer exclusion, then reverify each task while still fenced before removing it. */
export function enumerateWindowsIdleTasks(installation: string): readonly WindowsIdleTask[] | undefined {
  const idle: WindowsIdleTask[] = [];
  return inspect(installation, "retention", idle) === "empty" ? idle : undefined;
}

/** Requires the caller's store fence and stopped admissions. Never ends a task or removes a custody directory. */
export function cleanupWindowsIdleTasks(installation: string): void {
  const tasks = enumerateWindowsIdleTasks(installation);
  if (!tasks) throw new Error("Windows PTY task custody is not verified idle");
  for (const { slot, session } of tasks) {
    const removed = windowsCustodyTask(slot, windowsHostRuntime(slot), session).removeIdle();
    if (removed.present || exists(join(slot.root, "task.xml"))) throw new Error("Windows PTY task removal was not confirmed");
  }
}

function inspect(installation: string, mode: CensusMode, idle?: WindowsIdleTask[]): WindowsSeatOccupancy {
  if (process.platform !== "win32") return "unknown";
  try {
    const address = windowsSeatStoreAddress(installation);
    if (!windowsSeatStorePresent(address)) return "empty";
    const { root: store, installation: install } = address;
    const sid = windowsUserSid(), budget = { remaining: LIMIT, tasks: 32 };
    let result: WindowsSeatOccupancy = "empty";
    const anchors: WindowsSeatSlot[] = [], lineages = join(store, "lineages");
    if (exists(lineages)) for (const leaf of entries(lineages, budget)) {
      const anchor = HEX32.test(leaf) ? lineage(store, join(lineages, leaf), sid) : undefined;
      if (!anchor) { result = "unknown"; continue; }
      anchors.push(anchor);
      if (anchor.installation === install) result = merge(result, aliasOccupancy(anchor, budget));
    }
    for (const generation of entries(store, budget)) {
      if (generation === "lineages" || generation === "artifacts" || generation === WINDOWS_SEAT_STORE_LOCK || /^\.stage-[a-f0-9]{32}$/.test(generation)) continue;
      if (!HEX64.test(generation)) { result = merge(result, "unknown"); continue; }
      const generationRoot = join(store, generation), hosts = join(generationRoot, "hosts");
      if (!exists(hosts)) continue;
      budget.remaining -= anchors.length;
      if (budget.remaining < 0) return "unknown";
      const slots = new Map(anchors.map(anchor => {
        const slot = deriveWindowsSeatSlot(store, anchor.installation, sid, anchor.space, generation);
        return [slot.key, slot];
      }));
      for (const key of entries(hosts, budget)) {
        const slot = slots.get(key);
        if (!slot) result = merge(result, "unknown");
        else if (slot.installation === install) result = merge(result, hostOccupancy(slot, budget, mode, idle));
      }
    }
    return result;
  } catch { return "unknown"; }
}
