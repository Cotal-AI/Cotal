import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, type Stats } from "node:fs";
import { dirname, join, relative, resolve, sep, isAbsolute } from "node:path";
import { token } from "@cotal-ai/core";
import { authDir, c, CommandFailure, controlDirectory, foreignStoreEntries, loadMeshes, loadPreparedSpaces, protectedLocalDirectory } from "@cotal-ai/workspace";
import { readStackJournal } from "./stack-journal.js";

/** The stores the broker configurations `root`'s starts rendered name. */
function renderedStores(root: string, resolveFrom?: string): string[] {
  const stores: string[] = [];
  for (const conf of [join(authDir(root), "server.conf"), join(root, ".cotal", "server-open.conf")]) {
    if (!existsSync(conf)) continue;
    // The core renderer writes the path as a JSON string.
    const named = /jetstream \{ store_dir: ("(?:[^"\\]|\\.)*")/.exec(readFileSync(conf, "utf8"))?.[1];
    if (named !== undefined) stores.push(resolveFrom === undefined ? resolve(JSON.parse(named) as string) : resolve(resolveFrom, JSON.parse(named) as string));
  }
  return stores;
}

/** The store `root`'s last broker served, when it differs from `storeDir` and still holds JetStream
 *  data. `down` drops the record that named a custom or restored store, but each real start writes
 *  its `store_dir` into the broker config it renders, and that file outlives `down`. */
export function lastServedStore(root: string, storeDir: string): string | undefined {
  return renderedStores(root).find((last) => last !== resolve(storeDir) && existsSync(join(last, "jetstream")));
}

/** Whether a broker configuration `root`'s last start rendered names the store `storeDir`. */
export function servedStore(root: string, storeDir: string): boolean {
  return renderedStores(root, root).some((path) => samePath(path, storeDir));
}

/** Another space whose record names a store folder, or whose streams are in it. */
export interface StoreTenant {
  space: string;
  /** The root its record names, when a record names the folder. */
  root?: string;
  /** Its CHAT_, DM_ and TASK_ streams in the folder. */
  streams: string[];
}

const SPACE_STREAM = /^(?:CHAT|DM|TASK)_(.+)$/;

const realOrResolved = (path: string): string => { try { return realpathSync.native(path); } catch { return resolve(path); } };
const samePath = (a: string, b: string): boolean => realOrResolved(a) === realOrResolved(b);

/** The spaces other than `space` that use the store folder `dir`. One uses it when its registration,
 *  or its prepared root's stack journal or rendered broker configuration, names the folder, or when
 *  its streams are under any account in the folder's `jetstream` tree, whether or not a broker runs
 *  there: nats-server takes no lock on its store folder, so a broker of another space starts on it,
 *  and a reset or clean of the folder removes that space's data too. A record that cannot be read
 *  is not counted; its streams still are. */
export function otherStoreTenants(dir: string, space: string): StoreTenant[] {
  const tenants = new Map<string, StoreTenant>();
  const tenant = (name: string): StoreTenant => tenants.get(name) ?? tenants.set(name, { space: name, streams: [] }).get(name)!;
  const own = token(space);
  let meshes: ReturnType<typeof loadMeshes> = [];
  try { meshes = loadMeshes(); } catch { meshes = []; }
  for (const mesh of meshes) {
    const store = mesh.storeDir ?? (mesh.origin === "up" ? join(mesh.root, ".cotal", "nats") : undefined);
    if (mesh.space !== space && store !== undefined && samePath(store, dir)) tenant(mesh.space).root = mesh.root;
  }
  let prepared: ReturnType<typeof loadPreparedSpaces> = [];
  try { prepared = loadPreparedSpaces(); } catch { prepared = []; }
  for (const row of prepared) {
    if (row.space === space) continue;
    let recorded: string | undefined;
    try { const journal = readStackJournal(row.root)?.journal; recorded = journal?.space === row.space ? journal.broker?.storeDir : undefined; } catch { recorded = undefined; }
    let named: boolean;
    try { named = recorded !== undefined ? samePath(resolve(row.root, recorded), dir) : servedStore(row.root, dir); } catch { named = false; }
    if (named) tenant(row.space).root = row.root;
  }
  const jetstream = join(dir, "jetstream");
  let accounts: string[] = [];
  try { accounts = readdirSync(jetstream); } catch { accounts = []; }
  for (const account of accounts) {
    let streams: string[] = [];
    try { streams = readdirSync(join(jetstream, account, "streams")); } catch { streams = []; }
    for (const stream of streams) {
      const name = SPACE_STREAM.exec(stream)?.[1];
      if (name !== undefined && name !== own) tenant(name).streams.push(stream);
    }
  }
  return [...tenants.values()].map((row) => ({ ...row, streams: row.streams.sort() })).sort((a, b) => a.space.localeCompare(b.space));
}

/** The tenants as one clause: each space, the root a record names and its streams in the folder. */
export function storeTenantsText(tenants: readonly StoreTenant[]): string {
  return tenants.map((row) => `space ${row.space}${row.root ? ` at ${row.root}` : ""}${row.streams.length ? ` (streams ${listEntries(row.streams)})` : ""}`).join("; ");
}

/** Refuse a start of `space` on the store folder `dir` while another space uses it, unless `recorded`
 *  says it is this space's own recorded or default store, which starts with a warning. Returns the
 *  other spaces for that warning. */
export function sharedStoreAtStart(dir: string, space: string, recorded: boolean): StoreTenant[] {
  const tenants = otherStoreTenants(dir, space);
  if (tenants.length && !recorded)
    throw new CommandFailure("refused", "CONFLICT", `the --store-dir ${dir} is the store of ${storeTenantsText(tenants)}, and a store folder belongs to one space; nothing was started`, { target: { space, storeDir: dir, otherSpaces: tenants }, remedy: "name a folder no other space uses with --store-dir, or omit it to use this root's .cotal/nats" });
  return tenants;
}

/** The warning for a start on its recorded store that another space also uses. */
export function sharedStoreWarning(dir: string, tenants: readonly StoreTenant[]): string {
  return `the store ${dir} also belongs to ${storeTenantsText(tenants)}; a store folder belongs to one space, and cotal reset store, cotal reset space and cotal clean store refuse it while both use it`;
}

/** The warning for a start whose recorded store is missing. */
export function missingStoreWarning(dir: string): string {
  return `the recorded store ${dir} is missing, so the broker opens a new empty store there and this space's history starts empty`;
}

/** Refuse to remove the store folder `path` of `space` while another space uses it. */
export function refuseSharedStoreRemoval(path: string, space: string): void {
  const tenants = otherStoreTenants(path, space);
  if (tenants.length)
    throw new CommandFailure("refused", "CONFLICT", `the store ${path} also belongs to ${storeTenantsText(tenants)}, and removing it would delete that data too; nothing was removed`, { target: { space, storeDir: path, otherSpaces: tenants }, remedy: `keep it while either space needs its history; once neither does, stop both with cotal down and remove ${path} by hand` });
}

/** The entries of a restore's old store that no Cotal store writes, which no cleanup deletes: none
 *  when that store is gone or is not a folder. */
export function oldStoreForeignEntries(path: string | undefined): string[] {
  return path !== undefined && statIfPresent(path, lstatSync)?.isDirectory() ? foreignStoreEntries(path) : [];
}

/** The refusal for a store that holds `entries` no Cotal store writes. `held` says why that matters,
 *  `outcome` what did not happen, and `retry` is the command to run once they are moved out. */
export function foreignEntriesRefusal(path: string, entries: readonly string[], held: string, outcome: string, retry: string, target: Readonly<Record<string, unknown>> = {}): CommandFailure {
  return new CommandFailure("refused", "CONFLICT", `${held} ${path} also holds ${listEntries(entries)}, which no Cotal store writes; ${outcome}`, {
    target: { ...target, storeDir: path, entries: [...entries] },
    remedy: `move ${entries.length === 1 ? "it" : "them"} out of ${path}, then run ${retry} again`,
  });
}

/** Up to five entry names, then how many more there are. */
export function listEntries(entries: readonly string[]): string {
  return entries.length > 5 ? `${entries.slice(0, 5).join(", ")} and ${entries.length - 5} more` : entries.join(", ");
}

/** The entry at `path`, or nothing when it is missing. A path under a regular file is missing too,
 *  so the walk up reaches that file and names it. */
function statIfPresent(path: string, stat: (path: string) => Stats = statSync): Stats | undefined {
  try { return stat(path); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined; throw error; }
}

/** Check an explicit `--store-dir` before anything is written. Its nearest existing part must be a
 *  directory, so a regular file there is a usage refusal that names it, and that directory's chain
 *  is held to the project-root rule for other local writers. A path still to create needs that
 *  directory to be writable by this account. A non-empty directory is accepted, because it may be
 *  an existing store. A control directory, or a path in one, is refused unless it is `root`'s own
 *  default store: its files would mix with credentials and records, or with another root's store,
 *  and no reset could remove it alone. A link is refused and the directory it points to is named:
 *  the broker config records the path as given, and a reset removes only a real directory. */
export function assertStoreDirArgument(value: string, root: string): void {
  const path = resolve(value);
  // A dangling link has no real path, so its own target is named instead.
  if (statIfPresent(path, lstatSync)?.isSymbolicLink()) {
    let real: string | undefined;
    try { real = realpathSync.native(path); } catch { real = undefined; }
    throw new CommandFailure("refused", "USAGE_INVALID", `the --store-dir path ${path} is a link to ${real ?? `${readlinkSync(path)}, which does not exist`}; nothing was started or written`, { target: { storeDir: path, ...(real ? { linkTarget: real } : {}) }, remedy: real ? `name the directory itself with --store-dir ${real}` : "name a real directory with --store-dir" });
  }
  let existing = path, stat = statIfPresent(existing);
  while (!stat) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
    stat = statIfPresent(existing);
  }
  const physical = stat ? join(realpathSync.native(existing), relative(existing, path)) : path;
  const control = controlDirectory(path) ?? controlDirectory(physical);
  if (control !== undefined && path !== join(resolve(root), ".cotal", "nats"))
    throw new CommandFailure("refused", "USAGE_INVALID", `the --store-dir path ${path} is ${path === control ? "" : "in "}the control directory ${control}; nothing was started or written`, { target: { storeDir: path, controlDirectory: control }, remedy: "name a directory outside any .cotal with --store-dir, or omit it to use this root's .cotal/nats" });
  if (!stat) return;
  if (!stat.isDirectory())
    throw new CommandFailure("refused", "USAGE_INVALID", `${existing === path ? `the --store-dir path ${path}` : `${existing}, in the --store-dir path ${path},`} is not a directory; nothing was started or written`, { target: { storeDir: path }, remedy: "name a directory, or a path to create in one, with --store-dir" });
  protectedLocalDirectory(realpathSync.native(existing), "the --store-dir path");
  if (existing === path) return;
  try { accessSync(existing, constants.W_OK | constants.X_OK); }
  catch { throw new CommandFailure("refused", "PERMISSION_DENIED", `the --store-dir path ${path} cannot be created, because this account cannot write ${existing}; nothing was started or written`, { target: { storeDir: path }, remedy: "name a store directory this account can create, or create it with the right owner first" }); }
}

/** Why a broker could not start JetStream on the store `storeDir`: this account cannot write the
 *  folder it writes first, `jetstream` inside the store once a broker made it, or else the store
 *  itself. A store this account cannot search hides its `jetstream`, so the store is that folder.
 *  nats-server tests that folder when it starts and exits, naming the cause only in its log.
 *  The sentence and the next step, or undefined when it can write it or neither folder exists. A
 *  folder this account cannot read or search either needs those back too, which `u+w` leaves out. */
export function storeWriteProblem(storeDir: string): { path: string; message: string; remedy: string } | undefined {
  const jetstream = join(storeDir, "jetstream");
  let inner: Stats | undefined;
  try { inner = statIfPresent(jetstream); }
  catch (error) { if (!["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  const path = inner?.isDirectory() ? jetstream : statIfPresent(storeDir)?.isDirectory() ? storeDir : undefined;
  if (path === undefined) return undefined;
  try { accessSync(path, constants.W_OK | constants.X_OK); return undefined; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM" && code !== "EROFS") throw error;
    let readable = true;
    try { accessSync(path, constants.R_OK | constants.X_OK); } catch { readable = false; }
    return readable
      ? { path, message: `the broker store ${path} is not writable by this account (${code}), so the broker cannot start JetStream there`, remedy: `make it writable by you, for example with chmod -R u+w ${path}` }
      : { path, message: `the broker store ${path} is not readable or writable by this account (${code}), so the broker cannot start JetStream there`, remedy: `make it readable and writable by you, for example with chmod -R u+rwX ${path}` };
  }
}

/** The `store_dir` a broker configuration names for `storeDir`: relative to `root` when the store
 *  lies inside it, since the broker runs from the root. A project folder renamed while its broker runs
 *  then keeps that broker writing into the renamed folder, and nothing creates the old path again. A
 *  store outside the root keeps its absolute path. */
export function configuredStoreDir(root: string, storeDir: string): string {
  const path = relative(resolve(root), resolve(storeDir));
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path) ? path : resolve(storeDir);
}

/** Warn when an explicit `--store-dir` already holds files that are not part of a store. `up`
 *  starts on it, but `clean` and `reset` refuse to remove a store directory that holds them. */
export function warnForeignStoreEntries(value: string): void {
  const path = resolve(value);
  if (!statIfPresent(path)?.isDirectory()) return;
  const foreign = foreignStoreEntries(path);
  if (foreign.length)
    console.error(c.yellow(`! the --store-dir ${path} also holds ${listEntries(foreign)}; the broker writes its store beside them, and cotal clean store, cotal reset store, cotal backup cleanup-fallback and a restore into this directory refuse it while they are there`));
}
