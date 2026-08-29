import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { homeCotalDir } from "@cotal-ai/workspace";

/**
 * Cross-vendor Agent Skills distribution.
 *
 * Cotal authors a small set of Agent Skills (SKILL.md, the agentskills.io open format). One canonical
 * copy of each ships inside this CLI package (see package.json `files`) and feeds three delivery
 * channels from that single source:
 *   1. Claude Code, bundled in the `cotal-skills` plugin, installed from the mesh marketplace at user
 *      scope (real remote update via a release-derived plugin version; see setup.ts).
 *   2. Codex, OpenCode, pi, and Jcode all read the cross-vendor `~/.agents/skills/` user directory.
 *      The first normal CLI command after install/upgrade, `cotal update`, and `cotal setup` reconcile
 *      the files here; `cotal status` reports skew without mutating it. This module owns that reconcile.
 *   3. The website Agent Skills discovery index, generated from the same canonical files at build.
 *
 * File-level ownership (the safety model): Cotal owns exactly ONE file per skill it ships,
 * `~/.agents/skills/<name>/SKILL.md`, tracked by digest in a validated manifest under `~/.cotal`. It
 * only ever writes/removes that file: it never recursively deletes a skill directory (a retired skill's
 * dir is removed only if it is left empty), never touches any other file a user or third party put
 * there, refuses to follow a symlink anywhere in the managed path, and writes via a stage-and-rename so
 * it replaces the directory entry instead of writing through a hard-linked inode. That keeps a
 * destructive reconcile from becoming a data-loss or arbitrary-write primitive.
 */

/** The canonical `SKILL.md` source dir, shipped in this CLI package. Resolved the same way in a dev
 *  clone (built dist/lib) and an installed binary: two levels up from dist/lib is the package root. */
export function canonicalSkillsDir(): string {
  return join(import.meta.dirname, "..", "..", "cotal-skills", "skills");
}

/** The cross-vendor skills directory the other harnesses read: `~/.agents/skills`. Anchored on the OS
 *  home dir (not `~/.cotal`), because that is the real path those tools scan. */
export function agentSkillsHome(): string {
  return join(homedir(), ".agents", "skills");
}

export type AgentSkillDestination = {
  id: "agents";
  label: string;
  harnesses: readonly string[];
  root: string;
};

/** Thin destination registry over one canonical skill bundle. All currently verified harnesses consume
 * the shared Agent Skills user path, so there is one physical destination. Keeping the adapter explicit
 * prevents a future harness-specific path from duplicating sources or reconciliation logic. */
export function agentSkillDestinations(): AgentSkillDestination[] {
  return [{ id: "agents", label: "Codex · OpenCode · pi · Jcode", harnesses: ["codex", "opencode", "pi", "jcode"], root: agentSkillsHome() }];
}

// The Agent Skills name grammar: lowercase alphanumerics in hyphen-separated segments, no leading,
// trailing, or doubled hyphen (so no path separators and no `..`). Kept exactly as strict as the
// harnesses that consume the dir, so a name that passes local validation can never be one they reject.
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_NAME = 64;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function validSkillName(name: string): boolean {
  return name.length <= MAX_SKILL_NAME && SKILL_NAME.test(name);
}

function digest(buf: Buffer): string {
  return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

/** Write bytes to a file Cotal owns by staging a fresh file in the SAME directory and renaming it over
 *  the destination. rename() replaces the directory entry, so it never writes THROUGH an existing inode:
 *  a hard-linked `SKILL.md` (a regular file, so it passes the symlink guard) is superseded rather than
 *  truncated, and any file outside the tree it was linked to is left intact. The `wx` flag creates the
 *  temp exclusively (O_EXCL refuses to follow a pre-planted symlink at the temp path). */
function writeOwnedFile(destFile: string, bytes: Buffer): void {
  const tmp = `${destFile}.tmp.${process.pid}`;
  rmSync(tmp, { force: true }); // clear a stale temp from a crashed run (removes the entry, not any link target)
  writeFileSync(tmp, bytes, { flag: "wx" });
  renameSync(tmp, destFile);
}

/** Back up a user's current DIVERGENT `SKILL.md` to a fresh sibling that does not already exist, created
 *  exclusively (`wx` = O_CREAT|O_EXCL, so it neither follows a symlink nor overwrites a file Cotal does
 *  not own). Tries `.bak`, then `.bak.1`, `.bak.2`, ...: a pre-existing or third-party backup is never
 *  destroyed, and every divergent overwrite keeps its OWN recoverable copy rather than clobbering an
 *  earlier one. */
function backupDivergent(destFile: string, cur: Buffer): string {
  for (let i = 0; i < 1000; i++) {
    const bak = i === 0 ? `${destFile}.bak` : `${destFile}.bak.${i}`;
    try {
      writeFileSync(bak, cur, { flag: "wx" });
      return bak; // the exact path we wrote, so callers can point the user at their recoverable copy
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue; // that slot is taken (a prior/foreign backup): try the next
      throw e;
    }
  }
  throw new Error(`could not create a backup for ${destFile}: too many existing backups`);
}

/** Where the ownership manifest lives (`~/.cotal/agent-skills.json`): the record of which skill names
 *  Cotal owns in `~/.agents/skills` and the digest it last wrote for each. */
function manifestPath(): string {
  return join(homeCotalDir(), "agent-skills.json");
}

function assertManifestPathSafe(): void {
  const root = homeCotalDir();
  for (const p of [root, manifestPath()]) {
    if (!existsSync(p)) continue;
    if (lstatSync(p).isSymbolicLink())
      throw new Error(`Refusing to manage skills: ownership path ${p} is a symlink. Replace it with a real path, then retry.`);
  }
}

type Manifest = { skills: Record<string, string> }; // skill name -> digest Cotal last wrote

/** Read the ownership manifest. Absent bootstraps to empty; a present-but-malformed manifest (bad JSON,
 *  wrong shape, an illegal skill name, or a non-digest value) FAILS LOUD rather than silently resetting.
 *  This ledger authorizes deletion, so its integrity is the safety boundary: a corrupt or tampered file
 *  must never be trusted to name what we may remove, nor silently forget what we still own. */
function readManifest(): Manifest {
  const path = manifestPath();
  assertManifestPathSafe();
  if (!existsSync(path)) return { skills: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Corrupt Cotal skills manifest at ${path} (invalid JSON). Fix or delete it, then re-run cotal setup.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`Corrupt Cotal skills manifest at ${path} (unexpected shape). Fix or delete it, then re-run cotal setup.`);
  const skills = (parsed as { skills?: unknown }).skills;
  // Must be a plain object, never an array: array indices ("0", "1") pass a slug check, so an array
  // would let a numeric "name" be treated as owned (and deleted), and a string property assigned to an
  // array is dropped by JSON.stringify, so ownership would silently fail to persist. Reject it outright.
  if (typeof skills !== "object" || skills === null || Array.isArray(skills))
    throw new Error(`Corrupt Cotal skills manifest at ${path} (skills is not an object). Fix or delete it, then re-run cotal setup.`);
  for (const [name, dig] of Object.entries(skills as Record<string, unknown>)) {
    if (!validSkillName(name)) throw new Error(`Corrupt Cotal skills manifest at ${path}: illegal skill name ${JSON.stringify(name)}.`);
    if (typeof dig !== "string" || !DIGEST.test(dig)) throw new Error(`Corrupt Cotal skills manifest at ${path}: bad digest for ${JSON.stringify(name)}.`);
  }
  return { skills: skills as Record<string, string> };
}

/** Write the manifest atomically (temp + rename) so a crash can't leave a half-written ledger. */
function writeManifest(m: Manifest): void {
  const path = manifestPath();
  assertManifestPathSafe();
  mkdirSync(dirname(path), { recursive: true });
  writeOwnedFile(path, Buffer.from(JSON.stringify(m, null, 2) + "\n")); // stage-and-rename: its temp is unlinked + `wx`-created, so it can't be a symlink/hard-link clobber vector
}

/** The Cotal-authored skill names shipped in this binary, one dir with a `SKILL.md` each. Fails LOUD
 *  (repo rule: no silent fallbacks) if the bundle is absent, empty, a child dir lacks its SKILL.md, or a
 *  child name is not a valid slug, so a truncated/corrupt install surfaces instead of shipping zero (or
 *  a malformed) skill. */
export function canonicalSkillNames(): string[] {
  const dir = canonicalSkillsDir();
  if (!existsSync(dir)) throw new Error(`Cotal skills bundle missing at ${dir}. The cotal-ai install looks corrupt; reinstall it.`);
  const names: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (!validSkillName(e.name)) throw new Error(`Cotal skill dir "${e.name}" has an illegal name. Corrupt skills bundle.`);
    if (!existsSync(join(dir, e.name, "SKILL.md"))) throw new Error(`Cotal skill "${e.name}" is missing SKILL.md at ${join(dir, e.name)}. Corrupt skills bundle.`);
    names.push(e.name);
  }
  if (!names.length) throw new Error(`No Cotal skills found in ${dir}. Corrupt skills bundle.`);
  return names.sort();
}

/** Refuse to touch a skill whose `~/.agents`, `~/.agents/skills`, `<name>` dir, or `<name>/SKILL.md` is
 *  a symlink: Cotal only writes/removes real files under `~/.agents/skills`, so a redirected component
 *  can never make a read, write, or delete land on a file outside it. */
function assertNoSymlink(destination: AgentSkillDestination, name: string): void {
  for (const p of [dirname(destination.root), destination.root, join(destination.root, name), join(destination.root, name, "SKILL.md")]) {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue; // does not exist yet: nothing to follow
    }
    if (st.isSymbolicLink()) throw new Error(`Refusing to manage skills: ${p} is a symlink. Cotal only writes real files under ${destination.root}.`);
  }
}

export type AgentSkillsResult = { installed: string[]; backedUp: { name: string; path: string }[]; removed: string[]; changed: boolean };

/** Reconcile Cotal's authored skills into `~/.agents/skills`, at the file level:
 *  - install/refresh each canonical skill's `SKILL.md` (and only that file, never other files in the
 *    dir); if the destination is a user's or third party's copy (not what we last wrote), copy the
 *    current content into a fresh `SKILL.md.bak` slot (created exclusively, never overwriting an
 *    existing/foreign backup) before overwriting, so every divergent edit stays recoverable;
 *  - remove a skill Cotal previously owned that is no longer canonical (retired), but only its
 *    `SKILL.md`; if the managed copy was edited, preserve it in a fresh backup first. Then drop the dir
 *    only when empty. A user's or third party's other files in the directory are never removed.
 *  Idempotent; fails loud on a corrupt bundle or manifest. */
export function installAgentSkills(): AgentSkillsResult {
  const testCounter = process.env.COTAL_TEST_AGENT_SKILLS_COUNT_FILE;
  if (testCounter) writeFileSync(testCounter, "reconcile\n", { flag: "a" });
  const src = canonicalSkillsDir();
  const names = canonicalSkillNames();
  const destinations = agentSkillDestinations();
  if (destinations.length !== 1) throw new Error("internal error: the legacy Agent Skills manifest supports exactly one destination");
  const destination = destinations[0];
  const home = destination.root;
  const manifest = readManifest();
  const installed: string[] = [];
  const backedUp: { name: string; path: string }[] = [];
  const removed: string[] = [];
  let manifestChanged = false;

  for (const name of names) {
    assertNoSymlink(destination, name);
    const dir = join(home, name);
    const destFile = join(dir, "SKILL.md");
    const canonical = readFileSync(join(src, name, "SKILL.md"));
    const canonicalDigest = digest(canonical);
    if (existsSync(destFile)) {
      const cur = readFileSync(destFile);
      const currentDigest = digest(cur);
      if (currentDigest === canonicalDigest && manifest.skills[name] === canonicalDigest) continue;
      if (currentDigest === canonicalDigest && manifest.skills[name] === undefined) {
        manifest.skills[name] = canonicalDigest;
        manifestChanged = true;
        continue;
      }
      const ours = manifest.skills[name] === currentDigest;
      if (!ours && currentDigest !== canonicalDigest) {
        const path = backupDivergent(destFile, cur); // create a FRESH backup slot (never overwrite a pre-existing/foreign .bak); every divergent edit stays recoverable
        backedUp.push({ name, path });
      }
    }
    mkdirSync(dir, { recursive: true });
    writeOwnedFile(destFile, canonical); // write ONLY our file, via rename (never truncates a hard-linked inode); never delete or replace anything else in the dir
    installed.push(name);
    if (manifest.skills[name] !== canonicalDigest) manifestChanged = true;
    manifest.skills[name] = canonicalDigest;
  }

  for (const name of Object.keys(manifest.skills)) {
    if (names.includes(name)) continue; // still shipped
    assertNoSymlink(destination, name);
    const dir = join(home, name);
    const destFile = join(dir, "SKILL.md");
    if (existsSync(destFile)) {
      const current = readFileSync(destFile);
      if (digest(current) !== manifest.skills[name]) backedUp.push({ name, path: backupDivergent(destFile, current) });
      rmSync(destFile); // remove ONLY our file (not the dir, not a user's files)
      try {
        if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir); // drop the dir only if now empty (rmdir refuses a non-empty dir)
      } catch {
        /* not empty or already gone: leave it */
      }
      removed.push(name);
    }
    delete manifest.skills[name];
    manifestChanged = true;
  }

  const changed = installed.length > 0 || backedUp.length > 0 || removed.length > 0 || manifestChanged;
  if (changed) writeManifest(manifest);
  return { installed, backedUp, removed, changed };
}

export type SkillSkewState = "current" | "stale" | "missing" | "retired";
export type SkillSkew = { destination: AgentSkillDestination; name: string; state: SkillSkewState };

/** Compare the managed `~/.agents/skills` tree against canonical so `cotal status` can surface drift:
 *  `current` (identical), `stale` (present but differs), `missing` (not dropped), or `retired` (a skill
 *  Cotal still owns on disk but no longer ships, awaiting removal on the next `cotal setup`). Throws on
 *  a corrupt bundle or manifest; the caller renders that as an integrity error. */
export function agentSkillsSkew(): SkillSkew[] {
  const src = canonicalSkillsDir();
  const names = canonicalSkillNames();
  const destinations = agentSkillDestinations();
  if (destinations.length !== 1) throw new Error("internal error: the legacy Agent Skills manifest supports exactly one destination");
  const destination = destinations[0];
  const home = destination.root;
  const out: SkillSkew[] = names.map((name) => {
    const installed = join(home, name, "SKILL.md");
    if (!existsSync(installed)) return { destination, name, state: "missing" };
    const canonical = readFileSync(join(src, name, "SKILL.md"));
    return { destination, name, state: readFileSync(installed).equals(canonical) ? "current" : "stale" };
  });
  const manifest = readManifest();
  for (const name of Object.keys(manifest.skills)) {
    if (names.includes(name)) continue;
    if (existsSync(join(home, name, "SKILL.md"))) out.push({ destination, name, state: "retired" });
  }
  return out;
}
