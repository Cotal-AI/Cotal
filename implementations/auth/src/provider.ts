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
import { ManagedRowAttemptError, canonicalJson, epRequestSubject, managedRowEndpointRequest, managedRowRequesterGrantRows, managedRowWireId, parseEpSubject, parseManagedRowReplyBytes, registry, validateManagedRowIntent, verifyManagedRowAttemptNonce, type AuthPrepareInput, type AuthPrepared, type AuthProvider, type ManagedRowAttempt, type RemoteManagerAdminAuthorizationRequest, type RemoteManagerAdminAuthorizationResult, type RemoteManagerAuthorityMaterial, type RemoteManagerAuthorityRequest, type RemoteManagerGoalIndexScanRequest, type RemoteManagerGoalIndexScanResult, type RemoteRetainedAgentValidationRequest, type RemoteRetainedAgentValidationResult, type SecretStore } from "@cotal-ai/core";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { assertUserAuthInfo, findMesh, homeCotalDir, probeLiveness, spaceSegment, type UserAuthInfo } from "@cotal-ai/workspace";
import { createHash } from "node:crypto";
import { mkdirSync, openSync, closeSync, constants, fchmodSync, fsyncSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { isIPv4, isIPv6 } from "node:net";
import { join, resolve, sep } from "node:path";
import { fetchIdpJwt, loadIdpSession, probeIdpJwks, requireIdpSession } from "./login.js";
import { deriveOwnerForIdpSubject } from "./derive.js";
import { findActorUnified, findInteractiveActor, grantManagedActor, newActorToken, revokeManagedActor } from "./ledger.js";
import { userAuthTrustFingerprint, validateRetainedManagedAgent } from "./continuity.js";
import {
  AUTH_PROVIDER_NAME,
  authCalloutKey,
  authIssuerKey,
  authOwnerSecretKey,
  authServiceKeysKey,
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

export interface ManagedRowTransportMessage {
  subject: string;
  data: Uint8Array;
  headers?: { code?: number; status?: string } | null;
}
export interface ManagedRowTransportSubscription { unsubscribe(): void }
export interface ManagedRowTransportConnection {
  subscribe(subject: string, opts: { callback(error: Error | null, msg: ManagedRowTransportMessage): void }): ManagedRowTransportSubscription;
  flush(): Promise<void>;
  publish(subject: string, data: Uint8Array, opts?: { reply?: string }): void;
  close(): Promise<void>;
}
export interface ManagedRowTransportDeps {
  open(input: { server: string; credentials: string; requestId: string }): Promise<ManagedRowTransportConnection>;
  now(): number;
  setTimer(run: () => void, delayMs: number): unknown;
  clearTimer(timer: unknown): void;
}

const PRODUCTION_MANAGED_ROW_TRANSPORT: ManagedRowTransportDeps = {
  open: async ({ server, credentials, requestId }) => connect({
    servers: server,
    authenticator: credsAuthenticator(new TextEncoder().encode(credentials)),
    name: `cotal:managed-row-request:${requestId}`,
  }) as unknown as ManagedRowTransportConnection,
  now: () => performance.now(),
  setTimer: (run, delayMs) => setTimeout(run, delayMs),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

const MAX_TIMER_MS = 2_147_483_647;
export async function sendManagedRowAttemptWithTransport(
  { server, credentials, attempt, timeoutMs = 15_000 }: { server: string; credentials: string; attempt: ManagedRowAttempt; timeoutMs?: number },
  transport: ManagedRowTransportDeps = PRODUCTION_MANAGED_ROW_TRANSPORT,
): Promise<{ bytes: Uint8Array; data: import("@cotal-ai/core").ManagedRowResult }> {
  const startedAt = transport.now();
  const intent = validateManagedRowIntent(attempt.intent);
  if (attempt.ver !== 1 || attempt.command !== intent.command) throw new ManagedRowAttemptError("managed-row transport attempt command mismatch", "not-executed");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS)
    throw new ManagedRowAttemptError(`managed-row timeout must be a positive integer within ${MAX_TIMER_MS}ms`, "not-executed");
  try { verifyManagedRowAttemptNonce(attempt.nonce, attempt.caller, intent, attempt.authority, attempt.bind, attempt.mappingRevision); }
  catch (error) { throw new ManagedRowAttemptError((error as Error).message, "not-executed", undefined, { cause: error }); }
  const grants = managedRowRequesterGrantRows(intent.space, {
    command: intent.command, caller: attempt.caller, nonce: attempt.nonce,
    ...(intent.command === "revoke-managed-row" ? { targetOwner: intent.target.owner } : {}),
  });
  const subject = grants.publish[0];
  const replyFilter = grants.subscribe[0];
  const wireId = managedRowWireId(intent);
  let nc: ManagedRowTransportConnection | undefined;
  let sub: ManagedRowTransportSubscription | undefined;
  let timer: unknown;
  let published = false;
  // `reply` is owned by this invocation until the race settles. The subscription is retained for
  // exactly that interval and is synchronously unsubscribed in `finally`. A callback already queued
  // by the transport may still run after timeout/cleanup, so it must observe this terminal flag and
  // become a no-op rather than settling an abandoned continuation.
  let settled = false;
  try {
    const timeout = () => new Promise<never>((_, reject) => {
      const remaining = Math.max(0, timeoutMs - (transport.now() - startedAt));
      timer = transport.setTimer(() => {
        settled = true;
        reject(new ManagedRowAttemptError(`managed-row request ${intent.requestId} timed out`, published ? "unknown" : "not-executed"));
      }, remaining);
    });
    try { nc = await Promise.race([transport.open({ server, credentials, requestId: intent.requestId }), timeout()]); }
    catch (error) { throw new ManagedRowAttemptError(`managed-row connect failed: ${(error as Error).message}`, "not-executed", undefined, { cause: error }); }
    if (timer !== undefined) { transport.clearTimer(timer); timer = undefined; }
    let resolveReply!: (result: { bytes: Uint8Array; data: import("@cotal-ai/core").ManagedRowResult }) => void;
    let rejectReply!: (error: ManagedRowAttemptError) => void;
    const reply = new Promise<{ bytes: Uint8Array; data: import("@cotal-ai/core").ManagedRowResult }>((resolve, reject) => {
      resolveReply = resolve; rejectReply = reject;
    });
    try {
      sub = nc.subscribe(replyFilter, { callback: (error, msg) => {
        if (settled) return;
        try {
          if (error) { settled = true; rejectReply(new ManagedRowAttemptError(`managed-row reply subscription failed: ${error.message}`, published ? "unknown" : "not-executed", undefined, { cause: error })); return; }
          const attributed = parseEpSubject(msg.subject);
          if (!attributed || attributed.plane !== "reply" || attributed.endpoint !== "auth" || attributed.nonce !== attempt.nonce) return;
          if (attempt.bind !== undefined && (attributed.instanceId !== attempt.bind.instanceId || attributed.epoch !== attempt.bind.epoch)) return;
          let parsed;
          try { parsed = parseManagedRowReplyBytes(msg.data, wireId, intent); }
          catch { return; }
          settled = true;
          if (!parsed.ok) {
            const knowledge = parsed.error?.outcome === "not-executed" ? "not-executed" : parsed.error?.outcome === "executed" ? "executed" : "unknown";
            rejectReply(new ManagedRowAttemptError(parsed.error?.message ?? `managed-row ${intent.requestId} failed`, knowledge, parsed));
            return;
          }
          resolveReply({ bytes: msg.data, data: parsed.data });
        } catch { /* a late or malformed transport callback never escapes into the client runtime */ }
      } });
    } catch (error) {
      throw new ManagedRowAttemptError(`managed-row reply subscription setup failed: ${(error as Error).message}`, "not-executed", undefined, { cause: error });
    }
    try { await Promise.race([nc.flush(), timeout()]); }
    catch (error) { throw new ManagedRowAttemptError(`managed-row subscription flush failed: ${(error as Error).message}`, "not-executed", undefined, { cause: error }); }
    if (timer !== undefined) { transport.clearTimer(timer); timer = undefined; }
    const remainingAtPublish = Math.floor(timeoutMs - (transport.now() - startedAt));
    if (remainingAtPublish <= 0) throw new ManagedRowAttemptError(`managed-row request ${intent.requestId} timed out before publish`, "not-executed");
    const body = new TextEncoder().encode(canonicalJson(managedRowEndpointRequest(attempt, remainingAtPublish)));
    try { nc.publish(subject, body); }
    catch (error) { throw new ManagedRowAttemptError(`managed-row publish failed before acceptance: ${(error as Error).message}`, "not-executed", undefined, { cause: error }); }
    published = true;
    try { return await Promise.race([reply, timeout()]); }
    finally { settled = true; }
  } finally {
    settled = true;
    if (timer !== undefined) transport.clearTimer(timer);
    try { sub?.unsubscribe(); } catch {}
    await nc?.close().catch(() => {});
  }
}

const READY_TIMEOUT_MS = 15_000;

interface ProviderGrantRequest {
  ver: 1;
  requestId: string;
  owner: string;
  actor: string;
  lifecycleUid: string;
  actorToken: string;
  state: "pending" | "host-committed";
}

function providerRequestPath(dir: string, requestId: string): string {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(requestId)) throw new Error("auth provider requestId must be a 16-128 character opaque token");
  const root = join(dir, "managed-row-requests");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return join(root, `${requestId}.json`);
}

function writeProviderRequest(path: string, request: ProviderGrantRequest): void {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(request, null, 2)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, path);
}

function loadOrCreateGrantRequest(dir: string, requestId: string, owner: string, actor: string, lifecycleUid: string): ProviderGrantRequest {
  const path = providerRequestPath(dir, requestId);
  if (existsSync(path)) {
    const request = JSON.parse(readFileSync(path, "utf8")) as ProviderGrantRequest;
    if (request.ver !== 1 || request.requestId !== requestId || request.owner !== owner || request.actor !== actor || request.lifecycleUid !== lifecycleUid)
      throw new Error(`auth provider request ${requestId} conflicts with its durable coordinates`);
    return request;
  }
  const request: ProviderGrantRequest = { ver: 1, requestId, owner, actor, lifecycleUid, actorToken: newActorToken().actorToken, state: "pending" };
  writeProviderRequest(path, request);
  return request;
}

/** Present only if PROVEN present. `probeLiveness` resolves EPERM (another user's process) to
 *  `alive`, which is the defect this fixes: the old two-state probe called that dead. `unknown`
 *  reads as NOT present, matching the behaviour this replaced, because a readiness caller that
 *  accepts an undeterminable pid hands out an endpoint nothing is listening on. */
function pidAlive(pid: number): boolean {
  return probeLiveness(pid) === "alive";
}

export const cotalAuthProvider: AuthProvider = {
  kind: "auth-provider",
  name: AUTH_PROVIDER_NAME,
  async prepareServer(input: AuthPrepareInput): Promise<AuthPrepared> {
    const { space, store, dir, idpUrl } = input;
    // Fail BEFORE mutation: a degenerate space (`.`/`..`/empty) must be refused before the IdP
    // probe/pin below can touch anything at a caller-provided dir — not first at the key builders
    // further down, which would leave a pin written at an aliased path behind the thrown error.
    spaceSegment(space);
    // On a FRESH enable, prove the IdP actually serves a JWKS before we pin + provision a space
    // around it — a dead or typo'd `--idp` must fail loud here, not silently boot a broken space
    // that only errors at the first user connect. Skip on re-up (an already-pinned IdP was validated
    // at first enable; re-probing every boot would couple mesh liveness to IdP liveness).
    if (idpUrl && !loadPinnedIdp(dir)) await probeIdpJwks(idpUrl);
    // Pin the IdP FIRST, so a fresh `up --user-auth` without --idp fails on the config error before
    // any key material is generated.
    const idp = ensurePinnedIdp(dir, idpUrl);
    await ensureOwnerSecret(store, space);
    await ensureIssuer(store, space);
    const callout = await ensureCalloutAuth(store, { space, operatorSeed: input.operatorSeed, accountPub: input.account.pub });
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
        command: "auth-service",
        // Readiness = the daemon wrote its discovery file (which it does only after the callout SUB
        // is flushed AND the HTTP listener is bound) and /health answers. Poll until timeoutMs, then
        // THROW with the reason — the caller (`up`) surfaces it loudly (U5), never records a usable
        // user mesh on a half-started service.
        async ready({ dir: stateDir, timeoutMs = READY_TIMEOUT_MS }) {
          const deadline = Date.now() + timeoutMs;
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
            await new Promise((r) => setTimeout(r, 200));
          }
          // No log-path guess here — the CALLER owns the daemon's log location and appends it.
          throw new Error(`auth service not ready after ${timeoutMs}ms (${lastReason})`);
        },
      },
    };
  },

  /** Client side: this machine's login session → a fresh IdP JWT → the local auth service's
   *  exchange → the Cotal bearer, plus the space's sentinel creds. NO fallback anywhere; each
   *  failure is one sentence with the exact operator action (U1/U10/U11 acceptance strings). */
  async userCredentials({ store, dir, space, actor, view }: { store: SecretStore; dir: string; space: string; actor: string; view?: string }) {
    const idp = loadPinnedIdp(dir);
    const callout = await loadCalloutAuth(store, space);
    // No local material: this machine may still hold a REMOTE registration (\`cotal meshes add
    // --from\`), whose registry entry pinned the IdP + public exchange at registration time. The
    // remote arm consumes exactly what registration pinned - it discovers nothing at connect time.
    if (!idp || !callout) return remoteUserCredentials(dir, space, actor, view);
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
      throw new Error(
        `the user-auth service for space "${space}" is not running - restart it with \`cotal up\` (or \`cotal auth-service --space ${space} --server <broker>\`)`,
      );
    // Fresh short-lived IdP proof per connect — IdP-side revocation bites HERE, at the next fetch.
    const idpJwt = await fetchIdpJwt(idp.url, session.token);
    let res: Response;
    try {
      res = await fetch(`${info.url}/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${info.cap}` },
        body: JSON.stringify({ idpToken: idpJwt, actor, ...(view !== undefined ? { view } : {}) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new Error(
        `the user-auth service for space "${space}" did not answer at ${info.url} (${e instanceof Error ? e.message : String(e)}) - restart it with \`cotal up\``,
      );
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      // A refused exchange is an authenticated denial with the reason (an ungranted actor names
      // the grant command); surface it verbatim — the service's copy is already operator-exact.
      throw new Error(
        `signed in, but the exchange for actor "${actor}"${view ? ` (view "${view}")` : ""} was refused: ${body.error ?? `HTTP ${res.status}`}`,
      );
    }
    const out = (await res.json().catch(() => ({}))) as { token?: string };
    if (typeof out.token !== "string" || !out.token)
      throw new Error(`the auth service's exchange returned no token - its build may be stale; restart it with \`cotal up\``);
    return { bearer: out.token, sentinelCreds: callout.sentinelCreds };
  },

  async managerServiceAuthority({ store, dir, request }: { store: SecretStore; dir: string; request: RemoteManagerAuthorityRequest }): Promise<RemoteManagerAuthorityMaterial> {
    const idp = loadPinnedIdp(dir);
    const callout = await loadCalloutAuth(store, request.space);
    let idpUrl: string;
    let endpoint: string;
    let authorization: string | undefined;
    if (idp && callout) {
      const info = loadAuthServiceInfo(dir);
      if (!info || !pidAlive(info.pid))
        throw new Error(`the user-auth service for space "${request.space}" is not running - restart it with \`cotal up\` before requesting manager-service authority`);
      idpUrl = idp.url;
      endpoint = `${info.url}/manager-service-authority`;
      authorization = `Bearer ${info.cap}`;
    } else {
      const entry = findMesh(request.space);
      const ua = entry?.mode === "user" ? entry.userAuth : undefined;
      if (ua?.remote !== true || typeof ua.endpoints?.url !== "string")
        throw new Error(`space "${request.space}" has no pinned remote manager-authority endpoint - re-register it with \`cotal meshes add ${request.space} --from <url>\``);
      idpUrl = ua.idp.url;
      endpoint = managerAuthorityUrl(ua.endpoints.url, request.space);
    }
    const session = requireIdpSession(homeCotalDir(), idpUrl);
    const idpJwt = await fetchIdpJwt(idpUrl, session.token);
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
        body: JSON.stringify({ idpToken: idpJwt, request }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new Error(`the manager-service authority endpoint for space "${request.space}" did not answer at ${endpoint} (${e instanceof Error ? e.message : String(e)})`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok)
      throw new Error(`signed in, but manager-service authority was refused: ${(body as { error?: string }).error ?? `HTTP ${res.status}`}`);
    return body as RemoteManagerAuthorityMaterial;
  },

  async scanRemoteManagerGoalIndex({ store, dir, request }: { store: SecretStore; dir: string; request: RemoteManagerGoalIndexScanRequest }): Promise<RemoteManagerGoalIndexScanResult> {
    const idp = loadPinnedIdp(dir);
    const callout = await loadCalloutAuth(store, request.space);
    let idpUrl: string;
    let endpoint: string;
    let authorization: string | undefined;
    if (idp && callout) {
      const info = loadAuthServiceInfo(dir);
      if (!info || !pidAlive(info.pid))
        throw new Error(`the user-auth service for space "${request.space}" is not running - restart it with \`cotal up\` before scanning manager goal indexes`);
      idpUrl = idp.url;
      endpoint = `${info.url}/manager-service-authority`;
      authorization = `Bearer ${info.cap}`;
    } else {
      const entry = findMesh(request.space);
      const ua = entry?.mode === "user" ? entry.userAuth : undefined;
      if (ua?.remote !== true || typeof ua.endpoints?.url !== "string")
        throw new Error(`space "${request.space}" has no pinned remote manager-authority endpoint - re-register it with \`cotal meshes add ${request.space} --from <url>\``);
      idpUrl = ua.idp.url;
      endpoint = managerAuthorityUrl(ua.endpoints.url, request.space);
    }
    const session = requireIdpSession(homeCotalDir(), idpUrl);
    const idpJwt = await fetchIdpJwt(idpUrl, session.token);
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: JSON.stringify({ idpToken: idpJwt, request }),
      signal: AbortSignal.timeout(30_000),
    }).catch((error) => { throw new Error(`the manager goal-index endpoint for space "${request.space}" did not answer at ${endpoint} (${error instanceof Error ? error.message : String(error)})`); });
    if (response.status >= 300 && response.status < 400)
      throw new Error(`the manager goal-index endpoint answered ${response.status} with redirect Location ${JSON.stringify(response.headers.get("location") ?? "")} - redirects are refused`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`signed in, but manager goal-index scan was refused: ${(body as { error?: string }).error ?? `HTTP ${response.status}`}`);
    return body as RemoteManagerGoalIndexScanResult;
  },

  async authorizeRemoteManagerAdmin({ store, dir, request }: { store: SecretStore; dir: string; request: RemoteManagerAdminAuthorizationRequest }): Promise<RemoteManagerAdminAuthorizationResult> {
    const idp = loadPinnedIdp(dir);
    const callout = await loadCalloutAuth(store, request.space);
    let idpUrl: string;
    let endpoint: string;
    let authorization: string | undefined;
    if (idp && callout) {
      const info = loadAuthServiceInfo(dir);
      if (!info || !pidAlive(info.pid))
        throw new Error(`the user-auth service for space "${request.space}" is not running - restart it with \`cotal up\` before authorizing manager admin reach`);
      idpUrl = idp.url;
      endpoint = `${info.url}/manager-service-authority`;
      authorization = `Bearer ${info.cap}`;
    } else {
      const entry = findMesh(request.space);
      const ua = entry?.mode === "user" ? entry.userAuth : undefined;
      if (ua?.remote !== true || typeof ua.endpoints?.url !== "string")
        throw new Error(`space "${request.space}" has no pinned remote manager-authority endpoint - re-register it with \`cotal meshes add ${request.space} --from <url>\``);
      idpUrl = ua.idp.url;
      endpoint = managerAuthorityUrl(ua.endpoints.url, request.space);
    }
    const session = requireIdpSession(homeCotalDir(), idpUrl);
    const idpJwt = await fetchIdpJwt(idpUrl, session.token);
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: JSON.stringify({ idpToken: idpJwt, request }),
      signal: AbortSignal.timeout(30_000),
    }).catch((error) => { throw new Error(`the manager admin authorization endpoint for space "${request.space}" did not answer at ${endpoint} (${error instanceof Error ? error.message : String(error)})`); });
    if (response.status >= 300 && response.status < 400)
      throw new Error(`the manager admin authorization endpoint answered ${response.status} with redirect Location ${JSON.stringify(response.headers.get("location") ?? "")} - redirects are refused`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`signed in, but manager admin authorization was refused: ${(body as { error?: string }).error ?? `HTTP ${response.status}`}`);
    return body as RemoteManagerAdminAuthorizationResult;
  },

  async validateRemoteRetainedAgent({ store, dir, request }: { store: SecretStore; dir: string; request: RemoteRetainedAgentValidationRequest }): Promise<RemoteRetainedAgentValidationResult> {
    const idp = loadPinnedIdp(dir);
    const callout = await loadCalloutAuth(store, request.space);
    let idpUrl: string;
    let endpoint: string;
    let authorization: string | undefined;
    if (idp && callout) {
      const info = loadAuthServiceInfo(dir);
      if (!info || !pidAlive(info.pid))
        throw new Error(`the user-auth service for space "${request.space}" is not running - restart it with \`cotal up\` before validating retained manager authority`);
      idpUrl = idp.url;
      endpoint = `${info.url}/manager-service-authority`;
      authorization = `Bearer ${info.cap}`;
    } else {
      const entry = findMesh(request.space);
      const ua = entry?.mode === "user" ? entry.userAuth : undefined;
      if (ua?.remote !== true || typeof ua.endpoints?.url !== "string")
        throw new Error(`space "${request.space}" has no pinned remote manager-authority endpoint - re-register it with \`cotal meshes add ${request.space} --from <url>\``);
      idpUrl = ua.idp.url;
      endpoint = managerAuthorityUrl(ua.endpoints.url, request.space);
    }
    const session = requireIdpSession(homeCotalDir(), idpUrl);
    const idpJwt = await fetchIdpJwt(idpUrl, session.token);
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
        body: JSON.stringify({ idpToken: idpJwt, request }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new Error(`the manager retained-agent validation endpoint for space "${request.space}" did not answer at ${endpoint} (${e instanceof Error ? e.message : String(e)})`);
    }
    if (res.status >= 300 && res.status < 400)
      throw new Error(`the manager retained-agent validation endpoint answered ${res.status} with redirect Location ${JSON.stringify(res.headers.get("location") ?? "")} - redirects are refused so retained secrets cannot be walked onto another host`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok)
      throw new Error(`signed in, but manager retained-agent validation was refused: ${(body as { error?: string }).error ?? `HTTP ${res.status}`}`);
    return body as RemoteRetainedAgentValidationResult;
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
      // 401 is the one refusal with a local remedy; everything else is the mesh's own word.
      throw new Error(
        res.status === 401
          ? `the mesh refused this login for agent provisioning: ${reason} - your session may have expired; re-run \`cotal login --idp ${idpUrl}\``
          : `the mesh refused to provision agent "${actor}": ${reason}`,
      );
    }
    return body;
  },

  /** Offline status read: the pinned IdP, this machine's cached login, and (when the local ledger
   *  has material) the actor's grant row. No IdP round trip, no service call, no mint — `cotal
   *  status` must be able to say "not signed in" without becoming a connect. */
  async userStatus({ store, dir, space, actor }) {
    const idp = loadPinnedIdp(dir);
    if (!idp)
      throw new Error(
        `space "${space}" has no user-auth material on this machine - user-mode status reads run where \`cotal up --user-auth\` provisioned the space`,
      );
    const session = loadIdpSession(homeCotalDir(), idp.url);
    if (!session?.sub) return { idpUrl: idp.url };
    const login = { sub: session.sub, expiresAt: session.expiresAt };
    const secret = await loadOwnerSecret(store, space);
    if (!secret) return { idpUrl: idp.url, login };
    const owner = deriveOwnerForIdpSubject(secret, idp.issuer, session.sub);
    const row = findInteractiveActor(dir, owner, actor);
    return {
      idpUrl: idp.url,
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
  async grantAgent({ store, dir, space, owner, actor, scope, allowSubscribe, allowPublish, role, parent, label, lifecycleUid, requestId }) {
    const callout = await loadCalloutAuth(store, space);
    if (!callout)
      throw new Error(`space "${space}" has no user-auth material under ${dir} - enable it with \`cotal up --user-auth --idp <url>\` before spawning user-mode agents`);
    const stableRequestId = requestId ?? createHash("sha256").update(`provider-grant\0${owner}\0${actor}\0${lifecycleUid}`).digest("hex");
    const request = loadOrCreateGrantRequest(dir, stableRequestId, owner, actor, lifecycleUid);
    const actorToken = request.actorToken;
    const tokenHash = createHash("sha256").update(actorToken, "utf8").digest("hex");
    grantManagedActor(dir, {
      owner,
      actor,
      scope,
      allowSubscribe,
      allowPublish,
      ...(role ? { role } : {}),
      ...(parent ? { parent } : {}),
      ...(label ? { label } : {}),
      tokenHash,
      lifecycleUid,
    }, { requestId: stableRequestId });
    if (request.state !== "host-committed") {
      request.state = "host-committed";
      writeProviderRequest(providerRequestPath(dir, stableRequestId), request);
    }
    return { actorToken, sentinelCreds: callout.sentinelCreds };
  },

  async stageManagedRowCreate({ store, dir, space, owner, actor, lifecycleUid, requestId }) {
    const callout = await loadCalloutAuth(store, space);
    if (!callout) throw new Error(`space "${space}" has no local user-auth callout material`);
    const request = loadOrCreateGrantRequest(dir, requestId, owner, actor, lifecycleUid);
    return { actorToken: request.actorToken, sentinelCreds: callout.sentinelCreds };
  },

  sendManagedRowAttempt: (opts) => sendManagedRowAttemptWithTransport(opts),

  async revokeAgent({ dir, owner, actor, lifecycleUid, requestId }) {
    const stableRequestId = requestId ?? createHash("sha256").update(`provider-revoke\0${owner}\0${actor}\0${lifecycleUid ?? "current"}`).digest("hex");
    return revokeManagedActor(dir, owner, actor, { requestId: stableRequestId, lifecycleUid });
  },

  /** The delete half of the seam pair: drop the four secret kinds from the store, attempting all
   *  four even when one fails (idempotent deletes — a failed pass re-runs as-is), then fail loud
   *  with everything that failed. The caller sweeps its non-seam local state only after this. */
  async deprovisionSecrets({ store, space }) {
    const keys = [authCalloutKey(space), authIssuerKey(space), authOwnerSecretKey(space), authServiceKeysKey(space)];
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

/** The loopback-literal exception for the pinned exchange, decided by PARSING the host as an
 *  address - never by how the text begins. A NAME gets no exception however it starts
 *  (`127.evil.com`, `localhost`): names resolve wherever DNS says, and the exchange body carries
 *  the login proof. Mirrors the registration-side pinned-fetch policy in `meshes add --from`,
 *  which verified this same URL under the same rule before recording it. */
function isLoopbackLiteral(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIPv4(h)) return h.startsWith("127.");
  if (isIPv6(h)) {
    if (h === "::1") return true;
    const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped !== null && mapped[1].startsWith("127.");
  }
  return false;
}

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

/** Client side of a REMOTE user mesh: the registry entry `cotal meshes add --from` recorded is
 *  the whole trust position (IdP pins, public exchange URL, sentinel path) - registration pinned
 *  it, connect consumes it, nothing is discovered here. The flow mirrors the local arm exactly
 *  (login session -> fresh IdP JWT -> exchange -> bearer + sentinel), with two deliberate
 *  differences: the POST goes to the PUBLIC exchange face (capless - the idpToken IS the
 *  credential; the 0600 capability file exists only where the daemon runs), and the sentinel
 *  creds come from the 0600 file registration landed rather than the local secret store. */
async function remoteUserCredentials(
  dir: string,
  space: string,
  actor: string,
  view?: string,
): Promise<{ bearer: string; sentinelCreds: string }> {
  const entry = findMesh(space);
  const ua = entry?.mode === "user" ? entry.userAuth : undefined;
  // Bind the registry entry to the CALLER'S state dir: `dir` was derived from the target's root,
  // so an entry for the same space under a different root must not answer for it.
  const bound =
    ua?.remote === true &&
    typeof ua.endpoints?.url === "string" &&
    typeof ua.sentinelCredsPath === "string" &&
    resolve(ua.sentinelCredsPath).startsWith(resolve(dir) + sep);
  if (!bound)
    throw new Error(
      `space "${space}" has no user-auth material on this machine - run \`cotal up --user-auth\` where the mesh runs, or register a remote user mesh with \`cotal meshes add ${space} --from <url>\` and sign in with \`cotal login --idp <idp-url>\``,
    );
  const remote = ua as UserAuthInfo & { endpoints: { url: string }; sentinelCredsPath: string };
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
      body: JSON.stringify({ idpToken: idpJwt, actor, ...(view !== undefined ? { view } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new Error(
      `the exchange for space "${space}" did not answer at ${exchangeUrl} (${e instanceof Error ? e.message : String(e)}) - check the network, or re-register with \`cotal meshes add ${space} --from <url>\` if the mesh moved`,
    );
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    // A refused exchange is an authenticated denial with the reason; surface it verbatim - the
    // service's copy is already operator-exact (elevated views, for one, are refused on the
    // public face by policy, and its refusal names that).
    throw new Error(
      `signed in, but the exchange for actor "${actor}"${view ? ` (view "${view}")` : ""} was refused: ${body.error ?? `HTTP ${res.status}`}`,
    );
  }
  const out = (await res.json().catch(() => ({}))) as { token?: string };
  if (typeof out.token !== "string" || !out.token)
    throw new Error(`the exchange at ${exchangeUrl} returned no token - the mesh's auth service build may be stale`);
  return { bearer: out.token, sentinelCreds };
}
