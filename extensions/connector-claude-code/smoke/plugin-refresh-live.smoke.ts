/**
 * The `cotal` plugin a plain Claude Code session loads stays current. Claude Code runs a plugin from a
 * local-directory marketplace in place, from its folder, so the folder setup materializes is what every
 * install runs. This drives the real setup provider against the real `claude` CLI, with Claude's config
 * and Cotal's home in a scratch directory, and asks Claude Code what it would start in each project.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "cotal-plugin-refresh-")));
process.env.CLAUDE_CONFIG_DIR = join(ROOT, "claude");
process.env.COTAL_HOME = join(ROOT, "cotal");
const PROJECT_A = join(ROOT, "a");
const PROJECT_B = join(ROOT, "b");
for (const dir of [process.env.CLAUDE_CONFIG_DIR, process.env.COTAL_HOME, PROJECT_A, PROJECT_B]) mkdirSync(dir, { recursive: true });
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

/** The projects with a local install of the cotal plugin, as Claude Code records them. */
function installedIn(): string[] {
  const out = spawnSync("claude", ["plugin", "list", "--json"], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  return (JSON.parse(out.stdout) as { id: string; scope: string; projectPath?: string }[])
    .filter((e) => e.id === "cotal@cotal-mesh" && e.scope === "local")
    .map((e) => e.projectPath!)
    .sort();
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
    assert.deepEqual(installedIn(), []);
  });

  inProject(PROJECT_A, () => connector.run({ cotal: cli("one") }));
  ok("setup installs the plugin in its project, stamped with this release and a digest", () => {
    assert.deepEqual(installedIn(), [PROJECT_A]);
    assert.match(folderVersion(), new RegExp(`^${RELEASE.replace(/\./g, "\\.")}\\+[0-9a-f]{12}$`));
  });
  ok("the copy setup wrote is this package's build and records the CLI setup was given", () => {
    assert.equal(sha(join(FOLDER, "dist", "mcp.cjs")), sha(join(PACKAGE, "dist", "mcp.cjs")));
    assert.equal(sha(join(FOLDER, "dist", "monitor.cjs")), sha(join(PACKAGE, "dist", "monitor.cjs")));
    assert.deepEqual(folderCli(), cli("one"));
  });
  ok("Claude Code starts that copy's server in place, and it answers", () => {
    const line = startedIn(PROJECT_A);
    assert.ok(line.includes(join(FOLDER, "dist", "mcp.cjs")), line);
    assert.match(line, /Connected/);
  });

  inProject(PROJECT_B, () => connector.run({ cotal: cli("one") }));
  const first = folderVersion();
  ok("a second project runs the same copy", () => {
    assert.deepEqual(installedIn(), [PROJECT_A, PROJECT_B]);
    assert.ok(startedIn(PROJECT_B).includes(join(FOLDER, "dist", "mcp.cjs")));
  });
  ok("status calls the copy current", () => {
    assert.deepEqual(status(RELEASE), { label: "Claude plugin", state: "ok", text: "current (2 installs)" });
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
    assert.deepEqual(installedIn(), [PROJECT_A, PROJECT_B]);
  });
  ok("after the refresh both projects still start the rewritten copy", () => {
    for (const dir of [PROJECT_A, PROJECT_B]) assert.ok(startedIn(dir).includes(join(FOLDER, "dist", "mcp.cjs")));
  });
  ok("a second refresh with the same CLI writes the same version", () => {
    const before = folderVersion();
    refresh.run({ cotal: cli("two") });
    assert.equal(folderVersion(), before);
  });

  console.log(`plugin-refresh-live.smoke: ${checks} checks passed`);
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}
