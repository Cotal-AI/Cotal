import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
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
    const lockfile = { lockfileVersion: "9.0", settings: { autoInstallPeers: true }, importers: { "packages/seat": {}, "packages/workspace": {} }, packages: {}, snapshots: {} };
    write("pnpm-lock.yaml", stringify(lockfile));
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
    write("pnpm-lock.yaml", stringify({ ...lockfile, settings: { autoInstallPeers: false } }));
    const lock = snapshot();
    await t.test("lockfile resolution settings require a new build", () => assert.throws(() => assertNativeInputsMatch(sdk, lock, root), /native build inputs differ/));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native lockfile closure follows workspace, peer, optional and aliased dependencies", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "native-lock-fixture-"));
  const git = (...args) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "-c", `core.hooksPath=${join(root, "no-hooks")}`, ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  const dependency = (version) => ({ specifier: "fixture", version });
  const lock = {
    lockfileVersion: "9.0", settings: { autoInstallPeers: true },
    importers: {
      "packages/seat": { dependencies: { binding: dependency("1.0.0(peer@2.0.0)"), alias: dependency("actual@1.0.0") }, devDependencies: { helper: dependency("link:../helper") } },
      "packages/workspace": { optionalDependencies: { platform: dependency("1.0.0") } },
      "packages/helper": { dependencies: { leaf: dependency("1.0.0"), seat: dependency("link:../seat") } },
      desktop: { devDependencies: { font: dependency("1.0.0") } },
    },
    packages: Object.fromEntries(["binding@1.0.0", "peer@2.0.0", "actual@1.0.0", "platform@1.0.0", "leaf@1.0.0", "font@1.0.0"].map((id) => [id, { resolution: { integrity: "fixture" } }])),
    snapshots: {
      "binding@1.0.0(peer@2.0.0)": { dependencies: { peer: "2.0.0" }, optionalDependencies: { leaf: "1.0.0" } },
      "peer@2.0.0": {}, "actual@1.0.0": {}, "platform@1.0.0": {}, "leaf@1.0.0": { dependencies: { binding: "1.0.0(peer@2.0.0)" } }, "font@1.0.0": {},
    },
  };
  const snapshot = (value) => { write("pnpm-lock.yaml", stringify(value)); git("add", "."); git("commit", "-qm", "test: record lock fixture"); return git("rev-parse", "HEAD"); };
  try {
    git("init", "-q");
    write("package.json", JSON.stringify({ packageManager: "pnpm@11.28.2" }));
    write("packages/seat/package.json", JSON.stringify({ scripts: { "build:native": "native-build" } }));
    write(".github/workflows/changesets.yml", stringify({ jobs: { native: { steps: [{ run: "native-build" }] } } }));
    const base = snapshot(lock);
    const cases = [
      ["unrelated importer and package changes preserve identity", (value) => { value.importers.desktop.devDependencies.font = dependency("2.0.0"); value.packages["font@2.0.0"] = {}; value.snapshots["font@2.0.0"] = {}; }, false],
      ["direct importer changes require builders", (value) => { value.importers["packages/seat"].dependencies.binding.specifier = "changed"; }, true],
      ["reachable package integrity changes require builders", (value) => { value.packages["binding@1.0.0"].resolution.integrity = "changed"; }, true],
      ["peer dependency metadata changes require builders", (value) => { value.packages["peer@2.0.0"].resolution.integrity = "changed"; }, true],
      ["aliased dependency changes require builders", (value) => { value.packages["actual@1.0.0"].resolution.integrity = "changed"; }, true],
      ["optional importer dependencies require builders", (value) => { value.packages["platform@1.0.0"].resolution.integrity = "changed"; }, true],
      ["transitive optional dependencies require builders", (value) => { value.packages["leaf@1.0.0"].resolution.integrity = "changed"; }, true],
      ["linked workspace importers require builders", (value) => { value.importers["packages/helper"].dependencies.leaf.specifier = "changed"; }, true],
      ["shared settings changes require builders", (value) => { value.settings.autoInstallPeers = false; }, true],
      ["other shared resolution fields require builders", (value) => { value.overrides = { leaf: "2.0.0" }; }, true],
      ["patch hash changes require builders", (value) => { value.patchedDependencies = { "leaf@1.0.0": "changed" }; }, true],
      ["unknown lockfile versions refuse reuse", (value) => { value.lockfileVersion = "10.0"; }, /unsupported native lockfile version/],
      ["missing native importer refuses reuse", (value) => { delete value.importers["packages/workspace"]; }, /missing native lockfile importer/],
      ["missing linked importer refuses reuse", (value) => { delete value.importers["packages/helper"]; }, /missing native lockfile importer/],
      ["missing snapshot refuses reuse", (value) => { delete value.snapshots["peer@2.0.0"]; }, /missing native lockfile snapshot/],
      ["missing package refuses reuse", (value) => { delete value.packages["peer@2.0.0"]; }, /missing native lockfile package/],
      ["unsupported local dependency refuses reuse", (value) => { value.importers["packages/seat"].dependencies.binding.version = "file:../binding"; }, /unsupported native lockfile reference/],
      ["escaping workspace link refuses reuse", (value) => { value.importers["packages/seat"].devDependencies.helper.version = "link:../../../foreign"; }, /native workspace link escapes repository/],
      ["absolute workspace link refuses reuse", (value) => { value.importers["packages/seat"].devDependencies.helper.version = "link:/packages/helper"; }, /unsupported native workspace link/],
      ["unknown importer edge form refuses reuse", (value) => { value.importers["packages/seat"].futureDependencies = {}; }, /unsupported native lockfile importer/],
      ["unknown snapshot edge form refuses reuse", (value) => { value.snapshots["peer@2.0.0"].futureDependencies = {}; }, /unsupported native lockfile snapshot/],
      ["malformed dependency reference refuses reuse", (value) => { value.snapshots["peer@2.0.0"].dependencies = { broken: {} }; }, /invalid native lockfile reference/],
    ];
    for (const [name, change, refusal] of cases) {
      await t.test(name, () => {
        const value = structuredClone(lock);
        change(value);
        const changed = snapshot(value);
        if (refusal) assert.throws(() => assertNativeInputsMatch(base, changed, root), refusal === true ? /native build inputs differ/ : refusal);
        else assert.doesNotThrow(() => assertNativeInputsMatch(base, changed, root));
      });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
