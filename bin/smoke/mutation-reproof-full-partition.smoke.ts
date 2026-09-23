/**
 * Issue #1482: prove the committed mutation corpus is a complete, disjoint 12-way partition.
 *
 * This smoke is stack-free. It walks the same git-tracked corpus convention as the runner and calls
 * the runner's exported shard function rather than copying the hash into a detector.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mutationShard } from "../../scripts/mutation-shard.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHARD_COUNT = 12;
let passed = 0;
let failed = 0;

function check(name: string, ok: unknown, detail = ""): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}${detail ? `\n      ${detail}` : ""}`); }
}

const paths = execFileSync("git", ["ls-files", "*/mutations/*.json", "*.mutations.json"], {
  cwd: ROOT,
  encoding: "utf8",
}).split("\n").filter(Boolean);
const malformed: string[] = [];
for (const path of paths) {
  try {
    const config = JSON.parse(readFileSync(join(ROOT, path), "utf8"));
    if (!Array.isArray(config.mutations)) malformed.push(`${path}: no top-level mutations array`);
  } catch (error) {
    malformed.push(`${path}: ${(error as Error).message}`);
  }
}

const shards = Array.from({ length: SHARD_COUNT }, () => [] as string[]);
for (const path of paths) shards[mutationShard(path, SHARD_COUNT)]!.push(path);
const assigned = shards.flat();
const counts = shards.map((entries) => entries.length);

check("the tracked mutation corpus is non-empty and parseable", paths.length > 0 && malformed.length === 0,
  malformed.join("\n"));
check("every corpus fixture is assigned to exactly one of 12 shards",
  assigned.length === paths.length && new Set(assigned).size === paths.length
    && paths.every((path) => assigned.includes(path)),
  JSON.stringify({ corpus: paths.length, assigned: assigned.length, unique: new Set(assigned).size }));
check("the production shard function returns only configured shard indexes",
  paths.every((path) => {
    const shard = mutationShard(path, SHARD_COUNT);
    return Number.isInteger(shard) && shard >= 0 && shard < SHARD_COUNT;
  }));
check("all 12 full-sweep shards receive at least one fixture", counts.every((count) => count > 0),
  JSON.stringify(counts));

console.log(`\nmutation corpus partition: ${passed} passed, ${failed} failed (${paths.length} fixtures; shard counts ${counts.join(",")})`);
if (failed) process.exit(1);
