/**
 * Exact-head merge automation must require every named pull-request workflow that the repository
 * declarations say applies. An empty ordinary-run set, or Code Quality alone, is not green.
 *
 * Run: pnpm smoke:pr-head-gate
 * Prove: pnpm mutation-proof --config bin/smoke/mutations/pr-head-gate.json
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyPullRequestHead,
  expectedPullRequestWorkflows,
} from "../../scripts/pr-head-gate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = JSON.parse(readFileSync(join(ROOT, "bin/smoke/fixtures/pr-head-gate.json"), "utf8"));
const workflows = Object.fromEntries(
  readdirSync(join(ROOT, ".github/workflows"))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => [name, readFileSync(join(ROOT, ".github/workflows", name), "utf8")]),
);

let passed = 0, failed = 0;
function check(name: string, condition: unknown, detail?: unknown): void {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}`, detail ?? ""); }
}

const expectedNames = ["CI", "Docs", "Windows"];
check(
  "the real repository workflows and path filters yield the exact expected names",
  JSON.stringify(expectedPullRequestWorkflows(workflows, ["package.json"])) === JSON.stringify(["CI", "Windows"]) &&
    JSON.stringify(expectedPullRequestWorkflows(workflows, ["install.sh"])) === JSON.stringify(["CI", "Installer", "Windows"]),
);
const declarationForms = [
  ["plain flow sequence", "name: Plain Flow\non: [push, pull_request]\n", "Plain Flow"],
  ["commented flow sequence", "name: Commented Flow\non: [push, pull_request] # ordinary YAML comment\n", "Commented Flow"],
  ["block mapping", "name: Block Mapping\non:\n  pull_request:\n", "Block Mapping"],
] as const;
for (const [label, source, name] of declarationForms) {
  let detected = false;
  let detail: unknown;
  try {
    detected = JSON.stringify(expectedPullRequestWorkflows({ [`${label}.yml`]: source }, ["package.json"])) === JSON.stringify([name]);
  } catch (error) {
    detail = error;
  }
  check(
    `${label} pull_request declaration is detected`,
    detected,
    detail,
  );
}
check("every supported pull_request declaration form ran (3)", declarationForms.length === 3);
let malformedOnRefused = false;
try {
  expectedPullRequestWorkflows({
    "malformed.yml": "name: Malformed\non: push pull_request\n",
  }, ["package.json"]);
} catch (error) {
  malformedOnRefused = /unsupported top-level on declaration/.test(String(error));
}
check("an unrecognised top-level on declaration fails closed instead of omitting a workflow", malformedOnRefused);
let unsupportedRefused = false;
try {
  expectedPullRequestWorkflows({
    "unknown.yml": "name: Unknown\non:\n  pull_request:\n    paths: ${{ future.paths }}\n",
  }, ["package.json"]);
} catch (error) {
  unsupportedRefused = /unsupported inline paths declaration/.test(String(error));
}
check("an unrecognised workflow declaration fails closed instead of shrinking the expected set", unsupportedRefused);
let unsupportedPatternRefused = false;
try {
  expectedPullRequestWorkflows({
    "unknown.yml": "name: Unknown\non:\n  pull_request:\n    paths:\n      - 'docs/{api,cli}.md'\n",
  }, ["docs/cli.md"]);
} catch (error) {
  unsupportedPatternRefused = /unsupported workflow path pattern/.test(String(error));
}
check("unsupported GitHub glob syntax fails closed instead of being treated as a literal", unsupportedPatternRefused);
for (const c of fixture.cases) {
  const expected = expectedPullRequestWorkflows(workflows, c.changedPaths);
  check(
    `${c.label}: expected workflows come from the declarations and path filters`,
    JSON.stringify(expected) === JSON.stringify(expectedNames),
    expected,
  );
  const result = classifyPullRequestHead({
    pr: c.pr,
    headSha: c.headSha,
    expected,
    runs: c.runs,
  });
  if (c.pr === 1087) {
    check(`${c.label}: no expected workflow is missing`, result.missing.length === 0, result);
    check(`${c.label}: minted but unfinished workflows are pending`, JSON.stringify(result.pending) === JSON.stringify(expectedNames), result);
    check(`${c.label}: a pending head is not green`, !result.green, result);
  } else {
    check(`${c.label}: Code Quality or another PR's run does not satisfy this PR`, JSON.stringify(result.missing) === JSON.stringify(expectedNames), result);
    check(`${c.label}: zero ordinary pending and zero ordinary failures is still not green`, result.pending.length === 0 && result.failing.length === 0 && !result.green, result);
  }
}

const positive = fixture.cases.find((c: { pr: number }) => c.pr === 1087);
const succeeded = positive.runs.map((run: Record<string, unknown>) =>
  run.event === "pull_request" ? { ...run, status: "completed", conclusion: "success" } : run,
);
const green = classifyPullRequestHead({
  pr: positive.pr,
  headSha: positive.headSha,
  expected: expectedNames,
  runs: succeeded,
});
check("the exact head is green only after every expected workflow succeeds", green.green, green);

const failedRuns = succeeded.map((run: Record<string, unknown>) =>
  run.name === "CI" ? { ...run, conclusion: "failure" } : run,
);
const red = classifyPullRequestHead({
  pr: positive.pr,
  headSha: positive.headSha,
  expected: expectedNames,
  runs: failedRuns,
});
check("a completed non-success workflow is reported as failing, not missing or pending", JSON.stringify(red.failing) === '["CI"]' && red.missing.length === 0 && red.pending.length === 0, red);

for (const conclusion of ["neutral", "skipped"]) {
  const nonSuccess = succeeded.map((run: Record<string, unknown>) =>
    run.name === "CI" ? { ...run, conclusion } : run,
  );
  const verdict = classifyPullRequestHead({
    pr: positive.pr,
    headSha: positive.headSha,
    expected: expectedNames,
    runs: nonSuccess,
  });
  check(`a ${conclusion} expected workflow is failing, never green`, JSON.stringify(verdict.failing) === '["CI"]' && !verdict.green, verdict);
}

const EXPECTED = 25;
check(`every cell ran (${EXPECTED} before sentinel)`, passed + failed === EXPECTED);
console.log(`PR HEAD GATE SMOKE ${failed === 0 ? "OK" : "FAILED"} (${passed} passed, ${failed} failed)`);
console.log("SUITE COMPLETE");
if (failed) process.exitCode = 1;
