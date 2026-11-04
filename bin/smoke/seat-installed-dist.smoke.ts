import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";

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
const requireCheck = (name: string, condition: unknown, detail?: unknown): void => {
  check(name, condition, detail);
  if (!condition) throw new Error(name);
};

try {
  // CI assembles qualified native artifacts before this suite. Refuse before packing anything when
  // either set is absent, rather than allowing npm to fetch a missing first-party tarball later.
  for (const pkg of ["seat", "workspace"]) {
    const guarded = run(process.execPath, [join(ROOT, "packages", pkg, "scripts", "assert-shipped-natives.mjs")], ROOT);
    requireCheck(`${pkg} has the required assembled native artifacts`, guarded.status === 0, output(guarded));
  }
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
  check("assembled seat source tree starts without dist", !existsSync(join(seatClone, "dist")));

  const seatPack = run("pnpm", ["pack", "--pack-destination", packs], seatClone);
  requireCheck("assembled seat source tree packs successfully", seatPack.status === 0, output(seatPack));
  const seatTarball = readdirSync(packs).map((name) => join(packs, name)).find((path) => basename(path).startsWith("cotal-ai-seat-"));
  check("seat pack produced one tarball", seatTarball !== undefined, readdirSync(packs));
  if (!seatTarball) throw new Error("seat tarball missing");
  const listing = run("tar", ["-tzf", seatTarball], ROOT);
  const files = listing.stdout.split(/\r?\n/).filter(Boolean);
  check("seat package inventory contains dist/index.js", files.includes("package/dist/index.js"), files);
  check("seat package inventory contains dist/index.d.ts", files.includes("package/dist/index.d.ts"), files);
  check("seat package inventory contains all six native helpers", ["linux", "darwin", "win32"].every((platform) =>
    ["x64", "arm64"].every((arch) => files.includes(`package/build/Release/${platform}-${arch}/peercred.node`))), files);

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
    requireCheck(`packed installed closure member ${name}`, packed.status === 0, output(packed));
  }

  writeFileSync(join(installRoot, "package.json"), JSON.stringify({ name: "seat-installed-dist", private: true }));
  const tarballs = readdirSync(packs).filter((name) => name.endsWith(".tgz")).map((name) => join(packs, name));
  requireCheck("every closure member produced a local tarball", tarballs.length === needed.size, { tarballs: tarballs.length, needed: needed.size });
  const installed = run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], installRoot, true);
  requireCheck("fresh fixture installs the complete packaged CLI closure", installed.status === 0, output(installed));
  const lock = JSON.parse(readFileSync(join(installRoot, "package-lock.json"), "utf8")) as { packages: Record<string, { resolved?: string }> };
  for (const name of needed) {
    check(`installed ${name} came from its local tarball`, lock.packages[`node_modules/${name}`]?.resolved?.startsWith("file:"));
  }

  for (const platform of ["linux", "darwin", "win32"]) for (const arch of ["x64", "arm64"]) {
    const path = join("build", "Release", `${platform}-${arch}`, "peercred.node");
    check(`installed seat ${platform}-${arch} preserves the assembled binary`,
      readFileSync(join(installRoot, "node_modules", "@cotal-ai", "seat", path)).equals(readFileSync(join(ROOT, "packages", "seat", path))));
  }
  for (const platform of ["win32", "darwin"]) for (const arch of ["x64", "arm64"]) {
    for (const file of [platform === "win32" ? "creation.node" : "process.node", "build.json"]) {
      const path = join("build", "Release", `${platform}-${arch}`, file);
      check(`installed workspace ${platform}-${arch}/${file} preserves the qualified artifact`,
        readFileSync(join(installRoot, "node_modules", "@cotal-ai", "workspace", path)).equals(readFileSync(join(ROOT, "packages", "workspace", path))));
    }
  }
  const nativeLoad = run(process.execPath, ["-e", `require(${JSON.stringify(join(installRoot, "node_modules", "@cotal-ai", "seat", "build", "Release", `${process.platform}-${process.arch}`, "peercred.node"))})`], installRoot);
  check("fresh installed seat host binding actually loads", nativeLoad.status === 0, output(nativeLoad));

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
  check("all installed-distribution assertions ran", passed + failed === 27 + 2 * needed.size, { passed, failed, closureMembers: needed.size });
} catch (error) {
  if (failed === 0) check("installed-distribution fixture completed", false, error);
  else console.error(error);
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`SEAT INSTALLED DIST: ${passed} passed, ${failed} failed`);
console.log("SUITE COMPLETE: seat installed distribution");
process.exit(failed === 0 ? 0 : 1);
