/** Exercise the reconciliation used by self-update and rollback through the built CLI. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox, skipSuite, emitSentinel } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux" || process.getuid?.() === 0) skipSuite("read-only Claude refresh requires unprivileged Linux permissions");
const root = mkdtempSync(join(tmpdir(), "cotal-claude-refresh-live-"));
const cli = fileURLToPath(new URL("../dist/cotal.js", import.meta.url));
let passed = 0;
for (const name of [
  "absent",
  "readonly-config",
  "readonly-plugins",
  "readonly-installed-profile",
  "readonly-installed-cache",
  "readonly-installed-marketplace",
  "readonly-codex-marketplace",
]) {
  const base = join(root, name), home = join(base, "home"), project = join(base, "project"), native = join(base, "native");
  const config = join(base, "config"), state = join(base, "state"), runtime = join(base, "runtime");
  for (const dir of [home, project, native, config, state, runtime]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const tool of ["systemctl", "loginctl", "launchctl", "schtasks"]) {
    writeFileSync(join(native, tool), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  }
  const env: NodeJS.ProcessEnv = {
    PATH: `${native}:${process.env.PATH}`, HOME: home, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime,
    COTAL_HOME: state, CODEX_HOME: join(home, ".codex"), TMPDIR: root, COTAL_ALLOW_CHECKOUT_SEED: "1", COTAL_NO_UPDATE_CHECK: "1",
    COTAL_TELEMETRY: "off", DO_NOT_TRACK: "1", NO_COLOR: "1",
  };
  const anchor = recordSmokeSandbox({ root: project, cotalHome: state, xdgConfigHome: config });
  function run(...args: string[]) {
    const options = { env, cwd: project, encoding: "utf8" as const, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 };
    assertSmokeSandboxDown(anchor, args, options);
    const result = spawnSync(process.execPath, [cli, ...args], options);
    writeFileSync(join(base, `${args[0]}-${calls++}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}\nexit=${result.status} signal=${result.signal}\n`);
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    return `${result.stdout}${result.stderr}`;
  }
  let calls = 0, running = false;
  const installedSkills = name === "readonly-installed-profile" || name === "readonly-installed-cache";
  const installedMarketplace = name === "readonly-installed-marketplace";
  const codexMarketplace = name === "readonly-codex-marketplace";
  const claude = join(home, installedSkills || installedMarketplace ? "claude-profile" : ".claude"), plugins = join(claude, "plugins");
  const records = join(plugins, "installed_plugins.json");
  const protectedDir = name === "readonly-installed-cache" ? plugins
    : installedMarketplace ? join(state, "claude-plugin")
    : codexMarketplace ? join(state, "codex-plugin")
    : claude;
  const pluginKey = installedMarketplace ? "cotal@cotal-mesh" : "cotal-skills@cotal-mesh";
  const recordsBytes = JSON.stringify({ version: 2, plugins: { [pluginKey]: [{ scope: "user", version: "0.1.0" }] } });
  if (installedSkills || installedMarketplace) env.CLAUDE_CONFIG_DIR = claude;
  try {
    run("space", "create", "alpha", "--root", project);
    if (name === "readonly-installed-cache") run("ext", "seed");
    if (codexMarketplace) {
      mkdirSync(join(home, ".codex", "plugins", "cache", "cotal-mesh", "cotal", "0.1.0"), { recursive: true, mode: 0o700 });
      mkdirSync(protectedDir, { mode: 0o700 });
      writeFileSync(join(native, "codex"), `#!/bin/sh
if [ "$1 $2" = "plugin list" ]; then echo "cotal@cotal-mesh  installed, enabled  0.1.0"; exit 0; fi
if [ "$1 $2 $3 $4" = "plugin marketplace list --json" ]; then printf '{"marketplaces":[{"name":"cotal-mesh","root":"%s"}]}\\n' "${protectedDir}"; exit 0; fi
exit 1
`, { mode: 0o700 });
      chmodSync(protectedDir, 0o500);
    } else if (name !== "absent") {
      mkdirSync(claude);
      if (name === "readonly-plugins") { mkdirSync(plugins); chmodSync(plugins, 0o500); }
      if (installedSkills || installedMarketplace) { mkdirSync(plugins); writeFileSync(records, recordsBytes); }
      if (installedMarketplace) mkdirSync(protectedDir, { mode: 0o700 });
      chmodSync(protectedDir, 0o500);
    }
    if (name === "readonly-installed-cache") env.npm_config_offline = "true";
    const update = run("update");
    if (installedSkills) assert.ok(update.includes(`Claude skills refresh deferred because ${protectedDir} is read-only.`), update);
    else if (installedMarketplace) assert.ok(update.includes(`Claude integration refresh deferred because ${protectedDir} is read-only.`), update);
    else if (codexMarketplace) {
      assert.match(update, /Refresh the Claude Code plugin: not installed/);
      assert.ok(update.includes(`Codex plugin refresh deferred because ${protectedDir} is read-only. cotal@cotal-mesh remains at 0.1.0.`), update);
    } else assert.match(update, /Refresh the Claude Code plugin: not installed/);
    if (name === "readonly-installed-cache") assert.match(update, /Registry latest:?\s+not established/);
    const recovery = join(state, "update-recovery.json");
    if (name !== "readonly-installed-cache" || existsSync(recovery))
      assert.equal(JSON.parse(readFileSync(recovery, "utf8")), null);
    if (name === "absent") assert.equal(existsSync(claude), false);
    else if (codexMarketplace) {
      assert.equal(statSync(protectedDir).mode & 0o777, 0o500);
      assert.deepEqual(readdirSync(protectedDir), []);
    } else {
      assert.equal(statSync(protectedDir).mode & 0o777, 0o500);
      if (installedMarketplace) assert.deepEqual(readdirSync(protectedDir), []);
      assert.deepEqual(readdirSync(claude), name === "readonly-plugins" || installedSkills || installedMarketplace ? ["plugins"] : []);
      if (name === "readonly-plugins") assert.deepEqual(readdirSync(plugins), []);
      if (installedSkills || installedMarketplace) {
        assert.deepEqual(readdirSync(plugins), ["installed_plugins.json"]);
        assert.equal(readFileSync(records, "utf8"), recordsBytes);
      }
    }
    run("status");
    running = true;
    run("up", "--detach", "--server", `nats://127.0.0.1:${await freePort()}`);
    run("send", "-c", "general", "after reconciliation");
    passed++;
    console.log(`PASS ${name}: reconciliation, status, up and send leave Claude configuration unchanged${name === "readonly-installed-cache" ? "; the offline version check still exits 1" : ""}`);
  } finally {
    if (running) run("down", "--yes");
    if (name !== "absent" && existsSync(protectedDir)) chmodSync(protectedDir, 0o700);
    if (name === "readonly-plugins" && existsSync(plugins)) chmodSync(plugins, 0o700);
  }
}

function runNonwritableParentPair(kind: "claude" | "codex") {
  const base = join(root, `parent-pair-${kind}`);
  const parent = join(base, "users");
  const home = join(parent, "account");
  const project = join(base, "project");
  const native = join(base, "native");
  const config = join(home, ".config");
  const state = join(home, ".cotal");
  const runtime = join(base, "runtime");
  const codexHome = join(home, ".codex");
  for (const dir of [home, project, native, config, state, runtime, codexHome]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  for (const tool of ["systemctl", "loginctl", "launchctl", "schtasks"]) {
    writeFileSync(join(native, tool), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  }
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))),
    PATH: `${native}:${process.env.PATH}`,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    XDG_RUNTIME_DIR: runtime,
    COTAL_HOME: state,
    CODEX_HOME: codexHome,
    TMPDIR: root,
    COTAL_ALLOW_CHECKOUT_SEED: "1",
    COTAL_NO_UPDATE_CHECK: "1",
    COTAL_SKIP_ASSIST: "1",
    COTAL_TELEMETRY: "off",
    DO_NOT_TRACK: "1",
    NO_COLOR: "1",
  };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_CODE_PLUGIN_CACHE_DIR;

  let calls = 0;
  function execCli(...args: string[]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      env,
      cwd: project,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    writeFileSync(
      join(base, `${args[0]}-${calls++}.log`),
      `${result.stdout ?? ""}${result.stderr ?? ""}\nexit=${result.status} signal=${result.signal}\n`,
    );
    assert.ifError(result.error);
    return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }

  const market = join(state, kind === "claude" ? "claude-plugin" : "codex-plugin");
  const claudePlugin = join(state, "claude-plugin", "cotal");
  const claudeConfig = join(home, ".claude.json");
  const codexCache = join(codexHome, "plugins", "cache", "cotal-mesh", "cotal");
  const codexConfig = join(codexHome, "config.toml");

  if (kind === "claude") {
    const plugins = join(home, ".claude", "plugins");
    const claudeSkills = join(market, "cotal-skills");
    mkdirSync(plugins, { recursive: true, mode: 0o700 });
    writeFileSync(join(plugins, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "cotal@cotal-mesh": [{ scope: "user", version: "0.1.0" }] } }));
    writeFileSync(claudeConfig, "{}");
    writeFileSync(join(native, "claude"), `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const manifestPath = ${JSON.stringify(join(claudePlugin, ".claude-plugin", "plugin.json"))};
const skillsManifestPath = ${JSON.stringify(join(claudeSkills, ".claude-plugin", "plugin.json"))};
const version = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")).version : "0.1.0";
const entries = [{ id: "cotal@cotal-mesh", scope: "user", enabled: true, version, readFromFolder: ${JSON.stringify(claudePlugin)} }];
if (existsSync(skillsManifestPath)) {
  entries.push({ id: "cotal-skills@cotal-mesh", scope: "user", enabled: true, version: JSON.parse(readFileSync(skillsManifestPath, "utf8")).version, readFromFolder: ${JSON.stringify(claudeSkills)} });
}
switch (args.slice(0, 3).join(" ")) {
  case "--version": console.log("2.0.0"); break;
  case "plugin list --json": console.log(JSON.stringify(entries)); break;
  case "plugin marketplace list": console.log(JSON.stringify([{ name: "cotal-mesh", source: "directory", path: ${JSON.stringify(market)} }])); break;
  case "plugin marketplace add": case "plugin marketplace update":
  case "plugin install cotal@cotal-mesh": case "plugin update cotal@cotal-mesh":
  case "plugin install cotal-skills@cotal-mesh": case "plugin update cotal-skills@cotal-mesh": break;
  case "mcp remove --scope": writeFileSync(${JSON.stringify(claudeConfig)}, "{}"); break;
  case "mcp add --scope": writeFileSync(${JSON.stringify(claudeConfig)}, JSON.stringify({ mcpServers: { cotal: { command: args[6], args: args.slice(7) } } })); break;
  default: process.exit(1);
}
`, { mode: 0o700 });
  } else {
    mkdirSync(join(codexCache, "0.1.0"), { recursive: true, mode: 0o700 });
    writeFileSync(codexConfig, '[plugins."cotal@cotal-mesh"]\nenabled = true\n');
    writeFileSync(join(native, "codex"), `#!${process.execPath}
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2).join(" ");
const cacheRoot = ${JSON.stringify(codexCache)};
const market = ${JSON.stringify(market)};
if (args === "--version") console.log("0.172.0");
else if (args === "plugin list") {
  const versions = readdirSync(cacheRoot).sort();
  if (versions.length) console.log("cotal@cotal-mesh  installed, enabled  " + versions.at(-1));
} else if (args === "plugin marketplace list") console.log("cotal-mesh");
else if (args === "plugin marketplace list --json") console.log(JSON.stringify({ marketplaces: [{ name: "cotal-mesh", root: market }] }));
else if (args === "plugin marketplace add " + market) {}
else if (args === "plugin add cotal@cotal-mesh") {
  const manifest = readFileSync(market + "/plugins/cotal/.codex-plugin/plugin.json", "utf8");
  const version = JSON.parse(manifest).version;
  mkdirSync(cacheRoot + "/" + version + "/.codex-plugin", { recursive: true });
  writeFileSync(cacheRoot + "/" + version + "/.codex-plugin/plugin.json", manifest);
} else process.exit(1);
`, { mode: 0o700 });
  }

  try {
    assert.equal(execCli("space", "create", "alpha", "--root", project).status, 0);

    // 1. Non-writable home parent (0555) + writable marketplace: refresh RUNS and updates to the new version.
    chmodSync(parent, 0o555);
    const refreshedUnder0555 = execCli("update");
    assert.equal(refreshedUnder0555.status, 0, refreshedUnder0555.output);
    assert.doesNotMatch(refreshedUnder0555.output, /deferred because/);
    const manifestPath = kind === "claude"
      ? join(claudePlugin, ".claude-plugin", "plugin.json")
      : join(market, "plugins", "cotal", ".codex-plugin", "plugin.json");
    const newVersion = (JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string }).version;
    assert.notEqual(newVersion, "0.1.0");
    if (kind === "codex") assert.deepEqual(readdirSync(codexCache), [newVersion]);
    chmodSync(parent, 0o700);

    // 2. Writable parent + read-only marketplace: update defers with exit 0; explicit setup fails with the same sentence and remedy; restoring write access refreshes on next update.
    if (kind === "claude") {
      writeFileSync(manifestPath, JSON.stringify({ name: "cotal", version: "0.1.0" }));
    } else {
      rmSync(join(codexCache, newVersion), { recursive: true, force: true });
      mkdirSync(join(codexCache, "0.1.0"), { recursive: true, mode: 0o700 });
    }
    for (const mode of [0o500, 0o600] as const) {
      chmodSync(market, mode);
      const deferredUpdate = execCli("update");
      assert.equal(deferredUpdate.status, 0, deferredUpdate.output);
      const expectedUpdate = kind === "claude"
        ? `Claude integration refresh deferred because ${market} is read-only.`
        : `Codex plugin refresh deferred because ${market} is read-only. cotal@cotal-mesh remains at 0.1.0.`;
      assert.ok(deferredUpdate.output.includes(expectedUpdate), deferredUpdate.output);
      assert.ok(
        ["cotal update", "pnpm cotal update"].some((cmd) => deferredUpdate.output.includes(`Make that directory writable and searchable, then run \`${cmd}\`.`)),
        deferredUpdate.output,
      );

      const failedSetup = execCli("setup", "--destination", "local", "--harness", kind, "--project", project, "--space", "alpha", "--yes");
      assert.notEqual(failedSetup.status, 0, failedSetup.output);
      assert.ok(failedSetup.output.includes(`${market} is read-only.`), failedSetup.output);
      assert.ok(
        ["cotal setup", "pnpm cotal setup"].some((cmd) => failedSetup.output.includes(`Make that directory writable and searchable, then run \`${cmd}\`.`)),
        failedSetup.output,
      );
      chmodSync(market, 0o700);
    }
    const recoveredUpdate = execCli("update");
    assert.equal(recoveredUpdate.status, 0, recoveredUpdate.output);
    assert.doesNotMatch(recoveredUpdate.output, /deferred because/);
    const recoveredVersion = (JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string }).version;
    assert.equal(recoveredVersion, newVersion);
    if (kind === "codex") assert.deepEqual(readdirSync(codexCache), [newVersion]);

    // 2b. A 0400 .setup.lock in the writable marketplace is reclaimed: both cotal setup and cotal update exit 0 and complete.
    const marketLock = join(market, ".setup.lock");
    writeFileSync(marketLock, "{}", { mode: 0o400 });
    const setupOverMarketLock = execCli("setup", "--destination", "local", "--harness", kind, "--project", project, "--space", "alpha", "--yes");
    assert.equal(setupOverMarketLock.status, 0, setupOverMarketLock.output);
    assert.equal(existsSync(marketLock), false);

    if (kind === "claude") {
      writeFileSync(manifestPath, JSON.stringify({ name: "cotal", version: "0.1.0" }));
    } else {
      rmSync(join(codexCache, newVersion), { recursive: true, force: true });
      mkdirSync(join(codexCache, "0.1.0"), { recursive: true, mode: 0o700 });
    }
    writeFileSync(marketLock, "{}", { mode: 0o400 });
    const updateOverMarketLock = execCli("update");
    assert.equal(updateOverMarketLock.status, 0, updateOverMarketLock.output);
    assert.doesNotMatch(updateOverMarketLock.output, /deferred because/);
    assert.equal((JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string }).version, newVersion);
    assert.equal(existsSync(marketLock), false);

    if (kind === "claude") {
      for (const lockDir of [home, join(home, ".claude", "plugins")]) {
        const claudeLock = join(lockDir, ".cotal-setup.lock");
        writeFileSync(claudeLock, "{}", { mode: 0o400 });
        const setupOverClaudeLock = execCli("setup", "--destination", "local", "--harness", "claude", "--project", project, "--space", "alpha", "--yes");
        assert.equal(setupOverClaudeLock.status, 0, setupOverClaudeLock.output);
        assert.equal(existsSync(claudeLock), false);
      }
    }

    // 3. Dangling symbolic link and symbolic-link loop marketplace: update defers naming the broken link; explicit setup fails naming the same broken link.
    rmSync(market, { recursive: true, force: true });
    const missingTarget = join(base, `missing-${kind}-marketplace`);
    symlinkSync(missingTarget, market);
    const danglingUpdate = execCli("update");
    assert.equal(danglingUpdate.status, 0, danglingUpdate.output);
    assert.ok(
      danglingUpdate.output.includes(`${market} is a symbolic link to a missing target (${missingTarget}).`),
      danglingUpdate.output,
    );
    const danglingSetup = execCli("setup", "--destination", "local", "--harness", kind, "--project", project, "--space", "alpha", "--yes");
    assert.notEqual(danglingSetup.status, 0, danglingSetup.output);
    assert.ok(
      danglingSetup.output.includes(`${market} is a symbolic link to a missing target (${missingTarget}).`),
      danglingSetup.output,
    );
    rmSync(market, { force: true });

    symlinkSync(market, market);
    const loopUpdate = execCli("update");
    assert.equal(loopUpdate.status, 0, loopUpdate.output);
    assert.ok(loopUpdate.output.includes(`${market} is a symbolic-link loop.`), loopUpdate.output);
    const loopSetup = execCli("setup", "--destination", "local", "--harness", kind, "--project", project, "--space", "alpha", "--yes");
    assert.notEqual(loopSetup.status, 0, loopSetup.output);
    assert.ok(loopSetup.output.includes(`${market} is a symbolic-link loop.`), loopSetup.output);
    rmSync(market, { force: true });

    // 4. A non-directory (mode 0644 regular file) at the marketplace path keeps main's EEXIST failure rather than printing the read-only directory remedy.
    writeFileSync(market, "not a directory\n", { mode: 0o644 });
    const fileUpdate = execCli("update");
    assert.equal(fileUpdate.status, 1, fileUpdate.output);
    assert.doesNotMatch(fileUpdate.output, /deferred because/);
    assert.match(fileUpdate.output, /EEXIST/);
    const fileSetup = execCli("setup", "--destination", "local", "--harness", kind, "--project", project, "--space", "alpha", "--yes");
    assert.equal(fileSetup.status, 4, fileSetup.output);
    assert.doesNotMatch(fileSetup.output, /is read-only/);
    assert.match(fileSetup.output, /EEXIST/);
    rmSync(market, { force: true });
    passed++;
    console.log(`PASS parent-pair-${kind}: 0555 home parent refreshes; read-only or dangling-link marketplace defers update, fails explicit setup, and refreshes after repair`);
  } finally {
    if (existsSync(parent)) chmodSync(parent, 0o700);
    if (existsSync(market)) chmodSync(market, 0o700);
  }
}

runNonwritableParentPair("claude");
runNonwritableParentPair("codex");
console.log(`CLI evidence retained at ${root}`);
emitSentinel({ passed, failed: 0 });
