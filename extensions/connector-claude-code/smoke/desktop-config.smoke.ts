/**
 * Cotal's entry in Claude Desktop's `claude_desktop_config.json`: setup adds one `cotal` server and
 * keeps every other key of the file, never rewrites a file it cannot read, and writes nothing while
 * Desktop runs on macOS. A `ps` on PATH prints a macOS process listing for that check.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopConfigPath, desktopRunning, readDesktopEntry, writeDesktopEntry } from "../src/desktop-config.js";

const dir = mkdtempSync(join(tmpdir(), "cotal-desktop-config-"));
const path = join(dir, "claude_desktop_config.json");
const entry = { command: "/usr/local/bin/node", args: ["/Users/me/.cotal/claude-plugin/cotal/dist/mcp.cjs", "--desktop"] };
const bin = join(dir, "bin");
const listing = join(dir, "ps-listing");
const calls = join(dir, "ps-calls");
mkdirSync(bin);
writeFileSync(join(bin, "ps"), `#!/bin/sh\necho "$*" >> '${calls}'\ncat '${listing}'\nexit "\${PS_EXIT:-0}"\n`);
chmodSync(join(bin, "ps"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
/** What `ps -A -o comm=` prints on a Mac where Desktop 3.1623.4 runs, minus Desktop's main process. */
const beside = [
  "/sbin/launchd",
  "/Applications/Claude.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt",
  "/Users/me/Library/Application Support/Claude/claude-code/2.1.308/0a1b2c/claude.app/Contents/MacOS/claude",
  "/Users/me/.local/bin/claude",
  "/Users/me/Library/Application Support/Claude/claude-code/2.1.308/0a1b2c/claude-code-proxy",
];
const psCalls = () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : []);
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
  ok("Desktop's main executable counts as running wherever the app is; its updater, bundled Code and the CLI do not", () => {
    writeFileSync(listing, `${beside.join("\n")}\n`);
    assert.equal(desktopRunning("darwin"), false);
    writeFileSync(listing, `${[...beside, "/Applications/Claude.app/Contents/MacOS/Claude"].join("\n")}\n`);
    assert.equal(desktopRunning("darwin"), true);
    writeFileSync(listing, `${[...beside, "/Users/me/Applications/Claude.app/Contents/MacOS/Claude"].join("\n")}\n`);
    assert.equal(desktopRunning("darwin"), true);
    assert.deepEqual(psCalls(), ["-A -o comm=", "-A -o comm=", "-A -o comm="]);
  });
  ok("off macOS nothing is listed and Desktop never counts as running", () => {
    assert.equal(desktopRunning("win32"), false);
    assert.equal(desktopRunning("linux"), false);
    assert.equal(psCalls().length, 3);
  });
  ok("a process listing that fails is refused", () => {
    process.env.PS_EXIT = "1";
    try {
      assert.throws(() => desktopRunning("darwin"), /could not list processes to tell whether Claude Desktop is running/);
    } finally {
      delete process.env.PS_EXIT;
    }
  });
  ok("while Desktop runs no entry is added and the file is not created", () => {
    rmSync(path);
    assert.equal(writeDesktopEntry(path, entry, () => true), "not added");
    assert.equal(existsSync(path), false);
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes(".cotal-")), []);
  });
  ok("while Desktop runs an older entry is not updated and the file is left as it was", () => {
    const text = JSON.stringify(theirs);
    writeFileSync(path, text);
    assert.equal(writeDesktopEntry(path, entry, () => true), "not updated");
    assert.equal(readFileSync(path, "utf8"), text);
  });
  ok("a current entry needs no write, so it is reported current while Desktop runs", () => {
    writeFileSync(path, JSON.stringify({ mcpServers: { cotal: entry } }));
    let asked = 0;
    assert.equal(writeDesktopEntry(path, entry, () => ++asked > 0), "current");
    assert.equal(asked, 0);
  });
  console.log(`desktop-config.smoke: ${checks} checks passed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
