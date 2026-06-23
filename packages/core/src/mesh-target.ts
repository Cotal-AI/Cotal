import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_SERVER, DEFAULT_SPACE } from "./endpoint.js";
import { authDir, findCotalRoot, loadSpaceAuth, type SpaceAuth } from "./provision.js";
import {
  findMesh,
  getCurrent,
  homeCotalDir,
  loadMeshes,
  type MeshEntry,
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
  /** Trust material, or undefined for an open mesh. */
  auth?: SpaceAuth;
  /** `<root>/.cotal/agents` — the persona catalog for this mesh. */
  personaRoot: string;
  /** Where the target came from — this also carries OWNERSHIP for pruning. Every value except
   *  `local-space` and `flag-server` (the two non-registry escape hatches) means the server + mode
   *  came from a registry record, so a stale-broker failure prunes it. `local-recorded` is a local
   *  project matched to a registry entry by root: registry-owned for pruning, but quiet on the
   *  success line (the target is self-evident from cwd, like `local-space`). */
  source:
    | "flag-server"
    | "flag-space"
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

function personaRoot(root: string): string {
  return join(root, ".cotal", "agents");
}

function targetFromEntry(m: MeshEntry, server: string, source: MeshTarget["source"]): MeshTarget {
  return {
    root: m.root,
    server,
    space: m.space,
    // Honor the recorded mode: an OPEN mesh connects credlessly even if its root still has auth
    // material on disk (e.g. a root that once ran auth mode). Loading it would make `spawn` mint
    // creds against a broker that takes none.
    auth: m.mode === "auth" ? loadSpaceAuth(authDir(m.root)) : undefined,
    personaRoot: personaRoot(m.root),
    source,
  };
}

function localTarget(root: string, server: string, source: MeshTarget["source"]): MeshTarget {
  const auth = loadSpaceAuth(authDir(root));
  return { root, server, space: auth?.space ?? DEFAULT_SPACE, auth, personaRoot: personaRoot(root), source };
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
 *  3. A genuine local project (`cwd` walks up to a real `.cotal/`) — local wins, like `git config`.
 *  4. The registry: 0 ⇒ error; 1 ⇒ use it; N ⇒ `current` if set, else error naming each + its root.
 * No silent fallback — an unresolved target throws one human sentence.
 */
export function resolveMeshTarget(cwd: string, flags: ResolveFlags = {}): MeshTarget {
  if (flags.space) {
    const m = findMesh(flags.space);
    if (!m) throw new Error(`no mesh named "${flags.space}" is running — see \`cotal meshes\``);
    return targetFromEntry(m, flags.server ?? m.server, "flag-space");
  }

  if (flags.server) {
    const m = loadMeshes().find((e) => e.server === flags.server);
    if (m) return targetFromEntry(m, flags.server, "flag-server");
    return localTarget(findCotalRoot(cwd), flags.server, "flag-server");
  }

  const root = findCotalRoot(cwd);
  if (isGenuineSpace(root)) {
    // Local project wins by root — but if its mesh is in the registry, use the RECORDED server +
    // mode, not DEFAULT_SERVER: a project started with `--server …:4333` must spawn against :4333,
    // and a recorded OPEN mesh must not mint creds off stale `.cotal/auth` left on disk. Fall back
    // to the local default only when nothing is recorded for this root.
    const recorded = loadMeshes().find((m) => resolve(m.root) === resolve(root));
    if (recorded) return targetFromEntry(recorded, recorded.server, "local-recorded");
    // No record for this root (migration, or our broker went down and the entry was just pruned).
    // Before guessing DEFAULT_SERVER, refuse if a DIFFERENT mesh is recorded there — otherwise the
    // fallback would silently join someone else's mesh on the default port with our persona (the
    // exact silent-wrong-mesh outcome this feature exists to prevent).
    const onDefault = loadMeshes().find(
      (m) => m.server === DEFAULT_SERVER && resolve(m.root) !== resolve(root),
    );
    if (onDefault)
      throw new Error(
        `another mesh ("${onDefault.space}") is running at ${DEFAULT_SERVER} — run \`cotal up\` here to start yours, or \`--space ${onDefault.space}\` to join it`,
      );
    return localTarget(root, DEFAULT_SERVER, "local-space");
  }

  const meshes = loadMeshes();
  if (meshes.length === 0)
    throw new Error("no mesh running — run `cotal up` in a project, or pass `--server`");
  if (meshes.length === 1) return targetFromEntry(meshes[0], meshes[0].server, "registry");

  const current = getCurrent();
  const cur = current ? findMesh(current) : undefined;
  if (cur) return targetFromEntry(cur, cur.server, "current");

  const names = meshes.map((m) => `${m.space} (${m.root})`).join(", ");
  throw new Error(
    `multiple meshes running — ${names}. Pick one with \`--space <name>\` or set a default with \`cotal use <name>\`.`,
  );
}
