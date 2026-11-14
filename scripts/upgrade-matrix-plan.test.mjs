import test from "node:test";
import assert from "node:assert/strict";
import { BASELINE_VERSION, planPhase, planRelease, boundedCells, jobsMatrix, compareVersions, assertTarget, verifyResults } from "./upgrade-matrix-plan.mjs";

const sourceSHA = "a".repeat(40), newerSHA = "b".repeat(40);
const repository = "Cotal-AI/Cotal";
const repo = { full_name: repository };
const context = { eventName: "pull_request", repository, packageManifest: { version: "0.164.7" } };
function pr() { return { action: "synchronize", pull_request: { state: "open", head: { ref: "changeset-release/main", sha: sourceSHA, repo }, base: { ref: "main", sha: newerSHA, repo } } }; }
function dispatch(overrides = {}) { return planPhase({ eventName: "workflow_dispatch", inputs: { phase: "published", sourceSHA, targetVersion: "0.164.7", profile: "bounded", ...overrides } }); }
function run(conclusion = "failure") { return { action: "completed", repository: repo, workflow_run: { status: "completed", name: "Changesets", conclusion, head_branch: "main", head_sha: sourceSHA, repository: repo, head_repository: repo } }; }
const publishContext = { ...context, eventName: "workflow_run", published: true, publishJobConclusion: "success", targetVersion: "0.164.7" };
function goodResults(cells) { return cells.filter(c => c.required).map(c => ({ id: c.id, status: "passed", assertions: Object.fromEntries(c.requiredAssertions.map(a => [a, true])) })); }

test("candidate trigger: same-repository version PR freezes head SHA and explicit manifest version", () => {
  const event = pr();
  const snapshot = JSON.stringify(event);
  const plan = planPhase(event, context);
  assert.equal(plan.phase, "candidate");
  assert.equal(plan.sourceSHA, sourceSHA);
  assert.notEqual(plan.sourceSHA, event.pull_request.base.sha);
  assert.equal(plan.targetVersion, "0.164.7");
  assert.equal(plan.targetSource, "packed-target");
  assert.equal(plan.acceptance, false);
  event.pull_request.base.sha = "c".repeat(40);
  assert.deepEqual(planPhase(event, context), plan);
  assert.equal(JSON.parse(snapshot).pull_request.head.sha, sourceSHA);
  assert.throws(() => planPhase(pr(), { ...context, packageManifest: undefined }), /explicit semver/);
});

test("ordinary, fork, closed and wrong-base PRs are skipped, never green acceptance", () => {
  for (const mutate of [e => { e.pull_request.head.ref = "feature"; }, e => { e.pull_request.head.repo = { full_name: "fork/Cotal" }; }, e => { e.pull_request.base.ref = "other"; }, e => { e.action = "closed"; }]) {
    const event = pr(); mutate(event);
    const plan = planPhase(event, context);
    assert.equal(plan.status, "skipped");
    assert.equal(plan.acceptance, false);
    assert.deepEqual(boundedCells(plan), []);
    assert.equal(verifyResults([], []).acceptance, false);
  }
  assert.equal(planPhase({ eventName: "push" }).status, "skipped");
});

test("published trigger accepts ANY overall conclusion only with validated publication and successful publish job", () => {
  for (const conclusion of ["success", "failure", "cancelled", "timed_out", "neutral", null]) {
    const plan = planPhase(run(conclusion), publishContext);
    assert.equal(plan.phase, "published");
    assert.equal(plan.sourceSHA, sourceSHA);
    assert.equal(plan.targetVersion, "0.164.7");
    assert.equal(plan.targetSource, "npm-exact");
  }
  for (const published of [false, undefined, "true"]) assert.equal(planPhase(run(), { ...publishContext, published }).status, "skipped");
  for (const publishJobConclusion of ["failure", "skipped", undefined]) assert.equal(planPhase(run("success"), { ...publishContext, publishJobConclusion }).status, "skipped");
  assert.throws(() => planPhase(run(), { ...publishContext, targetVersion: "0.164.8" }), /match the source manifest/);
});

test("published trigger rejects incomplete, foreign, non-main and non-Changesets runs", () => {
  for (const mutate of [e => { e.action = "requested"; }, e => { e.workflow_run.status = "in_progress"; }, e => { e.workflow_run.name = "CI"; }, e => { e.workflow_run.head_branch = "feature"; }, e => { e.workflow_run.head_repository = { full_name: "fork/Cotal" }; }]) {
    const event = run(); mutate(event);
    assert.equal(planPhase(event, publishContext).status, "skipped");
  }
});

test("manual phase/profile/version are explicit and immutable SHA is mandatory", () => {
  for (const phase of ["candidate", "published"]) assert.equal(dispatch({ phase, profile: "bounded" }).profile, "bounded");
  for (const sourceSHA of ["main", "a".repeat(39), "a".repeat(41), "z".repeat(40), "", undefined]) assert.throws(() => dispatch({ sourceSHA }), /immutable/);
  for (const phase of ["green", "", undefined]) assert.throws(() => dispatch({ phase }), /manual phase/);
  for (const profile of ["all", "extended", "", undefined]) {
    if (profile === undefined) continue;
    assert.throws(() => dispatch({ profile }), /profile/);
  }
  for (const targetVersion of ["latest", "next", "v0.164.7", "0.164", "0.164.7-01", undefined]) assert.throws(() => dispatch({ targetVersion }), /semver|prerelease/);
});

test("semver comparison and target assertion reject stale/same source and every mismatched resolution", () => {
  assert.equal(BASELINE_VERSION, "0.164.6");
  assert.equal(compareVersions("0.164.10", "0.164.9"), 1);
  assert.equal(compareVersions("0.164.7-rc.10", "0.164.7-rc.2"), 1);
  assert.equal(compareVersions("0.164.7-rc.1", "0.164.7"), -1);
  assert.equal(compareVersions("0.164.7+build", "0.164.7"), 0);
  assert.equal(assertTarget("0.164.7", { cli: "0.164.7", core: "0.164.7", ext: "0.164.7" }), true);
  assert.throws(() => assertTarget("0.164.7", ["0.164.7", "0.164.6"]), /resolved/);
  assert.throws(() => assertTarget("0.164.6", "0.164.6"), /newer/);
  assert.throws(() => assertTarget("0.164.5", "0.164.5"), /newer/);
  assert.throws(() => assertTarget("0.164.7", {}), /missing/);
});

const requiredIDs = [
  "linux-npm-fresh", "linux-npm-configured", "linux-npm-stale-self",
  "darwin-npm-fresh", "darwin-npm-configured", "darwin-npm-stale-self",
  "win32-npm-fresh", "win32-npm-configured", "win32-npm-stale-self",
  "linux-installer-configured-rerun", "linux-installer-daemon-scheduler",
  "darwin-installer-configured-rerun", "darwin-installer-daemon-scheduler",
  "linux-npm-agent-stop-consent", "linux-npm-foreign-config-recovery", "linux-npm-container-manager",
];
test("bounded enumeration is deterministic: 9 npm + 4 POSIX + 1 consent + 2 Linux isolation", () => {
  const plan = dispatch();
  const cells = boundedCells(plan);
  assert.deepEqual(cells.filter(c => c.required).map(c => c.id), requiredIDs);
  assert.deepEqual(boundedCells(plan), cells);
  assert.equal(cells.length, 18);
  assert.equal(new Set(cells.map(c => c.id)).size, cells.length);
  for (const cell of cells) {
    assert.equal(cell.sourceSHA, sourceSHA);
    assert.equal(cell.sourceVersion, "0.164.6");
    assert.equal(cell.targetVersion, "0.164.7");
    assert.equal(cell.runner, { linux: "ubuntu-24.04", darwin: "macos-15", win32: "windows-2022" }[cell.platform]);
    if (cell.required) for (const assertion of ["status-healthy", "no-recovery", "no-manual-intervention"]) assert.ok(cell.requiredAssertions.includes(assertion));
    if (!cell.required) assert.ok(cell.reason);
    if (cell.channel === "installer") { assert.equal(cell.targetSource, "https://get.cotal.ai"); assert.equal(cell.installerOverride, false); }
  }
  assert.deepEqual(jobsMatrix(cells).include.map(c => c.id), requiredIDs);
  assert.equal(cells.find(c => c.id === "win32-npm-daemon-scheduler").required, false);
});

test("candidate B uses packed target and receipt-pinned installer artifact, candidate A optional", () => {
  const cells = boundedCells(dispatch({ phase: "candidate" }));
  assert.equal(cells.filter(c => c.required).length, 16);
  assert.ok(cells.filter(c => c.required && c.channel === "npm").every(c => c.targetSource === "packed-target"));
  const installers = cells.filter(c => c.channel === "installer" && c.scenario === "configured-rerun");
  const schedulers = cells.filter(c => c.required && c.scenario === "daemon-scheduler");
  assert.equal(installers.length, 2);
  assert.equal(schedulers.length, 2);
  assert.ok(installers.every(c => c.required && c.targetSource === "candidate-installer-artifact" && c.installerReceiptRequired && c.installerSource === "ARTIFACT/installer.sh" && c.requiredAssertions.includes("installer-source-receipt")));
  assert.ok(schedulers.every(c => c.required && !c.installerReceiptRequired && !c.requiredAssertions.includes("installer-source-receipt")));
  assert.equal(verifyResults(cells, goodResults(cells)).acceptance, true);
  assert.equal(cells.find(c => c.scenario === "candidate-a").required, false);
});

test("service baseline target must be newer or explicitly excluded, never same-version upgrade green", () => {
  for (const targetVersion of ["0.164.6", "0.164.5", "0.164.7-rc.1"]) {
    assert.throws(() => dispatch({ targetVersion }), /newer|stable/);
    assert.throws(() => planPhase(pr(), { ...context, packageManifest: { version: targetVersion } }), /newer|stable/);
  }
});

test("aggregator maps all required assertions, missing cells/assertions and failures cannot pass", () => {
  const cells = boundedCells(dispatch());
  const results = goodResults(cells);
  const report = verifyResults(cells, results);
  assert.equal(report.acceptance, true);
  assert.equal(report.passed.length, 16);
  assert.equal(report.excluded.length, 2);
  assert.equal(verifyResults(cells, results.slice(1)).acceptance, false);
  const missing = structuredClone(results);
  delete missing[0].assertions["target-version"];
  assert.equal(verifyResults(cells, missing).acceptance, false);
  missing[0].assertions["target-version"] = "true";
  assert.equal(verifyResults(cells, missing).acceptance, false);
  const failed = structuredClone(results); failed[0].status = "skipped";
  assert.equal(verifyResults(cells, failed).acceptance, false);
  assert.equal(verifyResults(cells, [...results, { id: "unknown", status: "passed" }]).acceptance, false);
  const excluded = cells.find(c => !c.required);
  assert.equal(verifyResults(cells, [...results, { id: excluded.id, status: "passed" }]).acceptance, false);
});

test("workflow wrapper accepts snake-case dispatch fields and exposes exact expected IDs", () => {
  const plan = planRelease({ eventName: "workflow_dispatch", inputs: { phase: "candidate", source_sha: sourceSHA, target_version: "0.164.7", profile: "bounded" } });
  assert.deepEqual(plan.expectedIDs, requiredIDs);
  assert.equal(plan.matrix.include.length, 16);
  const results = goodResults(plan.cells);
  assert.equal(verifyResults(plan.cells, results).acceptance, true);
  delete results.find(r => r.id === "linux-installer-configured-rerun").assertions["installer-source-receipt"];
  assert.equal(verifyResults(plan.cells, results).acceptance, false);
});

test("newer minor releases are valid and Linux isolation cells require their own evidence in both phases", () => {
  for (const phase of ["candidate", "published"]) {
    const cells = boundedCells(dispatch({ phase, targetVersion: "0.165.0" }));
    assert.equal(cells.filter(c => c.required).length, 16);
    for (const [id, assertion] of [["linux-npm-foreign-config-recovery", "foreign-snapshot-retained"], ["linux-npm-container-manager", "container-manager-preserved"]]) {
      const cell = cells.find(c => c.id === id);
      assert.equal(cell.sourceVersion, "0.164.6");
      assert.ok(cell.requiredAssertions.includes(assertion));
      const results = goodResults(cells);
      delete results.find(r => r.id === id).assertions[assertion];
      assert.equal(verifyResults(cells, results).acceptance, false);
    }
  }
});

test("duplicate coordinates and missing assertion/exclusion contracts are rejected", () => {
  const cells = boundedCells(dispatch()), results = goodResults(cells);
  assert.throws(() => jobsMatrix([...cells, cells[0]]), /duplicate coordinate/);
  assert.throws(() => verifyResults([...cells, cells[0]], results), /duplicate coordinate/);
  assert.throws(() => verifyResults(cells, [...results, results[0]]), /duplicate coordinate/);
  const badContract = structuredClone(cells); badContract[0].requiredAssertions = [];
  assert.throws(() => verifyResults(badContract, results), /missing required assertion/);
  const badExclusion = structuredClone(cells); badExclusion.find(c => !c.required).reason = "";
  assert.throws(() => verifyResults(badExclusion, results), /exclusion needs a reason/);
});
