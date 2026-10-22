import { execFile, type ExecFileException } from "node:child_process";
import { registry, type Extension } from "./registry.js";
import type { SecretStore } from "./secret-store.js";
import type { ServiceAuthorityInfo, ServiceAuthorityProof, ServiceAuthorityRequest, ServiceAuthorityResult } from "./remote-service-authority.js";
import type {
  RemoteManagerAdminAuthorizationRequest,
  RemoteManagerAdminAuthorizationResult,
  RemoteManagerAuthorityMaterial,
  RemoteManagerAuthorityRequest,
  RemoteManagerGoalIndexScanRequest,
  RemoteManagerGoalIndexScanResult,
  RemoteManagerMaintenanceRequest,
  RemoteManagerMaintenanceResult,
  RemoteManagedAgentEnrollmentRequest,
  RemoteManagedAgentEnrollmentResult,
  RemoteManagedAgentPrepareRetirementRequest,
  RemoteManagedAgentPrepareRetirementResult,
  RemoteManagedAgentRuntimeRequest,
  RemoteManagedAgentRuntimeResult,
  RemoteRetainedAgentValidationRequest,
  RemoteRetainedAgentValidationResult,
  RemoteRunAdmissionRequest,
  RemoteRunAdmissionResult,
  RemoteRunAttemptRequest,
  RemoteRunAttemptResult,
} from "./remote-manager-authority.js";
import { assertLifecycleToken } from "./subjects.js";

/** Who holds one managed lifecycle, recorded on its managed-agent grant row by the writer that
 *  granted it. `local-manager` is a manager on this host attesting its OWN persisted logical
 *  `instanceId`; `remote-manager` is the auth service recording the instance it authorized an
 *  enrollment for; `foreground` is a spawn with no manager. The value is attested by the writer and
 *  is never taken from a participant-supplied field. */
export type ManagedGrantCustody =
  | { kind: "local-manager"; instanceId: string }
  | { kind: "remote-manager"; instanceId: string }
  | { kind: "foreground" };

/** Validate a custody value at a write or read boundary: a closed shape, a known kind, and a
 *  lifecycle-token `instanceId` exactly when the kind names a manager. Throws otherwise. */
export function assertManagedGrantCustody(v: unknown): asserts v is ManagedGrantCustody {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("managed grant custody must be an object");
  const o = v as Record<string, unknown>;
  if (o.kind === "foreground") {
    if (Object.keys(o).length !== 1) throw new Error("foreground custody carries no other field");
    return;
  }
  if (o.kind !== "local-manager" && o.kind !== "remote-manager")
    throw new Error(`managed grant custody kind ${JSON.stringify(o.kind)} is not local-manager, remote-manager or foreground`);
  if (Object.keys(o).length !== 2 || typeof o.instanceId !== "string") throw new Error(`${o.kind} custody carries exactly kind and instanceId`);
  assertLifecycleToken(o.instanceId, "custody instanceId");
}

/** Exact custody equality. */
export function sameManagedGrantCustody(a: ManagedGrantCustody, b: ManagedGrantCustody): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "foreground" || a.instanceId === (b as { instanceId: string }).instanceId;
}

/** A fresh agent grant refused an occupied actor without replacing its authority. */
export class AgentGrantConflictError extends Error {
  constructor(actor: string) {
    super(`actor "${actor}" already has a grant; no grant was replaced`);
    this.name = "AgentGrantConflictError";
  }
}

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
   * Read-only check of the inputs {@link prepareServer} would refuse on its own terms, run BEFORE
   * the caller writes any space trust, broker configuration or journal. It must provision nothing,
   * pin nothing, create no directory, grant nothing and start no daemon. `prepareServer` applies
   * the same checks itself, so a caller that skips this still cannot provision around a bad input;
   * a race between the two calls is resolved by `prepareServer`, which remains authoritative.
   * Reports one legible sentence and a typed reason naming the exact correction. Optional: a caller
   * that needs a pre-effect guarantee refuses when a provider lacks it, rather than skipping it.
   */
  preflightServer?(input: AuthPreflightInput): Promise<AuthPreflightVerdict>;
  /** Read this space's already-provisioned operator-signed accounts for a whole-broker render.
   *  A missing or invalid account on an enabled space must refuse the render, not shrink it. */
  preloadAccounts(opts: { store: SecretStore; space: string }): Promise<Array<{ pub: string; jwt: string }>>;
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
  userCredentials(opts: UserCredentialsRequest): Promise<{ bearer: string; sentinelCreds: string }>;
  /**
   * Admit ONE distinct chat session for the signed-in human: the provider fetches the IdP
   * proof itself, and the minting authority derives the owner, draws the session actor and its
   * lifecycle UID, pins the human's own parent grant, and confines the session to `read`/`post`
   * (each contained in that grant, never widened) and `ttlSec` (at most 8 h, never extended; a
   * longer request refuses). The caller sends only the SHA-256 of a holder secret it keeps in
   * memory. Idempotent per `holderHash`: a retry with the same hash and the same ceiling returns
   * the same session, and a retired hash never admits again.
   *
   * Optional. A provider without it cannot serve user-mode chat, and the caller MUST refuse
   * `UNSUPPORTED` rather than borrow another identity or fall back to another auth mode. A refusal
   * whose outcome is `unknown` may have reserved a slot: retry with the SAME `holderHash`.
   */
  openChatSession?(opts: ChatSessionOpenRequest): Promise<ChatSessionOpened>;
  /**
   * Exchange the holder proof for a short-lived bearer of an ACTIVE chat session, with
   * TTL = min(900 s, IdP proof remaining, session remaining). The bearer authorizes exactly the
   * session's own agent leaf, never a view, role or capability. A moved parent grant, a non-active
   * session or an expired session refuses `permission-denied` with no bearer. Optional, with the
   * same no-fallback rule as {@link openChatSession}.
   */
  chatSessionBearer?(opts: ChatSessionBearerRequest): Promise<{ bearer: string; sentinelCreds: string; exp: number }>;
  /**
   * Retire a chat session. `failed` and a `pending` reason are never success: a blocked
   * retirement stays frozen (nothing can mint for it) and is retried by the authority. Optional,
   * with the same no-fallback rule as {@link openChatSession}.
   */
  retireChatSession?(opts: ChatSessionRetireRequest): Promise<ChatSessionRetireResult>;
  /**
   * Prepare the signed-in account's optional space catalog without exposing its cached session
   * bearer. The provider owns advertisement discovery, conditional HTTP, freshness, locking, and
   * the private cache. The caller supplies the product validator so an invalid candidate is never
   * published over the last valid snapshot, and the consumer's `apply`, which the provider runs
   * under its own lock: a candidate is committed to the cache as not yet applied before the first
   * registry mutation and marked applied after the last, so a process that dies or pauses while
   * applying leaves a cache that says so, and the next preparation applies that snapshot again
   * before reporting it fresh or not modified.
   */
  prepareSpaceCatalogs?(opts: {
    dir: string;
    idpUrl?: string;
    force?: boolean;
    validate(snapshot: unknown, account: AuthSpaceCatalogAccount): void;
    apply(result: AuthSpaceCatalogResult): void;
  }): Promise<AuthSpaceCatalogResult[]>;
  /** Complete login-time catalog discovery while the provider alone holds the new session. */
  syncSpaceCatalogAfterLogin?(opts: {
    dir: string;
    idpUrl: string;
    validate(snapshot: unknown, account: AuthSpaceCatalogAccount): void;
    apply(result: AuthSpaceCatalogResult): void;
  }): Promise<AuthSpaceCatalogResult[]>;
  /** Whether the just-proved account advertised a catalog. Reads provider state only. */
  hasSpaceCatalog?(opts: { dir: string; idpUrl: string; sub: string }): boolean;
  /** Clear one account's provider cache and return its opaque registry ownership key. */
  removeSpaceCatalog?(opts: { dir: string; idpUrl: string; sub: string }): string;
  /** Read this space's DATA-account identity from the pinned authority endpoint. A client persists
   * it before first service registration and refuses a later mismatch rather than silently repinning. */
  serviceEndpointInfo?(opts: { store: SecretStore; dir: string; space: string }): Promise<ServiceAuthorityInfo>;
  /** Generic user-auth service registration. The provider supplies IdP proof when no service
   * proof is supplied, validates its pinned authority origin, and returns that space's deny-all
   * sentinel alongside the checked result. It never enrolls an actor or falls back to static auth. */
  serviceEndpointAuthority?(opts: {
    store: SecretStore;
    dir: string;
    request: ServiceAuthorityRequest;
    proof?: Exclude<ServiceAuthorityProof, { kind: "idp" }>;
    /** Remaining local query budget. Describe queries are capped at two seconds. */
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{ result: ServiceAuthorityResult; sentinelCreds: string }>;
  /**
   * Request the closed remote manager-service authority material from the host's loopback/operator
   * exchange. This is an explicitly typed lifecycle protocol, not a generic profile mint: the
   * provider must authenticate the signed-in human, fresh-check `supervise`, bind the returned
   * material to the requested manager instance/lifecycle, and refuse public or managed-agent paths.
   * Optional so providers without remote supervision fail loud at the caller rather than falling
   * back to static/local trust.
   */
  managerServiceAuthority?(opts: {
    store: SecretStore;
    dir: string;
    request: RemoteManagerAuthorityRequest;
  }): Promise<RemoteManagerAuthorityMaterial>;
  /** The registered host resolves issued admission and native run state before returning a
   * closed admission or fixed JWT set for a caller-held nkey. No signer reaches the manager. */
  requestRemoteRunAdmission?(opts: {
    store: SecretStore;
    dir: string;
    request: RemoteRunAdmissionRequest;
  }): Promise<RemoteRunAdmissionResult>;
  requestRemoteRunSubmission?(opts: { store: SecretStore; dir: string;
    request: import("./remote-manager-authority.js").RemoteRunSubmissionRequest;
  }): Promise<import("./remote-manager-authority.js").RemoteRunSubmissionResult>;
  requestRemoteRunAttempt?(opts: {
    store: SecretStore;
    dir: string;
    request: RemoteRunAttemptRequest;
  }): Promise<RemoteRunAttemptResult>;
  /** Body-bound observed cancellation, separate from the holder's operator revoke. */
  requestRemoteRunCancel?(opts: { store: SecretStore; dir: string;
    request: import("./remote-manager-authority.js").RemoteRunCancelRequest;
  }): Promise<import("./remote-manager-authority.js").RemoteRunCancelResult>;
  /** Revoke through the issuing host under the authenticated owner's fresh ledger grant. */
  requestRemoteRunRevoke?(opts: {
    store: SecretStore;
    dir: string;
    request: import("./remote-manager-authority.js").RemoteRunRevokeRequest;
  }): Promise<import("./remote-manager-authority.js").RemoteRunRevokeResult>;
  /** Host-owned registration maintenance for a remote manager. The provider must scope eviction to
   * the caller instance's credential family and guard reconciliation with affirmative liveness. */
  maintainRemoteManager?(opts: {
    store: SecretStore;
    dir: string;
    request: RemoteManagerMaintenanceRequest;
  }): Promise<RemoteManagerMaintenanceResult>;
  /** Host-owned manager boot scan. The provider authenticates the human and returns only parsed,
   * owner-scoped manager goal-index entries. No raw records or consumer authority crosses. */
  scanRemoteManagerGoalIndex?(opts: {
    store: SecretStore;
    dir: string;
    request: RemoteManagerGoalIndexScanRequest;
  }): Promise<RemoteManagerGoalIndexScanResult>;
  /** Host-owned, fresh serve-time authorization for one exact remote manager caller. */
  authorizeRemoteManagerAdmin?(opts: {
    store: SecretStore;
    dir: string;
    request: RemoteManagerAdminAuthorizationRequest;
  }): Promise<RemoteManagerAdminAuthorizationResult>;
  /**
   * Revalidate one retained remote managed agent at the host that owns the current ledger and auth
   * secrets. This is a read-only lifecycle check, never a mint and never a generic provider hook.
   * The host authenticates the operator and manager lifecycle on every call and returns only the
   * current non-secret authority row. Optional providers fail loud at the composition root.
   */
  validateRemoteRetainedAgent?(opts: {
    store: SecretStore;
    dir: string;
    request: RemoteRetainedAgentValidationRequest;
  }): Promise<RemoteRetainedAgentValidationResult>;
  /**
   * Ask the host to enroll one FRESH managed agent under the authenticated owner (#1972). The
   * participant has already generated the standing `actorToken` and written it at 0600, so the
   * request carries only its digest; the host picks the lifecycle UID, authors the ledger grant,
   * pre-creates the durables, and returns the stable non-secret metadata plus the space sentinel.
   * Optional so a provider with no hosted storage composition fails loud at the caller rather than
   * letting a local grant masquerade as a host-owned one.
   */
  enrollRemoteManagedAgent?(opts: {
    store: SecretStore;
    dir: string;
    request: RemoteManagedAgentEnrollmentRequest;
  }): Promise<RemoteManagedAgentEnrollmentResult>;
  /**
   * Ask the host to PREPARE one managed agent's terminal retirement (#1972 phase P0/P1): revoke the
   * managed grant UID-exactly and commit the resumable release while preserving the UID. Success
   * means the terminal auth barrier may start. Never a retirement itself.
   */
  prepareRemoteManagedAgentRetirement?(opts: {
    store: SecretStore;
    dir: string;
    request: RemoteManagedAgentPrepareRetirementRequest;
  }): Promise<RemoteManagedAgentPrepareRetirementResult>;
  /**
   * Ask the host to create, or report, the hosted runtime of one already-enrolled managed agent.
   * The request names only the enrollment's host-selected target; the host decides, owns the
   * provider effect, and returns its intent state. Optional: a host with no hosted runtime leaves
   * it absent, and the caller fails loud.
   */
  requestRemoteManagedAgentRuntime?(opts: {
    store: SecretStore;
    dir: string;
    request: RemoteManagedAgentRuntimeRequest;
  }): Promise<RemoteManagedAgentRuntimeResult>;
  /**
   * The derived owner token (`u_…`) of THIS machine's cached login for the given space — resolved
   * offline from the login session + the space's local user-auth material (no IdP round trip).
   * The spawn paths use it to answer "whose agents are these": a foreground/manifest spawn runs
   * the agents under the OPERATOR's owner. MUST fail loud when not logged in (naming the exact
   * `cotal login --idp …` line) or when the space has no user-auth material (in `store`/`dir`).
   */
  ownerForLogin(opts: { store: SecretStore; dir: string; space: string }): Promise<string>;
  /**
   * CLIENT side of a REMOTE mesh's agent-provisioning endpoint (a discovery bundle advertising
   * `agentProvisioningUrl`): present this machine's login proof for `idpUrl` to `url`, asking it
   * to provision `actor`, and return the endpoint's parsed JSON answer verbatim. This method
   * lives on the provider because the LOGIN PROOF rides the request — the caller never touches
   * the session cache. The transport discipline is the provider's too: redirects are refused
   * (a 302 could walk the proof onto another host), and every failure MUST throw one sentence
   * with the exact operator action — not signed in names the `cotal login --idp …` line, an
   * endpoint refusal surfaces the endpoint's own reason. The caller owns validating the returned
   * material's shape; this method proves and carries, it does not interpret. Optional: a
   * provider without a remote-provisioning story simply lacks it, and the caller refuses with
   * its own named message.
   */
  postAgentProvisioning?(opts: { url: string; idpUrl: string; actor: string }): Promise<unknown>;
  /** Present the signed-in human's proof to a discovered conversation-identity authority. The
   * caller validates the selected registration and endpoint before this call. The provider keeps
   * the proof private, refuses non-HTTPS destinations and redirects, and performs one request only.
   * A transport failure is an unknown outcome; callers retain their original request and secret.
   * The status is returned with the body because pending retirement is not completed cleanup. */
  requestConversationIdentity?(opts: {
    url: string;
    idpUrl: string;
    method: "POST" | "DELETE";
    body?: { v: 1; requestId: string; tokenHash: string; label?: string };
  }): Promise<{ status: number; body: unknown }>;
  /**
   * CLIENT side of a REMOTE mesh's one-time enrollment redeem: GET the secret-bearing enrollment
   * URL exactly once and return the parsed JSON answer verbatim. The URL itself is the credential,
   * so implementations MUST send no Authorization header, MUST refuse redirects and non-HTTPS
   * destinations (except a loopback HTTP literal), MUST NOT retry, log, or echo the URL, and MUST
   * surface the server's closed enrollment-refusal sentence without trying to distinguish unknown,
   * expired, revoked, or already-used tokens. `idpUrl`, when known from an existing registration,
   * lets the provider refuse an ambiguous login+enrollment invocation before consuming the token.
   * The caller validates and persists the returned material. Optional so a provider without this
   * path fails loud at the caller rather than falling back to login provisioning.
   */
  postAgentEnrollment?(opts: { url: string; idpUrl?: string }): Promise<unknown>;
  /**
   * Read-only OFFLINE introspection for status surfaces (`cotal status`): this machine's cached
   * login for the space and — where the space's ledger is locally readable — whether that login's
   * `actor` is granted. Never network-bound and never a mint; "not signed in" is a REPORTED state
   * here, not a thrown one. The IdP pins come from `dir` when the space was provisioned locally,
   * or from the registry entry bound to that `dir` when it is a remote registration (a `meshes
   * add --from` entry or catalog discovery) — in which case `grant` stays absent, since the ledger
   * runs where the space was provisioned. Throws only when neither position exists (there is
   * nothing to report status about).
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
    /** Refuse an existing row with AgentGrantConflictError rather than rotating it. */
    fresh?: boolean;
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
    /** The incarnation's lifecycle UID (SPEC §13.1). Recorded on the ledger row so the auth
     *  callout mints this agent's lifecycle-keyed grants (`dm_…-<uid>`/`dlv_…-<uid>`/
     *  `chathist_…-<uid>`) from the SAME value its provisioned broker footprint carries. */
    lifecycleUid: string;
    /** Who holds this lifecycle (recorded on the managed row). The local manager passes its own
     *  logical instance id; a foreground spawn passes `foreground`. A remote-manager row is written
     *  only by the auth service's enrollment, never through this method. */
    custody: Exclude<ManagedGrantCustody, { kind: "remote-manager" }>;
  }): Promise<{ actorToken: string; sentinelCreds: string }>;
  /** Revoke an agent grant. False when there was nothing to revoke. New exchanges and new
   *  connects die immediately (both boundaries read the ledger fresh); an already-live
   *  connection dies at its bearer-bound JWT expiry (live eviction is a separate lever).
   *  `expectCustody` revokes only while the row still names both `lifecycleUid` (then required)
   *  and exactly that custody, read under the same lock as the removal. */
  revokeAgent(opts: { dir: string; owner: string; actor: string; lifecycleUid?: string; actorToken?: string; expectCustody?: ManagedGrantCustody }): Promise<boolean>;
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
  /** Offline key inventory for the same deprovision operation. A local reset can review and
   * validate its filesystem scope without running the delete hook. No secret values are returned.
   * Providers without this declaration cannot participate in a reviewed named identity reset. */
  deprovisionSecretKeys?(space: string): readonly string[];
  /**
   * Read-only OFFLINE continuity commitment for this space's existing user-auth trust state. The
   * provider defines `scheme`; `value` is safe to place in a backup manifest and MUST commit to the
   * account identity, owner derivation, IdP/issuer pins, and every interactive + managed authority
   * row. Missing or malformed state throws. This method must never create, repair, rotate, or mint.
   */
  trustFingerprint(opts: { store: SecretStore; dir: string; space: string }): Promise<AuthTrustFingerprint>;
  /**
   * Validate that retained managed-agent material still names the SAME live principal and authority
   * row. This is the resume path: it must reuse the supplied token/sentinel, never call
   * {@link grantAgent}, rotate a token, create a row, or provision a replacement identity.
   */
  validateRetainedAgent(opts: {
    store: SecretStore;
    dir: string;
    space: string;
    owner: string;
    actor: string;
    actorToken: string;
    sentinelCreds: string;
  }): Promise<RetainedAgentAuthority>;
  /**
   * Registry name of the provider's self-registered {@link Command} that prints ONE fresh agent
   * bearer to stdout and exits (flags: `--dir <state-dir> --space <space> --owner <o> --actor <a>
   * --token-file <path>`). A long-lived agent endpoint execs it per refresh — the exchange
   * protocol, discovery, and secret handling stay entirely behind the provider; the agent-side
   * runtime only runs an argv and reads a line. */
  readonly agentBearerCommand: string;
}

/** The error for a failed run of an {@link AuthProvider.agentBearerCommand} argv. The command prints
 *  an operator sentence on stderr for every failure it handles, and that sentence is the error.
 *  Empty stderr means the child never reached its handler, and Node's `Command failed` message
 *  would repeat the whole argv, with its exchange URL, principal and file paths, while hiding
 *  whether the child timed out, was killed or exited. */
export function bearerCommandFailure(err: ExecFileException, stderr: string, timeoutMs: number): Error {
  const said = stderr.trim();
  if (said) return new Error(said);
  // execFile marks an exit error `killed` only when its own timeout killed the child.
  if (err.killed) return new Error(`the bearer command timed out after ${timeoutMs}ms`);
  if (err.signal) return new Error(`the bearer command was killed by ${err.signal}`);
  if (typeof err.code === "number") return new Error(`the bearer command exited with code ${err.code} and printed nothing`);
  // A spawn, abort or output-limit error has no exit, and Node's sentence for it repeats no arguments.
  return new Error(err.message);
}

/** Run an {@link AuthProvider.agentBearerCommand} argv once and return the line it printed, trimmed
 *  and possibly empty. A caller that needs a bearer refuses an empty line itself; a preflight that
 *  only proves the command succeeds ignores it. */
export function runAgentBearer(
  argv: string[],
  opts: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    execFile(
      argv[0],
      argv.slice(1),
      { timeout: timeoutMs, maxBuffer: 64 * 1024, env: opts.env, signal: opts.signal },
      (err, stdout, stderr) => err ? reject(bearerCommandFailure(err, stderr, timeoutMs)) : resolve(stdout.trim()),
    );
  });
}

/** Non-secret proved account identity returned beside a catalog snapshot. */
export interface AuthSpaceCatalogAccount {
  idpUrl: string;
  issuer: string;
  sub: string;
  /** Opaque machine-local ownership key. It contains no subject or credential material. */
  ownerKey: string;
  catalogUrl?: string;
}

/** One account's catalog preparation result. A failure keeps and returns the prior snapshot. */
export interface AuthSpaceCatalogResult {
  account: AuthSpaceCatalogAccount;
  state: "fresh" | "updated" | "not-modified" | "no-catalog" | "failed";
  snapshot?: unknown;
  fetchedAt?: string;
  error?: string;
}

/** Workstation consumer for provider-owned catalogs. Kept separate so auth never imports a CLI.
 *  `apply` runs inside the provider's catalog lock and must be idempotent: an interrupted
 *  application is applied again from the cached snapshot by the next preparation. */
export interface SpaceCatalogConsumer extends Extension {
  readonly kind: "space-catalog-consumer";
  validate(snapshot: unknown, account: AuthSpaceCatalogAccount): void;
  apply(result: AuthSpaceCatalogResult): void;
}

export function resolveSpaceCatalogConsumer(): SpaceCatalogConsumer {
  const consumers = registry.all<SpaceCatalogConsumer>("space-catalog-consumer");
  if (consumers.length !== 1)
    throw new Error(consumers.length === 0 ? "no space catalog consumer is registered in this build" : "multiple space catalog consumers are registered");
  return consumers[0];
}

/** Provider-defined, versioned manifest-safe commitment. Callers compare both fields exactly. */
export interface AuthTrustFingerprint {
  scheme: string;
  value: string;
}

/** Existing managed row returned after retained secret + sentinel validation. */
export interface RetainedAgentAuthority {
  owner: string;
  actor: string;
  /** The incarnation UID the CURRENT ledger row carries. The manager binds it against the inventory
   *  identity's uid before any spawn, so a retained record aimed at a different incarnation fails at
   *  pre-effect validation rather than at the broker after the child is already running (SPEC §13.1). */
  lifecycleUid: string;
  scope: string[];
  allowSubscribe: string[];
  allowPublish: string[];
  role?: string;
  parent?: string;
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

/** What {@link AuthProvider.userCredentials} takes: `store` and `dir` locate this machine's state,
 *  and the other fields are the coordinates of the credential requested. */
export interface UserCredentialsRequest {
  store: SecretStore;
  dir: string;
  space: string;
  actor: string;
  view?: string;
  managerInstanceId?: string;
  sessionGrant?: unknown;
  transferWriter?: { instanceId: string; hex: string };
}

/** {@link AuthProvider.openChatSession}. `holderHash` is the lowercase SHA-256 hex of a holder
 *  secret the caller keeps in memory; the secret itself is never sent here. */
export interface ChatSessionOpenRequest {
  store: SecretStore;
  dir: string;
  space: string;
  holderHash: string;
  label?: string;
  read: string[];
  post: string[];
  ttlSec?: number;
  /** The user-auth position the caller resolved for this space: its IdP URL and, for a remote
   *  mesh only, its pinned exchange URL. A provider that resolves a different position, or a local
   *  one where `exchangeUrl` names a remote, or the reverse, MUST refuse `failed-precondition` with
   *  outcome `not-executed` before any request leaves. Narrowing only; it grants nothing. */
  expect?: { idpUrl: string; exchangeUrl?: string };
}

/** What an admitted chat session is. `expiresAt` is unix seconds, fixed at admission. */
export interface ChatSessionOpened {
  actor: string;
  lifecycleUid: string;
  expiresAt: number;
}

/** {@link AuthProvider.chatSessionBearer}. `holderProof` is the in-memory holder secret whose
 *  SHA-256 was sent at open. */
export interface ChatSessionBearerRequest {
  store: SecretStore;
  dir: string;
  space: string;
  actor: string;
  holderProof: string;
}

/** {@link AuthProvider.retireChatSession}. */
export interface ChatSessionRetireRequest {
  store: SecretStore;
  dir: string;
  space: string;
  actor: string;
  lifecycleUid: string;
  holderProof: string;
}

/** The closed retirement outcome. `pending` names why a retirement has not completed. */
export interface ChatSessionRetireResult {
  outcome: "retired" | "alreadyRetired" | "notStarted" | "failed";
  pending?: string;
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

/** The read-only {@link AuthProvider.preflightServer} input: only what the pre-effect checks read.
 *  No seed, signing key or secret store crosses this seam. */
export interface AuthPreflightInput {
  space: string;
  /** The same provider state dir {@link AuthPrepareInput.dir} names. Read only; never created. */
  dir: string;
  /** The same opaque IdP base URL {@link AuthPrepareInput.idpUrl} carries. */
  idpUrl?: string;
}

/** The {@link AuthProvider.preflightServer} result. `required`: a first enable needs an input the
 *  caller did not give. `invalid`: a given input is malformed. `conflict`: it disagrees with, or
 *  cannot be checked against, already persisted provider state. `unavailable`: a dependency the
 *  provider must reach (an IdP) did not answer as required. */
export type AuthPreflightVerdict =
  | { ok: true }
  | { ok: false; reason: "required" | "invalid" | "conflict" | "unavailable"; message: string };

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
   *  mesh registry; THROWS (with the reason) on timeout — the caller surfaces it, loudly.
   *
   *  The wait may be bound to the DAEMON PROCESS, not a clock alone: pass the pid the caller
   *  launched (or found live) and the provider waits past `timeoutMs` up to `maxWaitMs` while
   *  that pid is provably alive, ends the wait AT ONCE when the pid is provably gone (refusing
   *  with the exit), and still refuses at `maxWaitMs` — so a slow-but-healthy start is not
   *  misreported dead, a dead daemon is refused immediately, and a wedged daemon can never hold
   *  the caller open indefinitely. Either way the caller never invents ad-hoc readiness sleeps. */
  ready(opts: { dir: string; timeoutMs?: number; pid?: number; maxWaitMs?: number }): Promise<Record<string, unknown>>;
}
