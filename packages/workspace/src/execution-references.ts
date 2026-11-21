import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** Generation references are private installation data, separate from the package inventory. */
export const EXECUTION_READERS = ".execution-readers-v1";
const writing = new Set<string>();

export function executionProcessScope(): string | undefined {
  try {
    const ns = /^pid:\[(\d+)\]$/.exec(readlinkSync("/proc/self/ns/pid"));
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (ns && /^[a-f0-9-]{36}$/.test(boot)) return `${boot}-${ns[1]}`;
  } catch { /* Missing scope is not proof that a process exited. */ }
}

/** Match a retained package ancestor of an absolute filesystem path. */
export function executionReferenceGeneration(path: string): string | undefined {
  if (!isAbsolute(path)) return;
  for (let root = path; root !== dirname(root); root = dirname(root)) {
    const generation = dirname(root);
    if (basename(root) === "cotal-ai" && /^[a-f0-9]{32}$/.test(basename(generation)) && basename(dirname(generation)) === ".cotal-generations") return generation;
  }
}

/** Reserve a reference before its writer publishes it. An untracked generation is never collected. */
export function recordExecutionReference(generation: string, root: string, kind = "tree"): void {
  const readers = join(generation, EXECUTION_READERS);
  const info = lstatSync(readers, { throwIfNoEntry: false });
  if (!info) {
    if (!lstatSync(generation, { throwIfNoEntry: false })) throw new Error("the execution generation is unavailable");
    return;
  }
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || realpathSync.native(readers) !== readers)
    throw new Error("the execution reference directory is not private to this installation");
  if (!writing.has(generation)) {
    const pin = mkdtempSync(join(readers, `${executionProcessScope() ?? "unknown"}.${process.pid}-`));
    process.once("exit", () => { try { rmdirSync(pin); } catch { /* A stale pin can be checked by the collector. */ } });
    if (lstatSync(join(generation, ".collecting"), { throwIfNoEntry: false }) || !lstatSync(pin, { throwIfNoEntry: false }))
      throw new Error("the referenced execution generation is being collected");
    writing.add(generation);
  }
  root = resolve(root);
  const value = `${kind}\n${root}`;
  const record = join(readers, `ref-${createHash("sha256").update(value).digest("hex")}`);
  try { writeFileSync(record, value, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}

/** Visit the paths that a saved service can resolve to installed program files. */
export function visitExecutionServicePaths(text: string, visit: (path: string) => void): void {
  JSON.parse(text, (_key, value: unknown) => {
    if (typeof value === "string" && isAbsolute(value)) visit(resolve(value));
    if (value && typeof value === "object") {
      const { type, executable, cwd, args } = value as Record<string, unknown>;
      if (type === "process" && typeof cwd === "string" && isAbsolute(cwd)) {
        for (const input of [executable, ...(Array.isArray(args) ? args : [])]) {
          if (typeof input === "string" && !isAbsolute(input) && input.includes("/")) visit(resolve(cwd, input));
        }
      }
    }
    return value;
  });
}

export function recordExecutionServiceReferences(text: string, file: string): void {
  if (process.platform !== "linux") return;
  visitExecutionServicePaths(text, path => {
    let generation = executionReferenceGeneration(path);
    if (!generation) {
      try { generation = executionReferenceGeneration(realpathSync.native(path)); }
      catch { /* Arbitrary service arguments need not resolve to local paths. */ }
    }
    if (generation) recordExecutionReference(generation, file, "record");
  });
}

export function connectorExecutionReferenceRoot(config: string): string {
  for (let path = config; dirname(path) !== path; path = dirname(path)) {
    if (basename(path).startsWith(".extensions.stage-")) { config = dirname(path); break; }
  }
  const set = dirname(config);
  return basename(dirname(set)) === "sets" && /^cotal(?:-[a-f0-9]{16})?$/.test(basename(config)) ? set : config;
}

export function recordCopiedExecutionLink(source: string, root: string): void {
  if (!lstatSync(source).isSymbolicLink()) return;
  const target = resolve(dirname(source), readlinkSync(source));
  let generation = executionReferenceGeneration(target);
  if (!generation) {
    try { generation = executionReferenceGeneration(realpathSync.native(source)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (generation) recordExecutionReference(generation, root);
}
