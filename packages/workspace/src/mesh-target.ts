import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_SERVER, DEFAULT_SPACE, type SpaceAuth } from "@cotal-ai/core";
import { authDir, findCotalRoot, hasUserAuthState, listSpaceAccounts, loadSpaceAuth, soleSpaceOf, userAuthSpacesOnDisk } from "./auth-paths.js";
import {
  findMesh,
  getCurrent,
  homeCotalDir,
  loadMeshes,
  removeMesh,
  type MeshEntry,
  type UserAuthInfo,
} from "./mesh-registry.js";

/**
 * One coherent answer to "which mesh does this command act on, and where do its creds + personas
 * live" — resolved identically for both, so a spawn can never authenticate to mesh A while loading
 * mesh B's persona. Replaces the scattered `loadSpaceAuth(authDir(cotalRoot()))` + `resolveSpace` +
 * `DEFAULT_SERVER` guesswork that silently mistook `~/.cotal` for a space.
 *
 * Pure and offline (no network): `<TAB>` completion uses it as-is; `spawn` adds a reachability
 * preflight (`probeConnect`) on top.
 */
export interface MeshTarget {
  /** Absolute dir whose `.cotal/{auth,agents}` hold trust + personas. */
  root: string;
  server: string;
  space: string;
  /** The mesh's auth mode — `user` is its OWN connect path (login + bearer), a hard branch:
   *  it never static-mints from `auth` and never connects credlessly like `open`. */
  mode: MeshEntry["mode"];
  /** Trust material, for a STATIC-auth mesh only — undefined for open AND for user mode (a
   *  user-mode root may still hold `auth.json` on disk; deliberately not loaded here so no caller
   *  can drift into minting static creds for a user-auth space). */
  auth?: SpaceAuth;
  /** User-auth client metadata (from the registry entry), present iff `mode === "user"`. */
  userAuth?: UserAuthInfo;
  /** `<root>/.cotal/agents` — the persona catalog for this mesh. */
  personaRoot: string;
  /** Where the target came from — this also carries OWNERSHIP for pruning. `registry`/`current`/
   *  `flag-space`/`local-recorded` mean the server + mode came from a registry record, so a
   *  stale-broker failure prunes the entry. `local-space`/`flag-server`/`flag-space-override` are the
   *  non-registry escape hatches — NEVER pruned: the probed server is operator-supplied (a raw
   *  `--server`, or a `--space` whose `--server` overrides the recorded broker), so a failure against
   *  it must not delete the recorded entry. `local-recorded` is a local project matched to a registry
   *  entry by root: registry-owned for pruning, but quiet on the success line (self-evident from cwd). */
  source:
    | "flag-server"
    | "flag-space"
    | "flag-space-override"
    | "local-space"
    | "local-recorded"
    | "registry"
    | "current";
}

export interface ResolveFlags {
  /** `--server <url>` — raw broker escape hatch. */
  server?: string;
  /** `--space <name>` — pick a specific running mesh from the registry. */
  space?: string;
}

/** The distinct, command-agnostic reasons {@link resolveMeshTarget} can't pick a single mesh. Each
 *  maps 1:1 to a former prose-throw; the recovery copy (`cotal up`/`meshes`/`use`) is the renderer's
 *  job ({@link renderWorkspaceError}), not the protocol's. */
export type MeshTargetErrorCode =
  | "no-meshes"
  | "unknown-space"
  | "ambiguous-target"
  | "default-occupied"
  | "stale-auth-root"
  | "user-auth-unrecorded";

/** Structured context for a {@link MeshTargetError} — enough for any surface to render its own
 *  recovery affordance (a CLI sentence, a web button, an SDK embed that wants no command at all). */
export interface MeshTargetErrorDetails {
  /** The space/mesh the failure concerns. */
  space?: string;
  /** A broker URL involved (e.g. the occupant of the default port). */
  server?: string;
  /** A checkout root involved. */
  root?: string;
  /** Running meshes, for the ambiguous case — each formatted `"<space> (<root>)"`. */
  available?: string[];
  /** What the caller asked for that didn't match (e.g. an unknown `--space`). */
  requested?: string;
  /** For `stale-auth-root`: the space the on-disk auth now claims, diverging from the record. */
  found?: string;
}

const WORKSPACE_TARGET_ERROR = "cotal:workspace:mesh-target-error";

/**
 * A typed mesh-target resolution failure. `message` is **log/dev-safe and command-agnostic** — never
 * the canonical product copy (that's {@link renderWorkspaceError}'s job; don't let `message` become
 * an accidental string API). `code` + structured `details` are the surfaces consumers read.
 */
export class MeshTargetError extends Error {
  /** Brand for cross-package-safe detection — see {@link isWorkspaceTargetError}. */
  readonly brand = WORKSPACE_TARGET_ERROR;
  readonly code: MeshTargetErrorCode;
  readonly details: MeshTargetErrorDetails;
  constructor(
    code: MeshTargetErrorCode,
    message: string,
    details: MeshTargetErrorDetails = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MeshTargetError";
    this.code = code;
    this.details = details;
  }
}

/** Detect a {@link MeshTargetError} across the core/workspace/consumer package boundary without a
 *  brittle `instanceof` (which breaks if two copies of this package are installed) — a brand check. */
export function isWorkspaceTargetError(e: unknown): e is MeshTargetError {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { brand?: unknown }).brand === WORKSPACE_TARGET_ERROR
  );
}

function personaRoot(root: string): string {
  return join(root, ".cotal", "agents");
}

function targetFromEntry(m: MeshEntry, server: string, source: MeshTarget["source"]): MeshTarget {
  // Honor the recorded mode: an OPEN mesh connects credlessly even if its root still has auth
  // material on disk (e.g. a root that once ran auth mode). Loading it would make `spawn` mint
  // creds against a broker that takes none. A USER mesh loads NO static auth either — its connect
  // material comes from the login/bearer path; the entry's `userAuth` metadata rides the target.
  let auth: SpaceAuth | undefined;
  let userAuth: UserAuthInfo | undefined;
  if (m.mode === "auth") {
    // Space-KEYED load: ask for this entry's own space rather than "the" auth of the root, so a
    // root serving several spaces can never hand back a neighbour's account.
    auth = loadSpaceAuth(authDir(m.root), m.space);
    // Defense in depth: the root's on-disk auth must still cover THIS space. A divergence (the root
    // was re-`up`ed as a different space without re-recording) would otherwise mint mesh-A creds
    // against the entry for space B. Now that the load is space-keyed the divergence surfaces as an
    // ABSENT account rather than a mismatched one, so detect it by what the root DOES hold; prune
    // the stale entry and fail loud rather than connect wrong.
    if (!auth) {
      const found = listSpaceAccounts(authDir(m.root));
      if (found.length) {
        removeMesh(m.space);
        throw new MeshTargetError(
          "stale-auth-root",
          `registry entry "${m.space}" points at ${m.root}, whose on-disk auth is now for "${found.join('", "')}"`,
          { space: m.space, root: m.root, found: found.join(", ") },
        );
      }
    }
  } else if (m.mode === "user") {
    // A user entry without its metadata cannot produce an actionable login line — treat it as the
    // unrecorded case (re-`up` rewrites the entry) rather than half-connecting.
    if (!m.userAuth)
      throw new MeshTargetError(
        "user-auth-unrecorded",
        `registry entry "${m.space}" is user-auth but carries no IdP metadata`,
        { space: m.space, root: m.root },
      );
    userAuth = m.userAuth;
  }
  return {
    root: m.root,
    server,
    space: m.space,
    mode: m.mode,
    auth,
    ...(userAuth ? { userAuth } : {}),
    personaRoot: personaRoot(m.root),
    source,
  };
}

function localTarget(root: string, server: string, source: MeshTarget["source"]): MeshTarget {
  // No registry entry and no explicit space, so the root itself must name exactly one space;
  // `soleSpaceOf` fails loud rather than picking one when it holds several (or the tenant list is
  // unreadable). Surface that as a catchable target error so a caller like `status` reports it as an
  // ambiguous target instead of crashing on an uncaught throw.
  let space: string;
  try {
    space = soleSpaceOf(authDir(root)) ?? DEFAULT_SPACE;
  } catch (e) {
    throw new MeshTargetError("ambiguous-target", (e as Error).message, { root });
  }
  const auth = loadSpaceAuth(authDir(root), space);
  // U10 guard: a user-auth space resolved WITHOUT its registry entry (pruned/never recorded) must
  // not silently static-mint — static creds DO work on a user-auth broker, which would connect the
  // operator on the wrong identity plane. The on-disk marker is the space-scoped user-auth state
  // dir; the recovery (re-`cotal up` in that root) rewrites the registry entry with the IdP pins.
  // The marker binds even when `auth.json` itself is missing/corrupt — a surviving state dir alone
  // proves user auth was enabled here, and the alternative would classify the root "open" and
  // connect credlessly toward a user-auth broker. Fail closed on the marker, whichever half died.
  const userSpace = auth
    ? hasUserAuthState(root, space)
      ? space
      : undefined
    : userAuthSpacesOnDisk(authDir(root))[0];
  if (userSpace !== undefined)
    throw new MeshTargetError(
      "user-auth-unrecorded",
      `space "${userSpace}" has user auth enabled on disk but no usable registry entry`,
      { space: userSpace, root },
    );
  return { root, server, space, mode: auth ? "auth" : "open", auth, personaRoot: personaRoot(root), source };
}

/** A `.cotal/` that a user actually created here — not the machine-home dir the cwd walk-up lands on
 *  from outside any project (which has no space, just the daemon's pid/onboard files). */
function isGenuineSpace(root: string): boolean {
  // Normalize both sides — COTAL_HOME may be relative or non-canonical, and a raw string compare
  // would then let the real `~/.cotal` masquerade as a project space (or vice-versa).
  return resolve(join(root, ".cotal")) !== resolve(homeCotalDir()) && existsSync(join(root, ".cotal"));
}

/**
 * Resolve the mesh target by precedence (first match wins):
 *  1. `--space` — registry lookup (errors if that space isn't running).
 *  2. `--server` — registry entry on that server (for creds/personas), else the local project.
 *  3. The live `current` selected by `cotal use` — from any directory.
 *  4. A genuine local project (`cwd` walks up to a real `.cotal/`).
 *  5. The registry: 0 ⇒ error; 1 ⇒ use it; N ⇒ error naming each + its root.
 * No silent fallback — an unresolved target throws one human sentence.
 */
export function resolveMeshTarget(cwd: string, flags: ResolveFlags = {}): MeshTarget {
  if (flags.space) {
    const m = findMesh(flags.space);
    if (!m)
      throw new MeshTargetError("unknown-space", `no mesh named "${flags.space}" is running`, {
        requested: flags.space,
      });
    // An explicit `--server` that overrides the recorded broker is an operator-supplied endpoint, not
    // the registry's — probing IT must never prune the recorded entry (a dead override would otherwise
    // delete a live registered mesh, and pre-pruning would block a live-override recovery). Mark it so
    // preflight classifies the failure as non-registry / no-prune.
    const overriding = flags.server !== undefined && flags.server !== m.server;
    return targetFromEntry(m, flags.server ?? m.server, overriding ? "flag-space-override" : "flag-space");
  }

  if (flags.server) {
    const m = loadMeshes().find((e) => e.server === flags.server);
    if (m) return targetFromEntry(m, flags.server, "flag-server");
    return localTarget(findCotalRoot(cwd), flags.server, "flag-server");
  }

  const meshes = loadMeshes();
  const current = getCurrent();
  const cur = current ? meshes.find((m) => m.space === current) : undefined;
  if (cur) return targetFromEntry(cur, cur.server, "current");

  const root = findCotalRoot(cwd);
  if (isGenuineSpace(root)) {
    // For a local project, if its mesh is in the registry, use the RECORDED server +
    // mode, not DEFAULT_SERVER: a project started with `--server …:4333` must spawn against :4333,
    // and a recorded OPEN mesh must not mint creds off stale `.cotal/auth` left on disk. Fall back
    // to the local default only when nothing is recorded for this root.
    const rootMatches = meshes.filter((m) => resolve(m.root) === resolve(root));
    // A broker that runs several spaces records one entry per space, all under this same root. With no
    // `--space` to pick one, `.find()` would silently resolve whichever sorted first; name the tenants
    // and refuse instead (the same posture as `soleSpaceOf` for an unrecorded multi-space root).
    if (rootMatches.length > 1)
      throw new MeshTargetError(
        "ambiguous-target",
        `this folder's broker hosts ${rootMatches.length} spaces (${rootMatches.map((m) => m.space).join(", ")}) - name one with --space`,
        { available: rootMatches.map((m) => `${m.space} (${m.root})`) },
      );
    const recorded = rootMatches[0];
    if (recorded) return targetFromEntry(recorded, recorded.server, "local-recorded");
    // No record for this root (migration, or our broker went down and the entry was just pruned).
    // Before guessing DEFAULT_SERVER, refuse if a DIFFERENT mesh is recorded there — otherwise the
    // fallback would silently join someone else's mesh on the default port with our persona (the
    // exact silent-wrong-mesh outcome this feature exists to prevent).
    const onDefault = meshes.find(
      (m) => m.server === DEFAULT_SERVER && resolve(m.root) !== resolve(root),
    );
    if (onDefault)
      throw new MeshTargetError(
        "default-occupied",
        `another mesh ("${onDefault.space}") is running at ${DEFAULT_SERVER}`,
        { space: onDefault.space, server: DEFAULT_SERVER },
      );
    return localTarget(root, DEFAULT_SERVER, "local-space");
  }

  if (meshes.length === 0) throw new MeshTargetError("no-meshes", "no mesh running");
  if (meshes.length === 1) return targetFromEntry(meshes[0], meshes[0].server, "registry");

  const names = meshes.map((m) => `${m.space} (${m.root})`);
  throw new MeshTargetError("ambiguous-target", `multiple meshes running: ${names.join(", ")}`, {
    available: names,
  });
}
