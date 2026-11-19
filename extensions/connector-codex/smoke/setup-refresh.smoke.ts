/** Codex refresh must distinguish no installed plugin from an installed plugin it cannot update. */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  await check("current read-only plugins need no reinstall, but a changed digest still does", async () => {
    const f = fixture("read-only-current");
    process.env.CODEX_HOME = f.codex;
    const installed = join(f.codex, "installed-version");
    const calls = join(f.root, "calls");
    mkdirSync(cache(f.codex), { recursive: true });
    writeFileSync(join(f.codex, "config.toml"), '[plugins."cotal@cotal-mesh"]\nenabled = false\n');
    writeFileSync(join(bin, "codex"), `#!${process.execPath}
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2).join(" ");
appendFileSync(${JSON.stringify(calls)}, args + "\\n");
if (args === "plugin list") {
  console.log("cotal@cotal-mesh  disabled, installed  " + readFileSync(${JSON.stringify(installed)}, "utf8"));
} else if (args === "plugin marketplace list") {
  console.log("cotal-mesh");
} else if (args === "plugin add cotal@cotal-mesh") {
  const plugin = JSON.parse(readFileSync(${JSON.stringify(join(process.env.COTAL_HOME!, "codex-plugin/plugins/cotal/.codex-plugin/plugin.json"))}, "utf8"));
  mkdirSync(${JSON.stringify(cache(f.codex))} + "/" + plugin.version);
  writeFileSync(${JSON.stringify(installed)}, plugin.version);
} else process.exit(1);
`, { mode: 0o755 });
    try {
      const cotal = [process.execPath, join(ROOT, "cotal.js")];
      await codexSetupProvider.connector!.run({ cotal });
      const version = readFileSync(installed, "utf8");
      writeFileSync(calls, "");
      for (const dir of [join(cache(f.codex), version), cache(f.codex), f.codex]) chmodSync(dir, 0o500);
      for (let attempt = 0; attempt < 2; attempt++) assert.equal(await refresh(), `cotal@cotal-mesh ${version}; new Codex conversations load it`);
      assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["plugin list", "plugin list"]);
      assert.equal(statSync(f.codex).mode & 0o777, 0o500);
      assert.equal(readFileSync(join(f.codex, "config.toml"), "utf8"), '[plugins."cotal@cotal-mesh"]\nenabled = false\n');
      const changed = { cotal: [process.execPath, join(ROOT, "different-cotal.js")] };
      await assert.rejects(async () => codexSetupProvider.refresh!.run(changed), /codex plugin add failed/);
      assert.equal(readFileSync(installed, "utf8"), version);
      assert.equal(await refresh(), `cotal@cotal-mesh ${version}; new Codex conversations load it`);
      for (const dir of [f.codex, cache(f.codex), join(cache(f.codex), version)]) chmodSync(dir, 0o700);
      assert.match(await codexSetupProvider.refresh!.run(changed), /new Codex conversations load it/);
      assert.notEqual(readFileSync(installed, "utf8"), version);
    } finally {
      for (const dir of [f.codex, cache(f.codex)]) chmodSync(dir, 0o700);
      rmSync(join(bin, "codex"));
    }
  });
} finally {
  for (const key of keys) {
    if (before[key] === undefined) delete process.env[key];
    else process.env[key] = before[key];
  }
  rmSync(ROOT, { recursive: true, force: true });
}
console.log(`codex setup refresh smoke: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
