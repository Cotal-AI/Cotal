/**
 * The `cotal` plugin a plain Claude Code session loads stays current, in every project. Setup installs it
 * at user scope, so each project on the machine loads it, and moves the per-project installs earlier
 * releases made under that one. Claude Code runs a plugin from a local-directory marketplace in place,
 * from its folder, so the folder setup materializes is what every install runs. This drives the real
 * setup provider against the real `claude` CLI, with Claude's config and Cotal's home in a scratch
 * directory, and asks Claude Code what it would start in each project.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "cotal-plugin-refresh-")));
process.env.CLAUDE_CONFIG_DIR = join(ROOT, "claude");
process.env.COTAL_HOME = join(ROOT, "cotal");
const PROJECT_A = join(ROOT, "a");
const PROJECT_B = join(ROOT, "b");
const PROJECT_GONE = join(ROOT, "gone");
const PROJECT_FILE = join(ROOT, "file");
const PROJECT_OFF = join(ROOT, "off");
for (const dir of [process.env.CLAUDE_CONFIG_DIR, process.env.COTAL_HOME, PROJECT_A, PROJECT_B, PROJECT_GONE, PROJECT_FILE, PROJECT_OFF]) mkdirSync(dir, { recursive: true });
const BIG = 64 * 1024 * 1024;
if (spawnSync("claude", ["--version"]).status !== 0) throw new Error("this suite drives the real Claude Code CLI; put `claude` on PATH");

const { claudeSetupProvider } = await import("../src/setup.js");
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const RELEASE = (JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as { version: string }).version;
const FOLDER = join(process.env.COTAL_HOME, "claude-plugin", "cotal");
const connector = claudeSetupProvider.connector!;
const refresh = claudeSetupProvider.refresh!;

let checks = 0;
function ok(label: string, fn: () => void): void {
  fn();
  checks += 1;
  console.log(`  ✓ ${label}`);
}

/** The installs of the cotal plugin, as Claude Code records them: `user`, or `local:<project>`. */
function installs(): string[] {
  const out = spawnSync("claude", ["plugin", "list", "--json"], { encoding: "utf8", maxBuffer: BIG });
  assert.equal(out.status, 0, out.stderr);
  return (JSON.parse(out.stdout) as { id: string; scope: string; projectPath?: string }[])
    .filter((e) => e.id === "cotal@cotal-mesh" && !e.projectPath?.startsWith(join(ROOT, "old")))
    .map((e) => (e.scope === "local" ? `local:${e.projectPath}` : e.scope))
    .sort();
}

/** `claude plugin <args>` run in `dir`, as an earlier release's setup or a person would. */
function plugin(dir: string, ...args: string[]): void {
  const out = spawnSync("claude", ["plugin", ...args], { cwd: dir, encoding: "utf8" });
  assert.equal(out.status, 0, `${out.stdout}${out.stderr}`);
}

/** A user's terminal: no Cotal launch identity and no enclosing Claude Code session, which a suite run
 *  from inside a launched session would otherwise hand to the server Claude Code starts. */
const TERMINAL: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k === "COTAL_HOME" || !(k.startsWith("COTAL_") || k.startsWith("CLAUDE_CODE_") || k === "CLAUDECODE" || k === "CLAUDE_PID")),
);

/** The cotal server Claude Code would start in `dir`, as `claude mcp list` resolves and connects it. */
function startedIn(dir: string): string {
  const out = spawnSync("claude", ["mcp", "list"], { cwd: dir, encoding: "utf8", timeout: 120_000, env: TERMINAL });
  const line = `${out.stdout}${out.stderr}`.split("\n").find((l) => l.startsWith("plugin:cotal:cotal:"));
  assert.ok(line, `claude mcp list in ${dir} names the cotal plugin's server:\n${out.stdout}${out.stderr}`);
  return line;
}

const folderVersion = () => (JSON.parse(readFileSync(join(FOLDER, ".claude-plugin", "plugin.json"), "utf8")) as { version: string }).version;
const folderCli = () => (JSON.parse(readFileSync(join(FOLDER, "dist", "cli.json"), "utf8")) as { argv: string[] }).argv;
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const cli = (name: string) => [process.execPath, `/opt/cotal-${name}/cotal.js`];
const inProject = <T>(dir: string, fn: () => T): T => {
  const back = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(back);
  }
};
const status = (version: string) => claudeSetupProvider.status!({ version, skillsRemedy: "cotal setup --skills" }).find((r) => r.label === "Claude plugin")!;

try {
  console.log("plugin-refresh-live.smoke:");
  ok("refresh with nothing installed installs nothing", () => {
    assert.equal(refresh.run({ cotal: cli("one") }), "not installed");
    assert.deepEqual(installs(), []);
  });

  const setupText = inProject(PROJECT_A, () => connector.run({ cotal: cli("one") })) as string;
  ok("setup installs the plugin at user scope, stamped with this release and a digest", () => {
    assert.deepEqual(installs(), ["user"]);
    assert.ok(setupText.startsWith("cotal@cotal-mesh (user scope)"), setupText);
    assert.match(folderVersion(), new RegExp(`^${RELEASE.replace(/\./g, "\\.")}\\+[0-9a-f]{12}$`));
  });
  ok("the copy setup wrote is this package's build and records the CLI setup was given", () => {
    assert.equal(sha(join(FOLDER, "dist", "mcp.cjs")), sha(join(PACKAGE, "dist", "mcp.cjs")));
    assert.equal(sha(join(FOLDER, "dist", "hook.cjs")), sha(join(PACKAGE, "dist", "hook.cjs")));
    assert.equal(sha(join(FOLDER, "dist", "monitor.cjs")), sha(join(PACKAGE, "dist", "monitor.cjs")));
    assert.deepEqual(folderCli(), cli("one"));
  });
  ok("Claude Code starts that copy's server in place, and it answers", () => {
    const line = startedIn(PROJECT_A);
    assert.ok(line.includes(join(FOLDER, "dist", "mcp.cjs")), line);
    assert.match(line, /Connected/);
  });
  const first = folderVersion();
  ok("a project setup never ran in starts the same copy", () => {
    assert.ok(startedIn(PROJECT_B).includes(join(FOLDER, "dist", "mcp.cjs")));
  });
  ok("status calls the copy current at user scope", () => {
    assert.deepEqual(status(RELEASE), { label: "Claude plugin", state: "ok", text: "current (user scope)" });
  });
  ok("status after an upgrade, before setup runs again, calls the copy stale", () => {
    assert.deepEqual(status("999.0.0"), { label: "Claude plugin", state: "warn", text: "stale · run `cotal setup`" });
  });

  // What `cotal update` and a repeat `cotal setup` run, from a directory with no install, after the CLI moved.
  const text = inProject(ROOT, () => refresh.run({ cotal: cli("two") })) as string;
  ok("refresh rewrites the copy every project runs, and installs nothing new", () => {
    assert.notEqual(folderVersion(), first);
    assert.deepEqual(folderCli(), cli("two"));
    assert.equal(text, `cotal@cotal-mesh ${folderVersion()}; each Claude Code session loads it when it starts`);
    assert.deepEqual(installs(), ["user"]);
  });
  ok("after the refresh both projects start the rewritten copy", () => {
    for (const dir of [PROJECT_A, PROJECT_B]) assert.ok(startedIn(dir).includes(join(FOLDER, "dist", "mcp.cjs")));
  });
  ok("a second refresh with the same CLI writes the same version", () => {
    const before = folderVersion();
    refresh.run({ cotal: cli("two") });
    assert.equal(folderVersion(), before);
  });

  // An earlier release installed the plugin per project, at local scope. Since then one of those
  // projects was deleted and another path became a file.
  plugin(ROOT, "uninstall", "cotal@cotal-mesh", "--scope", "user");
  for (const dir of [PROJECT_A, PROJECT_B, PROJECT_GONE, PROJECT_FILE]) plugin(dir, "install", "cotal@cotal-mesh", "--scope", "local");
  rmSync(PROJECT_GONE, { recursive: true });
  rmSync(PROJECT_FILE, { recursive: true });
  writeFileSync(PROJECT_FILE, "");
  ok("status counts an earlier release's per-project installs", () => {
    assert.deepEqual(status(RELEASE), { label: "Claude plugin", state: "ok", text: "current (4 installs)" });
  });
  // Claude Code cannot change project B's settings, so it cannot remove the install recorded there. It
  // writes by replacing the file, so the directory is locked as well.
  const locked = join(PROJECT_B, ".claude");
  chmodSync(join(locked, "settings.local.json"), 0o444);
  chmodSync(locked, 0o555);
  try {
    ok("setup removes every per-project install it can, then fails naming the one it cannot", () => {
      let thrown: unknown;
      try {
        inProject(ROOT, () => connector.run({ cotal: cli("two") }));
      } catch (e) {
        thrown = e;
      }
      assert.ok(thrown instanceof Error, "setup did not fail");
      assert.ok(thrown.message.includes(`${PROJECT_B}:`) && !thrown.message.includes(`${PROJECT_A}:`), thrown.message);
      assert.ok(thrown.message.includes("claude plugin uninstall cotal@cotal-mesh --scope local"), thrown.message);
      assert.deepEqual(installs(), [`local:${PROJECT_B}`, `local:${PROJECT_FILE}`, `local:${PROJECT_GONE}`, "user"].sort());
    });
  } finally {
    chmodSync(locked, 0o755);
    chmodSync(join(locked, "settings.local.json"), 0o644);
  }
  const moved = inProject(ROOT, () => connector.run({ cotal: cli("two") })) as string;
  ok("once it can, setup removes that one too, and leaves the records of paths that are no longer directories", () => {
    assert.ok(moved.startsWith("cotal@cotal-mesh (user scope, replacing 1 project install)"), moved);
    assert.deepEqual(installs(), [`local:${PROJECT_FILE}`, `local:${PROJECT_GONE}`, "user"].sort());
  });
  ok("both projects still start the copy, now from the user-scope install", () => {
    for (const dir of [PROJECT_A, PROJECT_B]) assert.ok(startedIn(dir).includes(join(FOLDER, "dist", "mcp.cjs")));
    assert.deepEqual(status(RELEASE), { label: "Claude plugin", state: "ok", text: "current (user scope)" });
  });
  mkdirSync(join(PROJECT_OFF, ".claude"));
  writeFileSync(join(PROJECT_OFF, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "cotal@cotal-mesh": false } }));
  ok("setup run from a project that turns the plugin off still installs it for the account", () => {
    const text = inProject(PROJECT_OFF, () => connector.run({ cotal: cli("two") })) as string;
    assert.ok(text.startsWith("cotal@cotal-mesh (user scope)"), text);
  });
  ok("a repeat setup leaves the one install in place", () => {
    const again = inProject(PROJECT_B, () => connector.run({ cotal: cli("two") })) as string;
    assert.ok(again.startsWith("cotal@cotal-mesh (user scope)"), again);
    assert.deepEqual(installs(), [`local:${PROJECT_FILE}`, `local:${PROJECT_GONE}`, "user"].sort());
  });

  // A machine that ran setup in many projects over time: 1,700 more records of projects since deleted,
  // in the shape Claude Code writes them, take `claude plugin list --json` past 1 MiB.
  const records = join(process.env.CLAUDE_CONFIG_DIR, "plugins", "installed_plugins.json");
  const recorded = JSON.parse(readFileSync(records, "utf8")) as { plugins: Record<string, Record<string, unknown>[]> };
  const template = recorded.plugins["cotal@cotal-mesh"]!.find((r) => r.scope === "user")!;
  for (let i = 0; i < 1700; i++) recorded.plugins["cotal@cotal-mesh"]!.push({ ...template, scope: "local", projectPath: join(ROOT, "old", `p${i}`) });
  writeFileSync(records, JSON.stringify(recorded, null, 2));
  ok("with more than 1 MiB of install records, status and setup still read the list", () => {
    const size = spawnSync("claude", ["plugin", "list", "--json"], { encoding: "utf8", maxBuffer: BIG }).stdout.length;
    assert.ok(size > 1024 * 1024, `plugin list is ${size} bytes`);
    assert.deepEqual(status(RELEASE), { label: "Claude plugin", state: "ok", text: "current (user scope)" });
    const text = inProject(ROOT, () => connector.run({ cotal: cli("two") })) as string;
    assert.ok(text.startsWith("cotal@cotal-mesh (user scope)"), text);
  });

  console.log(`plugin-refresh-live.smoke: ${checks} checks passed`);
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}
