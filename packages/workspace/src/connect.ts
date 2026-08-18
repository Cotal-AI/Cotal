import { existsSync, readFileSync } from "node:fs";
import {
  DEFAULT_SERVER,
  DEFAULT_SPACE,
  DEV_OWNER,
  instancePinnedInstrumentCapabilities,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  probeConnect,
  registry,
  type AuthProvider,
  type EpCaller,
  type Profile,
  type SpaceAuth,
} from "@cotal-ai/core";
import { c } from "./colors.js";
import { findCotalRoot, hasUserAuthState, userAuthStateDir } from "./auth-paths.js";
import { workspaceSecretStore } from "./secret-store-fs.js";
import { findMesh, getCurrent, pruneMesh, type UserAuthInfo } from "./mesh-registry.js";
import { isWorkspaceTargetError, resolveMeshTarget, type MeshTarget } from "./mesh-target.js";
import { preflightTarget, pruneStaleMeshes } from "./preflight.js";
import { renderWorkspaceError } from "./render.js";

/**
 * The one way every command that touches a running mesh figures out WHICH mesh + with what creds,
 * and confirms it's actually up — shared by every command surface (@cotal-ai/cli, @cotal-ai/web)
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
  /** Whether this connection must REQUIRE TLS, rather than merely tolerate it.
   *
   *  NON-OPTIONAL on purpose, and it is the same reasoning as the broker's transport union. An
   *  optional flag is omitted by default, and the default here is the dangerous one: a client with
   *  no TLS requirement connects happily to a plaintext broker and sends its credentials in the
   *  clear, including to an on-path attacker who forged the unauthenticated INFO. Every site that
   *  builds a `Connection` must therefore SAY which it is, and the compiler asks.
   *
   *  Derive it from the resolved mesh record (`MeshEntry.tlsRequired`) or an explicit `cotals://`
   *  link — never re-decide it per call site. Five places each deciding "is this mesh TLS" is four
   *  chances to get it right and one to be silently wrong. */
  tls: boolean;
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
  /** The connection's v0.4 caller triple (SPEC §13.2), present when this connection can ride the
   *  ep rails: a minted operator INSTRUMENT (`control-caller-*` / `deployer`, static trust
   *  material - the mint pins a fresh lifecycle uid) or a USER-mode bearer (the callout mints the
   *  cli actor's rows keyed on the bearer's ledger lifecycle claim). The caller needs the same
   *  triple to build its request subjects (`askManager`'s ep path). Absent exactly for open meshes
   *  and raw off-registry creds (still ctl until 1d). */
  epCaller?: EpCaller;
}

/** The one way a command turns a {@link Connection} into endpoint auth options — spread this into
 *  `new CotalEndpoint({...})` instead of passing `creds:` directly, so a user-mode connection
 *  (bearer + sentinel) and a static/raw one (creds) ride the same call sites without each command
 *  re-learning the mode split. */
/** The connect material for one resolved connection, spread straight into `CotalEndpoint` options
 *  or a standalone helper.
 *
 *  `tls` rides along with the credentials DELIBERATELY. It used to be dropped here — this function
 *  returned creds/bearer only — which meant every caller that spread `endpointAuth(conn)` got the
 *  identity and silently lost the transport requirement. That is the failure with no symptom: the
 *  connection still works against an honest TLS broker (the client upgrades on the server's INFO),
 *  so nothing looks wrong until an on-path attacker forges an INFO without `tls_required` and
 *  collects the credentials in the clear. Keeping the two together means a caller cannot take the
 *  identity without also taking the requirement that protects it. */
export function endpointAuth(conn: Connection): { creds?: string; bearer?: string; sentinelCreds?: string; tls?: boolean } {
  const tls = conn.tls ? { tls: true as const } : {};
  if (conn.bearer && conn.sentinelCreds) return { bearer: conn.bearer, sentinelCreds: conn.sentinelCreds, ...tls };
  return conn.creds !== undefined ? { creds: conn.creds, ...tls } : { ...tls };
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
  /** The bearer's ledger lifecycle claim - with (owner, actor) the v0.4 caller triple the
   *  callout-minted instrument-view rows pin (1c.2c). */
  lifecycleUid: string;
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
  const store = workspaceSecretStore(conn.root);
  const mint = () => provider.userCredentials({ store, dir, space: conn.space, actor: CLI_USER_ACTOR, view });
  const { bearer, sentinelCreds } = await mint();
  const { owner, actor, lifecycleUid } = principalFromBearer(bearer);
  return { bearer, sentinelCreds, owner, actor, lifecycleUid, source: () => mint().then((r) => r.bearer) };
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

/** The (owner, actor, lifecycleUid) principal a minted bearer is bound to — read from the JWT
 *  payload WITHOUT verification (client side; the broker verifies). A bearer-source endpoint
 *  requires the principal pinned at construction, and the caller triple (1c.2c: the v0.4 ep-rail
 *  subjects the callout-minted rows pin) needs the ledger lifecycle claim too — the bearer is the
 *  one authoritative place all three live. */
function principalFromBearer(bearer: string): { owner: string; actor: string; lifecycleUid: string } {
  try {
    const mid = bearer.split(".")[1];
    if (!mid) throw new Error("not a compact JWS");
    const payload = JSON.parse(Buffer.from(mid, "base64url").toString("utf8")) as {
      sub?: string;
      act?: { actor?: string; lifecycleUid?: string };
    };
    if (typeof payload.sub !== "string" || !payload.sub || typeof payload.act?.actor !== "string" || !payload.act.actor)
      throw new Error("missing sub/act.actor");
    if (typeof payload.act.lifecycleUid !== "string" || !payload.act.lifecycleUid)
      throw new Error("missing act.lifecycleUid (lifecycle-bound bearers are the v0.4 hard cut)");
    return { owner: payload.sub, actor: payload.act.actor, lifecycleUid: payload.act.lifecycleUid };
  } catch (e) {
    throw new Error(`could not read the principal from the minted bearer (${e instanceof Error ? e.message : String(e)}) - the auth service's build may be stale; restart it with \`cotal up\``);
  }
}

/** Fail-closed guard for the flip: explicit raw creds are still useful for true off-registry/static
 *  meshes, but not for a user-auth mesh this machine KNOWS about. Otherwise an old static
 *  `local.<nkey>` creds file can bypass the user-mode branch and publish/join through raw `--creds`.
 *  Registry match covers cross-directory use; the on-disk marker covers a lost/stale registry. */
export function refuseStaticCredsForKnownUserAuth(space: string, server: string | undefined, what: string): void {
  const recorded = findMesh(space);
  const knownRecordedUser = recorded?.mode === "user" && (server === undefined || recorded.server === server);
  const knownLocalUser = hasUserAuthState(findCotalRoot(), space);
  if (!knownRecordedUser && !knownLocalUser) return;
  throw new ConnectRefusal(
    `✗ ${what} tried to authenticate with a static creds file, but space "${space}" is a per-user-auth mesh - old --creds files are refused here so they can't bypass user accounts.`,
    `  Sign in with \`cotal login\` and use the user-mode path instead (for agents: \`cotal spawn\`).`,
  );
}

/** {@link refuseStaticCredsForKnownUserAuth} with the exiting disposition, for the callers that are
 *  one command deep and want the refusal to end it. */
export function refuseStaticCredsForKnownUserAuthOrExit(space: string, server: string | undefined, what: string): void {
  try {
    refuseStaticCredsForKnownUserAuth(space, server, what);
  } catch (e) {
    exitOnRefusal(e);
  }
}

/**
 * A refusal from the connect path, carrying the exact sentence the operator would have been shown.
 *
 * Every step below has one answer for "this cannot be connected", and until now that answer was
 * always `print it and end the process`. That is right for a person who just typed a command and
 * wrong for anything that has to KEEP GOING: `cotal attach` re-establishing a session after the
 * link died has to treat an unreachable broker as the transient it is, and it cannot do that
 * through a function that exits. So the decision (what happened, and what to say about it) is
 * separated from the disposition (print and exit, or throw), and `connectOrExit` is now a thin
 * wrapper that supplies the exiting disposition. The two forms cannot drift in what they say
 * because there is only one place the sentence is written.
 */
export class ConnectRefusal extends Error {
  constructor(readonly rendered: string, readonly hint?: string) {
    super(rendered);
    this.name = "ConnectRefusal";
  }
}

/** The exiting disposition, in ONE place: print what the refusal already decided to say, and end
 *  the command. Anything that is not a {@link ConnectRefusal} is a real fault and rethrows. */
function exitOnRefusal(e: unknown): never {
  if (!(e instanceof ConnectRefusal)) throw e;
  console.error(c.red(e.rendered));
  if (e.hint) console.error(c.dim(e.hint));
  process.exit(1);
}

/**
 * Resolve where a mesh-touching command connects + with what creds, THROWING {@link ConnectRefusal}
 * on every refusal instead of ending the process. {@link connectOrExit} is this plus the printing
 * and the exit; a caller that must survive a refusal (a reconnect loop) calls this one.
 *  • Explicit `--creds` → a RAW off-registry connection, except when the target is a known
 *    per-user-auth mesh. Those refuse static creds fail-closed because old local creds remain
 *    broker-valid but are the wrong identity plane after the flip.
 *  • Otherwise → resolve the running mesh from the registry (works from any dir), mint `role` creds
 *    on an auth mesh, and preflight with the registry's stale-prune.
 */
export async function connectOrThrow(flags: ConnectFlags, role: Profile, opts: { instanceId?: string | string[] } = {}): Promise<Connection> {
  if (flags.creds) {
    const space = flags.space ?? DEFAULT_SPACE;
    // Run the flip guard with the RAW `--server` (may be undefined). The guard treats "no --server"
    // as "any recorded server for this space", so a user mesh on a NON-default port is still
    // recognized when the caller omits --server. Defaulting the server BEFORE the guard would make
    // its `recorded.server === server` match miss every non-4222 user mesh, letting a static --creds
    // slip past the flip.
    refuseStaticCredsForKnownUserAuth(space, flags.server, "--creds");
    const server = flags.server ?? DEFAULT_SERVER;
    if (!existsSync(flags.creds)) throw new ConnectRefusal(`✗ creds file not found: ${flags.creds}`);
    const creds = readFileSync(flags.creds, "utf8");
    // An explicit `--creds` file is an off-registry connect: no mesh record, so no recorded TLS
    // intent to inherit. It stays non-strict, and that is a real (documented) gap rather than a
    // safe default - a `--creds` connect to a TLS broker still upgrades, but is downgradeable.
    await reachableOrThrow(server, { creds });
    return { server, space, tls: false, creds };
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
    if (hasUserAuthState(findCotalRoot(), flags.space))
      throw new ConnectRefusal(
        `✗ space "${flags.space}" has user auth enabled on disk but no usable registry entry - re-record it with \`cotal up\` from its project folder, then sign in (\`cotal login\`)`,
      );
    // A raw OPEN remote broker named entirely on the command line: nothing recorded it, so there
    // is no intent to honour. Non-strict, same documented gap as `--creds`.
    await reachableOrThrow(flags.server, {});
    return { server: flags.server, space: flags.space, tls: false };
  }
  const target = await resolveTargetOrThrow({ server: flags.server, space: flags.space });
  // USER MODE is a HARD branch: it never mints from on-disk trust material (static creds DO work
  // on a user-auth broker — minting here would silently connect the operator on the wrong identity
  // plane) and never connects credlessly. Everything it needs comes from the login cache + the
  // provider's space-scoped state; every failure is one sentence with the exact operator action.
  //
  // The logged-in user bearer is the control surface; ledger scope is the grant. Operator
  // INSTRUMENTS (`control-caller-*`) are static-mesh only — they carry rows the user bearer does
  // not (the freeze STREAM.INFO read). Requesting one here used to fall through to the user bearer
  // silently, so a caller believed it held instrument grants it did not. Refuse loud.
  // `deployer` is NOT in that set: user-mode deploy connects as the bearer then elevates via
  // `userViewAuth("deployer")`, which is a real exchange, not a silent substitute.
  //
  // Role is ignored for MINTING on this path (there is no instrument mint). The caller triple
  // still lands: `userConnectOrExit` sets `epCaller` from the bearer's principal, so ep request
  // subjects can be built. "Never consults role" means never mints by role — not "no triple".
  if (target.mode === "user") {
    if (role === "control-caller-privileged" || role === "control-caller-admin")
      throw new ConnectRefusal(
        `✗ cannot mint the "${role}" instrument on a user-mode mesh - the logged-in user bearer is the control surface (ledger scope is the grant). Operator instruments are static-mesh only.`,
      );
    // NAMED, not overlooked: the user-mode connect still ends the process on its own refusals. No
    // reconnect loop reaches it (`cotal attach` refuses a user-mode mesh before it ever loops, and
    // a static mesh does not become a user mesh mid-session), and dragging that path into this
    // refactor would widen the diff well past the one behaviour it exists to fix.
    return userConnectOrExit(target);
  }
  // An operator INSTRUMENT mint pins a fresh lifecycle uid: its ep-rail caller rows are
  // lifecycle-keyed (SPEC §13.1/§13.2 — the reply rail names one incarnation), and the caller
  // needs the triple back to build its request subjects. Every other profile mints as before.
  const instrument = role === "control-caller-privileged" || role === "control-caller-admin" || role === "deployer";
  let creds: string | undefined;
  let epCaller: EpCaller | undefined;
  if (target.auth) {
    const identity = newIdentity();
    if (instrument) {
      const uid = mintLifecycleUid();
      // `--on <instanceId>`: pin THIS one-shot instrument to the instance the resolve already
      // chose, so it is issued the exact `ep.inst.<endpoint>.<iid>.<command>` rows for this
      // invocation. Without it the instrument holds only class-rail rows, every instance-addressed
      // request is refused at the broker, and the client renders that refusal as a describe
      // timeout — so `--on` reads as an unresponsive manager rather than an unminted grant. The
      // capability SHAPE is core's to define; this site only decides that a pin was asked for.
      // Only the two control-caller tiers take it: `deployer` mints through a different arm that
      // does not consume endpoint capabilities, so pinning it here would silently do nothing.
      const tier = role === "control-caller-admin" ? "admin" : "privileged";
      const pinned = opts.instanceId !== undefined && role !== "deployer"
        ? instancePinnedInstrumentCapabilities(tier, opts.instanceId)
        : undefined;
      creds = await mintCreds(target.auth, identity, role, { lifecycleUid: uid, ...(pinned ? { endpointCapabilities: pinned } : {}) });
      epCaller = { owner: DEV_OWNER, actor: identity.id, uid };
    } else {
      creds = await mintCreds(target.auth, identity, role);
    }
  }
  await preflightOrThrow(target, creds);
  // THE REGISTRY-RESOLVED PATH, and the one that must inherit the recorded decision: if the mesh
  // record says this broker is TLS-required, the connection REQUIRES it. This is the site whose
  // omission had no symptom - it connects either way against an honest broker.
  return {
    server: target.server, space: target.space, tls: target.tlsRequired, creds, auth: target.auth, root: target.root, source: target.source,
    ...(epCaller ? { epCaller } : {}),
  };
}

/**
 * Connect as the logged-in user on a user-auth mesh. **No profile/role argument** — there is no
 * instrument mint on this path; ledger scope is the grant and `epCaller` comes from the bearer
 * principal. Prefer this over `connectOrExit(..., someRole)` whenever the caller already knows
 * (or has just learned) the mesh is user-mode: a dummy role is a value that is meaningless today
 * and wrong the day this path starts consulting it.
 *
 * If this function is ever changed to accept or consult a {@link Profile}, every caller is wrong.
 */
export async function connectUserControlOrExit(flags: ConnectFlags): Promise<Connection> {
  if (flags.creds) {
    console.error(
      c.red(
        "✗ connectUserControlOrExit is the user-mode control path - it does not take --creds (that is the static/raw instrument path via connectOrExit)",
      ),
    );
    process.exit(1);
  }
  const target = await resolveTargetOrExit({ server: flags.server, space: flags.space });
  if (target.mode !== "user") {
    console.error(
      c.red(
        `✗ connectUserControlOrExit requires a user-auth mesh (resolved mode is "${target.mode}") - use connectOrExit with an instrument profile on static/open meshes`,
      ),
    );
    process.exit(1);
  }
  return userConnectOrExit(target);
}

/** The user-mode connect: resolve the space's auth provider from the registry (composition-root
 *  supplied — never imported here), exchange this machine's login session for a bearer, and hand
 *  back bearer + sentinel. The provider owns the failure copy for its own steps (not logged in,
 *  service down, actor ungranted) — each is already an exact recovery sentence; this wrapper only
 *  colours and exits (the workstation-layer contract).
 *
 *  Takes a resolved target only — never a Profile. Callers that know the mesh is user-mode must
 *  enter via {@link connectUserControlOrExit} (no role) or the user branch of {@link connectOrExit}
 *  (which refuses control-caller-* instruments). If a Profile is ever threaded into this function,
 *  the call sites that invented dummy roles are the defect. */
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
      store: workspaceSecretStore(target.root),
      dir: userAuthStateDir(target.root, target.space),
      space: target.space,
      actor: CLI_USER_ACTOR,
    });
    // The v0.4 caller triple (1c.2c): the callout mints the cli actor's ep-rail rows keyed on the
    // LEDGER lifecycle claim the bearer carries - the same three tokens, read client-side, let
    // askManager's ep path build its request subjects. A re-granted alias invalidates the triple
    // at the next exchange, exactly when the rows change.
    const p = principalFromBearer(bearer);
    return {
      server: target.server,
      space: target.space,
      tls: target.tlsRequired,
      bearer,
      sentinelCreds,
      userAuth: ua,
      root: target.root,
      source: target.source,
      epCaller: { owner: p.owner, actor: p.actor, uid: p.lifecycleUid },
    };
  } catch (e) {
    console.error(c.red(`✗ ${e instanceof Error ? e.message : String(e)}`));
    process.exit(1);
  }
}

/** Reachability check for a RAW (off-registry) connection — one plain sentence, never a registry/
 *  stale-entry message and never a prune. Used by the `--creds` escape hatch and `join`'s explicit
 *  (link/token/creds) path, both of which connect to a broker the user named, not the registry. */
export async function reachableOrThrow(server: string, auth: RawAuth = {}): Promise<void> {
  const probe = await probeConnect(server, auth);
  if (probe.ok) return;
  // Whether the caller actually presented anything to be rejected. `tls` is deliberately not part
  // of this: it is transport, not identity, and a TLS-only connection presents no credential.
  const hasAuth = Boolean(auth.creds ?? auth.token ?? (auth.user && auth.pass));
  throw new ConnectRefusal(renderWorkspaceError({ kind: "reachable", reason: probe.reason, server, hasAuth }));
}

/** {@link reachableOrThrow} with the exiting disposition. */
export async function reachableOrExit(server: string, auth: RawAuth = {}): Promise<void> {
  try {
    await reachableOrThrow(server, auth);
  } catch (e) {
    exitOnRefusal(e);
  }
}

/** Resolve the mesh a command targets, exiting with one human sentence on an unresolved/ambiguous
 *  registry rather than a stack trace. Prunes dead registry entries first so a crashed mesh doesn't
 *  block a bare command or appear in the "pick one" list — but ONLY when resolving without an
 *  explicit `--space`. A named `--space` is resolved + preflighted directly, so pre-pruning can't
 *  erase a dead-recorded mesh the operator is recovering with a live `--server` override; preflight
 *  still prunes it (with the friendly message) when no override revives it. */
export async function resolveTargetOrThrow(flags: {
  server?: string;
  space?: string;
}): Promise<MeshTarget> {
  if (!flags.space) await pruneStaleMeshes();
  let target: MeshTarget;
  try {
    target = resolveMeshTarget(process.cwd(), flags);
  } catch (e) {
    if (isWorkspaceTargetError(e)) throw new ConnectRefusal(renderWorkspaceError({ kind: "target", error: e }));
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
export async function preflightOrThrow(target: MeshTarget, probeCreds?: string): Promise<void> {
  // USER-mode targets are never credless-probed here: the callout denies a bare connect, the
  // classifier reads that as a stale registry entry, and the PRUNE deletes a healthy mesh's
  // record (found live: foreground `spawn` did exactly this and every later command fell into
  // raw-path copy). Liveness is the only mode-blind read; the real auth preflight for a user
  // target is the user connect / bearer chain itself.
  if (target.mode === "user") {
    if (await isReachable(target.server)) return;
    throw new ConnectRefusal(`✗ mesh "${target.space}" at ${target.server} is not reachable - start it with \`cotal up\` from its project folder`);
  }
  const r = await preflightTarget(target, probeCreds);
  if (r.ok) return;
  // The classifier says whether this failure is a stale-entry signal; `pruneMesh` says whether the
  // record is one an automatic sweep may delete (an operator-registered mesh is not). The message
  // reports what ACTUALLY happened, so it never claims a removal that the registry refused.
  const pruned = r.prune ? pruneMesh(target.space) : false;
  throw new ConnectRefusal(renderWorkspaceError({ kind: "preflight", failure: r.kind, target, pruned }));
}

/** {@link preflightOrThrow} with the exiting disposition. */
export async function preflightOrExit(target: MeshTarget, probeCreds?: string): Promise<void> {
  try {
    await preflightOrThrow(target, probeCreds);
  } catch (e) {
    exitOnRefusal(e);
  }
}

/**
 * {@link connectOrThrow} with the exiting disposition: the form nearly every command wants, where a
 * refusal is the end of the command and the operator gets one sentence rather than a stack trace.
 */
export async function connectOrExit(flags: ConnectFlags, role: Profile, opts: { instanceId?: string | string[] } = {}): Promise<Connection> {
  try {
    return await connectOrThrow(flags, role, opts);
  } catch (e) {
    exitOnRefusal(e);
  }
}

/** {@link resolveTargetOrThrow} with the exiting disposition. */
export async function resolveTargetOrExit(flags: { server?: string; space?: string }): Promise<MeshTarget> {
  try {
    return await resolveTargetOrThrow(flags);
  } catch (e) {
    exitOnRefusal(e);
  }
}
