/** Refresh reads absent integrations without mutating Claude's configuration. */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
  if (process.platform !== "win32" && process.getuid?.() !== 0) await check("a read-only or broken-link Cotal marketplace defers refresh and fails explicit setup while 0400 lock files are reclaimed", async () => {
    for (const [pluginId, expected] of [
      ["cotal@cotal-mesh", "Claude integration refresh"],
      ["cotal-skills@cotal-mesh", "Claude skills refresh"],
    ] as const) {
      const f = fixture(`readonly-market-${pluginId.split("@")[0]}`, true);
      const market = join(process.env.COTAL_HOME!, "claude-plugin");
      mkdirSync(f.config, { recursive: true });
      mkdirSync(f.plugins, { recursive: true });
      mkdirSync(market, { recursive: true, mode: 0o700 });
      writeFileSync(f.records, JSON.stringify({ version: 2, plugins: { [pluginId]: [{ scope: "user", version: "0.1.0" }] } }));
      for (const mode of [0o500, 0o600] as const) {
        chmodSync(market, mode);
        try {
          const detail = await refresh();
          assert.equal(detail, `${expected} deferred because ${market} is read-only. Make that directory writable and searchable, then run \`cotal update\`.`);
          await assert.rejects(
            async () => claudeSetupProvider.connector!.run({ cotal: [process.execPath, join(root, "cotal.js")] }),
            new Error(`${market} is read-only. Make that directory writable and searchable, then run \`cotal setup\`.`),
          );
          assert.equal(statSync(market).mode & 0o777, mode);
          assert.deepEqual(readdirSync(market), []);
          assert.equal(existsSync(join(f.config, ".cotal-setup.lock")), false);
          assert.equal(existsSync(join(f.plugins, ".cotal-setup.lock")), false);
        } finally {
          chmodSync(market, 0o700);
        }
      }
    }
    const f = fixture("reclaim-lock-and-link", true);
    const market = join(process.env.COTAL_HOME!, "claude-plugin");
    const plugin = join(market, "cotal");
    const lock = join(market, ".setup.lock");
    const config = join(f.config, ".claude.json");
    const executable = join(emptyBin, "claude");
    mkdirSync(f.config, { recursive: true });
    mkdirSync(f.plugins, { recursive: true });
    mkdirSync(market, { recursive: true, mode: 0o700 });
    writeFileSync(f.records, JSON.stringify({ version: 2, plugins: { "cotal@cotal-mesh": [{ scope: "user", version: "0.1.0" }] } }));
    writeFileSync(config, "{}");
    writeFileSync(executable, `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const manifestPath = ${JSON.stringify(join(plugin, ".claude-plugin", "plugin.json"))};
const version = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")).version : "0.1.0";
switch (args.slice(0, 3).join(" ")) {
  case "--version": console.log("2.0.0"); break;
  case "plugin list --json": console.log(JSON.stringify([{ id: "cotal@cotal-mesh", scope: "user", enabled: true, version, readFromFolder: ${JSON.stringify(plugin)} }])); break;
  case "plugin marketplace list": console.log(JSON.stringify([{ name: "cotal-mesh", source: "directory", path: ${JSON.stringify(market)} }])); break;
  case "plugin marketplace add": case "plugin marketplace update": case "plugin install cotal@cotal-mesh": case "plugin update cotal@cotal-mesh": break;
  case "mcp remove --scope": writeFileSync(${JSON.stringify(config)}, "{}"); break;
  case "mcp add --scope": writeFileSync(${JSON.stringify(config)}, JSON.stringify({ mcpServers: { cotal: { command: args[6], args: args.slice(7) } } })); break;
  default: process.exit(1);
}
`, { mode: 0o700 });
    try {
      // A 0400 .setup.lock in a writable marketplace is reclaimed by both setup and refresh, matching main.
      writeFileSync(lock, "{}", { mode: 0o400 });
      const setupDetail = await claudeSetupProvider.connector!.run({ cotal: [process.execPath, join(root, "cotal.js")] });
      assert.match(setupDetail, /^cotal@cotal-mesh \(user scope\)/);
      assert.equal(existsSync(lock), false);

      writeFileSync(lock, "{}", { mode: 0o400 });
      const refreshDetail = await claudeSetupProvider.refresh!.run({ cotal: [process.execPath, join(root, "updated-cotal.js")] });
      assert.doesNotMatch(refreshDetail, /deferred/);
      assert.match(refreshDetail, /cotal@cotal-mesh/);
      assert.equal(existsSync(lock), false);

      // A 0400 lock in the profile or plugin cache is reclaimed by explicit setup and defers refresh, matching main.
      for (const dir of [f.config, f.plugins]) {
        const otherLock = join(dir, ".cotal-setup.lock");
        writeFileSync(otherLock, "{}", { mode: 0o400 });
        assert.equal(
          await refresh(),
          `Claude integration refresh deferred because ${dir} is read-only. Make that directory writable and searchable, then run \`cotal update\`.`,
        );
        const recoveredSetup = await claudeSetupProvider.connector!.run({ cotal: [process.execPath, join(root, "cotal.js")] });
        assert.match(recoveredSetup, /^cotal@cotal-mesh \(user scope\)/);
        assert.equal(existsSync(otherLock), false);
      }
    } finally {
      rmSync(executable, { force: true });
      rmSync(market, { recursive: true, force: true });
    }
    const missingTarget = join(f.home, "missing-claude-marketplace");
    symlinkSync(missingTarget, market);
    try {
      assert.equal(
        await refresh(),
        `Claude integration refresh deferred because ${market} is a symbolic link to a missing target (${missingTarget}). Restore the link's target or replace the broken link, then run \`cotal update\`.`,
      );
      await assert.rejects(
        async () => claudeSetupProvider.connector!.run({ cotal: [process.execPath, join(root, "cotal.js")] }),
        new Error(`${market} is a symbolic link to a missing target (${missingTarget}). Restore the link's target or replace the broken link, then run \`cotal setup\`.`),
      );
    } finally {
      rmSync(market, { force: true });
    }
    symlinkSync(market, market);
    try {
      assert.equal(
        await refresh(),
        `Claude integration refresh deferred because ${market} is a symbolic-link loop. Replace the broken link with a writable and searchable directory, then run \`cotal update\`.`,
      );
      await assert.rejects(
        async () => claudeSetupProvider.connector!.run({ cotal: [process.execPath, join(root, "cotal.js")] }),
        new Error(`${market} is a symbolic-link loop. Replace the broken link with a writable and searchable directory, then run \`cotal setup\`.`),
      );
    } finally {
      rmSync(market, { force: true });
    }
    writeFileSync(market, "not a directory\n", { mode: 0o644 });
    try {
      await assert.rejects(async () => refresh(), { code: "EEXIST" });
      await assert.rejects(
        async () => claudeSetupProvider.connector!.run({ cotal: [process.execPath, join(root, "cotal.js")] }),
        { code: "EEXIST" },
      );
    } finally {
      rmSync(market, { force: true });
    }
  });
  if (process.platform !== "win32" && process.getuid?.() !== 0) await check("a default Claude account whose home parent is mode 0555 still refreshes", async () => {
    const parent = join(root, "nonwritable-parent");
    const home = join(parent, "user");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    Object.assign(process.env, { HOME: home, USERPROFILE: home, COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: join(home, ".config"), APPDATA: join(home, "appdata") });
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
    const claudeDir = join(home, ".claude");
    const plugins = join(claudeDir, "plugins");
    const records = join(plugins, "installed_plugins.json");
    const config = join(home, ".claude.json");
    const market = join(home, ".cotal", "claude-plugin");
    const plugin = join(market, "cotal");
    const executable = join(emptyBin, "claude");
    mkdirSync(plugins, { recursive: true, mode: 0o700 });
    writeFileSync(records, JSON.stringify({ plugins: { "cotal@cotal-mesh": [{ scope: "user" }] } }));
    writeFileSync(config, "{}");
    writeFileSync(executable, `#!${process.execPath}
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
switch (args.slice(0, 3).join(" ")) {
  case "--version": console.log("2.0.0"); break;
  case "plugin list --json": console.log(JSON.stringify([{ id: "cotal@cotal-mesh", scope: "user", enabled: true, readFromFolder: ${JSON.stringify(plugin)} }])); break;
  case "plugin marketplace list": console.log(JSON.stringify([{ name: "cotal-mesh", source: "directory", path: ${JSON.stringify(market)} }])); break;
  case "plugin marketplace add": case "plugin marketplace update": break;
  case "mcp add --scope": writeFileSync(${JSON.stringify(config)}, JSON.stringify({ mcpServers: { cotal: { command: args[6], args: args.slice(7) } } })); break;
  default: process.exit(1);
}
`, { mode: 0o700 });
    chmodSync(parent, 0o555);
    try {
      const detail = await refresh();
      assert.doesNotMatch(detail, /deferred/);
      assert.match(detail, /cotal@cotal-mesh/);
      assert.ok(existsSync(join(plugin, "dist", "cli.json")));
    } finally {
      chmodSync(parent, 0o700);
      rmSync(executable, { force: true });
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
