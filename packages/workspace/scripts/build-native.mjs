#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root, sdk, sha256, sourceHashes, verifyNative } from "./native-contract.mjs";

if (process.platform !== "win32") process.exit(0);
const arch = process.arch;
assert(arch === "x64" || arch === "arm64", `unsupported Windows native architecture: ${arch}`);
const dest = join(root, "build/Release", `win32-${arch}`);
if (existsSync(join(dest, "creation.node")) && existsSync(join(dest, "build.json"))) {
  // A verified prebuilt needs no compiler. Stale or damaged artifacts are not silently rebuilt.
  verifyNative(arch, dest);
  process.exit(0);
}
assert(process.env.VCToolsVersion && process.env.WindowsSDKVersion, "build Windows identity in the matching MSVC Developer Command Prompt");
const temp = mkdtempSync(join(tmpdir(), "cotal-win32-native-"));
try {
  const download = async (path, expected, output) => {
    const response = await fetch(`https://nodejs.org/dist/v${sdk.version}/${path}`, { signal: AbortSignal.timeout(60_000) });
    assert(response.ok, `Node SDK download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(sha256(bytes), expected, `Node SDK checksum mismatch: ${path}`);
    writeFileSync(output, bytes, { flag: "wx" });
  };
  const sdkDir = join(temp, "sdk");
  const buildDir = join(temp, "output");
  mkdirSync(sdkDir);
  mkdirSync(buildDir);
  const headers = join(sdkDir, "headers.tar.gz");
  const library = join(sdkDir, "node.lib");
  await Promise.all([
    download(`node-v${sdk.version}-headers.tar.gz`, sdk.headers, headers),
    download(`win-${arch}/node.lib`, sdk.libraries[arch], library),
  ]);
  execFileSync("tar.exe", ["-xzf", headers, "-C", sdkDir], { stdio: "inherit" });
  const include = join(sdkDir, `node-v${sdk.version}`, "include/node");
  const output = join(buildDir, "creation.node");
  execFileSync("cl.exe", ["/nologo", "/LD", "/O2", "/MT", "/W4", "/WX", "/std:c11",
    `/I${include}`, `/Fo${join(buildDir, "creation.obj")}`, join(root, "native/win32-process.c"),
    "/link", "/Brepro", `/OUT:${output}`, library, "kernel32.lib", "advapi32.lib"], { cwd: buildDir, stdio: "inherit" });
  const bytes = readFileSync(output);
  const receipt = { version: 1, platform: "win32", arch, nodeApi: 8,
    source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    sourceHashes: sourceHashes(), nodeHeaders: sdk.version, headersSha256: sdk.headers,
    librarySha256: sdk.libraries[arch], compiler: process.env.VCToolsVersion.trim(),
    windowsSdk: process.env.WindowsSDKVersion.trim(), sha256: sha256(bytes) };
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "creation.node"), bytes, { flag: "wx" });
  writeFileSync(join(dest, "build.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  verifyNative(arch, dest);
  console.log(`Windows creation identity built and verified (${arch}, Node-API 8)`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
