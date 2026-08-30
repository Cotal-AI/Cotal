/**
 * Exact-head merge automation must require every named pull-request workflow that the repository
 * declarations say applies. An empty ordinary-run set, or Code Quality alone, is not green.
 *
 * Run: pnpm smoke:pr-head-gate
 * Prove: pnpm mutation-proof --config bin/smoke/mutations/pr-head-gate.json
 */
import { spawnSync } from "node:child_process";
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
const fixtureFetch = join(ROOT, "bin/smoke/fixtures/pr-head-gate-fetch.mjs");

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
let repositoryWorkflowsParsed = false;
try {
  expectedPullRequestWorkflows(workflows, ["package.json"]);
  repositoryWorkflowsParsed = true;
} catch {}
check("every repository workflow declaration parses without throwing", repositoryWorkflowsParsed);
check(
  "paths-ignore skips a workflow only when every changed path is ignored",
  JSON.stringify(expectedPullRequestWorkflows({
    "ignore.yml": "name: Ignore\non:\n  pull_request:\n    paths-ignore: ['docs/**']\n",
  }, ["docs/cli.md"])) === "[]" &&
    JSON.stringify(expectedPullRequestWorkflows({
      "ignore.yml": "name: Ignore\non:\n  pull_request:\n    paths-ignore: ['docs/**']\n",
    }, ["docs/cli.md", "package.json"])) === '["Ignore"]',
);
check(
  "ordinary YAML comments after a flow event list preserve pull_request",
  JSON.stringify(expectedPullRequestWorkflows({
    "hidden.yml": "name: Hidden\non: [push, pull_request] # ordinary YAML comment\n",
  }, ["package.json"])) === '["Hidden"]',
);
let invalidYamlRefused = false;
try {
  expectedPullRequestWorkflows({
    "invalid.yml": "name: Invalid\non: [pull_request\n",
  }, ["package.json"]);
} catch (error) {
  invalidYamlRefused = /invalid YAML/.test(String(error));
}
check("invalid workflow YAML fails closed instead of shrinking the expected set", invalidYamlRefused);
for (const [label, source, pattern] of [
  ["an empty on sequence fails closed", "name: Empty\non: []\n", /top-level on sequence must not be empty/],
  ["an empty on mapping fails closed", "name: Empty\non: {}\n", /top-level on mapping must not be empty/],
] as const) {
  let refused = false;
  try { expectedPullRequestWorkflows({ "unknown.yml": source }, ["package.json"]); }
  catch (error) { refused = pattern.test(String(error)); }
  check(label, refused);
}
check(
  "a scalar event without pull_request is explicitly omitted",
  JSON.stringify(expectedPullRequestWorkflows({ "future.yml": "name: Future\non: future_event\n" }, ["package.json"])) === "[]",
);
check(
  "an event mapping without pull_request is explicitly omitted",
  JSON.stringify(expectedPullRequestWorkflows({ "future.yml": "name: Future\non:\n  future_event:\n" }, ["package.json"])) === "[]",
);
let unsupportedRefused = false;
try {
  expectedPullRequestWorkflows({
    "unknown.yml": "name: Unknown\non:\n  pull_request:\n    paths: ${{ future.paths }}\n",
  }, ["package.json"]);
} catch (error) {
  unsupportedRefused = /pull_request paths must be a non-empty string array/.test(String(error));
}
check("an unrecognised workflow declaration fails closed instead of shrinking the expected set", unsupportedRefused);
let unsupportedFilterRefused = false;
try {
  expectedPullRequestWorkflows({
    "unknown.yml": "name: Unknown\non:\n  pull_request:\n    branches: [main]\n",
  }, ["package.json"]);
} catch (error) {
  unsupportedFilterRefused = /unsupported pull_request filter: branches/.test(String(error));
}
check("a pull_request filter the guard cannot evaluate fails closed", unsupportedFilterRefused);
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

const missingOne = classifyPullRequestHead({
  pr: positive.pr,
  headSha: positive.headSha,
  expected: expectedNames,
  runs: succeeded.filter((run: Record<string, unknown>) => run.name !== "Docs"),
});
check("a missing expected workflow keeps the exact head red", JSON.stringify(missingOne.missing) === '["Docs"]' && !missingOne.green, missingOne);

const wrongPullRequest = classifyPullRequestHead({
  pr: positive.pr,
  headSha: positive.headSha,
  expected: ["CI"],
  runs: succeeded.map((run: Record<string, unknown>) =>
    run.name === "CI" ? { ...run, pull_requests: [{ number: positive.pr + 1 }] } : run,
  ),
});
check("a successful run attached to another pull request does not satisfy this pull request", JSON.stringify(wrongPullRequest.missing) === '["CI"]' && !wrongPullRequest.green, wrongPullRequest);

const wrongHead = classifyPullRequestHead({
  pr: positive.pr,
  headSha: positive.headSha,
  expected: ["Windows"],
  runs: succeeded.map((run: Record<string, unknown>) =>
    run.name === "Windows" ? { ...run, head_sha: "0".repeat(40) } : run,
  ),
});
check("a successful run for another commit does not satisfy the exact head", JSON.stringify(wrongHead.missing) === '["Windows"]' && !wrongHead.green, wrongHead);

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

function shippedCommand(mode: "success" | "missing") {
  // The shipped gate reads GitHub credentials (GH_TOKEN/GITHUB_TOKEN/GITHUB_REPOSITORY) and no
  // COTAL_ name at all, so an ambient copy would hand a live credential and broker URL to a child
  // that has no use for either. Strip the prefix.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  return spawnSync("pnpm", ["--silent", "pr-head-gate", "1098"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...env,
      GITHUB_REPOSITORY: "Cotal-AI/Cotal",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${fixtureFetch}`.trim(),
      PR_HEAD_GATE_FIXTURE: mode,
    },
  });
}

const shippedGreen = shippedCommand("success");
check(
  "the shipped pr-head-gate command reports the YAML-derived Hidden workflow green",
  shippedGreen.status === 0 && shippedGreen.stdout.includes("expected: Hidden") && shippedGreen.stdout.includes("verdict: GREEN"),
  `${shippedGreen.stdout}${shippedGreen.stderr}`,
);
const shippedMissing = shippedCommand("missing");
check(
  "the shipped pr-head-gate command reports a missing YAML-derived workflow as not green",
  shippedMissing.status === 1 && shippedMissing.stdout.includes("missing: Hidden") && shippedMissing.stdout.includes("verdict: NOT GREEN"),
  `${shippedMissing.stdout}${shippedMissing.stderr}`,
);

const EXPECTED = 34;
check(`every cell ran (${EXPECTED} before sentinel)`, passed + failed === EXPECTED);
console.log(`PR HEAD GATE SMOKE ${failed === 0 ? "OK" : "FAILED"} (${passed} passed, ${failed} failed)`);
console.log("SUITE COMPLETE");
if (failed) process.exitCode = 1;
