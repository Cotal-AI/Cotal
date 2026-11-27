import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { acquireWindowsSeatStoreFence, cleanupWindowsIdleTasks, inspectWindowsSeatOccupancy } from "@cotal-ai/seat";
import { CommandFailure, executionIdentity } from "@cotal-ai/workspace";

/** A local, read-only generation gate. Does not signal a host or depend on the mesh. */
export function windowsDetachedSeatOccupancy(installation?: string, mode: "occupancy" | "retention" = "occupancy"): "empty" | "held" | "unknown" {
  if (process.platform !== "win32") return "empty";
  try {
    const install = installation ?? loadedWindowsInstallation();
    return install ? inspectWindowsSeatOccupancy(install, mode) : "empty";
  } catch { return "unknown"; }
}

function loadedWindowsInstallation(): string | undefined {
  const identity = executionIdentity();
  if (!identity) return undefined;
  const root = dirname(dirname(identity.logicalEntry));
  return lstatSync(join(root, "desktop-runtime.json"), { throwIfNoEntry: false })?.isFile() ? dirname(root) : root;
}

export function acquireWindowsCustodyCleanup() {
  if (process.platform !== "win32") return undefined;
  const installation = loadedWindowsInstallation();
  if (!installation) return undefined;
  const release = acquireWindowsSeatStoreFence(installation);
  if (!release) return undefined;
  return { release, occupancy: () => inspectWindowsSeatOccupancy(installation), async cleanup() {
    const deadline = Date.now() + 7_000;
    while (inspectWindowsSeatOccupancy(installation, "retention") !== "empty") {
      if (Date.now() >= deadline) throw new Error("Windows PTY hosts did not confirm idle retirement");
      await delay(250);
    }
    cleanupWindowsIdleTasks(installation);
  } };
}

/** The updater must not load a native binary it is about to replace. */
export function observeWindowsDetachedSeatsForUpdate(): "empty" | "held" | "unknown" {
  if (process.platform !== "win32") return "empty";
  try {
    const install = loadedWindowsInstallation();
    if (!install) return "empty";
    const script = "const { windowsDetachedSeatOccupancy } = await import(process.argv[1]); process.stdout.write(windowsDetachedSeatOccupancy(process.argv[2]));";
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script, import.meta.url, install], {
      encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 4096, stdio: ["ignore", "pipe", "ignore"],
    });
    return result.status === 0 && (result.stdout === "empty" || result.stdout === "held") ? result.stdout : "unknown";
  } catch { return "unknown"; }
}

export function assertWindowsUpdateCustodyIdle(): void {
  const result = observeWindowsDetachedSeatsForUpdate();
  if (result === "unknown") throw new Error("Windows PTY custody could not confirm an empty inventory");
  if (result === "held") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "detached Windows PTY seats remain active", {
    remedy: "save their work, stop the held seats, then run `cotal update --self` again",
  });
}
