/** The desktop PATH read through real login shells, POSIX and not, each with an isolated home that adds one directory. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { skipSuite } from "@cotal-ai/smoke-kit";

if (process.platform === "win32") skipSuite("daemon-desktop-path-shells: POSIX login shells only");
const which = (name: string): string | undefined => {
  const found = spawnSync("/bin/sh", ["-c", 'command -v "$1"', "sh", name], { encoding: "utf8" }).stdout.trim();
  return found.startsWith("/") ? found : undefined;
};
const shells = ["bash", "zsh", "dash", "nu"].map((name) => ({ name, path: which(name) }));
const missing = shells.filter((shell) => !shell.path).map((shell) => shell.name);
if (missing.includes("nu")) skipSuite("daemon-desktop-path-shells: nushell (`nu`) is not on PATH, so the non-POSIX login shell cannot be checked");

const root = mkdtempSync(join(tmpdir(), "desktop-path-shells-"));
const realUserInfo = os.userInfo;
const { discoverDesktopApplicationPath } = await import("../daemon/desktop-path.js");
let checked = 0;
for (const shell of shells) {
  if (!shell.path) continue;
  const home = join(root, shell.name);
  const added = join(home, "login-bin");
  mkdirSync(join(home, ".config", "nushell"), { recursive: true, mode: 0o700 });
  mkdirSync(added, { mode: 0o700 });
  for (const profile of [".profile", ".bash_profile", ".zprofile"]) writeFileSync(join(home, profile), `export PATH=${added}:$PATH\n`, { mode: 0o600 });
  writeFileSync(join(home, ".config", "nushell", "env.nu"), `$env.PATH = ($env.PATH | split row (char esep) | prepend '${added}')\n`, { mode: 0o600 });
  writeFileSync(join(home, ".config", "nushell", "config.nu"), "", { mode: 0o600 });
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  delete process.env.ZDOTDIR;
  os.userInfo = ((options?: { encoding: BufferEncoding }) => ({ ...realUserInfo(options), shell: shell.path })) as typeof os.userInfo;
  syncBuiltinESMExports();
  const discovered = await discoverDesktopApplicationPath();
  const entries = discovered.path.split(":");
  assert.ok(entries.includes(added), `${shell.name}: the login profile's directory is in ${discovered.path}`);
  assert.ok(entries.length > 1, `${shell.name}: more than the added directory was read`);
  assert.deepEqual(discovered.omittedRelativeEntries, [], `${shell.name}: no unexpanded or relative entry`);
  checked++;
}
os.userInfo = realUserInfo;
syncBuiltinESMExports();
assert.equal(checked, shells.length - missing.length);
console.log(`desktop PATH read through ${checked} real login shells (${shells.filter((s) => s.path).map((s) => s.name).join(", ")})${missing.length ? `; not installed: ${missing.join(", ")}` : ""}`);
