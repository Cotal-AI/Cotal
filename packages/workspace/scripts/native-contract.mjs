import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));
export const sourceFiles = ["native/win32-process.c", "native/node-sdk.json", "scripts/build-native.mjs", "scripts/native-contract.mjs", "smoke/fixtures/win32-privilege-diagnostic.h"];
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const sourceHashes = () => Object.fromEntries(sourceFiles.map((path) => [path, sha256(readFileSync(join(root, path)))]));
export const sdk = JSON.parse(readFileSync(join(root, "native/node-sdk.json"), "utf8"));

/** Verify bytes and their native build receipt before reuse, assembly or publication. */
export function verifyNative(arch, dir = join(root, "build/Release", `win32-${arch}`), expectedSource) {
  assert(arch === "x64" || arch === "arm64", `unsupported Windows native architecture: ${arch}`);
  const bytes = readFileSync(join(dir, "creation.node"));
  assert(bytes.length >= 64 && bytes.toString("ascii", 0, 2) === "MZ", "Windows identity binding is not a PE binary");
  const offset = bytes.readUInt32LE(60);
  assert(offset + 24 <= bytes.length && bytes.toString("ascii", offset, offset + 4) === "PE\0\0", "invalid Windows identity PE header");
  assert.equal(bytes.readUInt16LE(offset + 4), arch === "x64" ? 0x8664 : 0xaa64, "Windows identity binding architecture mismatch");
  assert(bytes.readUInt16LE(offset + 22) & 0x2000, "Windows identity binding is not a DLL");
  const receipt = JSON.parse(readFileSync(join(dir, "build.json"), "utf8"));
  assert.equal(receipt.version, 1);
  assert.equal(receipt.platform, "win32");
  assert.equal(receipt.arch, arch);
  assert.equal(receipt.nodeApi, 8);
  assert.match(receipt.source, /^[a-f0-9]{40}$/);
  if (expectedSource !== undefined) assert.equal(receipt.source, expectedSource, "Windows identity native checkout provenance mismatch");
  assert.deepEqual(receipt.sourceHashes, sourceHashes(), "Windows identity native source provenance mismatch");
  assert.equal(receipt.nodeHeaders, sdk.version);
  assert.equal(typeof receipt.compiler, "string");
  assert(receipt.compiler.length > 0);
  assert.equal(typeof receipt.windowsSdk, "string");
  assert(receipt.windowsSdk.length > 0);
  assert.equal(receipt.headersSha256, sdk.headers);
  assert.equal(receipt.librarySha256, sdk.libraries[arch]);
  assert.equal(receipt.sha256, sha256(bytes), "Windows identity binary hash mismatch");
  return receipt;
}
