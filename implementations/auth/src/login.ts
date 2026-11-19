/**
 * `cotal login` client — device-authorization sign-in (RFC 8628) plus the machine-local IdP
 * session cache (plan §"How it lands in today's code" → Client).
 *
 * Flow: ask the IdP for a device code, show the human a verification URL + user code, poll until
 * the sign-in is approved in a browser. What comes back — and the ONLY thing ever persisted — is
 * the IdP SESSION token. The short-lived IdP JWT the bridge exchanges is fetched from `/token`
 * ({@link fetchIdpJwt}) and held in memory for at most {@link JWT_CACHE_CAP_MS} (and never past
 * its own `exp` minus a margin), one entry per (IdP, session), concurrent callers sharing one
 * request. Persisting the JWT would let a revoked session keep minting mesh access until the JWT
 * expired; the bounded in-process hold means revocation at the IdP bites within a minute, and a
 * 401 surfaces as a legible "run `cotal login` again", never a silent hang. Without the hold, a
 * manager hosting dozens of runs posted one `/token` per authority call and tripped the IdP's
 * per-source rate limit, failing unrelated spawns and reads with a bare HTTP 429.
 *
 * Device code, not auth-code+PKCE: it works headless (agents, SSH) and needs nothing beyond the
 * IdP's device endpoints — no OIDC provider metadata, no loopback redirect server (the plan
 * explicitly avoids Better Auth's draft OIDC-provider surface). Better Auth's
 * `deviceAuthorization` plugin is the reference IdP; the wire contract this client assumes is
 * pinned by the login smoke against a real instance. One deliberate deviation from strict
 * RFC 8628 §3.4: bodies are posted as JSON, because Better Auth's endpoint layer REJECTS
 * `application/x-www-form-urlencoded` (415). The opt-in OIDC flow uses discovered endpoints and
 * form bodies, and keeps its rotating refresh token separate from Better Auth sessions.
 *
 * `idpUrl` is the Better Auth base URL or the OIDC issuer. Credentials require HTTPS or HTTP
 * on a loopback IP literal. Embedded URL credentials are refused.
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
import { decodeJwt } from "jose";
import { acquireLockAsync, isCredentialTransportUrl, mkSecretDir, writeSecretFileAtomic, type AuthSpaceCatalogAccount, type AuthSpaceCatalogResult } from "@cotal-ai/core";
import { loginRecoveryCommand, serviceLoginRecovery, CommandFailure, acquireLock, chatNameProblem, credentialFailure, checkIdpUrl } from "@cotal-ai/workspace";
import { verifyIdpToken } from "./idp.js";
import { pinnedJwksResolver } from "./issuer.js";

interface SessionIdentity {
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

type BetterAuthSession = SessionIdentity & { token: string; expiresAt: number; oidc?: never };
type OidcSession = SessionIdentity & {
  oidc: { id: string; issuer: string; clientId: string; jwksUri: string; refreshToken: string };
  token?: never;
  expiresAt?: never;
};

/** The provider's revocable login handle. Only Better Auth reports a session expiration. */
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
  /** The Better Auth base URL or the exact OIDC issuer. */
  idpUrl: string;
  /** The OAuth client id this CLI presents; the IdP may pin it via its validateClient hook. */
  clientId: string;
  /** Select OpenID Connect Discovery, RFC 8628 form requests and RFC 8693 token exchange. */
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

/** An IdP request that got no answer: the transport failed or the per-request timeout fired. */
export class IdpUnreachableError extends Error {}

class IdpRequestTimeoutError extends IdpUnreachableError {}

/** The provider refused the initial device-code request, before approval or persistence. */
export class IdpDeviceAuthorizationRefusedError extends Error {}

/** The IdP rejected a cached session or refresh grant as expired or revoked. */
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
      throw new IdpRequestTimeoutError(`idp request to ${url} timed out after ${ms}ms - the IdP is unreachable or not responding`);
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

/** Best-effort reachability + shape check of an IdP's JWKS. Used at the FIRST `--user-auth` enable
 *  so a dead or typo'd `--idp` fails loud BEFORE a space is provisioned around it, instead of only
 *  surfacing far away at the first user connect (the pin is written but the JWKS is fetched lazily).
 *  Uses the explicit pin URI or the Better Auth default (`<base>/jwks`). Throws on an
 *  unreachable host, a redirect, a non-2xx, or a body that is not a JWKS key set. A redirect is
 *  refused because it could move the check onto another host or onto plaintext, away from the URL
 *  the space pins. */
export async function probeIdpJwks(idpUrl: string, pinnedUri?: string): Promise<void> {
  const jwksUri = pinnedUri === undefined ? `${normalizeIdpUrl(idpUrl)}/jwks` : checkedOidcUrl(pinnedUri, "JWKS URI");
  const hint = pinnedUri === undefined ? "Check --idp <auth base URL>; it must serve <base>/jwks" : "Check --idp-jwks-uri; it must serve the pinned JWKS";
  const res = await idpFetch(jwksUri, { redirect: "manual" });
  if (res.status >= 300 && res.status < 400)
    throw new Error(`the IdP at ${idpUrl} answered ${jwksUri} with HTTP ${res.status}, a redirect; redirects are refused, so its target was not fetched. ${hint} itself.`);
  if (!res.ok)
    throw new Error(`the IdP at ${idpUrl} did not serve a JWKS: ${jwksUri} returned HTTP ${res.status}. ${pinnedUri === undefined ? "Check --idp <auth base URL>" : hint}.`);
  const body = await idpJson<{ keys?: unknown } | null>(jwksUri, res);
  if (!Array.isArray(body?.keys))
    throw new Error(`the IdP at ${idpUrl} did not return a JWKS key set at ${jwksUri}. ${hint}.`);
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
export async function deviceLogin(opts: Omit<DeviceLoginOpts, "oidc">): Promise<BetterAuthSession> {
  const base = normalizeIdpUrl(opts.idpUrl);
  const tok = await pollDeviceLogin(opts, base);
  // The reference session expiry is advisory; bound it so operators never see invalid dates.
  if (typeof tok?.access_token !== "string" || !tok.access_token || !saneDuration(tok.expires_in, 31_536_000))
    throw new Error(`idp login: ${base} returned a malformed token response`);
  if (looksLikeJwt(tok.access_token))
    throw new Error(`idp login: ${base} returned a JWT as the device access token - the session token must be an opaque revocable handle, refusing to cache it; re-run \`cotal login\` after fixing the IdP`);
  return { token: tok.access_token, expiresAt: Math.floor(Date.now() / 1000) + tok.expires_in };
}

interface TokenReply {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  issued_token_type?: unknown;
}

function saneDuration(v: unknown, max: number): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= max;
}

async function pollDeviceLogin(opts: DeviceLoginOpts, base: string, oidc?: OidcMetadata): Promise<TokenReply | null> {
  const deviceUrl = oidc?.deviceUrl ?? `${base}/device/code`;
  const tokenUrl = oidc?.tokenUrl ?? `${base}/device/token`;
  const post = (url: string, fields: Record<string, string>, ms?: number) => oidc
    ? oidcPost(url, fields, opts.signal, ms)
    : idpFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fields) }, opts.signal);
  const res = await post(deviceUrl, { client_id: opts.clientId, ...(oidc ? { scope: "openid offline_access" } : {}) });
  if (!res.ok) {
    const e = await oauthError(res, opts.signal);
    throw new IdpDeviceAuthorizationRefusedError(
      `idp login: ${base} refused the device authorization (${e.error ?? `HTTP ${res.status}`}: ${e.error_description ?? "no detail"})`,
    );
  }
  const grant = await idpJson<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    expires_in: number;
    interval: number;
  } | null>(deviceUrl, res, opts.signal);
  // The WHOLE grant is shape-checked before anything is shown or polled — the timing fields
  // especially: a malicious IdP handing back `interval: "abc"` or a non-finite/absurd
  // `expires_in` would otherwise turn the poll loop into a tight (setTimeout coerces garbage to
  // ~1ms) or unbounded one. Bounds: a device code living past 24h or a poll interval past 5min
  // is not a sane grant — refuse, don't clamp.
  if (
    !grant || typeof grant.device_code !== "string" || !grant.device_code ||
    typeof grant.user_code !== "string" || !grant.user_code ||
    typeof grant.verification_uri !== "string" || !grant.verification_uri ||
    ((!oidc || grant.verification_uri_complete !== undefined) && (typeof grant.verification_uri_complete !== "string" || !grant.verification_uri_complete)) ||
    !saneDuration(grant.expires_in, 86_400) ||
    (grant.interval !== undefined && !saneDuration(grant.interval, 300))
  )
    throw new Error(`idp login: ${base} returned a malformed device grant - refusing to poll on it`);
  const verificationUri = oidc ? checkedOidcUrl(grant.verification_uri, "verification URI") : grant.verification_uri;
  const verificationUriComplete = oidc && grant.verification_uri_complete !== undefined
    ? checkedOidcUrl(grant.verification_uri_complete, "complete verification URI") : grant.verification_uri_complete ?? verificationUri;
  const retry = oidc ? `cotal login --idp ${base} --oidc --client-id <id>` : opts.migrationFrom === undefined ? "cotal login" : `cotal login --migrate-from ${normalizeIdpUrl(opts.migrationFrom)}`;
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
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(expired);
    let poll: Response;
    try {
      poll = await post(tokenUrl, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: grant.device_code, client_id: opts.clientId,
      }, oidc ? Math.min(left, idpTimeoutMs()) : undefined);
    } catch (error) {
      if (!oidc || !(error instanceof IdpRequestTimeoutError)) throw error;
      // RFC 8628 requires slower polling after a connection timeout. The grant deadline still wins.
      intervalSec *= 2;
      continue;
    }
    if (poll.ok) return idpJson<TokenReply | null>(tokenUrl, poll, opts.signal);
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
      `idp login: ${base} rejected the poll (${e.error ?? `HTTP ${poll.status}`}: ${e.error_description ?? "no detail"})`,
    );
  }
}

type IdpJwtResult = { jwt: string; response: Response };

interface OidcMetadata {
  deviceUrl: string;
  tokenUrl: string;
  jwksUri: string;
  revocationUrl?: string;
}

const ID_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token";

export function checkedOidcUrl(value: unknown, name: string): string {
  let url: URL | undefined;
  if (typeof value === "string") {
    try { url = new URL(value); } catch { /* Invalid URL, diagnosed below without echoing it. */ }
  }
  if (!url || !isCredentialTransportUrl(url) || url.username || url.password || url.href.includes("#"))
    throw new Error(`idp OIDC: ${name} must be an HTTPS URL (or HTTP on a loopback IP) without userinfo or a fragment`);
  return url.href;
}

/** OIDC compares issuer identifiers as strings. URL validation must not rewrite that identifier. */
export function checkedOidcIssuer(value: string): string {
  if (!checkIdpUrl(value).ok)
    throw new Error("idp OIDC: the issuer must use HTTPS (or HTTP on a loopback IP) without userinfo, a query or a fragment");
  if (!/^https?:\/\//.test(value) || /[\s\x00-\x1f\x7f\\]/.test(value) || value.includes("?") || value.includes("#"))
    throw new Error("idp OIDC: provide the exact HTTPS issuer URL (or HTTP on a loopback IP) from the discovery document");
  return value;
}

/** OIDC discovery binds the configured issuer before endpoint URLs are trusted. */
async function discoverOidc(issuer: string, signal?: AbortSignal): Promise<OidcMetadata> {
  const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const res = await idpFetch(url, { redirect: "manual" }, signal);
  assertOidcNoRedirect(res);
  if (!res.ok) throw new Error(`idp OIDC: discovery failed (HTTP ${res.status})`);
  const meta = await idpJson<Record<string, unknown> | null>(url, res, signal);
  if (meta?.issuer !== issuer) throw new Error("idp OIDC: discovery issuer does not match the configured issuer");
  return {
    deviceUrl: checkedOidcUrl(meta.device_authorization_endpoint, "device authorization endpoint"),
    tokenUrl: checkedOidcUrl(meta.token_endpoint, "token endpoint"),
    jwksUri: checkedOidcUrl(meta.jwks_uri, "JWKS URI"),
    ...(meta.revocation_endpoint !== undefined ? { revocationUrl: checkedOidcUrl(meta.revocation_endpoint, "revocation endpoint") } : {}),
  };
}

function assertOidcNoRedirect(res: Response): void {
  if (res.status >= 300 && res.status < 400)
    throw new Error(`idp OIDC: redirects are refused (HTTP ${res.status})`);
}

async function oidcPost(url: string, fields: Record<string, string>, signal?: AbortSignal, ms?: number): Promise<Response> {
  const res = await idpFetch(url, { method: "POST", redirect: "manual", body: new URLSearchParams(fields) }, signal, ms);
  assertOidcNoRedirect(res);
  return res;
}

function opaqueRefreshToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !looksLikeJwt(value);
}

async function exchangeOidcProof(issuer: string, tokenUrl: string, account: OidcSession["oidc"], accessToken: string, signal?: AbortSignal): Promise<string> {
  const res = await oidcPost(tokenUrl, {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    client_id: account.clientId,
    audience: account.clientId,
    scope: "openid",
    subject_token: accessToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    requested_token_type: ID_TOKEN_TYPE,
  }, signal);
  if (!res.ok) throw new Error(`idp OIDC: token exchange failed (HTTP ${res.status})`);
  const body = await idpJson<TokenReply | null>(tokenUrl, res, signal);
  if (body?.issued_token_type !== ID_TOKEN_TYPE || typeof body.access_token !== "string" || !body.access_token)
    throw new Error("idp OIDC: token exchange did not return the requested ID token");
  await verifyIdpToken(body.access_token, { issuer, audience: account.clientId, key: pinnedJwksResolver(account.jwksUri) });
  throwIfCancelled(signal);
  return body.access_token;
}

async function oidcLogin(opts: DeviceLoginOpts & { expectedPins?: IdpLoginPins }): Promise<{ session: OidcSession; jwt: string; link: null }> {
  const issuer = checkedOidcIssuer(opts.idpUrl);
  if (!opts.clientId.trim()) throw new Error("idp OIDC: an OAuth client ID is required");
  if (opts.expectedPins && (opts.expectedPins.issuer !== issuer || opts.expectedPins.audience !== opts.clientId))
    throw new Error("idp OIDC: the configured issuer or client ID does not match the expected login pins");
  const meta = await discoverOidc(issuer, opts.signal);
  if (opts.expectedPins?.jwksUri !== undefined && checkedOidcUrl(opts.expectedPins.jwksUri, "pinned JWKS URI") !== meta.jwksUri)
    throw new Error("idp OIDC: the discovered JWKS URI does not match the expected login pin");
  const body = await pollDeviceLogin(opts, issuer, meta);
  if (typeof body?.access_token !== "string" || !body.access_token || !opaqueRefreshToken(body.refresh_token))
    throw new Error("idp OIDC: device login must return an access token and an opaque refresh token; nothing was saved");
  const session: OidcSession = { oidc: { id: randomUUID(), issuer, clientId: opts.clientId, jwksUri: meta.jwksUri, refreshToken: body.refresh_token } };
  const jwt = await exchangeOidcProof(issuer, meta.tokenUrl, session.oidc, body.access_token, opts.signal);
  return { session, jwt, link: null };
}

/** Longest an IdP JWT is reused from memory. The bound on how long a session revoked at the IdP
 *  can still mint mesh access from a process that already held a JWT. */
const JWT_CACHE_CAP_MS = 60_000;
/** A held JWT is dropped this long before its own `exp`, so a reuse never hands the bridge a
 *  token that expires in flight. */
const JWT_CACHE_MARGIN_MS = 30_000;
type JwtCacheEntry = { result: IdpJwtResult; until: number } | { inflight: Promise<IdpJwtResult> };
const jwtCache = new Map<string, JwtCacheEntry>();
const oidcProofs = new Map<string, { jwt: string; until: number }>();

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
async function fetchIdpJwtResponse(idpUrl: string, sessionToken: string, cancel?: AbortSignal): Promise<IdpJwtResult> {
  const base = normalizeIdpUrl(idpUrl);
  const key = `${base}\0${sessionToken}`;
  const now = Date.now();
  const hit = jwtCache.get(key);
  if (hit) {
    if ("inflight" in hit) {
      if (!cancel) return hit.inflight;
    } else if (hit.until > now) return hit.result;
    else jwtCache.delete(key);
  }
  const inflight = fetchIdpJwtUncached(base, sessionToken, cancel).then(
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

export async function fetchIdpJwt(idpUrl: string, sessionToken: string, signal?: AbortSignal): Promise<string> {
  return (await fetchIdpJwtResponse(idpUrl, sessionToken, signal)).jwt;
}

/** Read a proof for a cached login. A standards login may rotate its handle in this directory. */
export async function fetchSessionIdpJwt(dir: string, idpUrl: string, signal?: AbortSignal): Promise<string> {
  throwIfCancelled(signal);
  const base = normalizeIdpUrl(idpUrl);
  const selected = requireIdpSession(dir, base);
  if (!selected.oidc) return fetchIdpJwt(base, selected.token, signal);
  const generation = selected.oidc.id;
  const cacheKey = (session: OidcSession) => JSON.stringify([resolve(dir), base, session.oidc.id, session.oidc.refreshToken]);
  const heldProof = (session: OidcSession) => {
    const key = cacheKey(session);
    const cached = oidcProofs.get(key);
    if (cached && cached.until > Date.now()) return cached.jwt;
    oidcProofs.delete(key);
    return undefined;
  };
  const cached = heldProof(selected);
  if (cached) return cached;

  return withIdpSessionLockAsync(dir, async () => {
    throwIfCancelled(signal);
    // A waiter must read the winner's handle, not the potentially spent one it read on entry.
    const session = requireIdpSession(dir, base);
    if (!session.oidc || session.oidc.id !== generation)
      throw new Error("idp OIDC: the cached account or its configuration changed while waiting for a proof; retry the command");
    const hit = heldProof(session);
    if (hit) return hit;
    const { issuer } = session.oidc;
    const meta = await discoverOidc(issuer, signal);
    if (meta.jwksUri !== session.oidc.jwksUri) throw new Error("idp OIDC: the discovered JWKS URI changed; sign in again after checking the provider configuration");
    throwIfCancelled(signal);
    // Once refresh is sent, caller cancellation must not discard the replacement handle. The
    // request still has a hard deadline and is never retried on an ambiguous failure.
    const response = await oidcPost(meta.tokenUrl, {
      grant_type: "refresh_token", client_id: session.oidc.clientId, refresh_token: session.oidc.refreshToken,
    });
    if (!response.ok) {
      const { error } = await oauthError(response);
      if (error === "invalid_grant")
        throw new IdpSessionRejectedError(`idp OIDC: the cached refresh grant was rejected; sign in again with \`cotal login --idp ${issuer} --oidc --client-id <id>\``);
      throw new Error(`idp OIDC: refreshing the session failed (HTTP ${response.status})`);
    }
    const body = await idpJson<TokenReply | null>(meta.tokenUrl, response);
    if (!body || (body.refresh_token !== undefined && !opaqueRefreshToken(body.refresh_token)))
      throw new Error("idp OIDC: the refresh response did not contain a usable replacement handle");
    const next: OidcSession = body.refresh_token === undefined ? session : { ...session, oidc: { ...session.oidc, refreshToken: body.refresh_token } };
    if (next.oidc.refreshToken !== session.oidc.refreshToken) saveIdpSessionLocked(dir, base, next);
    throwIfCancelled(signal);
    if (typeof body.access_token !== "string" || !body.access_token) throw new Error("idp OIDC: the refresh response did not contain an access token");
    const jwt = await exchangeOidcProof(issuer, meta.tokenUrl, next.oidc, body.access_token, signal);
    if (decodeJwt(jwt).sub !== session.sub) throw new Error("idp OIDC: refresh proved a different account subject");
    const now = Date.now(), until = jwtCacheUntil(jwt, now);
    for (const [key, entry] of oidcProofs) if (entry.until <= now) oidcProofs.delete(key);
    if (until > now) oidcProofs.set(cacheKey(next), { jwt, until });
    return jwt;
  });
}

/** Optional pins a staged login must match. OIDC also verifies the signature locally. */
export interface IdpLoginPins {
  idpUrl?: string;
  issuer: string;
  audience: string;
  jwksUri?: string;
  sub?: string;
}

type EstablishLoginOpts = DeviceLoginOpts & { dir: string; expectedPins?: IdpLoginPins };
type EstablishedSession<Session extends IdpSession> = { session: Session; sub: string; previousSub?: string; label?: string };

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
  if (opts.oidc && opts.migrationFrom !== undefined) throw new Error("idp OIDC: hosted catalog migration requires a Better Auth session");
  const initial = readCatalogPreparationState(opts.dir);
  const previous = initial.sessions[normalizeIdpUrl(opts.idpUrl)];
  if (previous?.oidc && !opts.oidc)
    throw new Error(`idp OIDC: this account uses OIDC; sign in with \`cotal login --idp ${previous.oidc.issuer} --oidc --client-id <id>\``);
  const baseline = opts.migrationFrom === undefined ? undefined : migrationDependency(initial, opts.migrationFrom);
  opts = { ...opts, ...(opts.expectedPins ? { expectedPins: { ...opts.expectedPins } } : {}) };
  if (opts.expectedPins?.idpUrl !== undefined && normalizeIdpUrl(opts.idpUrl) !== normalizeIdpUrl(opts.expectedPins.idpUrl))
    throw new Error("idp login: the provider URL does not match the expected login URL; nothing was saved");
  const previousSub = previous?.sub;
  const { session, jwt, link } = opts.oidc ? await oidcLogin(opts) : await (async () => {
    const session = await deviceLogin(opts);
    const { jwt, response } = await fetchIdpJwtResponse(opts.idpUrl, session.token, opts.signal);
    return { session, jwt, link: response.headers.get("link") };
  })();
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
  // Catalog and migration endpoints use a Better Auth session bearer. Never send a refresh token
  // to those endpoints, even if an OAuth server advertises a Cotal catalog link.
  stagedLogins.set(candidate, { opts, session, claims, previousSub, baseline, link });
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
  if (session.oidc) throw new Error("idp OIDC: hosted catalog migration requires a Better Auth session");
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
  if (!session.oidc) saveCatalogAdvertisement(opts.dir, opts.idpUrl, claims.iss, candidate.sub, link);
  return { session, sub: candidate.sub, ...(previousSub && previousSub !== candidate.sub ? { previousSub } : {}), ...(session.label ? { label: session.label } : {}) };
}

/** The whole login operation, in the only safe order: device sign-in, then PROVE the session
 *  mints a user JWT, and only then persist it. A session that can't produce a JWT must never
 *  land on disk, because it would pass {@link requireIdpSession}'s no-fallback gate as a dud and
 *  defer the failure to some later connect. Returns the session plus the JWT's `sub`, and a human
 *  `label` (email/name/preferred_username when the IdP mints one). Both are display-only: the
 *  operator must be able to read which human signed in, but verification is the bridge/callout's
 *  job, server-side. */
export function establishIdpSession(opts: EstablishLoginOpts & { oidc?: false }): Promise<EstablishedSession<BetterAuthSession>>;
export function establishIdpSession(opts: EstablishLoginOpts): Promise<EstablishedSession<IdpSession>>;
export async function establishIdpSession(opts: EstablishLoginOpts): Promise<EstablishedSession<IdpSession>> {
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
  const { token } = requireBetterAuthSession(opts.dir, idp);
  if (opts.intent && (opts.method !== "PUT" || !/^[A-Za-z0-9_-]{1,128}$/.test(opts.intent.spaceId) || !Number.isSafeInteger(opts.intent.expectedRevision) || opts.intent.expectedRevision < 0)) throw new Error("invalid computer space intent");
  const url = opts.intent
    ? `${new URL(idp).origin}/api/machines/${opts.machineId}/spaces/${encodeURIComponent(opts.intent.spaceId)}`
    : `${new URL(idp).origin}/api/cli/machines/${opts.machineId}${opts.method === "GET" ? "/spaces" : ""}`;
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
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
        const sub = session.sub!;
        results.push({ account: { idpUrl, issuer: session.oidc.issuer, sub, ownerKey: ownerKey(idpUrl, sub) }, state: "no-catalog" });
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

/** Revoke and remove the latest standards handle as one serialized operation with refresh. */
export async function clearOidcSession(dir: string, idpUrl: string, selected: OidcSession, local: boolean): Promise<boolean> {
  return withIdpSessionLockAsync(dir, async () => {
    const session = loadIdpSession(dir, idpUrl);
    if (!session) return false;
    if (!session.oidc || session.oidc.id !== selected.oidc.id)
      throw new Error("idp OIDC: the cached account changed before logout; nothing was cleared");
    if (!local) {
      const meta = await discoverOidc(session.oidc.issuer);
      if (meta.jwksUri !== session.oidc.jwksUri) throw new Error("idp OIDC: the discovered JWKS URI changed");
      if (!meta.revocationUrl) throw new Error("idp OIDC: the provider does not advertise token revocation");
      const response = await oidcPost(meta.revocationUrl, {
        client_id: session.oidc.clientId, token: session.oidc.refreshToken, token_type_hint: "refresh_token",
      });
      if (!response.ok) throw new Error(`idp OIDC: revocation failed (HTTP ${response.status})`);
    }
    deleteIdpSessionLocked(dir, idpUrl);
    return true;
  });
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
    if (session.oidc !== undefined) {
      const oidc = session.oidc;
      if (session.token !== undefined || session.expiresAt !== undefined || typeof session.sub !== "string" || !session.sub
        || !oidc || typeof oidc.id !== "string" || !oidc.id || typeof oidc.clientId !== "string" || !oidc.clientId.trim() || !opaqueRefreshToken(oidc.refreshToken)
        || typeof oidc.issuer !== "string" || normalizeIdpUrl(checkedOidcIssuer(oidc.issuer)) !== idp
        || checkedOidcUrl(oidc.jwksUri, "cached JWKS URI") !== oidc.jwksUri)
        throw new Error(`${f}: malformed OIDC session record`);
    } else if (typeof session.token !== "string" || !session.token || typeof session.expiresAt !== "number" || !Number.isFinite(session.expiresAt)) {
      throw new Error(`${f}: malformed session record`);
    }
  }
  return parsed;
}

/** Account-picker metadata only. Session tokens never leave this helper. */
export function listIdpAccounts(dir: string): { idp: string; sub?: string; expiresAt?: number }[] {
  return Object.entries(readSessionsFile(dir).sessions).map(([idp, session]) => {
    return { idp, ...(session.expiresAt !== undefined ? { expiresAt: session.expiresAt } : {}), ...(typeof session.sub === "string" ? { sub: session.sub } : {}) };
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
    ...(s.oidc ? { oidc: s.oidc } : { token: s.token, expiresAt: s.expiresAt }),
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

function idpSessionLockPath(dir: string): string {
  return resolve(dir, "idp-sessions.lock");
}

async function withIdpSessionLockAsync<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const lock = await acquireLockAsync(idpSessionLockPath(dir), { label: "IdP session cache", waitMs: idpTimeoutMs() });
  try { return await run(); }
  finally { lock.release(); }
}

/** Serialize a read-modify-write of one session cache, including service-store propagation. */
export function withIdpSessionLock<T>(dir: string, run: () => T): T {
  const path = idpSessionLockPath(dir);
  if (sessionLocks.has(path)) return run();
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
  const key = normalizeIdpUrl(idpUrl);
  if (!session.oidc && file.sessions[key]?.oidc)
    throw new Error("idp login: the cached OIDC session cannot be replaced with a Better Auth session");
  file.sessions[key] = {
    ...(session.oidc ? { oidc: session.oidc } : { token: session.token, expiresAt: session.expiresAt }),
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

/** Hosted provider routes that consume an opaque Better Auth session do not accept OAuth grants. */
export function requireBetterAuthSession(dir: string, idpUrl: string): BetterAuthSession {
  const session = requireIdpSession(dir, idpUrl);
  if (session.oidc) throw new Error("this hosted provider operation requires a Better Auth session; an OIDC refresh token cannot be used here");
  return session;
}
