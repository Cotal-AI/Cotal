// Drive the built version command through a private installation inventory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

function invoke(...words: string[]) {
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "../../../bin/dist/cotal.js"), ...words], {
    cwd: root, env, encoding: "utf8", timeout: 60_000,
  });
  assert.equal(result.error, undefined);
  return result;
}

function run(contents: string, ...words: string[]) {
  writeFileSync(manifest, contents);
  const result = invoke(...words);
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
    const report = assertPartial(invoke("version", "--json"), /extension promotion is pending/);
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
