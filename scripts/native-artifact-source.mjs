#!/usr/bin/env node
/** Select a successful native build with identical declared inputs, or request a fresh build. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { posix } from "node:path";
import { parse } from "yaml";
import { isMainEntry } from "./main-entry.mjs";
import { sourceFiles as workspaceNativeFiles } from "../packages/workspace/scripts/native-contract.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const INPUTS = [
  "packages/seat/native", "packages/seat/scripts",
  ...workspaceNativeFiles.map((path) => `packages/workspace/${path}`),
  ".github/workflows/workspace-native.yml",
  "pnpm-workspace.yaml", ".npmrc", ".pnpmfile.cjs", "patches",
];
export const nativeArtifacts = Object.freeze([
  "seat-native-x64", "seat-native-arm64",
  ...["win32", "darwin"].flatMap((platform) => ["x64", "arm64"].map((arch) => `seat-native-${platform}-${arch}`)),
  "workspace-native-x64", "workspace-native-arm64",
  "workspace-native-darwin-x64", "workspace-native-darwin-arm64",
]);
const run = (command, args, cwd = ROOT) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const git = (...args) => run("git", args);
const api = (path) => JSON.parse(run("gh", ["api", path]));
const commit = (ref) => git("rev-parse", "--verify", `${ref}^{commit}`);

/** Keep shared resolution settings and every resolved dependency of the native importers. */
function nativeLockInputs(lock) {
  const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  assert(record(lock) && String(lock.lockfileVersion) === "9.0", "unsupported native lockfile version");
  const { importers, packages, snapshots, ...settings } = lock;
  assert(record(importers) && record(packages) && record(snapshots), "invalid native lockfile tables");
  const selected = { settings, importers: Object.create(null), packages: Object.create(null), snapshots: Object.create(null) };
  const groups = ["dependencies", "devDependencies", "optionalDependencies"];
  const own = (table, key) => Object.hasOwn(table, key);
  const edges = (entry, fields, importer) => {
    for (const field of fields) {
      if (!own(entry, field)) continue;
      assert(record(entry[field]), `invalid native lockfile ${field}`);
      for (const [name, dependency] of Object.entries(entry[field])) {
        const version = importer === undefined ? dependency : dependency?.version;
        assert(typeof version === "string", `invalid native lockfile reference: ${name}`);
        if (version.startsWith("link:")) {
          assert(importer !== undefined, "unsupported linked native snapshot");
          const relative = version.slice(5);
          assert(relative && !posix.isAbsolute(relative) && !relative.includes("\\"), "unsupported native workspace link");
          const path = posix.normalize(posix.join(importer, relative));
          assert(!posix.isAbsolute(path) && path !== ".." && !path.startsWith("../"), "native workspace link escapes repository");
          visitImporter(path);
        } else {
          // pnpm stores aliases as name@version and ordinary references as version alone.
          const key = /^\d/.test(version) ? `${name}@${version}` : version;
          assert(/^(?:@[^/]+\/)?[^@/]+@\d+\./.test(key), `unsupported native lockfile reference: ${version}`);
          visitSnapshot(key);
        }
      }
    }
  };
  const visitImporter = (path) => {
    if (own(selected.importers, path)) return;
    assert(own(importers, path) && record(importers[path]), `missing native lockfile importer: ${path}`);
    const entry = importers[path];
    assert(Object.keys(entry).every((key) => groups.includes(key)), `unsupported native lockfile importer: ${path}`);
    selected.importers[path] = entry;
    edges(entry, groups, path);
  };
  const visitSnapshot = (key) => {
    if (own(selected.snapshots, key)) return;
    assert(own(snapshots, key) && record(snapshots[key]), `missing native lockfile snapshot: ${key}`);
    const id = key.split("(", 1)[0];
    assert(own(packages, id) && record(packages[id]), `missing native lockfile package: ${id}`);
    const entry = snapshots[key];
    assert(Object.keys(entry).every((field) => ["dependencies", "optionalDependencies", "transitivePeerDependencies", "optional"].includes(field)), `unsupported native lockfile snapshot: ${key}`);
    selected.packages[id] = packages[id];
    selected.snapshots[key] = entry;
    edges(entry, ["dependencies", "optionalDependencies"]);
  };
  for (const path of ["packages/seat", "packages/workspace"]) visitImporter(path);
  return selected;
}

/** Compiler inputs and build instructions, excluding package version/changelog changes. */
export function nativeInputs(ref, directory = ROOT) {
  const at = (...args) => run("git", args, directory);
  const sha = at("rev-parse", "--verify", `${ref}^{commit}`);
  const workflow = parse(at("show", `${sha}:.github/workflows/changesets.yml`));
  const native = workflow.jobs.native;
  const root = JSON.parse(at("show", `${sha}:package.json`));
  const seat = JSON.parse(at("show", `${sha}:packages/seat/package.json`));
  return {
    files: at("ls-tree", "-r", sha, "--", ...INPUTS),
    lock: nativeLockInputs(parse(at("show", `${sha}:pnpm-lock.yaml`))),
    recipe: { env: workflow.env, runner: native["runs-on"], strategy: native.strategy, steps: native.steps, nativeEnv: native.env },
    packageManager: root.packageManager,
    engines: root.engines,
    devEngines: root.devEngines,
    pnpm: root.pnpm,
    nativeCommand: seat.scripts["build:native"],
  };
}

/** Refuse reuse if any declared native input or build instruction differs. */
export function assertNativeInputsMatch(source, target, directory = ROOT) {
  assert(isDeepStrictEqual(nativeInputs(source, directory), nativeInputs(target, directory)), "native build inputs differ; fresh native builders are required");
}

/** Only this repository's successful main-push preparation can supply native artifacts. */
export function trustedNativeRun(candidate, repository) {
  return candidate.status === "completed" && candidate.conclusion === "success" && candidate.event === "push" &&
    candidate.head_branch === "main" && candidate.path === ".github/workflows/changesets.yml" &&
    candidate.repository?.full_name === repository && candidate.head_repository?.full_name === repository &&
    /^[a-f0-9]{40}$/.test(candidate.head_sha);
}

/** Require every architecture's unexpired artifact, with no ambiguous duplicate names. */
export function completeNativeArtifacts(artifacts) {
  return nativeArtifacts.every((name) => artifacts.filter((artifact) => artifact.name === name && artifact.expired === false).length === 1);
}

/** Find eligible artifacts through GitHub's authenticated, repository-scoped artifact API. */
export function selectNativeSource(target, repository) {
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), "GH_REPO must name owner/repository");
  target = commit(target);
  const wanted = nativeInputs(target);
  const candidates = api(`repos/${repository}/actions/artifacts?name=workspace-native-darwin-x64&per_page=100`).artifacts;
  const seen = new Set();
  for (const artifact of candidates) {
    const origin = artifact.workflow_run;
    if (artifact.name !== "workspace-native-darwin-x64" || artifact.expired !== false || !origin || origin.head_branch !== "main" ||
        !Number.isSafeInteger(origin.id) || origin.head_repository_id !== origin.repository_id || seen.has(origin.id)) continue;
    seen.add(origin.id);
    const candidate = api(`repos/${repository}/actions/runs/${origin.id}`);
    if (!trustedNativeRun(candidate, repository) || candidate.id !== origin.id || candidate.head_sha !== origin.head_sha) continue;
    try { git("merge-base", "--is-ancestor", candidate.head_sha, target); }
    catch (error) { if (error.status === 1) continue; throw error; }
    if (!isDeepStrictEqual(nativeInputs(candidate.head_sha), wanted)) continue;
    const artifacts = api(`repos/${repository}/actions/runs/${origin.id}/artifacts?per_page=100`).artifacts;
    if (!completeNativeArtifacts(artifacts)) continue;
    console.error(`Native build ${origin.id} at ${candidate.head_sha} has matching inputs; assembly will verify its bytes and receipts.`);
    return { run: String(origin.id), source: candidate.head_sha };
  }
  console.error("No eligible native artifacts; compile the requested source on native runners.");
  return { run: "", source: target };
}

if (isMainEntry(import.meta.url)) {
  const [mode, first, second] = process.argv.slice(2);
  if (mode === "verify" && first && second) {
    assertNativeInputsMatch(first, second);
    console.log("Native input identity verified against the packing checkout.");
  } else if (mode === "select" && first) {
    const selected = selectNativeSource(first, process.env.GH_REPO ?? "");
    console.log(`run=${selected.run}\nsource=${selected.source}`);
  } else throw new Error("usage: native-artifact-source.mjs select <source> | verify <native-source> <pack-source>");
}
