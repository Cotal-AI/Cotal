import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const base = mkdtempSync(join(tmpdir(), "cotal-seat-installed-dist-"));
const packs = join(base, "packs");
const installRoot = join(base, "install");
const cloneRoot = join(base, "source");
const seatClone = join(cloneRoot, "packages", "seat");
mkdirSync(packs, { recursive: true });
mkdirSync(installRoot);

let passed = 0;
let failed = 0;
const check = (name: string, condition: unknown, detail?: unknown): void => {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}`, detail ?? ""); }
};
const run = (command: string, args: string[], cwd: string, isolatedHome = false) => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    // Only the registry install runs against an isolated HOME: it must not see the operator's npm
    // config. The pack steps reuse the ambient toolchain caches read-only, exactly as a release
    // runner does, so the fixture does not redownload a toolchain into the temp home.
    env: isolatedHome
      ? { ...env, HOME: join(base, "home"), XDG_CONFIG_HOME: join(base, "xdg"), NO_COLOR: "1" }
      : { ...env, NO_COLOR: "1" },
    timeout: 180_000,
  });
};
const output = (result: ReturnType<typeof run>) => `${result.stdout ?? ""}${result.stderr ?? ""}`;
const writeElf = (arch: string, machine: number): void => {
  const path = join(seatClone, "build", "Release", `linux-${arch}`, "peercred.node");
  mkdirSync(dirname(path), { recursive: true });
  const buffer = Buffer.alloc(20);
  buffer[0] = 0x7f;
  buffer.write("ELF", 1);
  buffer.writeUInt16LE(machine, 18);
  writeFileSync(path, buffer);
};

try {
  cpSync(join(ROOT, "packages", "seat"), seatClone, {
    recursive: true,
    filter: (source) => !source.split(sep).includes("node_modules") && basename(source) !== "dist",
  });
  // The clone is a workspace root, so `pnpm pack` resolves the same pinned pnpm and the same
  // toolchain as the real tree. node_modules is a symlink, never a copy: the host tree stays
  // read-only for this fixture and no toolchain is duplicated.
  for (const name of ["package.json", "pnpm-workspace.yaml", "tsconfig.base.json"]) cpSync(join(ROOT, name), join(cloneRoot, name));
  symlinkSync(join(ROOT, "node_modules"), join(cloneRoot, "node_modules"), "dir");
  // The seat package's own dependency links (node-pty, xterm) resolve through the host's per-package
  // node_modules; symlinking them keeps the compile offline and the host tree read-only.
  if (existsSync(join(ROOT, "packages", "seat", "node_modules"))) {
    symlinkSync(join(ROOT, "packages", "seat", "node_modules"), join(seatClone, "node_modules"), "dir");
  }
  writeElf("x64", 62);
  writeElf("arm64", 183);
  check("assembled seat source tree starts without dist", !existsSync(join(seatClone, "dist")));

  const seatPack = run("pnpm", ["pack", "--pack-destination", packs], seatClone);
  check("assembled seat source tree packs successfully", seatPack.status === 0, output(seatPack));
  const seatTarball = readdirSync(packs).map((name) => join(packs, name)).find((path) => basename(path).startsWith("cotal-ai-seat-"));
  check("seat pack produced one tarball", seatTarball !== undefined, readdirSync(packs));
  if (!seatTarball) throw new Error("seat tarball missing");
  const listing = run("tar", ["-tzf", seatTarball], ROOT);
  const files = listing.stdout.split(/\r?\n/).filter(Boolean);
  check("seat package inventory contains dist/index.js", files.includes("package/dist/index.js"), files);
  check("seat package inventory contains dist/index.d.ts", files.includes("package/dist/index.d.ts"), files);
  check("seat package inventory contains both native helpers", ["x64", "arm64"].every((arch) => files.includes(`package/build/Release/linux-${arch}/peercred.node`)), files);

  const workspace = new Map<string, string>();
  for (const parent of ["packages", "extensions", "implementations"]) {
    for (const entry of readdirSync(join(ROOT, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(parent, entry.name);
      const manifestPath = join(ROOT, dir, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string; private?: boolean };
      if (manifest.name && !manifest.private) workspace.set(manifest.name, dir);
    }
  }
  workspace.set("cotal-ai", "bin");
  const needed = new Set<string>();
  const queue = ["cotal-ai"];
  while (queue.length > 0) {
    const name = queue.shift()!;
    const dir = workspace.get(name);
    if (!dir || needed.has(name)) continue;
    needed.add(name);
    const manifest = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
      if (range.startsWith("workspace:")) queue.push(dependency);
    }
  }
  for (const name of needed) {
    if (name === "@cotal-ai/seat") continue;
    const packed = run("pnpm", ["-C", join(ROOT, workspace.get(name)!), "pack", "--pack-destination", packs], ROOT);
    check(`packed installed closure member ${name}`, packed.status === 0, output(packed));
  }

  writeFileSync(join(installRoot, "package.json"), JSON.stringify({ name: "seat-installed-dist", private: true }));
  const tarballs = readdirSync(packs).filter((name) => name.endsWith(".tgz")).map((name) => join(packs, name));
  const installed = run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], installRoot, true);
  check("fresh fixture installs the complete packaged CLI closure", installed.status === 0, output(installed));

  const seatImport = run(process.execPath, ["--input-type=module", "-e", "await import('@cotal-ai/seat')"], installRoot);
  check("fresh installed @cotal-ai/seat import succeeds", seatImport.status === 0, output(seatImport));
  const managerImport = run(process.execPath, ["--input-type=module", "-e", "await import('@cotal-ai/manager')"], installRoot);
  check("fresh installed @cotal-ai/manager import succeeds", managerImport.status === 0, output(managerImport));
  const help = run(process.execPath, [join(installRoot, "node_modules", "cotal-ai", "dist", "cotal.js"), "--help"], installRoot, true);
  // The banner's `cotal` word is wrapped in unconditional ANSI bold (workspace colors never check
  // TTY), so require the literal line after stripping escapes — not a loose substring that the
  // uppercase package description would also satisfy.
  const banner = (help.stdout ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  check(
    "fresh installed cotal --help starts through the packaged CLI",
    help.status === 0 && /^cotal - lateral agent coordination over NATS$/m.test(banner),
    output(help),
  );
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`SEAT INSTALLED DIST: ${passed} passed, ${failed} failed`);
console.log("SUITE COMPLETE: seat installed distribution");
process.exit(failed === 0 ? 0 : 1);
