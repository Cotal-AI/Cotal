import { mkdtempSync, mkdirSync, readFileSync, realpathSync, statSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface StageNpmResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

export interface UpdateTargetStage {
  readonly packageRoot: string;
  /** Absent means the caller must explicitly choose its installed-check compatibility rule. */
  readonly entry?: string;
  /** Keep the stage alive while using this cache for a same-platform offline installation. */
  readonly npmCache: string;
  dispose(): void;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown, description: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${description}`);
  return value as RecordValue;
}

function readRecord(path: string): RecordValue {
  return record(JSON.parse(readFileSync(path, "utf8")), path);
}

function contained(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function excludes(value: unknown, current: string): boolean {
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) return false;
  return value.includes(`!${current}`) ||
    (value.some(item => !item.startsWith("!")) && !value.includes(current) && !value.includes("any"));
}

/** Stage an exact registry release without scripts or writes to the installed configuration.
 * npm verifies archive SRI while installing into a private prefix and cache. Ignoring lifecycle
 * scripts means native modules and generated assets may not be usable by the declared entry.
 */
export function stageUpdateTarget(
  version: string,
  runtime: { npm(args: string[], inherit?: boolean): StageNpmResult },
): UpdateTargetStage {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("target staging requires an exact release version");
  }
  const staging = mkdtempSync(join(tmpdir(), "cotal-update-target-"));
  const dispose = (): void => { rmSync(staging, { recursive: true, force: true, maxRetries: 3 }); };
  try {
    const npmCache = join(staging, "cache");
    mkdirSync(npmCache, { mode: 0o700 });
    const result = runtime.npm([
      "install", "--prefix", staging, "--ignore-scripts", "--package-lock=true", "--no-audit", "--no-fund",
      "--cache", npmCache, "--logs-max=0", "--update-notifier=false", "--fetch-retries=0",
      "--fetch-timeout=15000", "--prefer-online", `cotal-ai@${version}`,
    ]);
    if (result.status !== 0) throw new Error(`target staging failed: ${result.error ?? (result.stderr.trim() || result.stdout.trim() || "npm install failed")}`);
    const lock = readRecord(join(staging, "package-lock.json"));
    const packages = record(lock.packages, "target package lock entries");
    if (!Object.hasOwn(packages, "node_modules/cotal-ai")) throw new Error("target package lock is missing cotal-ai");
    const stagingRoot = realpathSync(staging);
    for (const [location, value] of Object.entries(packages)) {
      if (location === "") continue;
      const entry = record(value, `package lock entry ${location}`);
      if (!location.startsWith("node_modules/") || location.includes("\\") || !contained(stagingRoot, resolve(stagingRoot, location))) {
        throw new Error(`invalid target package location: ${location}`);
      }
      if (entry.link || typeof entry.resolved !== "string" || !/^https?:\/\//.test(entry.resolved) ||
          typeof entry.integrity !== "string" || !/^(?:sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2})(?:\s+sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2})*$/.test(entry.integrity)) {
        throw new Error(`target package lacks registry integrity: ${location}`);
      }
      const packagePath = resolve(stagingRoot, location);
      const name = location.slice(location.lastIndexOf("node_modules/") + "node_modules/".length);
      if (name !== "cotal-ai" && !name.startsWith("@cotal-ai/")) continue;
      if (entry.version !== version) throw new Error(`first-party target package does not match ${name}@${version}`);
      if (!existsSync(packagePath)) {
        if (entry.optional === true && (excludes(entry.os, process.platform) || excludes(entry.cpu, process.arch))) continue;
        throw new Error(`first-party target package is missing: ${name}`);
      }
      const root = realpathSync(packagePath);
      if (!contained(stagingRoot, root)) throw new Error(`target package escapes staging: ${name}`);
      const manifest = readRecord(join(root, "package.json"));
      if (manifest.name !== name || manifest.version !== version || entry.version !== version) {
        throw new Error(`first-party target package does not match ${name}@${version}`);
      }
      for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
        if (manifest[field] === undefined) continue;
        for (const [dependency, range] of Object.entries(record(manifest[field], `${name} ${field}`))) {
          if (!dependency.startsWith("@cotal-ai/")) continue;
          if (!/^@cotal-ai\/[a-z0-9][a-z0-9._-]*$/.test(dependency) || typeof range !== "string" ||
              (field !== "peerDependencies" && range !== version)) throw new Error(`invalid first-party dependency in ${name}`);
        }
      }
    }
    const packageRoot = realpathSync(join(staging, "node_modules", "cotal-ai"));
    const manifest = readRecord(join(packageRoot, "package.json"));
    let entry: string | undefined;
    if (Object.hasOwn(manifest, "cotalPreinstall")) {
      const declared = manifest.cotalPreinstall;
      if (typeof declared !== "string" || !declared.startsWith("./") || !declared.endsWith(".js") ||
          declared.includes("\\") || declared.split("/").slice(1).some(part => !part || part === "." || part === "..")) {
        throw new Error("target cotalPreinstall must be a strict relative .js path");
      }
      entry = realpathSync(resolve(packageRoot, declared));
      if (!contained(packageRoot, entry) || !statSync(entry).isFile()) throw new Error("target cotalPreinstall must be a regular file inside its package");
    }
    return { packageRoot, entry, npmCache, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
