#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeDir, nativeFile, sha256, sourceFiles, verifyNative } from "../packages/workspace/scripts/native-contract.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
// The commit the native builders checked out. The release pack assembles natives built from the pushed
// commit into the version PR head, whose only change is versioning, so it names that commit here.
const source = process.env.NATIVE_SOURCE ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const inputs = [
  ["win32", "x64", "WORKSPACE_NATIVE_X64"], ["win32", "arm64", "WORKSPACE_NATIVE_ARM64"],
  ["darwin", "x64", "WORKSPACE_NATIVE_DARWIN_X64"], ["darwin", "arm64", "WORKSPACE_NATIVE_DARWIN_ARM64"],
].map(([platform, arch, variable]) => ({ platform, arch, variable, dir: process.env[variable] }));
const receipts = new Map();
for (const { platform, arch, variable, dir } of inputs) {
  assert(dir, `${variable} must name the native builder artifact directory`);
  const receipt = verifyNative(platform, arch, dir, source);
  for (const path of sourceFiles) {
    const committed = execFileSync("git", ["show", `${source}:packages/workspace/${path}`], { cwd: repo });
    assert.equal(receipt.sourceHashes[path], sha256(committed), "native identity input differs from the committed source");
  }
  receipts.set(`${platform}-${arch}`, receipt);
}
for (const { platform, arch, dir } of inputs) {
  const dest = nativeDir(platform, arch);
  if (existsSync(dest)) {
    const current = verifyNative(platform, arch, dest, source);
    assert.deepEqual(current, receipts.get(`${platform}-${arch}`), `refusing to overwrite an existing ${platform}-${arch} identity build`);
    continue;
  }
  mkdirSync(dest, { recursive: true });
  for (const file of [nativeFile(platform), "build.json"]) {
    assert(!existsSync(join(dest, file)), `refusing to overwrite a ${platform}-${arch} identity artifact`);
    copyFileSync(join(dir, file), join(dest, file));
  }
  assert.equal(sha256(readFileSync(join(dest, nativeFile(platform)))), receipts.get(`${platform}-${arch}`).sha256);
  verifyNative(platform, arch, dest, source);
}
console.log("Native process identity: Windows and macOS, x64 and arm64, source-matched builds assembled");
