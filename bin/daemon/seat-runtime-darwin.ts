import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { executionInventory, protectedExecutionEntry } from "../cotal.js";
import { checkDir, ensureDir } from "./endpoint.js";
import { nativeRun } from "./install-native-run.js";

interface RetainedDarwinSeatRuntime {
  readonly generation: string;
  readonly node: string;
  readonly entry: string;
}

function immutableTree(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) for (const name of readdirSync(path)) immutableTree(join(path, name));
  chmodSync(path, info.mode & 0o555);
}

function nodeDigest(path: string): string {
  protectedExecutionEntry(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o100) === 0 || (stat.mode & 0o022) !== 0 || (stat.uid !== process.getuid?.() && stat.uid !== 0))
      throw new Error("the retained PTY host runtime has no verified Node executable");
    const hash = createHash("sha256"), buffer = Buffer.alloc(128 * 1024);
    let count: number;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) !== 0) hash.update(buffer.subarray(0, count));
    return hash.digest("hex");
  } finally { closeSync(fd); }
}

function copy(source: string, destination: string): void {
  if (nativeRun("/usr/bin/ditto", [source, destination], undefined, 45_000).status !== 0)
    throw new Error("could not retain the macOS PTY host runtime");
}

function signature(path: string): void {
  if (nativeRun("/usr/bin/codesign", ["--verify", "--strict", path], undefined, 10_000).status !== 0)
    throw new Error("the macOS PTY host Node signature did not verify");
}

/** A copied Node binary must not load mutable dylibs from the original installation. */
function requireStandaloneNode(path: string): void {
  const dependencies = nativeRun("/usr/bin/otool", ["-arch", "all", "-L", path], undefined, 10_000);
  const libraries = dependencies.stdout.split("\n").filter(line => /^\s+\S/.test(line));
  if (dependencies.status !== 0 || libraries.length === 0 || libraries.some(line => !/^\s+\/(?:usr\/lib|System\/Library)\//.test(line)))
    throw new Error("the macOS PTY host Node depends on files outside the retained runtime");
}

/** Stage a protected, immutable closure outside the install that npm or the app can replace. */
export function retainDarwinSeatRuntime(input: {
  home: string;
  node: string;
  root: string;
  entry: string;
  desktop: boolean;
}): RetainedDarwinSeatRuntime {
  if (process.platform !== "darwin") throw new Error("macOS PTY runtime retention is unavailable");
  const root = realpathSync.native(input.root), node = realpathSync.native(input.node), entry = realpathSync.native(input.entry);
  const suffix = relative(root, entry);
  if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix) || !lstatSync(entry).isFile() || !lstatSync(node).isFile())
    throw new Error("the macOS PTY host entry is outside its runtime closure");
  const hash = nodeDigest(node);
  const inventory = JSON.stringify(executionInventory(root));
  const underSource = relative(root, input.home);
  if ((!isAbsolute(underSource) && underSource !== ".." && !underSource.startsWith(`..${sep}`)) || input.home !== realpathSync.native(input.home))
    throw new Error("the macOS PTY runtime store has an unverified parent");
  checkDir(input.home);
  const store = join(input.home, "pty-host-runtimes");
  ensureDir(store);
  const generation = createHash("sha256").update(JSON.stringify([hash, suffix, inventory, input.desktop])).digest("hex");
  const retained = join(store, generation);
  if (lstatSync(retained, { throwIfNoEntry: false })) {
    verifyRuntime(retained, hash, inventory, input.desktop);
    return { generation, node: join(retained, "node", "cotal-node"), entry: join(retained, "runtime", suffix) };
  }
  const staging = mkdtempSync(join(store, ".copy-"));
  try {
    const stagedNode = join(staging, "node", "cotal-node");
    ensureDir(dirname(stagedNode));
    copy(node, stagedNode);
    copy(root, join(staging, "runtime"));
    if (nodeDigest(node) !== hash || JSON.stringify(executionInventory(root)) !== inventory) throw new Error("the macOS PTY runtime changed during retention");
    verifyRuntime(staging, hash, inventory, input.desktop);
    immutableTree(dirname(stagedNode));
    immutableTree(join(staging, "runtime"));
    try { renameSync(staging, retained); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      verifyRuntime(retained, hash, inventory, input.desktop);
    }
    return { generation, node: join(retained, "node", "cotal-node"), entry: join(retained, "runtime", suffix) };
  } finally {
    // A concurrent publisher may leave our not-yet-published copy. Only ever remove that copy.
    if (lstatSync(staging, { throwIfNoEntry: false })) {
      makeWritable(staging);
      rmSync(staging, { recursive: true });
    }
  }
}

function verifyRuntime(directory: string, hash: string, inventory: string, desktop: boolean): void {
  if (!lstatSync(directory).isDirectory()) throw new Error("the retained PTY runtime is not a real directory");
  protectedExecutionEntry(directory);
  const executable = join(directory, "node", "cotal-node"), runtime = join(directory, "runtime");
  if (realpathSync.native(executable) !== executable || realpathSync.native(runtime) !== runtime ||
      nodeDigest(executable) !== hash || JSON.stringify(executionInventory(runtime)) !== inventory)
    throw new Error("the retained PTY runtime differs from its execution generation");
  requireStandaloneNode(executable);
  if (desktop) signature(executable);
}

function makeWritable(path: string): void {
  const item = lstatSync(path);
  if (!item.isDirectory()) return;
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) makeWritable(join(path, name));
}
