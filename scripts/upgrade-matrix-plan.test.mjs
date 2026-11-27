import test from "node:test";
import assert from "node:assert/strict";
import { publishedPredecessor, planPhase, planRelease, boundedCells, jobsMatrix, compareVersions, assertTarget, verifyResults, syntheticNextVersion, syntheticFollowOnVersion } from "./upgrade-matrix-plan.mjs";

const sourceSHA = "a".repeat(40), newerSHA = "b".repeat(40);
const repository = "Cotal-AI/Cotal";
const repo = { full_name: repository };
const context = { eventName: "pull_request", repository, sourceVersion: "0.164.6", packageManifest: { version: "0.164.7" } };
function pr() { return { action: "synchronize", pull_request: { state: "open", head: { ref: "changeset-release/main", sha: sourceSHA, repo }, base: { ref: "main", sha: newerSHA, repo } } }; }
function dispatch(overrides = {}) { return planPhase({ eventName: "workflow_dispatch", inputs: { phase: "published", sourceSHA, targetVersion: "0.164.7", profile: "bounded", ...overrides } }, { sourceVersion: "0.164.6" }); }
function run(conclusion = "failure") { return { action: "completed", repository: repo, workflow_run: { status: "completed", name: "Publish packages", path: ".github/workflows/changesets.yml", conclusion, head_branch: "main", head_sha: sourceSHA, repository: repo, head_repository: repo } }; }
const publishContext = { ...context, eventName: "workflow_run", published: true, publishJobConclusion: "success", targetVersion: "0.164.7" };
function goodResults(cells) { return cells.filter(c => c.required).map(c => ({ id: c.id, status: "passed", assertions: Object.fromEntries(c.requiredAssertions.map(a => [a, true])) })); }

test("registry predecessor excludes target, newer versions, prereleases and malformed keys without a fallback", () => {
  const registry = { versions: Object.fromEntries(["0.164.6", "0.164.7", "0.164.8", "0.165.0", "0.164.8-rc.1", "latest"].map(version => [version, { version }])) };
  assert.equal(publishedPredecessor(registry, "0.164.8"), "0.164.7");
  assert.equal(publishedPredecessor(registry, "0.164.7"), "0.164.6");
  assert.throws(() => publishedPredecessor({}, "0.164.8"), /versions missing/);
  assert.throws(() => publishedPredecessor({ versions: {} }, "0.164.8"), /no published stable source/);
  assert.throws(() => publishedPredecessor({ versions: { "0.164.7": { version: "0.164.6" } } }, "0.164.8"), /version mismatch/);
  const plan = planPhase(pr(), { ...context, sourceVersion: "0.164.7", packageManifest: { version: "0.164.8" } });
  assert(boundedCells(plan).filter(cell => !["candidate-next-two-homes", "candidate-next-daemon-self", "candidate-next-stopped-daemon-self", "candidate-next-disabled-daemon-self", "candidate-next-stopped-desktop-self", "candidate-next-foreign-config-recovery"].includes(cell.scenario) && !cell.followOnAction && !cell.chain && !cell.deadUpdater && !cell.otherHomeAuth && !cell.pinnedTrustSource).every(cell => cell.sourceVersion === "0.164.7"));
  assert.throws(() => planPhase(pr(), { ...context, sourceVersion: undefined }), /frozen published/);
});

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
  for (const mutate of [e => { e.action = "requested"; }, e => { e.workflow_run.status = "in_progress"; }, e => { e.workflow_run.path = ".github/workflows/ci.yml"; }, e => { e.workflow_run.head_branch = "feature"; }, e => { e.workflow_run.head_repository = { full_name: "fork/Cotal" }; }]) {
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
  assert.throws(() => assertTarget("0.164.7", "0.164.7"), /semver/);
  const source = { sourceVersion: "0.164.6" };
  assert.equal(compareVersions("0.164.10", "0.164.9"), 1);
  assert.equal(compareVersions("0.164.7-rc.10", "0.164.7-rc.2"), 1);
  assert.equal(compareVersions("0.164.7-rc.1", "0.164.7"), -1);
  assert.equal(compareVersions("0.164.7+build", "0.164.7"), 0);
  assert.equal(assertTarget("0.164.7", { cli: "0.164.7", core: "0.164.7", ext: "0.164.7" }, source), true);
  assert.throws(() => assertTarget("0.164.7", ["0.164.7", "0.164.6"], source), /resolved/);
  assert.throws(() => assertTarget("0.164.6", "0.164.6", source), /newer/);
  assert.throws(() => assertTarget("0.164.5", "0.164.5", source), /newer/);
  assert.throws(() => assertTarget("0.164.7", {}, source), /missing/);
});

const requiredIDs = [
  "linux-npm-fresh", "linux-npm-configured", "linux-npm-stale-self",
  "darwin-npm-fresh", "darwin-npm-configured", "darwin-npm-stale-self",
  "win32-npm-fresh", "win32-npm-configured", "win32-npm-stale-self",
  "linux-installer-configured-rerun", "linux-installer-daemon-scheduler",
  "darwin-installer-configured-rerun", "darwin-installer-daemon-scheduler",
  "linux-npm-agent-stop-consent", "linux-npm-standalone-stop-consent", "linux-npm-foreign-config-recovery", "linux-npm-container-manager",
  "linux-npm-interrupted-snapshot-copy",
  "linux-npm-project-trust-migration", "darwin-npm-project-trust-migration", "win32-npm-project-trust-migration",
  "linux-npm-project-trust-migration-0.182.1", "darwin-npm-project-trust-migration-0.182.1", "win32-npm-project-trust-migration-0.182.1",
  "linux-npm-daemon-self", "darwin-npm-daemon-self", "win32-npm-daemon-self",
  "linux-installer-daemon-self", "darwin-installer-daemon-self",
];
test("bounded enumeration is deterministic: 29 ordinary + 2 two-home + 3 fresh next + 3 stopped-daemon next + 2 disabled-daemon next + 1 stopped-desktop next + 6 follow-on + 3 pinned chains + 2 killed-updater recovery cells + 1 other-home auth cell + 1 candidate-source recovery cell", () => {
  const plan = dispatch();
  const cells = boundedCells(plan);
  assert.deepEqual(cells.filter(c => c.required).map(c => c.id), candidateIDs);
  assert.deepEqual(boundedCells(plan), cells);
  assert.equal(cells.length, 56);
  assert.equal(new Set(cells.map(c => c.id)).size, cells.length);
  for (const cell of cells) {
    assert.equal(cell.sourceSHA, sourceSHA);
    assert.equal(cell.sourceVersion, cell.chain ? "0.164.10" : cell.pinnedTrustSource ? "0.182.1" : (["candidate-next-two-homes", "candidate-next-daemon-self", "candidate-next-stopped-daemon-self", "candidate-next-disabled-daemon-self", "candidate-next-stopped-desktop-self", "candidate-next-foreign-config-recovery"].includes(cell.scenario) || cell.followOnAction || cell.deadUpdater || cell.otherHomeAuth) ? "0.164.7" : "0.164.6");
    assert.equal(cell.targetVersion, (["candidate-next-two-homes", "candidate-next-daemon-self", "candidate-next-stopped-daemon-self", "candidate-next-disabled-daemon-self", "candidate-next-stopped-desktop-self", "candidate-next-foreign-config-recovery"].includes(cell.scenario) || cell.followOnAction || cell.deadUpdater || cell.otherHomeAuth) ? "0.164.1007" : "0.164.7");
    if (cell.followOnAction) assert.equal(cell.finalTargetVersion, "0.164.2007");
    assert.equal(cell.runner, { linux: "ubuntu-24.04", darwin: "macos-15", win32: "windows-2022" }[cell.platform]);
    if (cell.required) for (const assertion of ["status-healthy", "no-recovery", "no-manual-intervention"]) assert.ok(cell.requiredAssertions.includes(assertion));
    if (!cell.required) assert.ok(cell.reason);
    if (cell.channel === "installer" && cell.scenario !== "daemon-self" && !cell.followOnAction) { assert.equal(cell.targetSource, "https://get.cotal.ai"); assert.equal(cell.installerOverride, false); }
  }
  assert.deepEqual(jobsMatrix(cells).include.map(c => c.id), candidateIDs);
  assert.equal(cells.find(c => c.id === "win32-npm-daemon-scheduler").required, false);
});

const nextIDs = ["linux", "darwin", "win32"].map(platform => `${platform}-npm-candidate-next-daemon-self`);
const stoppedNextIDs = ["linux", "darwin", "win32"].map(platform => `${platform}-npm-candidate-next-stopped-daemon-self`);
const disabledNextIDs = ["linux", "darwin"].map(platform => `${platform}-npm-candidate-next-disabled-daemon-self`);
const stoppedDesktopNextIDs = ["linux-npm-candidate-next-stopped-desktop-self"];
const followOnIDs = ["linux", "darwin"].flatMap(platform => [
  `${platform}-npm-candidate-next-second-self`,
  `${platform}-npm-candidate-next-manual-npm`,
  `${platform}-installer-candidate-next-installer-rerun`,
]);
const chainIDs = ["linux", "darwin", "win32"].map(platform => `${platform}-npm-source-0.164.10-daemon-self-chain`);
const deadUpdaterIDs = ["linux", "darwin"].map(platform => `${platform}-npm-candidate-next-dead-updater`);
test("killed-updater recovery adds only two POSIX target-owned cells with mandatory evidence", () => {
  for (const phase of ["candidate", "published"]) {
    const plan = dispatch({ phase, targetVersion: "0.165.0" });
    const cells = boundedCells(plan);
    const added = cells.filter(cell => cell.deadUpdater);
    assert.deepEqual(added.map(cell => cell.id), deadUpdaterIDs);
    assert.equal(cells.filter(cell => cell.required && !cell.deadUpdater && !cell.otherHomeAuth).length, 50);
    for (const cell of added) {
      assert.equal(cell.sourceVersion, "0.165.0");
      assert.equal(cell.targetVersion, "0.165.1000");
      assert.equal(cell.sourceKind, phase === "candidate" ? "packed-candidate-A" : "npm-exact-A");
      assert.equal(cell.targetSource, "packed-next-B");
      assert.equal(cell.targetSourceSHA, sourceSHA);
      for (const key of ["dead-updater-release", "live-owner-held", "next-update-alone"]) {
        const results = goodResults(cells);
        delete results.find(result => result.id === cell.id).assertions[key];
        assert.equal(verifyResults(cells, results).acceptance, false);
      }
    }
  }
});

const twoHomeIDs = ["linux", "darwin"].map(platform => `${platform}-npm-candidate-next-two-homes`);
const candidateIDs = [...requiredIDs, ...twoHomeIDs, ...nextIDs, ...stoppedNextIDs, ...disabledNextIDs, ...stoppedDesktopNextIDs, ...followOnIDs, ...chainIDs, ...deadUpdaterIDs, "linux-npm-candidate-next-other-home-auth", "linux-npm-candidate-next-foreign-config-recovery"];

test("both phases retain 53 required cells with permanently pinned chains, stopped/disabled/desktop manual-repair cells, follow-on cells, and conditional ordinary chains", () => {
  for (const phase of ["candidate", "published"]) for (const sourceVersion of ["0.164.9", "0.164.10", "0.164.11"]) {
    const plan = planRelease({ eventName: "workflow_dispatch", inputs: { phase, sourceSHA, targetVersion: "0.164.12" } }, { sourceVersion });
    assert.deepEqual(plan.expectedIDs, candidateIDs);
    assert.equal(plan.matrix.include.length, 53);
    for (const cell of plan.cells) assert.equal(new Set(cell.requiredAssertions).size, cell.requiredAssertions.length);
    const recovery = plan.matrix.include.find(c => c.id === "linux-npm-candidate-next-foreign-config-recovery");
    const publishedSourceRecovery = plan.matrix.include.find(c => c.id === "linux-npm-foreign-config-recovery");
    assert.equal(recovery.sourceVersion, "0.164.12");
    assert.equal(recovery.sourceKind, phase === "candidate" ? "packed-candidate-A" : "npm-exact-A");
    assert.equal(recovery.targetVersion, "0.164.1012");
    assert.equal(recovery.targetSource, "packed-next-B");
    assert.equal(recovery.targetSourceSHA, sourceSHA);
    assert.deepEqual(new Set(recovery.requiredAssertions), new Set([...publishedSourceRecovery.requiredAssertions, "candidate-source-identity", "candidate-next-target", "next-hop-success"]));
    const ordinary = plan.cells.filter(c => requiredIDs.includes(c.id));
    assert.equal(ordinary.length, 29);
    const self = ordinary.filter(c => c.scenario === "daemon-self");
    assert.equal(self.length, 5);
    for (const cell of ordinary) assert.equal(cell.chain === true, sourceVersion === "0.164.10" && (cell.scenario === "daemon-self" || cell.id === "linux-npm-agent-stop-consent"));
    const pinned = plan.cells.filter(c => chainIDs.includes(c.id));
    assert.equal(pinned.length, 3);
    for (const cell of pinned) {
      assert.equal(cell.sourceVersion, "0.164.10");
      assert.equal(cell.sourceKind, "npm-exact-source");
      assert.equal(cell.chain, true);
    }
    for (const cell of plan.cells.filter(c => c.chain)) {
      assert.equal(cell.sourceSHA, sourceSHA);
      assert.equal(cell.targetSourceSHA, sourceSHA);
      assert.equal(cell.targetVersion, "0.164.12");
      assert.equal(cell.finalTargetVersion, "0.164.1012");
      for (const assertion of ["exact-source-refusal", "intermediate-whole-machine", "next-hop-success", "independent-final-state", ...(cell.id === "linux-npm-agent-stop-consent" ? [] : ["native-service-manual"])]) {
        assert.ok(cell.requiredAssertions.includes(assertion));
        const results = goodResults(plan.cells);
        delete results.find(r => r.id === cell.id).assertions[assertion];
        assert.equal(verifyResults(plan.cells, results).acceptance, false);
      }
    }
    for (const cell of plan.cells.filter(c => nextIDs.includes(c.id) || stoppedNextIDs.includes(c.id) || disabledNextIDs.includes(c.id) || stoppedDesktopNextIDs.includes(c.id))) {
      assert.equal(cell.sourceVersion, "0.164.12");
      assert.equal(cell.targetVersion, "0.164.1012");
      assert.ok(cell.requiredAssertions.includes("next-hop-success"));
      for (const assertion of ["next-hop-success", ...(cell.stoppedDaemonBeforeUpdate ? ["stopped-daemon-before-update"] : []), ...(cell.disabledDaemonBeforeUpdate ? ["disabled-daemon-before-update"] : []), ...(cell.desktopBesideCli ? ["stopped-desktop-beside-cli"] : [])]) {
        assert.ok(cell.requiredAssertions.includes(assertion));
        const results = goodResults(plan.cells);
        delete results.find(r => r.id === cell.id).assertions[assertion];
        assert.equal(verifyResults(plan.cells, results).acceptance, false);
      }
      assert.equal(cell.sourceKind, phase === "published" ? "npm-exact-A" : "packed-candidate-A");
      assert.equal(cell.sourceSHA, sourceSHA);
      assert.equal(cell.targetSourceSHA, sourceSHA);
    }
    for (const cell of plan.cells.filter(c => followOnIDs.includes(c.id))) {
      assert.equal(cell.sourceVersion, "0.164.12");
      assert.equal(cell.targetVersion, "0.164.1012");
      assert.equal(cell.finalTargetVersion, "0.164.2012");
      assert.equal(cell.sourceKind, phase === "published" ? "npm-exact-A" : "packed-candidate-A");
      assert.equal(cell.targetSource, "packed-follow-on-C");
      for (const assertion of ["intermediate-whole-machine", "follow-on-target", "follow-on-success", "independent-final-state", ...(cell.followOnAction === "npm" ? ["bare-manual-npm-observation"] : []), ...(cell.channel === "installer" ? ["installer-source-receipt"] : [])]) {
        assert.ok(cell.requiredAssertions.includes(assertion));
        const results = goodResults(plan.cells);
        delete results.find(r => r.id === cell.id).assertions[assertion];
        assert.equal(verifyResults(plan.cells, results).acceptance, false);
      }
    }
    assert.equal(verifyResults(plan.cells, goodResults(plan.cells)).upgradeAcceptance, true);
  }
});

test("source 0.164.10 hosted consent chains require restored Manager and all existing chain evidence", () => {
  for (const phase of ["candidate", "published"]) {
    const plan = planRelease({ eventName: "workflow_dispatch", inputs: { phase, sourceSHA, targetVersion: "0.164.12" } }, { sourceVersion: "0.164.10" });
    assert.equal(plan.matrix.include.length, 53);
    assert.deepEqual(plan.expectedIDs, candidateIDs);
    const cell = plan.cells.find(c => c.id === "linux-npm-agent-stop-consent");
    assert.equal(cell.platform, "linux");
    assert.equal(cell.channel, "npm");
    assert.equal(cell.sourceVersion, "0.164.10");
    assert.equal(cell.chain, true);
    assert.equal(cell.targetVersion, "0.164.12");
    assert.equal(cell.finalTargetVersion, "0.164.1012");
    for (const assertion of ["hosted-manager-restored", "exact-source-refusal", "intermediate-whole-machine", "next-hop-success", "independent-final-state"]) {
      assert.ok(cell.requiredAssertions.includes(assertion), assertion);
      const results = goodResults(plan.cells);
      delete results.find(r => r.id === cell.id).assertions[assertion];
      assert.equal(verifyResults(plan.cells, results).acceptance, false, assertion);
    }
    const standalone = plan.cells.find(c => c.id === "linux-npm-standalone-stop-consent");
    assert.notEqual(standalone.chain, true);
    assert.equal(standalone.finalTargetVersion, undefined);
  }
});

test("synthetic next and follow-on versions deterministically add 1000 and 2000 with safe numeric ordering", () => {
  for (const [candidate, next, followOn] of [["0.164.7", "0.164.1007", "0.164.2007"], ["1.2.0", "1.2.1000", "1.2.2000"], ["9007199254740991.0.9007199254738991", "9007199254740991.0.9007199254739991", "9007199254740991.0.9007199254740991"]]) {
    assert.equal(syntheticNextVersion(candidate), next);
    assert.equal(syntheticFollowOnVersion(candidate), followOn);
    assert.equal(compareVersions(next, candidate), 1);
    assert.equal(compareVersions(followOn, next), 1);
    assert.equal(assertTarget(next, next, { sourceVersion: candidate }), true);
    assert.equal(assertTarget(followOn, followOn, { sourceVersion: next }), true);
    assert.throws(() => assertTarget(next, candidate, { sourceVersion: candidate }), /resolved/);
    assert.throws(() => assertTarget(candidate, candidate, { sourceVersion: candidate }), /newer/);
  }
  for (const candidate of [undefined, null, 123, "latest", "01.2.3", "1.2.3-rc.1", "1.2.3+build", "1.2.-1", "1.2.9007199254739992", "9007199254740992.0.0", "0.9007199254740992.0"]) {
    assert.throws(() => syntheticNextVersion(candidate), /stable numeric|safe numeric/);
  }
  assert.throws(() => boundedCells(dispatch({ phase: "candidate", targetVersion: "0.164.9007199254738992" })), /safe numeric/);
});

test("candidate next-hop owns C to synthetic B at frozen H, separate from optional candidate A", () => {
  const plan = planRelease(pr(), context);
  assert.deepEqual(plan.expectedIDs, candidateIDs);
  assert.equal(plan.matrix.include.length, 53);
  assert.deepEqual(plan.matrix, jobsMatrix(plan.cells));
  const next = plan.cells.filter(c => c.scenario === "candidate-next-daemon-self");
  assert.deepEqual(next.map(c => c.id), nextIDs);
  for (const cell of next) {
    assert.equal(cell.phase, "candidate");
    assert.equal(cell.channel, "npm");
    assert.equal(cell.sourceSHA, sourceSHA);
    assert.equal(cell.targetSourceSHA, sourceSHA);
    assert.equal(cell.sourceVersion, "0.164.7");
    assert.notEqual(cell.sourceVersion, context.sourceVersion);
    assert.equal(cell.targetVersion, "0.164.1007");
    assert.equal(cell.sourceKind, "packed-candidate-A");
    assert.equal(cell.targetSource, "packed-next-B");
    assert.equal(cell.syntheticVersionRule, "candidate.patch+1000");
    assert.equal(cell.required, true);
    assert.equal(cell.disposition, "required");
    assert.equal(cell.reason, null);
    for (const assertion of ["native-service-manual", "independent-final-state", "candidate-source-identity", "candidate-next-target", "next-hop-success"]) {
      assert.ok(cell.requiredAssertions.includes(assertion));
      const results = goodResults(plan.cells);
      delete results.find(r => r.id === cell.id).assertions[assertion];
      assert.equal(verifyResults(plan.cells, results).acceptance, false);
    }
    for (const status of ["skipped", "excluded", "failed"]) {
      const results = goodResults(plan.cells);
      results.find(r => r.id === cell.id).status = status;
      assert.equal(verifyResults(plan.cells, results).acceptance, false);
    }
    const results = goodResults(plan.cells);
    assert.equal(verifyResults(plan.cells, results.filter(r => r.id !== cell.id)).acceptance, false);
    assert.throws(() => verifyResults(plan.cells, [...results, results.find(r => r.id === cell.id)]), /duplicate coordinate/);
    assert.throws(() => jobsMatrix([...plan.cells, cell]), /duplicate coordinate/);
  }
  assert.equal(verifyResults(plan.cells, goodResults(plan.cells)).upgradeAcceptance, true);
  assert.equal(verifyResults(plan.cells, [...goodResults(plan.cells), { id: "linux-npm-candidate-next-unknown", status: "passed" }]).acceptance, false);
  assert.equal(plan.cells.find(c => c.scenario === "candidate-a").required, false);
  const published = planRelease(run(), publishContext);
  assert.deepEqual(published.expectedIDs, candidateIDs);
  assert.equal(published.matrix.include.length, 53);
  assert.ok(published.cells.filter(c => nextIDs.includes(c.id) || stoppedNextIDs.includes(c.id) || disabledNextIDs.includes(c.id) || stoppedDesktopNextIDs.includes(c.id)).every(c => c.sourceKind === "npm-exact-A"));
  assert.deepEqual(plan.cells.map(c => c.id), published.cells.map(c => c.id));
});

test("candidate uses packed target and receipt-pinned installer artifact, candidate A optional", () => {
  const cells = boundedCells(dispatch({ phase: "candidate" }));
  assert.equal(cells.filter(c => c.required).length, 53);
  assert.ok(cells.filter(c => c.required && c.channel === "npm" && !["candidate-next-two-homes", "candidate-next-daemon-self", "candidate-next-stopped-daemon-self", "candidate-next-disabled-daemon-self", "candidate-next-stopped-desktop-self", "candidate-next-foreign-config-recovery"].includes(c.scenario) && !c.followOnAction && !c.deadUpdater && !c.otherHomeAuth).every(c => c.targetSource === "packed-target"));
  const installers = cells.filter(c => c.channel === "installer" && c.scenario === "configured-rerun");
  const schedulers = cells.filter(c => c.required && c.scenario === "daemon-scheduler");
  assert.equal(installers.length, 2);
  assert.equal(schedulers.length, 2);
  assert.ok(installers.every(c => c.required && c.targetSource === "candidate-installer-artifact" && c.installerReceiptRequired && c.installerSource === "ARTIFACT/installer.sh" && c.requiredAssertions.includes("installer-source-receipt")));
  assert.ok(schedulers.every(c => c.required && !c.installerReceiptRequired && !c.requiredAssertions.includes("installer-source-receipt")));
  assert.equal(verifyResults(cells, goodResults(cells)).acceptance, true);
  assert.equal(cells.find(c => c.scenario === "candidate-a").required, false);
});

test("automatic phases include manual service self-updates with self target provenance and strict evidence", () => {
  for (const [event, metadata, phase, targetSource] of [[pr(), context, "candidate", "packed-target"], [run(), publishContext, "published", "npm-exact"]]) {
    const plan = planRelease(event, metadata);
    assert.equal(plan.phase, phase);
    const ids = candidateIDs;
    assert.deepEqual(plan.expectedIDs, ids);
    assert.deepEqual(plan.matrix.include.map(c => c.id), ids);
    const selfCells = plan.cells.filter(c => c.scenario === "daemon-self" && c.required);
    assert.deepEqual(selfCells.map(c => c.id), requiredIDs.slice(-5));
    assert.equal(plan.cells.filter(c => c.required).length, ids.length);
    const exclusions = plan.cells.filter(c => !c.required);
    assert.deepEqual(exclusions.map(c => c.id), ["win32-installer-daemon-self", "win32-npm-daemon-scheduler", "linux-npm-candidate-a"]);
    assert.match(exclusions[0].reason, /no public shell installer route/);
    assert.deepEqual(exclusions[0].requiredAssertions, []);
    assert.equal(verifyResults(plan.cells, [...goodResults(plan.cells), { id: exclusions[0].id, status: "passed" }]).acceptance, false);
    for (const cell of selfCells) {
      assert.equal(cell.targetSource, targetSource);
      assert.equal(cell.installerSource, null);
      assert.equal(cell.installerReceiptRequired, false);
      assert.equal(cell.installerOverride, false);
      assert.ok(!cell.requiredAssertions.includes("installer-source-receipt"));
      for (const assertion of ["native-service-manual", "independent-final-state"]) {
        assert.ok(cell.requiredAssertions.includes(assertion));
        const results = goodResults(plan.cells);
        delete results.find(r => r.id === cell.id).assertions[assertion];
        const report = verifyResults(plan.cells, results);
        assert.equal(report.acceptance, false);
        assert.ok(report.failures.includes(`${cell.id}: missing required assertions: ${assertion}`));
      }
      assert.equal(verifyResults(plan.cells, goodResults(plan.cells).filter(r => r.id !== cell.id)).acceptance, false);
    }
    assert.equal(verifyResults(plan.cells, goodResults(plan.cells)).upgradeAcceptance, true);
  }
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
  assert.equal(report.passed.length, 53);
  assert.equal(report.excluded.length, 3);
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
  const plan = planRelease({ eventName: "workflow_dispatch", inputs: { phase: "candidate", source_sha: sourceSHA, target_version: "0.164.7", profile: "bounded" } }, { sourceVersion: "0.164.6" });
  assert.deepEqual(plan.expectedIDs, candidateIDs);
  assert.equal(plan.matrix.include.length, 53);
  const results = goodResults(plan.cells);
  assert.equal(verifyResults(plan.cells, results).acceptance, true);
  delete results.find(r => r.id === "linux-installer-configured-rerun").assertions["installer-source-receipt"];
  assert.equal(verifyResults(plan.cells, results).acceptance, false);
});

test("newer minor releases are valid and Linux isolation cells require their own evidence in both phases", () => {
  for (const phase of ["candidate", "published"]) {
    const cells = boundedCells(dispatch({ phase, targetVersion: "0.165.0" }));
    assert.equal(cells.filter(c => c.required).length, 53);
    for (const [id, assertion, sourceVersion] of [["linux-npm-foreign-config-recovery", "foreign-snapshot-retained", "0.164.6"], ["linux-npm-container-manager", "container-manager-preserved", "0.164.6"], ["linux-npm-interrupted-snapshot-copy", "interrupted-snapshot-reclaimed", "0.164.6"], ["linux-npm-project-trust-migration", "project-trust-migrated", "0.164.6"], ["darwin-npm-project-trust-migration", "project-trust-migrated", "0.164.6"], ["win32-npm-project-trust-migration", "project-trust-migrated", "0.164.6"], ["linux-npm-project-trust-migration-0.182.1", "project-trust-migrated", "0.182.1"], ["darwin-npm-project-trust-migration-0.182.1", "project-trust-migrated", "0.182.1"], ["win32-npm-project-trust-migration-0.182.1", "project-trust-migrated", "0.182.1"]]) {
      const cell = cells.find(c => c.id === id);
      assert.equal(cell.sourceVersion, sourceVersion);
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
