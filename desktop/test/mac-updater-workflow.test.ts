import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
const { parse } = createRequire(import.meta.url)("yaml");

function proofConfig(configKey: string | undefined, fixtureKey = "fixture-public-key", crlf = false) {
  const raw = readFileSync(new URL("mac-updater-version.mjs", import.meta.url), "utf8");
  const source = (crlf ? raw.replace(/\r?\n/g, "\r\n") : raw).replace(/^import .*;\r?\n/gm, "");
  let overlay: Record<string, unknown> | undefined;
  runInNewContext(source, {
    process: { platform: "darwin", argv: ["node", "stamper", "0.164.8"], env: {
      GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", npm_execpath: "pnpm",
      COTAL_UPDATER_TEST_ENDPOINT: "http://127.0.0.1:43189/latest.json", COTAL_UPDATER_PUBLIC_KEY: fixtureKey,
      COTAL_UPDATER_PROOF_CONFIG_PUBLIC_KEY: configKey,
    }, execPath: "node" },
    execFileSync: () => "[]", readFileSync: () => { throw new Error("Unexpected read"); },
    writeFileSync: (_path: string, value: string) => { overlay = JSON.parse(value); },
    resolve: (value: string) => value, join: (...values: string[]) => values.join("/"), console: { log() {} },
  });
  return overlay;
}

test("proof stamper supplies only a distinct inert bundler public key", () => {
  for (const crlf of [false, true]) {
    const overlay = proofConfig("config-public-key", "fixture-public-key", crlf);
    assert.deepEqual(overlay, {
      bundle: { createUpdaterArtifacts: true, macOS: { signingIdentity: "-" } },
      plugins: { updater: { pubkey: "config-public-key" } },
    });
    assert.notEqual((overlay?.plugins as { updater: { pubkey: string } }).updater.pubkey, "fixture-public-key");
  }
});

test("proof stamper refuses absent or matching config public keys", () => {
  for (const key of [undefined, "", "fixture-public-key"]) {
    assert.throws(() => proofConfig(key), /distinct disposable public key/);
  }
});

test("hosted Mac proof is explicit, ARM first, and uses immutable shared fixture input", () => {
  const workflow = parse(readFileSync(new URL("../../.github/workflows/desktop.yml", import.meta.url), "utf8"));
  const proof = parse(readFileSync(new URL("../../.github/workflows/desktop-mac-updater.yml", import.meta.url), "utf8"));
  assert.equal(workflow.on.workflow_dispatch.inputs.updater_apply.default, false);
  assert.equal(workflow.jobs['updater-arm'].with.runner, 'macos-15');
  assert.equal(workflow.jobs['updater-followup'].needs, 'updater-arm');
  assert.equal(proof.on.workflow_call.inputs.fixture_head.required, true);
  assert.ok(proof.jobs.native.steps.some((step: { run?: string }) => step.run?.includes('git fetch origin "$FIXTURE_HEAD"')));
  const steps = workflow.jobs['native-build'].steps as { name?: string; uses?: string; run?: string }[];
  const guard = steps.findIndex(step => step.name === 'Verify compiled updater release inputs');
  const upload = steps.findIndex(step => step.name === 'Upload built desktop packages');
  assert.ok(guard >= 0 && upload > guard, 'actual executable production-config check precedes upload');
  const proofDriver = readFileSync(new URL("mac-updater-proof.mjs", import.meta.url), "utf8");
  assert.match(proofDriver, /record\('initial daemon status', initial\)/);
  assert.match(proofDriver, /assert\.equal\(initial\.ok, false, 'Default native service must be absent'\)/);
  assert.match(proofDriver, /assert\.equal\(initial\.error\?\.code, 'TARGET_UNAVAILABLE', 'Default native service must be absent'\)/);
  assert.match(proofDriver, /assert\.equal\(initial\.error\?\.cause\?\.code, 'NOT_RUNNING', 'Default native service must be absent'\)/);
  assert.ok(!proofDriver.includes("call('update', '--auto'"), 'update --auto refuses --json');
  const swiftDriver = readFileSync(new URL("mac-updater-driver.swift", import.meta.url), "utf8");
  assert.match(swiftDriver, /children\(element\)\.map\(text\)/);
});
