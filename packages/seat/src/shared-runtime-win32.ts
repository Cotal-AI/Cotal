import { createHash } from "node:crypto";
import { closeSync, constants, copyFileSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkWindowsCustodyPath, checkWindowsCustodyRoot, makeWindowsCustodyDirectory } from "./shared-files-win32.js";
import { seatId } from "./record.js";
import { windowsSeatStore } from "./shared-slot-win32.js";

const seatPackage = dirname(dirname(fileURLToPath(import.meta.url)));
const requireHere = createRequire(import.meta.url);
const MAX_FILES = 4096;
const MAX_BYTES = 512 * 1024 * 1024;

type Entry = { name: string; source: string; bytes: number; sha256: string };

/** Only the host's execution closure, not a copy of the CLI, connector set or dependency cache.
 * The caller supplies the install tree the installer may replace. Host state lives beside the
 * inventory, never inside it.
 * Publish a complete, verified generation by rename. This function does not prune generations. */
export function retainWindowsSeatRuntime(install: string) {
  const store = windowsSeatStore(install);
  const native = `win32-${process.arch}`;
  if (native !== "win32-x64" && native !== "win32-arm64") throw new Error("Windows PTY runtime architecture is unsupported");
  const pty = packageRoot("@lydell/node-pty", requireHere);
  const serialize = packageRoot("@xterm/addon-serialize", requireHere);
  const ptyNative = `@lydell/node-pty-${native}`;
  const scan = inventory();
  scan.file(realpathSync.native(process.execPath), "node.exe");
  scan.file(join(seatPackage, "package.json"), "seat/package.json");
  scan.tree(join(seatPackage, "dist"), "seat/dist");
  scan.file(join(seatPackage, "build", "Release", native, "peercred.node"), `seat/build/Release/${native}/peercred.node`);
  const dependencies = [
    ["@lydell/node-pty", pty], [ptyNative, packageRoot(ptyNative, createRequire(join(pty, "package.json")))],
    ["@xterm/headless", packageRoot("@xterm/headless", requireHere)], ["@xterm/addon-serialize", serialize],
    ["@xterm/xterm", packageRoot("@xterm/xterm", createRequire(join(serialize, "package.json")))],
  ] as const;
  for (const [name, path] of dependencies) scan.tree(path, `node_modules/${name}`);
  const entries = scan.entries;
  const key = inventoryKey(entries);
  const generation = join(store, key);
  makeWindowsCustodyDirectory(generation);
  const root = join(generation, "runtime");
  try { verify(root, entries); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || exists(root)) throw error;
    publish(generation, root, entries);
  }
  return { root, key, program: join(root, "node.exe"), entry: join(root, "seat", "dist", "shared-custodian.js") };
}

/** Recompute the complete retained closure without consulting the replaceable installation. */
export function assertWindowsRetainedRuntime(root: string, key: string): void {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("unknown Windows PTY runtime generation");
  const scan = inventory();
  scan.tree(root, "", true);
  if (inventoryKey(scan.entries) !== key) throw new Error("Windows PTY runtime inventory does not match");
}

function inventoryKey(entries: Entry[]): string {
  entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
  return createHash("sha256").update(JSON.stringify(entries.map(({ name, bytes, sha256 }) => [name, bytes, sha256]))).digest("hex");
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function packageRoot(name: string, lookup: NodeJS.Require): string {
  let cursor = dirname(realpathSync.native(lookup.resolve(name)));
  for (;;) {
    const meta = join(cursor, "package.json");
    if (exists(meta) && (JSON.parse(readFileSync(meta, "utf8")) as { name?: unknown }).name === name) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error("Windows PTY runtime dependency does not resolve to its package");
    cursor = parent;
  }
}

function inventory() {
  const entries: Entry[] = [];
  let total = 0;
  const names = new Set<string>();
  const file = (source: string, name: string) => {
    const stat = lstatSync(source);
    const folded = name.toLowerCase();
    total += stat.size;
    if (!stat.isFile() || names.has(folded) || entries.length >= MAX_FILES || total > MAX_BYTES) throw new Error("Windows PTY runtime inventory is not bounded or canonical");
    names.add(folded);
    entries.push({ name, source, bytes: stat.size, sha256: hash(source, stat.size) });
  };
  const tree = (source: string, name: string, retained = false) => {
    const stack = [{ source, name }];
    let directories = 0;
    while (stack.length) {
      const dir = stack.pop()!;
      if (++directories > MAX_FILES || !lstatSync(dir.source).isDirectory() || realpathSync.native(dir.source).toLowerCase() !== dir.source.toLowerCase())
        throw new Error("Windows PTY runtime source contains an unknown directory");
      if (retained) checkWindowsCustodyRoot(dir.source);
      for (const child of readdirSync(dir.source, { withFileTypes: true })) {
        if (!retained && child.name === "node_modules") continue;
        const from = join(dir.source, child.name), to = dir.name ? `${dir.name}/${child.name}` : child.name;
        if (child.isDirectory()) stack.push({ source: from, name: to });
        else {
          if (retained) checkWindowsCustodyPath(from, false);
          file(from, to);
        }
      }
    }
  };
  return { entries, file, tree };
}

function hash(path: string, bytes: number): string {
  const digest = createHash("sha256"), chunk = Buffer.allocUnsafe(256 * 1024);
  const fd = openSync(path, "r");
  try {
    let total = 0;
    for (;;) {
      const got = readSync(fd, chunk, 0, Math.min(chunk.length, bytes + 1 - total), null);
      if (!got) break;
      total += got;
      if (total > bytes) throw new Error("Windows PTY runtime changed while reading it");
      digest.update(chunk.subarray(0, got));
    }
    if (total !== bytes) throw new Error("Windows PTY runtime changed while reading it");
    return digest.digest("hex");
  } finally { closeSync(fd); }
}

function verify(root: string, expected: Entry[]): void {
  checkWindowsCustodyRoot(root);
  const files = new Map(expected.map(entry => [entry.name, entry]));
  const dirs = new Set<string>();
  for (const entry of expected) for (let parent = entry.name; parent.includes("/");) {
    parent = parent.slice(0, parent.lastIndexOf("/"));
    dirs.add(parent);
  }
  const scan = [""];
  while (scan.length) {
    const name = scan.pop()!;
    const path = join(root, name);
    checkWindowsCustodyRoot(path);
    for (const child of readdirSync(path, { withFileTypes: true })) {
      const key = name ? `${name}/${child.name}` : child.name;
      if (child.isDirectory() && dirs.delete(key)) { scan.push(key); continue; }
      const entry = files.get(key);
      const file = join(root, key);
      if (!entry || !child.isFile()) throw new Error("Windows PTY runtime has an unexpected file");
      checkWindowsCustodyPath(file, false);
      if (lstatSync(file).size !== entry.bytes || hash(file, entry.bytes) !== entry.sha256) throw new Error("Windows PTY runtime inventory does not match");
      files.delete(key);
    }
  }
  if (files.size || dirs.size) throw new Error("Windows PTY runtime inventory is incomplete");
}

function publish(store: string, root: string, entries: Entry[]): void {
  const staging = join(store, `.stage-${seatId()}`);
  makeWindowsCustodyDirectory(staging);
  try {
    for (const entry of entries) {
      const path = join(staging, entry.name);
      mkdirSync(dirname(path), { recursive: true });
      copyFileSync(entry.source, path, constants.COPYFILE_EXCL);
    }
    verify(staging, entries);
    try { renameSync(staging, root); }
    catch (error) { if (!exists(root)) throw error; verify(root, entries); }
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
