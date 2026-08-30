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
  "path-filtered workflows are included only when a changed path matches their declaration",
  JSON.stringify(expectedPullRequestWorkflows(workflows, ["package.json"])) === JSON.stringify(["CI", "Windows"]) &&
    JSON.stringify(expectedPullRequestWorkflows(workflows, ["install.sh"])) === JSON.stringify(["CI", "Installer", "Windows"]),
);
const declarationForms = expectedPullRequestWorkflows({
  "comment.yml": "name: Hidden\non: [push, pull_request] # ordinary YAML comment\n",
  "quoted.yml": "name: 'Quoted name'\n\"on\": \"pull_request\"\n",
  "sequence.yml": "name: Block sequence\non:\n  - push\n  - pull_request\n",
  "flow-map.yml": "name: Flow map\non: { push: null, pull_request: { paths: [src/**] } }\n",
  "alias.yml": "name: Alias\non:\n  push: &filters\n    paths: [src/**]\n  pull_request: *filters\n",
}, ["src/index.ts"]);
check(
  "standards-valid scalar, sequence, mapping, comment, quote, flow, and alias forms declare pull-request workflows",
  JSON.stringify(declarationForms) === JSON.stringify(["Alias", "Block sequence", "Flow map", "Hidden", "Quoted name"]),
  declarationForms,
);
const successfulCiOnly = classifyPullRequestHead({
  pr: 1092,
  headSha: "1".repeat(40),
  expected: expectedPullRequestWorkflows({
    "ci.yml": "name: CI\non: pull_request\n",
    "hidden.yml": "name: Hidden\non: [push, pull_request] # ordinary YAML comment\n",
  }, ["package.json"]),
  runs: [{
    id: 1,
    name: "CI",
    event: "pull_request",
    head_sha: "1".repeat(40),
    pull_requests: [{ number: 1092 }],
    status: "completed",
    conclusion: "success",
    created_at: "2026-08-30T00:00:00Z",
  }],
});
check(
  "a successful parsed workflow cannot hide a missing trailing-comment workflow",
  JSON.stringify(successfulCiOnly.missing) === '["Hidden"]' && !successfulCiOnly.green,
  successfulCiOnly,
);
for (const [label, source, message] of [
  ["a non-string event scalar", "name: Wrong\non: 42\n", /on declaration must be a string, sequence, or mapping/],
  ["a non-string event sequence entry", "name: Wrong\non: [pull_request, 42]\n", /event sequence entries must be strings/],
  ["a non-mapping pull_request configuration", "name: Wrong\non:\n  pull_request: []\n", /pull_request declaration must be null or a mapping/],
  ["a non-sequence paths filter", "name: Wrong\non:\n  pull_request:\n    paths: ${{ future.paths }}\n", /paths declaration must be a sequence of strings/],
  ["a non-string paths entry", "name: Wrong\non:\n  pull_request:\n    paths: [src/**, 42]\n", /paths entries must be non-empty strings/],
] as const) {
  let refused = false;
  try { expectedPullRequestWorkflows({ "wrong.yml": source }, ["src/index.ts"]); }
  catch (error) { refused = message.test(String(error)); }
  check(`${label} fails closed`, refused);
}
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

const EXPECTED = 27;
check(`every cell ran (${EXPECTED} before sentinel)`, passed + failed === EXPECTED);
console.log(`PR HEAD GATE SMOKE ${failed === 0 ? "OK" : "FAILED"} (${passed} passed, ${failed} failed)`);
console.log("SUITE COMPLETE");
if (failed) process.exitCode = 1;
