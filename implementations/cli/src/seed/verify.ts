import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SEEDED_EXTENSIONS, cmdSpawnSpec, extensionPackageDir, extensionsDir, hostPackageDir, installedExtensionPackage, isExtensionPathSpec, resolveExtensionEntry, type InstalledExtension } from "@cotal-ai/workspace";
import { npmInvocation } from "../lib/npm-invocation.js";
import { seedStorePath, shippedSourceDir } from "./paths.js";
import { sharedPlacements, type SharedPlacement } from "./shared.js";

const semver = createRequire(import.meta.url)("semver") as {
  validRange(range: string): string | null;
  satisfies(version: string, range: string, options?: { includePrerelease?: boolean }): boolean;
};

/** Check the links installed by the peer binder without changing the extension tree. */
export function seededPeerLinksCurrent(pkg: string): boolean {
  const installed = installedExtensionPackage(pkg);
  return installed !== undefined && Object.keys(installed.peerDependencies ?? {}).every(peer =>
    !peer.startsWith("@cotal-ai/") ||
    realpathSync(join(extensionPackageDir(pkg), "node_modules", peer)) === realpathSync(hostPackageDir(peer)));
}

/**
 * Why `cotal update` still has to reinstall a seeded built-in that is recorded at this generation, or
 * undefined when its installed copy is proven to be the payload this binary ships.
 *
 * The proof is byte for byte, read from disk now: the shipped payload, the seed-store copy the
 * manifest spec names, and the installed package hold the same files with the same contents, the
 * installed package is a real directory inside the extensions prefix rather than a link out of it,
 * and the entry is the seeded one at this generation. Any doubt is a reason, and a reason runs the
 * ordinary reinstall; nothing here repairs, and nothing is skipped on a guess.
 */
export function seededInstallDiffers(name: string, generation: string, entry: InstalledExtension): string | undefined {
  const pkg = SEEDED_EXTENSIONS[name].pkg;
  const store = seedStorePath(generation, name);
  if (entry.source !== "seeded") return "the installed entry is operator-managed";
  if (entry.version !== generation) return `recorded at ${entry.version}, not ${generation}`;
  if (typeof entry.spec !== "string") return "the seed store spec is not recorded";
  if (resolve(entry.spec) !== store) return `recorded spec ${entry.spec} is not this generation's store payload`;
  const installed = extensionPackageDir(pkg);
  let kind: ReturnType<typeof lstatSync>;
  try {
    kind = lstatSync(installed);
  } catch {
    return "not installed on disk";
  }
  if (kind.isSymbolicLink()) return "installed as a link, not a copy";
  if (!kind.isDirectory()) return "the installed path is not a directory";
  if (!realpathSync(installed).startsWith(realpathSync(extensionsDir()) + sep)) return "the installed copy resolves outside the extensions prefix";
  const shipped = shippedSourceDir(name);
  const own = payloadFiles(shipped);
  if (typeof own === "string") return `the shipped payload ${own}`;
  // A published payload's docs data ships once in the shared directory; each copy is compared with that.
  let shared: SharedPlacement[];
  try {
    shared = sharedPlacements(name, shipped);
  } catch (e) {
    return (e as Error).message;
  }
  const sources = new Map(own.map((file) => [file, join(shipped, file)]));
  for (const { rel, source } of shared) {
    const file = join(...rel.split("/"));
    if (sources.has(file)) return `the shipped payload holds ${file} and also ships it shared`;
    sources.set(file, source);
  }
  const files = [...sources.keys()].sort();
  for (const [copy, label] of [[store, "the seed store copy"], [installed, "the installed copy"]] as const) {
    const listed = payloadFiles(copy);
    if (typeof listed === "string") return `${label} ${listed}`;
    const have = [...listed].sort();
    if (have.length !== files.length) return `${label} holds ${have.length} files, the shipped payload ${files.length}`;
    for (let i = 0; i < files.length; i++) {
      if (have[i] !== files[i]) return `${label} has ${have[i]} where the shipped payload has ${files[i]}`;
      if (!sameBytes(sources.get(files[i])!, join(copy, files[i]))) return `${label} differs at ${files[i]}`;
    }
  }
  return undefined;
}

/** The source for a matching-generation repair is the operator's path, if one was recorded. */
export function operatorUpdateSpec(entry: InstalledExtension, generation: string): string {
  return entry.version === generation && typeof entry.spec === "string" && isExtensionPathSpec(entry.spec) ? entry.spec : `${entry.pkg}@${generation}`;
}

/**
 * Why `cotal update` still has to reinstall a first-party operator extension, or undefined when npm's
 * own record in the prefix proves it installed at this generation: the entry is recorded at this
 * generation and any recorded spec matches what the update would install. The prefix lock records
 * the package at that version, every package the lock records is on disk at its recorded version
 * ({@link prefixLockDiffers}), and the extension's resolved entry is a nonempty regular file
 * that Node can import with its dependencies.
 * Any doubt is a reason, and a reason runs the ordinary reinstall.
 */
export function operatorInstallDiffers(entry: InstalledExtension, generation: string): string | undefined {
  const spec = operatorUpdateSpec(entry, generation);
  if (entry.version !== generation) return `recorded at ${entry.version}, not ${generation}`;
  if (typeof entry.spec === "string" && entry.spec !== spec) return `recorded spec ${entry.spec} is not ${spec}`;
  const differs = verifyPrefixLock(extensionsDir(), { pkg: entry.pkg, version: generation });
  if (differs) return differs;
  const installed = installedExtensionPackage(entry.pkg);
  if (!installed) return "not installed on disk";
  if (installed.version !== generation) return `installed at ${installed.version}, not ${generation}`;
  const path = resolveExtensionEntry(extensionPackageDir(entry.pkg), installed);
  const file = statSync(path, { throwIfNoEntry: false });
  if (!file?.isFile()) return "entry file is missing";
  if (file.size === 0) return "entry file is empty";
  // Import in a fresh process so registrations and Node's module cache stay out of the updater.
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e", "await import(process.argv[1]); process.exit(0)", pathToFileURL(path).href], {
    stdio: "ignore", timeout: 15_000, killSignal: "SIGKILL", windowsHide: true,
  });
  return probe.status === 0 ? undefined : "entry file failed to load";
}

/**
 * Why the extensions prefix is not the tree its lock records, or undefined when every recorded
 * package is on disk at its recorded version. This is the same comparison npm makes before it
 * decides a reinstall changes nothing, made once for the whole prefix rather than once per
 * built-in, so an update that skips a reinstall still leaves no missing or skewed dependency behind.
 */
export function prefixLockDiffers(): string | undefined {
  return verifyPrefixLock(extensionsDir());
}

/** Installed package directories in `prefix` whose host-admissible optionalDependencies are not satisfied. */
export function packagesMissingOptionalDependencies(prefix: string): string[] {
  const realPrefix = tryRealpath(prefix);
  const incomplete: string[] = [];
  const walkNodeModules = (nmDir: string): void => {
    let entries: Dirent[];
    try { entries = readdirSync(nmDir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const full = join(nmDir, entry.name);
      if (entry.name.startsWith("@")) {
        walkNodeModules(full);
        continue;
      }
      if (optionalDependenciesDiffer(prefix, realPrefix, full, readOptionalDependencies(join(full, "package.json")))) {
        incomplete.push(full);
        continue;
      }
      walkNodeModules(join(full, "node_modules"));
    }
  };
  walkNodeModules(join(prefix, "node_modules"));
  return incomplete;
}

const builtInLockKeys = new Set(Object.values(SEEDED_EXTENSIONS).map(({ pkg }) => `node_modules/${pkg}`));
const packageLockCache = new Map<string, boolean>();

function verifyPrefixLock(prefix: string, expected?: { pkg: string; version: string }): string | undefined {
  const realPrefix = tryRealpath(prefix);
  const checkLock = (packages: Record<string, LockEntry> | string, installed: boolean): string | undefined => {
    if (typeof packages === "string") return packages;
    const differs = lockedTreeDiffers(prefix, realPrefix, { packages, installed });
    if (differs) return differs;
    if (!expected) return undefined;
    const locked = findLockedVersion(prefix, realPrefix, packages, expected.pkg);
    if (locked === undefined) return "the prefix lock does not record it";
    return locked === expected.version ? undefined : `the prefix lock records it at ${String(locked)}`;
  };
  const publicPackages = readLockPackages(join(prefix, "package-lock.json"));
  const publicDiffers = checkLock(publicPackages, false);
  if (publicDiffers === undefined && typeof publicPackages !== "string" && publicLockCoversManifest(prefix, publicPackages)) {
    return undefined;
  }
  const actual = join(prefix, "node_modules", ".package-lock.json");
  if (existsSync(actual) && packageLockDisabled(prefix)) {
    return checkLock(readLockPackages(actual), true);
  }
  return publicDiffers;
}

function readLockPackages(path: string): Record<string, LockEntry> | string {
  try {
    const { packages } = JSON.parse(readFileSync(path, "utf8")) as { packages?: Record<string, LockEntry> };
    if (!packages || typeof packages !== "object" || Array.isArray(packages)) return "the prefix lock records no packages";
    return packages;
  } catch (e) {
    return `the prefix lock is unreadable: ${(e as Error).message}`;
  }
}

function publicLockCoversManifest(prefix: string, packages: Record<string, LockEntry>): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(prefix, "package.json"), "utf8")) as {
      dependencies?: Record<string, unknown>;
      optionalDependencies?: Record<string, unknown>;
    };
    const root = packages[""];
    if (!root || typeof root !== "object") return false;
    const deps = isStringMap(root.dependencies) ? root.dependencies : {};
    const optDeps = isStringMap(root.optionalDependencies) ? root.optionalDependencies : {};
    return Object.keys(manifest.dependencies ?? {}).every((name) => name in deps || name in optDeps) &&
      Object.keys(manifest.optionalDependencies ?? {}).every((name) => name in optDeps || name in deps);
  } catch {
    return false;
  }
}

/** npm records the installed tree under node_modules even with package-lock disabled. */
function packageLockDisabled(prefix: string): boolean {
  const key = packageLockCacheKey(prefix);
  const cached = packageLockCache.get(key);
  if (cached !== undefined) return cached;
  if (packageLockCache.size >= 64) packageLockCache.clear();
  try {
    const npm = npmInvocation(process.env, ["config", "get", "package-lock", "--prefix", prefix, "--logs-max=0", "--update-notifier=false"]);
    const { file, args, windowsVerbatimArguments } = cmdSpawnSpec(npm.file, npm.args, npm.env);
    const config = spawnSync(file, args, {
      cwd: npm.cwd, env: npm.env, windowsVerbatimArguments, encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", windowsHide: true,
    });
    if (config.status === 0 && config.stdout.trim() === "false") {
      packageLockCache.set(key, true);
      return true;
    }
  } catch {
    // Missing npm, cmd.exe, or invalid Windows command expansion cannot confirm package-lock=false.
  }
  packageLockCache.set(key, false);
  return false;
}

function packageLockCacheKey(prefix: string): string {
  const envEntries = Object.entries(process.env)
    .filter(([name]) => /^(?:npm_config_|path$|home$|userprofile$)/i.test(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value ?? ""}`);
  const home = envValue("HOME") ?? envValue("USERPROFILE") ?? homedir();
  const userConfig = envValue("npm_config_userconfig") ?? join(home, ".npmrc");
  const globalConfig = envValue("npm_config_globalconfig");
  const files = [join(prefix, ".npmrc"), userConfig, ...(globalConfig ? [globalConfig] : [])].map((file) => {
    try { return `${file}:${readFileSync(file, "utf8")}`; }
    catch { return `${file}:absent`; }
  });
  return JSON.stringify([prefix, process.platform, envEntries, files]);
}

function envValue(name: string): string | undefined {
  if (process.env[name] !== undefined) return process.env[name];
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(process.env)) if (key.toLowerCase() === lower) return value;
  return undefined;
}

function tryRealpath(path: string): string | undefined {
  try { return realpathSync(path); }
  catch { return undefined; }
}

function prefixLockKey(prefix: string, realPrefix: string | undefined, key: string): string {
  if (key === "" || key.startsWith("node_modules/") || !realPrefix) return key;
  const resolved = resolve(prefix, key);
  return resolved.startsWith(realPrefix + sep) ? resolved.slice(realPrefix.length + 1).replaceAll("\\", "/") : key;
}

function findLockedVersion(
  prefix: string,
  realPrefix: string | undefined,
  packages: Record<string, LockEntry>,
  pkg: string,
): unknown {
  const target = `node_modules/${pkg}`;
  if (packages[target] !== undefined) return packages[target]?.version;
  for (const [key, entry] of Object.entries(packages)) {
    if (entry.link === true) continue;
    if (prefixLockKey(prefix, realPrefix, key) === target) return entry.version;
  }
  return undefined;
}

function lockedTreeDiffers(
  prefix: string,
  realPrefix: string | undefined,
  lock: { packages: Record<string, LockEntry>; installed: boolean },
): string | undefined {
  if (lock.installed) {
    const rootDiffers = optionalDependenciesDiffer(prefix, realPrefix, prefix, readOptionalDependencies(join(prefix, "package.json")));
    if (rootDiffers) return rootDiffers;
  }
  for (const [key, recorded] of Object.entries(lock.packages)) {
    if (key === "" || recorded.link === true) continue;
    const normalized = prefixLockKey(prefix, realPrefix, key);
    const pkgDir = resolve(prefix, key);
    // Built-ins are checked against their payloads individually. The installed-tree record only
    // checks their dependencies and other packages, not an unrefreshed built-in entry.
    if (lock.installed && builtInLockKeys.has(normalized)) {
      const differs = optionalDependenciesDiffer(prefix, realPrefix, pkgDir, readOptionalDependencies(join(pkgDir, "package.json")));
      if (differs) return differs;
      continue;
    }
    if (typeof recorded.version !== "string") return `the prefix lock records no version for ${key}`;
    let manifest: { version?: unknown; optionalDependencies?: unknown };
    try {
      manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as typeof manifest;
    } catch {
      // npm installs an optional package only on a platform its `os`, `cpu` and `libc` lists admit; one
      // the lock records for another platform is absent by npm's own rule, not missing.
      if (recorded.optional === true && platformExcludesHost(recorded)) continue;
      return `${key} is recorded in the prefix lock but not installed`;
    }
    if (manifest.version !== recorded.version) return `${key} is ${String(manifest.version)} on disk and ${recorded.version} in the prefix lock`;
    if (lock.installed) {
      const optional = {
        ...(isStringMap(recorded.optionalDependencies) ? recorded.optionalDependencies : {}),
        ...(isStringMap(manifest.optionalDependencies) ? manifest.optionalDependencies : {}),
      };
      const differs = optionalDependenciesDiffer(prefix, realPrefix, pkgDir, optional);
      if (differs) return differs;
    }
  }
  return undefined;
}

function isStringMap(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "string");
}

function readOptionalDependencies(manifestPath: string): Record<string, string> | undefined {
  try {
    const { optionalDependencies } = JSON.parse(readFileSync(manifestPath, "utf8")) as { optionalDependencies?: unknown };
    return isStringMap(optionalDependencies) ? optionalDependencies : undefined;
  } catch {
    return undefined;
  }
}

function optionalDependenciesDiffer(
  prefix: string,
  realPrefix: string | undefined,
  declarerDir: string,
  optional: Record<string, string> | undefined,
): string | undefined {
  if (!optional) return undefined;
  for (const [depName, depSpec] of Object.entries(optional)) {
    const local = depSpec.startsWith("file:") || isExtensionPathSpec(depSpec);
    const manifestPath = findInstalledOptionalManifest(prefix, realPrefix, declarerDir, depName);
    if (manifestPath) {
      let installed: LockEntry;
      try {
        installed = JSON.parse(readFileSync(manifestPath, "utf8")) as LockEntry;
      } catch {
        return `node_modules/${depName} has an unreadable package.json`;
      }
      if (typeof installed.version !== "string") return `node_modules/${depName} has no version on disk`;
      if (local) {
        const source = readOptionalSource(declarerDir, depSpec);
        if (!source) return `node_modules/${depName} has an unreadable source at ${depSpec}`;
        if (typeof source.version === "string" && installed.version !== source.version) {
          return `node_modules/${depName} is ${installed.version} on disk and ${source.version} in ${depSpec}`;
        }
      } else if (semver.validRange(depSpec) !== null && !semver.satisfies(installed.version, depSpec, { includePrerelease: true })) {
        return `node_modules/${depName} is ${installed.version} on disk, which does not satisfy ${depSpec}`;
      }
      continue;
    }
    const platform = local ? readOptionalSource(declarerDir, depSpec) : inferredOptionalPlatform(depName);
    if (platform && platformExcludesHost(platform)) continue;
    return `node_modules/${depName} is recorded in optionalDependencies but not installed`;
  }
  return undefined;
}

function findInstalledOptionalManifest(
  prefix: string,
  realPrefix: string | undefined,
  declarerDir: string,
  depName: string,
): string | undefined {
  const logicalRoot = resolve(prefix);
  const withinPrefix = (dir: string) =>
    dir === logicalRoot || dir.startsWith(logicalRoot + sep) ||
    (realPrefix !== undefined && (dir === realPrefix || dir.startsWith(realPrefix + sep)));
  let dir = tryRealpath(declarerDir) ?? resolve(declarerDir);
  while (withinPrefix(dir)) {
    if (basename(dir) !== "node_modules") {
      const candidate = join(dir, "node_modules", ...depName.split("/"), "package.json");
      if (existsSync(candidate)) return candidate;
    }
    if (dir === logicalRoot || dir === realPrefix) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const fallback = join(prefix, "node_modules", ...depName.split("/"), "package.json");
  return existsSync(fallback) ? fallback : undefined;
}

function readOptionalSource(declarerDir: string, spec: string): LockEntry | undefined {
  try {
    const dir = spec.startsWith("file://") ? fileURLToPath(spec)
      : spec.startsWith("file:") ? resolve(declarerDir, spec.slice(5))
      : resolve(declarerDir, spec);
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as LockEntry;
  } catch {
    return undefined;
  }
}

const OPTIONAL_PLATFORM_SUFFIX = /(?:^|-)(darwin|linux|win32|freebsd|openbsd|netbsd|sunos|aix|android|openharmony)-(x64|arm64|ia32|arm|ppc64|s390x|riscv64|mips64el|loong64|universal)(?:-(gnu|glibc|musl|gnueabihf|msvc|eabi))?$/;

function inferredOptionalPlatform(pkg: string): Pick<LockEntry, "os" | "cpu" | "libc"> | undefined {
  if (pkg === "fsevents") return { os: ["darwin"] };
  const unscoped = pkg.includes("/") ? pkg.slice(pkg.indexOf("/") + 1) : pkg;
  if (unscoped.endsWith("-wasm32-wasi") || unscoped === "wasm32-wasi") return { cpu: ["wasm32"] };
  const match = OPTIONAL_PLATFORM_SUFFIX.exec(unscoped);
  if (!match) return undefined;
  const [, os, arch, abi] = match;
  const cpu = arch === "universal" ? ["x64", "arm64"] : [arch!];
  const libc = abi === "musl" ? ["musl"] : abi === "gnu" || abi === "glibc" || abi === "gnueabihf" ? ["glibc"] : undefined;
  return libc ? { os: [os!], cpu, libc } : { os: [os!], cpu };
}

/** The payload's regular files, sorted, relative to `root`, with nested `node_modules` and `.git`
 *  left out the way the stager leaves them out; or why the tree cannot be compared. */
function payloadFiles(root: string): string[] | string {
  const files: string[] = [];
  const walk = (dir: string, rel: string): string | undefined => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return `cannot be read at ${rel || "."}: ${(e as Error).message}`;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = join(rel, entry.name);
      if (entry.isSymbolicLink()) return `contains a link at ${path}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const problem = walk(join(dir, entry.name), path);
        if (problem) return problem;
      } else if (entry.isFile()) files.push(path);
      else return `contains a special file at ${path}`;
    }
    return undefined;
  };
  return walk(root, "") ?? files;
}

interface LockEntry {
  readonly version?: unknown;
  readonly link?: unknown;
  readonly optional?: unknown;
  readonly os?: unknown;
  readonly cpu?: unknown;
  readonly libc?: unknown;
  readonly dependencies?: unknown;
  readonly optionalDependencies?: unknown;
}

/** npm's platform rule for a package (npm-install-checks `checkPlatform`): it is left out of this
 *  host when its `os`, `cpu` or `libc` list does not admit the host, and a `libc` requirement on a
 *  host whose libc npm cannot name is left out too. A list this function cannot read admits the host,
 *  so the absent package is reported rather than excused. */
export function platformExcludesHost(
  entry: Pick<LockEntry, "os" | "cpu" | "libc">,
  host: { platform: string; arch: string; libc: () => string | undefined } = { platform: process.platform, arch: process.arch, libc: hostLibc },
): boolean {
  if (entry.os !== undefined && !admits(host.platform, entry.os)) return true;
  if (entry.cpu !== undefined && !admits(host.arch, entry.cpu)) return true;
  if (entry.libc !== undefined) {
    const libc = host.libc();
    if (!libc || !admits(libc, entry.libc)) return true;
  }
  return false;
}

/** npm-install-checks `checkList`: a string is a one-entry list, `["any"]` admits everything, and
 *  the value must match none of the negated (`!x`) entries and, when a plain entry exists, at least
 *  one of them. Anything that is not a list of strings is read as admitting the host. */
export function admits(value: string, list: unknown): boolean {
  const entries = typeof list === "string" ? [list] : Array.isArray(list) && list.every((entry) => typeof entry === "string") ? list : undefined;
  if (entries === undefined) return true;
  if (entries.length === 1 && entries[0] === "any") return true;
  let negated = 0;
  let match = false;
  for (const entry of entries) {
    const negate = entry.startsWith("!");
    const test = negate ? entry.slice(1) : entry;
    if (negate) {
      negated++;
      if (value === test) return false;
    } else match = match || value === test;
  }
  return match || negated === entries.length;
}

/** The host's libc family the way npm names it (npm-install-checks `current-env`): on Linux, read
 *  from `/usr/bin/ldd`, else from the process report; elsewhere there is none. */
function hostLibc(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const ldd = readFileSync("/usr/bin/ldd", "utf8");
    if (ldd.includes("musl")) return "musl";
    if (ldd.includes("GNU C Library")) return "glibc";
    return undefined;
  } catch {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: unknown }; sharedObjects?: unknown } | undefined;
    if (report?.header?.glibcVersionRuntime) return "glibc";
    if (Array.isArray(report?.sharedObjects) && report.sharedObjects.some((file) => typeof file === "string" && (file.includes("libc.musl-") || file.includes("ld-musl-")))) return "musl";
    return undefined;
  }
}

function sameBytes(a: string, b: string): boolean {
  if (statSync(a).size !== statSync(b).size) return false;
  return readFileSync(a).equals(readFileSync(b));
}
