import { existsSync, readFileSync } from "node:fs";
import {
  DEFAULT_SERVER,
  DEFAULT_SPACE,
  isReachable,
  mintCreds,
  newIdentity,
  probeConnect,
  registry,
  type AuthProvider,
  type Profile,
  type SpaceAuth,
} from "@cotal-ai/core";
import { c } from "./colors.js";
import { findCotalRoot, userAuthStateDir } from "./auth-paths.js";
import { findMesh, getCurrent, removeMesh, type UserAuthInfo } from "./mesh-registry.js";
import { isWorkspaceTargetError, resolveMeshTarget, type MeshTarget } from "./mesh-target.js";
import { preflightTarget, pruneStaleMeshes } from "./preflight.js";
import { renderWorkspaceError } from "./render.js";

/**
 * The one way every command that touches a running mesh figures out WHICH mesh + with what creds,
 * and confirms it's actually up — shared by every command surface (@cotal-ai/cli, cotal-web)
 * so `spawn`, `send`, `console`, `web`, … all behave identically from any
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

/** The auth material for one ELEVATED user-mode connection (a "view"): bearer + sentinel for the
 *  endpoint or a standalone helper, the bearer's own principal (a bearer-SOURCE endpoint needs it
 *  pinned up front), and a fresh-mint source for standing taps (each call is a full login→exchange
 *  round, so every refresh is a fresh ledger check). */
export interface UserViewAuth {
  bearer: string;
  sentinelCreds: string;
  owner: string;
  actor: string;
  source: () => Promise<string>;
}

/** Mint an elevated-view bearer over an existing user-mode {@link Connection} — the user-mode
 *  path for the operator surfaces (`web`, `console`, `history clear`, `channels`, `spawn -f`).
 *  The view is authorized server-side against the fresh ledger row; a refusal THROWS the exact
 *  re-grant sentence. Call ONLY with a user-mode connection (`conn.bearer` set) — anything else
 *  is a caller bug. Long-running servers (the web delete handler) call THIS and surface the
 *  thrown sentence; CLI startup paths use {@link userViewAuthOrExit}. */
export async function userViewAuth(conn: Connection, view: string): Promise<UserViewAuth> {
  if (!conn.bearer || !conn.userAuth || !conn.root)
    throw new Error(`userViewAuth: not a user-mode registry connection (view "${view}")`);
  const ua = conn.userAuth;
  let provider: AuthProvider;
  try {
    provider = registry.resolve<AuthProvider>("auth-provider", ua.provider);
  } catch {
    throw new Error(
      `space "${conn.space}" uses the "${ua.provider}" auth provider, which this build does not register - user-auth spaces need it (the official cotal binary includes @cotal-ai/auth)`,
    );
  }
  const dir = userAuthStateDir(conn.root, conn.space);
  const mint = () => provider.userCredentials({ dir, space: conn.space, actor: CLI_USER_ACTOR, view });
  const { bearer, sentinelCreds } = await mint();
  const { owner, actor } = principalFromBearer(bearer);
  return { bearer, sentinelCreds, owner, actor, source: () => mint().then((r) => r.bearer) };
}

/** {@link userViewAuth}, workstation-flavoured: colour the thrown sentence and exit. */
export async function userViewAuthOrExit(conn: Connection, view: string): Promise<UserViewAuth> {
  try {
    return await userViewAuth(conn, view);
  } catch (e) {
    console.error(c.red(`✗ ${e instanceof Error ? e.message : String(e)}`));
    process.exit(1);
  }
}

/** The (owner, actor) principal a minted bearer is bound to — read from the JWT payload WITHOUT
 *  verification (client side; the broker verifies). A bearer-source endpoint requires the principal
 *  pinned at construction, and the bearer is the one authoritative place it lives. */
function principalFromBearer(bearer: string): { owner: string; actor: string } {
  try {
    const mid = bearer.split(".")[1];
    if (!mid) throw new Error("not a compact JWS");
    const payload = JSON.parse(Buffer.from(mid, "base64url").toString("utf8")) as {
      sub?: string;
      act?: { actor?: string };
    };
    if (typeof payload.sub !== "string" || !payload.sub || typeof payload.act?.actor !== "string" || !payload.act.actor)
      throw new Error("missing sub/act.actor");
    return { owner: payload.sub, actor: payload.act.actor };
  } catch (e) {
    throw new Error(`could not read the principal from the minted bearer (${e instanceof Error ? e.message : String(e)}) - the auth service's build may be stale; restart it with \`cotal up\``);
  }
}

/** Fail-closed guard for the flip: explicit raw creds are still useful for true off-registry/static
 *  meshes, but not for a user-auth mesh this machine KNOWS about. Otherwise an old static
 *  `local.<nkey>` creds file can bypass the user-mode branch and publish/join through raw `--creds`.
 *  Registry match covers cross-directory use; the on-disk marker covers a lost/stale registry. */
export function refuseStaticCredsForKnownUserAuthOrExit(space: string, server: string | undefined, what: string): void {
  const recorded = findMesh(space);
  const knownRecordedUser = recorded?.mode === "user" && (server === undefined || recorded.server === server);
  const knownLocalUser = existsSync(userAuthStateDir(findCotalRoot(), space));
  if (!knownRecordedUser && !knownLocalUser) return;
  console.error(
    c.red(
      `✗ ${what} tried to authenticate with a static creds file, but space "${space}" is a per-user-auth mesh - old --creds files are refused here so they can't bypass user accounts.`,
    ),
  );
  console.error(c.dim(`  Sign in with \`cotal login\` and use the user-mode path instead (for agents: \`cotal spawn\`).`));
  process.exit(1);
}

/**
 * Resolve where a mesh-touching command connects + with what creds.
 *  • Explicit `--creds` → a RAW off-registry connection, except when the target is a known
 *    per-user-auth mesh. Those refuse static creds fail-closed because old local creds remain
 *    broker-valid but are the wrong identity plane after the flip.
 *  • Otherwise → resolve the running mesh from the registry (works from any dir), mint `role` creds
 *    on an auth mesh, and preflight with the registry's stale-prune.
 */
export async function connectOrExit(flags: ConnectFlags, role: Profile): Promise<Connection> {
  if (flags.creds) {
    const space = flags.space ?? DEFAULT_SPACE;
    // Run the flip guard with the RAW `--server` (may be undefined). The guard treats "no --server"
    // as "any recorded server for this space", so a user mesh on a NON-default port is still
    // recognized when the caller omits --server. Defaulting the server BEFORE the guard would make
    // its `recorded.server === server` match miss every non-4222 user mesh, letting a static --creds
    // slip past the flip.
    refuseStaticCredsForKnownUserAuthOrExit(space, flags.server, "--creds");
    const server = flags.server ?? DEFAULT_SERVER;
    if (!existsSync(flags.creds)) {
      console.error(c.red(`✗ creds file not found: ${flags.creds}`));
      process.exit(1);
    }
    const creds = readFileSync(flags.creds, "utf8");
    await reachableOrExit(server, { creds });
    return { server, space, creds };
  }
  // A raw OPEN remote mesh: explicit `--server` + a `--space` that isn't locally registered. Naming
  // both is as deliberate as `--creds`, but an open broker has no creds to pass — connect bare,
  // off-registry (no registry lookup, no prune). A registered `--space` still goes through the
  // resolver below (which honors `--server` as an override); `--server` alone resolves there too.
  if (flags.server && flags.space && !findMesh(flags.space)) {
    // Fail-closed marker, same posture as the resolver's: this machine may hold USER-AUTH state
    // for that very space even when the registry lost (or never had) the entry — treating it as an
    // open broker would credless-connect into a callout denial whose copy sends the operator
    // port-hunting. Name the real state and the recovery instead.
    if (existsSync(userAuthStateDir(findCotalRoot(), flags.space))) {
      console.error(
        c.red(
          `✗ space "${flags.space}" has user auth enabled on disk but no usable registry entry - re-record it with \`cotal up\` from its project folder, then sign in (\`cotal login\`)`,
        ),
      );
      process.exit(1);
    }
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
        `✗ space "${target.space}" uses the "${ua.provider}" auth provider, which this build does not register - user-auth spaces need it (the official cotal binary includes @cotal-ai/auth)`,
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
    console.error(c.dim(`note: default mesh "${cur}" is down - using "${target.space}"`));
  return target;
}

/** Confirm the resolved mesh is up and accepts these creds — replaces the raw NATS "Authorization
 *  Violation" trace with one sentence, and prunes the entry if the broker is gone / mismatched.
 *  The probe + classify + render live beside this file; this wrapper owns the operator I/O — it
 *  acts on the prune decision, colours, and exits. Probes with `probeCreds` when given (the
 *  caller's `--creds`/minted creds); otherwise a throwaway identity is minted from the target's
 *  own trust material. */
export async function preflightOrExit(target: MeshTarget, probeCreds?: string): Promise<void> {
  // USER-mode targets are never credless-probed here: the callout denies a bare connect, the
  // classifier reads that as a stale registry entry, and the PRUNE deletes a healthy mesh's
  // record (found live: foreground `spawn` did exactly this and every later command fell into
  // raw-path copy). Liveness is the only mode-blind read; the real auth preflight for a user
  // target is the user connect / bearer chain itself.
  if (target.mode === "user") {
    if (await isReachable(target.server)) return;
    console.error(c.red(`✗ mesh "${target.space}" at ${target.server} is not reachable - start it with \`cotal up\` from its project folder`));
    process.exit(1);
  }
  const r = await preflightTarget(target, probeCreds);
  if (r.ok) return;
  if (r.prune) removeMesh(target.space);
  console.error(c.red(renderWorkspaceError({ kind: "preflight", failure: r.kind, target, pruned: r.prune })));
  process.exit(1);
}
