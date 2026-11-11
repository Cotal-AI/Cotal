// npm owns cotal-ai's bin, but must not own the stable cotal launcher: Arborist retires every bin
// in the old manifest before unpacking its replacement. Publish one separate bin for npm/npx.
const { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync } = require("node:fs");
const { basename, dirname, join, relative, resolve } = require("node:path");
const cmdShim = require("cmd-shim");

async function install() {
  const pkg = resolve(__dirname, "..");
  const modules = dirname(pkg);
  if (basename(modules) !== "node_modules" || basename(pkg) !== "cotal-ai") return;
  const global = process.env.npm_config_global === "true";
  const bin = global
    ? process.platform === "win32" ? dirname(modules) : resolve(modules, "..", "..", "bin")
    : join(modules, ".bin");
  const stable = join(modules, ".cotal-launcher");
  const launcher = join(stable, "launcher.cjs");
  const target = join(bin, "cotal");
  for (const suffix of process.platform === "win32" ? ["", ".cmd", ".ps1"] : [""]) {
    const path = target + suffix;
    let stat;
    try { stat = lstatSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!stat) continue;
    const owned = stat.isSymbolicLink()
      ? [launcher, join(pkg, "dist", "cotal.js")].includes(resolve(bin, readlinkSync(path)))
      : process.platform === "win32" && stat.isFile() && /(?:\.cotal-launcher[\\/]launcher\.cjs|cotal-ai[\\/]dist[\\/]cotal\.js)/.test(readFileSync(path, "utf8"));
    if (!owned) throw new Error(`refusing to replace an unrelated executable at ${path}`);
  }
  mkdirSync(stable, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const temporary = `${launcher}.${process.pid}`;
  copyFileSync(join(pkg, "launcher.cjs"), temporary);
  renameSync(temporary, launcher);
  if (process.platform === "win32") {
    // Generate npm's quoting and runtime lookup, then replace each completed shim atomically.
    const staging = `${target}.${process.pid}`;
    await cmdShim(launcher, staging);
    for (const suffix of ["", ".cmd", ".ps1"]) renameSync(staging + suffix, target + suffix);
  } else {
    const staging = `${target}.${process.pid}`;
    try {
      symlinkSync(relative(bin, launcher), staging);
      renameSync(staging, target);
    } finally {
      if (existsSync(staging)) unlinkSync(staging);
    }
  }
}
install().catch((error) => { console.error(`cotal: could not install the stable launcher: ${error.message}`); process.exitCode = 1; });
