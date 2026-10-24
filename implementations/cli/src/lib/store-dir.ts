import { accessSync, constants, lstatSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { c, CommandFailure, homeCotalDir, protectedLocalDirectory } from "@cotal-ai/workspace";

/** What a store directory holds: the broker's `jetstream` tree and Cotal's generation marker. */
const STORE_ENTRIES = new Map<string, (stat: Stats) => boolean>([
  ["jetstream", (stat) => stat.isDirectory()],
  [".cotal-store-id", (stat) => stat.isFile()],
]);

/** The entries of the directory `dir` that are not part of a store, sorted. A store entry of the
 *  wrong kind, such as a `jetstream` link or file, is not part of it either. */
export function foreignStoreEntries(dir: string): string[] {
  return readdirSync(dir).filter((entry) => !STORE_ENTRIES.get(entry)?.(lstatSync(join(dir, entry)))).sort();
}

/** The names of the store entries, the only entries a store cleanup removes. */
export const STORE_ENTRY_NAMES: readonly string[] = [...STORE_ENTRIES.keys()];

/** Up to five entry names, then how many more there are. */
export function listEntries(entries: readonly string[]): string {
  return entries.length > 5 ? `${entries.slice(0, 5).join(", ")} and ${entries.length - 5} more` : entries.join(", ");
}

/** The entry at `path`, or nothing when it is missing. A path under a regular file is missing too,
 *  so the walk up reaches that file and names it. */
function statIfPresent(path: string): Stats | undefined {
  try { return statSync(path); }
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
 *  and no reset could remove it alone. */
export function assertStoreDirArgument(value: string, root: string): void {
  const path = resolve(value);
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
 *  itself. nats-server tests that folder when it starts and exits, naming the cause only in its log.
 *  The sentence and the next step, or undefined when it can write it or neither folder exists. */
export function storeWriteProblem(storeDir: string): { path: string; message: string; remedy: string } | undefined {
  const jetstream = join(storeDir, "jetstream");
  const path = statIfPresent(jetstream)?.isDirectory() ? jetstream : statIfPresent(storeDir)?.isDirectory() ? storeDir : undefined;
  if (path === undefined) return undefined;
  try { accessSync(path, constants.W_OK | constants.X_OK); return undefined; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM" && code !== "EROFS") throw error;
    return { path, message: `the broker store ${path} is not writable by this account (${code}), so the broker cannot start JetStream there`, remedy: `make it writable by you, for example with chmod -R u+w ${path}` };
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
    console.error(c.yellow(`! the --store-dir ${path} also holds ${listEntries(foreign)}; the broker writes its store beside them, and cotal clean store and cotal reset store will refuse this directory while they are there`));
}
