/**
 * Which running mesh a CONTROL command addresses, and the auth material it carries to the manager's
 * endpoint rails. Shared by every command surface that talks to the manager (`cotal ps`, `cotal
 * run`, the web dashboard), so they all resolve the same target the same way: exactly
 * {@link connectOrExit}'s precedence (--creds raw > --server + unregistered --space open >
 * registry/`current` with mint + preflight + stale-prune) with one control-specific delta: on the
 * raw `--creds` path the space defaults to THIS FOLDER's `.cotal/auth` space rather than
 * `DEFAULT_SPACE`, because a control op addresses the manager of the folder's mesh.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  DEFAULT_SPACE,
  DEV_OWNER,
  dialerFor,
  mintLifecycleUid,
  newIdentity,
  readAcceptedRow,
  standaloneConnectOpts,
  type EpCaller,
  type IssuedCaller,
  type Profile,
  type SpaceAuth,
} from "@cotal-ai/core";
import { agentLifecycleSecretFilePaths } from "./agent-secrets.js";
import { authDir, findCotalRoot, soleSpaceOf } from "./auth-paths.js";
import { connectOrExit, connectOrThrow, connectUserControlOrExit, endpointAuth, userViewAuth, type ConnectFlags } from "./connect.js";
import { isWorkspaceTargetError, resolveMeshTarget, type MeshTarget, type MeshTargetErrorCode } from "./mesh-target.js";
import { pruneStaleMeshes } from "./preflight.js";

/** Endpoint auth material for one control call: a static/raw cred OR a user-mode bearer+sentinel
 *  (spread into the endpoint verbatim), plus the minted instrument's caller triple when the static
 *  mint produced one. */
export type ControlAuth = { creds?: string; bearer?: string; sentinelCreds?: string; epCaller?: EpCaller; managerInstanceId?: string; tls?: boolean };

export interface ControlTarget {
  space: string;
  server: string;
  auth: ControlAuth;
  /** The resolved mesh's trust material, carried forward for a caller that re-mints against it.
   *  Absent for an open mesh and for raw off-registry creds. */
  spaceAuth?: SpaceAuth;
  /** The root the mesh resolved to. Absent for a raw off-registry connection. */
  root?: string;
  /** The registered mesh contract, carried forward from {@link Connection.mode}. Absent on a
   *  raw off-registry connect. Open-vs-static decisions read this field, never the absence of
   *  {@link spaceAuth}. */
  mode?: MeshTarget["mode"];
  policy?: MeshTarget["policy"];
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
 * mesh (user-mode manager calls borrow an instance-bound view; an open mesh connects bare).
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
  opts: { onRefusal?: "exit" | "throw"; endpoint?: string } = {},
): Promise<ControlTarget> {
  const connect_ = opts.onRefusal === "throw" ? connectOrThrow : connectOrExit;
  const withSpace = flags.creds
    ? { ...flags, space: flags.space ?? soleSpaceOf(authDir(findCotalRoot())) ?? DEFAULT_SPACE }
    : flags;
  // USER MODE: manager calls exchange the current ledger authority for a concrete instance view.
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
    // peek and the connect see one world. The sweep's `offline` set is the liveness verdict:
    // pass it through so a kept dead record is not a live candidate.
    const offline = withSpace.space ? [] : (await pruneStaleMeshes()).offline;
    let mode: MeshTarget["mode"] | undefined;
    try {
      mode = resolveMeshTarget(process.cwd(), {
        server: withSpace.server,
        space: withSpace.space,
        offline,
      }).mode;
    } catch (e) {
      if (!isWorkspaceTargetError(e) || !TARGET_ABSENT_CODES.has(e.code)) throw e;
    }
    if (mode === "user") {
      const conn = await connectUserControlOrExit(withSpace);
      const manager = (opts.endpoint === undefined || opts.endpoint === "manager") &&
          (profile === "control-caller-privileged" || profile === "control-caller-admin")
        ? await userViewAuth(conn, "manager-caller", instanceId === undefined ? {} : { managerInstanceId: instanceId })
        : undefined;
      return {
        space: conn.space,
        server: conn.server,
        auth: manager ? {
          bearer: manager.bearer,
          sentinelCreds: manager.sentinelCreds,
          tls: conn.tls,
          epCaller: { owner: manager.owner, actor: manager.actor, uid: manager.lifecycleUid },
          managerInstanceId: manager.managerInstanceId,
        } : { ...endpointAuth(conn), ...(conn.epCaller ? { epCaller: conn.epCaller } : {}) },
        ...(conn.root !== undefined ? { root: conn.root } : {}),
        ...(conn.mode !== undefined ? { mode: conn.mode } : {}),
        ...(conn.policy ? { policy: conn.policy } : {}),
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
    ...(conn.mode !== undefined ? { mode: conn.mode } : {}),
    ...(conn.policy ? { policy: conn.policy } : {}),
  };
}

/**
 * The managed seat this process runs in, as THAT seat's own control target, or `undefined` outside
 * one. A seat that shells out to `cotal` must reach the manager as itself, not as a fresh operator
 * instrument: the manager records the requesting principal (a detached spawn's spawner, a run
 * answer's answerer), and a one-shot instrument is a principal nothing can present again, so the
 * seat could never stop the child it asked for (#718). Connection material is intentionally not
 * inherited by shell children; the non-secret launch identity (`COTAL_NAME`, `COTAL_ID`,
 * `COTAL_LIFECYCLE_UID`, `COTAL_SPACE`) names the seat, and only a command aimed at the seat's own
 * space acts as it:
 *
 * - static mesh: the manager-owned lifecycle credential, whose accepted row (`COTAL_ACCEPTED_TOKEN`)
 *   resolves an issuer-bound generation that must name the same principal and lifecycle uid;
 * - open mesh: no credential system, so the seat's declared triple is the caller;
 * - user-auth mesh: `undefined`, because the CLI's bearer and the seat share an owner and the
 *   manager's owner-domain rule already covers that pair.
 */
export async function resolveSeatControlTarget(flags: ConnectFlags): Promise<ControlTarget | undefined> {
  const name = process.env.COTAL_NAME?.trim();
  const actor = process.env.COTAL_ID?.trim();
  const uid = process.env.COTAL_LIFECYCLE_UID?.trim();
  const seatSpace = process.env.COTAL_SPACE?.trim();
  if (!name || !actor || !uid || !seatSpace) return undefined;
  const mesh = resolveMeshTarget(process.cwd(), { space: flags.space, server: flags.server });
  if (mesh.space !== seatSpace) return undefined;
  const at = { space: mesh.space, server: mesh.server, root: mesh.root, mode: mesh.mode, ...(mesh.policy ? { policy: mesh.policy } : {}) };
  if (mesh.mode === "open") return { ...at, auth: { epCaller: { owner: DEV_OWNER, actor, uid } } };
  const acceptedToken = process.env.COTAL_ACCEPTED_TOKEN?.trim();
  if (mesh.mode !== "auth" || !acceptedToken) return undefined;
  const path = agentLifecycleSecretFilePaths(mesh.root, mesh.space, name, uid).creds;
  if (!existsSync(path))
    throw new Error(`managed seat credential is missing at ${path}; refusing to act as a different caller`);
  const creds = readFileSync(path, "utf8");
  const nc = await dialerFor(mesh.server)({
    servers: mesh.server,
    ...standaloneConnectOpts({ creds, tls: mesh.tlsRequired }),
    maxReconnectAttempts: 0,
  });
  try {
    const ref = await readAcceptedRow(nc, mesh.space, acceptedToken);
    if (ref.owner !== DEV_OWNER || ref.actor !== actor || ref.uid !== uid)
      throw new Error(`managed seat issuance resolves to ${ref.owner}.${ref.actor}/${ref.uid}, not ${DEV_OWNER}.${actor}/${uid}`);
    return { ...at, auth: { creds, tls: mesh.tlsRequired, epCaller: { owner: ref.owner, actor: ref.actor, uid: ref.uid, generation: ref.generation } as IssuedCaller } };
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}

/** The caller triple a control call rides, or a refusal naming why the credential cannot. A user
 *  bearer or a minted static instrument carries its own triple. An OPEN mesh has no credential
 *  system: the manager registered under DEV_OWNER and the broker enforces nothing, so the call rides
 *  the triple its target declares ({@link resolveSeatControlTarget}) or a freshly synthesized
 *  DEV_OWNER one. A raw `--creds` file supplies no triple and that route cannot mint one, so it is
 *  refused rather than silently downgraded. */
export function controlCaller(auth: ControlAuth): { caller: EpCaller } | { refusal: string } {
  if (auth.epCaller && (auth.creds || (auth.bearer && auth.sentinelCreds))) return { caller: auth.epCaller };
  if (auth.creds)
    return { refusal: "this control call has no endpoint-caller triple (owner, actor, lifecycle uid), and a raw --creds invocation cannot mint one; minting the file again changes nothing. Run the command from the mesh's project folder, or name the mesh with --space against its registry entry, so the CLI mints the one-shot instrument for you" };
  if (auth.epCaller && !auth.bearer && !auth.sentinelCreds) return { caller: auth.epCaller };
  return { caller: { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() } };
}
