import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, sep } from "node:path";
import { CommandFailure, type MaintenanceJournal } from "@cotal-ai/workspace";
import { missingBackupPath } from "../lib/backup-artifact.js";
import { localIdentityCleanupTargets } from "./clean.js";

interface ProspectiveDestination {
  path: string;
  dangling: string[];
}

/** Walk the missing suffix without losing the physical prefix or an obstructing symlink entry. */
function prospectiveDestination(destination: string): ProspectiveDestination {
  const { root } = parse(destination);
  let directory = root;
  let pending = dirname(destination).slice(root.length).split(sep).filter(Boolean);
  const dangling: string[] = [];
  while (pending.length) {
    const name = pending.shift()!;
    if (name === ".") continue;
    if (name === "..") { directory = dirname(directory); continue; }
    const entry = join(directory, name);
    const stat = lstatSync(entry, { throwIfNoEntry: false });
    if (!stat) {
      // Beyond a missing directory there is nothing else to resolve unless the path walks back out.
      const suffix: string[] = [name];
      while (pending.length && suffix.length) {
        const part = pending.shift()!;
        if (part === "..") suffix.pop();
        else if (part !== ".") suffix.push(part);
      }
      if (suffix.length) directory = join(directory, ...suffix);
      continue;
    }
    try { directory = realpathSync.native(entry); }
    catch (error) {
      if (!stat.isSymbolicLink() || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (dangling.length >= 40) throw new CommandFailure("refused", "USAGE_INVALID", `the backup destination ${destination} has too many symbolic links; nothing was written`, { target: { directory: destination }, remedy: "name a destination with a direct path", selfContained: true });
      dangling.push(entry);
      const target = readlinkSync(entry);
      const targetRoot = parse(target).root;
      if (isAbsolute(target)) directory = targetRoot;
      const separator = process.platform === "win32" ? /[\\/]/u : sep;
      pending = [...target.slice(targetRoot.length).split(separator).filter(Boolean), ...pending];
    }
  }
  return { path: join(directory, basename(destination)), dangling };
}

function obstructedLink(destination: string, link: string): CommandFailure {
  return new CommandFailure("refused", "USAGE_INVALID", `the backup destination ${destination} goes through the symbolic link ${link}, whose target is missing; nothing was written`, {
    target: { directory: destination, folder: dirname(destination) }, remedy: "fix the symbolic link or name another destination", selfContained: true,
  });
}

function hasPathPrefix(path: string, parent: string): boolean {
  return path === parent || path.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

function overlaps(a: string, b: string): boolean {
  return hasPathPrefix(a, b) || hasPathPrefix(b, a);
}

function sameEntry(a: string, b: string): boolean {
  const entry = lstatSync(a, { throwIfNoEntry: false, bigint: true });
  const other = lstatSync(b, { throwIfNoEntry: false, bigint: true });
  return entry !== undefined && other !== undefined && entry.dev === other.dev && entry.ino === other.ino;
}

/** Test lookup inside the relevant directory by changing the case of a known child, without writes. */
function foldsAsciiCase(directory: string, knownChild: string): boolean {
  return sameEntry(join(directory, knownChild), join(directory, knownChild.toUpperCase()));
}

function overlapsProtected(candidate: string, protectedPath: string, knownChild?: string): boolean {
  if (overlaps(candidate, protectedPath)) return true;
  // Align the candidate to the protected entry's depth, then compare the two entry names.
  if (!hasPathPrefix(candidate.toLowerCase(), protectedPath.toLowerCase())) return false;
  const entry = candidate.split(sep).slice(0, protectedPath.split(sep).length).join(sep);
  const parent = dirname(protectedPath), actualParent = dirname(entry);
  if (actualParent !== parent && !sameEntry(actualParent, parent)) return false;
  return lstatSync(protectedPath, { throwIfNoEntry: false })
    ? sameEntry(entry, protectedPath)
    : knownChild !== undefined && foldsAsciiCase(parent, knownChild);
}

export function assertBackupPaths(root: string, source: string, destination: string): void {
  const artifact = join(realpathSync.native(dirname(destination)), basename(destination));
  const attempts = join(root, ".cotal", "maintenance", "attempts");
  if (overlapsProtected(source, attempts, "v1")) throw new Error("preserved source must not overlap the maintenance attempt directory");
  if (overlapsProtected(artifact, source)) throw new Error("backup destination must not overlap the preserved source store");
  if (overlapsProtected(artifact, attempts, "v1")) throw attemptsRefusal(destination, attempts);
}

function attemptsRefusal(destination: string, attempts: string): CommandFailure {
  return new CommandFailure("refused", "USAGE_INVALID", `the backup destination ${destination} overlaps the maintenance attempt directory ${attempts}. No backup was created.`, {
    target: { directory: destination, attemptId: null, priorClaimAttemptId: null }, remedy: `name a destination outside ${attempts}`, selfContained: true,
  });
}

export function assertEligibleDestination(root: string, journal: MaintenanceJournal, destination: string): void {
  const folder = dirname(destination);
  const missing = missingBackupPath(destination) === "folder";
  const { path, dangling } = missing ? prospectiveDestination(destination) : {
    path: join(realpathSync.native(folder), basename(destination)), dangling: [],
  };
  const paths = [path, ...dangling];
  const preserved = journal.state === "ready" || journal.state === "claimed" ? journal.source.path : undefined;
  if (preserved && paths.some((p) => overlapsProtected(p, preserved)))
    throw new CommandFailure("refused", "USAGE_INVALID", `the backup destination ${destination} is inside the preserved store ${preserved} it would copy; nothing was written`, { target: { directory: destination, store: preserved }, remedy: `name a destination outside ${preserved}`, selfContained: true });
  const project = realpathSync.native(root);
  const control = realpathSync.native(join(project, ".cotal"));
  const cleaned = cleanupOverlap(project, control, journal.space, paths);
  if (cleaned)
    throw new CommandFailure("refused", "USAGE_INVALID", `the backup destination ${destination} is inside ${cleaned}, which \`cotal clean all\` removes; nothing was written`, { target: { directory: destination, removedBy: cleaned }, remedy: `name a destination outside ${cleaned}`, selfContained: true });
  if (!missing) return;
  const attempts = join(realpathSync.native(join(control, "maintenance")), "attempts");
  if (paths.some((p) => overlapsProtected(p, attempts, "v1"))) throw attemptsRefusal(destination, attempts);
  if (dangling[0]) throw obstructedLink(destination, dangling[0]);
  throw new CommandFailure("refused", "TARGET_NOT_FOUND", `there is no folder ${folder} to create the backup in; nothing was written`, { target: { directory: destination, folder, missing: "folder" }, remedy: "create that folder first; backup create makes only the artifact's own folder" });
}

function cleanupOverlap(project: string, control: string, space: string, paths: readonly string[]): string | undefined {
  for (const named of Object.values(localIdentityCleanupTargets(project, space)).flat()) {
    const entry = join(control, basename(named));
    if (paths.some((path) => overlapsProtected(path, entry, "maintenance"))) return entry;
    if (!lstatSync(entry, { throwIfNoEntry: false })?.isSymbolicLink()) continue;
    // Keep the existing refusal for a live cleanup target reached through an alias.
    let target: string;
    try { target = realpathSync.native(entry); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ELOOP" && code !== "ENOTDIR") throw error;
      continue;
    }
    if (paths.some((path) => overlapsProtected(path, target))) return target;
  }
  return undefined;
}
