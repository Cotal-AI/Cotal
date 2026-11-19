// Drive the built version command through a private installation inventory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cotal-version-json-"));
const xdg = join(root, "config");
const config = join(xdg, "cotal");
const extensions = join(config, "extensions");
const manifest = join(extensions, "extensions.json");
const journal = join(config, ".extensions-promotion.json");
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))),
  HOME: join(root, "home"), COTAL_HOME: join(root, "cotal"), XDG_CONFIG_HOME: xdg,
  COTAL_NO_UPDATE_CHECK: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1",
};

function invoke(words: string[], configHome = xdg) {
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "../../../bin/dist/cotal.js"), ...words], {
    cwd: root, env: { ...env, XDG_CONFIG_HOME: configHome }, encoding: "utf8", timeout: 60_000,
  });
  assert.equal(result.error, undefined);
  return result;
}

function run(contents: string, ...words: string[]) {
  writeFileSync(manifest, contents);
  const result = invoke(words);
  assert.equal(readFileSync(manifest, "utf8"), contents, "version never rewrites the manifest");
  assert.deepEqual(readdirSync(config), ["extensions"]);
  assert.deepEqual(readdirSync(extensions), ["extensions.json"]);
  return result;
}

const { version } = JSON.parse(readFileSync(join(import.meta.dirname, "../../../bin/package.json"), "utf8"));

function assertPartial(result: ReturnType<typeof invoke>, diagnostic: RegExp) {
  assert.equal(result.status, 4, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.command, "version");
  assert.equal(report.target, null);
  assert.equal(report.result.version, version);
  assert.deepEqual(report.result.extensions, []);
  assert.equal(report.outcome, "partial");
  assert.equal(report.completeness, "partial");
  assert.equal(report.error.code, "OPERATION_PARTIAL");
  assert.deepEqual(report.warnings.map((warning: { code: string }) => warning.code), ["EXTENSIONS_UNREADABLE"]);
  assert.match(report.warnings[0].message, diagnostic);
  return report;
}

try {
  mkdirSync(extensions, { recursive: true, mode: 0o700 });
  const readable = run('{"extensions":[{"pkg":"@example/sample","version":"1.2.3","commands":[]}]}', "version", "--json");
  assert.equal(readable.status, 0, readable.stderr);
  assert.equal(readable.stderr, "");
  const clean = JSON.parse(readable.stdout);
  assert.equal(clean.outcome, "ok");
  assert.equal(clean.completeness, "complete");
  assert.deepEqual(clean.warnings, []);
  assert.deepEqual(clean.result.extensions, [{ package: "@example/sample", version: "1.2.3" }]);
  assert.equal(clean.result.version, version);

  const unreadable = [
    { contents: "{}", words: ["version", "--json"], diagnostic: /no "extensions" array/ },
    { contents: "{}", words: ["--json", "version"], diagnostic: /no "extensions" array/ },
    { contents: "{}", words: ["--version", "-j"], diagnostic: /no "extensions" array/ },
    { contents: "{ not json", words: ["-V", "--json"], diagnostic: /corrupt extensions manifest/ },
    { contents: '{"extensions":[null]}', words: ["version", "--json"], diagnostic: /invalid extension version entry at index 0/ },
    { contents: '{"extensions":[{"pkg":"@example/sample","version":"1.2.3"}]}', words: ["version", "--json"], diagnostic: /entry at index 0: expected named provides or commands/ },
    { contents: '{"extensions":[{"pkg":"@example/sample","version":"1.2.3","provides":[null]}]}', words: ["version", "--json"], diagnostic: /entry at index 0: expected named provides or commands/ },
  ];
  for (const { contents, words, diagnostic } of unreadable) {
    assertPartial(run(contents, ...words), diagnostic);
  }
  for (const [contents, word] of [
    ['{"extensions":[{"pkg":"@example/sample","commands":[]}]}', "version"],
    ['{"extensions":[{"pkg":"@example/sample","version":123,"commands":[]}]}', "-V"],
  ] as const) {
    const plain = run(contents, word);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stdout, `cotal-ai ${version}\n`);
    assert.match(plain.stderr, /invalid extension version entry at index 0/);
  }

  const invalid = run("{}", "version", "--json", "--unknown");
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stderr, "");
  assert.equal(JSON.parse(invalid.stdout).error.code, "USAGE_INVALID");
  for (const words of [["version"], ["version", "--", "--json"], ["ext", "list", "--json"]]) {
    const strict = run("{}", ...words);
    assert.equal(strict.status, 1);
    assert.equal(strict.stdout, "");
    assert.match(strict.stderr, /corrupt extensions manifest/);
  }

  const badPin = '{"extensions":[{"pkg":"@cotal-ai/tmux","version":123,"commands":[]}]}';
  const rejected = assertPartial(run(badPin, "version", "--json"), /invalid extension version entry at index 0/);
  assert.equal(rejected.result.reconciliation.kind, "unreadable");
  assert.equal(rejected.result.reconciliation.source, "manifest");
  assert.equal(rejected.result.reconciliation.extensions, undefined);
  const skew = run('{"extensions":[{"pkg":"@cotal-ai/tmux","version":"0.1.0","commands":[]}]}', "version", "--json");
  assert.equal(skew.status, 0, skew.stderr);
  const skewReport = JSON.parse(skew.stdout);
  assert.equal(skewReport.result.reconciliation.kind, "version-mismatch");
  assert.deepEqual(skewReport.result.reconciliation.extensions, skewReport.result.extensions);

  const cotalHome = env.COTAL_HOME;
  mkdirSync(cotalHome, { mode: 0o700 });
  const receipt = join(cotalHome, "update-recovery.json");
  const receiptContents = JSON.stringify({ v: 1, previous: "0.1.0", target: version, installed: version, phase: "replacing", reason: "test receipt", recordedAt: "2026-11-19T00:00:00Z" });
  writeFileSync(receipt, receiptContents, { mode: 0o600 });
  const independent = assertPartial(run(badPin, "version", "--json"), /invalid extension version entry at index 0/);
  assert.equal(independent.result.reconciliation.kind, "receipt");
  assert.deepEqual(independent.result.reconciliation.recovery, JSON.parse(receiptContents));
  assert.equal(readFileSync(receipt, "utf8"), receiptContents);
  rmSync(receipt);

  const blockedConfig = join(root, "blocked-config");
  const configFile = join(blockedConfig, "cotal");
  mkdirSync(blockedConfig);
  writeFileSync(configFile, "not a directory\n");
  const noInventory = invoke(["version", "--json"], blockedConfig);
  assert.equal(noInventory.status, 0, noInventory.stderr || noInventory.stdout);
  assert.equal(noInventory.stderr, "");
  const empty = JSON.parse(noInventory.stdout);
  assert.equal(empty.completeness, "complete");
  assert.deepEqual(empty.result.extensions, []);
  assert.deepEqual(empty.result.reconciliation, { kind: "none" });
  assert.deepEqual(empty.warnings, []);
  const refused = invoke(["ext", "list", "--json"], blockedConfig);
  assert.equal(refused.status, 1);
  const refusal = JSON.parse(refused.stdout).error;
  assert.equal(refusal.code, "SCHEMA_INVALID");
  assert.match(refusal.message, /is a file, not a folder/);
  assert.equal(readFileSync(configFile, "utf8"), "not a directory\n");

  if (process.platform !== "win32") {
    const missing = join(config, "missing-journal");
    const contents = '{"extensions":[]}';
    writeFileSync(manifest, contents);
    symlinkSync(missing, journal);
    for (const argv of [["version", "--json"], ["ext", "list", "--json"]]) {
      const dangling = invoke(argv);
      assert.equal(dangling.status, 0, dangling.stderr || dangling.stdout);
      assert.equal(dangling.stderr, "");
      const report = JSON.parse(dangling.stdout);
      assert.equal(report.completeness, "complete");
      assert.deepEqual(report.warnings, []);
      assert.equal(readlinkSync(journal), missing);
      assert.equal(readFileSync(manifest, "utf8"), contents);
    }
    rmSync(journal);
    symlinkSync(journal, journal);
    const loop = assertPartial(invoke(["version", "--json"]), /could not check for a pending extension promotion/);
    assert.equal(loop.result.reconciliation.source, "promotion");
    assert.equal(readlinkSync(journal), journal);
    assert.equal(readFileSync(manifest, "utf8"), contents);
    rmSync(journal);
  }

  const staged = join(config, ".extensions.stage-test.ready");
  const old = join(config, ".extensions.rollback-test");
  const stagedManifest = join(staged, "extensions.json");
  const stagedContents = '{"extensions":[{"pkg":"@example/staged","version":"2.0.0","commands":[]}]}';
  mkdirSync(staged, { mode: 0o700 });
  writeFileSync(stagedManifest, stagedContents);
  writeFileSync(manifest, "{}");
  const identity = (path: string) => {
    const stat = lstatSync(path);
    return { dev: String(stat.dev), ino: String(stat.ino), birth: stat.birthtimeMs };
  };
  const prepared = JSON.stringify({ v: 1, root: extensions, stage: staged, old, stageIdentity: identity(staged), oldIdentity: identity(extensions) });
  for (const contents of ["{unparseable", prepared]) {
    writeFileSync(journal, contents, { mode: 0o600 });
    const report = assertPartial(invoke(["version", "--json"]), /extension promotion is pending/);
    assert.equal(report.result.reconciliation.kind, "unreadable");
    assert.equal(report.result.reconciliation.source, "promotion");
    assert.match(report.error.remedy, /extension promotion journal/);
    assert.equal(readFileSync(manifest, "utf8"), "{}");
    assert.equal(readFileSync(journal, "utf8"), contents);
    assert.equal(readFileSync(stagedManifest, "utf8"), stagedContents);
    assert.deepEqual(readdirSync(config).sort(), [".extensions-promotion.json", ".extensions.stage-test.ready", "extensions"]);
  }
  console.log("✓ version JSON smoke passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
