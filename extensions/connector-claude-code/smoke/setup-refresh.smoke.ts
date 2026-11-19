/** Refresh reads absent integrations without mutating Claude's configuration. */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";

const suite = createSuite();
async function check(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  suite.check(name, true);
}
const root = mkdtempSync(join(tmpdir(), "cotal-claude-refresh-"));
const keys = ["HOME", "USERPROFILE", "COTAL_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_PLUGIN_CACHE_DIR", "XDG_CONFIG_HOME", "APPDATA", "PATH"] as const;
const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const emptyBin = join(root, "empty-bin");
mkdirSync(emptyBin);
process.env.PATH = emptyBin;
const { claudeSetupProvider } = await import("../src/setup.js");
const refresh = () => claudeSetupProvider.refresh!.run({ cotal: [process.execPath, join(root, "cotal.js")] });
function fixture(name: string, custom = false) {
  const home = join(root, name);
  mkdirSync(home);
  Object.assign(process.env, { HOME: home, USERPROFILE: home, COTAL_HOME: join(home, "cotal"), XDG_CONFIG_HOME: join(home, "config"), APPDATA: join(home, "appdata") });
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  const config = join(home, custom ? "custom-claude" : ".claude");
  const plugins = join(home, custom ? "custom-cache" : ".claude/plugins");
  if (custom) Object.assign(process.env, { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PLUGIN_CACHE_DIR: plugins });
  return { home, config, plugins, records: join(plugins, "installed_plugins.json") };
}
try {
  await check("absent default and custom paths remain absent", async () => {
    for (const custom of [false, true]) {
      const f = fixture(`absent-${custom}`, custom);
      assert.equal(await refresh(), "not installed");
      assert.equal(existsSync(f.config), false);
      assert.equal(existsSync(f.plugins), false);
      assert.equal(existsSync(process.env.COTAL_HOME!), false);
      assert.deepEqual(readdirSync(f.home), []);
    }
  });
  await check("read-only config and plugin directories require no write access", async () => {
    for (const custom of [false, true]) for (const cache of [false, true]) {
      const f = fixture(`readonly-${custom}-${cache}`, custom);
      mkdirSync(f.config);
      if (cache) mkdirSync(f.plugins, { recursive: true });
      if (cache) chmodSync(f.plugins, 0o500);
      chmodSync(f.config, 0o500);
      try {
        assert.equal(await refresh(), "not installed");
        assert.deepEqual(readdirSync(f.config), !custom && cache ? ["plugins"] : []);
        if (process.platform !== "win32") assert.equal(statSync(f.config).mode & 0o777, 0o500);
        if (cache) assert.deepEqual(readdirSync(f.plugins), []);
        else assert.equal(existsSync(f.plugins), false);
        assert.equal(existsSync(process.env.COTAL_HOME!), false);
      } finally {
        chmodSync(f.config, 0o700);
        if (cache) chmodSync(f.plugins, 0o700);
      }
    }
  });
  await check("empty and unrelated native records are preserved read-only", async () => {
    const f = fixture("unrelated");
    mkdirSync(f.plugins, { recursive: true });
    const bytes = JSON.stringify({ version: 2, plugins: { "other@market": [{ scope: "user" }], "cotal@cotal-mesh": [], "cotal-skills@cotal-mesh": [] } });
    writeFileSync(f.records, bytes);
    chmodSync(f.plugins, 0o500);
    try {
      assert.equal(await refresh(), "not installed");
      assert.equal(readFileSync(f.records, "utf8"), bytes);
      assert.deepEqual(readdirSync(f.plugins), ["installed_plugins.json"]);
      assert.equal(existsSync(process.env.COTAL_HOME!), false);
    } finally { chmodSync(f.plugins, 0o700); }
  });
  await check("damaged or unreadable records refuse without creating locks", async () => {
    for (const bytes of ["{broken", "null", '{"plugins":[]}']) {
      const f = fixture(`damaged-${bytes.length}`);
      mkdirSync(f.plugins, { recursive: true });
      writeFileSync(f.records, bytes);
      await assert.rejects(async () => refresh(), /plugin records (?:could not be read|have an unsupported shape)/);
      assert.equal(readFileSync(f.records, "utf8"), bytes);
      assert.equal(existsSync(process.env.COTAL_HOME!), false);
    }
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const f = fixture("unreadable");
      mkdirSync(f.plugins, { recursive: true });
      writeFileSync(f.records, '{"plugins":{}}');
      chmodSync(f.records, 0o000);
      try {
        await assert.rejects(async () => refresh(), /plugin records could not be read/);
        assert.equal(existsSync(process.env.COTAL_HOME!), false);
      } finally { chmodSync(f.records, 0o600); }
    }
  });
  await check("installed plugins still require Claude, including disabled and skills installs", async () => {
    for (const name of ["cotal", "cotal-skills"]) {
      const f = fixture(name);
      mkdirSync(f.plugins, { recursive: true });
      writeFileSync(f.records, JSON.stringify({ plugins: { [`${name}@cotal-mesh`]: [{ scope: "user", enabled: false }] } }));
      await assert.rejects(async () => refresh(), new RegExp(`${name}@cotal-mesh is installed, but Claude Code is unavailable`));
    }
  });
} finally {
  for (const key of keys) {
    if (before[key] === undefined) delete process.env[key];
    else process.env[key] = before[key];
  }
  console.log(`Refresh evidence retained at ${root}`);
}
suite.finish();
