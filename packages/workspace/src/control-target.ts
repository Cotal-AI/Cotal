/**
 * Which running mesh a CONTROL command addresses, and the auth material it carries to the manager's
 * endpoint rails. Shared by every command surface that talks to the manager (`cotal ps`, `cotal
 * run`, the web dashboard), so they all resolve the same target the same way: exactly
 * {@link connectOrExit}'s precedence (--creds raw > --server + unregistered --space open >
 * registry/`current` with mint + preflight + stale-prune) with one control-specific delta: on the
 * raw `--creds` path the space defaults to THIS FOLDER's `.cotal/auth` space rather than
 * `DEFAULT_SPACE`, because a control op addresses the manager of the folder's mesh.
 */
import {
  DEFAULT_SPACE,
  DEV_OWNER,
  mintLifecycleUid,
  newIdentity,
  type EpCaller,
  type Profile,
  type SpaceAuth,
} from "@cotal-ai/core";
import { authDir, findCotalRoot, soleSpaceOf } from "./auth-paths.js";
import { connectOrExit, connectOrThrow, connectUserControlOrExit, endpointAuth, type ConnectFlags } from "./connect.js";
import { isWorkspaceTargetError, resolveMeshTarget, type MeshTarget, type MeshTargetErrorCode } from "./mesh-target.js";
import { pruneStaleMeshes } from "./preflight.js";

/** Endpoint auth material for one control call: a static/raw cred OR a user-mode bearer+sentinel
 *  (spread into the endpoint verbatim), plus the minted instrument's caller triple when the static
 *  mint produced one. */
export type ControlAuth = { creds?: string; bearer?: string; sentinelCreds?: string; epCaller?: EpCaller; tls?: boolean };

export interface ControlTarget {
  space: string;
  server: string;
  auth: ControlAuth;
  /** The resolved mesh's trust material, carried forward for a caller that re-mints against it.
   *  Absent for an open mesh and for raw off-registry creds. */
  spaceAuth?: SpaceAuth;
  /** The root the mesh resolved to. Absent for a raw off-registry connection. */
  root?: string;
}

/** The only {@link MeshTargetErrorCode}s that mean "there is NO registry entry here", and so the
 *  only ones the mode peek in {@link resolveControlTarget} may absorb. Every other code is
 *  non-absence and fails loud: `stale-auth-root` / `unreadable-auth` / `user-auth-unrecorded` are an
 *  entry that exists and is broken, `ambiguous-target` can be several healthy entries, and
 *  `default-occupied` an intended local target with no entry at all. A closed allow-list, so a new
 *  code defaults to failing loud. */
const TARGET_ABSENT_CODES: ReadonlySet<string> = new Set<MeshTargetErrorCode>(["unknown-space", "no-meshes"]);

/**
 * Resolve the control target for `flags`, minting `profile` as the caller's instrument on a static
 * mesh (user mode rides the logged-in bearer and mints nothing; an open mesh connects bare).
 *
 * `instanceId` (`--on <instanceId>`) is forwarded to the instrument mint so the one-shot credential
 * carries the exact `ep.inst.…` rows for that instance; a credential cannot gain a rail after it is
 * issued, so it has to arrive here rather than at the invoke.
 *
 * `onRefusal: "throw"` makes an unresolvable or unreachable mesh a thrown {@link ConnectRefusal}
 * instead of a printed sentence and `process.exit(1)`, for a loop that has to survive the broker
 * being briefly gone.
 */
export async function resolveControlTarget(
  flags: ConnectFlags,
  profile: Profile,
  instanceId?: string,
  opts: { onRefusal?: "exit" | "throw" } = {},
): Promise<ControlTarget> {
  const connect_ = opts.onRefusal === "throw" ? connectOrThrow : connectOrExit;
  const withSpace = flags.creds
    ? { ...flags, space: flags.space ?? soleSpaceOf(authDir(findCotalRoot())) ?? DEFAULT_SPACE }
    : flags;
  // USER MODE: the ledger-scoped bearer is the control surface; there is no instrument mint.
  // `connectOrExit` refuses control-caller-* on a user mesh (those profiles carry freeze rows the
  // bearer does not hold), so the mode is peeked here and the user path taken explicitly.
  //
  // The peek reads the MODE and nothing else. It resolves through the THROWING form and reads
  // ABSENCE as "not a registry mesh, therefore not user mode", leaving that path to the connect
  // helper below, which owns it. Absence only: `stale-auth-root` PRUNES the entry before throwing,
  // so absorbing it would let an explicit `--server` take the raw-open arm and connect a
  // misconfigured AUTH mesh with no credentials. Those codes rethrow and the command dies loud.
  if (!withSpace.creds) {
    // Sweep first when no space is named, as the connect helper does before ITS resolve, so the
    // peek and the connect see one world.
    if (!withSpace.space) await pruneStaleMeshes();
    let mode: MeshTarget["mode"] | undefined;
    try {
      mode = resolveMeshTarget(process.cwd(), { server: withSpace.server, space: withSpace.space }).mode;
    } catch (e) {
      if (!isWorkspaceTargetError(e) || !TARGET_ABSENT_CODES.has(e.code)) throw e;
    }
    if (mode === "user") {
      const conn = await connectUserControlOrExit(withSpace);
      return {
        space: conn.space,
        server: conn.server,
        auth: { ...endpointAuth(conn), ...(conn.epCaller ? { epCaller: conn.epCaller } : {}) },
        ...(conn.root !== undefined ? { root: conn.root } : {}),
      };
    }
  }
  const conn = await connect_(withSpace, profile, ...(instanceId !== undefined ? [{ instanceId }] as const : []));
  return {
    space: conn.space,
    server: conn.server,
    auth: { ...endpointAuth(conn), ...(conn.epCaller ? { epCaller: conn.epCaller } : {}) },
    ...(conn.auth ? { spaceAuth: conn.auth } : {}),
    ...(conn.root !== undefined ? { root: conn.root } : {}),
  };
}

/** The caller triple a control call rides, or a refusal naming why the credential cannot. A user
 *  bearer or a minted static instrument carries its own triple. An OPEN mesh has no credential
 *  system: the manager registered under DEV_OWNER and the broker enforces nothing, so a fresh
 *  DEV_OWNER triple is synthesized. A raw `--creds` file with no triple predates the endpoint
 *  control surface and is refused rather than silently downgraded. */
export function controlCaller(auth: ControlAuth): { caller: EpCaller } | { refusal: string } {
  if (auth.epCaller && (auth.creds || (auth.bearer && auth.sentinelCreds))) return { caller: auth.epCaller };
  if (auth.creds)
    return { refusal: "this --creds file predates the v0.4 control surface (no endpoint-serve rows); re-mint it with a current cotal, or drive the manager from its project folder which mints the instrument for you" };
  return { caller: { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() } };
}
