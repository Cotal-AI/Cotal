/** Two Cotal homes must not replace one shared Claude profile's installed registrations. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const tree = fileURLToPath(new URL("../../..", import.meta.url));
process.umask(0o077);
const root = realpathSync(mkdtempSync(join(tmpdir(), "cotal-registration-home-")));
const boundary = spawnSync("git", ["init", "-q", root], { encoding: "utf8" });
assert.equal(boundary.status, 0, boundary.stderr);
const cli = join(tree, "bin", "dist", "cotal.js");
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith("COTAL_") && !key.startsWith("CLAUDE_") && key !== "CLAUDECODE" && key !== "CLAUDE_PID"));
const standins = join(root, "bin");
const serviceLog = join(root, "service-calls.log");
mkdirSync(standins);
writeFileSync(serviceLog, "");
for (const name of ["systemctl", "launchctl", "schtasks"]) {
  writeFileSync(join(standins, name), `#!/bin/sh\necho ${name} >> '${serviceLog}'\nexit 1\n`, { mode: 0o700 });
}
const template = join(root, "template");
function env(profile: string, home: string): NodeJS.ProcessEnv {
  const user = join(root, `user-${profile}`);
  const config = join(root, `claude-${profile}`);
  const xdg = join(user, "config");
  for (const path of [user, config, xdg, home, join(user, "runtime")]) mkdirSync(path, { recursive: true });
  if (existsSync(join(template, "config", "cotal")) && !existsSync(join(xdg, "cotal")))
    cpSync(join(template, "config", "cotal"), join(xdg, "cotal"), { recursive: true, verbatimSymlinks: true });
  return {
    ...clean, PATH: `${standins}:${process.env.PATH ?? ""}`, HOME: user, USERPROFILE: user, USER_HOME: user,
    XDG_CONFIG_HOME: xdg, XDG_RUNTIME_DIR: join(user, "runtime"),
    XDG_DATA_HOME: join(user, "data"), XDG_CACHE_HOME: join(user, "cache"), COTAL_HOME: home,
    CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PLUGIN_CACHE_DIR: join(config, "plugins"),
    NODE_COMPILE_CACHE: join(root, "compile-cache"), COTAL_ALLOW_CHECKOUT_SEED: "1", COTAL_SKIP_ASSIST: "1",
  };
}
function run(command: string, args: string[], environment: NodeJS.ProcessEnv, cwd = root, timeout = 300_000) {
  const result = spawnSync(command, args, { env: environment, cwd, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
  assert.ifError(result.error);
  return result;
}
const seedEnv = { ...env("seed", template), XDG_CONFIG_HOME: join(template, "config") };
mkdirSync(seedEnv.XDG_CONFIG_HOME, { recursive: true });
const seeded = run(process.execPath, [cli, "ext", "seed"], seedEnv);
assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
const homeA = join(root, "home-a");
const homeB = join(root, "home-b");
const envA = env("shared", homeA);
const envB = env("shared", homeB);
function setup(environment: NodeJS.ProcessEnv, project: string, space: string, timeout = 300_000) {
  const cwd = join(root, project);
  mkdirSync(cwd, { recursive: true });
  const result = run(process.execPath, [cli, "setup", "--destination", "local", "--harness", "claude", "--project", cwd, "--space", space, "--configure-only", "--json"], environment, cwd, timeout);
  writeFileSync(join(root, `${project}-${space}.json`), result.stdout);
  return result;
}
function claude(environment: NodeJS.ProcessEnv, ...args: string[]): string {
  const result = run("claude", args, environment);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function profileBytes(environment: NodeJS.ProcessEnv) {
  return [join(environment.CLAUDE_CONFIG_DIR!, ".claude.json"), join(environment.CLAUDE_CODE_PLUGIN_CACHE_DIR!, "known_marketplaces.json")]
    .map((path) => readFileSync(path, "utf8"));
}
function resolved(environment: NodeJS.ProcessEnv, home: string): void {
  const entries = JSON.parse(claude(environment, "plugin", "list", "--json")) as Array<{ id: string; readFromFolder?: string }>;
  for (const name of ["cotal", "cotal-skills"])
    assert.equal(entries.find((entry) => entry.id === `${name}@cotal-mesh`)?.readFromFolder, join(home, "claude-plugin", name));
  const servers = claude(environment, "mcp", "list");
  assert.ok(servers.split("\n").find((line) => line.startsWith("cotal:"))?.includes(join(home, "claude-plugin", "cotal", "dist", "seat.cjs")), servers);
}

function assertIndependentCodexRepair(): void {
  const from = join(root, "codex-old-home");
  const to = join(root, "codex-new-home");
  const project = join(root, "codex-project");
  const codexHome = join(root, "codex-profile");
  const shared: NodeJS.ProcessEnv = { ...env("codex-move", from), CODEX_HOME: codexHome };
  if (spawnSync("codex", ["--version"], { env: shared, timeout: 30_000 }).status !== 0) {
    console.log("SKIP: native Codex not available for the independent connector refresh case");
    return;
  }
  for (const path of [to, project, codexHome]) mkdirSync(path);
  const installed = run(process.execPath, [cli, "setup", "--destination", "local", "--harness", "codex",
    "--project", project, "--space", "triage-codex", "--configure-only", "--no-input"], shared, project);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.match(claude(shared, "plugin", "list", "--json"), /cotal-skills@cotal-mesh/);
  const marketplaces = join(shared.CLAUDE_CODE_PLUGIN_CACHE_DIR!, "known_marketplaces.json");
  const original = readFileSync(marketplaces, "utf8");
  assert.equal(JSON.parse(original)["cotal-mesh"].source.path, join(from, "claude-plugin"));

  const replacement = join(to, "codex-plugin");
  renameSync(join(from, "codex-plugin"), replacement);
  const moved: NodeJS.ProcessEnv = { ...shared, COTAL_HOME: to };
  const broken = run("codex", ["plugin", "list"], moved, project);
  assert.equal(broken.status, 1, broken.stdout + broken.stderr);
  assert.match(broken.stderr, /marketplace root does not contain a supported manifest/);
  assert.ok(broken.stderr.includes(join(from, "codex-plugin")), broken.stderr);

  const update = run(process.execPath, [cli, "update"], moved, project);
  assert.equal(update.status, 1, update.stdout + update.stderr);
  assert.match(update.stderr, /connector installs: claude: Claude marketplace cotal-mesh belongs to Cotal home/);
  assert.ok(update.stderr.includes(from) && update.stderr.includes(to), update.stderr);
  assert.match(update.stdout, /✓ Refresh the Codex plugin: cotal@cotal-mesh/);
  assert.doesNotMatch(update.stdout, /connector integrations refreshed/);
  assert.equal(readFileSync(marketplaces, "utf8"), original);
  const repaired = run("codex", ["plugin", "list"], moved, project);
  assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);
  assert.match(repaired.stdout, /cotal@cotal-mesh\s+installed, enabled/);
  const registered = run("codex", ["plugin", "marketplace", "list"], moved, project);
  assert.equal(registered.status, 0, registered.stdout + registered.stderr);
  assert.ok(registered.stdout.includes(replacement), registered.stdout);
  console.log("PASS: update preserves the foreign Claude marketplace and repairs the moved Codex plugin");

  const version = run(process.execPath, [cli, "--version"], moved, project).stdout.match(/^cotal-ai (\S+)/)?.[1];
  assert.ok(version);
  const stamp = join(moved.XDG_CONFIG_HOME!, "cotal", "seed", "stamp.json");
  writeFileSync(stamp, JSON.stringify({ ...JSON.parse(readFileSync(stamp, "utf8")), generation: "0.0.1" }));
  const reconcile = run(process.execPath, [cli, "update"], {
    ...moved, COTAL_UPDATE_PARENT: String(process.pid), COTAL_UPDATE_TARGET_VERSION: version,
  }, project);
  assert.equal(reconcile.status, 0, reconcile.stdout + reconcile.stderr);
  assert.equal(reconcile.stderr.match(/Skipped claude integration refresh: Claude marketplace cotal-mesh belongs to Cotal home/g)?.length, 1, reconcile.stderr);
  assert.match(reconcile.stdout, /✓ Refresh the Codex plugin: cotal@cotal-mesh/);
  assert.equal(JSON.parse(readFileSync(stamp, "utf8")).generation, version);
  assert.equal(readFileSync(marketplaces, "utf8"), original);
  console.log("PASS: self-update reconciliation skips the foreign Claude marketplace and commits the generation");
}

async function assertCurrentUpdateRepairsCodex(): Promise<void> {
  if (process.platform !== "linux" || spawnSync("codex", ["--version"], { env: env("codex-version", root), timeout: 30_000 }).status !== 0) return;
  const version = "0.151.3";
  const build = join(root, "installed-build");
  const from = join(root, "current-old");
  const to = join(root, "current-new");
  const project = join(root, "current-project");
  const shared = env("current", from);
  delete shared.COTAL_ALLOW_CHECKOUT_SEED;
  const config = join(root, "current-config");
  const codexHome = join(root, "current-codex");
  const environment = { ...shared, XDG_CONFIG_HOME: config, CODEX_HOME: codexHome };
  for (const path of [to, project, config, codexHome]) mkdirSync(path);
  const built = run(process.execPath, [join(tree, "bin/smoke/build-daemon-upgrade-fixture.mjs"), build, "--workspace-source"], environment, tree);
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const prefix = join(root, "current-prefix");
  const installed = run("npm", ["install", "-g", "--prefix", prefix, "--ignore-scripts", "--offline", join(build, `cotal-ai-${version}.tgz`)], environment, project);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const entry = join(prefix, "lib/node_modules/cotal-ai/dist/cotal.js");
  const setup = run(process.execPath, [entry, "setup", "--destination", "local", "--harness", "codex", "--project", project,
    "--space", "current-codex", "--configure-only", "--no-input"], environment, project);
  assert.equal(setup.status, 0, setup.stdout + setup.stderr);
  const marketplaces = join(shared.CLAUDE_CODE_PLUGIN_CACHE_DIR!, "known_marketplaces.json");
  const claudeBefore = readFileSync(marketplaces);
  const moved = { ...environment, COTAL_HOME: to };
  const replacement = join(to, "codex-plugin");
  renameSync(join(from, "codex-plugin"), replacement);
  const broken = run("codex", ["plugin", "list"], moved, project);
  assert.equal(broken.status, 1, broken.stdout + broken.stderr);
  assert.match(broken.stderr, /marketplace root does not contain a supported manifest/);
  const registry = createServer((_request, response) => response.end(JSON.stringify({
    name: "cotal-ai", "dist-tags": { latest: version }, versions: { [version]: { name: "cotal-ai", version } },
  })));
  await new Promise<void>((resolve, reject) => registry.once("error", reject).listen(0, "127.0.0.1", resolve));
  try {
    const address = registry.address();
    assert.ok(address && typeof address !== "string");
    const updateEnv = { ...moved, npm_config_registry: `http://127.0.0.1:${address.port}` };
    const selfUpdate = () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [entry, "update", "--self"], { cwd: project, env: updateEnv, timeout: 120_000 });
      let output = "";
      child.stdout.on("data", (data) => { output += data; });
      child.stderr.on("data", (data) => { output += data; });
      child.once("error", reject).once("close", (code) => {
        if (code === 0) resolve(output);
        else reject(new Error(`self-update exited ${code}: ${output}`));
      });
    });
    const repaired = await selfUpdate();
    assert.match(repaired, /installed package closure is current/);
    assert.match(repaired, /Refresh the Codex plugin: cotal@cotal-mesh/);
    const listed = run("codex", ["plugin", "list"], moved, project);
    assert.equal(listed.status, 0, listed.stdout + listed.stderr);
    assert.match(listed.stdout, /cotal@cotal-mesh\s+installed, enabled/);
    assert.ok(listed.stdout.includes(replacement));
    assert.deepEqual(readFileSync(marketplaces), claudeBefore);
    assert.match(await selfUpdate(), /installed package closure is current\. No connector reconciliation was run\./);
    console.log("PASS: installed same-version self-update repairs the moved Codex marketplace once");
  } finally {
    await new Promise<void>((resolve) => registry.close(() => resolve()));
  }
}
const first = setup(envA, "project-a", "triage-a");
assert.equal(first.status, 0, first.stdout + first.stderr);
resolved(envA, homeA);
const beforeRepeat = profileBytes(envA);
const repeat = setup(envA, "project-a", "triage-a");
assert.equal(repeat.status, 0, repeat.stdout + repeat.stderr);
assert.equal(profileBytes(envA)[0], beforeRepeat[0]);
resolved(envA, homeA);
const original = profileBytes(envA);
console.log("PASS: same-home setup is idempotent");

const foreign = setup(envB, "project-b", "triage-b");
assert.notEqual(foreign.status, 0, "setup must refuse another Cotal home's registrations");
assert.ok((foreign.stdout + foreign.stderr).includes(homeA), foreign.stdout + foreign.stderr);
assert.match(foreign.stdout + foreign.stderr, /separate CLAUDE_CONFIG_DIR/);
assert.deepEqual(profileBytes(envA), original);
resolved(envA, homeA);
assert.ok(!existsSync(join(homeB, "claude-plugin", "cotal")), "refuse before materializing the competing plugin");
console.log("PASS: shipped setup refuses home B, names home A, and preserves both registrations");

// The same guard must cover connector refresh and the independently callable skills action.
const probe = join(root, "provider.mjs");
writeFileSync(probe, `import { claudeSetupProvider as p } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
const input = { cotal: [process.execPath, ${JSON.stringify(cli)}], skills: { skillsDir: ${JSON.stringify(join(tree, "implementations", "cli", "cotal-skills", "skills"))}, version: "0.0.0", stateDir: process.env.COTAL_HOME } };
try { p[process.argv[2]].run(process.argv[2] === "skills" ? input.skills : input); process.exitCode = 2; }
catch (error) { console.log(error.message); process.exitCode = error.message.includes("belongs to Cotal home") ? 0 : 1; }
`);
for (const action of ["refresh", "skills"]) {
  const result = run(process.execPath, [probe, action], envB);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(profileBytes(envA), original);
}
console.log("PASS: refresh and skills refuse without changing the shared profile");

const separate = env("separate", homeB);
const independent = setup(separate, "project-independent", "triage-independent");
assert.equal(independent.status, 0, independent.stdout + independent.stderr);
resolved(separate, homeB);
assert.deepEqual(profileBytes(envA), original);
const again = setup(envA, "project-a", "triage-a");
assert.equal(again.status, 0, again.stdout + again.stderr);
resolved(envA, homeA);
console.log("PASS: a separate profile supports home B and home A remains usable");
claude(envA, "plugin", "marketplace", "remove", "cotal-mesh");
const mcpOnly = readFileSync(join(envA.CLAUDE_CONFIG_DIR!, ".claude.json"), "utf8");
const noMarketplace = setup(envB, "project-b", "triage-b");
assert.notEqual(noMarketplace.status, 0);
assert.match(noMarketplace.stdout + noMarketplace.stderr, /Claude user MCP entry cotal belongs to Cotal home/);
assert.equal(readFileSync(join(envA.CLAUDE_CONFIG_DIR!, ".claude.json"), "utf8"), mcpOnly);
console.log("PASS: an MCP-only registration cannot be taken over either");

// The two shared lock names can address one physical file through different parent paths.
const aliasHome = join(root, "home-cache-alias");
const aliasEnv = env("cache-alias", aliasHome);
const cacheAlias = join(root, "cache-alias");
symlinkSync(aliasEnv.CLAUDE_CONFIG_DIR!, cacheAlias, process.platform === "win32" ? "junction" : "dir");
aliasEnv.CLAUDE_CODE_PLUGIN_CACHE_DIR = cacheAlias;
const aliased = setup(aliasEnv, "project-cache-alias", "triage-cache-alias", 60_000);
assert.equal(aliased.status, 0, aliased.stdout + aliased.stderr);
resolved(aliasEnv, aliasHome);
console.log("PASS: setup completes when plugin cache aliases the Claude config directory");
const sameParent = { ...aliasEnv, CLAUDE_CODE_PLUGIN_CACHE_DIR: aliasEnv.CLAUDE_CONFIG_DIR };
const identical = setup(sameParent, "project-cache-alias", "triage-cache-alias", 60_000);
assert.equal(identical.status, 0, identical.stdout + identical.stderr);
resolved(sameParent, aliasHome);
console.log("PASS: setup also completes when both lock parents use the same path");
assertIndependentCodexRepair();
await assertCurrentUpdateRepairsCodex();
assert.equal(readFileSync(serviceLog, "utf8"), "", "no native service command ran");
console.log(`registration-home-live.smoke: evidence retained at ${root}`);
