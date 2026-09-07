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
  if (missing.length === 0 && wrong.length === 0) return;
  for (const path of missing) {
    console.error(`@cotal-ai/seat: SO_PEERCRED native helper missing at ${path}`);
  }
  for (const line of wrong) console.error(`@cotal-ai/seat: ${line}`);
  console.error(
    `@cotal-ai/seat: linux-arm64 helper was not assembled into the publish tree. Native linux-x64 and linux-arm64 builder artifacts must be copied here before pack or publish. A host \`pnpm build\` is a one-arch dev build and cannot be published.`,
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
