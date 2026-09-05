/**
 * The reproof gate must execute the shipped mutation runner for every fixture whose guarded source
 * changed, even if the fixture's anchor still matches. The temporary repository below has one
 * known survivor: a new upstream cap preserves the result after the anchored cap is removed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCAN = join(ROOT, "scripts", "mutation-reproof.mjs");
let passed = 0;
let failed = 0;
const check = (name: string, ok: unknown, detail = ""): void => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}\n      ${detail}`); }
};
const git = (root: string, args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const root = mkdtempSync(join(tmpdir(), "mutation-reproof-smoke-"));
try {
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "smoke@example.test"]);
  git(root, ["config", "user.name", "Smoke"]);
  writeFileSync(join(root, "target.mjs"), [
    "export function capped(input) {",
    "  const normalized = input;",
    "  return Math.min(normalized, 32);",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(root, "suite.mjs"), [
    "import { capped } from './target.mjs';",
    "if (capped(100) !== 32) { console.error('✗ FAIL: the cap holds'); process.exit(1); }",
    "console.log('✓ the cap holds');",
    "",
  ].join("\n"));
  writeFileSync(join(root, "fixture.json"), JSON.stringify({
    command: "node suite.mjs",
    mutations: [{
      name: "the final cap is removed",
      file: "target.mjs",
      find: "  return Math.min(normalized, 32);",
      replace: "  return normalized;",
      expectRed: "the cap holds",
    }],
  }, null, 2));
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  writeFileSync(join(root, "target.mjs"), [
    "export function capped(input) {",
    "  const normalized = Math.min(input, 32);",
    "  return Math.min(normalized, 32);",
    "}",
    "",
  ].join("\n"));
  git(root, ["add", "target.mjs"]);
  git(root, ["commit", "--quiet", "-m", "upstream cap"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  const run = spawnSync(process.execPath, [SCAN, "--root", root, "--base", base, "--head", head], { encoding: "utf8" });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const offenders = [...output.matchAll(/MUTATION REPROOF FAILED \(\d+ fixture\(s\)\): (.+)/g)].flatMap((m) => m[1].split(", "));
  check(
    "the shipped scan reports the known survivor set after its guarded source changes",
    run.status === 1 && JSON.stringify(offenders) === JSON.stringify(["fixture.json"]),
    output,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`mutation-reproof smoke: ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
