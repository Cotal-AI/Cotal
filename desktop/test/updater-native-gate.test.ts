import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("native updater compile gate stays hosted-only and uses no production secret", () => {
  const script = readFileSync(new URL("../scripts/check-updater-native.ps1", import.meta.url), "utf8");
  const workflow = readFileSync(new URL("../../.github/workflows/desktop.yml", import.meta.url), "utf8");
  assert.ok(script.includes("$env:RUNNER_ENVIRONMENT -ne 'github-hosted'"));
  assert.ok(script.includes("signer generate --ci --write-keys $key"));
  assert.ok(!script.includes("TAURI_SIGNING_PRIVATE_KEY"));
  assert.equal((script.match(/tauri build --debug --no-bundle/g) ?? []).length, 2);
  assert.ok(script.includes("Remove-Item Env:COTAL_UPDATER_PUBLIC_KEY"));
  assert.ok(script.includes("finally {"));
  assert.ok(workflow.includes("inputs.updater_compile && runner.os != 'Linux'"));
  assert.ok(workflow.includes("desktop-updater-native-${{ runner.os }}-${{ runner.arch }}"));
});
