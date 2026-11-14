#!/usr/bin/env node
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setFlagsFromString } from "node:v8";

setFlagsFromString("--no-maglev");
setFlagsFromString("--no-concurrent-sparkplug");

export interface ExecutionBinding { name: "cotal-ai"; version: string; bootstrapSha256: string }
export interface ExecutionDescriptor {
  v: 1;
  binding: ExecutionBinding;
  bindings?: ExecutionBinding[];
  launch?: { entry: string; path: string; dev: string; ino: string; birth: string; ctime: string };
  generation: { id: string; version: string; inventorySha256: string };
}
export interface ExecutionInventoryEntry { path: string; sha256?: string; link?: string }
export const executionDescriptorName = ".cotal-execution.json";
export const executionSha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{32}$/;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid execution record");
  return value as Record<string, unknown>;
}

export function executionRecord(path: string): unknown {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_RECORD_BYTES) throw new Error("unsafe execution record");
  protectedExecutionEntry(path);
  const fd = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const current = fstatSync(fd);
    if (!current.isFile() || current.size > MAX_RECORD_BYTES ||
        (process.platform !== "win32" && ((current.mode & 0o022) !== 0 ||
          typeof process.getuid !== "function" || (current.uid !== process.getuid() && current.uid !== 0))))
      throw new Error("unsafe opened execution record");
    const bytes = readFileSync(fd);
    if (bytes.length > MAX_RECORD_BYTES) throw new Error("execution record exceeded its size limit");
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } finally { closeSync(fd); }
}

/** Read-only checks on a retained object. A missing or unreadable object is never a healthy generation. */
export function protectedExecutionEntry(path: string): void {
  const info = lstatSync(path);
  if (process.platform !== "win32" && ((!info.isSymbolicLink() && (info.mode & 0o022) !== 0) ||
      typeof process.getuid !== "function" || (info.uid !== process.getuid() && info.uid !== 0)))
    throw new Error(`unprotected execution entry: ${path}`);
}

export function executionBinding(root: string): ExecutionBinding {
  const meta = object(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
  if (meta.name !== "cotal-ai" || typeof meta.version !== "string" || !meta.version)
    throw new Error("the installed execution artifact is not cotal-ai");
  return { name: "cotal-ai", version: meta.version, bootstrapSha256: executionSha256(readFileSync(join(root, "dist", "cotal.js"))) };
}

export function executionStore(root: string): string {
  return join(dirname(dirname(root)), ".cotal-generations");
}

/** Enumerate the whole package, including dependencies, without following a link outside it. */
export function executionInventory(root: string): ExecutionInventoryEntry[] {
  const physical = realpathSync(root);
  const rows: ExecutionInventoryEntry[] = [];
  const walk = (directory: string, prefix: string): void => {
    protectedExecutionEntry(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(directory, entry.name), name = prefix ? `${prefix}/${entry.name}` : entry.name;
      protectedExecutionEntry(path);
      if (entry.isDirectory()) walk(path, name);
      else if (entry.isSymbolicLink()) {
        const target = readlinkSync(path), resolved = realpathSync(path), suffix = relative(physical, resolved);
        if (isAbsolute(target) || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix))
          throw new Error(`execution inventory link escapes its package: ${name}`);
        rows.push({ path: name, link: target });
      } else if (entry.isFile()) rows.push({ path: name, sha256: executionSha256(readFileSync(path)) });
      else throw new Error(`unsupported execution inventory entry: ${name}`);
    }
  };
  walk(physical, "");
  return rows;
}

export function executionLaunchBinding(root: string, entry: string): NonNullable<ExecutionDescriptor["launch"]> {
  const logical = resolve(entry), physical = realpathSync(logical);
  if (physical !== join(realpathSync(root), "dist", "cotal.js")) throw new Error("execution launch route does not resolve to this bootstrap");
  let path = join(realpathSync(root), "package.json");
  for (let current = dirname(logical); current !== dirname(current); current = dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) { path = current; break; }
  }
  const info = lstatSync(path, { bigint: true });
  return { entry: logical, path, dev: String(info.dev), ino: String(info.ino), birth: String(info.birthtimeNs), ctime: String(info.ctimeNs) };
}

export function executionDescriptorPath(root: string): string {
  return join(executionStore(root), `.active-${executionSha256(realpathSync(root))}.json`);
}

/** Select a verified program, or the installed first generation when no matching descriptor exists. */
export function selectExecutionProgram(root: string): { root: string; entry: string; retained: boolean } {
  const installed = realpathSync(root), descriptorPath = executionDescriptorPath(installed);
  const initial = () => ({ root: installed, entry: import.meta.url.endsWith(".ts") && installed === dirname(fileURLToPath(import.meta.url))
    ? join(installed, "cotal-program.ts") : join(installed, "dist", "cotal-program.js"), retained: false });
  let value: unknown;
  try { value = executionRecord(descriptorPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return initial(); throw error; }
  const descriptor = object(value), binding = object(descriptor.binding), current = executionBinding(installed);
  if (typeof binding.name !== "string" || typeof binding.version !== "string" || !binding.version ||
      typeof binding.bootstrapSha256 !== "string" || !HASH.test(binding.bootstrapSha256)) throw new Error("invalid execution artifact binding");
  if (descriptor.launch !== undefined) {
    const launch = object(descriptor.launch);
    if (!["entry", "path", "dev", "ino", "birth", "ctime"].every(key => typeof launch[key] === "string") || !isAbsolute(launch.entry as string) || !isAbsolute(launch.path as string))
      throw new Error("invalid execution launch binding");
    try { if (JSON.stringify(executionLaunchBinding(installed, launch.entry as string)) !== JSON.stringify(launch)) return initial(); }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return initial(); throw error; }
  }
  const matches = (candidate: Record<string, unknown>): boolean => candidate.name === current.name && candidate.version === current.version && candidate.bootstrapSha256 === current.bootstrapSha256;
  if (descriptor.bindings !== undefined && (!Array.isArray(descriptor.bindings) || descriptor.bindings.length > 4 ||
      descriptor.bindings.some(value => { const item = object(value); return item.name !== "cotal-ai" || typeof item.version !== "string" || !item.version || typeof item.bootstrapSha256 !== "string" || !HASH.test(item.bootstrapSha256); })))
    throw new Error("invalid execution transition bindings");
  if (!matches(binding) && !(descriptor.bindings as Record<string, unknown>[] | undefined)?.some(matches)) return initial();
  if (descriptor.v !== 1) throw new Error(`unsupported execution descriptor version ${String(descriptor.v)}`);
  if (process.platform === "win32") throw new Error("retained execution generations are unavailable on Windows");
  const generation = object(descriptor.generation);
  if (typeof generation.id !== "string" || !ID.test(generation.id) || typeof generation.version !== "string" ||
      typeof generation.inventorySha256 !== "string" || !HASH.test(generation.inventorySha256)) throw new Error("invalid retained execution identity");
  protectedExecutionEntry(installed);
  for (const ancestor of [dirname(installed), dirname(dirname(installed)), dirname(dirname(dirname(installed)))]) protectedExecutionEntry(ancestor);
  const store = executionStore(installed), container = join(store, generation.id), selected = join(container, "cotal-ai");
  for (const path of [store, container, selected]) {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe execution generation directory");
    protectedExecutionEntry(path);
  }
  const inventory = executionRecord(join(container, "inventory.json"));
  if (!Array.isArray(inventory) || executionSha256(JSON.stringify(inventory)) !== generation.inventorySha256 ||
      JSON.stringify(executionInventory(selected)) !== JSON.stringify(inventory)) throw new Error("retained execution inventory differs");
  const meta = object(JSON.parse(readFileSync(join(selected, "package.json"), "utf8")));
  if (meta.name !== "cotal-ai" || meta.version !== generation.version) throw new Error("retained execution manifest differs");
  return { root: selected, entry: join(selected, "dist", "cotal-program.js"), retained: true };
}

const executionStarted = Symbol.for("cotal.execution.started");
/** Explicit CLI delegation for a wrapper that imports the bootstrap rather than launching it. */
export function startExecutionProgram(): void {
  if (Reflect.get(globalThis, executionStarted)) return;
  Object.defineProperty(globalThis, executionStarted, { value: true });
  let selected: ReturnType<typeof selectExecutionProgram> | undefined;
  try { selected = selectExecutionProgram(resolve(dirname(fileURLToPath(import.meta.url)), import.meta.url.endsWith(".ts") ? "." : "..")); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}; reinstall with npm install -g cotal-ai@latest\n`);
    process.exitCode = 1;
  }
  if (selected) {
    if (!import.meta.url.endsWith(".ts")) Object.defineProperty(globalThis, Symbol.for("cotal.execution.identity"), {
      value: Object.freeze({ logicalEntry: fileURLToPath(import.meta.url), launchEntry: process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) ? resolve(process.argv[1]) : fileURLToPath(import.meta.url), loadedEntry: join(selected.root, "dist", "cotal.js") }),
      configurable: false, writable: false,
    });
    if (selected.retained || !process.argv[1] || realpathSync(process.argv[1]) !== fileURLToPath(import.meta.url)) process.argv[1] = join(selected.root, "dist", "cotal.js");
    void import(pathToFileURL(selected.entry).href);
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) startExecutionProgram();
