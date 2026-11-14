import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Exercises the executable-output verifier, not a native Tauri build.
test("release executable config guard accepts production and rejects test or extra config fields and endpoints", () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "updater-config-"));
  try {
    const executable = join(root, "config");
    const run = (config: object, env: NodeJS.ProcessEnv = process.env) => {
      writeFileSync(executable, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(config))});\n`);
      chmodSync(executable, 0o700);
      return spawnSync(process.execPath, [new URL("../scripts/check-updater-release.mjs", import.meta.url).pathname, executable], { env, encoding: "utf8" });
    };
    const production = { schema: 1, endpoints: ["https://github.com/Cotal-AI/Cotal/releases/latest/download/desktop-latest.json"], test: false };
    assert.equal(run(production).status, 0);
    for (const config of [{ ...production, test: true }, { ...production, insecure: true }, { ...production, endpoints: [...production.endpoints, "http://127.0.0.1:8000/latest.json"] }]) assert.notEqual(run(config).status, 0);
    const rejected = run(production, { ...process.env, COTAL_UPDATER_TEST_ENDPOINT: "http://127.0.0.1:8000/latest.json" });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Release updater test input is set/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
