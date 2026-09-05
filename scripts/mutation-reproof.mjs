#!/usr/bin/env node
/** Re-prove every mutation fixture whose guarded source changed at this head. */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

function fixturePaths(root) {
  return git(root, ["ls-files", "*.json"])
    .split("\n")
    .filter(Boolean)
    .flatMap((path) => {
      try {
        const config = JSON.parse(readFileSync(resolve(root, path), "utf8"));
        return Array.isArray(config.mutations) ? [{ path, mutations: config.mutations }] : [];
      } catch {
        return [];
      }
    });
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

const fixtures = fixturePaths(root);
if (fixtures.length === 0) {
  console.error("no mutation fixtures found");
  process.exit(1);
}
const changed = a.all
  ? new Set()
  : new Set(git(root, ["diff", "--name-only", "--diff-filter=ACMR", `${a.base}...${head}`]).split("\n").filter(Boolean));

if (!a.all) {
  try {
    git(root, ["merge-base", "--is-ancestor", a.base, head]);
  } catch {
    console.error(`${a.base} is not an ancestor of ${head}; refuse a comparison that includes another branch's changes`);
    process.exit(2);
  }
}

// A config is not the only thing that can retire its proof. A changed guarded source can leave an
// anchor intact while changing the workload that makes its mutant observable, which is #1217's
// failure mode. Include a directly changed config as well, so authoring and re-aiming a fixture is
// re-proven at the same head. `some`, rather than a precomputed source index, keeps discovery and
// selection on the config object that mutation-proof will execute.
let selected = fixtures.filter(({ path, mutations }) => a.all || changed.has(path)
  || mutations.some((mutation) => typeof mutation?.file === "string" && changed.has(mutation.file)));
if (shard) selected = selected.filter(({ path }) => shardOf(path, Number(shard[2])) === Number(shard[1]));

console.log(`mutation reproof: ${selected.length} fixture(s) selected from ${fixtures.length}`
  + (a.all ? " for a full sweep" : ` after ${changed.size} changed path(s)`));
if (selected.length === 0) {
  console.log("No mutation fixtures to re-prove.");
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
