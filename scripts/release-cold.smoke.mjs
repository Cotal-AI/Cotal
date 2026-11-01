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
check("optional cold qualification seals all native results independently of publication", () => {
  assert.equal(release.jobs["cold-setup"], undefined, "publication must not start another native matrix");
  assert.equal(release.jobs.snapshot, undefined);
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
check("build provenance is pinned, retained and verified before native qualification", () => {
  const job = workflow.jobs.candidate, steps = job.steps;
  const pack = steps.findIndex((step) => step.run?.includes("pack-cold-candidate.mjs"));
  const attest = steps.findIndex((step) => step.id === "build-attestation");
  const retain = steps.findIndex((step) => step.run?.includes('cp "$QUALIFICATION_BUNDLE"'));
  const verify = steps.findIndex((step) => step.run?.includes("verify-qualification-attestation.mjs"));
  const upload = steps.findIndex((step) => step.with?.name === "cold-candidate");
  assert(pack >= 0 && attest > pack && retain > attest && verify > retain && upload > verify);
  assert.equal(steps[attest].uses, "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6");
  assert.equal(steps[attest].with["subject-path"], "cold-candidate/manifest.json");
  assert.equal(job.permissions.contents, "read"); assert.equal(job.permissions["id-token"], "write");
  assert.equal(job.permissions.attestations, "write"); assert.equal(job.permissions["artifact-metadata"], "write");
  assert.equal(workflow.permissions["id-token"], undefined, "build signing authority must not become global");
  for (const index of [attest, retain, verify]) {
    assert.equal(steps[index].if, "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository");
    assert.equal(steps[index]["continue-on-error"], undefined);
  }
});
check("version preparation cannot publish", () => {
  const job = release.jobs["version-pr"];
  const steps = job.steps.filter((step) => step.uses?.startsWith("changesets/action/version@"));
  assert.equal(steps.length, 1);
  assert.equal(steps[0].with.script, "pnpm ci:version");
  assert.equal(job.permissions["id-token"], undefined);
  assert.equal(job.environment, undefined);
  assert.equal(job.needs, "select");
  assert.equal(job.if, "github.event_name == 'push' && needs.select.outputs.mode == 'version'");
  assert.equal(job.outputs.sha, "${{ steps.head.outputs.sha }}");
  assert(!job.steps.some((step) => step.uses?.startsWith("changesets/action/publish@")));
});
check("preparation and publication have separate queues", () => {
  assert.equal(release.concurrency, undefined);
  for (const name of ["version-pr", "publish"]) {
    const concurrency = release.jobs[name].concurrency;
    assert.equal(concurrency.group, `\${{ github.workflow }}-${name}`);
    assert.equal(concurrency["cancel-in-progress"], false);
    assert.equal(concurrency.queue, "max");
  }
  assert.equal(release.jobs["verify-install"].concurrency, undefined);
});
check("preparation packs the version head with its native binaries", () => {
  const job = release.jobs.pack, steps = job.steps;
  assert.deepEqual(job.needs, ["select", "version-pr", "native", "workspace-native"]);
  assert.equal(steps.find((step) => step.uses?.startsWith("actions/checkout@")).with.ref, "${{ needs.version-pr.outputs.sha }}");
  assert(steps.some((step) => step.run === 'test "$(git rev-parse HEAD^)" = "$GITHUB_SHA"'));
  const native = steps.findIndex((step) => step.run?.includes("workspace-assemble-natives.mjs"));
  const pack = steps.findIndex((step) => step.uses?.startsWith("changesets/action/pack@"));
  const record = steps.findIndex((step) => step.name === "Record the release candidate");
  assert(native >= 0 && pack > native && record > pack);
  assert(steps[record].run.includes("HEAD^{tree}"));
  assert.equal(steps[record].env.PACK, "${{ steps.pack.outputs.pack-dir-artifact-id }}");
});
check("main publication consumes the matching tree's immutable pack without rebuilding", () => {
  const selection = release.jobs.release;
  assert.equal(selection.if, "github.ref == 'refs/heads/main'");
  const find = selection.steps.find((step) => step.id === "find");
  assert(find.run.includes('--workflow changesets.yml --event push --branch main --commit "$parent" --status success'));
  assert(find.run.includes('[ "$(jq -r .tree "$candidate")" = "$tree" ]'));
  assert.equal(selection.outputs.pack, "${{ steps.find.outputs.pack }}");
  assert.equal(selection.outputs.run, "${{ steps.find.outputs.run }}");
  const job = release.jobs.publish;
  assert.equal(job.needs, "release");
  assert.equal(job.if, "needs.release.outputs.pack != ''");
  assert.equal(job.environment, "npm-publish");
  assert.equal(job.permissions["id-token"], "write");
  const download = job.steps.find((step) => step.uses === "actions/download-artifact@v4");
  assert.equal(download.with["artifact-ids"], "${{ needs.release.outputs.pack }}");
  assert.equal(download.with["run-id"], "${{ needs.release.outputs.run }}");
  assert.equal(download.with.pattern, undefined);
  const upload = job.steps.findIndex((step) => step.id === "packed");
  const publish = job.steps.findIndex((step) => step.uses?.startsWith("changesets/action/publish@"));
  assert(upload >= 0 && publish > upload);
  assert.equal(job.steps[publish].with["pack-dir-artifact-id"], "${{ steps.packed.outputs.artifact-id }}");
  assert(!job.steps.some((step) => step.run?.includes("pnpm build") || step.uses?.startsWith("changesets/action/pack@") || step.uses?.startsWith("changesets/action/version@")));
  for (const value of Object.values(release.jobs)) assert(!JSON.stringify(value.env ?? {}).includes("runner."), "runner paths belong in step context");
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
