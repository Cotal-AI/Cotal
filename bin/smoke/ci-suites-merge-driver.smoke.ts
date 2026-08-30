import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCiSuites } from "./ci-suites.mjs";

const root = mkdtempSync(join(tmpdir(), "cotal-ci-merge-"));
const driver = fileURLToPath(new URL("../../scripts/merge-ci-suites.mjs", import.meta.url));
const installer = fileURLToPath(new URL("../../scripts/install-git-merge-drivers.mjs", import.meta.url));
let pass = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  assert.ok(condition, `${name}${actual === undefined ? "" : ` - ${JSON.stringify(actual)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
const writeRegistry = (repo: string, body: string): void => writeFileSync(join(repo, "bin", "smoke", "ci-suites.txt"), body);
const readRegistry = (repo: string): string => readFileSync(join(repo, "bin", "smoke", "ci-suites.txt"), "utf8");
const suites = (raw: string): string[] => parseCiSuites(raw, "merged fixture");
const shards = (names: string[], count = 4): Map<string, number> => new Map(names.map((name, index) => [name, index % count]));

function fixture(): string {
  const repo = mkdtempSync(join(root, "repo-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "fixture");
  git(repo, "config", "user.email", "fixture@example.invalid");
  mkdirSync(join(repo, "bin", "smoke"), { recursive: true });
  mkdirSync(join(repo, "scripts"), { recursive: true });
  cpSync(driver, join(repo, "scripts", "merge-ci-suites.mjs"));
  cpSync(installer, join(repo, "scripts", "install-git-merge-drivers.mjs"));
  writeFileSync(join(repo, ".gitattributes"), "bin/smoke/ci-suites.txt merge=cotal-ci-suites\n");
  writeRegistry(repo, [
    "# fixture registry",
    "# blank/comment blocks attach to the suite below",
    "smoke:base-a",
    "",
    "# base B comment",
    "smoke:base-b",
    "",
    "# base C comment",
    "smoke:base-c",
    "",
  ].join("\n"));
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  const installed = spawnSync(process.execPath, [join(repo, "scripts", "install-git-merge-drivers.mjs")], { cwd: repo, encoding: "utf8" });
  check("installer registers the path-bound merge driver in local Git config", installed.status === 0 && git(repo, "config", "--local", "merge.cotal-ci-suites.driver").includes("merge-ci-suites.mjs"), installed.stderr);
  const repaired = spawnSync(process.execPath, [join(repo, "scripts", "install-git-merge-drivers.mjs")], { cwd: repo, encoding: "utf8" });
  check("explicit merge-driver setup is idempotent", repaired.status === 0 && git(repo, "config", "--local", "merge.cotal-ci-suites.driver").includes("merge-ci-suites.mjs"), repaired.stderr);
  return repo;
}

function addBranch(repo: string, branch: string, blocks: string[]): string {
  git(repo, "switch", "-qc", branch, "master");
  writeFileSync(join(repo, "bin", "smoke", "ci-suites.txt"), `${readRegistry(repo)}${blocks.join("\n")}\n`);
  git(repo, "add", "bin/smoke/ci-suites.txt");
  git(repo, "commit", "-qm", branch);
  return git(repo, "rev-parse", "HEAD");
}

function mergeOrder(first: "ours" | "theirs"): { raw: string; names: string[]; baseShards: Map<string, number> } {
  const repo = fixture();
  const base = git(repo, "rev-parse", "HEAD");
  const baseNames = suites(readRegistry(repo));
  const baseShards = shards(baseNames);
  const ours = addBranch(repo, "ours", ["", "# ours one comment", "# ours one detail", "smoke:ours-one", "", "# ours two comment", "smoke:ours-two"]);
  const theirs = addBranch(repo, "theirs", ["", "# theirs comment", "smoke:theirs-one"]);
  const start = first === "ours" ? ours : theirs;
  const incoming = first === "ours" ? theirs : ours;
  git(repo, "switch", "-q", "--detach", start);
  const merged = spawnSync("git", ["merge", "--no-commit", incoming], { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  check(`${first}-first real three-way merge completes without a registry conflict`, merged.status === 0, `${merged.stdout}\n${merged.stderr}`);
  const raw = readRegistry(repo);
  const names = suites(raw);
  check(`${first}-first merge preserves every base suite on its original shard`, baseNames.every((name) => shards(names).get(name) === baseShards.get(name)), { baseNames, names });
  const expectedTail = first === "ours"
    ? ["smoke:ours-one", "smoke:ours-two", "smoke:theirs-one"]
    : ["smoke:theirs-one", "smoke:ours-one", "smoke:ours-two"];
  check(`${first}-first merge appends ours additions before theirs at the true tail`, names.slice(-3).join(",") === expectedTail.join(","), names.slice(-3));
  check(`${first}-first merge keeps each comment block attached to its suite`,
    raw.includes("# ours one comment\n# ours one detail\nsmoke:ours-one") &&
    raw.includes("# ours two comment\nsmoke:ours-two") &&
    raw.includes("# theirs comment\nsmoke:theirs-one"), raw.slice(-300));
  return { raw, names, baseShards };
}

try {
  const oursFirst = mergeOrder("ours");
  const theirsFirst = mergeOrder("theirs");
  check("both merge directions retain the complete concurrent-append set", new Set(oursFirst.names).size === 6 && new Set(theirsFirst.names).size === 6);

  const repo = fixture();
  addBranch(repo, "edited", ["", "# new", "smoke:new"]);
  git(repo, "switch", "-q", "master");
  writeRegistry(repo, readRegistry(repo).replace("# base B comment", "# edited base B comment"));
  git(repo, "commit", "-qam", "edit base block");
  const refused = spawnSync("git", ["merge", "--no-commit", "edited"], { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  check("driver refuses a pre-existing comment-block edit instead of guessing", refused.status !== 0 && /comment block for pre-existing suite/.test(refused.stderr), refused.stderr);

  console.log(`\n${pass} checks passed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
