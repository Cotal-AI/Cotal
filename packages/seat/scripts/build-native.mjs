#!/usr/bin/env node
/**
 * Developer compile of the Linux SO_PEERCRED helper for THIS host arch.
 *
 * Customer `npm i` does not run this. A publishable tree is assembled in CI
 * from native linux-x64 and linux-arm64 builder artifacts. This script never
 * cross-compiles and never skips an arch: it only builds the host.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL(".", import.meta.url)));
const releaseRoot = join(root, "build", "Release");
mkdirSync(releaseRoot, { recursive: true });

if (process.platform !== "linux") {
  process.exit(0);
}

const src = join(root, "native", "peercred.c");
const include = join(dirname(process.execPath), "..", "include", "node");
if (!existsSync(join(include, "node_api.h"))) {
  console.error(
    `@cotal-ai/seat: node_api.h not found at ${include} (from ${process.execPath}). A source build needs the Node headers that ship next to that binary.`,
  );
  process.exit(1);
}

/** ELF e_machine: EM_X86_64=62, EM_AARCH64=183. */
const ELF_MACHINE = { x64: 62, arm64: 183 };
const arch = process.arch;
const expectedMachine = ELF_MACHINE[arch];
if (expectedMachine === undefined) {
  console.error(
    `@cotal-ai/seat: SO_PEERCRED native helper unsupported on linux-${arch} (supported: linux-x64, linux-arm64)`,
  );
  process.exit(1);
}

console.error(
  `@cotal-ai/seat: host dev build for linux-${arch}. This is not a publishable tree. Pack and publish require both linux-x64 (ELF e_machine 62) and linux-arm64 (ELF e_machine 183), assembled from native builder jobs.`,
);

const stale = join(releaseRoot, "peercred.node");
if (existsSync(stale)) rmSync(stale);

function elfMachine(path) {
  const buf = readFileSync(path);
  if (buf.length < 20 || buf[0] !== 0x7f || buf.subarray(1, 4).toString("ascii") !== "ELF") {
    throw new Error(`${path} is not an ELF file`);
  }
  return buf.readUInt16LE(18);
}

const outDir = join(releaseRoot, `linux-${arch}`);
mkdirSync(outDir, { recursive: true });
const out = join(outDir, "peercred.node");
const args = ["-shared", "-fPIC", "-D_GNU_SOURCE", "-o", out, src, `-I${include}`];
const result = spawnSync("cc", args, { cwd: root, encoding: "utf8" });
if (result.status !== 0 || result.error) {
  const detail = result.error
    ? result.error.message
    : `${result.stderr || result.stdout || `cc exited ${result.status ?? 1}`}`;
  console.error(`@cotal-ai/seat: failed to compile the SO_PEERCRED helper for linux-${arch}.`);
  console.error(`command: cc ${args.join(" ")}`);
  console.error(detail.trim() || "(no compiler diagnostic)");
  console.error(
    "A C compiler is required to BUILD this package from source. Published tarballs ship the prebuilt helpers and do not compile on install.",
  );
  process.exit(result.status ?? 1);
}
let machine;
try {
  machine = elfMachine(out);
} catch (err) {
  console.error(`@cotal-ai/seat: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
if (machine !== expectedMachine) {
  console.error(
    `@cotal-ai/seat: linux-${arch} helper at ${out} has ELF e_machine ${machine}, expected ${expectedMachine}.`,
  );
  process.exit(1);
}
