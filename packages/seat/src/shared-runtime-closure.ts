import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync,
  opendirSync, openSync, readSync, realpathSync, renameSync, rmSync, writeSync, type BigIntStats,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SEAT = "@cotal-ai/seat";
const PTY = "@lydell/node-pty";
const HEADLESS = "@xterm/headless";
const SERIALIZE = "@xterm/addon-serialize";
const SEAT_DIR = `node_modules/${SEAT}`;
const ENTRY = `${SEAT_DIR}/dist/shared-custodian.js`;
const NODE = "bin/node";
const MODULES = `${SEAT_DIR}/node_modules`;
const PTY_DIR = `${MODULES}/${PTY}`;
const HEADLESS_ENTRY = "lib-headless/xterm-headless.js";
const SERIALIZE_ENTRY = "lib/addon-serialize.js";
const MAX_ENTRIES = 512;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST = 128 * 1024;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const digestPattern = /^[a-f0-9]{64}$/;

export interface SharedRuntimeClosure {
  readonly digest: string;
  readonly root: string;
  readonly entryPath: string;
  readonly nodePath: string;
}

type Source = { path: string; source: string; mode: number; identity: string };
type Item = { path: string; mode: number; size: number; sha256: string };
type Budget = { bytes: number };

function refuse(reason: string): never {
  throw new Error(`shared PTY runtime closure: ${reason}`);
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function lookup(path: string): BigIntStats | undefined {
  try { return lstatSync(path, { bigint: true }); }
  catch (error) { if (!missing(error)) throw error; }
}

function stamp(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function directory(path: string): BigIntStats {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || realpathSync(path) !== path) refuse(`not a canonical directory: ${path}`);
  return stat;
}

function inPlaceSeatIdentity(): string {
  const module = fileURLToPath(import.meta.url);
  const dist = dirname(module), seat = dirname(dist);
  const roots = [seat, dist].map(path => stamp(directory(path)));
  const files = [join(seat, "package.json"), module, join(dist, "shared-custodian.js")].map(path => {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || realpathSync(path) !== path) refuse(`not a canonical seat identity file: ${path}`);
    return stamp(stat);
  });
  return JSON.stringify([...roots, ...files]);
}

// Capture while the Manager loads this module, not on its first shared launch. Unsupported
// layouts must still be able to import seat and use legacy custody; only a new copy is refused.
const loadedInPlaceSeatIdentity = (() => {
  if (process.platform !== "linux") return undefined;
  try { return inPlaceSeatIdentity(); } catch { return undefined; }
})();

function assertInPlaceSeatIdentity(): void {
  if (!loadedInPlaceSeatIdentity || loadedInPlaceSeatIdentity !== inPlaceSeatIdentity())
    refuse("installed seat changed since it was loaded");
}

function privateDirectory(path: string, mode: bigint): BigIntStats {
  const stat = directory(path);
  if (stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o7777n) !== mode)
    refuse(`unexpected directory ownership or permissions: ${path}`);
  return stat;
}

function platform(): void {
  if (process.platform !== "linux" || (process.arch !== "x64" && process.arch !== "arm64"))
    refuse(`unsupported platform ${process.platform}-${process.arch}`);
}

function storePath(store: string, create = false): string {
  platform();
  if (!isAbsolute(store)) refuse("closure store must be absolute");
  const path = resolve(store);
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory()) refuse("closure store must be a real directory");
  const canonical = realpathSync(path);
  privateDirectory(canonical, 0o700n);
  return canonical;
}

// O_NOFOLLOW covers the leaf. Checking the opened descriptor also rejects an intermediate link
// or rename outside the canonical tree. /proc/self/exe is the one intentional kernel link.
function readFile<T>(path: string, limit: number, fn: (fd: number, stat: BigIntStats) => T): T {
  const node = path === "/proc/self/exe";
  const fd = openSync(path, node ? constants.O_RDONLY : READ_FLAGS);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(limit) ||
        (node ? (before.mode & 0o111n) === 0n : realpathSync(`/proc/self/fd/${fd}`) !== path))
      refuse(`not a bounded regular runtime file: ${path}`);
    const result = fn(fd, before);
    if (stamp(before) !== stamp(fstatSync(fd, { bigint: true })) ||
        (!node && (realpathSync(`/proc/self/fd/${fd}`) !== path || stamp(before) !== stamp(lstatSync(path, { bigint: true })))))
      refuse(`runtime file changed while being read: ${path}`);
    return result;
  } finally { closeSync(fd); }
}

function hashFile(path: string, name: string, mode: number, budget: Budget, dest?: number): { item: Item; stamp: string } {
  return readFile(path, MAX_BYTES - budget.bytes, (fd, stat) => {
    const size = Number(stat.size);
    const hash = createHash("sha256");
    const buf = Buffer.allocUnsafe(Math.min(size, 1024 * 1024));
    let done = 0;
    while (done < size) {
      const count = readSync(fd, buf, 0, Math.min(buf.length, size - done), null);
      if (count === 0) refuse(`truncated runtime file: ${path}`);
      hash.update(buf.subarray(0, count));
      if (dest !== undefined) {
        for (let offset = 0; offset < count;) {
          const written = writeSync(dest, buf, offset, count - offset);
          if (written === 0) refuse(`short write for ${name}`);
          offset += written;
        }
      }
      done += count;
    }
    budget.bytes += size;
    return { item: { path: name, mode, size, sha256: hash.digest("hex") }, stamp: stamp(stat) };
  });
}

function readText(path: string, limit: number): string {
  return readFile(path, limit, (fd, stat) => {
    const buf = Buffer.allocUnsafe(Number(stat.size));
    for (let offset = 0; offset < buf.length;) {
      const count = readSync(fd, buf, offset, buf.length - offset, null);
      if (!count) refuse(`truncated runtime metadata: ${path}`);
      offset += count;
    }
    return buf.toString("utf8");
  });
}

function names(path: string): string[] {
  const dir = opendirSync(path);
  const entries: string[] = [];
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      if (entries.length >= MAX_ENTRIES) refuse(`too many runtime entries under ${path}`);
      entries.push(entry.name);
    }
  } finally { dir.closeSync(); }
  return entries.sort();
}

function packageInfo(root: string, name: string): { version: string; type?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> } {
  const meta = JSON.parse(readText(join(root, "package.json"), MAX_MANIFEST));
  if (meta?.name !== name || typeof meta.version !== "string") refuse(`unexpected package metadata for ${name}`);
  return meta;
}

function workspaceDependency(store: string, modules: string, name: string, entry: string, resolved: string, identities: string[]): string {
  directory(modules);
  const link = join(modules, name);
  directory(dirname(link));
  const linkStat = lstatSync(link, { bigint: true });
  if (!linkStat.isSymbolicLink()) refuse(`expected a pnpm workspace link for ${name}`);
  const root = realpathSync(link);
  const [slot, ...tail] = relative(store, root).split("/");
  const prefix = `${name.replace("/", "+")}@`;
  if (!slot.startsWith(prefix) || tail.join("/") !== `node_modules/${name}` || join(root, entry) !== resolved)
    refuse(`unexpected pnpm workspace resolution of ${name}`);
  directory(root);
  if (stamp(linkStat) !== stamp(lstatSync(link, { bigint: true }))) refuse(`workspace link changed: ${name}`);
  identities.push(`${link}:${stamp(linkStat)}`);
  return root;
}

// Locate each dependency in the installing tree, then check Node's actual resolution from the
// importer. No NODE_PATH/global fallbacks, and no package directory symlinks. A nested private
// node_modules for each importer preserves the dependency edges even if npm hoisted the sources.
function dependency(install: string, from: string, name: string, entry: string, resolved: string): string {
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (lookup(candidate)) {
      directory(candidate);
      if (join(candidate, entry) !== resolved) refuse(`unexpected resolution of ${name} from ${from}`);
      return candidate;
    }
    if (dir === install) refuse(`cannot locate ${name} within ${install}`);
  }
}

function sourcePlan(stagedRoot?: string): { files: Source[]; identities: string[] } {
  const here = fileURLToPath(import.meta.url);
  const seat = dirname(dirname(here));
  const seatModules = dirname(dirname(dirname(seat)));
  const checkout = dirname(dirname(seat));
  const workspace = seat === join(checkout, "packages/seat");
  const store = join(checkout, "node_modules/.pnpm");
  let install = seatModules;
  for (let dir = dirname(seatModules); dir !== dirname(dir); dir = dirname(dir)) {
    if (dir.endsWith("/node_modules")) install = dirname(dir);
  }
  if (stagedRoot !== undefined) {
    if (workspace || stagedRoot !== seatModules) refuse("seat package is not inside the pinned generation");
    install = stagedRoot;
  }
  const from = join(seat, "dist/shared-custodian.js");
  const files: Source[] = [];
  const identities: string[] = [];
  const track = (dir: string) => identities.push(`${dir}:${stamp(directory(dir))}`);
  const add = (root: string, target: string, name: string, mode = 0o400) => {
    const source = join(root, name);
    const stat = lstatSync(source, { bigint: true });
    if (!stat.isFile() || realpathSync(source) !== source) refuse(`not a canonical runtime file: ${source}`);
    files.push({ path: `${target}/${name}`, source, mode, identity: stamp(stat) });
  };
  const addPackage = (root: string, target: string, name: string) => {
    track(root);
    add(root, target, "package.json");
    return packageInfo(root, name);
  };

  if ((!workspace && seat !== join(seatModules, SEAT_DIR)) || here !== join(seat, "dist/shared-runtime-closure.js"))
    refuse("expected built seat package");
  const seatInfo = addPackage(seat, SEAT_DIR, SEAT);
  if (seatInfo.type !== "module") refuse("expected built ESM seat package");
  const direct = (name: string, entry: string, url: string) => {
    const resolved = fileURLToPath(url);
    if (!workspace) return dependency(install, from, name, entry, resolved);
    if (typeof seatInfo.dependencies?.[name] !== "string") refuse(`workspace seat does not declare ${name}`);
    return workspaceDependency(store, join(seat, "node_modules"), name, entry, resolved, identities);
  };
  if (workspace) {
    const workspaceFile = join(checkout, "pnpm-workspace.yaml");
    readText(workspaceFile, MAX_MANIFEST);
    identities.push(`${workspaceFile}:${stamp(lstatSync(workspaceFile, { bigint: true }))}`);
    track(store);
  }
  track(join(seat, "dist"));
  for (const file of names(join(seat, "dist"))) {
    if (/^[\w-]+\.js$/.test(file)) add(seat, SEAT_DIR, `dist/${file}`);
  }
  if (!files.some(file => file.path === ENTRY)) refuse("missing built shared custodian entry");
  const arch = `linux-${process.arch}`;
  add(seat, SEAT_DIR, `build/Release/${arch}/peercred.node`);

  const pty = direct(PTY, "index.js", import.meta.resolve("@lydell/node-pty"));
  const ptyInfo = addPackage(pty, PTY_DIR, PTY);
  if (workspace && seatInfo.dependencies?.[PTY] !== ptyInfo.version) refuse("workspace node-pty version does not match seat manifest");
  add(pty, PTY_DIR, "index.js");
  const nativeName = `${PTY}-${arch}`;
  const ptyEntry = join(pty, "index.js");
  const nativeEntry = createRequire(ptyEntry).resolve(nativeName);
  const native = workspace
    ? workspaceDependency(store, dirname(dirname(pty)), nativeName, "lib/index.js", nativeEntry, identities)
    : dependency(install, ptyEntry, nativeName, "lib/index.js", nativeEntry);
  const nativeTarget = `${PTY_DIR}/node_modules/${nativeName}`;
  const nativeInfo = addPackage(native, nativeTarget, nativeName);
  if (ptyInfo.optionalDependencies?.[nativeName] !== nativeInfo.version)
    refuse("node-pty and its platform package have different versions");
  track(join(native, "lib"));
  for (const file of names(join(native, "lib"))) {
    if (/^[\w-]+\.js$/.test(file)) add(native, nativeTarget, `lib/${file}`);
  }
  // The published Linux package uses prebuilds. A development binary in an earlier loader
  // slot makes it ambiguous which runtime the source would load, so refuse that layout.
  for (const base of ["", "lib/"]) {
    for (const dir of ["build/Release", "build/Debug"]) {
      if (lookup(join(native, `${base}${dir}/pty.node`))) refuse("unexpected local node-pty build");
    }
  }
  const prebuild = `prebuilds/${arch}`;
  track(join(native, prebuild));
  add(native, nativeTarget, `${prebuild}/pty.node`);
  const helper = `${prebuild}/spawn-helper`;
  if (lookup(join(native, helper))) add(native, nativeTarget, helper, 0o500);

  // addon-serialize's browser xterm peer is used only for types, not by its shipped JS.
  for (const [name, entry, url] of [
    [HEADLESS, HEADLESS_ENTRY, import.meta.resolve("@xterm/headless")],
    [SERIALIZE, SERIALIZE_ENTRY, import.meta.resolve("@xterm/addon-serialize")],
  ]) {
    const root = direct(name, entry, url);
    addPackage(root, `${MODULES}/${name}`, name);
    add(root, `${MODULES}/${name}`, entry);
  }
  const node = "/proc/self/exe";
  files.push({ path: NODE, source: node, mode: 0o500, identity: readFile(node, MAX_BYTES, (_fd, stat) => stamp(stat)) });
  if (files.length > MAX_ENTRIES) refuse("too many runtime files");
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files, identities };
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function manifest(items: Item[]): string {
  return JSON.stringify({ version: 1, platform: process.platform, arch: process.arch, items });
}

// Rebuild the inventory instead of walking untrusted paths from a manifest. An extra file (even
// empty), directory, hard link or symlink makes reuse fail, rather than altering it in place.
function inspect(root: string): string {
  const items: Item[] = [];
  const budget = { bytes: 0 };
  const uid = BigInt(process.getuid!());
  const dirs = new Set<string>();
  let count = 0;
  const visit = (path: string, depth: number) => {
    if (depth > 16) refuse("runtime inventory is too deep");
    const dir = join(root, path);
    const before = privateDirectory(dir, 0o500n);
    dirs.add(path);
    for (const name of names(dir)) {
      if (++count > MAX_ENTRIES || !/^[\w@.-]+$/.test(name)) refuse("invalid runtime inventory entry");
      const rel = path ? `${path}/${name}` : name;
      const absolute = join(root, rel);
      const stat = lstatSync(absolute, { bigint: true });
      if (stat.isDirectory()) { visit(rel, depth + 1); continue; }
      const mode = rel === NODE || rel.endsWith("/spawn-helper") ? 0o500 : 0o400;
      if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== uid || (stat.mode & 0o7777n) !== BigInt(mode))
        refuse(`invalid published runtime file: ${rel}`);
      if (rel !== "inventory.json") {
        const file = hashFile(absolute, rel, mode, budget);
        if (file.stamp !== stamp(stat)) refuse(`published runtime changed: ${rel}`);
        items.push(file.item);
      }
    }
    if (stamp(before) !== stamp(privateDirectory(dir, 0o500n))) refuse(`published runtime directory changed: ${path}`);
  };
  visit("", 0);
  for (const { path } of items) {
    for (let dir = dirname(path); dir !== "."; dir = dirname(dir)) dirs.delete(dir);
  }
  const arch = `linux-${process.arch}`;
  const native = `${PTY_DIR}/node_modules/${PTY}-${arch}`;
  const required = [ENTRY, NODE, `${SEAT_DIR}/package.json`, `${SEAT_DIR}/build/Release/${arch}/peercred.node`,
    `${PTY_DIR}/package.json`, `${PTY_DIR}/index.js`, `${native}/package.json`, `${native}/lib/index.js`,
    `${native}/prebuilds/${arch}/pty.node`, `${MODULES}/${HEADLESS}/package.json`, `${MODULES}/${HEADLESS}/${HEADLESS_ENTRY}`,
    `${MODULES}/${SERIALIZE}/package.json`, `${MODULES}/${SERIALIZE}/${SERIALIZE_ENTRY}`];
  if (dirs.size !== 1 || !dirs.has("") || !required.every(path => items.some(item => item.path === path)))
    refuse("incomplete runtime inventory");
  items.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const expected = manifest(items);
  if (expected !== readText(join(root, "inventory.json"), MAX_MANIFEST)) refuse("runtime inventory mismatch");
  return hashText(expected);
}

/** Verify a retained closure independently of the original installation. Throws on any mismatch. */
export function verifySharedRuntimeClosure(store: string, digest: string): SharedRuntimeClosure {
  const base = storePath(store);
  if (!digestPattern.test(digest)) refuse("invalid runtime digest");
  const root = join(base, digest);
  if (inspect(root) !== digest) refuse("runtime digest mismatch");
  return { digest, root, entryPath: join(root, ENTRY), nodePath: join(root, NODE) };
}

export interface VerifiedStagedRuntimeSource {
  readonly root: string;
  readonly inventorySha256: string;
}

// The caller supplies the full bootstrap inventory proof and keeps the generation pinned. We
// bind that proof to the exact generation path and confirm the entry against its named inventory.
function stagedEntry(source: VerifiedStagedRuntimeSource): string {
  const { root, inventorySha256 } = source;
  const generation = dirname(root);
  const generations = dirname(generation);
  if (!isAbsolute(root) || root !== join(generation, "cotal-ai") ||
      !generation.slice(generations.length + 1).match(/^[a-f0-9]{32}$/) ||
      !generations.endsWith("/.cotal-generations") || !digestPattern.test(inventorySha256))
    refuse("invalid verified staged generation");
  directory(root);
  const rows: unknown = JSON.parse(readText(join(generation, "inventory.json"), 4 * 1024 * 1024));
  if (!Array.isArray(rows) || hashText(JSON.stringify(rows)) !== inventorySha256)
    refuse("staged execution inventory digest mismatch");
  const entries = rows.filter(row => row?.path === ENTRY);
  const entry = join(root, ENTRY);
  if (entries.length !== 1 || typeof entries[0].sha256 !== "string" ||
      hashFile(entry, ENTRY, 0o400, { bytes: 0 }).item.sha256 !== entries[0].sha256)
    refuse("staged custodian does not match its execution inventory");
  return entry;
}

function stagedDigest(source: VerifiedStagedRuntimeSource, node: Item): string {
  return hashText(JSON.stringify({ version: 1, kind: "staged", arch: process.arch,
    root: source.root, inventorySha256: source.inventorySha256, node }));
}

function inspectStagedNode(root: string): Item {
  privateDirectory(root, 0o500n);
  privateDirectory(join(root, "bin"), 0o500n);
  if (names(root).join("/") !== "bin" || names(join(root, "bin")).join("/") !== "node")
    refuse("unexpected staged Node inventory");
  const path = join(root, NODE);
  const info = lstatSync(path, { bigint: true });
  if (!info.isFile() || info.nlink !== 1n || info.uid !== BigInt(process.getuid!()) || (info.mode & 0o7777n) !== 0o500n)
    refuse("unsafe staged Node file");
  const node = hashFile(path, NODE, 0o500, { bytes: 0 });
  if (node.stamp !== stamp(info)) refuse("staged Node changed during verification");
  return node.item;
}

/** Recheck the private Node and bind it to an already verified, pinned generation. */
export function verifyStagedSharedRuntime(store: string, digest: string, source: VerifiedStagedRuntimeSource): SharedRuntimeClosure {
  const base = storePath(store);
  if (!digestPattern.test(digest)) refuse("invalid staged runtime digest");
  const root = join(base, digest);
  const entryPath = stagedEntry(source);
  if (stagedDigest(source, inspectStagedNode(root)) !== digest) refuse("staged runtime digest mismatch");
  return { digest, root, entryPath, nodePath: join(root, NODE) };
}

/** Retain only Node for a bootstrap-verified package tree. No package copy or dispatch here. */
export function prepareStagedSharedRuntime(store: string, source: VerifiedStagedRuntimeSource): SharedRuntimeClosure {
  platform();
  const entry = stagedEntry(source);
  if (entry !== join(dirname(fileURLToPath(import.meta.url)), "shared-custodian.js"))
    refuse("staged generation does not contain this seat package");
  const plan = sourcePlan(source.root);
  const base = storePath(store, true);
  const stage = mkdtempSync(join(base, ".stage-"));
  const bin = join(stage, "bin");
  let published = false;
  try {
    mkdirSync(bin, { mode: 0o700 });
    const nodePath = join(stage, NODE);
    const fd = openSync(nodePath, "wx", 0o600);
    let node: Item;
    try {
      node = hashFile("/proc/self/exe", NODE, 0o500, { bytes: 0 }, fd).item;
      fchmodSync(fd, 0o500);
    } finally { closeSync(fd); }
    chmodSync(bin, 0o500);
    chmodSync(stage, 0o500);
    const digest = stagedDigest(source, node);
    if (stagedDigest(source, inspectStagedNode(stage)) !== digest) refuse("staged Node copy differs");
    probeRuntime(nodePath, entry, join(source.root, SEAT_DIR), stage);
    stagedEntry(source);
    if (JSON.stringify(plan) !== JSON.stringify(sourcePlan(source.root))) refuse("staged runtime source changed");
    const root = join(base, digest);
    if (!lookup(root)) {
      try { renameSync(stage, root); published = true; }
      catch (error) { if (!lookup(root)) throw error; }
    }
    return verifyStagedSharedRuntime(base, digest, source);
  } finally {
    if (!published) {
      chmodSync(stage, 0o700);
      if (lookup(bin)) chmodSync(bin, 0o700);
      rmSync(stage, { recursive: true, force: true });
    }
  }
}

// Load both native addons and the actual host dependency graph without entering its dispatch path.
function probeRuntime(node: string, entry: string, seat: string, cwd: string): void {
  const entryURL = JSON.stringify(pathToFileURL(entry).href);
  const peer = JSON.stringify(join(seat, `build/Release/linux-${process.arch}/peercred.node`));
  const script = `import { createRequire } from 'node:module';\nawait import(${entryURL});\ncreateRequire(${entryURL})(${peer});`;
  const probe = spawnSync(node, ["--no-global-search-paths", "--input-type=module", "--eval", script],
    { cwd, env: {}, stdio: "ignore", timeout: 5000, killSignal: "SIGKILL" });
  if (probe.status !== 0) refuse("copied Node or host runtime failed its load check");
}

/** Prepare a Linux in-place installation's closure before dispatch. No published closure is
 * changed or collected here. The caller must keep the store outside any installation/updater tree. */
export function prepareSharedRuntimeClosure(store: string): SharedRuntimeClosure {
  platform();
  assertInPlaceSeatIdentity();
  const base = storePath(store, true);
  const plan = sourcePlan();
  const stage = mkdtempSync(join(base, ".stage-"));
  const dirs = new Set([stage]);
  let published = false;
  try {
    const makeParents = (dir: string) => {
      if (dirs.has(dir)) return;
      makeParents(dirname(dir));
      mkdirSync(dir, { mode: 0o700 });
      dirs.add(dir);
    };
    const budget = { bytes: 0 };
    const captured = plan.files.map(({ path, source, mode, identity }) => {
      const dest = join(stage, path);
      makeParents(dirname(dest));
      const fd = openSync(dest, "wx", 0o600);
      try {
        const file = hashFile(source, path, mode, budget, fd);
        if (file.stamp !== identity) refuse(`runtime source changed: ${path}`);
        fchmodSync(fd, mode);
        return file;
      } finally { closeSync(fd); }
    });
    const inventory = manifest(captured.map(file => file.item));
    const digest = hashText(inventory);
    const inventoryFd = openSync(join(stage, "inventory.json"), "wx", 0o400);
    try {
      if (writeSync(inventoryFd, inventory) !== Buffer.byteLength(inventory)) refuse("short inventory write");
      fchmodSync(inventoryFd, 0o400);
    } finally { closeSync(inventoryFd); }
    for (const dir of [...dirs].reverse()) chmodSync(dir, 0o500);
    if (inspect(stage) !== digest) refuse("staged runtime digest mismatch");

    probeRuntime(join(stage, NODE), join(stage, ENTRY), join(stage, SEAT_DIR), stage);

    // Resolve and enumerate again as well as comparing every source's identity and contents.
    // This catches package replacement, mixed snapshots, and changes to the relevant file set.
    if (JSON.stringify(plan) !== JSON.stringify(sourcePlan())) refuse("runtime source layout changed");
    const recheck = { bytes: 0 };
    for (const [index, { path, source, mode }] of plan.files.entries()) {
      const file = hashFile(source, path, mode, recheck);
      if (file.stamp !== captured[index].stamp || file.item.sha256 !== captured[index].item.sha256)
        refuse(`runtime source changed: ${path}`);
    }
    if (JSON.stringify(plan) !== JSON.stringify(sourcePlan())) refuse("runtime source layout changed");

    assertInPlaceSeatIdentity();
    const root = join(base, digest);
    if (!lookup(root)) {
      try { renameSync(stage, root); published = true; }
      catch (error) {
        // A concurrent preparation may have published the same nonempty directory first.
        if (!lookup(root)) throw error;
      }
    }
    return verifySharedRuntimeClosure(base, digest);
  } finally {
    if (!published) {
      for (const dir of dirs) chmodSync(dir, 0o700);
      rmSync(stage, { recursive: true, force: true });
    }
  }
}
