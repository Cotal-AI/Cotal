import { randomBytes } from "node:crypto";
import { accessSync, constants, lstatSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { globalConfigDir, globalConfigPath, readCotalConfigFile, type McpServerSpec } from "@cotal-ai/core";
import { acquireLock } from "./advisory-lock.js";
import { shellPath } from "./local-record-source.js";

/** The obstructing component of a directory path, if it cannot be traversed. */
export function directoryReadProblem(dir: string): { readonly path: string; readonly message: string; readonly remedy: string; readonly blockedByFile?: true } | undefined {
  for (let path = dir; ; path = dirname(path)) {
    const parent = dirname(path);
    let stat;
    try { stat = lstatSync(path, { throwIfNoEntry: false }); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (parent === path || !["ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(code ?? "")) {
        return { path, message: `${path} cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
          remedy: `check that ${path} is an accessible folder before retrying` };
      }
      continue;
    }
    if (stat) {
      try {
        const target = stat.isSymbolicLink() ? statSync(path) : stat;
        if (target.isDirectory()) { accessSync(path, constants.X_OK); return undefined; }
        const what = target.isFile() ? "a file, not a folder" : "not a folder";
        return { path, message: `${path} is ${what}`, remedy: `move ${path} aside, for example \`mv ${shellPath(path)} ${shellPath(`${path}.old`)}\`; Cotal makes the folder when it next saves there`,
          ...(target.isFile() ? { blockedByFile: true } : {}) };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM") {
          return { path, message: `${path} cannot be searched by this account (${code})`, remedy: `restore search access to ${path}, for example with \`chmod u+x ${shellPath(path)}\` if you own it` };
        }
        return { path, message: `${path} cannot be resolved as a folder: ${error instanceof Error ? error.message : String(error)}`,
          remedy: `restore the folder or correct the link at ${path} before retrying` };
      }
    }
    if (parent === path) return undefined;
  }
}

/** Name the path that blocks access to the operator config, if any. */
export function globalConfigDirProblem(): { readonly message: string; readonly remedy: string; readonly blockedByFile?: true } | undefined {
  const dir = globalConfigDir();
  const problem = directoryReadProblem(dir);
  if (!problem) return;
  const { path, message, ...detail } = problem;
  return { message: path === dir ? `the Cotal config folder ${message}` : `the Cotal config folder ${dir} cannot be made: ${message}`, ...detail };
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
