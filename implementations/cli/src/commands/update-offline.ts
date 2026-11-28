import { claimExtensionMutationLock, isReleaseExtension, SEEDED_EXTENSIONS } from "@cotal-ai/workspace";
import { operatorInstallDiffers } from "../seed/verify.js";
import { c } from "../ui.js";
import { installExtensionSet } from "./ext.js";
import { message } from "./update-process.js";
import type { UpdateRuntime } from "./update.js";

/** Repair only installed npm packages at this release, without activating a new generation. */
export async function repairOfflineExtensions(current: string, rt: UpdateRuntime, admit: () => Promise<boolean>): Promise<void> {
  const builtIns = new Set(Object.values(SEEDED_EXTENSIONS).map(entry => entry.pkg));
  const repairs = () => rt.extensions().flatMap(entry => {
    const spec = `${entry.pkg}@${current}`;
    return isReleaseExtension(entry) && !builtIns.has(entry.pkg) && entry.version === current && entry.spec === spec
      && operatorInstallDiffers(entry, current) !== undefined ? [{ pkg: entry.pkg, version: current, spec }] : [];
  });
  let packages: string | undefined;
  const report = (detail: string) => rt.err(c.yellow(`Offline extension repair${packages ? ` for ${packages}` : ""} did not finish: ${detail}`));
  try {
    let requests = repairs();
    if (!requests.length) return;
    packages = requests.map(entry => entry.spec).join(", ");
    if (!await admit()) return report("continuity or installation checks did not permit changes.");
    const release = claimExtensionMutationLock();
    try {
      requests = repairs();
      if (!requests.length) return;
      packages = requests.map(entry => entry.spec).join(", ");
      await installExtensionSet(requests, line => rt.err(line), { offline: true });
    } finally { release(); }
  } catch (error) { report(message(error)); }
}
