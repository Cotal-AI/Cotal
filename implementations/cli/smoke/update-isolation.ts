import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Import this before product modules, including modules that capture paths at evaluation time.
const keys = ["HOME", "COTAL_HOME", "XDG_CONFIG_HOME", "LOCALAPPDATA", "APPDATA"] as const;
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const callerPaths = [...new Set([
  process.env.COTAL_HOME ?? (process.platform === "win32" && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "Cotal") : join(homedir(), ".cotal")),
  process.env.XDG_CONFIG_HOME?.trim() ? join(process.env.XDG_CONFIG_HOME.trim(), "cotal")
    : process.platform === "win32" && process.env.APPDATA?.trim()
      ? join(process.env.APPDATA.trim(), "Cotal") : join(homedir(), ".config", "cotal"),
])];
function entries(path: string): { name: string; size: number; mtime: number }[] {
  if (!existsSync(path)) return [];
  return readdirSync(path).filter(name => /^(?:update-|\.update-)/.test(name)).sort().map(name => {
    const stat = lstatSync(join(path, name));
    return { name, size: stat.size, mtime: stat.mtimeMs };
  });
}
const before = callerPaths.map(path => entries(path));
const root = realpathSync(mkdtempSync(join(tmpdir(), "update-suite-")));
for (const [key, name] of [["HOME", "home"], ["COTAL_HOME", "cotal"], ["XDG_CONFIG_HOME", "config"], ["LOCALAPPDATA", "local"], ["APPDATA", "roaming"]] as const) {
  process.env[key] = join(root, name);
  mkdirSync(process.env[key], { mode: 0o700 });
}
mkdirSync(join(process.env.XDG_CONFIG_HOME!, "cotal"), { mode: 0o700 });
process.once("exit", () => {
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  try {
    callerPaths.forEach((path, index) => assert.deepEqual(entries(path), before[index], `update smoke changed caller update entries: ${path}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
