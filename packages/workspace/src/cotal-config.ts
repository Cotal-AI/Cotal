import { randomBytes } from "node:crypto";
import { lstatSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { globalConfigDir, globalConfigPath, readCotalConfigFile, type McpServerSpec } from "@cotal-ai/core";
import { acquireLock } from "./advisory-lock.js";
import { isCommandFailure, type CommandFailure } from "./output.js";
import { shellPath } from "./local-record-source.js";
import { protectedResolvedDirectory } from "./protected-records.js";

/** A single config ancestor whose owner or write permissions prevent connector use. */
export function connectorConfigModeProblem(requireRepairable = false): { failure: CommandFailure; path: string; mode: number; owned: boolean; remove: number; remedy: string } | undefined {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  let path = dirname(resolve(globalConfigDir()));
  try {
    while (!lstatSync(path, { throwIfNoEntry: false })) path = dirname(path);
    protectedResolvedDirectory(path, "the connector config folder");
  } catch (failure) {
    if (!isCommandFailure(failure) || failure.code !== "PERMISSION_DENIED") {
      if (requireRepairable) throw failure;
      return;
    }
    const target = failure.target as { path?: unknown; paths?: unknown } | undefined;
    if (typeof target?.path === "string" && target.paths === undefined) {
      const path = target.path;
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat?.isDirectory()) { if (requireRepairable) throw failure; return; }
      const mode = stat.mode & 0o7777;
      const owned = stat.uid === process.getuid?.();
      if (!owned) return { failure, path, mode, owned, remove: 0, remedy: stat.uid === 0
        ? `ask an administrator to remove the unsafe write permissions from ${shellPath(path)}`
        : `ask an administrator to make ${shellPath(path)} owned by your account or root` };
      for (const [word, remove] of [["o-w", 0o002], ["go-w", 0o022], ["g-w", 0o020]] as const)
        if (failure.remedy === `chmod ${word} ${shellPath(path)}`) return { failure, path, mode, owned, remove, remedy: failure.remedy };
    }
    if (requireRepairable) throw failure;
  }
}

/** Why the operator config folder can hold nothing, or undefined when it is a folder or not made yet.
 *  A file at it, or at a folder above it, fails every read and write of the preferences, the config
 *  file and the extensions there; the result names that path and how to clear it. */
export function globalConfigDirProblem(): { readonly message: string; readonly remedy: string } | undefined {
  const dir = globalConfigDir();
  for (let path = dir; ; path = dirname(path)) {
    let stat;
    try {
      stat = statSync(path, { throwIfNoEntry: false });
    } catch {
      return undefined;
    }
    if (stat) {
      if (stat.isDirectory()) return undefined;
      const what = `${path} is ${stat.isFile() ? "a file, not a folder" : "not a folder"}`;
      return {
        message: path === dir ? `the Cotal config folder ${what}` : `the Cotal config folder ${dir} cannot be made: ${what}`,
        remedy: `move ${path} aside to an unused name, then repeat the original command; Cotal makes the folder when it next saves there`,
      };
    }
    if (dirname(path) === path) return undefined;
  }
}

/** Record `servers` as what `connector` shares, in the operator-level cotal config, unless that file
 *  already declares a list for it: an existing list, even an empty one, is the operator's choice and
 *  is kept. Every other key in the file is preserved. Returns whether it wrote.
 *
 *  The file is global, so setups run from two folders can seed at once. A lock held from the read to
 *  the rename makes the second one find the first one's list, and the rename means a spawn reading the
 *  file never sees it half-written. */
export function seedConnectorServers(connector: string, servers: Record<string, McpServerSpec>): boolean {
  const path = globalConfigPath();
  const held = acquireLock(`${path}.lock`, { label: `the seed lock for ${path}`, waitMs: 30_000, pollMs: 20 });
  try {
    const config = readCotalConfigFile(path);
    if (config.connectors?.[connector]?.mcpServers !== undefined) return false;
    const connectors = { ...config.connectors, [connector]: { ...config.connectors?.[connector], mcpServers: servers } };
    const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ ...config, connectors }, null, 2)}\n`, { flag: "wx" });
    renameSync(tmp, path);
    return true;
  } finally {
    held.release();
  }
}
