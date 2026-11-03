#!/usr/bin/env node
/**
 * Developer compile of the native helper for THIS host's platform and arch.
 *
 * Customer `npm i` does not run this. A publishable tree is assembled in CI
 * from native builder artifacts. This script never cross-compiles and never
 * skips an arch: it only builds the host.
 *
 * Linux and macOS compile native/peercred.c with the host `cc` against the
 * Node headers that ship next to this Node binary. Windows compiles
 * native/peercred_win32.c with the node-gyp that npm bundles next to node.exe,
 * in a temporary project, because a Windows addon links node.lib, which only
 * node-gyp fetches; nothing node-gyp writes lands in this package.
 *
 * `pnpm build` runs this without `--host` and compiles on Linux only, so a
 * macOS or Windows workspace build needs no C toolchain. `build:native` passes
 * `--host` and compiles for whichever of the three platforms runs it.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL(".", import.meta.url)));
const releaseRoot = join(root, "build", "Release");
mkdirSync(releaseRoot, { recursive: true });

const platform = process.platform;
const host = process.argv.includes("--host");
if (platform !== "linux" && !(host && (platform === "darwin" || platform === "win32"))) {
  process.exit(0);
}
const arch = process.arch;

function fail(lines, status = 1) {
  for (const line of lines) console.error(line);
  process.exit(status);
}

const stale = join(releaseRoot, "peercred.node");
if (existsSync(stale)) rmSync(stale);
const outDir = join(releaseRoot, `${platform}-${arch}`);

if (platform === "win32") buildWindows();
else buildPosix();

function buildPosix() {
  const src = join(root, "native", "peercred.c");
  const include = join(dirname(process.execPath), "..", "include", "node");
  if (!existsSync(join(include, "node_api.h"))) {
    fail([
      `@cotal-ai/seat: node_api.h not found at ${include} (from ${process.execPath}). A source build needs the Node headers that ship next to that binary.`,
    ]);
  }
  const check = platform === "linux" ? linuxTarget() : darwinTarget();
  console.error(
    platform === "linux"
      ? `@cotal-ai/seat: host dev build for linux-${arch}. This is not a publishable tree. Pack and publish require both linux-x64 (ELF e_machine 62) and linux-arm64 (ELF e_machine 183), assembled from native builder jobs.`
      : `@cotal-ai/seat: host dev build for darwin-${arch}. This is not a publishable tree.`,
  );
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, "peercred.node");
  const args =
    platform === "linux"
      ? ["-shared", "-fPIC", "-D_GNU_SOURCE", "-o", out, src, `-I${include}`]
      : ["-bundle", "-undefined", "dynamic_lookup", "-mmacosx-version-min=11.0", "-o", out, src, `-I${include}`, "-framework", "CoreFoundation"];
  const result = spawnSync("cc", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0 || result.error) {
    const detail = result.error
      ? result.error.message
      : `${result.stderr || result.stdout || `cc exited ${result.status ?? 1}`}`;
    fail(
      [
        `@cotal-ai/seat: failed to compile the ${check.what} helper for ${platform}-${arch}.`,
        `command: cc ${args.join(" ")}`,
        detail.trim() || "(no compiler diagnostic)",
        "A C compiler is required to BUILD this package from source. Published tarballs ship the prebuilt helpers and do not compile on install.",
      ],
      result.status ?? 1,
    );
  }
  check.verify(out);
}

function linuxTarget() {
  /** ELF e_machine: EM_X86_64=62, EM_AARCH64=183. */
  const ELF_MACHINE = { x64: 62, arm64: 183 };
  const expected = ELF_MACHINE[arch];
  if (expected === undefined) {
    fail([`@cotal-ai/seat: SO_PEERCRED native helper unsupported on linux-${arch} (supported: linux-x64, linux-arm64)`]);
  }
  return {
    what: "SO_PEERCRED",
    verify(out) {
      let machine;
      try {
        const buf = readFileSync(out);
        if (buf.length < 20 || buf[0] !== 0x7f || buf.subarray(1, 4).toString("ascii") !== "ELF") {
          throw new Error(`${out} is not an ELF file`);
        }
        machine = buf.readUInt16LE(18);
      } catch (err) {
        fail([`@cotal-ai/seat: ${err instanceof Error ? err.message : String(err)}`]);
      }
      if (machine !== expected) fail([`@cotal-ai/seat: linux-${arch} helper at ${out} has ELF e_machine ${machine}, expected ${expected}.`]);
    },
  };
}

function darwinTarget() {
  /** Mach-O cputype: CPU_TYPE_X86_64, CPU_TYPE_ARM64. */
  const MACHO_CPU = { x64: 0x01000007, arm64: 0x0100000c };
  const expected = MACHO_CPU[arch];
  if (expected === undefined) {
    fail([`@cotal-ai/seat: LOCAL_PEERCRED native helper unsupported on darwin-${arch} (supported: darwin-x64, darwin-arm64)`]);
  }
  return {
    what: "LOCAL_PEERCRED",
    verify(out) {
      const buf = readFileSync(out);
      if (buf.length < 8 || buf.readUInt32LE(0) !== 0xfeedfacf) fail([`@cotal-ai/seat: ${out} is not a 64-bit Mach-O file`]);
      const cpu = buf.readUInt32LE(4);
      if (cpu !== expected) fail([`@cotal-ai/seat: darwin-${arch} helper at ${out} has Mach-O cputype 0x${cpu.toString(16)}, expected 0x${expected.toString(16)}.`]);
    },
  };
}

function buildWindows() {
  /** PE machine: IMAGE_FILE_MACHINE_AMD64, IMAGE_FILE_MACHINE_ARM64. */
  const PE_MACHINE = { x64: 0x8664, arm64: 0xaa64 };
  const expected = PE_MACHINE[arch];
  if (expected === undefined) {
    fail([`@cotal-ai/seat: named-pipe native helper unsupported on win32-${arch} (supported: win32-x64, win32-arm64)`]);
  }
  const gyp = join(dirname(process.execPath), "node_modules", "npm", "node_modules", "node-gyp", "bin", "node-gyp.js");
  if (!existsSync(gyp)) {
    fail([`@cotal-ai/seat: node-gyp not found at ${gyp} (from ${process.execPath}). A Windows source build uses the node-gyp that npm installs next to node.exe.`]);
  }
  console.error(`@cotal-ai/seat: host dev build for win32-${arch}. This is not a publishable tree.`);
  const work = mkdtempSync(join(tmpdir(), "cotal-seat-native-"));
  try {
    copyFileSync(join(root, "native", "peercred_win32.c"), join(work, "peercred_win32.c"));
    writeFileSync(
      join(work, "binding.gyp"),
      JSON.stringify({ targets: [{ target_name: "peercred", sources: ["peercred_win32.c"], libraries: ["advapi32.lib"] }] }),
    );
    const result = spawnSync(process.execPath, [gyp, "rebuild", `--arch=${arch}`], { cwd: work, encoding: "utf8" });
    if (result.status !== 0 || result.error) {
      const detail = result.error ? result.error.message : `${result.stderr || result.stdout || `node-gyp exited ${result.status ?? 1}`}`;
      fail(
        [
          `@cotal-ai/seat: failed to compile the named-pipe helper for win32-${arch}.`,
          `command: ${process.execPath} ${gyp} rebuild --arch=${arch}`,
          detail.trim() || "(no compiler diagnostic)",
          "Visual Studio C++ build tools are required to BUILD this package from source on Windows. Published tarballs ship the prebuilt helpers and do not compile on install.",
        ],
        result.status ?? 1,
      );
    }
    const built = join(work, "build", "Release", "peercred.node");
    const buf = readFileSync(built);
    const pe = buf.length >= 0x40 ? buf.readUInt32LE(0x3c) : 0;
    if (buf.subarray(0, 2).toString("ascii") !== "MZ" || buf.length < pe + 6 || buf.subarray(pe, pe + 4).toString("latin1") !== "PE\0\0") {
      fail([`@cotal-ai/seat: ${built} is not a PE file`]);
    }
    const machine = buf.readUInt16LE(pe + 4);
    if (machine !== expected) fail([`@cotal-ai/seat: win32-${arch} helper has PE machine 0x${machine.toString(16)}, expected 0x${expected.toString(16)}.`]);
    mkdirSync(outDir, { recursive: true });
    copyFileSync(built, join(outDir, "peercred.node"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
