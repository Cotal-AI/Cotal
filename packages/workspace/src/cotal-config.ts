import { randomBytes } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { globalConfigPath, readCotalConfigFile, type McpServerSpec } from "@cotal-ai/core";
import { acquireLock } from "./advisory-lock.js";

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
