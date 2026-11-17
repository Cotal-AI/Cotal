import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertDesktopSetupComplete } from "../daemon/desktop-setup.js";

const home = mkdtempSync(join(tmpdir(), "desktop-setup-"));
const executable = join(home, "installation", "node.exe");
const folder = join(home, "CotalSetup");
const file = join(folder, "service-update.json");
try {
  mkdirSync(folder);
  mkdirSync(join(home, "installation"));
  mkdirSync(join(home, "other"));
  assert.doesNotThrow(() => assertDesktopSetupComplete(executable, home, "win32"));
  for (const phase of ["preparing", "copying", "activating"]) {
    writeFileSync(file, JSON.stringify({ schema: 1, installPath: join(home, "installation"), phase }));
    assert.throws(() => assertDesktopSetupComplete(executable, home, "win32"), /Setup was interrupted/);
  }
  writeFileSync(file, JSON.stringify({ schema: 1, installPath: join(home, "installation"), phase: "ready" }));
  assert.doesNotThrow(() => assertDesktopSetupComplete(executable, home, "win32"));
  writeFileSync(file, JSON.stringify({ schema: 1, installPath: join(home, "other"), phase: "copying" }));
  assert.doesNotThrow(() => assertDesktopSetupComplete(executable, home, "win32"));
  writeFileSync(file, JSON.stringify({ schema: 1, installPath: join(home, "missing"), phase: "copying" }));
  assert.throws(() => assertDesktopSetupComplete(executable, home, "win32"), /installation folder could not be identified/);
  writeFileSync(file, JSON.stringify({ schema: 1, installPath: join(home, "installation") + "/", phase: "copying" }));
  assert.throws(() => assertDesktopSetupComplete(executable, home, "win32"), /Setup was interrupted/);
  writeFileSync(file, "broken");
  assert.throws(() => assertDesktopSetupComplete(executable, home, "win32"), /could not be read/);
  assert.doesNotThrow(() => assertDesktopSetupComplete(executable, home, "linux"));
  const native = spawnSync("cargo", ["test", "--manifest-path", fileURLToPath(new URL("../../desktop/src-tauri/Cargo.toml", import.meta.url)), "--no-default-features", "presence::tests::"], { encoding: "utf8" });
  assert.equal(native.status, 0, `Native desktop preference tests failed: ${native.error ?? ""}\n${native.stdout}\n${native.stderr}`);
  console.log("PASS native desktop startup preserves invalid preferences and continues with defaults");
  console.log("PASS interrupted setup blocks service start and admission, ready and unrelated installations remain available");
} finally { rmSync(home, { recursive: true, force: true }); }
