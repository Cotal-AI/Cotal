/** Upgrade a real cached release through the setup provider, without editing Claude's registry.
 * Usage: tsx smoke/plugin-upgrade-live.smoke.ts [claude-binary] [baseline-marketplace] */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const binary = process.argv[2] || "claude";
const baseline = process.argv[3] || "Cotal-AI/Cotal#v0.88.0";
const root = realpathSync(mkdtempSync(join(tmpdir(), "cotal-plugin-upgrade-")));
const projects = [join(root, "one"), join(root, "two")];
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_") || key.startsWith("CLAUDE_") || key === "CLAUDECODE") delete process.env[key];
Object.assign(process.env, {
  HOME: root,
  XDG_CONFIG_HOME: join(root, ".config"),
  XDG_DATA_HOME: join(root, ".local", "share"),
  XDG_CACHE_HOME: join(root, ".cache"),
  CLAUDE_CONFIG_DIR: join(root, ".claude"),
  COTAL_HOME: join(root, ".cotal"),
  PATH: binary === "claude" ? process.env.PATH : `${dirname(binary)}:${process.env.PATH}`,
});
for (const path of [process.env.CLAUDE_CONFIG_DIR!, process.env.COTAL_HOME!, ...projects]) mkdirSync(path, { recursive: true });

const { claudeSetupProvider } = await import("../src/setup.js");
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = [process.execPath, "--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../../../bin/cotal.ts", import.meta.url))];
const folder = join(process.env.COTAL_HOME!, "claude-plugin", "cotal");
const release = (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string }).version;
const skills = { skillsDir: fileURLToPath(new URL("../../../implementations/cli/cotal-skills/skills", import.meta.url)), version: release, stateDir: process.env.COTAL_HOME! };
const settings = join(process.env.CLAUDE_CONFIG_DIR!, "settings.json");
const permissions = { deny: ["Bash(git push*)"] };
writeFileSync(settings, JSON.stringify({ permissions, cleanupPeriodDays: 27 }));
const result: { host?: string; baseline: string; checks: string[]; failure?: string } = { baseline, checks: [] };
function check(name: string, test: () => void): void {
  test();
  result.checks.push(name);
  console.log(`  ✓ ${name}`);
}
function claude(args: string[], cwd = projects[0]!): string {
  const r = spawnSync(binary, args, { cwd, env: process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  assert.equal(r.status, 0, `${args.slice(0, 3).join(" ")}: ${r.error?.message ?? ""}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
type Install = { id: string; version: string; enabled: boolean; installPath: string; readFromFolder?: string; lastUpdated: string };
const installed = (): Install => {
  const entry = (JSON.parse(claude(["plugin", "list", "--json"])) as Install[]).find((e) => e.id === "cotal@cotal-mesh");
  assert.ok(entry);
  return entry;
};
const version = (): string => (JSON.parse(readFileSync(join(folder, ".claude-plugin", "plugin.json"), "utf8")) as { version: string }).version;
const resolvedVersion = (entry: Install): string => (JSON.parse(readFileSync(join(entry.readFromFolder ?? entry.installPath, ".claude-plugin", "plugin.json"), "utf8")) as { version: string }).version;
const health = () => claudeSetupProvider.status!({ version: version().split("+")[0]!, skillsRemedy: "cotal setup --skills" }).find((row) => row.label === "Claude plugin");

try {
  result.host = claude(["--version"]).trim();
  claude(["plugin", "marketplace", "add", baseline, "--sparse", ".claude-plugin", "claude-plugin"]);
  claude(["plugin", "install", "cotal@cotal-mesh", "--scope", "user"]);
  claude(["plugin", "install", "cotal-skills@cotal-mesh", "--scope", "user"]);
  claude(["plugin", "disable", "cotal-skills@cotal-mesh", "--scope", "user"]);
  check("baseline is a real cached Git-marketplace installation", () => assert.ok(installed().installPath.includes(join("cache", "cotal-mesh", "cotal"))));
  claude(["plugin", "disable", "cotal@cotal-mesh", "--scope", "user"]);
  const old = installed().version;
  const recordsPath = join(process.env.CLAUDE_CONFIG_DIR!, "plugins", "installed_plugins.json");
  type Records = { plugins: Record<string, Record<string, unknown>[]> };
  const baselineRecords = JSON.parse(readFileSync(recordsPath, "utf8")) as Records;
  const legacyRecord = { ...baselineRecords.plugins["cotal@cotal-mesh"]![0], scope: "local", projectPath: projects[1] };
  await claudeSetupProvider.refresh!.run({ cotal: cli, skills });
  check("upgrade updates the recorded version and resolved payload", () => {
    const entry = installed();
    assert.notEqual(version(), old);
    assert.equal(resolvedVersion(entry), version());
    const actual = join(entry.readFromFolder ?? entry.installPath, "hooks", "native-wake.js");
    assert.deepEqual(readFileSync(actual), readFileSync(join(packageRoot, "hooks", "native-wake.js")));
  });
  check("upgrade preserves disabled user state and unrelated settings", () => {
    assert.equal(installed().enabled, false);
    const config = JSON.parse(readFileSync(settings, "utf8")) as { permissions: unknown; cleanupPeriodDays: number };
    assert.deepEqual(config.permissions, permissions);
    assert.equal(config.cleanupPeriodDays, 27);
  });
  check("upgrade refreshes the installed skills plugin without enabling it", () => {
    const entry = (JSON.parse(claude(["plugin", "list", "--json"])) as Install[]).find((e) => e.id === "cotal-skills@cotal-mesh");
    assert.equal(entry?.version, release);
    assert.equal(entry?.enabled, false);
  });
  claude(["plugin", "enable", "cotal@cotal-mesh", "--scope", "user"]);
  check("new sessions in two projects resolve the current server", () => {
    for (const project of projects) {
      const output = claude(["mcp", "list"], project);
      assert.ok(output.includes(join(folder, "dist", "mcp.cjs")), output);
      assert.match(output, /Connected/);
    }
    assert.equal(health()?.state, "ok");
  });
  const partial = JSON.parse(readFileSync(recordsPath, "utf8")) as Records;
  partial.plugins["cotal@cotal-mesh"]!.push(legacyRecord);
  writeFileSync(recordsPath, JSON.stringify(partial, null, 2));
  check("a legacy record cannot override the current folder payload", () => {
    assert.equal(health()?.state, "ok");
    claudeSetupProvider.refresh!.run({ cotal: cli, skills });
    assert.equal(health()?.state, "ok");
    const records = JSON.parse(readFileSync(recordsPath, "utf8")) as Records;
    assert.equal(records.plugins["cotal@cotal-mesh"]!.find((entry) => entry.scope === "local")?.version, old);
  });
  const stamp = installed().lastUpdated;
  await claudeSetupProvider.refresh!.run({ cotal: cli, skills });
  check("a repeated refresh does not reinstall an already current plugin", () => assert.equal(installed().lastUpdated, stamp));
  const moved = [process.execPath, "--no-warnings", ...cli.slice(1)];
  const prior = version();
  await claudeSetupProvider.refresh!.run({ cotal: moved, skills });
  check("a changed CLI record updates the plugin within the same release", () => {
    assert.notEqual(version(), prior);
    assert.equal(resolvedVersion(installed()), version());
    assert.deepEqual(JSON.parse(readFileSync(join(folder, "dist", "cli.json"), "utf8")), { argv: moved });
  });
  const module = join(folder, "hooks", "native-wake.js");
  const bytes = readFileSync(module);
  writeFileSync(module, "// incomplete installation fixture\n");
  check("health refuses a damaged resolved native module even with a current manifest", () => assert.equal(health()?.state, "warn"));
  writeFileSync(module, bytes);
  check("restored fixture reports the actual current installation", () => assert.equal(health()?.state, "ok"));
  check("a missing Claude executable cannot hide installed plugins during refresh", () => {
    const source = new URL("../src/setup.ts", import.meta.url).href;
    const script = `const { claudeSetupProvider: p } = await import(${JSON.stringify(source)}); await p.refresh.run({ cotal: ${JSON.stringify(cli)}, skills: ${JSON.stringify(skills)} });`;
    const path = process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32") : "/usr/bin:/bin";
    const env = { ...process.env, PATH: path };
    assert.notEqual(spawnSync("claude", ["--version"], { env }).status, 0, "fixture must lack a standalone Claude executable");
    const child = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], {
      env, cwd: root, encoding: "utf8", timeout: 30_000,
    });
    assert.notEqual(child.status, 0);
    assert.match(`${child.stdout}${child.stderr}`, /is installed, but Claude Code is unavailable/);
  });
  console.log(`plugin-upgrade-live.smoke: ${result.checks.length} checks passed (${result.host})`);
} catch (error) {
  result.failure = (error as Error).message;
  throw error;
} finally {
  writeFileSync(join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Upgrade evidence and isolated profile retained at ${root}`);
}
