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
check("normal and snapshot publication require the cold workflow", () => {
  for (const name of ["version", "snapshot"]) assert(release.jobs[name].needs.includes("cold-setup"));
  assert.equal(release.jobs["cold-setup"].uses, "./.github/workflows/cold-setup.yml");
  assert.equal(release.jobs["cold-setup"]["continue-on-error"], undefined);
  assert.deepEqual(workflow.jobs["cold-ok"].needs, ["native", "workspace-native", "candidate", "lifecycle"]);
  assert.equal(workflow.jobs["cold-ok"].if, "always()");
  assert(workflow.jobs["cold-ok"].steps.some((step) => step.run?.includes("verify-cold-results.mjs")));
});
check("snapshot publication reuses qualified versions", () => {
  const steps = release.jobs.snapshot.steps;
  assert(steps.some((step) => step.run?.includes("apply-cold-versions.mjs")));
  assert(!steps.some((step) => step.run?.includes("changeset version")));
});
const actionStep = (job) => {
  const steps = release.jobs[job].steps.filter((step) => step.uses?.startsWith("changesets/action@"));
  assert.equal(steps.length, 1, `${job} runs changesets/action exactly once`);
  return steps[0];
};
const statusFunction = /\b(always|cancelled|failure|success)\s*\(/;
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
check("only an explicit no-changesets admission starts the normal cold matrix", () => {
  const cold = release.jobs["cold-setup"];
  assert.deepEqual(cold.needs, ["version-pr"]);
  assert.equal(cold.if, "(github.event_name == 'workflow_dispatch' && inputs.snapshot != '') || needs.version-pr.outputs.has-changesets == 'false'");
  assert(!statusFunction.test(cold.if));
});
check("publication needs a definite no-changesets admission and a successful cold matrix", () => {
  const job = release.jobs.version;
  assert.deepEqual(job.needs, ["version-pr", "cold-setup"]);
  assert.equal(job.if, "needs.version-pr.outputs.has-changesets == 'false'");
  assert(!statusFunction.test(job.if));
  assert.equal(job.environment, "npm-publish");
  assert.equal(job.permissions["id-token"], "write");
  const step = actionStep("version");
  assert.equal(step.with.publish, "pnpm ci:publish");
  assert.equal(step.env.COLD_CANDIDATE, "${{ runner.temp }}/cold-candidate");
  assert.equal(step.env.COLD_RESULTS, "${{ runner.temp }}/cold-results");
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
