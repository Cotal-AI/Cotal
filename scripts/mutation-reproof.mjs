#!/usr/bin/env node
/**
 * Re-prove every mutation fixture whose guarded source changed at this head.
 *
 * This gate exists to catch a suite that has quietly stopped proving what it claims. Its own
 * all-clear therefore must not be a way for it to prove nothing: an exit 0 that means "I looked and
 * found nothing to re-prove" has to be distinguishable from an exit 0 that means "I looked at
 * nothing." Every path that returns 0 below prints the evidence a reader needs to tell those apart,
 * and every path where the selector could not measure the corpus exits non-zero instead.
 *
 * Three earlier silent-success paths, reproduced at the blocked head and refused here:
 *   - a deleted guarded source never entered the changed set, because the diff excluded `D`;
 *   - a renamed guarded source reported only its new path, so a fixture still pointing at the old
 *     path was never selected;
 *   - a selected count of zero exited 0 unconditionally, whether the tree was clean or the selector
 *     had been handed nothing to look at.
 *
 * A fixture whose guarded source was deleted or renamed away is a DANGLING fixture: its anchor can
 * no longer resolve, so its proof is unrunnable. That is precisely the state this gate refuses, so a
 * dangling fixture is a loud failure, not a silent skip.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const PROOF = resolve(dirname(SCRIPT), "mutation-proof.mjs");

function usage(message) {
  if (message) console.error(message);
  console.error("usage: node scripts/mutation-reproof.mjs --base <commit> [--head <commit>] [--root <dir>] [--all] [--shard <index>/<count>]");
  process.exit(2);
}

function args(argv) {
  const out = {};
  const known = new Set(["base", "head", "root", "all", "shard"]);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) usage(`unexpected argument: ${argv[i]}`);
    const key = argv[i].slice(2);
    if (!known.has(key)) usage(`unknown option: --${key}`);
    if (key === "all") { out.all = true; continue; }
    if (i + 1 === argv.length || argv[i + 1].startsWith("--")) usage(`missing value for --${key}`);
    out[key] = argv[++i];
  }
  return out;
}

function git(root, argv) {
  return execFileSync("git", argv, { cwd: root, encoding: "utf8" });
}

/**
 * Membership in the corpus is decided by PATH CONVENTION, not by whether the file parses. A fixture
 * config is a mutations-directory JSON or a `*.mutations.json` — that rule matches every committed
 * fixture in the tree and nothing else (data fixtures under `fixtures/` and JSONC tsconfigs are
 * excluded). Deciding membership before parsing is what lets a MALFORMED fixture be refused rather
 * than silently dropped from the corpus: a fixture that no longer parses is still a fixture.
 */
function fixtureConfigPaths(root) {
  return git(root, ["ls-files", "*/mutations/*.json", "*.mutations.json"])
    .split("\n")
    .filter(Boolean);
}

/** Parse the corpus, collecting errors instead of dropping the offender. A fixture that fails to
 *  parse, or that carries no `mutations` array, leaves the corpus unmeasured and must be refused. */
function loadCorpus(root, paths) {
  const fixtures = [];
  const errors = [];
  for (const path of paths) {
    let config;
    try {
      config = JSON.parse(readFileSync(resolve(root, path), "utf8"));
    } catch (err) {
      errors.push(`${path}: ${err.message}`);
      continue;
    }
    if (!Array.isArray(config.mutations)) {
      errors.push(`${path}: no top-level "mutations" array`);
      continue;
    }
    fixtures.push({ path, mutations: config.mutations });
  }
  return { fixtures, errors };
}

/**
 * The changed set, seeing deletions and BOTH sides of a rename.
 *
 * `--name-status -M` reports one record per change: `A/C/M/D\tpath`, and `R<score>\told\tnew` for a
 * rename. `--name-only` (the blocked version) dropped `D` and reported only a rename's new path, so
 * a deleted guarded source never entered the set and a fixture still anchored to a pre-rename path
 * was never selected. Adding both the old and the new path of a rename is what makes a rename-away
 * select the fixture that still points at the old path.
 *
 * Returns the changed paths and the raw record count, so a caller can print the size of the diff as
 * evidence for a legitimate all-clear.
 */
function changedSet(root, base, head) {
  const raw = git(root, ["diff", "--name-status", "-M", `${base}...${head}`])
    .split("\n")
    .filter(Boolean);
  const changed = new Set();
  for (const line of raw) {
    const parts = line.split("\t");
    const status = parts[0];
    if (status.startsWith("R") || status.startsWith("C")) {
      if (parts[1]) changed.add(parts[1]);
      if (parts[2]) changed.add(parts[2]);
    } else if (parts[1]) {
      changed.add(parts[1]);
    }
  }
  return { changed, diffSize: raw.length };
}

function shardOf(path, count) {
  let hash = 0;
  for (const byte of Buffer.from(path)) hash = (hash * 31 + byte) >>> 0;
  return hash % count;
}

const a = args(process.argv.slice(2));
const root = resolve(a.root ?? process.cwd());
const head = a.head ?? "HEAD";
if (!a.all && !a.base) usage("--base is required unless --all is set");
const shard = a.shard === undefined ? undefined : a.shard.match(/^(\d+)\/(\d+)$/);
if (a.shard !== undefined && (!shard || Number(shard[2]) < 1 || Number(shard[1]) >= Number(shard[2])))
  usage(`invalid --shard ${a.shard}; use <index>/<count>`);

if (!a.all) {
  try {
    git(root, ["merge-base", "--is-ancestor", a.base, head]);
  } catch {
    console.error(`${a.base} is not an ancestor of ${head}; refuse a comparison that includes another branch's changes`);
    process.exit(2);
  }
}

// UNMEASURED, exit 1: the corpus is empty. There is nothing this gate could have proven, which is
// not the same as there being nothing that needed proving.
const configPaths = fixtureConfigPaths(root);
if (configPaths.length === 0) {
  console.error("mutation reproof: UNMEASURED — no fixture configs found in the corpus (expected */mutations/*.json or *.mutations.json)");
  process.exit(1);
}

// UNMEASURED, exit 1: a fixture failed to parse or is missing its mutations array. A malformed
// fixture must fail here rather than vanish from the corpus and shrink the set that gets proven.
const { fixtures, errors } = loadCorpus(root, configPaths);
if (errors.length) {
  console.error(`mutation reproof: UNMEASURED — ${errors.length} malformed fixture(s), refusing rather than dropping them:`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

const { changed, diffSize } = a.all ? { changed: new Set(), diffSize: 0 } : changedSet(root, a.base, head);

let selected = fixtures.filter(({ path, mutations }) => a.all || changed.has(path)
  || mutations.some((mutation) => typeof mutation?.file === "string" && changed.has(mutation.file)));
if (shard) selected = selected.filter(({ path }) => shardOf(path, Number(shard[2])) === Number(shard[1]));

// UNMEASURED, exit 1: a selected fixture's guarded file does not exist at head — a dangling fixture.
// Its guarded source was deleted or renamed away, so its anchor cannot resolve and its proof is
// unrunnable. This is the failure the gate exists to refuse, so it is loud, not a skip.
const dangling = [];
for (const { path, mutations } of selected) {
  const missing = [...new Set(mutations
    .map((mutation) => mutation?.file)
    .filter((file) => typeof file === "string" && !existsSync(resolve(root, file))))];
  if (missing.length) dangling.push({ path, missing });
}
if (dangling.length) {
  console.error(`mutation reproof: UNMEASURED — ${dangling.length} dangling fixture(s); a guarded source was deleted or renamed away and the proof is unrunnable:`);
  for (const { path, missing } of dangling) console.error(`  ${path} -> missing: ${missing.join(", ")}`);
  process.exit(1);
}

// LEGITIMATE all-clear, exit 0: nothing intersected. Print the evidence — diff size, changed-set
// size, corpus size, selected count — so a reader can tell a real clean tree from a broken selector
// that looked at nothing. On --all this branch is unreachable (every fixture selects).
console.log(`mutation reproof: ${selected.length} fixture(s) selected from ${fixtures.length}`
  + (a.all
    ? " for a full sweep"
    : ` (diff ${diffSize} record(s), ${changed.size} changed path(s), corpus ${fixtures.length})`));
if (selected.length === 0) {
  console.log("No mutation fixtures to re-prove: no fixture config or guarded source intersects the diff.");
  process.exit(0);
}
console.log(`selected fixture paths:\n${selected.map(({ path }) => `  ${path}`).join("\n")}`);

const failed = [];
for (const { path } of selected) {
  console.log(`\n===== ${path} =====`);
  const run = spawnSync(process.execPath, [PROOF, "--config", path], {
    cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  process.stdout.write(run.stdout ?? "");
  process.stderr.write(run.stderr ?? "");
  if (run.status !== 0) failed.push(path);
}

if (failed.length) {
  console.error(`\nMUTATION REPROOF FAILED (${failed.length} fixture(s)): ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`\nMUTATION REPROOF OK (${selected.length} fixture(s))`);
