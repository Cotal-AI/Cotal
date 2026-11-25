/** Refresh reads absent integrations without mutating Claude's configuration. */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  if (process.platform !== "win32") await check("a protected Claude MCP entry warns while the local plugin refreshes", async () => {
    const f = fixture("protected-mcp", true);
    const config = join(f.config, ".claude.json");
    const market = join(process.env.COTAL_HOME!, "claude-plugin");
    const plugin = join(market, "cotal");
    const executable = join(emptyBin, "claude");
    mkdirSync(f.config, { recursive: true });
    mkdirSync(f.plugins, { recursive: true });
    writeFileSync(f.records, JSON.stringify({ plugins: { "cotal@cotal-mesh": [{ scope: "user" }] } }));
    const bytes = JSON.stringify({ mcpServers: { cotal: { command: "/different/node", args: [join(plugin, "dist", "seat.cjs")] } } });
    writeFileSync(config, bytes, { mode: 0o444 });
    writeFileSync(executable, `#!${process.execPath}
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
switch (args.slice(0, 3).join(" ")) {
  case "--version": console.log("2.0.0"); break;
  case "plugin list --json": console.log(JSON.stringify([{ id: "cotal@cotal-mesh", scope: "user", enabled: true, readFromFolder: ${JSON.stringify(plugin)} }])); break;
  case "plugin marketplace list": console.log(JSON.stringify([{ name: "cotal-mesh", source: "directory", path: ${JSON.stringify(market)} }])); break;
  case "plugin marketplace add": case "plugin marketplace update": break;
  case "mcp remove --scope": writeFileSync(${JSON.stringify(config)}, "{}"); break;
  case "mcp add --scope": writeFileSync(${JSON.stringify(config)}, JSON.stringify({ mcpServers: { cotal: { command: args[6], args: args.slice(7) } } })); break;
  default: process.exit(1);
}
`, { mode: 0o700 });
    try {
      const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
      const row = () => claudeSetupProvider.status!({ version, skillsRemedy: "" }).find((row) => row.label === "Claude wake channel")!;
      const original = statSync(config);
      const detail = await refresh();
      assert.ok(detail.includes(config));
      assert.match(detail, /run `cotal update`/);
      assert.equal(row().state, "warn");
      assert.ok(row().text.includes(config));
      assert.equal(readFileSync(config, "utf8"), bytes);
      assert.equal(statSync(config).ino, original.ino);
      assert.equal(statSync(config).mode & 0o777, 0o444);
      assert.ok(existsSync(join(plugin, "dist", "cli.json")));
      chmodSync(config, 0o600);
      assert.doesNotMatch(await refresh(), /read-only/);
      assert.equal(row().state, "ok");
      assert.ok(!row().text.includes(config));
    } finally { rmSync(executable, { force: true }); }
  });
} finally {
  for (const key of keys) {
    if (before[key] === undefined) delete process.env[key];
    else process.env[key] = before[key];
  }
  console.log(`Refresh evidence retained at ${root}`);
}
suite.finish();
