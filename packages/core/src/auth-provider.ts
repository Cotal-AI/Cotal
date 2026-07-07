import type { Extension } from "./registry.js";

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
 */
export interface AuthProvider extends Extension {
  readonly kind: "auth-provider";
  /**
   * Ensure this space's user-auth material exists under `input.dir` (generated + persisted on the
   * first call, reused verbatim after — account identities and signing keys MUST be stable across
   * restarts or previously-issued credentials break) and describe what the composition root must
   * wire up. Idempotent. This call may hold the provisioning seeds BRIEFLY; the long-lived service
   * process must load only provider-owned projected files written here, never the space's full
   * trust bundle.
   */
  prepareServer(input: AuthPrepareInput): Promise<AuthPrepared>;
  /**
   * CLIENT side: produce the connect material for a user-mode space from THIS machine's session
   * state (the login cache + the provider's space-scoped state under `dir`). `actor` is the
   * ledger-granted agent-instance the caller connects as. Returns what {@link EndpointOptions}'
   * user mode consumes (`bearer` + `sentinelCreds`). MUST fail loud with the EXACT operator
   * action when anything is missing — not logged in (`cotal login --idp …`), the auth service
   * down (how to restart it), the actor ungranted (how to grant) — and NEVER falls back to any
   * other auth mode.
   */
  userCredentials(opts: { dir: string; space: string; actor: string }): Promise<{ bearer: string; sentinelCreds: string }>;
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
  /** The provider's OWN state dir. The caller keys it — today `<root>/.cotal/auth/<space>`; a
   *  future (broker, space) key is a caller change, never an on-disk format break. */
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
