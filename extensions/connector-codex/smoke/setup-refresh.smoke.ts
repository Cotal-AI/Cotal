/** Codex refresh must distinguish no installed plugin from an installed plugin it cannot update. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "cotal-codex-refresh-"));
const keys = ["HOME", "USERPROFILE", "CODEX_HOME", "COTAL_HOME", "PATH"] as const;
const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const bin = join(ROOT, "empty-bin");
mkdirSync(bin);
process.env.PATH = bin;
let passed = 0;
let failed = 0;

try {
  const { codexSetupProvider } = await import("../src/setup.js");
  const refresh = () => codexSetupProvider.refresh!.run({ cotal: [process.execPath, join(ROOT, "cotal.js")] });
  const fixture = (name: string) => {
    const root = join(ROOT, name);
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.COTAL_HOME = join(root, "cotal");
    delete process.env.CODEX_HOME;
    return { root, home, codex: join(home, ".codex") };
  };
  const cache = (home: string) => join(home, "plugins", "cache", "cotal-mesh", "cotal");
  const check = async (name: string, run: () => Promise<void>) => {
    try { await run(); passed++; console.log(`  ✓ ${name}`); }
    catch (error) { failed++; console.error(`  ✗ ${name}: ${(error as Error).message}`); }
  };

  await check("a host with no Codex installation needs no executable", async () => {
    fixture("absent");
    assert.equal(await refresh(), "not installed");
    assert.equal(existsSync(join(process.env.COTAL_HOME!, "codex-plugin", ".setup.lock")), false);
  });
  await check("an empty custom Codex home needs no executable", async () => {
    const f = fixture("empty-home");
    process.env.CODEX_HOME = join(f.root, "custom-codex");
    mkdirSync(process.env.CODEX_HOME);
    assert.equal(await refresh(), "not installed");
  });
  await check("an empty plugin cache needs no executable", async () => {
    const f = fixture("empty-cache");
    mkdirSync(cache(f.codex), { recursive: true });
    assert.equal(await refresh(), "not installed");
  });
  await check("configuration alone does not install a plugin", async () => {
    const f = fixture("config-only");
    mkdirSync(f.codex);
    writeFileSync(join(f.codex, "config.toml"), '[plugins."cotal@cotal-mesh"]\nenabled = true\n');
    assert.equal(await refresh(), "not installed");
  });
  await check("a removed Codex host leaves its populated cache dormant", async () => {
    const f = fixture("installed");
    mkdirSync(join(cache(f.codex), "0.1.0"), { recursive: true });
    assert.equal(await refresh(), "Codex not installed; cached plugin left unchanged");
    assert.equal(existsSync(join(cache(f.codex), "0.1.0")), true);
    assert.equal(existsSync(join(process.env.COTAL_HOME!, "codex-plugin", "plugins")), false);
  });
  await check("a removed host leaves its disabled cached plugin dormant", async () => {
    const f = fixture("disabled");
    mkdirSync(join(cache(f.codex), "0.1.0"), { recursive: true });
    writeFileSync(join(f.codex, "config.toml"), '[plugins."cotal@cotal-mesh"]\nenabled = false\n');
    assert.equal(await refresh(), "Codex not installed; cached plugin left unchanged");
  });
  await check("an unreadable cache shape refuses instead of appearing absent", async () => {
    const f = fixture("invalid-cache");
    mkdirSync(join(f.codex, "plugins", "cache", "cotal-mesh"), { recursive: true });
    writeFileSync(cache(f.codex), "not a directory");
    await assert.rejects(async () => refresh(), /Codex plugin cache could not be read/);
  });
  await check("an installed but non-executable Codex still refuses refresh", async () => {
    const f = fixture("permission-denied");
    mkdirSync(join(cache(f.codex), "0.1.0"), { recursive: true });
    writeFileSync(join(bin, "codex"), "not executable", { mode: 0o600 });
    try { await assert.rejects(async () => refresh(), /codex plugin list could not run/); }
    finally { rmSync(join(bin, "codex")); }
  });
  await check("CODEX_HOME selects the native cache instead of the default home", async () => {
    const f = fixture("override");
    mkdirSync(join(cache(f.codex), "0.1.0"), { recursive: true });
    process.env.CODEX_HOME = join(f.root, "custom-codex");
    mkdirSync(process.env.CODEX_HOME);
    assert.equal(await refresh(), "not installed");
    mkdirSync(join(cache(process.env.CODEX_HOME), "0.1.0"), { recursive: true });
    assert.equal(await refresh(), "Codex not installed; cached plugin left unchanged");
  });
  await check("read-only Codex config keeps its bytes and mode while the cache moves to the new digest", async () => {
    const f = fixture("read-only-current");
    process.env.CODEX_HOME = f.codex;
    const market = join(process.env.COTAL_HOME!, "codex-plugin");
    const priorMarket = join(f.root, "previous-marketplace");
    mkdirSync(priorMarket);
    const calls = join(f.root, "calls");
    const config = join(f.codex, "config.toml");
    const disabledConfig = '[plugins."cotal@cotal-mesh"]\nenabled = false\n';
    mkdirSync(cache(f.codex), { recursive: true });
    writeFileSync(config, disabledConfig);
    writeFileSync(join(bin, "codex"), `#!${process.execPath}
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
const config = ${JSON.stringify(config)};
const market = ${JSON.stringify(market)};
const cacheRoot = ${JSON.stringify(cache(f.codex))};
const args = process.argv.slice(2).join(" ");
appendFileSync(${JSON.stringify(calls)}, args + "\\n");
if (args === "plugin list") {
  const versions = readdirSync(cacheRoot).sort();
  if (versions.length) console.log("cotal@cotal-mesh  disabled, installed  " + versions.at(-1));
} else if (args === "plugin marketplace list") {
  console.log("cotal-mesh");
} else if (args === "plugin marketplace list --json") {
  const moved = readFileSync(config, "utf8").includes("# previous marketplace");
  console.log(JSON.stringify({ marketplaces: [{ name: "cotal-mesh", root: moved ? ${JSON.stringify(priorMarket)} : market }] }));
} else if (args === "plugin marketplace remove cotal-mesh") {
  // The fixture models the config edit in the subsequent marketplace add.
} else if (args === "plugin marketplace add " + market) {
  writeFileSync(config, readFileSync(config, "utf8").replace("# previous marketplace\\n", ""));
} else if (args === "plugin add cotal@cotal-mesh") {
  const plugin = readFileSync(${JSON.stringify(join(process.env.COTAL_HOME!, "codex-plugin/plugins/cotal/.codex-plugin/plugin.json"))}, "utf8");
  const cache = ${JSON.stringify(cache(f.codex))} + "/" + JSON.parse(plugin).version;
  mkdirSync(cache + "/.codex-plugin", { recursive: true });
  writeFileSync(cache + "/.codex-plugin/plugin.json", plugin);
  writeFileSync(cache + "/.mcp.json", "{}");
  writeFileSync(config + ".tmp", readFileSync(config, "utf8").replace("# stale\\n", ""), { mode: 0o600 });
  renameSync(config + ".tmp", config);
} else process.exit(1);
`, { mode: 0o755 });
    try {
      const cotal = [process.execPath, join(ROOT, "cotal.js")];
      const written: string[] = [];
      const setup = () => codexSetupProvider.connector!.run({ cotal, wrote: (_, path) => written.push(path) });
      writeFileSync(config, `# stale\n${disabledConfig}`);
      await setup();
      const manifest = join(market, "plugins/cotal/.codex-plugin/plugin.json");
      const materializedVersion = () => (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
      const version = materializedVersion();
      assert.ok(written.includes(config), "the native config content change must be reported");
      assert.ok(written.includes(join(process.env.COTAL_HOME!, "codex-plugin/plugins/cotal/.mcp.json")));
      for (const path of [".codex-plugin/plugin.json", ".mcp.json"]) {
        assert.ok(written.includes(join(cache(f.codex), version, path)), `the cached ${path} write must be reported`);
      }
      written.length = 0;
      await setup();
      assert.deepEqual(written, [], "identical marketplace, config and cache rewrites must not be reported");
      const cachedMcp = join(cache(f.codex), version, ".mcp.json");
      rmSync(cachedMcp);
      const marketplaceMcp = join(process.env.COTAL_HOME!, "codex-plugin/plugins/cotal/.mcp.json");
      writeFileSync(marketplaceMcp, "{}");
      await setup();
      assert.deepEqual(written, [marketplaceMcp, cachedMcp], "repair reports only the changed and recreated files");
      assert.deepEqual(codexSetupProvider.status!({ version: version.split("+")[0]!, skillsRemedy: "" }), [
        { label: "Codex plugin", state: "off", text: "disabled" },
      ]);
      assert.equal(readFileSync(config, "utf8"), disabledConfig);
      chmodSync(config, 0o444);
      writeFileSync(calls, "");
      const changed = { cotal: [process.execPath, join(ROOT, "different-cotal.js")] };
      const currentRefresh = await codexSetupProvider.refresh!.run(changed);
      assert.match(currentRefresh, /remains disabled/);
      assert.doesNotMatch(currentRefresh, /read-only/);
      const current = materializedVersion();
      assert.notEqual(current, version);
      assert.equal(existsSync(join(cache(f.codex), version)), false);
      assert.deepEqual(readFileSync(join(cache(f.codex), current, ".codex-plugin/plugin.json")), readFileSync(manifest));
      assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["plugin list", "plugin marketplace list --json", "plugin list"]);
      assert.equal(statSync(config).mode & 0o777, 0o444);
      assert.equal(readFileSync(config, "utf8"), disabledConfig);

      chmodSync(config, 0o600);
      const outdatedConfig = `# previous marketplace\n${disabledConfig}`;
      writeFileSync(config, outdatedConfig);
      chmodSync(config, 0o444);
      const deferred = await codexSetupProvider.refresh!.run({ cotal });
      assert.match(deferred, /remains disabled/);
      assert.deepEqual(readFileSync(join(cache(f.codex), version, ".codex-plugin/plugin.json")), readFileSync(manifest));
      assert.ok(deferred.includes(config));
      assert.match(deferred, /run `cotal update`/);
      const status = () => codexSetupProvider.status!({ version: version.split("+")[0]!, skillsRemedy: "" })[0]!;
      assert.equal(status().state, "warn");
      assert.ok(status().text.includes(config));
      assert.equal(statSync(config).mode & 0o777, 0o444);
      assert.equal(readFileSync(config, "utf8"), outdatedConfig);
      chmodSync(config, 0o600);
      const repaired = await codexSetupProvider.refresh!.run({ cotal });
      assert.equal(readFileSync(config, "utf8"), disabledConfig);
      assert.doesNotMatch(repaired, /read-only/);
      assert.equal(status().state, "off");
      assert.ok(!status().text.includes(config));
      if (process.platform !== "win32") {
        chmodSync(cache(f.codex), 0o500);
        const protectedCache = await codexSetupProvider.refresh!.run(changed);
        assert.ok(protectedCache.includes(cache(f.codex)));
        assert.match(protectedCache, /read-only.*run `cotal update`/);
        assert.ok(existsSync(join(cache(f.codex), version, ".codex-plugin/plugin.json")));
      }
    } finally {
      for (const dir of [f.codex, cache(f.codex)]) chmodSync(dir, 0o700);
      rmSync(join(bin, "codex"));
    }
  });
  if (process.platform !== "win32") {
    process.env.PATH = before.PATH;
    const codex = (...args: string[]) => spawnSync("codex", args, { encoding: "utf8", timeout: 60_000 });
    if (codex("--version").status === 0) await check("native Codex keeps a read-only cache and refreshes after write access returns", async () => {
      const f = fixture("native");
      const cotal = [process.execPath, join(ROOT, "cotal.js")];
      await codexSetupProvider.connector!.run({ cotal });
      const config = join(f.codex, "config.toml");
      chmodSync(config, 0o444);
      const original = readFileSync(config);
      const inode = statSync(config).ino;
      const beforeRefresh = codex("plugin", "list");
      assert.equal(beforeRefresh.status, 0, beforeRefresh.stderr);
      const changed = [process.execPath, join(ROOT, "updated-cotal.js")];
      const cacheDir = cache(f.codex);
      const [oldVersion] = readdirSync(cacheDir);
      assert.ok(oldVersion);
      chmodSync(config, 0o600);
      chmodSync(cacheDir, 0o500);
      try {
        const deferred = await codexSetupProvider.refresh!.run({ cotal: changed });
        assert.ok(deferred.includes(`cotal@cotal-mesh remains at ${oldVersion}`), deferred);
        assert.equal(statSync(cacheDir).mode & 0o777, 0o500);
        assert.deepEqual(readdirSync(cacheDir), [oldVersion]);
        assert.equal(codex("plugin", "list").stdout, beforeRefresh.stdout);
        assert.deepEqual(readFileSync(config), original);
      } finally {
        chmodSync(cacheDir, 0o700);
      }
      chmodSync(config, 0o444);
      await codexSetupProvider.refresh!.run({ cotal: changed });
      const afterRefresh = codex("plugin", "list");
      assert.equal(afterRefresh.status, 0, afterRefresh.stderr);
      const manifest = join(process.env.COTAL_HOME!, "codex-plugin/plugins/cotal/.codex-plugin/plugin.json");
      const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version: string };
      assert.ok(afterRefresh.stdout.includes(version), afterRefresh.stdout);
      assert.ok(!beforeRefresh.stdout.includes(version), beforeRefresh.stdout);
      assert.deepEqual(readFileSync(config), original);
      assert.equal(statSync(config).ino, inode);
      assert.equal(statSync(config).mode & 0o777, 0o444);
    });
    if (codex("--version").status === 0) for (const enabled of [true, false]) {
      await check(`native Codex repoints a moved marketplace and keeps the plugin ${enabled ? "enabled" : "disabled"}`, async () => {
        const f = fixture(`native-moved-${enabled}`);
        const cotal = [process.execPath, join(ROOT, "cotal.js")];
        await codexSetupProvider.connector!.run({ cotal });
        const original = join(process.env.COTAL_HOME!, "codex-plugin");
        const unrelated = join(f.root, "other-marketplace");
        mkdirSync(join(unrelated, ".agents/plugins"), { recursive: true });
        writeFileSync(join(unrelated, ".agents/plugins/marketplace.json"), '{"name":"other-marketplace","plugins":[]}\n');
        const added = codex("plugin", "marketplace", "add", unrelated);
        assert.equal(added.status, 0, added.stderr);
        const config = join(f.codex, "config.toml");
        if (!enabled) writeFileSync(config, readFileSync(config, "utf8").replace("enabled = true", "enabled = false"));
        const originalConfig = readFileSync(config, "utf8");
        process.env.COTAL_HOME = join(f.root, "new home's files");
        mkdirSync(process.env.COTAL_HOME);
        const replacement = join(process.env.COTAL_HOME, "codex-plugin");
        const missing = join(f.root, "not the Cotal marketplace");
        renameSync(original, missing);

        const broken = codex("plugin", "list");
        assert.notEqual(broken.status, 0);
        assert.match(broken.stderr, /marketplace root does not contain a supported manifest/);
        assert.match(await refresh(), /Restore the Cotal marketplace/);
        assert.equal(readFileSync(config, "utf8"), originalConfig);
        renameSync(missing, replacement);

        const changed = [process.execPath, join(ROOT, "updated-cotal.js")];
        chmodSync(config, 0o444);
        assert.match(await codexSetupProvider.refresh!.run({ cotal: changed }), /read-only/);
        assert.equal(statSync(config).mode & 0o777, 0o444);
        assert.equal(readFileSync(config, "utf8"), originalConfig);
        chmodSync(config, 0o600);
        await codexSetupProvider.refresh!.run({ cotal: changed });

        const listed = codex("plugin", "list");
        assert.equal(listed.status, 0, listed.stderr);
        assert.match(listed.stdout, new RegExp(`^cotal@cotal-mesh\\s+installed, ${enabled ? "enabled" : "disabled"}\\s+`, "m"));
        assert.equal(readFileSync(config, "utf8"), originalConfig.replace(original, replacement));
        assert.equal(existsSync(original), false);
        const manifest = join(replacement, "plugins/cotal/.codex-plugin/plugin.json");
        const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version: string };
        assert.ok(listed.stdout.includes(version), listed.stdout);
        assert.deepEqual(readFileSync(join(cache(f.codex), version, ".codex-plugin/plugin.json")), readFileSync(manifest));
      });
    }
  }
} finally {
  for (const key of keys) {
    if (before[key] === undefined) delete process.env[key];
    else process.env[key] = before[key];
  }
  rmSync(ROOT, { recursive: true, force: true });
}
console.log(`codex setup refresh smoke: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
