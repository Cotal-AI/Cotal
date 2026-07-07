/**
 * `cotal login` client — device-authorization sign-in (RFC 8628) plus the machine-local IdP
 * session cache (plan §"How it lands in today's code" → Client).
 *
 * Flow: ask the IdP for a device code, show the human a verification URL + user code, poll until
 * the sign-in is approved in a browser. What comes back — and the ONLY thing ever cached — is the
 * IdP SESSION token. The short-lived IdP JWT the bridge exchanges is fetched fresh from `/token`
 * per use ({@link fetchIdpJwt}): caching the JWT would let a revoked session keep minting mesh
 * access until the JWT expired, so instead revocation at the IdP bites at the very next fetch —
 * a 401 surfaces as a legible "run `cotal login` again", never a silent hang.
 *
 * Device code, not auth-code+PKCE: it works headless (agents, SSH) and needs nothing beyond the
 * IdP's device endpoints — no OIDC provider metadata, no loopback redirect server (the plan
 * explicitly avoids Better Auth's draft OIDC-provider surface). Better Auth's
 * `deviceAuthorization` plugin is the reference IdP; the wire contract this client assumes is
 * pinned by the login smoke against a real instance. One deliberate deviation from strict
 * RFC 8628 §3.4: bodies are posted as JSON, because Better Auth's endpoint layer REJECTS
 * `application/x-www-form-urlencoded` (415). A strict-RFC IdP plugs in via a thin adapter, not
 * by bending the reference client.
 *
 * `idpUrl` throughout is the IdP's AUTH BASE URL — every endpoint resolves under it (Better
 * Auth: `<origin>/api/auth`). Same origin posture as the JWKS pin: https, or loopback http for
 * local dev; embedded `user:pass@` credentials are refused (the @-confusion host spoof).
 *
 * Every IdP request carries a hard per-request timeout ({@link idpFetch}) — Node's global fetch
 * has none, and the poll deadline is only checked between polls, so a hung IdP would otherwise
 * stall a login (or a non-interactive `requireIdpSession`→`fetchIdpJwt` on an agent connect)
 * forever. Override the 30s default with `COTAL_IDP_TIMEOUT_MS` for a slow IdP.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeJwt } from "jose";
import { mkSecretDir, writeSecretFileAtomic } from "@cotal-ai/core";

/** A cached IdP login. `token` is the IdP session bearer (Better Auth: `session.token`) — an
 *  opaque revocable handle, never a JWT. `expiresAt` (unix seconds) is advisory for messages;
 *  the server is the authority (a revoked session dies earlier). */
export interface IdpSession {
  token: string;
  expiresAt: number;
  /** The IdP subject this session proved at login (display + local owner derivation). Absent only
   *  in caches written by older builds — consumers that need it fail loud naming `cotal login`. */
  sub?: string;
}

/** What the human must be shown to approve the sign-in. */
export interface DeviceLoginPrompt {
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  expiresInSec: number;
}

export interface DeviceLoginOpts {
  /** The IdP auth base URL (Better Auth: `<origin>/api/auth`). */
  idpUrl: string;
  /** The OAuth client id this CLI presents; the IdP may pin it via its validateClient hook. */
  clientId: string;
  /** Shows the human the verification URL + code. Called exactly once, before polling starts. */
  onPrompt: (prompt: DeviceLoginPrompt) => void;
}

/** Normalize + guard the IdP base URL: https (or loopback http for dev), no query/hash, no
 *  trailing slash — the normalized string is also the session-cache key, so `…/api/auth` and
 *  `…/api/auth/` must land on the same entry. */
export function normalizeIdpUrl(idpUrl: string): string {
  let u: URL;
  try {
    u = new URL(idpUrl);
  } catch {
    throw new Error(`idp url "${idpUrl}" is not a valid URL`);
  }
  // WHATWG URL keeps the brackets on an IPv6 hostname — "[::1]", not "::1" (same set as the
  // issuer's pinned-JWKS origin guard).
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback))
    throw new Error(`idp url must be https (or loopback http for local dev) — got "${idpUrl}"`);
  // A query/hash would be silently DROPPED by the normalization below — and a silently altered
  // auth base is a different IdP than the operator asked for. Refuse instead.
  if (u.search !== "" || u.hash !== "")
    throw new Error(`idp url must not carry a query or fragment — got "${idpUrl}"`);
  // Same class: `--idp https://real-idp.example@evil.example/api/auth` parses to host
  // evil.example, so an operator who eyeballed "real-idp.example" would sign in against evil.
  // The normalization below drops the userinfo silently — refuse it (don't echo the password).
  if (u.username !== "" || u.password !== "")
    throw new Error(`idp url must not embed credentials before the host — the host it would actually contact is "${u.host}"`);
  return u.origin + u.pathname.replace(/\/+$/, "");
}

interface OAuthError {
  error?: string;
  error_description?: string;
}
async function oauthError(res: Response): Promise<OAuthError> {
  try {
    return (await res.json()) as OAuthError;
  } catch {
    return {};
  }
}

/** Per-request timeout budget (ms). Default 30s; `COTAL_IDP_TIMEOUT_MS` overrides for a slow IdP
 *  (or a test). A malformed override fails loud rather than silently reverting to the default. */
function idpTimeoutMs(): number {
  const raw = process.env.COTAL_IDP_TIMEOUT_MS;
  if (raw === undefined) return 30_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0)
    throw new Error(`COTAL_IDP_TIMEOUT_MS must be a positive number of milliseconds — got "${raw}"`);
  return n;
}

/** `fetch` with a hard per-request timeout, so a hung IdP connection can never stall the client
 *  (Node's global fetch has no default timeout). A timeout or transport failure surfaces as a
 *  legible sentence rather than a raw DOMException/TypeError. */
async function idpFetch(url: string, init?: RequestInit): Promise<Response> {
  const ms = idpTimeoutMs();
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError")
      throw new Error(`idp request to ${url} timed out after ${ms}ms — the IdP is unreachable or not responding`);
    throw new Error(`idp request to ${url} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Read a JSON body under the SAME normalization as {@link idpFetch}. The request timeout can fire
 *  DURING the body read (an IdP that flushes headers then stalls or truncates the body), and that
 *  abort is raised from `res.json()` — outside idpFetch's catch — so without this it would leak a
 *  raw DOMException/parse error instead of the legible "idp request to …" sentence. */
async function idpJson<T>(url: string, res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError")
      throw new Error(`idp request to ${url} timed out reading the response body — the IdP flushed headers then stalled`);
    throw new Error(`idp request to ${url} returned an unreadable response body: ${e instanceof Error ? e.message : String(e)}`);
  }
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
export async function deviceLogin(opts: DeviceLoginOpts): Promise<IdpSession> {
  const base = normalizeIdpUrl(opts.idpUrl);
  const res = await idpFetch(`${base}/device/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: opts.clientId }),
  });
  if (!res.ok) {
    const e = await oauthError(res);
    throw new Error(
      `idp login: ${base} refused the device authorization (${e.error ?? `HTTP ${res.status}`}: ${e.error_description ?? "no detail"})`,
    );
  }
  const grant = await idpJson<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  }>(`${base}/device/code`, res);
  // The WHOLE grant is shape-checked before anything is shown or polled — the timing fields
  // especially: a malicious IdP handing back `interval: "abc"` or a non-finite/absurd
  // `expires_in` would otherwise turn the poll loop into a tight (setTimeout coerces garbage to
  // ~1ms) or unbounded one. Bounds: a device code living past 24h or a poll interval past 5min
  // is not a sane grant — refuse, don't clamp.
  const sane = (v: unknown, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= max;
  if (
    typeof grant.device_code !== "string" || !grant.device_code ||
    typeof grant.user_code !== "string" || !grant.user_code ||
    typeof grant.verification_uri !== "string" || !grant.verification_uri ||
    typeof grant.verification_uri_complete !== "string" || !grant.verification_uri_complete ||
    !sane(grant.expires_in, 86_400) ||
    (grant.interval !== undefined && !sane(grant.interval, 300))
  )
    throw new Error(`idp login: ${base} returned a malformed device grant — refusing to poll on it`);
  opts.onPrompt({
    verificationUri: grant.verification_uri,
    verificationUriComplete: grant.verification_uri_complete,
    userCode: grant.user_code,
    expiresInSec: grant.expires_in,
  });

  const deadline = Date.now() + grant.expires_in * 1000;
  // RFC 8628 §3.5: poll at the server's interval; `slow_down` adds 5s to it, permanently.
  let intervalSec = Math.max(1, grant.interval || 5);
  for (;;) {
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
    if (Date.now() > deadline)
      throw new Error(`idp login: the device code expired after ${grant.expires_in}s without approval — run \`cotal login\` again`);
    const poll = await idpFetch(`${base}/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: grant.device_code,
        client_id: opts.clientId,
      }),
    });
    if (poll.ok) {
      const tok = await idpJson<{ access_token: string; expires_in: number }>(`${base}/device/token`, poll);
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
        throw new Error(`idp login: ${base} returned a JWT as the device access token — the session token must be an opaque revocable handle, refusing to cache it; re-run \`cotal login\` after fixing the IdP`);
      return { token: tok.access_token, expiresAt: Math.floor(Date.now() / 1000) + tok.expires_in };
    }
    const e = await oauthError(poll);
    if (e.error === "authorization_pending") continue;
    if (e.error === "slow_down") {
      intervalSec += 5;
      continue;
    }
    if (e.error === "access_denied") throw new Error("idp login: the sign-in was denied at the verification page");
    if (e.error === "expired_token")
      throw new Error("idp login: the device code expired before the sign-in was approved — run `cotal login` again");
    throw new Error(
      `idp login: ${base} rejected the poll (${e.error ?? `HTTP ${poll.status}`}: ${e.error_description ?? "no detail"})`,
    );
  }
}

/** Fetch a fresh short-lived IdP user JWT for the cached session — the input to the bridge
 *  exchange. A 401 means the session was revoked or expired at the IdP: the error says exactly
 *  how to recover. The JWT is returned, never stored. */
export async function fetchIdpJwt(idpUrl: string, sessionToken: string): Promise<string> {
  const base = normalizeIdpUrl(idpUrl);
  const res = await idpFetch(`${base}/token`, { headers: { authorization: `Bearer ${sessionToken}` } });
  if (res.status === 401)
    throw new Error(
      `idp session: ${base} rejected the cached session (expired or revoked) — run \`cotal login --idp ${base}\` to sign in again`,
    );
  if (!res.ok) throw new Error(`idp session: ${base}/token failed (HTTP ${res.status})`);
  const body = await idpJson<{ token?: string }>(`${base}/token`, res);
  if (typeof body.token !== "string" || !body.token) throw new Error(`idp session: ${base}/token returned no token`);
  return body.token;
}

/** The whole login operation, in the only safe order: device sign-in, then PROVE the session
 *  mints a user JWT, and only then persist it. A session that can't produce a JWT must never
 *  land on disk — it would pass {@link requireIdpSession}'s no-fallback gate as a dud and defer
 *  the failure to some later connect. Returns the session plus the JWT's `sub`, and a human
 *  `label` (email/name/preferred_username when the IdP mints one) — BOTH display-only: the
 *  operator must be able to read WHICH human signed in, but verification is the bridge/callout's
 *  job, server-side. */
export async function establishIdpSession(
  opts: DeviceLoginOpts & { dir: string },
): Promise<{ session: IdpSession; sub: string; label?: string }> {
  const session = await deviceLogin(opts);
  const jwt = await fetchIdpJwt(opts.idpUrl, session.token);
  let claims: Record<string, unknown>;
  try {
    claims = decodeJwt(jwt);
  } catch {
    // fetchIdpJwt only guarantees a non-empty string; a hostile IdP returning /token 200 with a
    // non-JWT body would otherwise surface jose's raw "Invalid JWT" here.
    throw new Error(`idp login: ${normalizeIdpUrl(opts.idpUrl)} returned a /token value that is not a decodable JWT — refusing to cache the session; re-run \`cotal login\` after fixing the IdP`);
  }
  const sub = claims.sub;
  if (typeof sub !== "string" || !sub)
    throw new Error(`idp login: ${normalizeIdpUrl(opts.idpUrl)} minted a user JWT without a sub — refusing to cache the session; re-run \`cotal login\` after fixing the IdP`);
  session.sub = sub; // proven above — cached so owner derivation (spawn paths) stays offline
  saveIdpSession(opts.dir, opts.idpUrl, session);
  const label = [claims.email, claims.name, claims.preferred_username].find(
    (c): c is string => typeof c === "string" && c.length > 0,
  );
  return { session, sub, ...(label ? { label } : {}) };
}

/** Revoke the session server-side (sign out). A 401 back means the session is already dead —
 *  the goal state, treated as success; any other failure is thrown because a still-live
 *  server-side session is a real leak the operator must hear about. */
export async function revokeIdpSession(idpUrl: string, sessionToken: string): Promise<void> {
  const base = normalizeIdpUrl(idpUrl);
  const res = await idpFetch(`${base}/sign-out`, {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok && res.status !== 401)
    throw new Error(`idp logout: ${base}/sign-out failed (HTTP ${res.status}) — the server-side session may still be alive`);
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
  if (!existsSync(f)) return { ver: SESSIONS_VER, sessions: {} };
  // A torn write or a hand-edit must not reach requireIdpSession (the no-fallback gate) as a raw
  // "SyntaxError: Unexpected token" — say what's wrong and how to recover, like everywhere else.
  let parsed: SessionsFile;
  try {
    parsed = JSON.parse(readFileSync(f, "utf8")) as SessionsFile;
  } catch (e) {
    throw new Error(`${f}: the session cache is not valid JSON (${e instanceof Error ? e.message : String(e)}) — delete it and run \`cotal login\` again`);
  }
  if (parsed === null || typeof parsed !== "object")
    throw new Error(`${f}: the session cache is not a JSON object — delete it and run \`cotal login\` again`);
  if (parsed.ver !== SESSIONS_VER)
    throw new Error(`${f}: unknown version ${String(parsed.ver)} (expected ${SESSIONS_VER}) — refusing to guess at a credential file`);
  if (parsed.sessions === null || typeof parsed.sessions !== "object" || Array.isArray(parsed.sessions))
    throw new Error(`${f}: malformed sessions map`);
  return parsed;
}

export function loadIdpSession(dir: string, idpUrl: string): IdpSession | undefined {
  const key = normalizeIdpUrl(idpUrl);
  const s = readSessionsFile(dir).sessions[key];
  if (s === undefined) return undefined;
  if (typeof s.token !== "string" || !s.token || typeof s.expiresAt !== "number")
    throw new Error(`stored idp session for ${key} is malformed — run \`cotal login --idp ${key}\` again`);
  return { token: s.token, expiresAt: s.expiresAt };
}

export function saveIdpSession(dir: string, idpUrl: string, session: IdpSession): void {
  const file = readSessionsFile(dir);
  file.sessions[normalizeIdpUrl(idpUrl)] = { token: session.token, expiresAt: session.expiresAt };
  mkSecretDir(dir); // harden the dir BEFORE the secret lands (0700 POSIX, private ACL win32)
  writeSecretFileAtomic(join(dir, SESSIONS_FILE), JSON.stringify(file, null, 2));
}

/** Remove the cached session. Returns false when there was nothing to remove. */
export function deleteIdpSession(dir: string, idpUrl: string): boolean {
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
    throw new Error(
      `not logged in to ${key} — this space requires a user identity and there is no anonymous fallback; run \`cotal login --idp ${key}\``,
    );
  return s;
}
