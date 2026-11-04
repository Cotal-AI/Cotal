import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { assertNativeInputsMatch, completeNativeArtifacts, nativeArtifacts, trustedNativeRun } from "./native-artifact-source.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const valid = { status: "completed", conclusion: "success", event: "push", head_branch: "main", path: ".github/workflows/changesets.yml", repository: { full_name: "fixture/repo" }, head_repository: { full_name: "fixture/repo" }, head_sha: sha };
test("accepts a successful main push in the same repository", () => assert.equal(trustedNativeRun(valid, "fixture/repo"), true));
for (const [name, fields] of [
  ["unfinished run", { status: "queued" }], ["failed run", { conclusion: "failure" }],
  ["pull request", { event: "pull_request" }], ["other branch", { head_branch: "feature" }],
  ["other workflow", { path: ".github/workflows/other.yml" }],
  ["other repository", { repository: { full_name: "other/repo" } }],
  ["fork source", { head_repository: { full_name: "fork/repo" } }],
  ["invalid source", { head_sha: "not-a-commit" }],
]) test(`refuses ${name}`, () => assert.equal(trustedNativeRun({ ...valid, ...fields }, "fixture/repo"), false));

const artifacts = nativeArtifacts.map((name) => ({ name, expired: false }));
test("requires all ten native artifacts", () => { assert.equal(artifacts.length, 10); assert.equal(completeNativeArtifacts(artifacts), true); });
test("refuses missing architecture", () => assert.equal(completeNativeArtifacts(artifacts.slice(1)), false));
test("refuses expired artifact", () => assert.equal(completeNativeArtifacts([{ ...artifacts[0], expired: true }, ...artifacts.slice(1)]), false));
test("refuses unknown expiry", () => assert.equal(completeNativeArtifacts([{ name: artifacts[0].name }, ...artifacts.slice(1)]), false));
test("refuses duplicate artifact names", () => assert.equal(completeNativeArtifacts([...artifacts, artifacts[0]]), false));
test("allows unrelated pack artifacts", () => assert.equal(completeNativeArtifacts([...artifacts, { name: "release-candidate", expired: false }]), true));

test("compares immutable git fixture snapshots, not edited product source", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "native-input-fixture-"));
  const git = (...args) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "-c", `core.hooksPath=${join(root, "no-hooks")}`, ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value)); };
  const snapshot = () => { git("add", "."); git("commit", "-qm", "test: record fixture snapshot"); return git("rev-parse", "HEAD"); };
  try {
    git("init", "-q");
    write("package.json", { packageManager: "pnpm@11.28.2" });
    write("packages/seat/package.json", { version: "1.0.0", scripts: { "build:native": "node scripts/build-native.mjs --host" } });
    write("packages/seat/native/peercred.c", "native fixture one");
    write("packages/workspace/native/node-sdk.json", { version: "fixture-one" });
    write(".github/workflows/workspace-native.yml", "jobs: {}\n");
    write(".github/workflows/changesets.yml", { jobs: { native: { "runs-on": "ubuntu-latest", steps: [{ run: "native-build" }] } } });
    const base = snapshot();
    write("packages/seat/package.json", { version: "1.0.1", scripts: { "build:native": "node scripts/build-native.mjs --host" } });
    write("packages/seat/CHANGELOG.md", "release note");
    const versioned = snapshot();
    await t.test("version and changelog changes preserve native identity", () => assert.doesNotThrow(() => assertNativeInputsMatch(base, versioned, root)));
    write("packages/seat/native/peercred.c", "native fixture two");
    const changed = snapshot();
    await t.test("native source changes require a new build", () => assert.throws(() => assertNativeInputsMatch(versioned, changed, root), /native build inputs differ/));
    write(".github/workflows/changesets.yml", { jobs: { native: { "runs-on": "ubuntu-latest", steps: [{ run: "different-build" }] } } });
    const recipe = snapshot();
    await t.test("build-command changes require a new build", () => assert.throws(() => assertNativeInputsMatch(changed, recipe, root), /native build inputs differ/));
    write("packages/workspace/native/node-sdk.json", { version: "fixture-two" });
    const sdk = snapshot();
    await t.test("SDK changes require a new build", () => assert.throws(() => assertNativeInputsMatch(recipe, sdk, root), /native build inputs differ/));
    write("pnpm-lock.yaml", "lock fixture");
    const lock = snapshot();
    await t.test("lockfile changes require a new build", () => assert.throws(() => assertNativeInputsMatch(sdk, lock, root), /native build inputs differ/));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
