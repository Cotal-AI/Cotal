import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { globalConfigDir } from "@cotal-ai/core";
import { launcherInstallRoot, logicalExecutionEntry } from "@cotal-ai/workspace";
import { repairInstallModes } from "../lib/install-umask.js";
import { c } from "../ui.js";
import { installedUpdatePrefix } from "./update-process.js";
import type { UpdateRuntime } from "./update.js";

function ownedInstallRoot(rt: UpdateRuntime): string | undefined {
  const launcher = launcherInstallRoot();
  if (launcher) return launcher;
  if (process.platform === "win32") return undefined;
  const logical = logicalExecutionEntry();
  if (!logical || rt.checkout()) return undefined;
  const packageRoot = dirname(dirname(logical));
  if (existsSync(join(packageRoot, "desktop-runtime.json"))) return undefined;
  try {
    return installedUpdatePrefix(packageRoot, logical) ? packageRoot : undefined;
  } catch {
    return undefined;
  }
}

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && code ? code : undefined;
}

/** Harden owned modes in Cotal's install and config roots while reporting filesystem failures as warnings. */
export function repairOwnedModes(rt: UpdateRuntime): boolean {
  const install = ownedInstallRoot(rt);
  let changed = false;
  for (const { what, root } of [...(install ? [{ what: "install", root: install }] : []), { what: "config", root: globalConfigDir() }]) {
    let repaired = 0;
    let failedCode: string | undefined;
    const onError = (error: NodeJS.ErrnoException): void => {
      failedCode ??= errorCode(error) ?? "UNKNOWN";
    };
    try {
      repaired = rt.repairInstallModes ? rt.repairInstallModes(root, onError) : repairInstallModes(root, onError);
    } catch (error) {
      const code = errorCode(error);
      if (!code) throw error;
      failedCode ??= code;
    }
    if (repaired > 0) {
      changed = true;
      rt.out(c.green(`✓ removed group and other write from ${repaired} ${repaired === 1 ? "entry" : "entries"} in Cotal's ${what} at ${root}`));
    }
    if (failedCode) {
      const shownRoot = root.replace(/[\r\n]+/g, " ");
      rt.err(c.yellow(`Could not finish permission repair in Cotal's ${what} at ${shownRoot} (${failedCode}).`));
    }
  }
  return changed;
}
