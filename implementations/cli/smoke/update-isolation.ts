import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Import this before product modules, including modules that capture paths at evaluation time.
const keys = ["HOME", "COTAL_HOME", "XDG_CONFIG_HOME", "LOCALAPPDATA", "APPDATA"] as const;
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const callerPaths = [...new Set([
  homedir(),
  process.env.COTAL_HOME ?? join(homedir(), ".cotal"),
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  ...[process.env.LOCALAPPDATA, process.env.APPDATA].filter((path): path is string => !!path),
])];
function entries(path: string): string[] {
  if (!existsSync(path)) return [];
  const result = ["."];
  function walk(directory: string, relative: string): void {
    for (const name of readdirSync(directory).sort()) {
      const child = join(directory, name), entry = join(relative, name);
      result.push(entry);
      // Do not follow caller symlinks into unrelated trees.
      const recursive = path !== callerPaths[0] || path === previous.COTAL_HOME || path === previous.XDG_CONFIG_HOME;
      if (recursive && lstatSync(child).isDirectory()) walk(child, entry);
    }
  }
  walk(path, "");
  return result;
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
    callerPaths.forEach((path, index) => assert.deepEqual(entries(path), before[index], `update smoke changed caller entries: ${path}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
