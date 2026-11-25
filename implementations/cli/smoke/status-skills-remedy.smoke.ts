/**
 * Status's skills rows must recommend a skills-only write (`cotal setup --skills`),
 * never unscoped `cotal setup`. The real CLI entry (`bin/cotal.ts`) is driven in an
 * isolated HOME/COTAL_HOME with the Claude connector installed, a planted stale `.agents` skill,
 * and with and without the connector executable on PATH.
 *
 * Run: pnpm smoke:status-skills-remedy
 */
import nodeAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setup } from "../src/commands/setup.js";
const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

void setup; // source-path import: setup.ts mutations execute through this suite's module graph

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const created: string[] = [];
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cli = join(repoRoot, "bin", "cotal.ts");
const tsx = fileURLToPath(import.meta.resolve("tsx/cli"));
const canonSkill = join(repoRoot, "implementations", "cli", "cotal-skills", "skills", "team-topology", "SKILL.md");
const cliVersion = (JSON.parse(readFileSync(join(repoRoot, "bin", "package.json"), "utf8")) as { version: string }).version;
const claudePkg = join(repoRoot, "extensions", "connector-claude-code");
const claudeVersion = (JSON.parse(readFileSync(join(claudePkg, "package.json"), "utf8")) as { version: string }).version;

function freshEnv(): { home: string; cwd: string; env: NodeJS.ProcessEnv } {
  const home = mkdtempSync(join(tmpdir(), "cotal-421-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "cotal-421-cwd-"));
  created.push(home, cwd);
  mkdirSync(join(cwd, ".cotal"), { recursive: true });
  mkdirSync(join(home, ".agents", "skills", "team-topology"), { recursive: true });
  mkdirSync(join(home, "bin"), { recursive: true });
  mkdirSync(join(home, "runtime"), { mode: 0o700 });
  writeFileSync(join(home, ".agents", "skills", "team-topology", "SKILL.md"), "STALE-SKILL-BODY\n");
  writeFileSync(
    join(home, "bin", "claude"),
    `#!/bin/sh
state="$HOME/.claude-fake-state"
current="${cliVersion}"
if [ "$1" = plugin ] && [ "$2" = list ]; then
  ver=0.0.0
  [ -f "$state" ] && IFS= read -r ver < "$state"
  printf '%s\\n' "[{\\"id\\":\\"cotal-skills@cotal-mesh\\",\\"scope\\":\\"user\\",\\"enabled\\":true,\\"version\\":\\"$ver\\"}]"
  exit 0
fi
if [ "$1" = plugin ] && { [ "$2" = install ] || [ "$2" = update ] || [ "$2" = marketplace ]; }; then
  printf '%s\\n' "$current" > "$state"
  echo already installed
  exit 0
fi
exit 0
`,
  );
  writeFileSync(join(home, "bin", "cotal"), "#!/bin/sh\nexit 0\n");
  // The Claude skills row comes from the claude connector's setup provider, so the child sees that
  // connector installed: the repository package linked into the extensions prefix, with the manifest
  // entry `ext add` writes for it.
  const prefix = join(home, ".config", "cotal", "extensions");
  mkdirSync(join(prefix, "node_modules", "@cotal-ai"), { recursive: true });
  symlinkSync(claudePkg, join(prefix, "node_modules", "@cotal-ai", "connector-claude-code"), "dir");
  writeFileSync(join(prefix, "extensions.json"), JSON.stringify({ extensions: [{
    pkg: "@cotal-ai/connector-claude-code",
    version: claudeVersion,
    spec: claudePkg,
    provides: [{ kind: "connector", name: "claude" }, { kind: "connector-setup", name: "claude" }],
    commands: [],
    connectors: [{ name: "claude", requires: ["claude"], eventPlane: true, setup: { kind: "connector-setup", name: "claude" } }],
  }] }));
  chmodSync(join(home, "bin", "claude"), 0o755);
  chmodSync(join(home, "bin", "cotal"), 0o755);
  return {
    home,
    cwd,
    env: {
      HOME: home,
      USERPROFILE: home,
      COTAL_HOME: join(home, ".cotal"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_RUNTIME_DIR: join(home, "runtime"),
      TMPDIR: tmpdir(),
      COTAL_SKIP_CONNECTOR_SEED: "1",
      NO_COLOR: "1",
      PATH: join(home, "bin"),
    },
  };
}

function run(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [tsx, cli, ...args], { cwd, env, timeout: 30_000 }, (err, stdout, stderr) =>
      resolve({
        code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
        stdout: strip(String(stdout ?? "")),
        stderr: strip(String(stderr ?? "")),
      }),
    );
  });
}

const skillRow = (out: string, name: "Claude skills" | "Agent skills") => {
  const line = out.split("\n").find((l) => l.startsWith(`  ${name}`));
  assert.ok(line, `status printed the ${name} row`);
  return line!;
};

try {
  assert.equal(existsSync(cli), true, "the subprocess entry is the repository's real bin/cotal.ts");
  assert.equal(existsSync(tsx), true, "the worktree tsx binary exists");
  assert.equal(existsSync(canonSkill), true, "canonical team-topology SKILL.md is present");

  const first = freshEnv();
  const status = await run(["status"], first.env, first.cwd);
  assert.equal(status.code, 0, `status exits 0: ${status.stderr}`);
  assert.match(status.stdout, /^This machine$/m, "status report/control was reached");

  const claudeRow = skillRow(status.stdout, "Claude skills");
  const agentsRow = skillRow(status.stdout, "Agent skills");
  assert.match(claudeRow, /stale · cotal setup --skills/, "stale Claude skills recommend setup --skills");
  assert.doesNotMatch(claudeRow, /stale · cotal setup$/, "Claude skills row is not unscoped setup");
  assert.match(agentsRow, /1\/1 out of date · cotal setup --skills/, "stale .agents skills recommend setup --skills");
  assert.doesNotMatch(agentsRow, /out of date · cotal setup$/, ".agents skills row is not unscoped setup");

  renameSync(join(first.home, "bin", "claude"), join(first.home, "claude-stand-in"));
  for (const flags of [[], ["--plain"]]) {
    const compact = await run(["status", ...flags], first.env, first.cwd);
    assert.equal(compact.code, 0, `compact status exits 0: ${compact.stderr}`);
    assert.match(compact.stdout, /^  Agent applications:\s+(?:○ )?not set up$/m);
    assert.doesNotMatch(compact.stdout, /^  Claude skills:/m);
    assert.match(skillRow(compact.stdout, "Agent skills"), /1\/1 out of date [·-] cotal setup --skills/);
  }

  const cotalHome = join(first.home, ".cotal");
  mkdirSync(cotalHome, { recursive: true });
  const manifest = join(cotalHome, "agent-skills.json");
  const corrupt = "{ not json";
  writeFileSync(manifest, corrupt);
  for (const flags of [[], ["--plain"]]) {
    const compact = await run(["status", ...flags], first.env, first.cwd);
    assert.equal(compact.code, 4, `corrupt manifest makes status partial: ${compact.stderr}`);
    const row = skillRow(compact.stdout, "Agent skills");
    assert.ok(row.includes(`Corrupt Cotal skills manifest at ${manifest} (invalid JSON)`));
    assert.doesNotMatch(compact.stdout, /`cotal setup`/, "the report must not suggest full setup");
    assert.match(row, /Restore a valid manifest, then run `cotal setup --skills`/);
    assert.equal(readFileSync(manifest, "utf8"), corrupt, "status preserves the unreadable manifest");
  }

  const refused = await run(["setup", "--skills", "--full"], first.env, first.cwd);
  assert.notEqual(refused.code, 0, "setup --skills --full is refused");
  assert.match(refused.stderr, /--skills cannot be combined with --full or --demo/, "refusal names the --skills combination fence");
  const refusedDemo = await run(["setup", "--skills", "--demo"], first.env, first.cwd);
  assert.notEqual(refusedDemo.code, 0, "setup --skills --demo is refused");

  const setupSource = readFileSync(join(repoRoot, "implementations", "cli", "src", "commands", "setup.ts"), "utf8");
  const skillsOnly = setupSource.slice(setupSource.indexOf("async function runSkillsOnly"), setupSource.indexOf("\n}\n", setupSource.indexOf("async function runSkillsOnly")) + 2);
  assert.match(skillsOnly, /await reconcileConnectorSkills\(\);\s*seedAgentSkills\(\);/, "setup --skills dispatches only provider and cross-vendor skills reconcile");
  assert.doesNotMatch(skillsOnly, /seedDefaultAgent|runEnsure/, "setup --skills dispatch contains no persona or full-setup path");
  assert.doesNotMatch(setupSource, /plugin", "(?:install|update)"|\.claude-plugin|--scope/, "generic setup owns no harness plugin command or asset path");

  console.log(`status-skills-remedy.smoke: ${cells()} checks passed`);
} finally {
  for (const p of created) rmSync(p, { recursive: true, force: true });
}
emitSentinel({ passed: cells(), failed: 0 });
