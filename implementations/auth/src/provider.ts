/**
 * The core `auth-provider` extension — how a composition root gets user-mode auth WITHOUT importing
 * this package from the CLI (`bin/cotal.ts` imports `@cotal-ai/auth`; `@cotal-ai/cli` resolves the
 * provider from the registry, generically).
 *
 * `prepareServer` is the `cotal up --user-auth` hook. It receives the NARROW provisioning input
 * (core's {@link AuthPrepareInput}: operator seed + data-account pub/signingSeed + the space-scoped
 * state dir — never the whole space bundle), makes all persisted material exist, projects the ONE
 * signing seed the daemon may hold into `service-keys.json`, and hands back:
 *  - the callout account for the broker config preload,
 *  - the non-secret client metadata (trust pins) the workstation registry records ({@link
 *    assertUserAuthInfo} shape — typed in workspace, opaque to core),
 *  - the service handle: the `auth-service` command name + the readiness contract (poll the
 *    discovery file the daemon writes only after BOTH planes are bound, then confirm /health).
 */
import { isLoopbackLiteral, registry, type AuthPreflightInput, type AuthPreflightVerdict, type AuthPrepareInput, type AuthPrepared, type AuthProvider, type RemoteManagerAdminAuthorizationRequest, type RemoteManagerAdminAuthorizationResult, type RemoteManagerAuthorityMaterial, type RemoteManagerAuthorityRequest, type RemoteManagerGoalIndexScanRequest, type RemoteManagerGoalIndexScanResult, type RemoteManagerMaintenanceRequest, type RemoteManagerMaintenanceResult, type RemoteManagedAgentEnrollmentRequest, type RemoteManagedAgentEnrollmentResult, type RemoteManagedAgentPrepareRetirementRequest, type RemoteManagedAgentPrepareRetirementResult, type RemoteManagedAgentRuntimeRequest, type RemoteManagedAgentRuntimeResult, type RemoteRetainedAgentValidationRequest, type RemoteRetainedAgentValidationResult, type RemoteRunAdmissionRequest, type RemoteRunAdmissionResult, type RemoteRunAttemptRequest, type RemoteRunAttemptResult, type SecretStore, type UserCredentialsRequest } from "@cotal-ai/core";
import { assertUserAuthInfo, credentialFailure, findMesh, homeCotalDir, probeLiveness, spaceSegment, type UserAuthInfo } from "@cotal-ai/workspace";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { AgentGrantConflictError, EP_ERROR_CODES, EpEnvelopeError, type EpEffectOutcome, type EpErrorCode } from "@cotal-ai/core";
import { parseServiceAuthorityEnvelope, parseServiceAuthorityRequest } from "@cotal-ai/core";
import { readRemoteServiceAuthorityInfo, postRemoteServiceAuthority, serviceAuthorityUrl, withServiceAuthorityBudget, assertServiceViewFreshness } from "./service-authority-client.js";
import { deleteIdpSpaceCatalog, fetchIdpJwt, hasIdpSessions, hasIdpSpaceCatalog, loadIdpSession, normalizeIdpUrl, prepareIdpSpaceCatalogs, probeIdpJwks, requireIdpSession } from "./login.js";
import { deriveOwnerForIdpSubject } from "./derive.js";
import { findActorUnified, findInteractiveActor, hashActorToken, newActorToken, withManagedGrantTransaction } from "./ledger.js";
import { userAuthTrustFingerprint, validateRetainedManagedAgent } from "./continuity.js";
import {
  AUTH_PROVIDER_NAME,
  authCalloutKey,
  authClientSentinelKey,
  authIssuerKey,
  authOwnerSecretKey,
  authServiceKeysKey,
  checkPinnedIdp,
  ensureCalloutAuth,
  ensureIssuer,
  ensureOwnerSecret,
  ensurePinnedIdp,
  loadAuthServiceInfo,
  loadCalloutAuth,
  loadOwnerSecret,
  loadPinnedIdp,
  saveServiceKeys,
} from "./store.js";

/** The pre-effect half of {@link cotalAuthProvider.prepareServer}: the space segment, the IdP pin
 *  requirement and match, and on a first enable the JWKS probe. Reads only: no directory, pin, key
 *  or daemon is created. `prepareServer` runs this same function first and throws its message, so
 *  the checks and their sentences cannot drift. The reason is set by which check refused, never by
 *  matching message text. */
async function preflightServerInput({ space, dir, idpUrl }: AuthPreflightInput): Promise<AuthPreflightVerdict> {
  const refuse = (reason: Exclude<AuthPreflightVerdict, { ok: true }>["reason"], error: unknown): AuthPreflightVerdict => ({ ok: false, reason, message: error instanceof Error ? error.message : String(error) });
  // Fail BEFORE mutation: a degenerate space (`.`/`..`/empty) must be refused before the IdP
  // probe/pin below can touch anything at a caller-provided dir.
  try { spaceSegment(space); } catch (error) { return refuse("invalid", error); }
  // An existing pin is read first. An unreadable pin, or one the given `--idp` does not match, is
  // a conflict with persisted state; neither is replaced here.
  let existing;
  try { existing = loadPinnedIdp(dir); } catch (error) { return refuse("conflict", error); }
  let checked;
  try { checked = checkPinnedIdp(dir, idpUrl); } catch (error) { return refuse(existing ? "conflict" : idpUrl === undefined ? "required" : "invalid", error); }
  // On a FRESH enable, prove the IdP actually serves a JWKS before a space is provisioned around
  // it. Skip on re-up: an already-pinned IdP was validated at first enable, and re-probing every
  // boot would couple mesh liveness to IdP liveness.
  if (checked.fresh) {
    try { await probeIdpJwks(idpUrl ?? checked.pin.url); } catch (error) { return refuse("unavailable", error); }
  }
  return { ok: true };
}

const READY_TIMEOUT_MS = 15_000;
/** The pid-bound extension of the readiness wait (#1931): while the daemon the caller LAUNCHED
 *  (or found live) is provably alive, the wait continues past READY_TIMEOUT_MS up to this bound.
 *  The daemon's startup is bounded work (a plane open that resolves, two listener binds, one
 *  discovery write), so a start still unfinished here is a wedge (an open that never returns),
 *  and the wait must end in a loud refusal rather than following the daemon forever. A full
 *  minute is 4x the base budget with no daemon startup step anywhere near it on a healthy
 *  machine; the pre-2.0 era when 15s also served as the sole budget keeps its role for callers
 *  that pass no pid. */
const READY_MAX_WAIT_MS = 60_000;

/** Present only if PROVEN present. `probeLiveness` resolves EPERM (another user's process) to
 *  `alive`, which is the defect this fixes: the old two-state probe called that dead. `unknown`
 *  reads as NOT present, matching the behaviour this replaced, because a readiness caller that
 *  accepts an undeterminable pid hands out an endpoint nothing is listening on. */
function pidAlive(pid: number): boolean {
  return probeLiveness(pid) === "alive";
}

const deprovisionSecretKeys = (space: string) => [authCalloutKey(space), authIssuerKey(space), authOwnerSecretKey(space), authServiceKeysKey(space), authClientSentinelKey(space)];

export const cotalAuthProvider: AuthProvider = {
  kind: "auth-provider",
  name: AUTH_PROVIDER_NAME,
  async requestRemoteRunSubmission({ store, dir, request }) {
    const { endpoint, idpUrl, authorization } = await managerAuthorityEndpoint(store, dir, request.space, "keyed run submission");
    return postManagerAuthority(endpoint, idpUrl, authorization, request, "keyed run submission") as Promise<import("@cotal-ai/core").RemoteRunSubmissionResult>;
  },
  async requestRemoteRunAdmission({ store, dir, request }: { store: SecretStore; dir: string; request: RemoteRunAdmissionRequest }): Promise<RemoteRunAdmissionResult> {
    const { endpoint, idpUrl, authorization } = await managerAuthorityEndpoint(store, dir, request.space, "admitting a hosted run");
    return postManagerAuthority(endpoint, idpUrl, authorization, request, "manager run admission") as Promise<RemoteRunAdmissionResult>;
  },
  async requestRemoteRunAttempt({ store, dir, request }: { store: SecretStore; dir: string; request: RemoteRunAttemptRequest }): Promise<RemoteRunAttemptResult> {
    const { endpoint, idpUrl, authorization } = await managerAuthorityEndpoint(store, dir, request.space, "issuing hosted run credentials");
    return postManagerAuthority(endpoint, idpUrl, authorization, request, "manager run issuance") as Promise<RemoteRunAttemptResult>;
  },
  async requestRemoteRunCancel({ store, dir, request }) {
    const { endpoint, idpUrl, authorization } = await managerAuthorityEndpoint(store, dir, request.space, "cancelling a hosted run");
    return postManagerAuthority(endpoint, idpUrl, authorization, request, "manager run cancel") as Promise<import("@cotal-ai/core").RemoteRunCancelResult>;
  },
  async requestRemoteRunRevoke({ store, dir, request }) {
    const { endpoint, idpUrl, authorization } = await managerAuthorityEndpoint(store, dir, request.space, "revoking a hosted run");
    return postManagerAuthority(endpoint, idpUrl, authorization, request, "manager run revoke") as Promise<import("@cotal-ai/core").RemoteRunRevokeResult>;
  },
  async preloadAccounts({ store, space }) {
    const callout = await loadCalloutAuth(store, space);
    if (!callout) throw new Error(`space "${space}" has user auth enabled but its callout account is missing - restore it from backup before starting the broker`);
    return [{ pub: callout.account.pub, jwt: callout.account.jwt }];
  },
  prepareSpaceCatalogs: prepareIdpSpaceCatalogs,
  syncSpaceCatalogAfterLogin: async ({ dir, idpUrl, validate, apply }) => {
    const results = await prepareIdpSpaceCatalogs({ dir, idpUrl, force: true, validate, apply });
    const failed = results.find((r) => r.state === "failed");
    if (failed) throw new Error(`space catalog for ${idpUrl} failed after login: ${failed.error}`);
    return results;
  },
  hasSpaceCatalog: ({ dir, idpUrl, sub }) => hasIdpSpaceCatalog(dir, idpUrl, sub),
  removeSpaceCatalog: ({ dir, idpUrl, sub }) => deleteIdpSpaceCatalog(dir, idpUrl, sub),
  preflightServer: preflightServerInput,
  async prepareServer(input: AuthPrepareInput): Promise<AuthPrepared> {
    const { space, store, dir, idpUrl } = input;
    // The same read-only checks a caller may already have run through `preflightServer`. They run
    // again here because this call is authoritative: a pin written by another process between the
    // two calls is honored by `ensurePinnedIdp` below exactly as before.
    const verdict = await preflightServerInput({ space, dir, idpUrl });
    if (!verdict.ok) throw new Error(verdict.message);
    // Pin the IdP FIRST, so a fresh `up --user-auth` without --idp fails on the config error before
    // any key material is generated.
    const idp = ensurePinnedIdp(dir, idpUrl);
    await ensureOwnerSecret(store, space);
    await ensureIssuer(store, space);
    const callout = await ensureCalloutAuth(store, { space, operatorSeed: input.operatorSeed, accountPub: input.account.pub });
    await store.put(authClientSentinelKey(space), callout.sentinelCreds);
    // The daemon's ONLY signing material: the data-account user-minting seed. Written by this
    // (briefly privileged) call; the long-lived service loads this projection, never the space bundle.
    await saveServiceKeys(store, space, { dataAccount: { pub: input.account.pub, signingSeed: input.account.signingSeed } });

    const publicAuth: UserAuthInfo = assertUserAuthInfo({
      provider: AUTH_PROVIDER_NAME,
      idp: { url: idp.url, issuer: idp.issuer, audience: idp.audience },
    });
    return {
      extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }],
      publicAuth: publicAuth as unknown as Record<string, unknown>,
      service: {
        // The hidden twin of `auth-service`, so `up` does not print the deprecation warning.
        command: "__daemon-auth-service",
        // Readiness = the daemon wrote its discovery file (which it does only after the callout SUB
        // is flushed AND the HTTP listener is bound) and /health answers. Poll until timeoutMs,
        // then THROW with the reason — the caller (`up`) surfaces it loudly (U5), never records a
        // usable user mesh on a half-started service. With `pid`, the wait is bound to the daemon
        // PROCESS (#1931): the clock alone misreported a same-root refresh's live, still-binding
        // daemon as dead at a fixed 15s. Past timeoutMs the wait continues while THAT pid is
        // provably alive, up to maxWaitMs (a wedged daemon still ends in a loud refusal); the
        // moment the pid is provably gone the wait ends at once with the exit, so a dead daemon
        // is never waited on.
        async ready({ dir: stateDir, timeoutMs = READY_TIMEOUT_MS, pid, maxWaitMs = READY_MAX_WAIT_MS }) {
          // `pid` is the daemon process the CALLER launched (or found live): 0/absent means the
          // caller cannot name one (a yielded slot, a spawn failure) and the wait is clock-only.
          // A value that claims to name a process but cannot be one is a caller bug; polling the
          // discovery file to the bound would silently disable the process binding it exists for.
          if (pid !== undefined && pid !== 0 && !(Number.isSafeInteger(pid) && pid > 0))
            throw new Error(`auth service readiness was given a pid that cannot name a process (${pid})`);
          const daemonPid = pid === undefined || pid === 0 ? undefined : pid;
          // Process-bound: the base clock is the floor, the bound the ceiling — a live daemon
          // extends the wait past the old fixed 15s, and nothing extends it past the bound.
          const deadline = Date.now() + (daemonPid === undefined ? timeoutMs : Math.max(timeoutMs, maxWaitMs));
          let lastReason = "the auth service has not written its discovery file yet";
          while (Date.now() < deadline) {
            try {
              const info = loadAuthServiceInfo(stateDir);
              if (info && pidAlive(info.pid)) {
                // pid-liveness first: a STALE file from a dead prior daemon must never satisfy
                // this poll (the daemon also scrubs it at startup and on exit — belt and braces).
                const res = await fetch(`${info.url}/health`, { signal: AbortSignal.timeout(2000) });
                // `publicUrl` (when the public exchange face is enabled) rides along so `up` can
                // record it in the registry's convenience endpoint; `cap` NEVER leaves this file.
                if (res.ok) return { url: info.url, ...(info.publicUrl !== undefined ? { publicUrl: info.publicUrl } : {}) };
                lastReason = `health probe at ${info.url}/health returned HTTP ${res.status}`;
              } else if (info) {
                // Do not assert "not running" about a pid we could not attribute. The POLICY is
                // unchanged (unknown is not ready, and no HTTP call is made), but the REASON has to
                // be true: one of these is an observation and the other is a guess wearing its clothes.
                lastReason =
                  probeLiveness(info.pid) === "unknown"
                    ? `discovery file names pid ${info.pid}, whose liveness cannot be determined (a seccomp filter or LSM policy answers kill(pid,0) with an arbitrary errno) - not treating it as ready`
                    : `discovery file names pid ${info.pid}, which is not running (stale entry)`;
              }
            } catch (e) {
              lastReason = e instanceof Error ? e.message : String(e);
            }
            // The process-bound half of the contract: a daemon that EXITED can never become
            // ready, so the wait ends AT ONCE (not at the clock) and the refusal says so.
            if (daemonPid !== undefined && probeLiveness(daemonPid) === "dead")
              throw new Error(`auth service not ready - the process (pid ${daemonPid}) exited before becoming ready (${lastReason})`);
            await new Promise((r) => setTimeout(r, 200));
          }
          if (daemonPid !== undefined && probeLiveness(daemonPid) === "alive")
            // The bound, and the daemon is STILL alive: name both facts. The daemon did not die,
            // it never finished starting — a plane open that never returns is the wedge case, and
            // this is where the wait stops following it. The pidfile and the service log (which
            // the caller's wrapper appends) are where the operator looks next.
            throw new Error(
              `auth service not ready after ${maxWaitMs}ms - the process (pid ${daemonPid}) is alive and still starting (${lastReason}); a start this slow is wedged, not slow - stop it with \`cotal down\` and check the service log`,
            );
          // No log-path guess here — the CALLER owns the daemon's log location and appends it.
          throw new Error(`auth service not ready after ${timeoutMs}ms (${lastReason})`);
        },
      },
    };
  },

  /** Client side: this machine's login session → a fresh IdP JWT → the local auth service's
   *  exchange → the Cotal bearer, plus the space's sentinel creds. NO fallback anywhere; each
   *  failure is one sentence with the exact operator action (U1/U10/U11 acceptance strings). */
  async userCredentials(request: UserCredentialsRequest) {
    const { store, dir, space, actor, view } = request;
    const idp = loadPinnedIdp(dir);
    const callout = await loadCalloutAuth(store, space);
    // No local material: this machine may still hold a REMOTE registration (\`cotal meshes add
    // --from\`), whose registry entry pinned the IdP + public exchange at registration time. The
    // remote arm consumes exactly what registration pinned - it discovers nothing at connect time.
    if (!idp || !callout) return remoteUserCredentials(request);
    // The no-fallback login gate: throws the exact `cotal login --idp …` line when not signed in.
    const session = requireIdpSession(homeCotalDir(), idp.url);
    // Daemon liveness BEFORE the IdP round-trip: a down auth service must surface its exact
    // restart recovery (U10) without spending an IdP /token call — and without an unrelated
    // IdP/network failure masking it. Missing-login stays primary (the session gate above).
    const info = loadAuthServiceInfo(dir);
    if (info && probeLiveness(info.pid) === "unknown")
      throw new Error(
        `the user-auth service for space "${space}" records pid ${info.pid}, whose liveness cannot be determined - the kernel answered neither "running" nor "no such process" (a seccomp filter or LSM policy does this inside some sandboxes).\n` +
          `Refusing rather than claiming it is down: verify with \`ps -p ${info.pid}\` before restarting anything.`,
      );
    if (!info || !pidAlive(info.pid))
      throw credentialFailure(
        "unavailable",
        `the user-auth service for space "${space}" is not running - restart it with \`cotal up\` (or \`cotal auth-service --space ${space} --server <broker>\`)`,
      );
    // Fresh short-lived IdP proof per connect — IdP-side revocation bites HERE, at the next fetch.
    const idpJwt = await fetchIdpJwt(idp.url, session.token);
    let res: Response;
    try {
      res = await fetch(`${info.url}/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${info.cap}` },
        body: exchangeBody(idpJwt, request),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw credentialFailure(
        "unavailable",
        `the user-auth service for space "${space}" did not answer at ${info.url} (${e instanceof Error ? e.message : String(e)}) - restart it with \`cotal up\``,
      );
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      // A refused exchange is an authenticated denial with the reason (an ungranted actor names
      // the grant command); surface it verbatim — the service's copy is already operator-exact.
      throw credentialFailure(
        "refused",
        `signed in, but the exchange for actor "${actor}"${view ? ` (view "${view}")` : ""} was refused: ${body.error ?? `HTTP ${res.status}`}`,
      );
    }
    const out = (await res.json().catch(() => ({}))) as { token?: string };
    if (typeof out.token !== "string" || !out.token)
      throw new Error(`the auth service's exchange returned no token - its build may be stale; restart it with \`cotal up\``);
    return { bearer: out.token, sentinelCreds: callout.sentinelCreds };
  },

  async serviceEndpointInfo({ store, dir, space }) {
    const target = serviceClientTarget(store, dir, space);
    return readRemoteServiceAuthorityInfo(target.base, space);
  },

  async serviceEndpointAuthority({ store, dir, request: raw, proof, timeoutMs, signal }) {
    const startedAt = performance.now(), request = parseServiceAuthorityRequest(raw);
    return withServiceAuthorityBudget(request.operation, { timeoutMs, signal }, async (budget) => {
      const target = serviceClientTarget(store, dir, request.space);
      serviceAuthorityUrl(target.base);
      if (proof !== undefined && proof.kind !== "service-renewal" && proof.kind !== "service-access")
        throw new Error("service authority client accepts only its own login or a service proof");
      const checked = parseServiceAuthorityEnvelope({ request, proof: proof ?? { kind: "idp", token: "pending-login" } });
      const sentinelCreds = await target.readSentinel();
      budget.check();
      if (!sentinelCreds) throw new Error("service authority client has no sentinel projection; refresh the registered space before setup");
      const actualProof = proof === undefined
        ? { kind: "idp" as const, token: await fetchIdpJwt(target.idpUrl, requireIdpSession(homeCotalDir(), target.idpUrl).token) }
        : checked.proof;
      budget.check();
      const result = await postRemoteServiceAuthority(target.base, { request, proof: actualProof }, { signal: budget.signal, timeoutMs: budget.remainingMs() });
      budget.check();
      assertServiceViewFreshness(result, startedAt);
      return { result, sentinelCreds };
    }, startedAt);
  },

  /** Client side of chat admission: a fresh IdP proof plus the holder HASH. The holder secret
   *  itself stays with the caller. The route this open resolved is kept, in this process only, for
   *  the session's later bearer exchanges and its retirement. */
  async openChatSession({ store, dir, space, holderHash, label, read, post, ttlSec, expect }) {
    const route = await resolveChatSessionRoute(store, dir, space);
    if (expect !== undefined) assertChatRouteExpected(route, space, expect);
    const r = (await postChatSession(route, space, "open", { holderHash, ...(label !== undefined ? { label } : {}), read, post, ttlSec })) as { actor?: unknown; lifecycleUid?: unknown; expiresAt?: unknown };
    if (typeof r.actor !== "string" || typeof r.lifecycleUid !== "string" || typeof r.expiresAt !== "number")
      throw new EpEnvelopeError("unavailable", `the chat-session open for space "${space}" answered without a session; a reservation it made is reclaimed by the service's sweep`, undefined, "unknown");
    CHAT_SESSION_ROUTES.set(chatRouteKey(dir, space, r.actor), route);
    return { actor: r.actor, lifecycleUid: r.lifecycleUid, expiresAt: r.expiresAt };
  },

  /** A fresh IdP proof plus the holder proof for one short bearer of the ACTIVE session, sent to
   *  the route its open resolved. */
  async chatSessionBearer({ dir, space, actor, holderProof }) {
    const route = pinnedChatSessionRoute(dir, space, actor);
    const r = (await postChatSession(route, space, "bearer", { actor, holderProof })) as { token?: unknown; exp?: unknown };
    if (typeof r.token !== "string" || r.token === "" || typeof r.exp !== "number")
      throw new EpEnvelopeError("unavailable", `the chat-session bearer exchange for space "${space}" returned no bearer - the auth service build may be stale`, undefined, "not-executed");
    return { bearer: r.token, sentinelCreds: route.sentinelCreds, exp: r.exp };
  },

  /** Retire the session at the route its open resolved. `failed` comes back with its pending
   *  reason and is never success; the kept route goes once the retirement is terminal. */
  async retireChatSession({ dir, space, actor, lifecycleUid, holderProof }) {
    const route = pinnedChatSessionRoute(dir, space, actor);
    const r = (await postChatSession(route, space, "retire", { actor, lifecycleUid, holderProof })) as { outcome?: unknown; pending?: unknown };
    if (r.outcome !== "retired" && r.outcome !== "alreadyRetired" && r.outcome !== "notStarted" && r.outcome !== "failed")
      throw new EpEnvelopeError("unavailable", `the chat-session retirement for space "${space}" answered without an outcome`, undefined, "unknown");
    if (r.outcome !== "failed") CHAT_SESSION_ROUTES.delete(chatRouteKey(dir, space, actor));
    return { outcome: r.outcome, ...(typeof r.pending === "string" ? { pending: r.pending } : {}) };
  },

  async managerServiceAuthority({ store, dir, request }: { store: SecretStore; dir: string; request: RemoteManagerAuthorityRequest }): Promise<RemoteManagerAuthorityMaterial> {
    const { endpoint, idpUrl, authorization } = await managerAuthorityEndpoint(store, dir, request.space, "requesting manager-service authority");
    return postManagerAuthority(endpoint, idpUrl, authorization, request, "manager-service authority") as Promise<RemoteManagerAuthorityMaterial>;
  },

  async maintainRemoteManager({ store, dir, request }: { store: SecretStore; dir: string; request: RemoteManagerMaintenanceRequest }): Promise<RemoteManagerMaintenanceResult> {
    const { endpoint, idpUrl, authorization } = await managerAuthorityEndpoint(store, dir, request.space, "requesting manager maintenance");
    return postManagerAuthority(endpoint, idpUrl, authorization, request, "manager maintenance") as Promise<RemoteManagerMaintenanceResult>;
  },

  async scanRemoteManagerGoalIndex({ store, dir, request }: { store: SecretStore; dir: string; request: RemoteManagerGoalIndexScanRequest }): Promise<RemoteManagerGoalIndexScanResult> {
    const { endpoint, idpUrl, authorization } = await managerAuthorityEndpoint(store, dir, request.space, "scanning manager goal indexes");
    return postManagerAuthority(endpoint, idpUrl, authorization, request, "manager goal-index scan") as Promise<RemoteManagerGoalIndexScanResult>;
  },

  async authorizeRemoteManagerAdmin({ store, dir, request }: { store: SecretStore; dir: string; request: RemoteManagerAdminAuthorizationRequest }): Promise<RemoteManagerAdminAuthorizationResult> {
    const { endpoint, idpUrl, authorization } = await managerAuthorityEndpoint(store, dir, request.space, "authorizing manager admin reach");
    return postManagerAuthority(endpoint, idpUrl, authorization, request, "manager admin authorization") as Promise<RemoteManagerAdminAuthorizationResult>;
  },

  async validateRemoteRetainedAgent({ store, dir, request }: { store: SecretStore; dir: string; request: RemoteRetainedAgentValidationRequest }): Promise<RemoteRetainedAgentValidationResult> {
    const { endpoint, idpUrl, authorization } = await managerAuthorityEndpoint(store, dir, request.space, "validating retained manager authority");
    return postManagerAuthority(endpoint, idpUrl, authorization, request, "manager retained-agent validation") as Promise<RemoteRetainedAgentValidationResult>;
  },

  /** Client half of host-owned managed agent enrollment (#1972 §3.4). The request carries only the
   *  digest of the standing actorToken — the participant wrote the plaintext at 0600 before calling
   *  — so a refused or lost response never leaks an agent's exchange secret. Redirects are refused
   *  for the same reason the retained-validation client refuses them: a 302 could walk the login
   *  proof, and the enrollment it authorizes, onto another host. */
  async enrollRemoteManagedAgent({ store, dir, request }: { store: SecretStore; dir: string; request: RemoteManagedAgentEnrollmentRequest }): Promise<RemoteManagedAgentEnrollmentResult> {
    const { endpoint, idpUrl, authorization } = await managerAuthorityEndpoint(store, dir, request.space, "enrolling a managed agent");
    return postManagerAuthority(endpoint, idpUrl, authorization, request, "managed agent enrollment") as Promise<RemoteManagedAgentEnrollmentResult>;
  },

  /** Client half of host-owned terminal release preparation (#1972 phase P0/P1). The opId is derived
   *  from the target lifecycle, so a retry after a dropped response re-enters the SAME host
   *  operation rather than opening a second one. */
  async prepareRemoteManagedAgentRetirement({ store, dir, request }: { store: SecretStore; dir: string; request: RemoteManagedAgentPrepareRetirementRequest }): Promise<RemoteManagedAgentPrepareRetirementResult> {
    const { endpoint, idpUrl, authorization } = await managerAuthorityEndpoint(store, dir, request.space, "preparing a managed agent retirement");
    return postManagerAuthority(endpoint, idpUrl, authorization, request, "managed agent retirement preparation") as Promise<RemoteManagedAgentPrepareRetirementResult>;
  },

  /** Client half of a hosted runtime create or status read. The body comes back verbatim; the
   *  manager binds it to its request before reading the state. */
  async requestRemoteManagedAgentRuntime({ store, dir, request }: { store: SecretStore; dir: string; request: RemoteManagedAgentRuntimeRequest }): Promise<RemoteManagedAgentRuntimeResult> {
    const what = request.kind === "manager-managed-agent-runtime-create" ? "managed agent runtime create" : "managed agent runtime status";
    const { endpoint, idpUrl, authorization } = await managerAuthorityEndpoint(store, dir, request.space, `requesting a ${what}`);
    return postManagerAuthority(endpoint, idpUrl, authorization, request, what) as Promise<RemoteManagedAgentRuntimeResult>;
  },

  /** WHO the local login is, as this space's derived owner — offline (cached session sub + the
   *  space's owner secret; no IdP round trip). The spawn paths' "whose agents are these" answer. */
  async ownerForLogin({ store, dir, space }) {
    const idp = loadPinnedIdp(dir);
    const secret = await loadOwnerSecret(store, space);
    if (!idp || !secret)
      throw new Error(`space "${space}" has no user-auth material on this machine - spawns for a user-auth space run where \`cotal up --user-auth\` provisioned it`);
    const session = requireIdpSession(homeCotalDir(), idp.url);
    if (!session.sub)
      throw new Error(`your cached login for ${idp.url} predates this build (no subject recorded) - re-run \`cotal login --idp ${idp.url}\``);
    return deriveOwnerForIdpSubject(secret, idp.issuer, session.sub);
  },

  /** Client half of remote agent provisioning (U6 §2): the login proof for `idpUrl` rides the
   *  request, so the POST lives here — the CLI names the pinned URL and the actor, and validates
   *  the material that comes back; this method never touches the session cache's contents beyond
   *  presenting them. Redirects are refused for the same reason registration refuses them: a 302
   *  could walk the proof onto another host or onto plaintext. */
  async postAgentProvisioning({ url, idpUrl, actor }: { url: string; idpUrl: string; actor: string }): Promise<unknown> {
    // The no-fallback login gate: throws the exact `cotal login --idp …` line when not signed in.
    const session = requireIdpSession(homeCotalDir(), idpUrl);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ actor }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new Error(`the mesh's agent-provisioning endpoint did not answer at ${url} (${e instanceof Error ? e.message : String(e)})`);
    }
    if (res.status >= 300 && res.status < 400)
      throw new Error(
        `the mesh's agent-provisioning endpoint answered ${res.status} with redirect Location ${JSON.stringify(res.headers.get("location") ?? "")} - redirects are refused so the login proof cannot be walked onto another host`,
      );
    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = (body as { error?: string }).error ?? `HTTP ${res.status}`;
      // 401 is the one refusal with a local remedy; everything else is the mesh's own word. A 401 or
      // 403 refuses before anything is provisioned. Any other status leaves that open, so it carries
      // no code.
      if (res.status === 401)
        throw credentialFailure("signed-out", `the mesh refused this login for agent provisioning: ${reason} - your session may have expired; re-run \`cotal login --idp ${idpUrl}\``);
      const refusal = `the mesh refused to provision agent "${actor}": ${reason}`;
      throw res.status === 403 ? credentialFailure("refused", refusal) : new Error(refusal);
    }
    return body;
  },

  /** Redeem one pre-minted remote enrollment. The URL itself carries the one-time secret, so this
   *  method names it nowhere, sends no Authorization header, and performs exactly one manual-redirect
   *  GET. A provider-level login conflict check runs before the GET so refusing the ambiguous input
   *  cannot consume the token. */
  async postAgentEnrollment({ url, idpUrl }: { url: string; idpUrl?: string }): Promise<unknown> {
    if (!idpUrl && hasIdpSessions(homeCotalDir()))
      throw new Error("both a cached login and an enrollment were supplied - log out first or remove the enrollment input; refusing before redeeming the one-time enrollment");
    if (idpUrl && loadIdpSession(homeCotalDir(), idpUrl))
      throw new Error("both a cached login and an enrollment were supplied - log out first or remove the enrollment input; refusing before redeeming the one-time enrollment");
    // WHATWG parsing rewrites many inputs into a different URL than the owner minted: it folds
    // backslashes into slashes, erases empty userinfo, lowercases the scheme and host, drops a
    // default port, resolves dot segments, and canonicalizes short host forms. Accepting any of
    // those means redeeming a URL the owner never issued, so the raw string is held to a positive
    // grammar first and then required to be its own canonical serialization.
    if (!url.startsWith("https://") && !url.startsWith("http://"))
      throw new Error("the enrollment URL must begin with https:// or http:// in lowercase");
    for (const [char, label] of [["\\", "a backslash"], ["@", "userinfo"], ["?", "a query"], ["#", "a fragment"]] as const)
      if (url.includes(char)) throw new Error(`the enrollment URL must not contain ${label}`);
    if (/[\s\u0000-\u001f\u007f]/.test(url) || /%(0[0-9a-f]|1[0-9a-f]|20|7f)/i.test(url))
      throw new Error("the enrollment URL must not contain whitespace or control characters, encoded or literal");
    let enrollment: URL;
    try {
      enrollment = new URL(url);
    } catch {
      throw new Error("the enrollment URL is not a valid URL");
    }
    if (enrollment.href !== url)
      throw new Error("the enrollment URL is not in canonical form - redeem the URL exactly as the mesh owner minted it");
    if (enrollment.username || enrollment.password || enrollment.search || enrollment.hash)
      throw new Error("the enrollment URL must carry no userinfo, query, or fragment");
    if (!enrollment.pathname.split("/").filter(Boolean).at(-1))
      throw new Error("the enrollment URL must end with the one-time secret path segment");
    if (enrollment.protocol !== "https:" && !(enrollment.protocol === "http:" && isLoopbackLiteral(enrollment.hostname)))
      throw new Error("the enrollment URL must be https://, except for a loopback HTTP literal on this machine");
    let res: Response;
    try {
      res = await fetch(enrollment, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error("the enrollment endpoint did not answer");
    }
    if (res.status >= 300 && res.status < 400)
      throw new Error(`the enrollment endpoint answered ${res.status} with a redirect - redirects are refused because the enrollment URL is the credential`);
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      throw new Error("enrollment refused: unknown, expired, or already-used; ask the owner for a fresh one");
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error("the enrollment endpoint returned a 200 response that is not JSON");
    }
    return body;
  },

  /** Offline status read: the pinned IdP, this machine's cached login, and (when the local ledger
   *  has material) the actor's grant row. No IdP round trip, no service call, no mint — `cotal
   *  status` must be able to say "not signed in" without becoming a connect.
   *
   *  A space with no LOCAL pin may still be a REMOTE registration (a `meshes add --from` entry, or
   *  catalog discovery): its IdP pins live in the registry entry itself, exactly where
   *  {@link remoteUserCredentials} reads them. The remote arm answers the same offline questions
   *  from the entry — with `grant` absent, because the ledger that holds the row runs where the
   *  space was provisioned, and the renderer already says "grant not checkable on this machine
   *  (no local ledger)" for that shape. No entry either is the one state that stays a refusal. */
  async userStatus({ store, dir, space, actor }) {
    const idp = loadPinnedIdp(dir);
    const ua = idp ? undefined : remoteUserAuthEntry(dir, space);
    if (!idp && !ua)
      throw new Error(
        `space "${space}" has no user-auth material on this machine - user-mode status reads run where \`cotal up --user-auth\` provisioned the space, or where the discovered/registered entry for it lives`,
      );
    const idpUrl = idp ? idp.url : ua!.idp.url;
    const session = loadIdpSession(homeCotalDir(), idpUrl);
    if (!session?.sub) return { idpUrl };
    const login = { sub: session.sub, expiresAt: session.expiresAt };
    if (!idp) return { idpUrl, login };
    const secret = await loadOwnerSecret(store, space);
    if (!secret) return { idpUrl, login };
    const owner = deriveOwnerForIdpSubject(secret, idp.issuer, session.sub);
    const row = findInteractiveActor(dir, owner, actor);
    return {
      idpUrl,
      login,
      owner,
      grant: row
        ? {
            scope: row.scope,
            allowSubscribe: row.allowSubscribe,
            allowPublish: row.allowPublish,
            ...(row.role ? { role: row.role } : {}),
            ...(row.label ? { label: row.label } : {}),
          }
        : "not-granted",
    };
  },

  /** Spawn-path grant authorship: one atomic MANAGED-AGENT row (its own row space — never
   *  IdP-exchangeable by construction) carrying the agent's ACLs + the hash of a fresh per-agent
   *  secret. Upsert semantics rotate the secret on respawn — a captured old secret dies the moment
   *  its agent is respawned. */
  async grantAgent({ store, dir, space, owner, actor, scope, allowSubscribe, allowPublish, role, parent, label, lifecycleUid, fresh, custody }) {
    // Async work first: the callout material is loaded before the transaction, never inside it.
    const callout = await loadCalloutAuth(store, space);
    if (!callout)
      throw new Error(`space "${space}" has no user-auth material under ${dir} - enable it with \`cotal up --user-auth --idp <url>\` before spawning user-mode agents`);
    if (custody?.kind !== "local-manager" && custody?.kind !== "foreground")
      throw new Error("grantAgent: custody is required and is local-manager or foreground; a remote-manager row is written only by the auth service's enrollment");
    // ONE synchronous transaction: the `fresh` occupancy read, the token mint and the write are
    // decided under the same lock, so no other writer can land between the read and the upsert.
    // An earlier occupancy read by the caller authorizes nothing here; this one is authoritative.
    const actorToken = withManagedGrantTransaction(dir, (tx) => {
      if (fresh && tx.read(owner, actor) !== undefined)
        throw new AgentGrantConflictError(actor);
      const minted = newActorToken();
      tx.grantManaged({
        owner,
        actor,
        scope,
        allowSubscribe,
        allowPublish,
        ...(role ? { role } : {}),
        ...(parent ? { parent } : {}),
        ...(label ? { label } : {}),
        tokenHash: minted.tokenHash,
        lifecycleUid,
        custody,
      });
      return minted.actorToken;
    });
    return { actorToken, sentinelCreds: callout.sentinelCreds };
  },

  async revokeAgent({ dir, owner, actor, lifecycleUid, actorToken, expectCustody }) {
    if (expectCustody !== undefined && lifecycleUid === undefined)
      throw new Error("revokeAgent: expectCustody pins an exact lifecycle, so lifecycleUid is required with it");
    // The token check and the removal are one transaction: the row compared is the row removed.
    return withManagedGrantTransaction(dir, (tx) => {
      if (actorToken !== undefined && tx.read(owner, actor)?.tokenHash !== hashActorToken(actorToken)) return false;
      if (expectCustody !== undefined) return tx.revokeManagedIf(owner, actor, { lifecycleUid: lifecycleUid!, custody: expectCustody }) === "revoked";
      return lifecycleUid === undefined ? tx.revokeManaged(owner, actor) : tx.revokeManagedAt(owner, actor, lifecycleUid);
    });
  },

  deprovisionSecretKeys,

  /** The delete half of the seam pair: drop secrets and the client sentinel projection, attempting
   *  every key even when one fails (idempotent deletes — a failed pass re-runs as-is), then fail loud
   *  with everything that failed. The caller sweeps its non-seam local state only after this. */
  async deprovisionSecrets({ store, space }) {
    const keys = deprovisionSecretKeys(space);
    const failures: string[] = [];
    for (const key of keys) {
      try {
        await store.delete(key);
      } catch (e) {
        failures.push(`${key}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (failures.length)
      throw new Error(
        `auth secret deprovision failed for ${failures.length} of ${keys.length} keys (${failures.join("; ")}) - the deletes are idempotent, re-run the reset`,
      );
  },

  /** Fresh read across BOTH row spaces (actor names are disjoint between them, so the unified
   *  lookup is unambiguous): the manager's control authorization must see an operator's
   *  `actor grant` scope edit — or a revoke — on the very next stop/attach, hence no caching. */
  async actorScope({ dir, owner, actor }) {
    const row = findActorUnified(dir, owner, actor);
    return row ? [...row.scope] : undefined;
  },

  async trustFingerprint({ store, dir, space }) {
    return userAuthTrustFingerprint(store, dir, space);
  },

  async validateRetainedAgent(opts) {
    return validateRetainedManagedAgent(opts);
  },

  agentBearerCommand: "agent-bearer",
};

registry.register(cotalAuthProvider);

/** The pinned exchange base -> the POST target. Same composition as `agent-bearer
 *  --exchange-url` (append `/exchange`, drop search/hash), same transport rule as the
 *  registration probe: HTTPS, with a loopback-LITERAL http exception (nothing leaves the box;
 *  it is also what keeps the suites honest without a TLS fixture). */
function pinnedExchangeUrl(base: string, space: string): string {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new Error(
      `space "${space}" pins a malformed exchange URL (${JSON.stringify(base)}) - re-register with \`cotal meshes add ${space} --from <url>\``,
    );
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackLiteral(u.hostname)))
    throw new Error(
      `space "${space}" pins a non-HTTPS exchange (${base}) - the login proof rides the request body and must never cross plaintext off this machine; re-register with \`cotal meshes add ${space} --from <https-url>\``,
    );
  u.pathname = `${u.pathname.replace(/\/$/, "")}/exchange`;
  u.search = "";
  u.hash = "";
  return u.toString();
}

/** The manager-authority route shares the verified exchange origin. A registry convenience field
 * cannot redirect secret-bearing manager requests to another origin or to plaintext. */
function managerAuthorityUrl(base: string, space: string): string {
  const u = new URL(pinnedExchangeUrl(base, space));
  u.pathname = `${u.pathname.slice(0, -"/exchange".length)}/manager-service-authority`;
  return u.toString();
}

/** Resolve the manager-authority endpoint for one space: the local loopback service when this
 *  machine hosts the space's user-auth material, else the registry entry's pinned public exchange.
 *  `what` names the operation in a refusal so an operator reads which call could not be made. */
async function managerAuthorityEndpoint(
  store: SecretStore,
  dir: string,
  space: string,
  what: string,
): Promise<{ endpoint: string; idpUrl: string; authorization?: string }> {
  const idp = loadPinnedIdp(dir);
  const callout = await loadCalloutAuth(store, space);
  if (idp && callout) {
    const info = loadAuthServiceInfo(dir);
    if (!info || !pidAlive(info.pid))
      throw new Error(`the user-auth service for space "${space}" is not running - restart it with \`cotal up\` before ${what}`);
    return { endpoint: `${info.url}/manager-service-authority`, idpUrl: idp.url, authorization: `Bearer ${info.cap}` };
  }
  const entry = findMesh(space);
  const ua = entry?.mode === "user" ? entry.userAuth : undefined;
  if (ua?.remote !== true || typeof ua.endpoints?.url !== "string")
    throw new Error(`space "${space}" has no pinned remote manager-authority endpoint - re-register it with \`cotal meshes add ${space} --from <url>\``);
  return { endpoint: managerAuthorityUrl(ua.endpoints.url, space), idpUrl: ua.idp.url };
}

/** POST one typed manager-authority request with this machine's fresh login proof. Redirects are
 *  refused: a 302 could walk the proof, and the authority it buys, onto a host the registry never
 *  pinned. The parsed body comes back verbatim — the CALLER binds it to its own request. */
async function postManagerAuthority(
  endpoint: string,
  idpUrl: string,
  authorization: string | undefined,
  request: unknown,
  what: string,
): Promise<unknown> {
  const session = requireIdpSession(homeCotalDir(), idpUrl);
  const idpJwt = await fetchIdpJwt(idpUrl, session.token);
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
    body: JSON.stringify({ idpToken: idpJwt, request }),
    signal: AbortSignal.timeout(30_000),
  }).catch((error) => { throw new Error(`the ${what} endpoint did not answer at ${endpoint} (${error instanceof Error ? error.message : String(error)})`); });
  if (response.status >= 300 && response.status < 400)
    throw new Error(`the ${what} endpoint answered ${response.status} with redirect Location ${JSON.stringify(response.headers.get("location") ?? "")} - redirects are refused`);
  // A stand-in object would reach the caller as a result the endpoint never sent.
  const body = await response.json().catch(() => { throw new Error(`the ${what} endpoint at ${endpoint} answered HTTP ${response.status} with a body that could not be read as JSON`); });
  if (!response.ok) throw managerAuthorityRefusal(what, request, body, response.status);
  return body;
}

/** This build's version. The release group versions every package in lockstep, so it is also the
 *  version of the manager whose requests this client sends. */
const COTAL_VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

/** A manager-authority refusal, with the host's reason verbatim. The protocol is closed, so a host
 *  that names a field this request carries as unknown predates that field: say it is version skew
 *  and which side has to move. The field is never dropped to fit the older host. */
function managerAuthorityRefusal(what: string, request: unknown, body: unknown, status: number): Error {
  const reason = (body as { error?: string }).error ?? `HTTP ${status}`;
  const field = /unknown field "?([A-Za-z_$][\w$]*)"?/.exec(reason)?.[1];
  const skew = field !== undefined && carriesField(request, field)
    ? ` - version skew: this manager runs Cotal ${COTAL_VERSION} and the host's auth service predates the field "${field}" it sends; it needs a host at Cotal ${COTAL_VERSION} or later`
    : "";
  return new Error(`signed in, but ${what} was refused: ${reason}${skew}`);
}

function carriesField(value: unknown, field: string): boolean {
  return value !== null && typeof value === "object" &&
    (Object.hasOwn(value, field) || Object.values(value).some((v) => carriesField(v, field)));
}

/** The registry entry's user-auth position for a REMOTE space, bound to the CALLER'S state dir the
 *  way {@link remoteUserCredentials} binds it: `dir` derives from the resolved target's root, so an
 *  entry for the same space under a different root must not answer for it. `undefined` when the
 *  registry holds no such remote entry. This is the ONE read of the entry's pins — connect and the
 *  offline status read consume the same trust position, so they cannot drift. */
function remoteUserAuthEntry(
  dir: string,
  space: string,
): (UserAuthInfo & { remote: true; endpoints: { url: string }; sentinelCredsPath: string }) | undefined {
  const entry = findMesh(space);
  const ua = entry?.mode === "user" ? entry.userAuth : undefined;
  const bound =
    ua?.remote === true &&
    typeof ua.endpoints?.url === "string" &&
    typeof ua.sentinelCredsPath === "string" &&
    resolve(ua.sentinelCredsPath).startsWith(resolve(dir) + sep);
  return bound ? (ua as UserAuthInfo & { remote: true; endpoints: { url: string }; sentinelCredsPath: string }) : undefined;
}

/** Client-only service transport. The local arm reads a powerless sentinel projection, never
 * the callout account document. It sends no loopback capability. Remote pins remain dir-bound. */
function serviceClientTarget(store: SecretStore, dir: string, space: string): {
  base: string; idpUrl: string; readSentinel(): Promise<string | undefined>;
} {
  const remote = remoteUserAuthEntry(dir, space);
  if (remote) return {
    base: remote.endpoints.url, idpUrl: remote.idp.url,
    readSentinel: async () => readFileSync(remote.sentinelCredsPath, "utf8"),
  };
  const idp = loadPinnedIdp(dir);
  const info = loadAuthServiceInfo(dir);
  if (!idp || !info || !pidAlive(info.pid))
    throw new Error("service authority has no live local service or pinned remote registration; configure the user-auth space before setup");
  return { base: info.url, idpUrl: idp.url, readSentinel: () => store.get(authClientSentinelKey(space)) };
}

/** The `/exchange` body both client arms send. It names each coordinate rather than spreading the
 *  request because the service also reads `owner`, `actorToken` and `ttlSec` from this body, and a
 *  wider object passed as the request must not reach them. */
function exchangeBody(idpToken: string, { actor, view, managerInstanceId, sessionGrant, transferWriter }: UserCredentialsRequest): string {
  return JSON.stringify({ idpToken, actor, view, managerInstanceId, sessionGrant, transferWriter });
}

/** Client side of a REMOTE user mesh: the registry entry `cotal meshes add --from` recorded is
 *  the whole trust position (IdP pins, public exchange URL, sentinel path) - registration pinned
 *  it, connect consumes it, nothing is discovered here. The flow mirrors the local arm exactly
 *  (login session -> fresh IdP JWT -> exchange -> bearer + sentinel), with two deliberate
 *  differences: the POST goes to the PUBLIC exchange face (capless - the idpToken IS the
 *  credential; the 0600 capability file exists only where the daemon runs), and the sentinel
 *  creds come from the 0600 file registration landed rather than the local secret store. */
async function remoteUserCredentials(request: UserCredentialsRequest): Promise<{ bearer: string; sentinelCreds: string }> {
  const { dir, space, actor, view } = request;
  const remote = remoteUserAuthEntry(dir, space);
  if (!remote)
    throw new Error(
      `space "${space}" has no user-auth material on this machine - run \`cotal up --user-auth\` where the mesh runs, or register a remote user mesh with \`cotal meshes add ${space} --from <url>\` and sign in with \`cotal login --idp <idp-url>\``,
    );
  let sentinelCreds: string;
  try {
    sentinelCreds = readFileSync(remote.sentinelCredsPath, "utf8");
  } catch (e) {
    throw new Error(
      `space "${space}" is registered as a remote user mesh but its sentinel credential at ${remote.sentinelCredsPath} cannot be read (${e instanceof Error ? e.message : String(e)}) - re-register with \`cotal meshes add ${space} --from <url>\``,
    );
  }
  // The pin's transport rule is a STATIC check - run it before spending an IdP round trip on a
  // mint that is doomed either way (same ordering discipline as the local arm's liveness-first).
  const exchangeUrl = pinnedExchangeUrl(remote.endpoints.url, space);
  // The no-fallback login gate: throws the exact `cotal login --idp ...` line when not signed in.
  const session = requireIdpSession(homeCotalDir(), remote.idp.url);
  // Fresh short-lived IdP proof per connect - IdP-side revocation bites HERE, at the next fetch.
  const idpJwt = await fetchIdpJwt(remote.idp.url, session.token);
  let res: Response;
  try {
    res = await fetch(exchangeUrl, {
      method: "POST",
      // NO Authorization header: the public face is capless by design - the idpToken in the body
      // is the whole credential, and the loopback capability never leaves the daemon's machine.
      headers: { "content-type": "application/json" },
      body: exchangeBody(idpJwt, request),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw credentialFailure(
      "unavailable",
      `the exchange for space "${space}" did not answer at ${exchangeUrl} (${e instanceof Error ? e.message : String(e)}) - check the network, or re-register with \`cotal meshes add ${space} --from <url>\` if the mesh moved`,
    );
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    // A refused exchange is an authenticated denial with the reason; surface it verbatim - the
    // service's copy is already operator-exact (god-view, history-purge, deployer, and
    // manager-service stay loopback-only, and that refusal names the face). But the PUBLIC face
    // (#2158) is not this repository's and may withhold the service's reason; when it supplies
    // none, say so rather than presenting the bare HTTP status as if it were the reason - this
    // client cannot tell a real service sentence from a status code dressed up as one.
    const actorLabel = `actor "${actor}"${view ? ` (view "${view}")` : ""}`;
    throw credentialFailure(
      "refused",
      body.error
        ? `signed in, but the exchange for ${actorLabel} was refused: ${body.error}`
        : `signed in, but the exchange for ${actorLabel} was refused, and the exchange face withheld the reason (HTTP ${res.status})`,
    );
  }
  const out = (await res.json().catch(() => ({}))) as { token?: string };
  if (typeof out.token !== "string" || !out.token)
    throw new Error(`the exchange at ${exchangeUrl} returned no token - the mesh's auth service build may be stale`);
  return { bearer: out.token, sentinelCreds };
}

/** The auth service's chat-session routes are `/chat-session/<op>` (its `CHAT_SESSION_PATHS`). */
type ChatSessionOp = "open" | "bearer" | "retire";

/** Where one chat session's requests go and how this machine proves itself there, fixed at its
 *  open. `local`: the auth service recorded under this target's own state dir, whose URL and 0600
 *  capability are re-read from that dir per request (a restart moves them), under the IdP the open
 *  pinned. `remote`: the exchange origin the registry entry pinned at open, capless. The sentinel
 *  creds are read once, at open. */
export type ChatSessionRoute =
  | { kind: "local"; dir: string; idpUrl: string; sentinelCreds: string }
  | { kind: "remote"; base: string; idpUrl: string; sentinelCreds: string };

/** Each open session's route, by `(state dir, space, actor)`, in this process's memory only. The
 *  holder secret lives in the same process, so no other process can use the session anyway. */
const CHAT_SESSION_ROUTES = new Map<string, ChatSessionRoute>();
const chatRouteKey = (dir: string, space: string, actor: string): string => `${resolve(dir)}\0${space}\0${actor}`;

/** The route a later request of an open session must use. A session this process did not open
 *  has none, and the request refuses before anything is sent. */
function pinnedChatSessionRoute(dir: string, space: string, actor: string): ChatSessionRoute {
  const route = CHAT_SESSION_ROUTES.get(chatRouteKey(dir, space, actor));
  if (route === undefined)
    throw new EpEnvelopeError("failed-precondition", `chat session "${actor}" in space "${space}" was not opened by this process; its holder secret and route exist only there - open a new session`, undefined, "not-executed");
  return route;
}

/** Resolve a space's chat-session route once, at open: the local service when this machine hosts
 *  the space's user-auth material, else the registry entry's pinned exchange origin. */
async function resolveChatSessionRoute(store: SecretStore, dir: string, space: string): Promise<ChatSessionRoute> {
  const idp = loadPinnedIdp(dir);
  const callout = await loadCalloutAuth(store, space);
  if (idp && callout) return { kind: "local", dir, idpUrl: idp.url, sentinelCreds: callout.sentinelCreds };
  const remote = remoteUserAuthEntry(dir, space);
  if (!remote)
    throw new EpEnvelopeError("unimplemented", `space "${space}" has no user-auth material on this machine - run \`cotal up --user-auth\` where the mesh runs, or register a remote user mesh with \`cotal meshes add ${space} --from <url>\``, undefined, "not-executed");
  const u = new URL(pinnedExchangeUrl(remote.endpoints.url, space));
  u.pathname = u.pathname.slice(0, -"/exchange".length);
  let sentinelCreds: string;
  try {
    sentinelCreds = readFileSync(remote.sentinelCredsPath, "utf8");
  } catch (e) {
    throw new EpEnvelopeError("unavailable", `space "${space}" is registered as a remote user mesh but its sentinel credential at ${remote.sentinelCredsPath} cannot be read (${e instanceof Error ? e.message : String(e)}) - re-register with \`cotal meshes add ${space} --from <url>\``, undefined, "not-executed");
  }
  return { kind: "remote", base: u.toString().replace(/\/$/, ""), idpUrl: remote.idp.url, sentinelCreds };
}

/** The open's narrowing check: the route resolved here must be the position the caller resolved.
 *  A remote route needs the same exchange origin, a local route needs no `exchangeUrl`, and both need
 *  the same IdP, each compared after the normalization that pinned it. Refuses before any request. */
export function assertChatRouteExpected(route: ChatSessionRoute, space: string, expect: { idpUrl: string; exchangeUrl?: string }): void {
  const differs = (what: string): never => {
    throw new EpEnvelopeError("failed-precondition", `the user-auth position for space "${space}" is not the one this command resolved (${what}); nothing was sent - run the command again`, undefined, "not-executed");
  };
  let sameIdp: boolean;
  try {
    sameIdp = normalizeIdpUrl(route.idpUrl) === normalizeIdpUrl(expect.idpUrl);
  } catch {
    return differs("an IdP URL does not normalize");
  }
  if (!sameIdp) differs("its IdP changed");
  if (route.kind === "local") {
    if (expect.exchangeUrl !== undefined) differs("it resolved a remote mesh, and this machine hosts the space");
    return;
  }
  if (expect.exchangeUrl === undefined) differs("it resolved a local mesh, and the registry names a remote one");
  let expected: string;
  try {
    const u = new URL(pinnedExchangeUrl(expect.exchangeUrl as string, space));
    u.pathname = u.pathname.slice(0, -"/exchange".length);
    expected = u.toString().replace(/\/$/, "");
  } catch {
    return differs("its exchange URL does not normalize");
  }
  if (expected !== route.base) differs("its exchange origin changed");
}

/** The URL and authorization for one request on a route. A local route re-reads the service record
 *  from its own state dir and refuses when that dir's pinned IdP is no longer the one the open used. */
function chatSessionTarget(route: ChatSessionRoute, space: string, op: ChatSessionOp): { url: string; authorization?: string } {
  if (route.kind === "remote") return { url: `${route.base}/chat-session/${op}` };
  if (loadPinnedIdp(route.dir)?.url !== route.idpUrl)
    throw new EpEnvelopeError("failed-precondition", `the user-auth IdP recorded for space "${space}" changed after this chat session opened; open a new session`, undefined, "not-executed");
  const info = loadAuthServiceInfo(route.dir);
  if (info && probeLiveness(info.pid) === "unknown")
    throw new EpEnvelopeError("unavailable", `the user-auth service for space "${space}" records pid ${info.pid}, whose liveness cannot be determined; verify with \`ps -p ${info.pid}\` before restarting anything`, undefined, "not-executed");
  if (!info || !pidAlive(info.pid))
    throw new EpEnvelopeError("unavailable", `the user-auth service for space "${space}" is not running - restart it with \`cotal up\``, undefined, "not-executed");
  return { url: `${info.url}/chat-session/${op}`, authorization: `Bearer ${info.cap}` };
}

/** POST one chat-session request with this machine's fresh IdP proof for the route's IdP. Redirects
 *  are refused and their outcome is unknown, because whatever answered may have acted first. A
 *  refusal keeps the service's own code and its `executed`, `not-executed` or `unknown` outcome; an
 *  answer that states no outcome, a transport failure or an unreadable body is unknown. The holder
 *  proof rides only the request body, never an error string. */
async function postChatSession(route: ChatSessionRoute, space: string, op: ChatSessionOp, fields: Record<string, unknown>): Promise<object> {
  const target = chatSessionTarget(route, space, op);
  const session = requireIdpSession(homeCotalDir(), route.idpUrl);
  const idpToken = await fetchIdpJwt(route.idpUrl, session.token);
  let res: Response;
  try {
    res = await fetch(target.url, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", ...(target.authorization ? { authorization: target.authorization } : {}) },
      body: JSON.stringify({ idpToken, ...fields }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new EpEnvelopeError("unavailable", `the chat-session ${op} for space "${space}" did not answer at ${target.url} (${e instanceof Error ? e.message : String(e)}); its outcome is unknown`, undefined, "unknown");
  }
  if (res.status >= 300 && res.status < 400)
    throw new EpEnvelopeError("unavailable", `the chat-session ${op} endpoint answered ${res.status} with a redirect; redirects are refused and the request's outcome is unknown`, undefined, "unknown");
  const body = (await res.json().catch(() => undefined)) as unknown;
  if (!res.ok) {
    const b = (body ?? {}) as { error?: unknown; code?: unknown; outcome?: unknown };
    const code: EpErrorCode = typeof b.code === "string" && (EP_ERROR_CODES as readonly string[]).includes(b.code) ? (b.code as EpErrorCode) : "unavailable";
    const outcome: EpEffectOutcome = b.outcome === "executed" || b.outcome === "not-executed" ? b.outcome : "unknown";
    const why = typeof b.error === "string" && b.error !== "" ? b.error : `HTTP ${res.status}`;
    throw new EpEnvelopeError(code, `signed in, but the chat-session ${op} for space "${space}" was refused: ${why}`, undefined, outcome);
  }
  if (body === undefined || body === null || typeof body !== "object")
    throw new EpEnvelopeError("unavailable", `the chat-session ${op} for space "${space}" answered HTTP ${res.status} with a body that could not be read; its outcome is unknown`, undefined, "unknown");
  return body;
}
