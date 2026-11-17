/** Codex refresh must distinguish no installed plugin from an installed plugin it cannot update. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  await check("a populated plugin cache still requires the native executable", async () => {
    const f = fixture("installed");
    mkdirSync(join(cache(f.codex), "0.1.0"), { recursive: true });
    await assert.rejects(async () => refresh(), /codex plugin list could not run/);
  });
  await check("a disabled cached plugin is not silently skipped", async () => {
    const f = fixture("disabled");
    mkdirSync(join(cache(f.codex), "0.1.0"), { recursive: true });
    writeFileSync(join(f.codex, "config.toml"), '[plugins."cotal@cotal-mesh"]\nenabled = false\n');
    await assert.rejects(async () => refresh(), /codex plugin list could not run/);
  });
  await check("an unreadable cache shape refuses instead of appearing absent", async () => {
    const f = fixture("invalid-cache");
    mkdirSync(join(f.codex, "plugins", "cache", "cotal-mesh"), { recursive: true });
    writeFileSync(cache(f.codex), "not a directory");
    await assert.rejects(async () => refresh(), /Codex plugin cache could not be read/);
  });
  await check("CODEX_HOME selects the native cache instead of the default home", async () => {
    const f = fixture("override");
    mkdirSync(join(cache(f.codex), "0.1.0"), { recursive: true });
    process.env.CODEX_HOME = join(f.root, "custom-codex");
    mkdirSync(process.env.CODEX_HOME);
    assert.equal(await refresh(), "not installed");
    mkdirSync(join(cache(process.env.CODEX_HOME), "0.1.0"), { recursive: true });
    await assert.rejects(async () => refresh(), /codex plugin list could not run/);
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
