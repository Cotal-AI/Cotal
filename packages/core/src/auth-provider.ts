import { registry, type Extension } from "./registry.js";
import type { SecretStore } from "./secret-store.js";

/**
 * The one extension kind an identity/auth implementation registers so a composition root can turn
 * on USER-MODE auth (the human-owner identity plane over per-agent NATS identity) WITHOUT importing
 * that implementation. `@cotal-ai/auth` self-registers one on import; the `cotal` binary pulls the
 * package in, and the CLI resolves it generically (`registry.all<AuthProvider>("auth-provider")`).
 *
 * Guarded core: this seam is IdP-agnostic and knows nothing about callouts, bearers, ledgers, or
 * any concrete IdP. It exchanges a NARROW provisioning input (exactly the signing material the
 * provider's function requires — never the whole space trust bundle) for the operator-signed
 * accounts the broker config preloads, plus opaque client metadata and a service handle. All
 * auth-specific substance stays behind these types.
 *
 * No provider registered ⇒ user-mode auth is unavailable and requesting it MUST fail loud (no
 * static fallback) — a library root that never imports the auth package simply cannot serve a
 * user-auth space.
 *
 * TWO state surfaces, split by the {@link SecretStore} seam: the provider's SECRET material
 * (callout account, issuer keys, owner secret, service key projection) rides the `store` each
 * method receives — the CALLER composes it (locally the workspace's `.cotal`-rooted filesystem
 * store; a hosted composition injects KMS/Vault), the provider never discovers one ambiently.
 * The provider's NON-SEAM state (the actor ledger, the IdP pin, service runtime discovery)
 * stays under `dir`, the local state directory.
 */
export interface AuthProvider extends Extension {
  readonly kind: "auth-provider";
  /**
   * Ensure this space's user-auth material exists (generated + persisted on the first call, reused
   * verbatim after — account identities and signing keys MUST be stable across restarts or
   * previously-issued credentials break) and describe what the composition root must wire up.
   * Secret material persists through `input.store`; non-seam state under `input.dir`. Idempotent. This call may hold the provisioning seeds BRIEFLY; the long-lived service
   * process must load only provider-owned projected files written here, never the space's full
   * trust bundle.
   */
  prepareServer(input: AuthPrepareInput): Promise<AuthPrepared>;
  /**
   * CLIENT side: produce the connect material for a user-mode space from THIS machine's session
   * state (the login cache + the provider's space-scoped state — secrets in `store`, the rest
   * under `dir`). `actor` is the
   * ledger-granted agent-instance the caller connects as. Returns what {@link EndpointOptions}'
   * user mode consumes (`bearer` + `sentinelCreds`). MUST fail loud with the EXACT operator
   * action when anything is missing — not logged in (`cotal login --idp …`), the auth service
   * down (how to restart it), the actor ungranted (how to grant) — and NEVER falls back to any
   * other auth mode.
   *
   * `view` requests an ELEVATED per-connection profile (opaque to core; the provider validates it
   * against its closed view enum and the fresh ledger grant) — the god-view/purge/registry-write/
   * deploy connections the operator surfaces (`web`, `console`, `history clear`, `channels`,
   * `spawn -f`) ride. An under-scoped or unknown view MUST fail loud with the exact re-grant.
   */
  userCredentials(opts: { store: SecretStore; dir: string; space: string; actor: string; view?: string }): Promise<{ bearer: string; sentinelCreds: string }>;
  /**
   * The derived owner token (`u_…`) of THIS machine's cached login for the given space — resolved
   * offline from the login session + the space's local user-auth material (no IdP round trip).
   * The spawn paths use it to answer "whose agents are these": a foreground/manifest spawn runs
   * the agents under the OPERATOR's owner. MUST fail loud when not logged in (naming the exact
   * `cotal login --idp …` line) or when the space has no user-auth material (in `store`/`dir`).
   */
  ownerForLogin(opts: { store: SecretStore; dir: string; space: string }): Promise<string>;
  /**
   * Read-only OFFLINE introspection for status surfaces (`cotal status`): this machine's cached
   * login for the space and — where the space's ledger is locally readable — whether that login's
   * `actor` is granted. Never network-bound and never a mint; "not signed in" is a REPORTED state
   * here, not a thrown one. Throws only when the space has no user-auth material in `store`/`dir`
   * (there is nothing to report status about).
   */
  userStatus(opts: { store: SecretStore; dir: string; space: string; actor: string }): Promise<UserAuthStatus>;
  /**
   * SERVER side, agent lifecycle: author an agent grant for `(owner, actor)` in this space's
   * ledger — the spawn path's half of "actors are server-ledger-authorized, never taken from
   * connect payloads". Returns the ONE-TIME plaintext agent secret (persisted only as a hash;
   * the caller delivers it to the agent process via a 0600 file and never sees it again) plus
   * the sentinel creds the agent presents alongside its bearers. Upsert — re-granting an actor
   * rotates its secret. MUST fail loud when the space has no user-auth material in `store`/`dir`.
   */
  grantAgent(opts: {
    store: SecretStore;
    dir: string;
    space: string;
    owner: string;
    actor: string;
    scope: string[];
    allowSubscribe: string[];
    allowPublish: string[];
    role?: string;
    /** The spawning principal (`<owner>.<actor>` dot-form) — the grant's audit link. */
    parent?: string;
    label?: string;
  }): Promise<{ actorToken: string; sentinelCreds: string }>;
  /** Revoke an agent grant. False when there was nothing to revoke. New exchanges and new
   *  connects die immediately (both boundaries read the ledger fresh); an already-live
   *  connection dies at its bearer-bound JWT expiry (live eviction is a separate lever). */
  revokeAgent(opts: { dir: string; owner: string; actor: string }): Promise<boolean>;
  /**
   * Read-only FRESH capability-scope read for one granted principal — `undefined` when the
   * principal holds no grant (for an authorization read, unknowable is "no grant": fail-closed).
   * Never a mint, never a write. The manager's named-target control authorization (owner-domain
   * stop/attach) consults it for its else-branch — "does the caller hold `admin`?" — reading
   * fresh so a scope edit bites the caller's next control op with no restart or reconnect.
   */
  actorScope(opts: { dir: string; owner: string; actor: string }): Promise<string[] | undefined>;
  /**
   * Remove this provider's SECRET material for a space from the given store — the DELETE half of
   * the seam pair (every kind that reads and writes through a {@link SecretStore} must be
   * deletable through it, or a reset wipes local identity while an injected backend keeps the old
   * secrets authoritative: split authority, and the next provision mixes a fresh trust bundle
   * with stale stable identities). Attempts EVERY owned key even when one fails (each delete is
   * idempotent by the store contract, so a failed pass is retryable as-is), then throws with the
   * collected failures. Touches ONLY the store — non-seam state (ledger, IdP pin, discovery) is
   * the caller's local-reset concern, swept only AFTER this succeeds.
   */
  deprovisionSecrets(opts: { store: SecretStore; space: string }): Promise<void>;
  /**
   * Registry name of the provider's self-registered {@link Command} that prints ONE fresh agent
   * bearer to stdout and exits (flags: `--dir <state-dir> --space <space> --owner <o> --actor <a>
   * --token-file <path>`). A long-lived agent endpoint execs it per refresh — the exchange
   * protocol, discovery, and secret handling stay entirely behind the provider; the agent-side
   * runtime only runs an argv and reads a line. */
  readonly agentBearerCommand: string;
}

/** The ONE registered auth provider, or a thrown sentence naming the fix. More than one registered
 *  is ambiguous and refuses just as loudly — there is no pick-the-first fallback. Lives in core so
 *  every surface that resolves the provider generically (CLI, manager) shares one resolution. */
export function resolveAuthProvider(): AuthProvider {
  const providers = registry.all<AuthProvider>("auth-provider");
  if (providers.length === 0)
    throw new Error(
      "no auth provider is registered in this build - user auth needs one (the `cotal` binary registers @cotal-ai/auth; a custom composition root must import an auth package)",
    );
  if (providers.length > 1)
    throw new Error(`multiple auth providers registered (${providers.map((p) => p.name).join(", ")}) - cannot choose between them`);
  return providers[0];
}

/** What {@link AuthProvider.userStatus} reports. Fields are absent when locally unknowable —
 *  absence is honest ("can't tell from here"), never a guess. */
export interface UserAuthStatus {
  /** The space's pinned IdP base URL (always known — it is part of the user-auth material). */
  idpUrl: string;
  /** This machine's cached login for that IdP; absent = not signed in. */
  login?: { sub: string; expiresAt: number };
  /** The login's derived owner token (`u_…`) for this space. */
  owner?: string;
  /** The (owner, actor) interactive ledger row: its lists when granted, `"not-granted"` when the
   *  locally-readable ledger has no row. Absent when the ledger is not on this machine. */
  grant?:
    | { scope: string[]; allowSubscribe: string[]; allowPublish: string[]; role?: string; label?: string }
    | "not-granted";
}

/** The provisioning input — deliberately NARROW (a capability boundary, not a convenience): the
 *  operator seed signs the provider's dedicated account(s) once; the data-account signing seed is
 *  projected into the service's own key file because minting scoped data-account users at connect
 *  time IS the service's function. Nothing else of the space bundle crosses this seam. */
export interface AuthPrepareInput {
  space: string;
  /** The space operator's signing seed — used once per fresh space, to sign the provider's
   *  dedicated account(s) into the operator's trust chain. */
  operatorSeed: string;
  /** The data account users are bound into: its public key + the signing seed that mints its
   *  users (projected to the service's key file; the ACCOUNT seed itself never crosses). */
  account: { pub: string; signingSeed: string };
  /** Where the provider's SECRET material persists (callout account, issuer keys, owner secret,
   *  service key projection) — caller-composed, keys are the provider's own. Locally the
   *  workspace's `.cotal`-rooted filesystem store; a hosted composition injects its backend. */
  store: SecretStore;
  /** The provider's OWN state dir for NON-SEAM state (actor ledger, IdP pin, service runtime
   *  discovery). The caller keys it — today `<root>/.cotal/auth/<space>`; a future
   *  (broker, space) key is a caller change, never an on-disk format break. */
  dir: string;
  /** The operator's external identity-provider base URL (`up --user-auth --idp <url>`), OPAQUE to
   *  core — the provider pins/persists it (first call requires one; a later call must match the
   *  persisted pin or omit it; re-pointing an IdP is a migration, never a flag flip). */
  idpUrl?: string;
}

/** What `prepareServer` hands back to the composition root. */
export interface AuthPrepared {
  /** Operator-signed accounts the broker config must preload in its resolver (e.g. a dedicated
   *  callout account, which must never share the data account). */
  extraAccounts: Array<{ pub: string; jwt: string }>;
  /** NON-SECRET client-facing metadata (trust pins, provider id) for the workstation layer's mesh
   *  registry, so connects from other directories can print exact recovery actions. Opaque to
   *  core — the workspace layer owns the concrete shape. */
  publicAuth: Record<string, unknown>;
  /** The long-lived auth service this space needs running alongside its broker. */
  service: AuthServiceSpec;
}

/** The provider's daemon, by contract rather than convention: which registered {@link Command} to
 *  spawn (the CLI re-execs `cotal <command> --space … --server …` detached, pid/log space-scoped),
 *  and how to know it is actually SERVING — so `up` never records a usable user mesh on a
 *  half-started service, and never invents ad-hoc readiness sleeps. */
export interface AuthServiceSpec {
  /** Registry name of the self-registered daemon command (e.g. `"auth-service"`). Resolved through
   *  the command registry and exec'd as argv — never shell-interpolated. */
  command: string;
  /** Wait until the running service is READY (every plane bound — e.g. broker subscription AND
   *  local endpoints). Resolves with the service's runtime, non-secret endpoint metadata for the
   *  mesh registry; THROWS (with the reason) on timeout — the caller surfaces it, loudly. */
  ready(opts: { dir: string; timeoutMs?: number }): Promise<Record<string, unknown>>;
}
