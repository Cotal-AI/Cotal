/**
 * Platform loud-fail for custody transport. Linux is the production transport.
 * Other platforms must throw the named error and print a completion banner.
 * No top-of-file skip. References #1297.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { unsupportedTransport } from "../src/protocol.js";
import { nativeHelperPath, unsupportedNativeArch } from "../src/peercred.js";

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
    return;
  }
  fail++;
  console.log(`  ✗ FAIL: ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
};
const childEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  return env;
};

// Header fixtures exercise packaging validation only; they are never loaded or published.
const writeHostFixtures = (root: string): string[] => {
  const args: string[] = [];
  for (const platform of ["darwin", "win32"]) for (const arch of ["x64", "arm64"]) {
    const path = join(root, "build", "Release", `${platform}-${arch}`, "peercred.node");
    mkdirSync(dirname(path), { recursive: true });
    const buf = Buffer.alloc(platform === "darwin" ? 32 : 88);
    if (platform === "darwin") {
      buf.writeUInt32LE(0xfeedfacf, 0);
      buf.writeUInt32LE(arch === "x64" ? 0x01000007 : 0x0100000c, 4);
      buf.writeUInt32LE(8, 12);
    } else {
      buf.write("MZ");
      buf.writeUInt32LE(64, 60);
      buf.write("PE\0\0", 64);
      buf.writeUInt16LE(arch === "x64" ? 0x8664 : 0xaa64, 68);
      buf.writeUInt16LE(0x2000, 86);
    }
    writeFileSync(path, buf);
    args.push(`--${platform}-${arch}`, path);
  }
  return args;
};
const outputInventory = (root: string): string => {
  const files: Array<[string, string]> = [];
  const visit = (path: string, relative: string): void => {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = join(relative, entry.name);
      if (entry.isDirectory()) visit(join(path, entry.name), name);
      else files.push([name, createHash("sha256").update(readFileSync(join(path, entry.name))).digest("hex")]);
    }
  };
  for (const name of ["dist", "build"]) visit(join(root, name), name);
  return JSON.stringify(files);
};

const err = unsupportedTransport("darwin");
check(
  "darwin throws custody transport unsupported on darwin",
  err instanceof Error && err.message === "custody transport unsupported on darwin",
  err.message,
);
const win = unsupportedTransport("win32");
check(
  "win32 throws custody transport unsupported on win32",
  win instanceof Error && win.message === "custody transport unsupported on win32",
  win.message,
);
const linux = unsupportedTransport("linux");
check(
  "named error is still formed for linux so the helper never silently no-ops",
  linux.message === "custody transport unsupported on linux",
);

if (process.platform !== "linux") {
  const { launchSeat } = await import("../src/launcher.js");
  let threw = "";
  try {
    launchSeat({
      root: "/tmp/cotal-seat-should-not-exist",
      name: "nope",
      spec: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      cwd: process.cwd(),
    });
  } catch (e) {
    threw = (e as Error).message;
  }
  check(
    `launchSeat throws custody transport unsupported on ${process.platform}`,
    threw === `custody transport unsupported on ${process.platform}`,
    threw,
  );
}

{
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = join(here, "..");
  const manifest = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
    scripts?: { install?: string; prepack?: string; prepare?: string; prepublishOnly?: string; "build:ts"?: string };
    files?: string[];
  };
  check("customer install does not compile: package.json has no install script", manifest.scripts?.install === undefined, manifest.scripts);
  check(
    "prepack asserts shipped natives and compiles TypeScript only",
    manifest.scripts?.prepack === "node scripts/assert-shipped-natives.mjs && pnpm run build:ts",
    manifest.scripts,
  );
  check(
    "prepublishOnly asserts shipped natives and compiles TypeScript only",
    manifest.scripts?.prepublishOnly === "node scripts/assert-shipped-natives.mjs && pnpm run build:ts",
    manifest.scripts,
  );
  check("the TypeScript-only build does not rebuild natives", manifest.scripts?.["build:ts"] === "tsc -p tsconfig.json", manifest.scripts);
  check(
    "prepare is absent so install-from-git is not gated",
    manifest.scripts?.prepare === undefined,
    manifest.scripts,
  );
  check(
    "no binding.gyp so npm/pnpm will not infer node-gyp rebuild on install",
    !existsSync(join(pkgRoot, "binding.gyp")),
  );
  check(
    "published files list is the prebuilt output, not the compiler sources",
    JSON.stringify(manifest.files) === JSON.stringify(["dist", "build"]),
    manifest.files,
  );

  if (process.platform !== "linux") {
    const compile = spawnSync(process.execPath, [join(pkgRoot, "scripts", "build-native.mjs")], {
      cwd: pkgRoot,
      encoding: "utf8",
    });
    check(
      "source compile is a no-op off linux so Windows build does not need headers or a C compiler",
      compile.status === 0,
      { status: compile.status, stdout: compile.stdout, stderr: compile.stderr },
    );
  }

  if (process.platform === "linux") {
  {
    const blocked = mkdtempSync(join(tmpdir(), "cotal-seat-ncc-"));
    try {
      const bin = join(blocked, "bin");
      mkdirSync(bin);
      for (const name of ["cc", "gcc", "g++", "c++", "make", "node-gyp"]) {
        writeFileSync(join(bin, name), "#!/bin/sh\nexit 1\n");
        chmodSync(join(bin, name), 0o755);
      }
      const helper = nativeHelperPath();
      const saved = existsSync(helper) ? join(blocked, "peercred.node") : undefined;
      if (saved) copyFileSync(helper, saved);
      const compile = spawnSync(process.execPath, [join(pkgRoot, "scripts", "build-native.mjs")], {
        cwd: pkgRoot,
        encoding: "utf8",
        env: childEnv({ PATH: `${bin}:${process.env.PATH ?? ""}` }),
      });
      if (saved) copyFileSync(saved, helper);
      check(
        "source compile without a C compiler fails with a diagnostic",
        compile.status !== 0 && /failed to compile the SO_PEERCRED helper/.test(`${compile.stdout}\n${compile.stderr}`),
        { status: compile.status, stdout: compile.stdout, stderr: compile.stderr },
      );
    } finally {
      rmSync(blocked, { recursive: true, force: true });
    }
  }

  {
    const reloc = mkdtempSync(join(tmpdir(), "cotal-seat-reloc-"));
    try {
      const bin = join(reloc, "bin");
      const includeDir = join(reloc, "include", "node");
      const ccDir = join(reloc, "cc");
      mkdirSync(bin);
      mkdirSync(includeDir, { recursive: true });
      mkdirSync(ccDir);
      copyFileSync(process.execPath, join(bin, "node"));
      writeFileSync(join(includeDir, "node_api.h"), "");
      const argvLog = join(reloc, "cc-argv.txt");
      writeFileSync(
        join(ccDir, "cc"),
        `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argvLog)}\nexit 0\n`,
      );
      chmodSync(join(ccDir, "cc"), 0o755);
      const helper = nativeHelperPath();
      const saved = existsSync(helper) ? join(reloc, "peercred.node") : undefined;
      if (saved) copyFileSync(helper, saved);
      const compile = spawnSync(join(bin, "node"), [join(pkgRoot, "scripts", "build-native.mjs")], {
        cwd: pkgRoot,
        encoding: "utf8",
        env: childEnv({ PATH: `${ccDir}:${process.env.PATH ?? ""}` }),
      });
      if (saved) copyFileSync(saved, helper);
      const argv = existsSync(argvLog) ? readFileSync(argvLog, "utf8") : "";
      const expectedInclude = join(dirname(realpathSync(join(bin, "node"))), "..", "include", "node");
      check("relocated-node source compile invoked cc", existsSync(argvLog), {
        status: compile.status,
        stdout: compile.stdout,
        stderr: compile.stderr,
      });
      check(
        "source compile uses the running Node include dir, not /usr/include/node",
        argv.split("\n").includes(`-I${expectedInclude}`) && !argv.includes("-I/usr/include/node"),
        argv,
      );
    } finally {
      rmSync(reloc, { recursive: true, force: true });
    }
  }

  {
    const unsupported = unsupportedNativeArch("linux", "riscv64");
    check(
      "unsupported linux arch is loud",
      unsupported.message ===
        "@cotal-ai/seat: SO_PEERCRED native helper unsupported on linux-riscv64 (supported: linux-x64, linux-arm64)",
      unsupported.message,
    );
    check(
      "loader selects the host arch helper",
      nativeHelperPath().replaceAll("\\", "/").endsWith(`/linux-${process.arch}/peercred.node`),
      nativeHelperPath(),
    );
    check(
      "host linux helper is keyed, not unkeyed Release/peercred.node",
      existsSync(nativeHelperPath()) && !existsSync(join(pkgRoot, "build", "Release", "peercred.node")),
    );
  }

  {
    const tree = mkdtempSync(join(tmpdir(), "cotal-seat-assert-"));
    const writeElf = (arch: string, machine: number): string => {
      const path = join(tree, "build", "Release", `linux-${arch}`, "peercred.node");
      mkdirSync(dirname(path), { recursive: true });
      const buf = Buffer.alloc(20);
      buf[0] = 0x7f;
      buf.write("ELF", 1);
      buf.writeUInt16LE(machine, 18);
      writeFileSync(path, buf);
      return path;
    };
    try {
      writeElf("x64", 62);
      const oneArch = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { assertShippedNatives } from ${JSON.stringify(join(pkgRoot, "scripts", "assert-shipped-natives.mjs"))}; assertShippedNatives(process.argv[1]);`,
          tree,
        ],
        { encoding: "utf8" },
      );
      check(
        "one-arch tree is refused before pack",
        oneArch.status === 1 &&
          /linux-arm64 helper was not assembled into the publish tree/.test(`${oneArch.stdout}\n${oneArch.stderr}`),
        { status: oneArch.status, stdout: oneArch.stdout, stderr: oneArch.stderr },
      );
      writeElf("arm64", 183);
      writeHostFixtures(tree);
      const both = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { assertShippedNatives } from ${JSON.stringify(join(pkgRoot, "scripts", "assert-shipped-natives.mjs"))}; assertShippedNatives(process.argv[1]);`,
          tree,
        ],
        { encoding: "utf8" },
      );
      check("assembled Linux, macOS and Windows helpers are packable", both.status === 0, {
        status: both.status,
        stdout: both.stdout,
        stderr: both.stderr,
      });
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  const sourcePkgRoot = pkgRoot;
  const originalOutputs = outputInventory(sourcePkgRoot);
  const cloneRoot = mkdtempSync(join(tmpdir(), "cotal-seat-platform-"));
  try {
  const repo = join(sourcePkgRoot, "..", "..");
  const pkgRoot = join(cloneRoot, "packages", "seat");
  cpSync(sourcePkgRoot, pkgRoot, {
    recursive: true,
    filter: (source) => !source.split(sep).includes("node_modules"),
  });
  // Reuse the installed toolchain, as the installed-distribution smoke does. Only the copy is packed.
  for (const name of ["package.json", "pnpm-workspace.yaml", "tsconfig.base.json"]) copyFileSync(join(repo, name), join(cloneRoot, name));
  symlinkSync(join(repo, "node_modules"), join(cloneRoot, "node_modules"), "dir");
  symlinkSync(join(sourcePkgRoot, "node_modules"), join(pkgRoot, "node_modules"), "dir");
  mkdirSync(join(cloneRoot, "scripts"));
  copyFileSync(join(repo, "scripts", "seat-assemble-natives.mjs"), join(cloneRoot, "scripts", "seat-assemble-natives.mjs"));
  {
    const sources = mkdtempSync(join(tmpdir(), "cotal-seat-asm-src-"));
    const saved: Array<{ dest: string; backup?: string }> = [];
    const writeElf = (arch: string, machine: number): string => {
      const path = join(sources, `peercred-${arch}.node`);
      const buf = Buffer.alloc(20);
      buf[0] = 0x7f;
      buf.write("ELF", 1);
      buf.writeUInt16LE(machine, 18);
      writeFileSync(path, buf);
      return path;
    };
    try {
      for (const arch of ["x64", "arm64"]) {
        const dest = join(pkgRoot, "build", "Release", `linux-${arch}`, "peercred.node");
        const backup = existsSync(dest) ? join(sources, `saved-${arch}.node`) : undefined;
        if (backup) copyFileSync(dest, backup);
        saved.push({ dest, backup });
      }
      const x64 = writeElf("x64", 62);
      const arm64 = writeElf("arm64", 183);
      const assembled = spawnSync(
        process.execPath,
        [join(pkgRoot, "..", "..", "scripts", "seat-assemble-natives.mjs"), "--x64", x64, "--arm64", arm64, ...writeHostFixtures(sources)],
        { encoding: "utf8" },
      );
      const destArm = join(pkgRoot, "build", "Release", "linux-arm64", "peercred.node");
      const destX64 = join(pkgRoot, "build", "Release", "linux-x64", "peercred.node");
      check(
        "assemble copies both native builder artifacts",
        assembled.status === 0 && existsSync(destX64) && existsSync(destArm),
        { status: assembled.status, stdout: assembled.stdout, stderr: assembled.stderr },
      );
    } finally {
      for (const { dest, backup } of saved) {
        if (backup) copyFileSync(backup, dest);
        else if (existsSync(dest)) rmSync(dest);
      }
      rmSync(sources, { recursive: true, force: true });
    }
  }

  const packDir = mkdtempSync(join(tmpdir(), "cotal-seat-pack-"));
  const packState = mkdtempSync(join(tmpdir(), "cotal-seat-pack-state-"));
  const savedPack: Array<{ dest: string; backup?: string }> = [];
  try {
    for (const arch of ["x64", "arm64"]) {
      const dest = join(pkgRoot, "build", "Release", `linux-${arch}`, "peercred.node");
      const backup = existsSync(dest) ? join(packState, `saved-${arch}.node`) : undefined;
      if (backup) copyFileSync(dest, backup);
      savedPack.push({ dest, backup });
    }
    const otherArch = process.arch === "x64" ? "arm64" : "x64";
    const otherDest = join(pkgRoot, "build", "Release", `linux-${otherArch}`, "peercred.node");
    if (existsSync(otherDest)) rmSync(otherDest);

    // Inspect a host-only tree without running prepack.
    const packed = spawnSync("pnpm", ["--config.ignore-scripts=true", "pack", "--pack-destination", packDir], {
      cwd: pkgRoot,
      encoding: "utf8",
    });
    const tarball = readdirSync(packDir).find((name) => name.endsWith(".tgz"));
    check("pnpm pack wrote a tarball", packed.status === 0 && tarball !== undefined, {
      status: packed.status,
      stderr: packed.stderr,
      files: readdirSync(packDir),
    });
    if (tarball) {
      const listing = spawnSync("tar", ["-tzf", join(packDir, tarball)], { encoding: "utf8" });
      const files = listing.stdout.split("\n").filter(Boolean);
      check(
        "a host-only pack does not ship the other linux arch or an unkeyed helper",
        files.includes(`package/build/Release/linux-${process.arch}/peercred.node`) &&
          !files.includes(`package/build/Release/linux-${otherArch}/peercred.node`) &&
          !files.includes("package/build/Release/peercred.node"),
        files.filter((f) => f.includes("peercred") || f.includes("build/")),
      );
      check(
        "the tarball does not ship compiler sources",
        !files.some((f) => f === "package/native/peercred.c" || f === "package/binding.gyp" || f === "package/scripts/build-native.mjs"),
        files.filter((f) => f.includes("native") || f.includes("binding") || f.includes("build-native")),
      );
    }

    rmSync(join(pkgRoot, "dist"), { recursive: true, force: true });
    const refuseDir = mkdtempSync(join(tmpdir(), "cotal-seat-pack-gated-"));
    const gated = spawnSync("pnpm", ["pack", "--pack-destination", refuseDir], { cwd: pkgRoot, encoding: "utf8" });
    check(
      "host-only pnpm pack is refused by prepack",
      gated.status !== 0,
      { status: gated.status, stdout: gated.stdout, stderr: gated.stderr },
    );
    check("refused pack preserves the caller's compiled output and native helpers", outputInventory(sourcePkgRoot) === originalOutputs);
    rmSync(refuseDir, { recursive: true, force: true });

    const writePackedElf = (arch: string, machine: number): string => {
      const path = join(packState, `peercred-${arch}.node`);
      const buf = Buffer.alloc(20);
      buf[0] = 0x7f;
      buf.write("ELF", 1);
      buf.writeUInt16LE(machine, 18);
      writeFileSync(path, buf);
      return path;
    };
    const assembled = spawnSync(
      process.execPath,
      [join(pkgRoot, "..", "..", "scripts", "seat-assemble-natives.mjs"), "--x64", writePackedElf("x64", 62), "--arm64", writePackedElf("arm64", 183), ...writeHostFixtures(packState)],
      { encoding: "utf8" },
    );
    check(
      "pack proof assembled both native builder artifacts",
      assembled.status === 0 &&
        existsSync(join(pkgRoot, "build", "Release", "linux-x64", "peercred.node")) &&
        existsSync(join(pkgRoot, "build", "Release", "linux-arm64", "peercred.node")),
      { status: assembled.status, stdout: assembled.stdout, stderr: assembled.stderr },
    );
    check("assembled package inventory starts with no dist directory", !existsSync(join(pkgRoot, "dist")));
    const succeedDir = mkdtempSync(join(tmpdir(), "cotal-seat-pack-assembled-"));
    const assembledPack = spawnSync("pnpm", ["pack", "--pack-destination", succeedDir], { cwd: pkgRoot, encoding: "utf8" });
    check(
      "assembled tree packs with scripts",
      assembledPack.status === 0,
      { status: assembledPack.status, stdout: assembledPack.stdout, stderr: assembledPack.stderr },
    );
    const assembledTarball = readdirSync(succeedDir).find((name) => name.endsWith(".tgz"));
    if (assembledTarball) {
      const listing = spawnSync("tar", ["-tzf", join(succeedDir, assembledTarball)], { encoding: "utf8" });
      const files = listing.stdout.split("\n").filter(Boolean);
      check(
        "the tarball ships keyed linux-x64 and linux-arm64 helpers",
        files.includes("package/build/Release/linux-x64/peercred.node") &&
          files.includes("package/build/Release/linux-arm64/peercred.node") &&
          !files.includes("package/build/Release/peercred.node"),
        files.filter((f) => f.includes("peercred") || f.includes("build/")),
      );
      check("the tarball ships all six platform and architecture helpers", ["linux", "darwin", "win32"].every((platform) =>
        ["x64", "arm64"].every((arch) => files.includes(`package/build/Release/${platform}-${arch}/peercred.node`))), files);
      check("the tarball ships dist/index.js compiled by prepack", files.includes("package/dist/index.js"), files);
      check("the tarball ships dist/index.d.ts compiled by prepack", files.includes("package/dist/index.d.ts"), files);
    }
    rmSync(succeedDir, { recursive: true, force: true });
  } finally {
    for (const { dest, backup } of savedPack) {
      if (backup) {
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(backup, dest);
      } else if (existsSync(dest)) {
        rmSync(dest);
        try {
          rmSync(dirname(dest));
        } catch {
          /* directory still holds other files */
        }
      }
    }
    rmSync(packDir, { recursive: true, force: true });
    rmSync(packState, { recursive: true, force: true });
  }
  } finally {
    rmSync(cloneRoot, { recursive: true, force: true });
    check("assembly and pack leave the caller's compiled output and native helpers unchanged", outputInventory(sourcePkgRoot) === originalOutputs);
  }
  }
}

console.log(`\nSEAT PLATFORM ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
if (process.platform !== "linux") {
  console.log(`SEAT PLATFORM COMPLETE on ${process.platform}: custody transport unsupported (no skip-as-pass)`);
}
process.exitCode = fail === 0 ? 0 : 1;
