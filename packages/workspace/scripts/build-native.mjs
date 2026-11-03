#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { darwinTarget, nativeDir, nativeFile, root, sdk, sha256, sourceHashes, verifyNative } from "./native-contract.mjs";

const platform = process.platform;
if (platform !== "win32" && platform !== "darwin") process.exit(0);
const arch = process.arch;
const name = platform === "win32" ? "Windows creation identity" : "macOS process identity";
assert(arch === "x64" || arch === "arm64", `unsupported ${name} architecture: ${arch}`);
const dest = nativeDir(platform, arch);
if (existsSync(join(dest, nativeFile(platform))) || existsSync(join(dest, "build.json"))) {
  // A verified prebuilt needs no compiler. Stale or damaged artifacts are not silently rebuilt.
  verifyNative(platform, arch, dest);
  process.exit(0);
}
if (platform === "win32") assert(process.env.VCToolsVersion && process.env.WindowsSDKVersion && process.env.WindowsSdkDir, "build Windows identity in the matching MSVC Developer Command Prompt");
const temp = mkdtempSync(join(tmpdir(), `cotal-${platform}-native-`));
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
  // A macOS bundle resolves Node-API symbols from the loading node at runtime, so it needs no import library.
  await Promise.all([
    download(`node-v${sdk.version}-headers.tar.gz`, sdk.headers, headers),
    ...(platform === "win32" ? [download(`win-${arch}/node.lib`, sdk.libraries[arch], library)] : []),
  ]);
  execFileSync(platform === "win32" ? "tar.exe" : "tar", ["-xzf", headers, "-C", sdkDir], { stdio: "inherit" });
  const include = join(sdkDir, `node-v${sdk.version}`, "include/node");
  const output = join(buildDir, nativeFile(platform));
  if (platform === "win32") {
    // The system ID reader is C++/WinRT, whose headers ship in the Windows SDK off the default include path.
    const cppwinrt = join(process.env.WindowsSdkDir, "Include", process.env.WindowsSDKVersion, "cppwinrt");
    assert(existsSync(join(cppwinrt, "winrt", "base.h")), `C++/WinRT headers not found at ${cppwinrt}`);
    const compile = ["/nologo", "/c", "/O2", "/MT", "/W4", "/WX"];
    execFileSync("cl.exe", [...compile, "/std:c11", `/I${include}`, `/Fo${join(buildDir, "creation.obj")}`, join(root, "native/win32-process.c")], { cwd: buildDir, stdio: "inherit" });
    execFileSync("cl.exe", [...compile, "/std:c++20", "/EHsc", "/permissive-", "/external:anglebrackets", "/external:W0", `/I${cppwinrt}`,
      `/Fo${join(buildDir, "system-id.obj")}`, join(root, "native/win32-system-id.cpp")], { cwd: buildDir, stdio: "inherit" });
    execFileSync("link.exe", ["/nologo", "/DLL", "/Brepro", `/OUT:${output}`, join(buildDir, "creation.obj"), join(buildDir, "system-id.obj"),
      library, "kernel32.lib", "advapi32.lib", "windowsapp.lib"], { cwd: buildDir, stdio: "inherit" });
    if (process.argv.includes("--test-controls")) {
      const testDir = join(root, "build/test", `win32-${arch}`);
      mkdirSync(testDir, { recursive: true });
      execFileSync("cl.exe", ["/nologo", "/LD", "/O2", "/MT", "/W4", "/WX", "/std:c11",
        `/I${include}`, `/Fo${join(buildDir, "query-denied.obj")}`, join(root, "smoke/fixtures/win32-query-denied.c"),
        "/link", "/Brepro", `/OUT:${join(testDir, "query-denied.node")}`, library, "advapi32.lib"], { cwd: buildDir, stdio: "inherit" });
    }
  } else {
    // The node-gyp shape of a macOS addon: a bundle whose Node-API symbols resolve at load. On arm64 the
    // linker signs it ad hoc, as macOS requires of native code there.
    execFileSync("xcrun", ["clang", "-bundle", "-undefined", "dynamic_lookup", "-arch", arch === "x64" ? "x86_64" : "arm64",
      `-mmacosx-version-min=${darwinTarget}`, "-O2", "-std=c11", "-Wall", "-Wextra", "-Werror",
      `-I${include}`, "-o", output, join(root, "native/darwin-process.c")], { cwd: buildDir, stdio: "inherit" });
  }
  const bytes = readFileSync(output);
  const tool = (args) => execFileSync("xcrun", args, { encoding: "utf8" }).trim();
  const receipt = { version: 1, platform, arch, nodeApi: 8,
    source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    sourceHashes: sourceHashes(), nodeHeaders: sdk.version, headersSha256: sdk.headers,
    ...(platform === "win32"
      ? { librarySha256: sdk.libraries[arch], compiler: process.env.VCToolsVersion.trim(), windowsSdk: process.env.WindowsSDKVersion.trim() }
      : { compiler: tool(["clang", "--version"]).split("\n")[0], macosSdk: tool(["--show-sdk-version"]), deploymentTarget: darwinTarget }),
    sha256: sha256(bytes) };
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, nativeFile(platform)), bytes, { flag: "wx" });
  writeFileSync(join(dest, "build.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  verifyNative(platform, arch, dest);
  console.log(`${name} built and verified (${arch}, Node-API 8)`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
