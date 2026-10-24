import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, type Stats } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { authDir, c, CommandFailure, homeCotalDir, protectedLocalDirectory } from "@cotal-ai/workspace";

/** What a store directory holds: the broker's `jetstream` tree, Cotal's generation marker, and the
 *  `ocsp` folder nats-server makes in its store directory on every configuration reload. */
const STORE_ENTRIES = new Map<string, (stat: Stats) => boolean>([
  ["jetstream", (stat) => stat.isDirectory()],
  [".cotal-store-id", (stat) => stat.isFile()],
  ["ocsp", (stat) => stat.isDirectory()],
]);

/** The entries of the directory `dir` that are not part of a store, sorted. A store entry of the
 *  wrong kind, such as a `jetstream` link or file, is not part of it either. */
export function foreignStoreEntries(dir: string): string[] {
  return readdirSync(dir).filter((entry) => !STORE_ENTRIES.get(entry)?.(lstatSync(join(dir, entry)))).sort();
}

/** The names of the store entries, the only entries a store cleanup removes. */
export const STORE_ENTRY_NAMES: readonly string[] = [...STORE_ENTRIES.keys()];

/** The store `root`'s last broker served, when it differs from `storeDir` and still holds JetStream
 *  data. `down` drops the record that named a custom or restored store, but each real start writes
 *  its `store_dir` into the broker config it renders, and that file outlives `down`. */
export function lastServedStore(root: string, storeDir: string): string | undefined {
  for (const conf of [join(authDir(root), "server.conf"), join(root, ".cotal", "server-open.conf")]) {
    if (!existsSync(conf)) continue;
    // The core renderer writes the path as a JSON string.
    const named = /jetstream \{ store_dir: ("(?:[^"\\]|\\.)*")/.exec(readFileSync(conf, "utf8"))?.[1];
    const last = named === undefined ? undefined : resolve(JSON.parse(named) as string);
    if (last !== undefined && last !== resolve(storeDir) && existsSync(join(last, "jetstream"))) return last;
  }
  return undefined;
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

/** The control directory `path` is or lies in: a root's `.cotal`, or the machine home's. */
function controlDirectory(path: string): string | undefined {
  const home = resolve(homeCotalDir());
  if (path === home || path.startsWith(`${home}${sep}`)) return home;
  const parts = path.split(sep), at = parts.indexOf(".cotal");
  return at === -1 ? undefined : parts.slice(0, at + 1).join(sep);
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

/** Warn when an explicit `--store-dir` already holds files that are not part of a store. `up`
 *  starts on it, but `clean` and `reset` refuse to remove a store directory that holds them. */
export function warnForeignStoreEntries(value: string): void {
  const path = resolve(value);
  if (!statIfPresent(path)?.isDirectory()) return;
  const foreign = foreignStoreEntries(path);
  if (foreign.length)
    console.error(c.yellow(`! the --store-dir ${path} also holds ${listEntries(foreign)}; the broker writes its store beside them, and cotal clean store and cotal reset store will refuse this directory while they are there`));
}
