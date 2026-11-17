#!/usr/bin/env node
/**
 * Pack and publish gate, hooked as `prepack` (and again as `prepublishOnly`).
 * `prepack` runs for `pnpm pack` and `pnpm publish`. `prepare` is not used:
 * it would also fire on install-from-git. This script refuses a tree that
 * would ship one Linux arch. It does not compile. A host `pnpm build` is a
 * one-arch dev build and is not enough.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL(".", import.meta.url)));
export const SHIPPED_LINUX_NATIVES = [
  { arch: "x64", elfMachine: 62 },
  { arch: "arm64", elfMachine: 183 },
];

export function elfMachine(path) {
  const buf = readFileSync(path);
  if (buf.length < 20 || buf[0] !== 0x7f || buf.subarray(1, 4).toString("ascii") !== "ELF") {
    throw new Error(`${path} is not an ELF file`);
  }
  return buf.readUInt16LE(18);
}

export const SHIPPED_HOST_NATIVES = [
  { platform: "darwin", arch: "x64", machine: 0x01000007 },
  { platform: "darwin", arch: "arm64", machine: 0x0100000c },
  { platform: "win32", arch: "x64", machine: 0x8664 },
  { platform: "win32", arch: "arm64", machine: 0xaa64 },
];

/** Check the host addon's native container and architecture before it enters the package. */
export function hostMachine(path, platform) {
  const buf = readFileSync(path);
  if (platform === "darwin") {
    if (buf.length < 32 || buf.readUInt32LE(0) !== 0xfeedfacf || buf.readUInt32LE(12) !== 8) throw new Error(`${path} is not a 64-bit Mach-O bundle`);
    return buf.readUInt32LE(4);
  }
  if (platform !== "win32" || buf.length < 64 || buf.toString("ascii", 0, 2) !== "MZ") throw new Error(`${path} is not a PE binary`);
  const offset = buf.readUInt32LE(60);
  if (offset + 24 > buf.length || buf.toString("ascii", offset, offset + 4) !== "PE\0\0" || !(buf.readUInt16LE(offset + 22) & 0x2000)) throw new Error(`${path} is not a PE DLL`);
  return buf.readUInt16LE(offset + 4);
}

export function shippedNativePath(pkgRoot, arch) {
  return join(pkgRoot, "build", "Release", `linux-${arch}`, "peercred.node");
}

export function assertShippedNatives(pkgRoot = root) {
  const missing = [];
  const wrong = [];
  for (const target of SHIPPED_LINUX_NATIVES) {
    const path = shippedNativePath(pkgRoot, target.arch);
    if (!existsSync(path)) {
      missing.push(path);
      continue;
    }
    let machine;
    try {
      machine = elfMachine(path);
    } catch (err) {
      wrong.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (machine !== target.elfMachine) {
      wrong.push(
        `${path}: ELF e_machine ${machine}, expected ${target.elfMachine} for linux-${target.arch}`,
      );
    }
  }
  for (const target of SHIPPED_HOST_NATIVES) {
    const path = join(pkgRoot, "build", "Release", `${target.platform}-${target.arch}`, "peercred.node");
    if (!existsSync(path)) { missing.push(path); continue; }
    try {
      if (hostMachine(path, target.platform) !== target.machine) wrong.push(`${path}: native architecture does not match ${target.platform}-${target.arch}`);
    } catch (error) { wrong.push(error instanceof Error ? error.message : String(error)); }
  }
  if (missing.length === 0 && wrong.length === 0) return;
  for (const path of missing) {
    console.error(`@cotal-ai/seat: host native helper missing at ${path}`);
  }
  for (const line of wrong) console.error(`@cotal-ai/seat: ${line}`);
  console.error(
    `@cotal-ai/seat: linux-arm64 helper was not assembled into the publish tree. Native Linux, macOS and Windows x64 and arm64 builder artifacts must be copied here before pack or publish. A host \`pnpm build\` is a one-arch dev build and cannot be published.`,
  );
  process.exit(1);
}

const invoked = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const pkgRoot = process.argv[2];
  if (pkgRoot !== undefined && pkgRoot.trim() === "") {
    console.error("@cotal-ai/seat: package-root argument is empty");
    process.exit(1);
  }
  assertShippedNatives(pkgRoot);
}
