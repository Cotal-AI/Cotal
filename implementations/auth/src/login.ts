/**
 * `cotal login` client — device-authorization sign-in (RFC 8628) plus the machine-local IdP
 * session cache (plan §"How it lands in today's code" → Client).
 *
 * Flow: ask the IdP for a device code, show the human a verification URL + user code, poll until
 * sign-in is approved. Persist only the opaque Better Auth session or OIDC refresh credential.
 * The short-lived IdP JWT is read from Better Auth's `/token` or obtained by OIDC token exchange
 * and held in memory for at most {@link JWT_CACHE_CAP_MS} (and never past
 * its own `exp` minus a margin), one entry per (IdP, session), concurrent callers sharing one
 * request. Persisting the JWT would let a revoked session keep minting mesh access until the JWT
 * expired; the bounded in-process hold means revocation at the IdP bites within a minute, and a
 * 401 surfaces as a legible "run `cotal login` again", never a silent hang. Without the hold, a
 * manager hosting dozens of runs posted one `/token` per authority call and tripped the IdP's
 * per-source rate limit, failing unrelated spawns and reads with a bare HTTP 429.
 *
 * Better Auth uses fixed endpoints and JSON bodies. Explicit OIDC mode uses discovery and form
 * bodies. A provider error never switches one mode to the other.
 *
 * The session key is the normalized provider URL. OIDC keeps the exact configured issuer for
 * discovery and token claims, and uses same-origin endpoints without following redirects.
 *
 * Every IdP request carries a hard per-request timeout ({@link idpFetch}) — Node's global fetch
 * has none, and the poll deadline is only checked between polls, so a hung IdP would otherwise
 * stall a login (or a non-interactive `requireIdpSession`→`fetchIdpJwt` on an agent connect)
 * forever. Override the 30s default with `COTAL_IDP_TIMEOUT_MS` for a slow IdP.
 */
import { idpSessionDir } from "./session-context.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { isCredentialTransportUrl, mkSecretDir, writeSecretFileAtomic, type AuthSpaceCatalogAccount, type AuthSpaceCatalogResult } from "@cotal-ai/core";
import { loginRecoveryCommand, serviceLoginRecovery, CommandFailure, acquireLock, acquireLockAsync, chatNameProblem, credentialFailure, checkIdpUrl } from "@cotal-ai/workspace";

interface IdpSessionAccount {
  expiresAt: number;
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

type OidcLogin = { issuer: string; clientId: string; audience: string; loginId: string; refreshToken: string };

/** A cached login. `expiresAt` is advisory (Unix seconds). For OIDC it describes the most recent
 *  access token. The refresh token is a separate field so older clients refuse the record instead
 *  of sending it as a Better Auth session to other services. */
export type IdpSession = IdpSessionAccount & ({ token: string; oidc?: never } | { oidc: OidcLogin; token?: never });

type BetterAuthSession = Extract<IdpSession, { token: string }>;

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
  /** Better Auth base URL or the exact configured OIDC issuer. */
  idpUrl: string;
  /** The OAuth client id this CLI presents; the IdP may pin it via its validateClient hook. */
  clientId: string;
  /** Explicit standards mode. No discovery or protocol fallback when absent. */
  oidc?: { audience: string };
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

/** An IdP request that got no answer: the transport failed or the per-request timeout fired. */
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
    // A JSON parser's diagnostic may quote the start of a malformed response containing tokens.
    throw new Error(`idp request to ${url} returned an unreadable response body`);
  }
}

/** Best-effort reachability + shape check of an IdP's JWKS. Used at the FIRST `--user-auth` enable
 *  so a dead or typo'd `--idp` fails loud BEFORE a space is provisioned around it, instead of only
 *  surfacing far away at the first user connect (the pin is written but the JWKS is fetched lazily).
 *  Normalizes the URL exactly as the pin does (`<base>/jwks`). Throws a legible sentence on an
 *  unreachable host, a redirect, a non-2xx, or a body that is not a JWKS key set. A redirect is
 *  refused because it could move the check onto another host or onto plaintext, away from the URL
 *  the space pins. */
export async function probeIdpJwks(idpUrl: string, explicitJwksUri?: string): Promise<void> {
  const jwksUri = explicitJwksUri ?? `${normalizeIdpUrl(idpUrl)}/jwks`;
  if (!checkIdpUrl(jwksUri).ok) throw new Error("the pinned JWKS URL is invalid");
  const remedy = explicitJwksUri ? "Check --idp-jwks-uri." : "Check --idp <auth base URL>; it must serve <base>/jwks itself.";
  const res = await idpFetch(jwksUri, { redirect: "manual" });
  if (res.status >= 300 && res.status < 400)
    throw new Error(`the IdP at ${idpUrl} answered ${jwksUri} with HTTP ${res.status}, a redirect; redirects are refused, so its target was not fetched. ${remedy}`);
  if (!res.ok)
    throw new Error(`the IdP at ${idpUrl} did not serve a JWKS: ${jwksUri} returned HTTP ${res.status}. ${remedy}`);
  const body = await idpJson<{ keys?: unknown } | null>(jwksUri, res);
  if (!Array.isArray(body?.keys))
    throw new Error(`the IdP at ${idpUrl} did not return a JWKS key set at ${jwksUri}. ${remedy}`);
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

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const ID_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token";
const sane = (v: unknown, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= max;

function oidcEndpoint(issuer: string, field: string, value: unknown): string {
  const checked = typeof value === "string" && checkIdpUrl(value);
  if (!checked || !checked.ok || checked.url.origin !== new URL(issuer).origin)
    throw new Error(`idp OIDC: ${field} must be a same-origin HTTPS URL (or HTTP on a loopback IP), without credentials, a query or a fragment`);
  return checked.url.href;
}

async function discoverOidc(issuer: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const url = `${normalizeIdpUrl(issuer)}/.well-known/openid-configuration`;
  const res = await idpFetch(url, { redirect: "manual" }, signal);
  if (!res.ok) throw new Error(`idp OIDC: discovery failed (HTTP ${res.status}); redirects are not followed`);
  const body = await idpJson<Record<string, unknown> | null>(url, res, signal);
  if (body?.issuer !== issuer) throw new Error("idp OIDC: discovery issuer does not match the configured issuer");
  return body;
}

function postOidc(url: string, fields: Record<string, string>, signal?: AbortSignal): Promise<Response> {
  return idpFetch(url, { method: "POST", redirect: "manual", body: new URLSearchParams(fields) }, signal);
}

function oidcGrant(body: { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown } | null) {
  if (typeof body?.access_token !== "string" || !body.access_token || !sane(body.expires_in, 31_536_000) ||
    (body.refresh_token !== undefined && (typeof body.refresh_token !== "string" || !body.refresh_token || looksLikeJwt(body.refresh_token))))
    throw new Error("idp OIDC: malformed access or opaque refresh token response");
  return { accessToken: body.access_token, expiresAt: Math.floor(Date.now() / 1000) + body.expires_in, refreshToken: body.refresh_token };
}

/** Sign in via the RFC 8628 device flow and return the IdP session. Fail-loud on every non-happy
 *  path: a deny, an expiry, or an unknown poll error is a thrown human sentence, never a retry
 *  loop. Blocks (polling at the server's stated interval) until the human approves. */
export function deviceLogin(opts: DeviceLoginOpts & { oidc?: undefined }): Promise<BetterAuthSession>;
export function deviceLogin(opts: DeviceLoginOpts): Promise<IdpSession>;
export async function deviceLogin(opts: DeviceLoginOpts): Promise<IdpSession> {
  return (await approveDeviceLogin(opts)).session;
}

async function approveDeviceLogin(opts: DeviceLoginOpts): Promise<{ session: IdpSession; oidcProof?: { accessToken: string; endpoint: string } }> {
  const base = normalizeIdpUrl(opts.idpUrl);
  if (opts.oidc && (!opts.clientId.trim() || !opts.oidc.audience.trim() || opts.migrationFrom !== undefined))
    throw new Error("idp OIDC: configure a non-empty client ID and audience without a native migration");
  const oidc = opts.oidc && { issuer: opts.idpUrl, clientId: opts.clientId, audience: opts.oidc.audience };
  const metadata = oidc && await discoverOidc(oidc.issuer, opts.signal);
  const codeUrl = metadata ? oidcEndpoint(base, "device_authorization_endpoint", metadata.device_authorization_endpoint) : `${base}/device/code`;
  const tokenUrl = metadata ? oidcEndpoint(base, "token_endpoint", metadata.token_endpoint) : `${base}/device/token`;
  const post = (url: string, fields: Record<string, string>) => oidc ? postOidc(url, fields, opts.signal) : idpFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fields),
  }, opts.signal);
  const res = await post(codeUrl, { client_id: opts.clientId, ...(oidc ? { scope: "openid offline_access" } : {}) });
  if (!res.ok) {
    const e = await oauthError(res, opts.signal);
    throw new IdpDeviceAuthorizationRefusedError(
      oidc ? `idp OIDC: device authorization failed (HTTP ${res.status}); redirects are not followed`
        : `idp login: ${base} refused the device authorization (${e.error ?? `HTTP ${res.status}`}: ${e.error_description ?? "no detail"})`,
    );
  }
  const grant = await idpJson<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  } | null>(codeUrl, res, opts.signal);
  // The WHOLE grant is shape-checked before anything is shown or polled — the timing fields
  // especially: a malicious IdP handing back `interval: "abc"` or a non-finite/absurd
  // `expires_in` would otherwise turn the poll loop into a tight (setTimeout coerces garbage to
  // ~1ms) or unbounded one. Bounds: a device code living past 24h or a poll interval past 5min
  // is not a sane grant — refuse, don't clamp.
  if (
    !grant ||
    typeof grant.device_code !== "string" || !grant.device_code ||
    typeof grant.user_code !== "string" || !grant.user_code ||
    typeof grant.verification_uri !== "string" || !grant.verification_uri ||
    ((!oidc || grant.verification_uri_complete !== undefined) && (typeof grant.verification_uri_complete !== "string" || !grant.verification_uri_complete)) ||
    !sane(grant.expires_in, 86_400) ||
    (grant.interval !== undefined && !sane(grant.interval, 300))
  )
    throw new Error(`idp login: ${base} returned a malformed device grant - refusing to poll on it`);
  const verificationUri = grant.verification_uri;
  const verificationUriComplete = grant.verification_uri_complete ?? verificationUri;
  if (oidc) for (const value of [verificationUri, verificationUriComplete]) {
    const url = URL.parse(value);
    if (!url || !isCredentialTransportUrl(url) || url.username || url.password)
      throw new Error("idp OIDC: invalid device verification URL");
  }
  const retry = opts.migrationFrom === undefined ? "cotal login" : `cotal login --migrate-from ${normalizeIdpUrl(opts.migrationFrom)}`;
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
    await sleepUnlessCancelled(intervalSec * 1000, opts.signal);
    if (Date.now() > deadline) throw new Error(expired);
    const poll = await post(tokenUrl, { grant_type: DEVICE_GRANT, device_code: grant.device_code, client_id: opts.clientId });
    if (oidc && poll.status >= 300 && poll.status < 400)
      throw new Error(`idp OIDC: device polling failed (HTTP ${poll.status}); redirects are not followed`);
    if (poll.ok) {
      const tok = await idpJson<{ access_token: string; expires_in: number; refresh_token?: unknown } | null>(tokenUrl, poll, opts.signal);
      if (oidc) {
        const { accessToken, expiresAt, refreshToken } = oidcGrant(tok);
        if (!refreshToken) throw new Error("idp OIDC: device approval did not issue a refresh token; allow offline_access for this client");
        return { session: { expiresAt, oidc: { ...oidc, refreshToken, loginId: randomUUID() } }, oidcProof: { accessToken, endpoint: tokenUrl } };
      }
      // Bound the session lifetime like the device grant's timing fields above (finite, positive,
      // not past a year). `expiresAt` is advisory only — the server is the revocation authority —
      // so this is a legibility/symmetry guard, not a security boundary: it refuses a hostile
      // `expires_in: 1e12` rather than caching it and printing "Session cached … until <year 33000>".
      if (typeof tok?.access_token !== "string" || !tok.access_token || !sane(tok.expires_in, 31_536_000))
        throw new Error(`idp login: ${base} returned a malformed token response`);
      // Defense-in-depth for the revocation model: we cache the OPAQUE session handle precisely so
      // that IdP revocation bites at the next /token fetch. A JWT outlives its session, so if a
      // misconfigured IdP hands one back as the device token, refuse rather than silently cache a
      // credential that can't be revoked.
      if (looksLikeJwt(tok.access_token))
        throw new Error(`idp login: ${base} returned a JWT as the device access token - the session token must be an opaque revocable handle, refusing to cache it; re-run \`cotal login\` after fixing the IdP`);
      return { session: { token: tok.access_token, expiresAt: Math.floor(Date.now() / 1000) + tok.expires_in } };
    }
    const e = await oauthError(poll, opts.signal);
    if (e.error === "authorization_pending") continue;
    if (e.error === "slow_down") {
      intervalSec += 5;
      continue;
    }
    if (e.error === "access_denied") throw new Error("idp login: the sign-in was denied at the verification page");
    if (e.error === "expired_token")
      throw new Error(`idp login: the device code expired before the sign-in was approved - run \`${retry}\` again`);
    throw new Error(
      oidc ? `idp OIDC: device polling failed (HTTP ${poll.status}); redirects are not followed`
        : `idp login: ${base} rejected the poll (${e.error ?? `HTTP ${poll.status}`}: ${e.error_description ?? "no detail"})`,
    );
  }
}

type IdpJwtResult = { jwt: string; link: string | null };

/** Longest an IdP JWT is reused from memory. The bound on how long a session revoked at the IdP
 *  can still mint mesh access from a process that already held a JWT. */
const JWT_CACHE_CAP_MS = 60_000;
/** A held JWT is dropped this long before its own `exp`, so a reuse never hands the bridge a
 *  token that expires in flight. */
const JWT_CACHE_MARGIN_MS = 30_000;
type JwtCacheEntry = { result: IdpJwtResult; until: number } | { inflight: Promise<IdpJwtResult> };
const jwtCache = new Map<string, JwtCacheEntry>();

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
async function cachedIdpProof(key: string, fetchProof: () => Promise<IdpJwtResult>, cancel?: AbortSignal): Promise<IdpJwtResult> {
  const now = Date.now();
  const hit = jwtCache.get(key);
  if (hit) {
    if ("inflight" in hit) {
      if (!cancel) return hit.inflight;
    } else if (hit.until > now) return hit.result;
    else jwtCache.delete(key);
  }
  const inflight = fetchProof().then(
    (result) => {
      for (const [k, e] of jwtCache) if ("until" in e && e.until <= Date.now()) jwtCache.delete(k);
      const until = jwtCacheUntil(result.jwt, Date.now());
      if (until > Date.now()) jwtCache.set(key, { result, until });
      else if (jwtCache.get(key) === entry) jwtCache.delete(key);
      return result;
    },
    (e: unknown) => {
      if (jwtCache.get(key) === entry) jwtCache.delete(key);
      throw e;
    },
  );
  const entry: JwtCacheEntry = { inflight };
  if (!cancel) jwtCache.set(key, entry);
  return inflight;
}

function fetchIdpJwtResponse(idpUrl: string, sessionToken: string, cancel?: AbortSignal): Promise<IdpJwtResult> {
  const base = normalizeIdpUrl(idpUrl);
  return cachedIdpProof(`${base}\0${sessionToken}`, () => fetchIdpJwtUncached(base, sessionToken, cancel), cancel);
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
    return { jwt: body.token, link: res.headers.get("link") };
  }
}

export async function fetchIdpJwt(idpUrl: string, sessionToken: string, signal?: AbortSignal): Promise<string> {
  return (await fetchIdpJwtResponse(idpUrl, sessionToken, signal)).jwt;
}

async function oidcTokenResponse(endpoint: string, fields: Record<string, string>, operation: string, rejected: string, signal?: AbortSignal) {
  const res = await postOidc(endpoint, fields, signal);
  if (!res.ok) {
    const { error } = await oauthError(res, signal);
    if (res.status === 401 || (res.status === 400 && error === "invalid_grant")) throw new IdpSessionRejectedError(rejected);
    // Provider error descriptions can echo credentials. Never relay one from the token endpoint.
    throw new Error(`idp OIDC: ${operation} failed (HTTP ${res.status}); redirects are not followed`);
  }
  return idpJson<Record<string, unknown> | null>(endpoint, res, signal);
}

async function exchangeOidcProof(oidc: OidcLogin, endpoint: string, accessToken: string, rejected: string, signal?: AbortSignal, sub?: string): Promise<IdpJwtResult> {
  const body = await oidcTokenResponse(endpoint, {
    grant_type: EXCHANGE_GRANT, client_id: oidc.clientId, audience: oidc.audience,
    subject_token: accessToken, subject_token_type: ACCESS_TOKEN_TYPE, requested_token_type: ID_TOKEN_TYPE,
  }, "token exchange", rejected, signal);
  const jwt = body?.access_token;
  if (body?.issued_token_type !== ID_TOKEN_TYPE || typeof jwt !== "string" || !looksLikeJwt(jwt))
    throw new Error("idp OIDC: token exchange did not issue an ID token");
  const claims = decodeJwt(jwt);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (decodeProtectedHeader(jwt).alg !== "EdDSA" || claims.iss !== oidc.issuer || aud.length !== 1 || aud[0] !== oidc.audience ||
    typeof claims.sub !== "string" || !claims.sub || (sub !== undefined && claims.sub !== sub) ||
    typeof claims.iat !== "number" || !Number.isFinite(claims.iat) || Object.hasOwn(claims, "purpose") ||
    typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now())
    throw new Error("idp OIDC: exchanged ID token does not match the required EdDSA algorithm, issuer, single audience, subject or expiry");
  return { jwt, link: null };
}

/** Read the selected store's session and obtain its bounded in-memory mesh proof. The store is
 *  explicit so rotation cannot write into the desktop's cache for a service login, or vice versa. */
export async function fetchStoredIdpJwt(dir: string, idpUrl: string, signal?: AbortSignal): Promise<string> {
  return fetchSessionIdpJwt(dir, idpUrl, requireIdpSession(dir, idpUrl), signal);
}

/** Hold the selected identity across retryable operations. Refresh may change its credential, but
 *  not its login ID. A replacement sign-in must not be substituted midway through an exchange. */
export async function fetchSessionIdpJwt(dir: string, idpUrl: string, session: IdpSession, signal?: AbortSignal): Promise<string> {
  const base = normalizeIdpUrl(idpUrl);
  const { token, oidc } = session;
  if (!oidc) return fetchIdpJwt(base, token, signal);
  throwIfCancelled(signal);
  const key = oidcProofKey(dir, base, oidc);
  const result = await cachedIdpProof(key, async () => {
    const rejected = "idp OIDC: the provider rejected the cached sign-in; sign in again with --oidc and the same issuer, client ID and audience";
    const metadata = await discoverOidc(oidc.issuer, signal);
    const endpoint = oidcEndpoint(oidc.issuer, "token_endpoint", metadata.token_endpoint);
    const { accessToken, sub } = await withOidcSessionLock(dir, base, async () => {
      const latest = requireCurrentOidcSession(dir, base, oidc.loginId);
      throwIfCancelled(signal);
      // A request already sent may rotate the token. Finish receiving and recording that
      // response even if the caller cancels. Do not restore a forgotten or replaced sign-in.
      const body = await oidcTokenResponse(endpoint, { grant_type: "refresh_token", client_id: oidc.clientId, refresh_token: latest.oidc.refreshToken }, "refresh", rejected);
      const { accessToken, expiresAt, refreshToken } = oidcGrant(body);
      withIdpSessionLock(dir, () => {
        const current = requireCurrentOidcSession(dir, base, oidc.loginId);
        saveIdpSessionLocked(dir, base, { ...current, oidc: { ...current.oidc, refreshToken: refreshToken ?? current.oidc.refreshToken }, expiresAt });
      });
      return { accessToken, sub: latest.sub };
    }, signal);
    // The access token is local to this request. Exchanging it cannot rotate the stored refresh token.
    return exchangeOidcProof(oidc, endpoint, accessToken, rejected, signal, sub);
  }, signal);
  requireCurrentOidcSession(dir, base, oidc.loginId);
  return result.jwt;
}

function oidcProofKey(dir: string, base: string, oidc: OidcLogin): string {
  return `${resolve(dir)}\0${base}\0${oidc.loginId}`;
}

function requireCurrentOidcSession(dir: string, base: string, loginId: string): Extract<IdpSession, { oidc: OidcLogin }> {
  const session = loadIdpSession(dir, base);
  if (!session?.oidc || session.oidc.loginId !== loginId)
    throw new IdpSessionRejectedError("idp OIDC: the cached sign-in changed; retry using the current sign-in");
  return session;
}

/** Opaque Better Auth bearer for routes whose contract is a provider session, not a mesh proof. */
export function betterAuthSessionToken(session: IdpSession): string {
  if (session.oidc) throw new Error("this operation requires a Better Auth session and does not support OIDC sign-in");
  return session.token;
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
  const previousSub = loadIdpSession(opts.dir, opts.idpUrl)?.sub;
  const { session, oidcProof } = await approveDeviceLogin(opts);
  const tokenResult = oidcProof && session.oidc
    ? await exchangeOidcProof(session.oidc, oidcProof.endpoint, oidcProof.accessToken, "idp OIDC: the provider refused to exchange the device access token; nothing was saved", opts.signal)
    : await fetchIdpJwtResponse(opts.idpUrl, betterAuthSessionToken(session), opts.signal);
  const jwt = tokenResult.jwt;
  let claims: Record<string, unknown>;
  try {
    claims = decodeJwt(jwt);
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
  stagedLogins.set(candidate, { opts, session, claims, previousSub, baseline, link: tokenResult.link });
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
  throwIfCancelled(opts.signal);
  const idpUrl = normalizeIdpUrl(opts.idpUrl);
  const catalogUrl = catalogUrlFromLink(idpUrl, link);
  if (!catalogUrl) throw new Error("idp login: the approved provider did not advertise a same-origin catalog");
  if (typeof claims.iss !== "string" || !claims.iss) throw new Error("idp login: the approved provider did not supply an issuer");
  const account = { idpUrl, issuer: claims.iss, sub: candidate.sub, ownerKey: ownerKey(idpUrl, candidate.sub), catalogUrl };
  const response = await idpFetch(catalogUrl, { headers: { authorization: `Bearer ${betterAuthSessionToken(session)}` }, redirect: "manual" }, opts.signal);
  if (!response.ok) throw new Error(`idp login: candidate catalog failed (HTTP ${response.status})`);
  const snapshot = await idpJson<unknown>(catalogUrl, response, opts.signal);
  validate(snapshot, account);
  throwIfCancelled(opts.signal);
  return { snapshot, account };
}

/** Persist a staged proof after the caller has checked its migration pins. Not a multi-file transaction. */
export function commitStagedIdpSession(candidate: StagedIdpSession): { session: IdpSession; sub: string; previousSub?: string; label?: string } {
  const { opts, session, claims, previousSub, baseline, link } = stagedState(candidate);
  // The persistence fence: a cancel that lands after approval, while the proof was in flight,
  // must leave no session and no catalog entry on disk.
  throwIfCancelled(opts.signal);
  assertLoginPins(claims, opts.expectedPins);
  // Approval can take minutes. Recheck before writing if another process changed the cache.
  const current = readCatalogPreparationState(opts.dir);
  if (opts.migrationFrom !== undefined && migrationDependency(current, opts.migrationFrom) !== baseline)
    throw new Error("idp login: the old account sign-in or catalog state changed during approval; nothing was saved; retry `cotal login --migrate-from " + normalizeIdpUrl(opts.migrationFrom) + "`");
  stagedLogins.delete(candidate);
  saveIdpSession(opts.dir, opts.idpUrl, session);
  saveCatalogAdvertisement(opts.dir, opts.idpUrl, claims.iss, candidate.sub, link);
  return { session, sub: candidate.sub, ...(previousSub && previousSub !== candidate.sub ? { previousSub } : {}), ...(session.label ? { label: session.label } : {}) };
}

type EstablishLoginOpts = DeviceLoginOpts & { dir: string; expectedPins?: IdpLoginPins };
type EstablishedLogin = ReturnType<typeof commitStagedIdpSession>;

/** The whole login operation, in the only safe order: device sign-in, then PROVE the session
 *  mints a user JWT, and only then persist it. A session that can't produce a JWT must never
 *  land on disk, because it would pass {@link requireIdpSession}'s no-fallback gate as a dud and
 *  defer the failure to some later connect. Returns the session plus the JWT's `sub`, and a human
 *  `label` (email/name/preferred_username when the IdP mints one). Both are display-only: the
 *  operator must be able to read which human signed in, but verification is the bridge/callout's
 *  job, server-side. */
export function establishIdpSession(opts: EstablishLoginOpts & { oidc?: undefined }): Promise<EstablishedLogin & { session: BetterAuthSession }>;
export function establishIdpSession(opts: EstablishLoginOpts): Promise<EstablishedLogin>;
export async function establishIdpSession(opts: EstablishLoginOpts): Promise<EstablishedLogin> {
  return commitStagedIdpSession(await stageIdpSession(opts));
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

async function discoverAdvertisement(state: CatalogAccountState, session: IdpSession): Promise<CatalogAccountState> {
  const result = await fetchIdpJwtResponse(state.idpUrl, betterAuthSessionToken(session));
  const claims = decodeJwt(result.jwt);
  if (claims.sub !== state.sub)
    throw new Error(`idp session: ${state.idpUrl} proved a different subject than the cached session - run \`${loginRecoveryCommand(state.idpUrl)}\` again`);
  const catalogUrl = catalogUrlFromLink(state.idpUrl, result.link);
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

/** Account identities available to a machine client. Session proofs stay inside this module. */
export function signedInMachineAccounts(dir: string): AuthSpaceCatalogAccount[] {
  const { sessions, file } = readCatalogPreparationState(dir);
  return Object.keys(sessions).sort().flatMap((idpUrl) => {
    const session = loadIdpSession(dir, idpUrl);
    if (!session?.sub || session.oidc) return [];
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
      if (session.oidc) {
        const sub = session.sub!; // required by the OIDC cache schema
        results.push({ account: accountView({ idpUrl, issuer: session.oidc.issuer, sub, ownerKey: ownerKey(idpUrl, sub), advertised: false }), state: "no-catalog" });
        continue;
      }
      if (!session.sub) {
        const tokenResult = await fetchIdpJwtResponse(idpUrl, session.token);
        const claims = decodeJwt(tokenResult.jwt);
        if (typeof claims.sub !== "string" || !claims.sub)
          throw new Error(`idp session: ${idpUrl} minted a user JWT without a sub - run \`${loginRecoveryCommand(idpUrl)}\` again`);
        session = { ...session, sub: claims.sub };
        saveIdpSession(opts.dir, idpUrl, session);
        saveCatalogAdvertisement(opts.dir, idpUrl, claims.iss, claims.sub, tokenResult.link);
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
  jwtCache.delete(`${base}\0${sessionToken}`); // this process stops minting from it now, not within the hold
  const res = await idpFetch(`${base}/sign-out`, {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok && res.status !== 401)
    throw new Error(`idp logout: ${base}/sign-out failed (HTTP ${res.status}) - the server-side session may still be alive`);
}

/** Revoke and remove the current generation under the same lock as refresh. RFC 7009 revocation
 *  is explicit: when no endpoint is advertised, leave the cache intact for `logout --local`. */
export async function revokeStoredOidcSession(dir: string, idpUrl: string, expected: OidcLogin): Promise<void> {
  const base = normalizeIdpUrl(idpUrl);
  const metadata = await discoverOidc(expected.issuer);
  const endpoint = oidcEndpoint(expected.issuer, "revocation_endpoint", metadata.revocation_endpoint);
  await withOidcSessionLock(dir, base, async () => {
    const { oidc: current } = requireCurrentOidcSession(dir, base, expected.loginId);
    const res = await postOidc(endpoint, { client_id: current.clientId, token: current.refreshToken, token_type_hint: "refresh_token" });
    if (!res.ok) throw new Error(`idp OIDC: revocation failed (HTTP ${res.status}); redirects are not followed`);
    jwtCache.delete(oidcProofKey(dir, base, current));
    withIdpSessionLock(dir, () => {
      if (loadIdpSession(dir, base)?.oidc?.loginId === current.loginId) deleteIdpSessionLocked(dir, base);
    });
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
  let source: string;
  try {
    source = readFileSync(f, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ver: SESSIONS_VER, sessions: {} };
    throw new Error(`${f}: could not read the session cache (${code ?? "unknown error"}) - restore access before retrying`);
  }
  // A torn write or a hand-edit must not reach requireIdpSession (the no-fallback gate) as a raw
  // "SyntaxError: Unexpected token" — say what's wrong and how to recover, like everywhere else.
  let parsed: SessionsFile;
  try {
    parsed = JSON.parse(source) as SessionsFile;
  } catch {
    throw new Error(`${f}: the session cache is not valid JSON - inspect it without printing its credentials, then sign in again`);
  }
  if (parsed === null || typeof parsed !== "object")
    throw new Error(`${f}: the session cache is not a JSON object - delete it and run \`cotal login\` again`);
  if (parsed.ver !== SESSIONS_VER)
    throw new Error(`${f}: unknown version ${String(parsed.ver)} (expected ${SESSIONS_VER}) - refusing to guess at a credential file`);
  if (parsed.sessions === null || typeof parsed.sessions !== "object" || Array.isArray(parsed.sessions))
    throw new Error(`${f}: malformed sessions map`);
  for (const [idp, session] of Object.entries(parsed.sessions)) {
    if (normalizeIdpUrl(idp) !== idp || !session || typeof session !== "object" || Array.isArray(session)
      || typeof session.expiresAt !== "number" || !Number.isFinite(session.expiresAt))
      throw new Error(`${f}: malformed session record`);
    const { oidc } = session;
    if (oidc === undefined ? typeof session.token !== "string" || !session.token
      : !oidc || typeof oidc !== "object" || session.token !== undefined || typeof oidc.issuer !== "string"
        || normalizeIdpUrl(oidc.issuer) !== idp || typeof oidc.clientId !== "string" || !oidc.clientId.trim()
        || typeof oidc.audience !== "string" || !oidc.audience.trim() || typeof oidc.loginId !== "string" || !oidc.loginId
        || typeof oidc.refreshToken !== "string" || !oidc.refreshToken || looksLikeJwt(oidc.refreshToken)
        || typeof session.sub !== "string" || !session.sub)
      throw new Error(`${f}: malformed session credential`);
  }
  return parsed;
}

/** Account-picker metadata only. Session tokens never leave this helper. */
export function listIdpAccounts(dir: string): { idp: string; sub?: string; expiresAt: number }[] {
  return Object.entries(readSessionsFile(dir).sessions).map(([idp, session]) => {
    return { idp, expiresAt: session.expiresAt, ...(typeof session.sub === "string" ? { sub: session.sub } : {}) };
  });
}

export function loadIdpSession(dir: string, idpUrl: string): IdpSession | undefined {
  const key = normalizeIdpUrl(idpUrl);
  const s = readSessionsFile(dir).sessions[key];
  if (s === undefined) return undefined;
  // `sub` rides the cache round-trip (offline owner derivation for the spawn paths) — every
  // consumer of ownerForLogin is a SEPARATE process re-reading this file, so dropping it here
  // broke both user-mode spawn entry points while every in-process test passed.
  return {
    ...(s.oidc ? { oidc: s.oidc } : { token: s.token }),
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

/** Serialize a read-modify-write of one session cache, including service-store propagation. */
export function withIdpSessionLock<T>(dir: string, run: () => T): T {
  const path = resolve(dir, "idp-sessions.lock");
  if (sessionLocks.has(path)) return run();
  mkSecretDir(dir);
  const lock = acquireLock(path, { label: "IdP session cache", waitMs: 5000 });
  sessionLocks.add(path);
  try { return run(); }
  finally { sessionLocks.delete(path); lock.release(); }
}

/** Only refresh and revocation of the same provider wait on its network request. Cache writers
 *  take the shared file lock separately and never hold it over network I/O. */
async function withOidcSessionLock<T>(dir: string, base: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const path = resolve(dir, `idp-oidc-${createHash("sha256").update(base).digest("hex")}.lock`);
  mkSecretDir(dir);
  const lock = await acquireLockAsync(path, { label: "OIDC provider session", waitMs: idpTimeoutMs(), signal }).catch(error => {
    throwIfCancelled(signal);
    throw error;
  });
  try {
    throwIfCancelled(signal);
    return await run();
  } finally { lock.release(); }
}

export function saveIdpSession(dir: string, idpUrl: string, session: IdpSession): void {
  withIdpSessionLock(dir, () => saveIdpSessionLocked(dir, idpUrl, session));
}

function saveIdpSessionLocked(dir: string, idpUrl: string, session: IdpSession): void {
  const file = readSessionsFile(dir);
  file.sessions[normalizeIdpUrl(idpUrl)] = {
    ...(session.oidc ? { oidc: session.oidc } : { token: session.token }),
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
