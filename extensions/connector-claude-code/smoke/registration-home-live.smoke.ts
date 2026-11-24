/** Two Cotal homes must not replace one shared Claude profile's installed registrations. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
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
    CODEX_HOME: join(user, "codex"),
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
function skillsStatus(environment: NodeJS.ProcessEnv, project: string) {
  const result = run(process.execPath, [cli, "status", "--json"], environment, join(root, project));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const { integrations } = JSON.parse(result.stdout).result.machine as { integrations: Array<{ name: string; state: string; text: string }> };
  const row = integrations.find((entry) => entry.name === "Claude skills");
  assert.ok(row, result.stdout);
  return row;
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
  const moved = { ...shared, COTAL_HOME: to };
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

function assertForeignSkillsStatus(): void {
  const project = join(root, "project-b");
  const guidance = `Claude marketplace cotal-mesh belongs to Cotal home ${homeA}, not ${homeB}. Use that COTAL_HOME or a separate CLAUDE_CONFIG_DIR and plugin cache for this home.`;
  const status = run(process.execPath, [cli, "status"], envB, project);
  assert.equal(status.status, 0, status.stdout + status.stderr);
  const line = status.stdout.split("\n").find((text) => text.includes("Claude skills:"));
  assert.ok(line, status.stdout);
  assert.ok(line.includes(guidance), line);
  assert.doesNotMatch(line, /stale|≠|setup --skills/);
  const repair = run(process.execPath, [cli, "setup", "--skills"], envB, project);
  assert.equal(repair.status, 3, repair.stdout + repair.stderr);
  assert.ok(repair.stderr.includes(guidance), repair.stderr);
  assert.deepEqual(skillsStatus(envB, "project-b"), { name: "Claude skills", state: "warn", text: guidance });
  assert.deepEqual(profileBytes(envA), original);
  assert.ok(!existsSync(join(homeB, "claude-plugin", "cotal-skills")));
  console.log("PASS: status reports the ownership conflict and skills setup still refuses it without changing the profile");
}
assertForeignSkillsStatus();

const probe = join(root, "provider.mjs");
writeFileSync(probe, `import { claudeSetupProvider as p } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
const input = { cotal: [process.execPath, ${JSON.stringify(cli)}], skills: { skillsDir: ${JSON.stringify(join(tree, "implementations", "cli", "cotal-skills", "skills"))}, version: "0.0.0", stateDir: process.env.COTAL_HOME } };
try { p.refresh.run(input); process.exitCode = 2; }
catch (error) { console.log(error.message); process.exitCode = error.message.includes("belongs to Cotal home") ? 0 : 1; }
`);
const refresh = run(process.execPath, [probe], envB);
assert.equal(refresh.status, 0, refresh.stdout + refresh.stderr);
assert.deepEqual(profileBytes(envA), original);
console.log("PASS: refresh refuses without changing the shared profile");

const separate = env("separate", homeB);
const independent = setup(separate, "project-independent", "triage-independent");
assert.equal(independent.status, 0, independent.stdout + independent.stderr);
resolved(separate, homeB);
const currentSkills = { name: "Claude skills", state: "ok", text: "current" };
assert.deepEqual(skillsStatus(separate, "project-independent"), currentSkills);
assert.deepEqual(profileBytes(envA), original);
const again = setup(envA, "project-a", "triage-a");
assert.equal(again.status, 0, again.stdout + again.stderr);
resolved(envA, homeA);
assert.deepEqual(skillsStatus(envA, "project-a"), currentSkills);
console.log("PASS: a separate profile supports home B and home A remains usable");
claude(envA, "plugin", "marketplace", "remove", "cotal-mesh");
const mcpOnly = readFileSync(join(envA.CLAUDE_CONFIG_DIR!, ".claude.json"), "utf8");
const noMarketplace = setup(envB, "project-b", "triage-b");
assert.notEqual(noMarketplace.status, 0);
assert.match(noMarketplace.stdout + noMarketplace.stderr, /Claude user MCP entry cotal belongs to Cotal home/);
assert.deepEqual(skillsStatus(envB, "project-b"), {
  name: "Claude skills", state: "warn",
  text: `Claude user MCP entry cotal belongs to Cotal home ${homeA}, not ${homeB}. Use that COTAL_HOME or a separate CLAUDE_CONFIG_DIR and plugin cache for this home.`,
});
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
assert.equal(readFileSync(serviceLog, "utf8"), "", "no native service command ran");
console.log(`registration-home-live.smoke: evidence retained at ${root}`);
