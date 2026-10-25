#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { root, sha256, sourceFiles, verifyNative } from "../packages/workspace/scripts/native-contract.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const source = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const inputs = [["x64", process.env.WORKSPACE_NATIVE_X64], ["arm64", process.env.WORKSPACE_NATIVE_ARM64]];
const receipts = new Map();
for (const [arch, dir] of inputs) {
  assert(dir, `WORKSPACE_NATIVE_${arch.toUpperCase()} must name the native builder artifact directory`);
  const receipt = verifyNative("win32", arch, dir, source);
  for (const path of sourceFiles) {
    const committed = execFileSync("git", ["show", `${source}:packages/workspace/${path}`], { cwd: repo });
    assert.equal(receipt.sourceHashes[path], sha256(committed), "Windows identity native input differs from the committed source");
  }
  receipts.set(arch, receipt);
}
for (const [arch, dir] of inputs) {
  const dest = join(root, "build/Release", `win32-${arch}`);
  if (existsSync(dest)) {
    const current = verifyNative("win32", arch, dest, source);
    assert.deepEqual(current, receipts.get(arch), "refusing to overwrite an existing Windows identity build");
    continue;
  }
  mkdirSync(dest, { recursive: true });
  for (const file of ["creation.node", "build.json"]) {
    assert(!existsSync(join(dest, file)), "refusing to overwrite a Windows identity artifact");
    copyFileSync(join(dir, file), join(dest, file));
  }
  assert.equal(sha256(readFileSync(join(dest, "creation.node"))), receipts.get(arch).sha256);
  verifyNative("win32", arch, dest, source);
}
console.log("Windows creation identity: both source-matched native builds assembled");
