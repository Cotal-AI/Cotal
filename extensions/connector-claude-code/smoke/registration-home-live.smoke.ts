/** Two Cotal homes must not replace one shared Claude profile's installed registrations. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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
assert.equal(readFileSync(serviceLog, "utf8"), "", "no native service command ran");
console.log(`registration-home-live.smoke: evidence retained at ${root}`);
