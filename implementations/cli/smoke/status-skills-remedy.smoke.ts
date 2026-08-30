/**
 * Status's skills rows must recommend a skills-only write (`cotal setup --skills`),
 * never unscoped `cotal setup`. The real CLI entry (`bin/cotal.ts`) is driven in an
 * isolated HOME/COTAL_HOME with a fake `claude` and a planted stale `.agents` skill.
 *
 * Run: pnpm smoke:status-skills-remedy
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setup } from "../src/commands/setup.js";

void setup; // source-path import: setup.ts mutations execute through this suite's module graph

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const created: string[] = [];
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cli = join(repoRoot, "bin", "cotal.ts");
const tsx = join(repoRoot, "node_modules", ".bin", "tsx");
const canonSkill = join(repoRoot, "implementations", "cli", "cotal-skills", "skills", "team-topology", "SKILL.md");
const cliVersion = (JSON.parse(readFileSync(join(repoRoot, "bin", "package.json"), "utf8")) as { version: string }).version;

function freshEnv(): { home: string; cwd: string; env: NodeJS.ProcessEnv } {
  const home = mkdtempSync(join(tmpdir(), "cotal-421-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "cotal-421-cwd-"));
  created.push(home, cwd);
  mkdirSync(join(cwd, ".cotal"), { recursive: true });
  mkdirSync(join(home, ".agents", "skills", "team-topology"), { recursive: true });
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, ".agents", "skills", "team-topology", "SKILL.md"), "STALE-SKILL-BODY\n");
  writeFileSync(
    join(home, "bin", "claude"),
    `#!/bin/sh
state="$HOME/.claude-fake-state"
current="${cliVersion}"
if [ "$1" = plugin ] && [ "$2" = list ]; then
  ver=0.0.0
  [ -f "$state" ] && ver=$(cat "$state")
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
  chmodSync(join(home, "bin", "claude"), 0o755);
  chmodSync(join(home, "bin", "cotal"), 0o755);
  // The child runs the shipped status/remedy path, which reads connection material. Every COTAL_
  // name it genuinely needs (COTAL_HOME, COTAL_SKIP_CONNECTOR_SEED) is set on top of the copy below,
  // so strip the prefix rather than trusting the runner's environment to be clean.
  const ambientEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(ambientEnv)) if (key.startsWith("COTAL_")) delete ambientEnv[key];
  return {
    home,
    cwd,
    env: {
      ...ambientEnv,
      HOME: home,
      USERPROFILE: home,
      COTAL_HOME: join(home, ".cotal"),
      XDG_CONFIG_HOME: join(home, ".config"),
      COTAL_SKIP_CONNECTOR_SEED: "1",
      NO_COLOR: "1",
      PATH: `${join(home, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    },
  };
}

function run(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(tsx, [cli, ...args], { cwd, env, timeout: 30_000 }, (err, stdout, stderr) =>
      resolve({
        code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
        stdout: strip(String(stdout ?? "")),
        stderr: strip(String(stderr ?? "")),
      }),
    );
  });
}

const skillRow = (out: string, name: "Claude skills" | "Skills (.agents)") => {
  const line = out.split("\n").find((l) => l.startsWith(`  ${name}`));
  assert.ok(line, `status printed a ${name} row`);
  return line!;
};

try {
  assert.equal(existsSync(cli), true, "the subprocess entry is the repository's real bin/cotal.ts");
  assert.equal(existsSync(tsx), true, "the worktree tsx binary exists");
  assert.equal(existsSync(canonSkill), true, "canonical team-topology SKILL.md is present");

  const first = freshEnv();
  const status = await run(["status"], first.env, first.cwd);
  assert.equal(status.code, 0, `status exits 0: ${status.stderr}`);
  assert.match(status.stdout, /^cotal status$/m, "status header/control was reached");

  const claudeRow = skillRow(status.stdout, "Claude skills");
  const agentsRow = skillRow(status.stdout, "Skills (.agents)");
  assert.match(claudeRow, /stale · cotal setup --skills/, "stale Claude skills recommend setup --skills");
  assert.doesNotMatch(claudeRow, /stale · cotal setup$/, "Claude skills row is not unscoped setup");
  assert.match(agentsRow, /1\/1 out of date · cotal setup --skills/, "stale .agents skills recommend setup --skills");
  assert.doesNotMatch(agentsRow, /out of date · cotal setup$/, ".agents skills row is not unscoped setup");

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

  console.log("status-skills-remedy.smoke: 15 checks passed");
} finally {
  for (const p of created) rmSync(p, { recursive: true, force: true });
}
