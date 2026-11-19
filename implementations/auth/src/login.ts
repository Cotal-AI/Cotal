/**
 * Device sign-in and machine-local IdP sessions. Better Auth uses JSON and an opaque session
 * bearer. Explicit OIDC mode uses discovery and form grants and retains only a refresh token.
 * Mesh proofs stay in memory under the same expiry and revocation bounds for both modes.
 */
import { idpSessionDir } from "./session-context.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createLocalJWKSet, decodeJwt, type JWK } from "jose";
import { acquireLockAsync, isCredentialTransportUrl, liveLockOwnerPid, mkSecretDir, writeSecretFileAtomic, type AuthSpaceCatalogAccount, type AuthSpaceCatalogResult } from "@cotal-ai/core";
import { loginRecoveryCommand, serviceLoginRecovery, CommandFailure, acquireLock, chatNameProblem, credentialFailure, checkIdpUrl, shellPath } from "@cotal-ai/workspace";
import { pinnedJwksResolver } from "./issuer.js";
import { verifyIdpToken } from "./idp.js";

interface AccountIdentity {
  /** The IdP subject this session proved at login (display + local owner derivation). Absent only
   *  in caches written by older builds — consumers that need it fail loud naming `cotal login`. */
  sub?: string;
  /** The handle a chat session appears as by default: the IdP's preferred_username, else its
   *  email's local part, else its name, the first that is a chat name. Display only. Absent when
   *  none is, and in caches written by older builds. */
  name?: string;
  /** Account display label returned by the provider, never an authorization identity. */
  label?: string;
}

/** Legacy Better Auth records have no mode tag. Their expiry is advisory. */
interface BetterAuthSession extends AccountIdentity {
  mode?: never;
  token: string;
  expiresAt: number;
}

interface OidcSession extends AccountIdentity {
  mode: "oidc";
  token?: never;
  expiresAt?: never;
  id: string;
  sub: string;
  issuer: string;
  clientId: string;
  tokenEndpoint: string;
  jwksUri: string;
  revocationEndpoint?: string;
  refreshToken: string;
}

/** A saved provider session. An OIDC refresh token is never a Better Auth bearer. */
export type IdpSession = BetterAuthSession | OidcSession;

const SPACE_CATALOG_REL = "https://cotal.ai/relations/space-catalog";
export const CATALOG_FRESH_MS = 5_000;
const CATALOG_FILE = "space-catalogs.json";
const CATALOG_VER = 1;
const CATALOG_LOCK = "space-catalogs.lock";

interface CatalogAccountState {
  idpUrl: string;
  issuer: string;
  sub: string;
  ownerKey: string;
  catalogUrl?: string;
  advertised: boolean;
  advertisementCheckedAt?: string;
  etag?: string;
  fetchedAt?: string;
  snapshot?: unknown;
  /** The consumer applied this snapshot in full. Absent while a fetched snapshot is being applied,
   *  so a preparation that finds it absent applies the cached snapshot again. */
  applied?: boolean;
  /** The last refresh failed. A successful refresh clears it. */
  failing?: boolean;
}

interface CatalogsFile {
  ver: number;
  accounts: Record<string, CatalogAccountState>;
}

/** What the human must be shown to approve the sign-in. */
export interface DeviceLoginPrompt {
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  expiresInSec: number;
}

export interface DeviceLoginOpts {
  /** The Better Auth base URL, or the exact issuer in OIDC mode. */
  idpUrl: string;
  /** The OAuth client id this CLI presents; the IdP may pin it via its validateClient hook. */
  clientId: string;
  /** Pick the discovery-based device grant explicitly. The exchange audience is the client ID. */
  oidc?: boolean;
  /** Retained auth URL when this approval is part of a native migration. */
  migrationFrom?: string;
  /** Shows the human the verification URL + code. Called exactly once; polling starts only after
   *  it settles, a rejection fails the login, and the device code's lifetime bounds it. */
  onPrompt: (prompt: DeviceLoginPrompt) => void | Promise<void>;
  /** Stops this sign-in: no further IdP request is sent and nothing is persisted. It is local only
   *  and revokes nothing at the IdP. Omitted, the sign-in runs until approval, denial or expiry. */
  signal?: AbortSignal;
}

/** Normalize + guard the IdP base URL: https (or http on a loopback IP literal for dev), no
 *  query/hash, no trailing slash — the normalized string is also the session-cache key, so
 *  `…/api/auth` and `…/api/auth/` must land on the same entry. */
export function normalizeIdpUrl(idpUrl: string): string {
  const checked = checkIdpUrl(idpUrl);
  if (!checked.ok) {
    switch (checked.reason) {
      case "invalid-url": throw new Error(`idp url "${idpUrl}" is not a valid URL`);
      case "scheme": throw new Error(`idp url must be https (or http on a loopback IP literal such as 127.0.0.1 for local dev) - got "${idpUrl}"`);
      case "query-or-fragment": throw new Error(`idp url must not carry a query or fragment - got "${idpUrl}"`);
      case "credentials": throw new Error(`idp url must not embed credentials before the host - the host it would actually contact is "${checked.host}"`);
    }
  }
  return checked.url.origin + checked.url.pathname.replace(/\/+$/, "");
}

interface OAuthError {
  error?: string;
  error_description?: string;
}
async function oauthError(res: Response, cancel?: AbortSignal): Promise<OAuthError> {
  try {
    const body: unknown = await res.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) return {};
    const fields = body as Record<string, unknown>;
    return {
      ...(typeof fields.error === "string" ? { error: fields.error } : {}),
      ...(typeof fields.error_description === "string" ? { error_description: fields.error_description } : {}),
    };
  } catch {
    // An unreadable error body is treated as "no detail", unless the caller cancelled mid-read.
    throwIfCancelled(cancel);
    return {};
  }
}

/** Local IdP configuration that must be corrected before making a request. */
export class IdpConfigurationError extends Error {}

/** Per-request timeout budget (ms). Default 30s; `COTAL_IDP_TIMEOUT_MS` overrides for a slow IdP
 *  (or a test). Requires whole milliseconds from 1 to 2147483647, the non-overflowing Node timer
 *  range. A malformed override fails loud rather than silently reverting to the default. */
export function idpTimeoutMs(): number {
  const raw = process.env.COTAL_IDP_TIMEOUT_MS;
  if (raw === undefined) return 30_000;
  const n = Number(raw);
  // AbortSignal.timeout rejects fractions; its underlying timer clamps larger delays to 1ms.
  if (!Number.isInteger(n) || n < 1 || n > 2_147_483_647)
    throw new IdpConfigurationError(`COTAL_IDP_TIMEOUT_MS must be a whole number of milliseconds from 1 to 2147483647 - got "${raw}"`);
  return n;
}

/** The client could not complete an IdP request because of transport failure, timeout, or session cache contention. */
export class IdpUnreachableError extends Error {}

/** The provider refused the initial device-code request, before approval or persistence. */
export class IdpDeviceAuthorizationRefusedError extends Error {}

/** The IdP answered 401 to a cached session: it expired or was revoked there. */
export class IdpSessionRejectedError extends Error {}

/** A token read still answered 429. The provider's minimum delay is in seconds, without the
 *  client's retry floor, or undefined when neither retry header is usable. */
export class IdpRateLimitedError extends Error {
  readonly status = 429;
  constructor(message: string, readonly retryAfterSeconds?: number) {
    super(message);
  }
}

/** A sign-in stopped by the caller's AbortSignal. It stops this local operation only: nothing
 *  is revoked at the IdP, and an approval already given there is left as it is. */
export class IdpLoginCancelled extends Error {}

const CANCELLED = "idp login: the sign-in was cancelled on this machine; nothing was saved and nothing was revoked at the IdP";

/** Throw {@link IdpLoginCancelled} when the caller's signal has fired. */
function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new IdpLoginCancelled(CANCELLED);
}

/** A promise that rejects with {@link IdpLoginCancelled} once `signal` fires, and never settles
 *  without one. `dispose` removes the listener so a finished race leaves nothing attached. */
function cancelled(signal: AbortSignal | undefined): { promise: Promise<never>; dispose: () => void } {
  if (!signal) return { promise: new Promise<never>(() => {}), dispose: () => {} };
  let onAbort: () => void = () => {};
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(new IdpLoginCancelled(CANCELLED));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  promise.catch(() => {});
  return { promise, dispose: () => signal.removeEventListener("abort", onAbort) };
}

/** Sleep `ms`, or reject with {@link IdpLoginCancelled} as soon as `signal` fires. */
async function sleepUnlessCancelled(ms: number, signal: AbortSignal | undefined): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = cancelled(signal);
  try {
    await Promise.race([new Promise<void>((r) => { timer = setTimeout(r, ms); }), stop.promise]);
  } finally {
    clearTimeout(timer);
    stop.dispose();
  }
}

/** `fetch` with a hard per-request timeout, so a hung IdP connection can never stall the client
 *  (Node's global fetch has no default timeout). A timeout or transport failure surfaces as a
 *  legible sentence rather than a raw DOMException/TypeError. */
async function idpFetch(url: string, init?: RequestInit, cancel?: AbortSignal, ms = idpTimeoutMs()): Promise<Response> {
  throwIfCancelled(cancel);
  try {
    const timeout = AbortSignal.timeout(ms);
    return await fetch(url, { ...init, signal: cancel ? AbortSignal.any([timeout, cancel]) : timeout });
  } catch (e) {
    throwIfCancelled(cancel);
    if (e instanceof DOMException && e.name === "TimeoutError")
      throw new IdpUnreachableError(`idp request to ${url} timed out after ${ms}ms - the IdP is unreachable or not responding`);
    throw new IdpUnreachableError(`idp request to ${url} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Read a JSON body under the SAME normalization as {@link idpFetch}. The request timeout can fire
 *  DURING the body read (an IdP that flushes headers then stalls or truncates the body), and that
 *  abort is raised from `res.json()` — outside idpFetch's catch — so without this it would leak a
 *  raw DOMException/parse error instead of the legible "idp request to …" sentence. */
async function idpJson<T>(url: string, res: Response, cancel?: AbortSignal): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (e) {
    throwIfCancelled(cancel);
    if (e instanceof DOMException && e.name === "TimeoutError")
      throw new IdpUnreachableError(`idp request to ${url} timed out reading the response body - the IdP flushed headers then stalled`);
    throw new Error(`idp request to ${url} returned an unreadable response body: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN = "urn:ietf:params:oauth:token-type:access_token";
const ID_TOKEN = "urn:ietf:params:oauth:token-type:id_token";

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Better Auth-specific routes cannot use an OIDC refresh token or mesh proof as a bearer. */
export function betterAuthSessionToken(session: IdpSession): string {
  if (session.mode === "oidc") throw new Error("this provider route requires a Better Auth session and does not support OIDC sign-in");
  return session.token;
}

export function oidcEndpoint(value: unknown, name: string): string {
  const url = text(value) ? URL.parse(value) : null;
  if (!url || !isCredentialTransportUrl(url) || url.username || url.password || url.href.includes("#"))
    throw new IdpConfigurationError(`OIDC ${name} must be an absolute HTTPS URL without credentials or a fragment (HTTP loopback IPs are allowed for local development)`);
  return url.href;
}

/** An OIDC issuer is compared as written, even when its cache key is normalized. */
export function normalizeOidcIssuer(issuer: string): string {
  const base = normalizeIdpUrl(issuer);
  const parsed = new URL(issuer);
  if (issuer.includes("?") || issuer.includes("#") || (parsed.href !== issuer && parsed.origin !== issuer))
    throw new IdpConfigurationError("use the exact OIDC issuer URL without a query or fragment");
  return base;
}

async function oidcFetch(url: string, cancel?: AbortSignal, form?: Record<string, string>, timeout?: number): Promise<Response> {
  const res = await idpFetch(url, { redirect: "manual", ...(form ? { method: "POST", body: new URLSearchParams(form) } : {}) }, cancel, timeout);
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new Error(`OIDC request to ${url} answered HTTP ${res.status}; redirects are refused`);
  }
  return res;
}

/** Do not echo OIDC token responses or provider error descriptions in diagnostics. */
async function oidcJson<T extends object>(res: Response, cancel?: AbortSignal): Promise<Partial<T> | undefined> {
  try {
    const body: unknown = await res.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Partial<T> : undefined;
  } catch (e) {
    throwIfCancelled(cancel);
    if (e instanceof DOMException && e.name === "TimeoutError")
      throw new IdpUnreachableError(`OIDC request to ${res.url} timed out reading the response body`);
    return undefined;
  }
}

async function discoverOidc(issuer: string, signal?: AbortSignal) {
  normalizeOidcIssuer(issuer);
  const res = await oidcFetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, signal);
  const metadata = await oidcJson<{ issuer: string; device_authorization_endpoint: string; token_endpoint: string; jwks_uri: string; revocation_endpoint: string }>(res, signal);
  if (!res.ok) throw new Error(`OIDC discovery failed (HTTP ${res.status})`);
  if (metadata?.issuer !== issuer) throw new IdpConfigurationError("OIDC discovery issuer does not match the configured issuer");
  return {
    deviceEndpoint: oidcEndpoint(metadata.device_authorization_endpoint, "device_authorization_endpoint"),
    tokenEndpoint: oidcEndpoint(metadata.token_endpoint, "token_endpoint"),
    jwksUri: oidcEndpoint(metadata.jwks_uri, "jwks_uri"),
    ...(metadata.revocation_endpoint === undefined ? {} : { revocationEndpoint: oidcEndpoint(metadata.revocation_endpoint, "revocation_endpoint") }),
  };
}

type OidcGrant = { access_token: string; refresh_token: string; token_type: string };

function opaqueRefreshToken(value: unknown): value is string {
  return text(value) && value === value.trim() && !looksLikeJwt(value);
}

export function validOidcClientId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\s\x00-\x1f\x7f]/.test(value);
}

function oidcLoginCommand(issuer: string, clientId: string): string {
  return `cotal login --oidc --idp ${shellPath(issuer)} --client-id ${shellPath(clientId)}`;
}

async function exchangeOidcProof(session: Pick<OidcSession, "issuer" | "clientId" | "tokenEndpoint" | "jwksUri">, accessToken: string, signal?: AbortSignal) {
  const res = await oidcFetch(session.tokenEndpoint, signal, {
    grant_type: TOKEN_EXCHANGE, client_id: session.clientId,
    subject_token: accessToken, subject_token_type: ACCESS_TOKEN,
    requested_token_type: ID_TOKEN, audience: session.clientId, scope: "openid",
  });
  const body = await oidcJson<{ access_token: string; issued_token_type: string }>(res, signal);
  if (!res.ok) throw new Error(`OIDC token exchange failed (HTTP ${res.status})`);
  if (body?.issued_token_type !== ID_TOKEN || !text(body.access_token))
    throw new Error("OIDC token exchange did not return an ID token");
  const proof = await verifyIdpToken(body.access_token, {
    issuer: session.issuer, audience: session.clientId, key: pinnedJwksResolver(session.jwksUri),
  });
  if (proof.exp * 1000 <= Date.now()) throw new Error("OIDC token exchange returned an expired ID token");
  throwIfCancelled(signal);
  return { jwt: body.access_token, sub: proof.sub };
}

/** Probe the pinned JWKS at first enable. Explicit OIDC trust requires a key the proof verifier
 * can resolve. Better Auth retains its existing key-set check at `<base>/jwks`. */
export async function probeIdpJwks(idpUrl: string, jwksUri = `${normalizeIdpUrl(idpUrl)}/jwks`, opts: { requireEd25519?: boolean } = {}): Promise<void> {
  const res = await idpFetch(jwksUri, { redirect: "manual" });
  if (res.status >= 300 && res.status < 400)
    throw new Error(`the IdP at ${idpUrl} answered ${jwksUri} with HTTP ${res.status}, a redirect; redirects are refused, so its target was not fetched.`);
  if (!res.ok)
    throw new Error(`the IdP at ${idpUrl} did not serve a JWKS: ${jwksUri} returned HTTP ${res.status}. Check --idp <auth base URL>.`);
  const body = await idpJson<{ keys?: unknown }>(jwksUri, res);
  if (!Array.isArray(body?.keys))
    throw new Error(`the IdP at ${idpUrl} did not return a JWKS key set at ${jwksUri}.`);
  if (!opts.requireEd25519) return;
  if (body.keys.every((key: unknown): key is JWK => key !== null && typeof key === "object" && !Array.isArray(key))) {
    // Use the same resolver as the pinned remote set, including key IDs, use and key_ops.
    const getKey = createLocalJWKSet({ keys: body.keys });
    const kids = new Set(body.keys.map(key => typeof key.kid === "string" ? key.kid : undefined));
    for (const kid of kids) {
      try {
        const key = await getKey({ alg: "EdDSA", kid });
        if (key.algorithm.name === "Ed25519" && key.usages.includes("verify")) return;
      } catch { /* Try the remaining key IDs. */ }
    }
  }
  throw new Error("the pinned JWKS has no usable Ed25519 verification key");
}

/** True if `s` parses as a JWT — used to REJECT a JWT where an opaque session token is required.
 *  The revocation model depends on the cached token being revocable; a JWT stays valid until it
 *  expires regardless of revocation, so one must never be cached as the session handle. */
function looksLikeJwt(s: string): boolean {
  try {
    decodeJwt(s);
    return true;
  } catch {
    return false;
  }
}

/** Sign in via the RFC 8628 device flow and return the IdP session. Fail-loud on every non-happy
 *  path: a deny, an expiry, or an unknown poll error is a thrown human sentence, never a retry
 *  loop. Blocks (polling at the server's stated interval) until the human approves. */
export function deviceLogin(opts: DeviceLoginOpts & { oidc?: false }): Promise<BetterAuthSession>;
export function deviceLogin(opts: DeviceLoginOpts): Promise<IdpSession>;
export async function deviceLogin(opts: DeviceLoginOpts): Promise<IdpSession> {
  return (await requestDeviceLogin(opts)).session;
}

async function requestDeviceLogin(opts: DeviceLoginOpts): Promise<{ session: BetterAuthSession } | { session: OidcSession; jwt: string }> {
  const base = normalizeIdpUrl(opts.idpUrl);
  if (opts.oidc && !validOidcClientId(opts.clientId))
    throw new IdpConfigurationError("OIDC mode requires a non-empty client ID without whitespace or control characters");
  if (opts.oidc && opts.migrationFrom !== undefined)
    throw new IdpConfigurationError("OIDC mode does not support Better Auth native migrations");
  const oidc = opts.oidc ? await discoverOidc(opts.idpUrl, opts.signal) : undefined;
  const deviceEndpoint = oidc ? oidc.deviceEndpoint : `${base}/device/code`;
  const tokenEndpoint = oidc ? oidc.tokenEndpoint : `${base}/device/token`;
  const post = (url: string, fields: Record<string, string>, timeout?: number) => oidc
    ? oidcFetch(url, opts.signal, fields, timeout)
    : idpFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fields) }, opts.signal);
  const res = await post(deviceEndpoint, { client_id: opts.clientId, ...(oidc ? { scope: "openid offline_access" } : {}) });
  if (!res.ok) {
    if (oidc) {
      await res.body?.cancel();
      throw new IdpDeviceAuthorizationRefusedError(`idp login: ${base} refused the device authorization (HTTP ${res.status})`);
    }
    const e = await oauthError(res, opts.signal);
    throw new IdpDeviceAuthorizationRefusedError(
      `idp login: ${base} refused the device authorization (${e.error ?? `HTTP ${res.status}`}: ${e.error_description ?? "no detail"})`,
    );
  }
  type Grant = {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  };
  const grant = oidc ? await oidcJson<Grant>(res, opts.signal) : await idpJson<Grant>(deviceEndpoint, res, opts.signal);
  // The WHOLE grant is shape-checked before anything is shown or polled — the timing fields
  // especially: a malicious IdP handing back `interval: "abc"` or a non-finite/absurd
  // `expires_in` would otherwise turn the poll loop into a tight (setTimeout coerces garbage to
  // ~1ms) or unbounded one. Bounds: a device code living past 24h or a poll interval past 5min
  // is not a sane grant — refuse, don't clamp.
  const sane = (v: unknown, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= max;
  if (
    !grant || typeof grant.device_code !== "string" || !grant.device_code ||
    typeof grant.user_code !== "string" || !grant.user_code ||
    typeof grant.verification_uri !== "string" || !grant.verification_uri ||
    ((!oidc || grant.verification_uri_complete !== undefined) && !text(grant.verification_uri_complete)) ||
    !sane(grant.expires_in, 86_400) ||
    (grant.interval !== undefined && !sane(grant.interval, 300))
  )
    throw new Error(`idp login: ${base} returned a malformed device grant - refusing to poll on it`);
  const retry = oidc ? oidcLoginCommand(opts.idpUrl, opts.clientId) : opts.migrationFrom === undefined ? "cotal login" : `cotal login --migrate-from ${normalizeIdpUrl(opts.migrationFrom)}`;
  const verificationUri = oidc ? oidcEndpoint(grant.verification_uri, "verification_uri") : grant.verification_uri;
  const verificationUriComplete = grant.verification_uri_complete === undefined ? verificationUri : oidc ? oidcEndpoint(grant.verification_uri_complete, "verification_uri_complete") : grant.verification_uri_complete;
  const expired = `idp login: the device code expired after ${grant.expires_in}s without approval - run \`${retry}\` again`;
  // The code's lifetime runs from the grant, so a prompt that never settles fails the login at
  // expiry instead of holding it open.
  const deadline = Date.now() + grant.expires_in * 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = cancelled(opts.signal);
  try {
    await Promise.race([
      opts.onPrompt({
        verificationUri,
        verificationUriComplete,
        userCode: grant.user_code,
        expiresInSec: grant.expires_in,
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(expired)), deadline - Date.now()); }),
      stop.promise,
    ]);
  } finally {
    clearTimeout(timer);
    stop.dispose();
  }

  // RFC 8628 §3.5: poll at the server's interval; `slow_down` adds 5s to it, permanently.
  let intervalSec = Math.max(1, grant.interval || 5);
  for (;;) {
    await sleepUnlessCancelled(Math.min(intervalSec * 1000, Math.max(0, deadline - Date.now())), opts.signal);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(expired);
    let poll: Response;
    try {
      poll = await post(tokenEndpoint, { grant_type: DEVICE_GRANT, device_code: grant.device_code, client_id: opts.clientId }, oidc ? Math.min(idpTimeoutMs(), remaining) : undefined);
    } catch (error) {
      if (oidc && error instanceof IdpUnreachableError) { intervalSec *= 2; continue; }
      throw error;
    }
    if (poll.ok) {
      if (oidc) {
        const tok = await oidcJson<OidcGrant>(poll, opts.signal);
        if (!text(tok?.access_token) || typeof tok.token_type !== "string" || tok.token_type.toLowerCase() !== "bearer" || !opaqueRefreshToken(tok.refresh_token) || tok.refresh_token === tok.access_token)
          throw new Error("OIDC device grant must return a bearer access token and an opaque refresh token");
        const session = { mode: "oidc" as const, id: randomUUID(), issuer: opts.idpUrl, clientId: opts.clientId,
          tokenEndpoint, jwksUri: oidc.jwksUri, refreshToken: tok.refresh_token, ...(oidc.revocationEndpoint ? { revocationEndpoint: oidc.revocationEndpoint } : {}) };
        const { jwt, sub } = await exchangeOidcProof(session, tok.access_token, opts.signal);
        return { session: { ...session, sub }, jwt };
      }
      const tok = await idpJson<{ access_token: string; expires_in: number }>(tokenEndpoint, poll, opts.signal);
      // Bound the session lifetime like the device grant's timing fields above (finite, positive,
      // not past a year). `expiresAt` is advisory only — the server is the revocation authority —
      // so this is a legibility/symmetry guard, not a security boundary: it refuses a hostile
      // `expires_in: 1e12` rather than caching it and printing "Session cached … until <year 33000>".
      if (typeof tok.access_token !== "string" || !tok.access_token || !sane(tok.expires_in, 31_536_000))
        throw new Error(`idp login: ${base} returned a malformed token response`);
      // Defense-in-depth for the revocation model: we cache the OPAQUE session handle precisely so
      // that IdP revocation bites at the next /token fetch. A JWT outlives its session, so if a
      // misconfigured IdP hands one back as the device token, refuse rather than silently cache a
      // credential that can't be revoked.
      if (looksLikeJwt(tok.access_token))
        throw new Error(`idp login: ${base} returned a JWT as the device access token - the session token must be an opaque revocable handle, refusing to cache it; re-run \`cotal login\` after fixing the IdP`);
      return { session: { token: tok.access_token, expiresAt: Math.floor(Date.now() / 1000) + tok.expires_in } };
    }
    const e = oidc ? await oidcJson<OAuthError>(poll, opts.signal) : await oauthError(poll, opts.signal);
    if (e?.error === "authorization_pending") continue;
    if (e?.error === "slow_down") {
      intervalSec += 5;
      continue;
    }
    if (e?.error === "access_denied") throw new Error("idp login: the sign-in was denied at the verification page");
    if (e?.error === "expired_token")
      throw new Error(`idp login: the device code expired before the sign-in was approved - run \`${retry}\` again`);
    const reason = oidc ? `HTTP ${poll.status}` : `${e?.error ?? `HTTP ${poll.status}`}: ${e?.error_description ?? "no detail"}`;
    throw new Error(`idp login: ${base} rejected the poll (${reason})`);
  }
}

/** Longest an IdP JWT is reused from memory. The bound on how long a session revoked at the IdP
 *  can still mint mesh access from a process that already held a JWT. */
const JWT_CACHE_CAP_MS = 60_000;
/** A held JWT is dropped this long before its own `exp`, so a reuse never hands the bridge a
 *  token that expires in flight. */
const JWT_CACHE_MARGIN_MS = 30_000;
function createJwtCache<T extends { jwt: string }>() {
  type Entry = { result: T; until: number } | { inflight: Promise<T> };
  const entries = new Map<string, Entry>();
  const cached = (key: string): T | undefined => {
    const hit = entries.get(key);
    if (!hit || !("until" in hit)) return undefined;
    if (hit.until > Date.now()) return hit.result;
    entries.delete(key);
    return undefined;
  };
  return {
    forget: (key: string) => entries.delete(key),
    cached,
    async read(key: string, fetchProof: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      throwIfCancelled(signal);
      const result = cached(key);
      if (result) return result;
      const hit = entries.get(key);
      if (hit && "inflight" in hit && !signal) return hit.inflight;
      const inflight = fetchProof().then((result) => {
        for (const [k, entry] of entries) if ("until" in entry && entry.until <= Date.now()) entries.delete(k);
        const until = jwtCacheUntil(result.jwt, Date.now());
        if (until > Date.now()) entries.set(key, { result, until });
        else if (entries.get(key) === entry) entries.delete(key);
        return result;
      }, (error: unknown) => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      });
      const entry: Entry = { inflight };
      if (!signal) entries.set(key, entry);
      return inflight;
    },
  };
}

type IdpJwtResult = { jwt: string; response: Response };
const jwtCache = createJwtCache<IdpJwtResult>();
const oidcJwtCache = createJwtCache<{ jwt: string }>();

/** When a JWT stops being reusable: the cap, or its `exp` minus the margin, whichever is sooner.
 *  A token with no decodable `exp` is never held, because nothing bounds its lifetime. */
function jwtCacheUntil(jwt: string, now: number): number {
  let exp: unknown;
  try {
    exp = decodeJwt(jwt).exp;
  } catch {
    return now;
  }
  if (typeof exp !== "number" || !Number.isFinite(exp)) return now;
  return Math.min(now + JWT_CACHE_CAP_MS, exp * 1000 - JWT_CACHE_MARGIN_MS);
}

/** A short-lived IdP user JWT for the cached session — the input to the bridge exchange. A 401
 *  means the session was revoked or expired at the IdP: the error says exactly how to recover.
 *  The JWT is held in memory within the bounds above and never written anywhere; a failure is
 *  never held, so a rate-limited or unreachable IdP is retried on the next call. Concurrent
 *  callers without a cancel signal share one proof fetch; a cancellable call makes its own fetch,
 *  so one caller's abort rejects nobody else. */
function fetchIdpJwtResponse(idpUrl: string, sessionToken: string, cancel?: AbortSignal): Promise<IdpJwtResult> {
  const base = normalizeIdpUrl(idpUrl);
  return jwtCache.read(`${base}\0${sessionToken}`, () => fetchIdpJwtUncached(base, sessionToken, cancel), cancel);
}

/** Retry only an explicitly rate-limited proof read, never the operation that consumes its JWT.
 * Both attempts, their bodies and the server's wait share the original IdP timeout. */
async function fetchIdpJwtUncached(base: string, sessionToken: string, cancel?: AbortSignal): Promise<IdpJwtResult> {
  const deadline = Date.now() + idpTimeoutMs();
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now();
    throwIfCancelled(cancel);
    if (remaining <= 0) throw new IdpUnreachableError(`idp request to ${base}/token timed out before the retry`);
    const res = await idpFetch(`${base}/token`, { headers: { authorization: `Bearer ${sessionToken}` } }, cancel, remaining);
    if (res.status === 429) {
      const delays = ["retry-after", "x-retry-after"].map((name) => {
        const value = res.headers.get(name)?.trim();
        return value && /^\d+$/.test(value) ? Number(value) * 1000
          : value && name === "retry-after" ? Date.parse(value) - Date.now() : NaN;
      }).filter(Number.isFinite);
      const wait = Math.max(1000, ...delays);
      if (attempt === 0 && delays.length && wait < deadline - Date.now()) {
        await res.body?.cancel();
        await sleepUnlessCancelled(wait, cancel);
        continue;
      }
      throw new IdpRateLimitedError(
        `idp session: ${base}/token failed (HTTP 429)`,
        delays.length ? Math.max(0, ...delays) / 1000 : undefined,
      );
    }
    if (res.status === 401)
      throw new IdpSessionRejectedError(
        `idp session: ${base} rejected the cached session (expired or revoked) - ${serviceLoginRecovery(base, idpSessionDir())}`,
      );
    if (!res.ok) throw new Error(`idp session: ${base}/token failed (HTTP ${res.status})`);
    const body = await idpJson<{ token?: string }>(`${base}/token`, res, cancel);
    if (typeof body.token !== "string" || !body.token) throw new Error(`idp session: ${base}/token returned no token`);
    return { jwt: body.token, response: res };
  }
}

function oidcCacheKey(dir: string, session: OidcSession): string {
  return `${resolve(dir)}\0${session.issuer}\0${session.id}`;
}

function currentOidcSession(dir: string, session: OidcSession): OidcSession {
  const current = loadIdpSession(dir, session.issuer);
  if (current?.mode !== "oidc" || current.id !== session.id)
    throw new IdpSessionRejectedError("OIDC sign-in changed while obtaining a proof; retry with the current sign-in");
  return current;
}

async function refreshOidcProof(dir: string, session: OidcSession, signal?: AbortSignal) {
  const grant = await withAsyncSessionLock(dir, async () => {
    const current = currentOidcSession(dir, session);
    throwIfCancelled(signal);
    const cached = oidcJwtCache.cached(oidcCacheKey(dir, current));
    if (cached) return { cached };
    // Once sent, let the rotation finish and commit even if the caller cancels. An aborted
    // response could lose the replacement while the provider has already invalidated the old one.
    let res: Response;
    let body: Partial<OidcGrant & OAuthError> | undefined;
    try {
      res = await oidcFetch(current.tokenEndpoint, undefined, {
        grant_type: "refresh_token", client_id: current.clientId, refresh_token: current.refreshToken,
      });
      body = await oidcJson<OidcGrant & OAuthError>(res);
    } catch (error) {
      if (error instanceof IdpUnreachableError)
        throw new IdpUnreachableError(`OIDC refresh response was not received; the provider may have rotated the token. If the cached sign-in is rejected, run \`${oidcLoginCommand(current.issuer, current.clientId)}\` again.`);
      throw error;
    }
    if (!res.ok) {
      if (res.status === 401 || body?.error === "invalid_grant")
        throw new IdpSessionRejectedError(`OIDC provider rejected the cached sign-in; run \`${oidcLoginCommand(current.issuer, current.clientId)}\` again`);
      throw new Error(`OIDC refresh failed (HTTP ${res.status})`);
    }
    if (body?.refresh_token !== undefined && (!opaqueRefreshToken(body.refresh_token) || body.refresh_token === body.access_token))
      throw new Error("OIDC refresh returned an invalid refresh token; sign in again");
    if (body?.refresh_token && body.refresh_token !== current.refreshToken)
      saveIdpSessionLocked(dir, current.issuer, { ...current, refreshToken: body.refresh_token });
    if (!text(body?.access_token) || typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer")
      throw new Error("OIDC refresh did not return a bearer access token");
    return { current, accessToken: body.access_token };
  }, signal);
  if (grant.cached) return grant.cached;
  // Exchange and JWKS lookup do not touch the rotating credential. Other processes can refresh
  // while this proof is checked. The caller rechecks the session ID before returning the proof.
  const proof = await exchangeOidcProof(grant.current, grant.accessToken, signal);
  if (proof.sub !== grant.current.sub) throw new Error("OIDC token exchange returned a different subject than the cached sign-in");
  return proof;
}

export async function fetchIdpJwt(idpUrl: string, session: string | IdpSession, signal?: AbortSignal, dir = idpSessionDir()): Promise<string> {
  if (typeof session === "string" || session.mode !== "oidc")
    return (await fetchIdpJwtResponse(idpUrl, typeof session === "string" ? session : session.token, signal)).jwt;
  if (normalizeIdpUrl(idpUrl) !== normalizeIdpUrl(session.issuer)) throw new IdpConfigurationError("OIDC session belongs to another provider");
  currentOidcSession(dir, session);
  const result = await oidcJwtCache.read(oidcCacheKey(dir, session), () => refreshOidcProof(dir, session, signal), signal);
  currentOidcSession(dir, session);
  return result.jwt;
}

/** Optional expected identity claims checked before a staged login can be committed.
 * Claims are decoded from the provider response. Signature verification remains server-side. */
export interface IdpLoginPins {
  idpUrl?: string;
  issuer: string;
  audience: string;
  sub?: string;
}

/** An in-memory login proof. Its bearer and advertisement are private to this module. */
export interface StagedIdpSession {
  readonly sub: string;
  readonly issuer?: string;
  readonly audience?: string | readonly string[];
}

interface StagedLoginState {
  opts: DeviceLoginOpts & { dir: string; expectedPins?: IdpLoginPins; migrationFrom?: string };
  session: IdpSession;
  claims: Record<string, unknown>;
  link: string | null;
  previousSub?: string;
  baseline?: string;
}
const stagedLogins = new WeakMap<StagedIdpSession, StagedLoginState>();

function assertLoginPins(claims: Record<string, unknown>, pins?: IdpLoginPins): void {
  if (!pins) return;
  const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  if (claims.iss !== pins.issuer || !Array.isArray(audiences) || !audiences.every(a => typeof a === "string") || !audiences.includes(pins.audience) || (pins.sub !== undefined && claims.sub !== pins.sub))
    throw new Error("idp login: the approved account does not match the expected issuer, audience or subject; nothing was saved");
}

/** Approve and prove a fresh login without writing any local state.
 * `migrationFrom` fences the retained account used to validate a native migration. */
export async function stageIdpSession(
  opts: DeviceLoginOpts & { dir: string; expectedPins?: IdpLoginPins; migrationFrom?: string },
): Promise<StagedIdpSession> {
  // Refuse damaged local state before asking the person to approve a sign-in.
  const initial = readCatalogPreparationState(opts.dir);
  const baseline = opts.migrationFrom === undefined ? undefined : migrationDependency(initial, opts.migrationFrom);
  opts = { ...opts, ...(opts.expectedPins ? { expectedPins: { ...opts.expectedPins } } : {}) };
  if (opts.expectedPins?.idpUrl !== undefined && normalizeIdpUrl(opts.idpUrl) !== normalizeIdpUrl(opts.expectedPins.idpUrl))
    throw new Error("idp login: the provider URL does not match the expected login URL; nothing was saved");
  const previous = loadIdpSession(opts.dir, opts.idpUrl);
  if (previous && (previous.mode === "oidc") !== Boolean(opts.oidc))
    throw new IdpConfigurationError("the cached sign-in uses a different provider mode; sign out of it before changing modes");
  const previousSub = previous?.sub;
  const login = await requestDeviceLogin(opts);
  const { session } = login;
  const tokenResult = "jwt" in login ? login : await fetchIdpJwtResponse(opts.idpUrl, login.session.token, opts.signal);
  let claims: Record<string, unknown>;
  try {
    claims = decodeJwt(tokenResult.jwt);
  } catch {
    // fetchIdpJwt only guarantees a non-empty string; a hostile IdP returning /token 200 with a
    // non-JWT body would otherwise surface jose's raw "Invalid JWT" here.
    throw new Error(`idp login: ${normalizeIdpUrl(opts.idpUrl)} returned a /token value that is not a decodable JWT - refusing to cache the session; re-run \`cotal login\` after fixing the IdP`);
  }
  const sub = claims.sub;
  if (typeof sub !== "string" || !sub)
    throw new Error(`idp login: ${normalizeIdpUrl(opts.idpUrl)} minted a user JWT without a sub - refusing to cache the session; re-run \`cotal login\` after fixing the IdP`);
  assertLoginPins(claims, opts.expectedPins);
  session.sub = sub; // proven above — cached so owner derivation (spawn paths) stays offline
  const label = [claims.email, claims.name, claims.preferred_username].find(
    (c): c is string => typeof c === "string" && c.length > 0,
  );
  const at = typeof claims.email === "string" ? claims.email.lastIndexOf("@") : -1;
  const local = at > 0 ? (claims.email as string).slice(0, at) : undefined;
  const handle = [claims.preferred_username, local, claims.name].find(
    (c): c is string => typeof c === "string" && chatNameProblem(c) === undefined,
  );
  if (label) session.label = label;
  if (handle) session.name = handle;
  throwIfCancelled(opts.signal);
  const candidate: StagedIdpSession = Object.freeze({ sub,
    ...(typeof claims.iss === "string" ? { issuer: claims.iss } : {}),
    ...(typeof claims.aud === "string" ? { audience: claims.aud } : Array.isArray(claims.aud) && claims.aud.every(a => typeof a === "string") ? { audience: Object.freeze([...claims.aud]) } : {}),
  });
  stagedLogins.set(candidate, { opts, session, claims, previousSub, baseline, link: "response" in tokenResult ? tokenResult.response.headers.get("link") : null });
  return candidate;
}

function stagedState(candidate: StagedIdpSession): StagedLoginState {
  const state = stagedLogins.get(candidate);
  if (!state) throw new Error("idp login: unknown or already committed staged login");
  return state;
}

/** Fetch a fresh candidate catalog without caching it or applying registrations. */
export async function fetchStagedIdpSpaceCatalog(candidate: StagedIdpSession, validate: (snapshot: unknown, account: AuthSpaceCatalogAccount) => void): Promise<{ snapshot: unknown; account: AuthSpaceCatalogAccount }> {
  const { opts, session, claims, link } = stagedState(candidate);
  if (session.mode === "oidc") throw new Error("OIDC sign-in does not support the Better Auth space catalog");
  throwIfCancelled(opts.signal);
  const idpUrl = normalizeIdpUrl(opts.idpUrl);
  const catalogUrl = catalogUrlFromLink(idpUrl, link);
  if (!catalogUrl) throw new Error("idp login: the approved provider did not advertise a same-origin catalog");
  if (typeof claims.iss !== "string" || !claims.iss) throw new Error("idp login: the approved provider did not supply an issuer");
  const account = { idpUrl, issuer: claims.iss, sub: candidate.sub, ownerKey: ownerKey(idpUrl, candidate.sub), catalogUrl };
  const response = await idpFetch(catalogUrl, { headers: { authorization: `Bearer ${session.token}` }, redirect: "manual" }, opts.signal);
  if (!response.ok) throw new Error(`idp login: candidate catalog failed (HTTP ${response.status})`);
  const snapshot = await idpJson<unknown>(catalogUrl, response, opts.signal);
  validate(snapshot, account);
  throwIfCancelled(opts.signal);
  return { snapshot, account };
}

/** Persist a staged proof after the caller has checked its migration pins. Not a multi-file transaction. */
export function commitStagedIdpSession(candidate: StagedIdpSession): { session: IdpSession; sub: string; previousSub?: string; label?: string } {
  return withIdpSessionLock(stagedState(candidate).opts.dir, () => commitStagedLoginLocked(candidate));
}

function commitStagedLoginLocked(candidate: StagedIdpSession): { session: IdpSession; sub: string; previousSub?: string; label?: string } {
  const { opts, session, claims, previousSub, baseline, link } = stagedState(candidate);
  // The persistence fence: a cancel that lands after approval, while the proof was in flight,
  // must leave no session and no catalog entry on disk.
  throwIfCancelled(opts.signal);
  assertLoginPins(claims, opts.expectedPins);
  // Approval can take minutes. Recheck before writing if another process changed the cache.
  const current = readCatalogPreparationState(opts.dir);
  const currentSession = current.sessions[normalizeIdpUrl(opts.idpUrl)];
  if (currentSession && (currentSession.mode === "oidc") !== Boolean(opts.oidc))
    throw new IdpConfigurationError("another sign-in changed this provider's mode during approval; nothing was saved");
  if (opts.migrationFrom !== undefined && migrationDependency(current, opts.migrationFrom) !== baseline)
    throw new Error("idp login: the old account sign-in or catalog state changed during approval; nothing was saved; retry `cotal login --migrate-from " + normalizeIdpUrl(opts.migrationFrom) + "`");
  stagedLogins.delete(candidate);
  saveIdpSessionLocked(opts.dir, opts.idpUrl, session);
  if (session.mode !== "oidc") saveCatalogAdvertisement(opts.dir, opts.idpUrl, claims.iss, candidate.sub, link);
  return { session, sub: candidate.sub, ...(previousSub && previousSub !== candidate.sub ? { previousSub } : {}), ...(session.label ? { label: session.label } : {}) };
}

type EstablishOpts = DeviceLoginOpts & { dir: string; expectedPins?: IdpLoginPins };
type EstablishedSession<S extends IdpSession = IdpSession> = { session: S; sub: string; previousSub?: string; label?: string };

/** Approve device sign-in, prove the session can supply a user JWT, then persist the session. */
export function establishIdpSession(opts: EstablishOpts & { oidc?: false }): Promise<EstablishedSession<BetterAuthSession>>;
export function establishIdpSession(opts: EstablishOpts): Promise<EstablishedSession>;
export async function establishIdpSession(opts: EstablishOpts): Promise<EstablishedSession> {
  const candidate = await stageIdpSession(opts);
  return opts.oidc ? withAsyncSessionLock(opts.dir, () => commitStagedLoginLocked(candidate)) : commitStagedIdpSession(candidate);
}

function ownerKey(idpUrl: string, sub: string): string {
  return createHash("sha256").update(`${new URL(idpUrl).origin}\0${sub}`).digest("hex");
}

function readCatalogsFile(dir: string): CatalogsFile {
  const path = join(dir, CATALOG_FILE);
  if (!existsSync(path)) return { ver: CATALOG_VER, accounts: {} };
  let parsed: CatalogsFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as CatalogsFile;
  } catch (e) {
    throw new Error(`${path}: the space catalog cache is not valid JSON (${e instanceof Error ? e.message : String(e)}) - delete it and run \`cotal sync\``);
  }
  if (parsed?.ver !== CATALOG_VER || parsed.accounts === null || typeof parsed.accounts !== "object" || Array.isArray(parsed.accounts))
    throw new Error(`${path}: malformed or unsupported space catalog cache`);
  return parsed;
}

function writeCatalogsFile(dir: string, file: CatalogsFile): void {
  mkSecretDir(dir);
  writeSecretFileAtomic(join(dir, CATALOG_FILE), JSON.stringify(file, null, 2));
}

function catalogUrlFromLink(idpUrl: string, link: string | null): string | undefined {
  if (!link) return undefined;
  const base = normalizeIdpUrl(idpUrl);
  const origin = new URL(base).origin;
  for (const value of link.split(/,\s*(?=<)/)) {
    const match = value.match(/^\s*<([^>]+)>\s*((?:;[^,]*)*)$/);
    if (!match) continue;
    const rel = [...match[2].matchAll(/;\s*rel\s*=\s*(?:"([^"]*)"|([^;\s]+))/gi)][0];
    const rels = (rel?.[1] ?? rel?.[2] ?? "").split(/\s+/);
    if (!rels.includes(SPACE_CATALOG_REL)) continue;
    let url: URL;
    try {
      url = new URL(match[1], `${base}/token`);
    } catch {
      return undefined;
    }
    if (url.origin !== origin || !isCredentialTransportUrl(url) || url.username || url.password)
      return undefined;
    return url.toString();
  }
  return undefined;
}

function saveCatalogAdvertisement(dir: string, idpUrl: string, issuer: unknown, sub: string, link: string | null): void {
  const normalized = normalizeIdpUrl(idpUrl);
  const key = ownerKey(normalized, sub);
  const file = readCatalogsFile(dir);
  const catalogUrl = catalogUrlFromLink(normalized, link);
  file.accounts[key] = {
    idpUrl: normalized,
    issuer: typeof issuer === "string" && issuer ? issuer : new URL(normalized).origin,
    sub,
    ownerKey: key,
    advertised: true,
    advertisementCheckedAt: new Date().toISOString(),
    ...(catalogUrl ? { catalogUrl } : {}),
  };
  writeCatalogsFile(dir, file);
}

function accountView(state: CatalogAccountState): AuthSpaceCatalogAccount {
  return {
    idpUrl: state.idpUrl,
    issuer: state.issuer,
    sub: state.sub,
    ownerKey: state.ownerKey,
    ...(state.catalogUrl ? { catalogUrl: state.catalogUrl } : {}),
  };
}

function fresh(state: CatalogAccountState): boolean {
  return typeof state.fetchedAt === "string" && Date.now() - Date.parse(state.fetchedAt) < CATALOG_FRESH_MS;
}

async function discoverAdvertisement(state: CatalogAccountState, session: BetterAuthSession): Promise<CatalogAccountState> {
  const result = await fetchIdpJwtResponse(state.idpUrl, session.token);
  const claims = decodeJwt(result.jwt);
  if (claims.sub !== state.sub)
    throw new Error(`idp session: ${state.idpUrl} proved a different subject than the cached session - run \`${loginRecoveryCommand(state.idpUrl)}\` again`);
  const catalogUrl = catalogUrlFromLink(state.idpUrl, result.response.headers.get("link"));
  return {
    ...state,
    issuer: typeof claims.iss === "string" && claims.iss ? claims.iss : state.issuer,
    advertised: true,
    advertisementCheckedAt: new Date().toISOString(),
    ...(catalogUrl ? { catalogUrl } : { catalogUrl: undefined }),
  };
}

/** Retained account identities, including signed-out holders. No session proofs are returned. */
export function knownMachineAccounts(dir: string): AuthSpaceCatalogAccount[] {
  return Object.values(readCatalogsFile(dir).accounts).map(accountView);
}

/** Accounts using the provider's machine API, which requires a Better Auth session bearer. */
export function signedInMachineAccounts(dir: string): AuthSpaceCatalogAccount[] {
  const { sessions, file } = readCatalogPreparationState(dir);
  return Object.keys(sessions).sort().flatMap((idpUrl) => {
    const session = loadIdpSession(dir, idpUrl);
    if (!session?.sub || session.mode === "oidc") return [];
    const key = ownerKey(idpUrl, session.sub);
    return [accountView(file.accounts[key] ?? { idpUrl, issuer: new URL(idpUrl).origin, sub: session.sub, ownerKey: key, advertised: false })];
  });
}

/** Call only the account-computer routes on the signed-in provider's origin. */
export async function requestAccountMachine(opts: {
  dir: string; idpUrl: string; machineId: string; method: "PUT" | "GET";
  metadata?: { name: string; platform: "linux" | "darwin" | "win32"; daemonVersion: string; managers: readonly { spaceId: string; instanceId: string }[]; vitals?: { sampledAt: string; cpu: { logicalCount: number; utilisationPercent: number; intervalMs: number; load1?: number; load5?: number; load15?: number }; memory: { totalBytes: number; availableBytes: number }; filesystems: Array<{ mount: string; totalBytes: number; freeBytes: number }>; uptimeSeconds: number } };
  etag?: string; signal?: AbortSignal;
  intent?: { spaceId: string; enabled: boolean; expectedRevision: number };
}): Promise<{ status: number; etag?: string; body?: unknown }> {
  const idp = normalizeIdpUrl(opts.idpUrl);
  if (!/^[0-9a-f-]{36}$/.test(opts.machineId)) throw new Error("invalid computer identity");
  const session = requireIdpSession(opts.dir, idp);
  if (opts.intent && (opts.method !== "PUT" || !/^[A-Za-z0-9_-]{1,128}$/.test(opts.intent.spaceId) || !Number.isSafeInteger(opts.intent.expectedRevision) || opts.intent.expectedRevision < 0)) throw new Error("invalid computer space intent");
  const url = opts.intent
    ? `${new URL(idp).origin}/api/machines/${opts.machineId}/spaces/${encodeURIComponent(opts.intent.spaceId)}`
    : `${new URL(idp).origin}/api/cli/machines/${opts.machineId}${opts.method === "GET" ? "/spaces" : ""}`;
  const headers: Record<string, string> = { authorization: `Bearer ${betterAuthSessionToken(session)}` };
  if (opts.etag) headers["if-none-match"] = opts.etag;
  if (opts.method === "PUT") headers["content-type"] = "application/json";
  const body = opts.method === "PUT" ? JSON.stringify(opts.intent ? { enabled: opts.intent.enabled, expectedRevision: opts.intent.expectedRevision } : opts.metadata) : undefined;
  if (body !== undefined && Buffer.byteLength(body, "utf8") > 16384) throw new Error("invalid computer registration exceeds 16384 bytes");
  const response = await idpFetch(url, { method: opts.method, headers, redirect: "manual", ...(opts.method === "PUT" ? { body } : {}) }, opts.signal);
  const etag = response.headers.get("etag");
  return { status: response.status, ...(etag ? { etag } : {}), ...(response.ok ? { body: await idpJson<unknown>(url, response, opts.signal) } : {}) };
}

interface PrepareCatalogOpts {
  dir: string;
  idpUrl?: string;
  force?: boolean;
  validate(snapshot: unknown, account: AuthSpaceCatalogAccount): void;
  apply(result: AuthSpaceCatalogResult): void;
}

function readCatalogPreparationState(dir: string) {
  let sessions: SessionsFile["sessions"];
  let file: CatalogsFile;
  try { sessions = readSessionsFile(dir).sessions; }
  catch {
    throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the local sign-in cache (idp-sessions.json) could not be read; no catalog refresh or registry application was attempted", {
      target: { path: join(dir, SESSIONS_FILE) }, remedy: "inspect and restore the sign-in cache before retrying; its contents were not printed or replaced",
    });
  }
  try { file = readCatalogsFile(dir); }
  catch {
    throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the local space catalog cache (space-catalogs.json) could not be read; no catalog refresh or registry application was attempted", {
      target: { path: join(dir, CATALOG_FILE) }, remedy: "inspect and restore the catalog cache before retrying; its contents were not printed or replaced",
    });
  }
  return { sessions, file };
}

/** Only the retained account supplies migration authority. Refresh timing is not authority. */
function migrationDependency(state: ReturnType<typeof readCatalogPreparationState>, from: string): string {
  const idpUrl = normalizeIdpUrl(from);
  const session = state.sessions[idpUrl];
  const account = session?.sub ? state.file.accounts[ownerKey(idpUrl, session.sub)] : undefined;
  const catalog = account ? { ...account } : undefined;
  if (catalog) delete catalog.fetchedAt;
  return JSON.stringify({ session, catalog });
}

const catalogPreparations = new Map<string, Promise<AuthSpaceCatalogResult[]>>();

export function prepareIdpSpaceCatalogs(opts: PrepareCatalogOpts): Promise<AuthSpaceCatalogResult[]> {
  const key = `${opts.dir}\0${opts.idpUrl ? normalizeIdpUrl(opts.idpUrl) : "*"}`;
  const active = catalogPreparations.get(key);
  if (active) return active;
  const work = prepareIdpSpaceCatalogsLocked(opts).finally(() => catalogPreparations.delete(key));
  catalogPreparations.set(key, work);
  return work;
}

async function prepareIdpSpaceCatalogsLocked(opts: PrepareCatalogOpts): Promise<AuthSpaceCatalogResult[]> {
  const requested = opts.idpUrl ? normalizeIdpUrl(opts.idpUrl) : undefined;
  // No account means no catalog work. Do not create a control directory just to lock an empty
  // observation. Active accounts are read again under the lock before any refresh or application.
  const initial = readCatalogPreparationState(opts.dir);
  const signedOut = () => new CommandFailure("refused", "AUTH_REQUIRED", "the requested IdP has no cached sign-in; no catalog refresh or registry application was attempted", {
    target: { idp: requested }, remedy: `run \`${loginRecoveryCommand(requested!)}\` before syncing this account`,
  });
  if (!Object.keys(initial.sessions).some((idp) => !requested || idp === requested)) {
    if (requested) throw signedOut();
    return [];
  }
  const lock = acquireLock(join(opts.dir, CATALOG_LOCK), { label: "space catalog sync", waitMs: 30_000 });
  try {
    const current = readCatalogPreparationState(opts.dir);
    const sessions = current.sessions;
    let file = current.file;
    const idps = Object.keys(sessions).filter((idp) => !requested || idp === requested).sort();
    if (requested && idps.length === 0) throw signedOut();
    const results: AuthSpaceCatalogResult[] = [];
    let changed = false;
    for (const idpUrl of idps) {
      let session = loadIdpSession(opts.dir, idpUrl)!;
      if (session.mode === "oidc") {
        results.push({ account: accountView({ idpUrl, issuer: session.issuer, sub: session.sub, ownerKey: ownerKey(idpUrl, session.sub), advertised: false }), state: "no-catalog" });
        continue;
      }
      if (!session.sub) {
        const tokenResult = await fetchIdpJwtResponse(idpUrl, session.token);
        const claims = decodeJwt(tokenResult.jwt);
        if (typeof claims.sub !== "string" || !claims.sub)
          throw new Error(`idp session: ${idpUrl} minted a user JWT without a sub - run \`${loginRecoveryCommand(idpUrl)}\` again`);
        session = { ...session, sub: claims.sub };
        saveIdpSession(opts.dir, idpUrl, session);
        saveCatalogAdvertisement(opts.dir, idpUrl, claims.iss, claims.sub, tokenResult.response.headers.get("link"));
        file = readCatalogsFile(opts.dir);
      }
      const sub = session.sub;
      if (!sub) throw new Error(`idp session: ${idpUrl} has no proved subject`);
      const key = ownerKey(idpUrl, sub);
      let state = file.accounts[key] ?? {
        idpUrl,
        issuer: new URL(idpUrl).origin,
        sub,
        ownerKey: key,
        advertised: false,
      };
      try {
        const advertisementFresh = typeof state.advertisementCheckedAt === "string" && Date.now() - Date.parse(state.advertisementCheckedAt) < CATALOG_FRESH_MS;
        if (!state.advertised || (!state.catalogUrl && (opts.force || !advertisementFresh))) {
          state = await discoverAdvertisement(state, session);
          file.accounts[key] = state;
          changed = true;
        }
        const catalogUrl = state.catalogUrl;
        if (!catalogUrl) {
          if (state.failing) {
            state = { ...state, failing: undefined };
            file.accounts[key] = state;
            changed = true;
          }
          results.push({ account: accountView(state), state: "no-catalog", ...(state.snapshot !== undefined ? { snapshot: state.snapshot } : {}) });
          continue;
        }
        // A cached snapshot whose application never finished (the applying process died or is
        // paused; this process holds the lock, so it is not running) is applied again before any
        // freshness or conditional answer can present it as complete.
        if (state.snapshot !== undefined && !state.applied) {
          const result: AuthSpaceCatalogResult = { account: accountView(state), state: "updated", snapshot: state.snapshot, fetchedAt: state.fetchedAt };
          opts.apply(result);
          state = { ...state, applied: true };
          file.accounts[key] = state;
          changed = true;
          if (!opts.force && fresh(state)) {
            results.push(result);
            continue;
          }
        }
        if (!opts.force && fresh(state)) {
          results.push({ account: accountView(state), state: "fresh", snapshot: state.snapshot, fetchedAt: state.fetchedAt });
          continue;
        }
        const headers: Record<string, string> = { authorization: `Bearer ${session.token}` };
        if (state.etag) headers["if-none-match"] = state.etag;
        const response = await idpFetch(catalogUrl, { headers, redirect: "manual" });
        if (response.status === 304) {
          if (state.snapshot === undefined) throw new Error("the catalog returned 304 before this machine had a snapshot");
          state = { ...state, fetchedAt: new Date().toISOString(), failing: undefined };
          file.accounts[key] = state;
          changed = true;
          const result: AuthSpaceCatalogResult = { account: accountView(state), state: "not-modified", snapshot: state.snapshot, fetchedAt: state.fetchedAt };
          opts.apply(result);
          results.push(result);
          continue;
        }
        if (response.status === 401)
          throw new IdpSessionRejectedError(`idp session: ${idpUrl} rejected the cached session (expired or revoked) - ${serviceLoginRecovery(idpUrl, opts.dir)}`);
        if (!response.ok) throw new Error(`${catalogUrl} failed (HTTP ${response.status})`);
        const snapshot = await idpJson<unknown>(catalogUrl, response);
        opts.validate(snapshot, accountView(state));
        state = {
          ...state,
          snapshot,
          fetchedAt: new Date().toISOString(),
          ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : { etag: undefined }),
          applied: false,
          failing: undefined,
        };
        // Commit the candidate as NOT applied before the first registry write. A death anywhere in
        // the application leaves a cache that names the snapshot and says it is incomplete.
        file.accounts[key] = state;
        writeCatalogsFile(opts.dir, file);
        changed = false;
        const result: AuthSpaceCatalogResult = { account: accountView(state), state: "updated", snapshot, fetchedAt: state.fetchedAt };
        opts.apply(result);
        state = { ...state, applied: true };
        file.accounts[key] = state;
        changed = true;
        results.push(result);
      } catch (e) {
        const ongoing = state.failing === true;
        if (!ongoing) {
          state = { ...state, failing: true };
          file.accounts[key] = state;
          changed = true;
        }
        const result: AuthSpaceCatalogResult = {
          account: accountView(state),
          state: "failed",
          ...(state.snapshot !== undefined ? { snapshot: state.snapshot } : {}),
          ...(state.fetchedAt ? { fetchedAt: state.fetchedAt } : {}),
          error: e instanceof Error ? e.message : String(e),
          ...(ongoing ? { ongoing: true } : {}),
        };
        opts.apply(result);
        results.push(result);
      }
    }
    if (changed) writeCatalogsFile(opts.dir, file);
    return results;
  } finally {
    lock.release();
  }
}

export function deleteIdpSpaceCatalog(dir: string, idpUrl: string, sub: string): string {
  const file = readCatalogsFile(dir);
  const key = ownerKey(normalizeIdpUrl(idpUrl), sub);
  if (key in file.accounts) {
    delete file.accounts[key];
    writeCatalogsFile(dir, file);
  }
  return key;
}

export function hasIdpSpaceCatalog(dir: string, idpUrl: string, sub: string): boolean {
  return Boolean(readCatalogsFile(dir).accounts[ownerKey(normalizeIdpUrl(idpUrl), sub)]?.catalogUrl);
}

/** Revoke the session server-side (sign out). A 401 back means the session is already dead —
 *  the goal state, treated as success; any other failure is thrown because a still-live
 *  server-side session is a real leak the operator must hear about. */
export async function revokeIdpSession(idpUrl: string, sessionToken: string): Promise<void> {
  const base = normalizeIdpUrl(idpUrl);
  jwtCache.forget(`${base}\0${sessionToken}`); // this process stops minting from it now, not within the hold
  const res = await idpFetch(`${base}/sign-out`, {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok && res.status !== 401)
    throw new Error(`idp logout: ${base}/sign-out failed (HTTP ${res.status}) - the server-side session may still be alive`);
}

/** Revoke the latest rotating token and remove the same sign-in, under one cache lock. */
export async function clearOidcSession(dir: string, session: OidcSession, local: boolean): Promise<void> {
  await withAsyncSessionLock(dir, async () => {
    const current = loadIdpSession(dir, session.issuer);
    if (current?.mode !== "oidc" || current.id !== session.id)
      throw new CommandFailure("refused", "CONFLICT", "the cached OIDC sign-in changed before sign-out; nothing was revoked or cleared");
    if (!local) {
      if (!current.revocationEndpoint) throw new CommandFailure("refused", "UNSUPPORTED", "this OIDC provider did not advertise a revocation endpoint; the cached sign-in was kept", { remedy: "revoke the sign-in at the provider, then run `cotal logout --local` for this provider" });
      try {
        const res = await oidcFetch(current.revocationEndpoint, undefined, {
          token: current.refreshToken, token_type_hint: "refresh_token", client_id: current.clientId,
        });
        await res.body?.cancel();
        if (res.status !== 200) throw new Error(`OIDC revocation answered HTTP ${res.status}`);
      } catch {
        throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "OIDC revocation was not confirmed; the cached sign-in was kept", { remedy: "retry logout for this provider, revoke the sign-in at the provider, or use `cotal logout --local`" });
      }
    }
    oidcJwtCache.forget(oidcCacheKey(dir, current));
    try { deleteIdpSessionLocked(dir, current.issuer); }
    catch {
      if (local) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the cached OIDC sign-in could not be confirmed cleared; the provider was not contacted");
      throw new CommandFailure("partial", "OPERATION_PARTIAL", "the OIDC provider confirmed revocation, but local sign-in removal was not confirmed");
    }
  });
}

// ---- the machine-local session cache ----
// Explicit-dir APIs like the workspace auth-path helpers: the caller (the `login` command) picks
// the directory (`homeCotalDir()`); nothing here discovers paths ambiently. One file, all IdPs,
// keyed by normalized base URL; 0700 dir / 0600 file via core's secret-file helpers.

const SESSIONS_FILE = "idp-sessions.json";
const SESSIONS_VER = 1;

interface SessionsFile {
  ver: number;
  sessions: Record<string, IdpSession>;
}

function readSessionsFile(dir: string): SessionsFile {
  const f = join(dir, SESSIONS_FILE);
  // A torn write or a hand-edit must not reach requireIdpSession (the no-fallback gate) as a raw
  // "SyntaxError: Unexpected token" — say what's wrong and how to recover, like everywhere else.
  let parsed: SessionsFile;
  try {
    parsed = JSON.parse(readFileSync(f, "utf8")) as SessionsFile;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ver: SESSIONS_VER, sessions: {} };
    throw new Error(`${f}: the session cache is not valid JSON (${e instanceof Error ? e.message : String(e)}) - delete it and run \`cotal login\` again`);
  }
  if (parsed === null || typeof parsed !== "object")
    throw new Error(`${f}: the session cache is not a JSON object - delete it and run \`cotal login\` again`);
  if (parsed.ver !== SESSIONS_VER)
    throw new Error(`${f}: unknown version ${String(parsed.ver)} (expected ${SESSIONS_VER}) - refusing to guess at a credential file`);
  if (parsed.sessions === null || typeof parsed.sessions !== "object" || Array.isArray(parsed.sessions))
    throw new Error(`${f}: malformed sessions map`);
  for (const [idp, session] of Object.entries(parsed.sessions)) {
    if (normalizeIdpUrl(idp) !== idp || !session || typeof session !== "object" || Array.isArray(session))
      throw new Error(`${f}: malformed session record`);
    if (session.mode === "oidc") {
      const { id, sub, issuer, clientId, tokenEndpoint, jwksUri, revocationEndpoint, refreshToken } = session;
      if (session.token !== undefined || session.expiresAt !== undefined || !text(id) || !text(sub) || !text(issuer) || normalizeOidcIssuer(issuer) !== idp
        || !validOidcClientId(clientId) || !opaqueRefreshToken(refreshToken)
        || oidcEndpoint(tokenEndpoint, "token_endpoint") !== tokenEndpoint || oidcEndpoint(jwksUri, "jwks_uri") !== jwksUri
        || (revocationEndpoint !== undefined && oidcEndpoint(revocationEndpoint, "revocation_endpoint") !== revocationEndpoint))
        throw new Error(`${f}: malformed OIDC session record`);
    } else if (session.mode !== undefined || typeof session.token !== "string" || !session.token || typeof session.expiresAt !== "number" || !Number.isFinite(session.expiresAt)) {
      throw new Error(`${f}: malformed session record`);
    }
  }
  return parsed;
}

/** Account-picker metadata only. Session tokens never leave this helper. */
export function listIdpAccounts(dir: string): { idp: string; sub?: string; expiresAt?: number }[] {
  return Object.entries(readSessionsFile(dir).sessions).map(([idp, session]) => {
    return { idp, ...(session.mode !== "oidc" ? { expiresAt: session.expiresAt } : {}), ...(typeof session.sub === "string" ? { sub: session.sub } : {}) };
  });
}

export function loadIdpSession(dir: string, idpUrl: string): IdpSession | undefined {
  const key = normalizeIdpUrl(idpUrl);
  const s = readSessionsFile(dir).sessions[key];
  if (s === undefined) return undefined;
  if (s.mode === "oidc") {
    const { id, issuer, clientId, tokenEndpoint, jwksUri, revocationEndpoint, refreshToken, sub } = s;
    return { mode: "oidc", id, issuer, clientId, tokenEndpoint, jwksUri, ...(revocationEndpoint !== undefined ? { revocationEndpoint } : {}), refreshToken, sub,
      ...(typeof s.label === "string" && s.label ? { label: s.label } : {}), ...(typeof s.name === "string" && s.name ? { name: s.name } : {}) };
  }
  // `sub` rides the cache round-trip (offline owner derivation for the spawn paths) — every
  // consumer of ownerForLogin is a SEPARATE process re-reading this file, so dropping it here
  // broke both user-mode spawn entry points while every in-process test passed.
  return {
    token: s.token,
    expiresAt: s.expiresAt,
    ...(typeof s.sub === "string" && s.sub ? { sub: s.sub } : {}),
    ...(typeof s.label === "string" && s.label ? { label: s.label } : {}),
    ...(typeof s.name === "string" && s.name ? { name: s.name } : {}),
  };
}

/** Whether this machine carries any cached human login. Enrollment URLs are single-use credentials,
 *  so an unregistered-mesh client must resolve the login-vs-enrollment conflict before it GETs the
 *  URL and learns which IdP the response names. */
export function hasIdpSessions(dir: string): boolean {
  return Object.keys(readSessionsFile(dir).sessions).length > 0;
}

const sessionLocks = new Set<string>();

async function withAsyncSessionLock<T>(dir: string, run: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfCancelled(signal);
  const path = resolve(dir, "idp-sessions.lock");
  mkSecretDir(dir);
  // The holder runs at most one timed provider request. Match that budget instead of rejecting
  // normal contention early, but leave a stalled or sustained queue before it can wait forever.
  const lock = await acquireLockAsync(path, {
    label: "IdP session cache", waitMs: idpTimeoutMs(), signal,
    onTimeout: () => new IdpUnreachableError("the OIDC session cache is busy; retry after the current provider request finishes"),
  }).catch((error: unknown) => { throwIfCancelled(signal); throw error; });
  try { return await run(); }
  finally { lock.release(); }
}

/** Serialize a read-modify-write of one session cache, including service-store propagation. */
export function withIdpSessionLock<T>(dir: string, run: () => T): T {
  const path = resolve(dir, "idp-sessions.lock");
  if (sessionLocks.has(path)) return run();
  // An asynchronous refresh in this process cannot finish if a synchronous writer blocks its loop.
  if (liveLockOwnerPid(path) === process.pid) throw new Error("IdP session cache is busy in this process; retry after the current request finishes");
  mkSecretDir(dir);
  const lock = acquireLock(path, { label: "IdP session cache", waitMs: 5000 });
  sessionLocks.add(path);
  try { return run(); }
  finally { sessionLocks.delete(path); lock.release(); }
}

export function saveIdpSession(dir: string, idpUrl: string, session: IdpSession): void {
  withIdpSessionLock(dir, () => saveIdpSessionLocked(dir, idpUrl, session));
}

function saveIdpSessionLocked(dir: string, idpUrl: string, session: IdpSession): void {
  const file = readSessionsFile(dir);
  file.sessions[normalizeIdpUrl(idpUrl)] = session.mode === "oidc" ? session : {
    token: session.token,
    expiresAt: session.expiresAt,
    ...(session.sub ? { sub: session.sub } : {}),
    ...(session.label ? { label: session.label } : {}),
    ...(session.name ? { name: session.name } : {}),
  };
  mkSecretDir(dir); // harden the dir BEFORE the secret lands (0700 POSIX, private ACL win32)
  writeSecretFileAtomic(join(dir, SESSIONS_FILE), JSON.stringify(file, null, 2));
}

/** Remove the cached session. Returns false when there was nothing to remove. */
export function deleteIdpSession(dir: string, idpUrl: string): boolean {
  if (!existsSync(join(dir, SESSIONS_FILE))) return false;
  return withIdpSessionLock(dir, () => deleteIdpSessionLocked(dir, idpUrl));
}

function deleteIdpSessionLocked(dir: string, idpUrl: string): boolean {
  const key = normalizeIdpUrl(idpUrl);
  const file = readSessionsFile(dir);
  if (!(key in file.sessions)) return false;
  delete file.sessions[key];
  mkSecretDir(dir);
  writeSecretFileAtomic(join(dir, SESSIONS_FILE), JSON.stringify(file, null, 2));
  return true;
}

/** The no-fallback gate the user-mode connect path consumes: a session or a thrown sentence that
 *  says exactly how to get one. There is no anonymous degradation when a space requires a user. */
export function requireIdpSession(dir: string, idpUrl: string): IdpSession {
  const key = normalizeIdpUrl(idpUrl);
  const s = loadIdpSession(dir, key);
  if (!s)
    throw credentialFailure(
      "signed-out",
      `not logged in to ${key} - this space requires a user identity and there is no anonymous fallback; ${serviceLoginRecovery(key, dir)}`,
    );
  return s;
}
