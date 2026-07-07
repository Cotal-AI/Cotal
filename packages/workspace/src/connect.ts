import { readFileSync } from "node:fs";
import {
  DEFAULT_SERVER,
  DEFAULT_SPACE,
  mintCreds,
  newIdentity,
  probeConnect,
  registry,
  type AuthProvider,
  type Profile,
  type SpaceAuth,
} from "@cotal-ai/core";
import { c } from "./colors.js";
import { userAuthStateDir } from "./auth-paths.js";
import { findMesh, getCurrent, removeMesh, type UserAuthInfo } from "./mesh-registry.js";
import { isWorkspaceTargetError, resolveMeshTarget, type MeshTarget } from "./mesh-target.js";
import { preflightTarget, pruneStaleMeshes } from "./preflight.js";
import { renderWorkspaceError } from "./render.js";

/**
 * The one way every command that touches a running mesh figures out WHICH mesh + with what creds,
 * and confirms it's actually up — shared by every command surface (@cotal-ai/cli, cotal-web,
 * @cotal-ai/demo) so `spawn`, `send`, `console`, `web`, … all behave identically from any
 * directory. The pure resolution/probe/classify/render steps live beside this file; these wrappers
 * own the OPERATOR I/O — they colour, print the command-copy line, and exit the process. That is
 * deliberate: this is the workstation layer, not the wire library (core never prints or exits).
 * Two escape hatches take a RAW off-registry connection (no registry lookup, no stale-prune):
 * explicit `--creds`, and `--server` + an unregistered `--space` (an open remote mesh that has no
 * creds to pass).
 */

export interface ConnectFlags {
  server?: string;
  space?: string;
  /** Explicit creds file — triggers a raw off-registry connection (see {@link connectOrExit}). */
  creds?: string;
}

/** Raw NATS auth for an off-registry connection — a join link / --token / --user+--pass / --creds.
 *  Structurally matches what `probeConnect` accepts. */
export interface RawAuth {
  token?: string;
  user?: string;
  pass?: string;
  creds?: string;
  tls?: boolean;
}

export interface Connection {
  server: string;
  space: string;
  creds?: string;
  /** USER-MODE connect material (mode `"user"` only): the Cotal user bearer + the deny-all
   *  sentinel creds, exactly what `EndpointOptions.bearer`/`sentinelCreds` consume. Mutually
   *  exclusive with `creds` — spread {@link endpointAuth} instead of reading either directly. */
  bearer?: string;
  sentinelCreds?: string;
  /** The user-auth registry metadata, when this is a user-mode connection. */
  userAuth?: UserAuthInfo;
  /** The mesh's trust material when resolved from the registry on an auth mesh — undefined for an
   *  open mesh or a raw off-registry connection (`--creds` or `--server`+unregistered `--space`).
   *  (web keeps it for its per-delete manager mint.) */
  auth?: SpaceAuth;
  /** The resolved mesh's recorded checkout root, for a REGISTERED mesh — undefined for a raw
   *  off-registry connection (`--creds`, or `--server`+unregistered `--space`). `spawn -f`/`down -f`
   *  use it to enforce the same-checkout invariant: local launch artifacts + the ledger live under
   *  this checkout, so deploying onto a mesh recorded by another checkout would decouple them. */
  root?: string;
  /** How the target was resolved (registry / current / flag-space / …) — undefined for raw. */
  source?: MeshTarget["source"];
}

/** The one way a command turns a {@link Connection} into endpoint auth options — spread this into
 *  `new CotalEndpoint({...})` instead of passing `creds:` directly, so a user-mode connection
 *  (bearer + sentinel) and a static/raw one (creds) ride the same call sites without each command
 *  re-learning the mode split. */
export function endpointAuth(conn: Connection): { creds?: string; bearer?: string; sentinelCreds?: string } {
  if (conn.bearer && conn.sentinelCreds) return { bearer: conn.bearer, sentinelCreds: conn.sentinelCreds };
  return conn.creds !== undefined ? { creds: conn.creds } : {};
}

/** The ledger actor a HUMAN CLI connect runs as on a user-auth space (v1: one well-known name).
 *  Grant it once per user: `cotal actor grant cli --sub <your IdP subject>`. */
export const CLI_USER_ACTOR = "cli";

/**
 * Resolve where a mesh-touching command connects + with what creds.
 *  • Explicit `--creds` → a RAW off-registry connection: straight to `--server` (default loopback)
 *    as `--space`, with those creds. No registry lookup, no stale-prune, plain reachability message
 *    (the user is deliberately off-registry — e.g. a remote mesh that isn't locally recorded).
 *  • Otherwise → resolve the running mesh from the registry (works from any dir), mint `role` creds
 *    on an auth mesh, and preflight with the registry's stale-prune.
 */
export async function connectOrExit(flags: ConnectFlags, role: Profile): Promise<Connection> {
  if (flags.creds) {
    const server = flags.server ?? DEFAULT_SERVER;
    const space = flags.space ?? DEFAULT_SPACE;
    const creds = readFileSync(flags.creds, "utf8");
    await reachableOrExit(server, { creds });
    return { server, space, creds };
  }
  // A raw OPEN remote mesh: explicit `--server` + a `--space` that isn't locally registered. Naming
  // both is as deliberate as `--creds`, but an open broker has no creds to pass — connect bare,
  // off-registry (no registry lookup, no prune). A registered `--space` still goes through the
  // resolver below (which honors `--server` as an override); `--server` alone resolves there too.
  if (flags.server && flags.space && !findMesh(flags.space)) {
    await reachableOrExit(flags.server, {});
    return { server: flags.server, space: flags.space };
  }
  const target = await resolveTargetOrExit({ server: flags.server, space: flags.space });
  // USER MODE is a HARD branch: it never mints from on-disk trust material (static creds DO work
  // on a user-auth broker — minting here would silently connect the operator on the wrong identity
  // plane) and never connects credlessly. Everything it needs comes from the login cache + the
  // provider's space-scoped state; every failure is one sentence with the exact operator action.
  if (target.mode === "user") return userConnectOrExit(target);
  const creds = target.auth ? await mintCreds(target.auth, newIdentity(), role) : undefined;
  await preflightOrExit(target, creds);
  return { server: target.server, space: target.space, creds, auth: target.auth, root: target.root, source: target.source };
}

/** The user-mode connect: resolve the space's auth provider from the registry (composition-root
 *  supplied — never imported here), exchange this machine's login session for a bearer, and hand
 *  back bearer + sentinel. The provider owns the failure copy for its own steps (not logged in,
 *  service down, actor ungranted) — each is already an exact recovery sentence; this wrapper only
 *  colours and exits (the workstation-layer contract). */
async function userConnectOrExit(target: MeshTarget): Promise<Connection> {
  const ua = target.userAuth!; // mode "user" guarantees it (targetFromEntry throws otherwise)
  let provider: AuthProvider;
  try {
    provider = registry.resolve<AuthProvider>("auth-provider", ua.provider);
  } catch {
    console.error(
      c.red(
        `✗ space "${target.space}" uses the "${ua.provider}" auth provider, which this build does not register — user-auth spaces need it (the official cotal binary includes @cotal-ai/auth)`,
      ),
    );
    process.exit(1);
  }
  try {
    const { bearer, sentinelCreds } = await provider.userCredentials({
      dir: userAuthStateDir(target.root, target.space),
      space: target.space,
      actor: CLI_USER_ACTOR,
    });
    return {
      server: target.server,
      space: target.space,
      bearer,
      sentinelCreds,
      userAuth: ua,
      root: target.root,
      source: target.source,
    };
  } catch (e) {
    console.error(c.red(`✗ ${e instanceof Error ? e.message : String(e)}`));
    process.exit(1);
  }
}

/** Reachability check for a RAW (off-registry) connection — one plain sentence, never a registry/
 *  stale-entry message and never a prune. Used by the `--creds` escape hatch and `join`'s explicit
 *  (link/token/creds) path, both of which connect to a broker the user named, not the registry. */
export async function reachableOrExit(server: string, auth: RawAuth = {}): Promise<void> {
  const probe = await probeConnect(server, auth);
  if (probe.ok) return;
  console.error(c.red(renderWorkspaceError({ kind: "reachable", reason: probe.reason, server })));
  process.exit(1);
}

/** Resolve the mesh a command targets, exiting with one human sentence on an unresolved/ambiguous
 *  registry rather than a stack trace. Prunes dead registry entries first so a crashed mesh doesn't
 *  block a bare command or appear in the "pick one" list — but ONLY when resolving without an
 *  explicit `--space`. A named `--space` is resolved + preflighted directly, so pre-pruning can't
 *  erase a dead-recorded mesh the operator is recovering with a live `--server` override; preflight
 *  still prunes it (with the friendly message) when no override revives it. */
export async function resolveTargetOrExit(flags: {
  server?: string;
  space?: string;
}): Promise<MeshTarget> {
  if (!flags.space) await pruneStaleMeshes();
  let target: MeshTarget;
  try {
    target = resolveMeshTarget(process.cwd(), flags);
  } catch (e) {
    if (isWorkspaceTargetError(e)) {
      console.error(c.red(renderWorkspaceError({ kind: "target", error: e })));
      process.exit(1);
    }
    throw e;
  }
  // If a dangling `current` was silently bypassed — it named a mesh that's since gone and we fell
  // back to the only live one — say so. The N>1 case errors loudly; this is the one spot that would
  // otherwise quietly redirect a stale default.
  const cur = getCurrent();
  if (cur && !findMesh(cur) && target.source === "registry")
    console.error(c.dim(`note: default mesh "${cur}" is down — using "${target.space}"`));
  return target;
}

/** Confirm the resolved mesh is up and accepts these creds — replaces the raw NATS "Authorization
 *  Violation" trace with one sentence, and prunes the entry if the broker is gone / mismatched.
 *  The probe + classify + render live beside this file; this wrapper owns the operator I/O — it
 *  acts on the prune decision, colours, and exits. Probes with `probeCreds` when given (the
 *  caller's `--creds`/minted creds); otherwise a throwaway identity is minted from the target's
 *  own trust material. */
export async function preflightOrExit(target: MeshTarget, probeCreds?: string): Promise<void> {
  const r = await preflightTarget(target, probeCreds);
  if (r.ok) return;
  if (r.prune) removeMesh(target.space);
  console.error(c.red(renderWorkspaceError({ kind: "preflight", failure: r.kind, target, pruned: r.prune })));
  process.exit(1);
}
