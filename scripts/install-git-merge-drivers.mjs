#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const git = (...args) => spawnSync("git", args, { encoding: "utf8" });
const inside = git("rev-parse", "--is-inside-work-tree");
if (inside.status !== 0 || inside.stdout.trim() !== "true") {
  console.log("git merge driver setup skipped (not a Git worktree)");
  process.exit(0);
}

const values = [
  ["merge.cotal-ci-suites.name", "Cotal CI suite tail-append merge"],
  ["merge.cotal-ci-suites.driver", "node scripts/merge-ci-suites.mjs %O %A %B %P"],
];
for (const [key, value] of values) {
  const result = git("config", "--local", key, value);
  if (result.status !== 0) {
    console.error(`could not configure ${key}: ${(result.stderr || result.stdout).trim()}`);
    process.exit(1);
  }
}
console.log("configured the ci-suites tail-append merge driver");
