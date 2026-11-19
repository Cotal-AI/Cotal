// Drive the built version command through a private installation inventory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cotal-version-json-"));
const xdg = join(root, "config");
const config = join(xdg, "cotal");
const extensions = join(config, "extensions");
const manifest = join(extensions, "extensions.json");
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))),
  HOME: join(root, "home"), COTAL_HOME: join(root, "cotal"), XDG_CONFIG_HOME: xdg,
  COTAL_NO_UPDATE_CHECK: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1",
};

function run(contents: string, ...words: string[]) {
  writeFileSync(manifest, contents);
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "../../../bin/dist/cotal.js"), ...words], {
    cwd: root, env, encoding: "utf8", timeout: 60_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(readFileSync(manifest, "utf8"), contents, "version never rewrites the manifest");
  assert.deepEqual(readdirSync(config), ["extensions"]);
  assert.deepEqual(readdirSync(extensions), ["extensions.json"]);
  return result;
}

try {
  mkdirSync(extensions, { recursive: true });
  const readable = run('{"extensions":[{"pkg":"@example/sample","version":"1.2.3","commands":[]}]}', "version", "--json");
  assert.equal(readable.status, 0, readable.stderr);
  assert.equal(readable.stderr, "");
  const clean = JSON.parse(readable.stdout);
  assert.equal(clean.outcome, "ok");
  assert.equal(clean.completeness, "complete");
  assert.deepEqual(clean.warnings, []);
  assert.deepEqual(clean.result.extensions, [{ package: "@example/sample", version: "1.2.3" }]);
  const { version } = JSON.parse(readFileSync(join(import.meta.dirname, "../../../bin/package.json"), "utf8"));
  assert.equal(clean.result.version, version);

  const unreadable = [
    { contents: "{}", words: ["version", "--json"], diagnostic: /no "extensions" array/ },
    { contents: "{}", words: ["--json", "version"], diagnostic: /no "extensions" array/ },
    { contents: "{}", words: ["--version", "-j"], diagnostic: /no "extensions" array/ },
    { contents: "{ not json", words: ["-V", "--json"], diagnostic: /corrupt extensions manifest/ },
    { contents: '{"extensions":[null]}', words: ["version", "--json"], diagnostic: /invalid extension version entry at index 0/ },
  ];
  for (const { contents, words, diagnostic } of unreadable) {
    const result = run(contents, ...words);
    assert.equal(result.status, 4, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    const corrupt = JSON.parse(result.stdout);
    assert.equal(corrupt.command, "version");
    assert.equal(corrupt.target, null);
    assert.equal(corrupt.result.version, version);
    assert.deepEqual(corrupt.result.extensions, []);
    assert.equal(corrupt.outcome, "partial");
    assert.equal(corrupt.completeness, "partial");
    assert.equal(corrupt.error.code, "OPERATION_PARTIAL");
    assert.deepEqual(corrupt.warnings.map((warning: { code: string }) => warning.code), ["EXTENSIONS_UNREADABLE"]);
    assert.match(corrupt.warnings[0].message, diagnostic);
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
  console.log("✓ version JSON smoke passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
