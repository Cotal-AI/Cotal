import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));
export const sourceFiles = ["native/win32-process.c", "native/win32-system-id.cpp", "native/darwin-process.c", "native/node-sdk.json", "scripts/build-native.mjs", "scripts/native-contract.mjs"];
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const sourceHashes = () => Object.fromEntries(sourceFiles.map((path) => [path, sha256(readFileSync(join(root, path)))]));
export const sdk = JSON.parse(readFileSync(join(root, "native/node-sdk.json"), "utf8"));
/** The oldest macOS the binding loads on: Node 22's own macOS floor. */
export const darwinTarget = "11.0";
/** The binding file each platform ships, under `build/Release/<platform>-<arch>`. */
export const nativeFile = (platform) => (platform === "win32" ? "creation.node" : "process.node");
export const nativeDir = (platform, arch) => join(root, "build/Release", `${platform}-${arch}`);
const label = (platform) => (platform === "win32" ? "Windows identity" : "macOS process identity");

/** Verify bytes and their native build receipt before reuse, assembly or publication. */
export function verifyNative(platform, arch, dir = nativeDir(platform, arch), expectedSource) {
  assert(platform === "win32" || platform === "darwin", `unsupported native platform: ${platform}`);
  assert(arch === "x64" || arch === "arm64", `unsupported ${label(platform)} architecture: ${arch}`);
  const bytes = readFileSync(join(dir, nativeFile(platform)));
  if (platform === "win32") {
    assert(bytes.length >= 64 && bytes.toString("ascii", 0, 2) === "MZ", "Windows identity binding is not a PE binary");
    const offset = bytes.readUInt32LE(60);
    assert(offset + 24 <= bytes.length && bytes.toString("ascii", offset, offset + 4) === "PE\0\0", "invalid Windows identity PE header");
    assert.equal(bytes.readUInt16LE(offset + 4), arch === "x64" ? 0x8664 : 0xaa64, "Windows identity binding architecture mismatch");
    assert(bytes.readUInt16LE(offset + 22) & 0x2000, "Windows identity binding is not a DLL");
  } else {
    // mach_header_64: MH_MAGIC_64, then cputype (CPU_TYPE_X86_64 or CPU_TYPE_ARM64) and, at 12, filetype MH_BUNDLE.
    assert(bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf, "macOS process identity binding is not a 64-bit Mach-O binary");
    assert.equal(bytes.readUInt32LE(4), arch === "x64" ? 0x01000007 : 0x0100000c, "macOS process identity binding architecture mismatch");
    assert.equal(bytes.readUInt32LE(12), 8, "macOS process identity binding is not a loadable bundle");
  }
  const receipt = JSON.parse(readFileSync(join(dir, "build.json"), "utf8"));
  assert.equal(receipt.version, 1);
  assert.equal(receipt.platform, platform);
  assert.equal(receipt.arch, arch);
  assert.equal(receipt.nodeApi, 8);
  assert.match(receipt.source, /^[a-f0-9]{40}$/);
  if (expectedSource !== undefined) assert.equal(receipt.source, expectedSource, `${label(platform)} native checkout provenance mismatch`);
  assert.deepEqual(receipt.sourceHashes, sourceHashes(), `${label(platform)} native source provenance mismatch`);
  assert.equal(receipt.nodeHeaders, sdk.version);
  assert.equal(typeof receipt.compiler, "string");
  assert(receipt.compiler.length > 0);
  assert.equal(receipt.headersSha256, sdk.headers);
  if (platform === "win32") {
    assert.equal(typeof receipt.windowsSdk, "string");
    assert(receipt.windowsSdk.length > 0);
    assert.equal(receipt.librarySha256, sdk.libraries[arch]);
  } else {
    assert.equal(typeof receipt.macosSdk, "string");
    assert(receipt.macosSdk.length > 0);
    assert.equal(receipt.deploymentTarget, darwinTarget);
  }
  assert.equal(receipt.sha256, sha256(bytes), `${label(platform)} binary hash mismatch`);
  return receipt;
}
