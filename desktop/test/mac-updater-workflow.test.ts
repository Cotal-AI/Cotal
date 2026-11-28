import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
const { parse } = createRequire(import.meta.url)("yaml");

function proofConfig(configKey: string | undefined, fixtureKey = "fixture-public-key", crlf = false, platform = "darwin", version = "0.164.8") {
  const raw = readFileSync(new URL("mac-updater-version.mjs", import.meta.url), "utf8");
  const source = (crlf ? raw.replace(/\r?\n/g, "\r\n") : raw).replace(/^import .*;\r?\n/gm, "");
  let overlay: Record<string, unknown> | undefined;
  runInNewContext(source, {
    process: { platform, argv: ["node", "stamper", version], env: {
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

test("proof stamper supplies only a distinct inert bundler public key across Mac and Windows hops", () => {
  for (const crlf of [false, true]) {
    for (const [platform, version] of [["darwin", "0.164.8"], ["win32", "0.164.10"]] as const) {
      const overlay = proofConfig("config-public-key", "fixture-public-key", crlf, platform, version);
      assert.deepEqual(overlay, {
        bundle: { createUpdaterArtifacts: true, macOS: { signingIdentity: "-" } },
        plugins: { updater: { pubkey: "config-public-key" } },
      });
      assert.notEqual((overlay?.plugins as { updater: { pubkey: string } }).updater.pubkey, "fixture-public-key");
    }
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
  assert.equal(workflow.jobs['updater-windows']['runs-on'], 'windows-2022');
  assert.equal(proof.on.workflow_call.inputs.fixture_head.required, true);
  assert.ok(proof.jobs.native.steps.some((step: { run?: string }) => step.run?.includes('git fetch origin "$FIXTURE_HEAD"')));
  const steps = workflow.jobs['native-build'].steps as { name?: string; uses?: string; run?: string }[];
  const guard = steps.findIndex(step => step.name === 'Verify compiled updater release inputs');
  const upload = steps.findIndex(step => step.name === 'Upload built desktop packages');
  assert.ok(guard >= 0 && upload > guard, 'actual executable production-config check precedes upload');
});

test("desktop release waits for native first-install and upgrade acceptance", () => {
  const { jobs } = parse(readFileSync(new URL("../../.github/workflows/desktop.yml", import.meta.url), "utf8"));
  const checks = ["clean-install-linux", "clean-install-macos", "clean-install-windows"];
  assert.deepEqual(jobs.release.needs, checks);
  for (const name of checks) {
    const job = jobs[name];
    assert.equal(job.needs, "native-build");
    assert.equal(job.strategy["fail-fast"], false);
    assert.ok(job.strategy.matrix.cell.includes("first-install"));
    assert.ok(job.steps.some((step: { with?: { name?: string } }) => step.with?.name?.startsWith("desktop-validation-")));
  }
  assert.deepEqual(jobs[checks[0]!].strategy.matrix.format, ["deb", "rpm"]);
  assert.deepEqual(jobs[checks[0]!].strategy.matrix.cell, ["first-install", "upgrade"]);
  assert.deepEqual(jobs[checks[1]!].strategy.matrix.runner, ["macos-15", "macos-15-intel"]);
  assert.deepEqual(jobs[checks[1]!].strategy.matrix.cell, ["first-install", "upgrade"]);
  assert.deepEqual(jobs[checks[2]!].strategy.matrix.cell, ["first-install", "0.162.0", "0.177.0"]);
});
