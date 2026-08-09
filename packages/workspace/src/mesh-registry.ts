import { readFileSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkSecretDir, writeSecretFile } from "@cotal-ai/core";
import { spaceSegment } from "./auth-paths.js";

/**
 * The registry of meshes this machine can reach, so a `cotal spawn` from *any* directory can find
 * which mesh to join, with which creds and personas. One record per broker `cotal up` started here,
 * plus any an operator registered by hand with `cotal meshes add` — a mesh running on another
 * machine, which no local command could otherwise describe. {@link MeshEntry.origin} is which, and
 * decides what may delete the record without being told to.
 *
 * Stored as **one JSON file per mesh** (`~/.cotal/meshes/<space>.json`) rather than a single
 * `meshes.json`: concurrent `up`/`down` never read-modify-write the same file (no lost-update race),
 * a crash damages at most one entry, and it mirrors the existing per-process pid files under
 * `~/.cotal`. A separate `~/.cotal/current-mesh` holds the default space from any directory (the
 * kubectl `current-context` analogue).
 *
 * Each record stores the mesh's **root path**, not its secrets — trust material stays in that
 * project's `.cotal/auth`; the registry just makes it findable from elsewhere.
 */
export interface MeshEntry {
  /** The space name — also the registry filename stem. */
  space: string;
  /** The broker URL, e.g. `nats://127.0.0.1:4222`. */
  server: string;
  /** Absolute path whose `.cotal/{auth,agents}` hold this mesh's trust material + personas. */
  root: string;
  /** How the broker authenticates: static per-agent JWT creds (`auth`), none (`open`), or
   *  per-USER auth (`user`) — login + bearer through the space's auth service. `user` is its own
   *  connect path: it must never be treated as `auth` with missing creds, nor as `open`. */
  mode: "auth" | "open" | "user";
  /** The user-auth client metadata, present iff `mode === "user"` — how a connect from any
   *  directory on THIS machine finds the login target and exchange. Local operator config, not
   *  broker truth: it lives under the user's protected registry dir and is trusted the way the
   *  registry itself is; remote/cross-machine discovery is explicitly out of its scope. */
  userAuth?: UserAuthInfo;
  /** The host the operator bound this mesh to, when they bound it somewhere reachable (`up --host`).
   *  It is the manager's attach/console BIND address, and it is recorded because it is a DECISION,
   *  not a derivable fact: a broker dial address is deliberately not treated as a manager bind
   *  address (see the note in `Manager`'s constructor), so nothing downstream can reconstruct it.
   *  Every later manager launch for this mesh — same-root repair, adopting a preserved listener,
   *  a manifest deploy — reads it back, or the attach face silently reverts to loopback and remote
   *  `cotal attach` dies. Absent means the operator never asked for exposure: loopback, as before. */
  attachHost?: string;
  /** Who put this record here — and therefore what may take it out. `up` (the default, and what any
   *  record written without the field is) means THIS machine started the mesh: it is safe to drop
   *  on a liveness verdict or a local teardown, because `cotal up` writes it straight back.
   *  `manual` means an operator registered it by hand (`cotal meshes add`) — typically a mesh
   *  running on another machine, whose record nothing here can reconstruct.
   *
   *  A `manual` record is removed only by an act that NAMES it: `cotal meshes rm`, or an
   *  `add --force` / a `cotal up` for that same space, which replace it deliberately. Everything
   *  that infers a record is dead or obsolete — the liveness sweep, the classified preflight prune,
   *  `cotal down` / `cotal clean all` sweeping a shared root — leaves it alone. */
  origin?: "up" | "manual";
  /** ISO timestamp of when the record was written. */
  ts: string;
}

/** Non-secret user-auth metadata on a {@link MeshEntry}. TRUST PINS and CONVENIENCE ENDPOINTS are
 *  deliberately separate fields: `idp` is what the operator pinned at `up --user-auth` time (the
 *  login/exchange trust config — error messages and login guidance use THIS); `endpoints` is where
 *  the local auth service happened to bind (runtime, may change across restarts, re-recorded by
 *  `up`). Nothing here is ever taken from a presented token or an unauthenticated response. */
export interface UserAuthInfo {
  /** The registered auth provider's name (registry key, e.g. `"cotal"`). */
  provider: string;
  /** The pinned IdP: the login target (`cotal login --idp <url>`) + exact issuer/audience pins. */
  idp: { url: string; issuer: string; audience: string };
  /** The local auth service's runtime endpoints (exchange/JWKS base URL). Convenience, not trust. */
  endpoints?: { url?: string };
}

/** Runtime-validate a provider's opaque `publicAuth` blob into a {@link UserAuthInfo} — the
 *  workstation layer owns this shape (core stays IdP-agnostic), so the boundary where an
 *  arbitrary provider's metadata enters the registry is checked here, fail-loud. */
export function assertUserAuthInfo(v: unknown): UserAuthInfo {
  const o = v as UserAuthInfo;
  if (o === null || typeof o !== "object" || typeof o.provider !== "string" || !o.provider)
    throw new Error("auth provider publicAuth: a provider name is required");
  if (o.idp === null || typeof o.idp !== "object" || typeof o.idp.url !== "string" || !o.idp.url ||
      typeof o.idp.issuer !== "string" || !o.idp.issuer || typeof o.idp.audience !== "string" || !o.idp.audience)
    throw new Error("auth provider publicAuth: idp { url, issuer, audience } trust pins are required");
  if (o.endpoints !== undefined && (o.endpoints === null || typeof o.endpoints !== "object" ||
      (o.endpoints.url !== undefined && typeof o.endpoints.url !== "string")))
    throw new Error("auth provider publicAuth: endpoints, when present, must be { url?: string }");
  return { provider: o.provider, idp: { url: o.idp.url, issuer: o.idp.issuer, audience: o.idp.audience },
    ...(o.endpoints ? { endpoints: { ...(o.endpoints.url ? { url: o.endpoints.url } : {}) } } : {}) };
}

/** The cotal machine-home dir, overridable via `COTAL_HOME` so tests sandbox it and never touch the
 *  real one. POSIX: `~/.cotal`. Windows: `%LOCALAPPDATA%\Cotal` — the platform's place for per-user
 *  app state (a dotdir in the profile root is a Unix idiom; `%LOCALAPPDATA%` is already a per-user
 *  private dir, so secrets under it start owner-only). The single source of that path for the
 *  registry, the current pointer, and the onboard marker. */
export function homeCotalDir(): string {
  if (process.env.COTAL_HOME) return process.env.COTAL_HOME;
  if (process.platform === "win32" && process.env.LOCALAPPDATA)
    return join(process.env.LOCALAPPDATA, "Cotal");
  return join(homedir(), ".cotal");
}

/** Directory holding the per-mesh registry files (`~/.cotal/meshes`). */
export function meshesDir(): string {
  return join(homeCotalDir(), "meshes");
}

/** The canonical registry filename for a space: the workspace-wide injective `space.<hex>` segment
 *  (see {@link spaceSegment}). Raw `encodeURIComponent` stems preserved ASCII case, so on a
 *  case-insensitive filesystem two case-differing spaces addressed ONE registry file and the
 *  second `up` silently swallowed the first mesh's record. The space's real name is authoritative
 *  in the document; the filename only locates it. */
function meshFileName(space: string): string {
  return `${spaceSegment(space)}.json`;
}

function meshFile(space: string): string {
  return join(meshesDir(), meshFileName(space));
}

/** Remove every PRE-HEX registry file that records `space` (`<encodeURIComponent>.json` stems from
 *  older builds). Matched by each document's own `space` - never by decoding the filename, which
 *  would case-fold on this filesystem - so a legacy record can neither shadow nor resurrect a mesh
 *  the canonical file no longer records. A file that will not parse is left for {@link loadMeshes}
 *  to skip. */
function removeLegacyMeshFiles(space: string): void {
  let files: string[];
  try {
    files = readdirSync(meshesDir());
  } catch {
    return; // no registry yet
  }
  const canonical = meshFileName(space);
  for (const f of files) {
    if (f === canonical || !f.endsWith(".json")) continue;
    try {
      const doc = JSON.parse(readFileSync(join(meshesDir(), f), "utf8")) as MeshEntry;
      if (doc.space === space) rmSync(join(meshesDir(), f), { force: true });
    } catch {
      /* unparseable stray - not provably this space's record, leave it */
    }
  }
}

function currentFile(): string {
  return join(homeCotalDir(), "current-mesh");
}

/** Record (or refresh) a running mesh — atomic write, 0600 (the file points at a secrets dir). */
export function recordMesh(m: MeshEntry): void {
  // The filenames in here ARE the space names, so a world-traversable dir would leak them to other
  // local users even though the file contents are private. Keep the dir readable only by us
  // (0700 POSIX / hardened ACL win32).
  mkSecretDir(meshesDir());
  const file = meshFile(m.space);
  // Per-process temp name so two concurrent `up`s for the same space can't stomp each other's
  // half-written file before the rename.
  const tmp = `${file}.${process.pid}.tmp`;
  writeSecretFile(tmp, JSON.stringify(m, null, 2)); // hardened before rename; rename preserves the ACL/mode
  renameSync(tmp, file); // atomic replace — a reader never sees a half-written record
  removeLegacyMeshFiles(m.space); // a pre-hex record for this space must not survive as a duplicate
}

/** Drop a mesh from the registry (on `cotal down` / a stale-entry prune). Absent ⇒ no-op. */
export function removeMesh(space: string): void {
  rmSync(meshFile(space), { force: true });
  removeLegacyMeshFiles(space); // else a pre-hex record would resurrect the mesh in every listing
}

/**
 * Drop a record because its mesh looks GONE — the auto-prune path, as opposed to the operator
 * saying so. Returns whether the record was actually removed.
 *
 * Every automatic deletion goes through here rather than {@link removeMesh}, because the rule is one
 * rule and forgetting it at a single site is the whole failure: a `manual` record (`cotal meshes
 * add`) is NEVER auto-pruned. An `up` record is safe to drop — `cotal up` writes it back — but a
 * manual one usually describes a mesh on ANOTHER machine, and nothing on this machine can
 * reconstruct the server URL, root and mode the operator typed. A sleeping laptop or a VPN blip
 * would otherwise unregister a perfectly healthy remote mesh for good (observed exactly once, and
 * once was enough). An unreachable manual record is a STATE the surfaces report ("offline"), not a
 * deletion; `cotal meshes rm` is how it leaves.
 */
export function pruneMesh(space: string): boolean {
  const m = findMesh(space);
  if (!m || m.origin === "manual") return false;
  removeMesh(space);
  return true;
}

/** Canonicalize a project root for comparison. A recorded root is whatever spelling `cotal up` was
 *  run under, so the same directory reaches us by several names: a symlinked root (macOS `/var` →
 *  `/private/var`) or, on Windows, an 8.3 short name (`C:\Users\RUNNER~1\…`) — `process.cwd()` keeps
 *  the short form there rather than expanding it. realpath collapses both. Falls back to `resolve`
 *  for a root that no longer exists on disk. */
function canonicalRoot(p: string): string {
  try { return realpathSync.native(p); } catch { return resolve(p); }
}

/** Every registry entry recorded for THIS project root, matched {@link canonicalRoot}-wise so a
 *  differently-spelled root still matches. The root is the only sound key for a local operation on
 *  an OPEN mesh, which has no auth material to resolve its space NAME from — that would fall back
 *  to the default space and hit an unrelated mesh's entry. Anything comparing a live root against
 *  the registry must go through here: a raw `===` silently misses, which for a safety check (e.g.
 *  `cotal clean`'s reachable-broker refusal) reads as "no mesh recorded" and lets it proceed. */
export function meshesForRoot(root: string): MeshEntry[] {
  const rootKey = canonicalRoot(root);
  return loadMeshes().filter((m) => canonicalRoot(m.root) === rootKey);
}

/**
 * Drop the entries recorded for THIS project root because the mesh they describe was just stopped
 * or wiped (`cotal down` / `cotal clean all`), releasing the `current` pointer per removed entry.
 * Returns the removed space names.
 *
 * OPERATOR-REGISTERED entries are skipped. The root is shared, not owned: `cotal meshes add`
 * defaults `--root` to the project you run it in, so registering a mesh that runs elsewhere from
 * inside your own project files both records under one root. Tearing down THIS project's mesh says
 * nothing about the remote one, and deleting its record here is the unrecoverable case (`down` can
 * rewrite what `up` wrote; nothing rewrites a hand-registered record). `cotal meshes rm` is how one
 * of those leaves.
 */
export function removeMeshesByRoot(root: string): string[] {
  const removed: string[] = [];
  for (const m of meshesForRoot(root)) {
    if (m.origin === "manual") continue;
    removeMesh(m.space);
    if (getCurrent() === m.space) clearCurrent();
    removed.push(m.space);
  }
  return removed;
}

/** The entries this root actually RUNS — what a local teardown or wipe may act on. The complement
 *  of the skip in {@link removeMeshesByRoot}, exported so a caller that guards on "is this root's
 *  mesh still live" asks about its OWN mesh: a hand-registered record co-rooted here points at a
 *  broker on another machine, which the operator cannot stop and must not be blocked by. */
export function localMeshesForRoot(root: string): MeshEntry[] {
  return meshesForRoot(root).filter((m) => m.origin !== "manual");
}

/** All currently-recorded meshes. An unparseable/partially-written entry is skipped, not fatal —
 *  one bad file must not hide the rest. One record per space: if a pre-hex legacy file and the
 *  canonical `space.<hex>` file both name the same space (a crash between {@link recordMesh}'s
 *  write and its legacy sweep), the canonical one wins — it is the newer scheme's write. */
export function loadMeshes(): MeshEntry[] {
  let files: string[];
  try {
    files = readdirSync(meshesDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return []; // no registry yet
  }
  const bySpace = new Map<string, { entry: MeshEntry; canonical: boolean }>();
  for (const f of files.sort()) {
    let entry: MeshEntry;
    try {
      entry = JSON.parse(readFileSync(join(meshesDir(), f), "utf8")) as MeshEntry;
    } catch {
      continue; /* skip a corrupt/half-written entry rather than fail the whole listing */
    }
    if (typeof entry.space !== "string" || !entry.space) continue; // every consumer keys on space
    let canonical = false;
    try {
      canonical = f === meshFileName(entry.space);
    } catch {
      /* a degenerate space name in the doc has no canonical filename - rank it as legacy */
    }
    const prev = bySpace.get(entry.space);
    if (!prev || (canonical && !prev.canonical)) bySpace.set(entry.space, { entry, canonical });
  }
  return [...bySpace.values()].map((v) => v.entry);
}

export function findMesh(space: string): MeshEntry | undefined {
  return loadMeshes().find((m) => m.space === space);
}

/** The default mesh's space name, set by `cotal use` (and by the first `cotal up`). Undefined when
 *  unset or empty. The pointer can dangle (its mesh went down); callers treat a `findMesh` miss as
 *  "no current". */
export function getCurrent(): string | undefined {
  try {
    return readFileSync(currentFile(), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function setCurrent(space: string): void {
  mkSecretDir(homeCotalDir());
  writeSecretFile(currentFile(), space);
}

export function clearCurrent(): void {
  rmSync(currentFile(), { force: true });
}
