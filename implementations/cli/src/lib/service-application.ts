import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homeCotalDir, loadExtensionsManifest, resolveOnPath } from "@cotal-ai/workspace";

/**
 * Applications this shell can run that the recorded Linux unit cannot.
 * Empty unless the receipt, unit digest and both PATH lookups agree.
 */
export function applicationsBeyondRecordedService(): readonly string[] {
  if (process.platform !== "linux") return [];
  try {
    const receipt = JSON.parse(readFileSync(join(homeCotalDir(), "daemon", "service-unit.json"), "utf8")) as { mechanism?: string; unitPath?: string; unitSha256?: string };
    if ((receipt.mechanism ?? "systemd-user") !== "systemd-user" || !receipt.unitPath || !receipt.unitSha256) return [];
    const source = readFileSync(receipt.unitPath, "utf8");
    if (createHash("sha256").update(source).digest("hex") !== receipt.unitSha256) return [];
    const pinned = /^Environment=PATH="((?:\\.|[^"\\])*)"$/m.exec(source)?.[1]?.replace(/\\([\\"])/g, "$1").replaceAll("%%", "%");
    if (!pinned) return [];
    const pinnedDirs = new Set(pinned.split(delimiter).filter(Boolean));
    const found = new Set<string>();
    for (const extension of loadExtensionsManifest().extensions) {
      for (const connector of extension.connectors ?? []) {
        const required = connector.requires.filter(executable => executable.trim() && !executable.includes("/") && !executable.includes("\\"));
        if (!required.length) continue;
        const sees = (dirs: readonly string[]) => required.every(executable => dirs.some(dir => { try { accessSync(join(dir, executable), constants.X_OK); return true; } catch { return false; } }));
        const shellDirs = (process.env.PATH ?? "").split(delimiter).filter(dir => dir && !pinnedDirs.has(dir));
        if (sees(shellDirs) && !sees([...pinnedDirs]) && required.every(executable => resolveOnPath(executable) !== undefined)) found.add(connector.name);
      }
    }
    return [...found].sort();
  } catch { return []; }
}
