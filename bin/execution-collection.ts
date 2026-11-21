import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { executionProcessScope, executionReferenceGeneration, visitExecutionServicePaths } from "@cotal-ai/workspace";
import { executionReadersName, executionSha256, protectedExecutionEntry } from "./cotal.js";

const id = /^[a-f0-9]{32}$/;

/** Check only protected reference roots and do not follow directory links. */
function hasExecutionReference(kind: string, root: string, target: string, uid: number): boolean {
  let parent = dirname(root);
  while (!lstatSync(parent, { throwIfNoEntry: false })) parent = dirname(parent);
  if (realpathSync.native(parent) !== parent) return true;
  for (let path = parent; path !== dirname(path); path = dirname(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || (stat.uid !== uid && stat.uid !== 0) ||
        ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0))) return true;
  }
  const observedDirectories: { path: string; dev: bigint; ino: bigint; ctimeNs: bigint }[] = [];
  let remaining = 100_000;
  const walk = (path: string, first: boolean): boolean => {
    if (--remaining < 0) return true;
    const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!stat) return !first;
    if (stat.uid !== BigInt(uid)) return true;
    if (stat.isSymbolicLink()) {
      const link = resolve(dirname(path), readlinkSync(path));
      if (link === target || link.startsWith(target + sep) || first) return true;
      try {
        const physical = realpathSync.native(path);
        return physical === target || physical.startsWith(target + sep);
      } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
    }
    if ((stat.mode & 0o022n) !== 0n) return true;
    if (stat.isDirectory() && kind === "tree") {
      observedDirectories.push({ path, dev: stat.dev, ino: stat.ino, ctimeNs: stat.ctimeNs });
      return readdirSync(path).some(name => walk(join(path, name), false));
    }
    if (!stat.isFile()) return true;
    if (kind === "record") {
      if (stat.size > 1024n * 1024n) return true;
      let referenced = false;
      visitExecutionServicePaths(readFileSync(path, "utf8"), value => {
        if (executionReferenceGeneration(value) === target) referenced = true;
        else {
          try { if (executionReferenceGeneration(realpathSync.native(value)) === target) referenced = true; }
          catch (error) { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) referenced = true; }
        }
      });
      return referenced;
    }
    return false;
  };
  // A promotion can move a reference between siblings while they are being read.
  return walk(root, true) || observedDirectories.some(before => {
    const after = lstatSync(before.path, { bigint: true, throwIfNoEntry: false });
    return !after?.isDirectory() || before.dev !== after.dev || before.ino !== after.ino || before.ctimeNs !== after.ctimeNs;
  });
}

/** The update lock excludes descriptor changes. The fence excludes readers and reference writers. */
export function collectExecutionGeneration(path: string, uid: number, remove: (path: string) => void): void {
  if (process.platform !== "linux" || !id.test(basename(path))) return;
  const container = lstatSync(path, { throwIfNoEntry: false });
  if (!container?.isDirectory() || container.uid !== uid) return;
  const readers = join(path, executionReadersName), info = lstatSync(readers, { throwIfNoEntry: false });
  if (!info || !info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) return;
  protectedExecutionEntry(path);
  const fence = join(path, ".collecting");
  const existing = lstatSync(fence, { throwIfNoEntry: false });
  if (existing) {
    if (!existing.isDirectory() || existing.uid !== uid || (existing.mode & 0o077) !== 0 || readdirSync(fence).length) return;
  } else mkdirSync(fence, { mode: 0o700 });
  let moved = false;
  try {
    const scope = executionProcessScope();
    if (!scope) return;
    for (const name of readdirSync(readers)) {
      const file = join(readers, name), entry = lstatSync(file, { throwIfNoEntry: false });
      if (!entry) continue;
      if (entry.uid !== uid || (entry.mode & 0o077) !== 0) return;
      if (entry.isDirectory()) {
        const match = /^([a-f0-9-]{36}-\d+)\.([1-9]\d*)-[A-Za-z0-9]+$/.exec(name);
        if (!match || match[1] !== scope) return;
        try { process.kill(Number(match[2]), 0); return; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return; }
      } else if (!entry.isFile() || !/^ref-[a-f0-9]{64}$/.test(name)) return;
    }
    // An admitted writer can finish and drop its process pin during the first scan. Read
    // durable references after checking those pins, while admission is still closed.
    for (const name of readdirSync(readers).filter(name => name.startsWith("ref-"))) {
      const file = join(readers, name), entry = lstatSync(file);
      if (!entry.isFile() || entry.uid !== uid || (entry.mode & 0o077) !== 0 || entry.size > 8192) return;
      const value = readFileSync(file, "utf8"), [kind, root, extra] = value.split("\n");
      if (!root || extra !== undefined || (kind !== "tree" && kind !== "record") || !isAbsolute(root) || resolve(root) !== root ||
          `ref-${executionSha256(value)}` !== name || hasExecutionReference(kind, root, path, uid)) return;
    }
    const retired = join(dirname(path), `.retired-${basename(path)}`);
    renameSync(path, retired);
    moved = true;
    remove(retired);
  } finally { if (!moved) rmdirSync(fence); }
}
