#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { coldVersionWrites } from "./apply-cold-versions.mjs";

const root = resolve(import.meta.dirname, "..");
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };
const workflow = parse(readFileSync(join(root, ".github/workflows/cold-setup.yml"), "utf8"));
const release = parse(readFileSync(join(root, ".github/workflows/changesets.yml"), "utf8"));
const runners = ["ubuntu-latest", "ubuntu-24.04-arm", "macos-15-intel", "macos-15", "windows-latest", "windows-11-arm"];
check("matrix covers every native architecture and supported Node major", () => {
  assert.deepEqual(workflow.jobs.lifecycle.strategy.matrix.runner, runners);
  assert.deepEqual(workflow.jobs.lifecycle.strategy.matrix.node, [22, 24, 26]);
  assert.equal(workflow.jobs.lifecycle.strategy["fail-fast"], false);
});
check("normal and snapshot publication consume sealed native qualification", () => {
  assert.equal(release.jobs["cold-setup"], undefined, "publish-go must not start another native matrix");
  assert.equal(release.jobs.snapshot, undefined, "snapshots use the same guarded publisher");
  assert.deepEqual(workflow.jobs["cold-ok"].needs, ["native", "workspace-native", "candidate", "lifecycle"]);
  assert.equal(workflow.jobs["cold-ok"].if, "always()");
  const steps = workflow.jobs["cold-ok"].steps;
  const verify = steps.findIndex((step) => step.run?.includes("verify-cold-results.mjs"));
  const requireAll = steps.findIndex((step) => step.name === "Require every cold setup");
  const seal = steps.findIndex((step) => step.run?.includes("release-qualification.mjs record"));
  const upload = steps.findIndex((step) => step.with?.name === "cold-qualified");
  assert(verify >= 0 && requireAll > verify && seal > requireAll && upload > seal);
  assert.equal(steps[seal].if, undefined); assert.equal(steps[seal]["continue-on-error"], undefined);
});
check("snapshot publication replays qualified versions without versioning after go", () => {
  const steps = release.jobs.version.steps;
  const replay = steps.findIndex((step) => step.run?.includes("apply-cold-versions.mjs"));
  const verify = steps.findIndex((step) => step.run?.includes("release-qualification.mjs verify"));
  const publish = steps.findIndex((step) => step.run?.includes("publish-cold-candidate.mjs"));
  assert(verify >= 0 && replay > verify && publish > replay);
  assert.equal(steps[replay].if, "inputs.snapshot != ''");
  assert(!steps.some((step) => step.run?.includes("changeset version") || step.uses?.startsWith("changesets/action@")));
  assert.equal(workflow.on.workflow_dispatch.inputs.snapshot.default, "");
});
const actionStep = (job) => {
  const steps = release.jobs[job].steps.filter((step) => step.uses?.startsWith("changesets/action@"));
  assert.equal(steps.length, 1, `${job} runs changesets/action exactly once`);
  return steps[0];
};
check("version-only admission cannot publish", () => {
  const job = release.jobs["version-pr"];
  const step = actionStep("version-pr");
  assert.equal(step.id, "changesets");
  assert.equal(step.with.publish, undefined);
  assert.equal(step.with.version, "pnpm ci:version");
  assert.equal(step.env.COLD_CANDIDATE, undefined);
  assert.equal(job.permissions["id-token"], undefined);
  assert.equal(job.environment, "npm-publish");
  assert.equal(job.needs, undefined);
  assert.equal(job.outputs["has-changesets"], "${{ steps.changesets.outputs.hasChangesets }}");
  const steps = job.steps.map((step) => step.name);
  const definite = job.steps.find((step) => step.name === "Require a definite changeset state");
  assert(steps.indexOf("Require a definite changeset state") > steps.indexOf(step.name));
  assert.equal(definite.run, 'test "$HAS_CHANGESETS" = true || test "$HAS_CHANGESETS" = false');
});
check("preparation cannot start publication or block its queue", () => {
  assert.equal(release.jobs["version-pr"].if, "github.event_name == 'push'");
  assert.equal(release.concurrency.group, "${{ github.workflow }}-${{ github.ref }}-${{ github.event_name }}");
  assert.equal(release.concurrency["cancel-in-progress"], false);
  assert.equal(release.concurrency.queue, "max");
});
check("main-only OIDC promotion pins the original clock and immutable cross-run inputs", () => {
  const job = release.jobs.version;
  assert.equal(job.needs, undefined);
  assert.equal(job.if, "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'");
  assert.equal(job.environment, "npm-publish");
  assert.equal(job.permissions["id-token"], "write"); assert.equal(job.permissions.actions, "read");
  for (const name of ["qualification_run", "candidate_sha256", "source", "requested_at"]) assert.equal(release.on.workflow_dispatch.inputs[name].required, true);
  assert.equal(job.env.RELEASE_REQUESTED_AT, "${{ inputs.requested_at }}");
  assert.equal(job.env.RELEASE_SOURCE, "${{ inputs.source }}");
  assert.equal(job.env.RELEASE_ROOT, "${{ runner.temp }}/release-source");
  assert.equal(job.env.RELEASE_CANDIDATE_SHA256, "${{ inputs.candidate_sha256 }}");
  const download = job.steps.find((step) => step.uses === "actions/download-artifact@v4");
  assert.equal(download.with["artifact-ids"], "${{ steps.qualification.outputs.artifact-ids }}");
  assert.equal(download.with["run-id"], "${{ inputs.qualification_run }}");
  assert.equal(download.with["github-token"], "${{ github.token }}");
  assert.equal(download.with.pattern, undefined); assert.equal(download.with["merge-multiple"], undefined);
  const selection = job.steps.findIndex((step) => step.id === "qualification");
  const checkout = job.steps.findIndex((step) => step.run?.includes("release-qualification.mjs checkout"));
  const verify = job.steps.findIndex((step) => step.run?.includes("release-qualification.mjs verify"));
  const publish = job.steps.findIndex((step) => step.run?.includes("publish-cold-candidate.mjs"));
  const archives = job.steps.findIndex((step) => step.id === "archive-gate");
  const install = job.steps.findIndex((step) => step.id === "install-gate");
  const outcome = job.steps.findIndex((step) => step.run?.includes("record-publication-outcome.mjs"));
  const releaseStep = job.steps.findIndex((step) => step.id === "release-step");
  assert(selection >= 0 && checkout > selection && verify > checkout && publish > verify && archives > publish && install > archives && outcome > install && releaseStep > outcome);
  for (const index of [selection, checkout, verify, publish, archives]) {
    assert.equal(job.steps[index].if, undefined); assert.equal(job.steps[index]["continue-on-error"], undefined);
  }
  assert(job.steps[install].run.includes("--requested-at=$RELEASE_REQUESTED_AT"));
  assert.equal(job.steps[outcome].if, "always()");
  assert.equal(job.steps.at(-1).uses, "actions/upload-artifact@v4"); assert.equal(job.steps.at(-1).if, "always()");
  assert(!job.steps.some((step) => step.run?.includes("pnpm build") || step.run?.includes("pack-cold-candidate.mjs")));
  assert(workflow.jobs.candidate.steps.some((step) => step.run?.includes("post-publish-install-probe.mjs")));
});
const source = "a".repeat(40);
const candidateBytes = JSON.stringify({ source, syntheticVerifierFixture: true });
const candidateSha256 = createHash("sha256").update(candidateBytes).digest("hex");
const current = { name: "one", version: "1.0.0", scripts: { build: "real-build" }, dependencies: { two: "workspace:*", external: "^1" } };
const prepared = { ...current, version: "1.0.1-next-20261015000000", dependencies: { two: "1.0.1-next-20261015000000", external: "^1" } };
const row = { name: "one", path: "/fixture/one", manifest: current };
const packages = [row, { name: "two", path: "/fixture/two", manifest: { name: "two", version: "1.0.0" } }];
const expected = ["one", "two"];
const manifest = { source, packages: [{ name: "one", version: prepared.version, sourceManifest: JSON.stringify(prepared) }, { name: "two", version: prepared.version, sourceManifest: JSON.stringify({ name: "two", version: prepared.version }) }] };
check("snapshot versions replay without changing policy", () => assert.equal(coldVersionWrites(manifest, packages, expected, source).length, 2));
for (const [name, mutate] of [
  ["wrong source", (m) => { m.source = "b".repeat(40); }],
  ["missing package", (m) => { m.packages = []; }],
  ["duplicate package", (m) => { m.packages.push(m.packages[0]); }],
  ["wrong version metadata", (m) => { m.packages[0].version = "other"; }],
  ["replaced package policy", (m) => { const p = JSON.parse(m.packages[0].sourceManifest); p.scripts.build = "different"; m.packages[0].sourceManifest = JSON.stringify(p); }],
  ["changed external dependency", (m) => { const p = JSON.parse(m.packages[0].sourceManifest); p.dependencies.external = "^2"; m.packages[0].sourceManifest = JSON.stringify(p); }],
]) {
  check(`snapshot refuses ${name}`, () => { const copy = structuredClone(manifest); mutate(copy); assert.throws(() => coldVersionWrites(copy, packages, expected, source)); });
}
const fixture = mkdtempSync(join(tmpdir(), "cold-gate-contract-"));
try {
  const platforms = [["linux", "x64"], ["linux", "arm64"], ["darwin", "x64"], ["darwin", "arm64"], ["win32", "x64"], ["win32", "arm64"]];
  const checks = ["cold restart replaces every process generation", "native process identity round-trips before daemon startup"];
  for (const round of [0, 1]) for (const name of ["Manager, delivery and broker survive startup", "native Manager control answers", "empty Manager roster is an empty seat list", "native shutdown policy is accepted once", "owned broker listener closed"]) checks.push(`round ${round} ${name}`);
  for (const round of [0, 1]) for (const component of ["manager", "delivery"]) checks.push(`round ${round} Windows ${component} cleanup handler ran`);
  let firstFile;
  for (const [i, runner] of runners.entries()) for (const node of [22, 24, 26]) {
    const dir = join(fixture, `cold-result-${runner}-node${node}`); mkdirSync(dir);
    const value = { source, candidateSha256, complete: true, platform: platforms[i][0], arch: platforms[i][1], node: `v${node}.0.0`, assertions: checks.length, checks, generations: [0, 1].map((round) => ["nats", "manager", "delivery"].map((name, index) => ({ name: name + ".pid", pid: 100 + index + round * 10, token: `fixture-${round}` }))) };
    const file = join(dir, "cold-result.json"); writeFileSync(file, JSON.stringify(value)); firstFile ??= file;
  }
  const candidate = join(fixture, "manifest.json"); writeFileSync(candidate, candidateBytes);
  const verify = () => spawnSync(process.execPath, [join(root, "scripts/verify-cold-results.mjs"), fixture, source, candidate], { encoding: "utf8", timeout: 10_000 });
  check("complete synthetic verifier fixtures pass (not native execution)", () => assert.equal(verify().status, 0));
  const original = readFileSync(firstFile, "utf8");
  for (const [name, mutate] of [
    ["another source", (r) => { r.source = "b".repeat(40); }],
    ["another archive set", (r) => { r.candidateSha256 = "b".repeat(64); }],
    ["incomplete setup", (r) => { r.complete = false; }],
    ["wrong native architecture", (r) => { r.arch = "arm64"; }],
    ["wrong Node major", (r) => { r.node = "v20.0.0"; }],
    ["missing shutdown check", (r) => { r.checks = r.checks.filter((s) => !s.includes("shutdown policy")); r.assertions = r.checks.length; }],
    ["missing first native identity read", (r) => { r.checks = r.checks.filter((s) => !s.includes("before daemon startup")); r.assertions = r.checks.length; }],
    ["missing process identity", (r) => { r.generations[0] = []; }],
  ]) check(`receipt verifier refuses ${name}`, () => {
    const value = JSON.parse(original); mutate(value); writeFileSync(firstFile, JSON.stringify(value));
    assert.equal(verify().status, 1); writeFileSync(firstFile, original);
  });
  const windowsFile = join(fixture, "cold-result-windows-latest-node22", "cold-result.json");
  const windowsOriginal = readFileSync(windowsFile, "utf8");
  for (const component of ["manager", "delivery"]) check(`receipt verifier refuses missing Windows ${component} cleanup`, () => {
    const value = JSON.parse(windowsOriginal);
    value.checks = value.checks.filter((name) => name !== `round 0 Windows ${component} cleanup handler ran`);
    value.assertions = value.checks.length;
    writeFileSync(windowsFile, JSON.stringify(value));
    assert.equal(verify().status, 1);
    writeFileSync(windowsFile, windowsOriginal);
  });
  rmSync(firstFile);
  check("receipt verifier refuses an absent platform result", () => assert.equal(verify().status, 1));
} finally { rmSync(fixture, { recursive: true, force: true }); }
console.log(`COLD GATE CONTRACT OK (${passed} checks; synthetic fixtures only)`);
