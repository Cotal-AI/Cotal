import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installJcodeDiagnosticLog, writeJcodeDiagnostic } from "../src/startup-diagnostics.js";

let pass = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  assert.ok(condition, `${name}${actual === undefined ? "" : ` — ${JSON.stringify(actual)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const root = mkdtempSync(join(tmpdir(), "cotal-jcode-diagnostics-"));
try {
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const log = installJcodeDiagnosticLog(home);
  writeJcodeDiagnostic("diagnostic-log-canary\n");
  check("connector diagnostic log directory is owner-only", (statSync(join(home, "logs")).mode & 0o777) === 0o700);
  check("connector diagnostic log file is owner-only", (statSync(log).mode & 0o777) === 0o600);

  if (process.platform === "win32") {
    check("connector diagnostic log symlink guard is unreachable on unsupported Windows", true);
  } else {
    const plantedHome = join(root, "planted-home");
    const outside = join(root, "outside");
    mkdirSync(plantedHome, { mode: 0o700 });
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, join(plantedHome, "logs"), "dir");
    let refused = false;
    try {
      installJcodeDiagnosticLog(plantedHome);
    } catch (error) {
      refused = /refusing symlinked Jcode connector log directory/.test(String((error as Error).message));
    }
    check("connector diagnostic log refuses a pre-planted logs symlink", refused && readdirSync(outside).length === 0, readdirSync(outside));
  }

  console.log(`\n${pass} checks passed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
