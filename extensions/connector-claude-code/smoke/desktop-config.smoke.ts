/**
 * Cotal's entry in Claude Desktop's `claude_desktop_config.json`: setup adds one `cotal` server and
 * keeps every other key of the file, and never rewrites a file it cannot read.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopConfigPath, readDesktopEntry, writeDesktopEntry } from "../src/desktop-config.js";

const dir = mkdtempSync(join(tmpdir(), "cotal-desktop-config-"));
const path = join(dir, "claude_desktop_config.json");
const entry = { command: "/usr/local/bin/node", args: ["/Users/me/.cotal/claude-plugin/cotal/dist/mcp.cjs", "--desktop"] };
let checks = 0;
function ok(label: string, fn: () => void): void {
  fn();
  checks += 1;
  console.log(`  ✓ ${label}`);
}

try {
  console.log("desktop-config.smoke:");
  ok("the config lives where the MCP docs say, and nowhere is guessed on another platform", () => {
    assert.equal(desktopConfigPath("darwin", {}, "/Users/me"), "/Users/me/Library/Application Support/Claude/claude_desktop_config.json");
    assert.equal(desktopConfigPath("win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "C:\\Users\\me"), join("C:\\Users\\me\\AppData\\Roaming", "Claude", "claude_desktop_config.json"));
    assert.equal(desktopConfigPath("linux", {}, "/home/me"), undefined);
  });
  ok("no config yet: the entry is added in a file only its owner reads", () => {
    assert.equal(writeDesktopEntry(path, entry), "added");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { mcpServers: { cotal: entry } });
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
  ok("the same entry again writes nothing", () => {
    const before = statSync(path).mtimeMs;
    assert.equal(writeDesktopEntry(path, entry), "current");
    assert.equal(statSync(path).mtimeMs, before);
  });
  const theirs = { globalShortcut: "Alt+Space", mcpServers: { filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me"] }, cotal: { command: "old" } } };
  rmSync(path);
  writeFileSync(path, JSON.stringify(theirs), { mode: 0o644 });
  ok("an older cotal entry is replaced and every other key and server is kept, with the file's mode", () => {
    assert.equal(writeDesktopEntry(path, entry), "updated");
    const now = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(now, { ...theirs, mcpServers: { ...theirs.mcpServers, cotal: entry } });
    assert.equal(statSync(path).mode & 0o777, 0o644);
    assert.deepEqual(readDesktopEntry(path), entry);
  });
  ok("a config that is not valid JSON is refused and left as it was", () => {
    writeFileSync(path, "{ not json");
    assert.throws(() => writeDesktopEntry(path, entry), /is not valid JSON, so Cotal left it alone/);
    assert.equal(readFileSync(path, "utf8"), "{ not json");
  });
  ok("a config whose mcpServers is not an object is refused and left as it was", () => {
    writeFileSync(path, '{"mcpServers": []}');
    assert.throws(() => writeDesktopEntry(path, entry), /is not a Claude Desktop config/);
    assert.equal(readFileSync(path, "utf8"), '{"mcpServers": []}');
  });
  ok("an empty file counts as no config", () => {
    writeFileSync(path, "");
    assert.equal(readDesktopEntry(path), undefined);
    assert.equal(writeDesktopEntry(path, entry), "added");
  });
  console.log(`desktop-config.smoke: ${checks} checks passed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
