import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("owned Windows application install appends User PATH and restores its original value", {
  skip: process.platform !== "win32" || process.env.RUNNER_ENVIRONMENT !== "github-hosted",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-user-path-"));
  const directory = join(root, "application"); mkdirSync(directory);
  const receipt = join(root, "receipt.json");
  const script = fileURLToPath(new URL("../e2e/windows-application.ps1", import.meta.url));
  const ps = join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const run = (action: "install" | "restore") => {
    const result = spawnSync(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script,
      "-Action", action, "-Directory", directory, "-Receipt", receipt], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
  };
  let restored = false;
  try {
    run("install");
    const installed = JSON.parse(readFileSync(receipt, "utf8").replace(/^\uFEFF/, ""));
    assert.equal(installed.directory, directory);
    assert.ok(installed.installed.endsWith(directory));
    assert.equal(installed.restored, false);
    run("restore"); restored = true;
    const final = JSON.parse(readFileSync(receipt, "utf8").replace(/^\uFEFF/, ""));
    assert.equal(final.previous, installed.previous);
    assert.equal(final.restored, true);
  } finally {
    // The script refuses to overwrite a foreign PATH edit, so a failed restoration
    // must retain its receipt rather than erase the only restoration authority.
    if (!restored) run("restore");
    rmSync(root, { recursive: true, force: true });
  }
});
