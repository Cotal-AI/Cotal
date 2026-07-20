/**
 * `cotal login` client smoke — the device-authorization flow proven against a REAL Better Auth
 * instance (jwt + deviceAuthorization + bearer plugins), end-to-end into the C2a bridge: device
 * sign-in → cached session → fresh IdP JWT over `Authorization: Bearer` → bridge exchange →
 * validated Cotal bearer. Plus the reject matrix a real operator hits: pinned client id, a deny
 * at the verification page, an expired device code, a revoked session (the 401 → "run `cotal
 * login` again" path — the revocation lever this client exists to preserve), and the session
 * cache's hygiene (0600, session token only — never a JWT, version-guarded).
 *
 * Deliberately NOT covered live: `slow_down` back-off (+5s per RFC 8628 §3.5) — Better Auth only
 * emits it on a faster-than-interval poll this client never sends; the handling is code-reviewed.
 * Loopback HTTP only; broker-free. Run: pnpm smoke:auth-login
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintLifecycleUid } from "@cotal-ai/core";
import { jwtVerify } from "jose";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins/jwt";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { bearer } from "better-auth/plugins/bearer";
import { toNodeHandler } from "better-auth/node";
import {
  createIdpBridge,
  createUserTokenIssuer,
  deleteIdpSession,
  deriveOwnerToken,
  deviceLogin,
  establishIdpSession,
  fetchIdpJwt,
  generateSigningKey,
  loadIdpSession,
  normalizeIdpUrl,
  pinnedJwksResolver,
  requireIdpSession,
  revokeIdpSession,
  saveIdpSession,
  validateUserToken,
  type DeviceLoginPrompt,
} from "../src/index.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
async function rejects(name: string, fn: () => Promise<unknown> | unknown, needle?: string) {
  try { await fn(); check(`${name} (expected rejection)`, false); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(needle && !msg.includes(needle) ? `${name} (wrong reason: ${msg})` : name, !needle || msg.includes(needle));
  }
}

const SPACE = "demo";
const SECRET = "s".repeat(32);
const CLIENT_ID = "cotal-cli";

// ---------- the real Better Auth IdP ----------
console.log("A) real Better Auth (jwt + deviceAuthorization + bearer), the happy chain");

let handler: ReturnType<typeof toNodeHandler> | undefined;
const server = createServer((req, res) => handler!(req, res));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const base = `${origin}/api/auth`;

const auth = betterAuth({
  baseURL: origin,
  secret: "smoke-only-better-auth-secret-0123456789",
  // The memory adapter throws on any missing model: BA's base four + the jwt plugin's `jwks` +
  // the device plugin's `deviceCode`.
  database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [], deviceCode: [] }),
  emailAndPassword: { enabled: true },
  plugins: [
    jwt({ jwt: { issuer: origin, audience: origin } }),
    // The operator PINS the client id — a wrong one must fail loud at /device/code.
    deviceAuthorization({ expiresIn: "2m", interval: "1s", validateClient: (id) => id === CLIENT_ID }),
    // bearer() is what lets a CLI present the cached session token as `Authorization: Bearer`
    // instead of juggling cookies — the login client's /token + /sign-out calls depend on it.
    bearer(),
  ],
});
handler = toNodeHandler(auth);

// The approving browser: a real signed-up user with a real session cookie.
const signup = await auth.api.signUpEmail({
  body: { email: "human@example.test", password: "correct-horse-battery", name: "Human 42" },
  returnHeaders: true,
});
const cookie = signup.headers.get("set-cookie")!.split(";")[0];
const userId = signup.response.user.id;

// Approve/deny the way the real verification page does, with the session cookie: first
// `GET /device?user_code=…` (claims the code for the signed-in session), then the decision.
async function decide(userCode: string, verb: "approve" | "deny") {
  const claim = await fetch(`${base}/device?user_code=${encodeURIComponent(userCode)}`, { headers: { cookie, origin } });
  if (!claim.ok) throw new Error(`device claim failed: HTTP ${claim.status} ${await claim.text()}`);
  const res = await fetch(`${base}/device/${verb}`, {
    method: "POST",
    // `origin` included: BA's CSRF guard requires it on cookie-authenticated state changes —
    // exactly what the real verification page sends.
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ userCode }),
  });
  if (!res.ok) throw new Error(`device/${verb} failed: HTTP ${res.status} ${await res.text()}`);
}

// Run one full device login, deciding as soon as the prompt appears.
async function loginDeciding(verb: "approve" | "deny", clientId = CLIENT_ID) {
  let prompt: DeviceLoginPrompt | undefined;
  let prompts = 0;
  const session = deviceLogin({
    idpUrl: base,
    clientId,
    onPrompt: (p) => { prompt = p; prompts++; void decide(p.userCode, verb); },
  });
  return { session: await session, prompt: prompt!, prompts };
}

// ---- the happy chain ----
const { session, prompt, prompts } = await loginDeciding("approve");
check("prompt fired exactly once with the verification URL + user code",
  prompts === 1 && prompt.verificationUri.startsWith(origin) &&
  prompt.verificationUriComplete.includes(prompt.userCode) && prompt.userCode.length > 0 && prompt.expiresInSec > 0);
check("device login returns an IdP session (opaque token, future expiry)",
  session.token.length > 0 && !session.token.includes(".") && session.expiresAt > Math.floor(Date.now() / 1000));

const idpJwt = await fetchIdpJwt(base, session.token);
{
  // The JWT is a real, verifiable IdP token for OUR user — checked against BA's live JWKS.
  const { payload } = await jwtVerify(idpJwt, pinnedJwksResolver(`${base}/jwks`), {
    issuer: origin, audience: origin,
  });
  check("cached session mints a fresh IdP JWT for the signed-in user (verified vs live JWKS)", payload.sub === userId);
}

{
  // End-to-end into C2a: the login client's JWT is exactly what the bridge exchanges.
  const issuer = createUserTokenIssuer({ issuer: "https://auth.cotal.test", key: await generateSigningKey() });
  const bridge = createIdpBridge({
    idp: { issuer: origin, audience: origin, key: pinnedJwksResolver(`${base}/jwks`) },
    space: SPACE, spaceSecret: SECRET, issuer,
    authorizeActor: () => ({ scope: ["chat"], lifecycleUid: mintLifecycleUid() }),
    mintConnectCredential: async () => "root0001", // R1: the v0.4 bridge requires the mint hook
  });
  const { token, owner } = await bridge.exchange(idpJwt, { actor: "agent_1" });
  const v = await validateUserToken(token, { key: issuer.localKeySet(), issuer: "https://auth.cotal.test", audience: SPACE });
  check("device-login JWT exchanges into a validated Cotal bearer (login → session → JWT → bridge → bearer)",
    v.owner === owner && v.owner === deriveOwnerToken(SECRET, JSON.stringify([origin, userId])) && v.act.actor === "agent_1");
}

{
  // The whole login op in its safe order against the REAL IdP: prove via /token, then persist.
  const estDir = mkdtempSync(join(tmpdir(), "cotal-login-smoke-est-"));
  const est = await establishIdpSession({
    dir: estDir, idpUrl: base, clientId: CLIENT_ID,
    onPrompt: (p) => void decide(p.userCode, "approve"),
  });
  check("establishIdpSession: proves the session mints a JWT, THEN persists; sub is the signed-in user",
    est.sub === userId && loadIdpSession(estDir, base)?.token === est.session.token);
}

// ---- the session cache ----
console.log("B) the machine-local session cache");
const dir = mkdtempSync(join(tmpdir(), "cotal-login-smoke-"));
saveIdpSession(dir, `${base}/`, session); // trailing slash — must land on the normalized key
{
  const loaded = loadIdpSession(dir, base);
  check("save/load round-trips (URL normalized: trailing slash is the same IdP)",
    loaded?.token === session.token && loaded?.expiresAt === session.expiresAt);
  const raw = readFileSync(join(dir, "idp-sessions.json"), "utf8");
  check("cache holds the SESSION token only — no JWT ever lands on disk", !raw.includes("eyJ") && raw.includes(session.token));
  if (process.platform !== "win32")
    check("cache file is 0600", (statSync(join(dir, "idp-sessions.json")).mode & 0o777) === 0o600);
  check("requireIdpSession returns the cached session", requireIdpSession(dir, base).token === session.token);
  await rejects("requireIdpSession on a never-logged-in IdP is a legible no-fallback throw",
    () => requireIdpSession(dir, "https://other.example.com"), "no anonymous fallback");
  check("deleteIdpSession removes it (and says so)", deleteIdpSession(dir, base) === true && loadIdpSession(dir, base) === undefined);
  check("deleting again reports nothing-to-do", deleteIdpSession(dir, base) === false);
  saveIdpSession(dir, base, session); // restore for the logout leg below
}
{
  const verDir = mkdtempSync(join(tmpdir(), "cotal-login-smoke-ver-"));
  saveIdpSession(verDir, base, session);
  const f = join(verDir, "idp-sessions.json");
  const bumped = JSON.parse(readFileSync(f, "utf8"));
  bumped.ver = 99;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(f, JSON.stringify(bumped));
  await rejects("an unknown cache version refuses to guess (no silent migration)", () => loadIdpSession(verDir, base), "version");
}
{
  // A torn write / hand-edit must reach the no-fallback gate as a legible sentence, never jose/JSON raw.
  const badDir = mkdtempSync(join(tmpdir(), "cotal-login-smoke-bad-"));
  saveIdpSession(badDir, base, session);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(badDir, "idp-sessions.json"), "{ this is not json");
  await rejects("a corrupt (non-JSON) cache is a legible throw, not a raw SyntaxError",
    () => requireIdpSession(badDir, base), "not valid JSON");
}
await rejects("a non-loopback http IdP url is refused", () => normalizeIdpUrl("http://auth.example.com/api/auth"), "https");
await rejects("a garbage IdP url is refused", () => normalizeIdpUrl("not a url"), "not a valid URL");
check("bracketed IPv6 loopback http is accepted (WHATWG hostname is \"[::1]\")",
  normalizeIdpUrl("http://[::1]:4599/api/auth") === "http://[::1]:4599/api/auth");
await rejects("a query on the IdP url is refused, not silently dropped",
  () => normalizeIdpUrl("http://127.0.0.1/api/auth?tenant=a"), "query or fragment");
await rejects("a fragment on the IdP url is refused, not silently dropped",
  () => normalizeIdpUrl("http://127.0.0.1/api/auth#frag"), "query or fragment");
await rejects("an IdP url with embedded credentials (@-confusion host spoof) is refused",
  () => normalizeIdpUrl("https://real-idp.example@evil.example/api/auth"), "embed credentials");

// ---- the reject matrix ----
console.log("C) denies, expiry, revocation");
await rejects("a client id the operator didn't pin is refused at /device/code",
  () => loginDeciding("approve", "evil-cli"), "refused the device authorization");
await rejects("a deny at the verification page is a legible throw, not a retry loop",
  () => loginDeciding("deny"), "denied");

{
  // A second, short-fuse IdP instance: the device code dies before anyone approves.
  let h2: ReturnType<typeof toNodeHandler> | undefined;
  const s2 = createServer((req, res) => h2!(req, res));
  await new Promise<void>((r) => s2.listen(0, "127.0.0.1", r));
  const origin2 = `http://127.0.0.1:${(s2.address() as AddressInfo).port}`;
  const auth2 = betterAuth({
    baseURL: origin2,
    secret: "smoke-only-better-auth-secret-0123456789",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], deviceCode: [] }),
    plugins: [deviceAuthorization({ expiresIn: "1s", interval: "1s" })],
  });
  h2 = toNodeHandler(auth2);
  await rejects("an unapproved device code expires into a legible throw",
    () => deviceLogin({ idpUrl: `${origin2}/api/auth`, clientId: CLIENT_ID, onPrompt: () => {} }), "expired");
  s2.close();
}

// ---- a hostile / broken IdP: the client must refuse, never spin or cache ----
console.log("D) hostile-IdP responses");
{
  // A minimal fake IdP whose responses the smoke scripts per-path — the surface a MALICIOUS
  // (not merely misconfigured) IdP controls.
  let script: Record<string, { status: number; body: unknown }> = {};
  const fake = createServer((req, res) => {
    const route = new URL(req.url!, "http://x").pathname;
    const r = script[route] ?? { status: 404, body: {} };
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(JSON.stringify(r.body));
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const fakeBase = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/api/auth`;
  const grantBody = (over: Record<string, unknown>) => ({
    device_code: "d", user_code: "u", verification_uri: "v", verification_uri_complete: "vc",
    expires_in: 60, interval: 1, ...over,
  });

  script = { "/api/auth/device/code": { status: 200, body: grantBody({ interval: "abc" }) } };
  await rejects("a non-numeric poll interval is refused before any poll (no ~1ms tight loop)",
    () => deviceLogin({ idpUrl: fakeBase, clientId: CLIENT_ID, onPrompt: () => {} }), "malformed device grant");
  script = { "/api/auth/device/code": { status: 200, body: grantBody({ interval: 1e9 }) } };
  await rejects("an absurd poll interval is refused, not obeyed as a silent hang",
    () => deviceLogin({ idpUrl: fakeBase, clientId: CLIENT_ID, onPrompt: () => {} }), "malformed device grant");
  script = { "/api/auth/device/code": { status: 200, body: grantBody({ expires_in: 1e12 }) } };
  await rejects("an absurd device-code lifetime is refused (no unbounded poll loop)",
    () => deviceLogin({ idpUrl: fakeBase, clientId: CLIENT_ID, onPrompt: () => {} }), "malformed device grant");
  script = { "/api/auth/device/code": { status: 200, body: grantBody({ user_code: "" }) } };
  await rejects("an empty user code is refused before the human is prompted with it",
    () => deviceLogin({ idpUrl: fakeBase, clientId: CLIENT_ID, onPrompt: () => {} }), "malformed device grant");
  script = {
    "/api/auth/device/code": { status: 200, body: grantBody({}) },
    "/api/auth/device/token": { status: 200, body: { access_token: "tok", expires_in: Number.POSITIVE_INFINITY } },
  };
  await rejects("a non-finite session lifetime in the token response is refused",
    () => deviceLogin({ idpUrl: fakeBase, clientId: CLIENT_ID, onPrompt: () => {} }), "malformed token response");
  script = {
    "/api/auth/device/code": { status: 200, body: grantBody({}) },
    "/api/auth/device/token": { status: 200, body: { access_token: "opaque-session", expires_in: 1e12 } },
  };
  await rejects("an absurd (finite but unbounded) session lifetime is refused, not echoed as 'until year 33000'",
    () => deviceLogin({ idpUrl: fakeBase, clientId: CLIENT_ID, onPrompt: () => {} }), "malformed token response");

  // Prove-then-save: a device flow that "succeeds" but whose session can't mint a JWT must
  // leave NO cache entry — otherwise requireIdpSession would pass the no-fallback gate on a dud.
  const dudDir = mkdtempSync(join(tmpdir(), "cotal-login-smoke-dud-"));
  script = {
    "/api/auth/device/code": { status: 200, body: grantBody({}) },
    "/api/auth/device/token": { status: 200, body: { access_token: "dud-session", expires_in: 3600 } },
    "/api/auth/token": { status: 401, body: {} },
  };
  await rejects("establishIdpSession: a session that can't mint a JWT fails the login legibly",
    () => establishIdpSession({ dir: dudDir, idpUrl: fakeBase, clientId: CLIENT_ID, onPrompt: () => {} }), "run `cotal login");
  check("… and leaves NO cache entry behind (prove-then-save)", loadIdpSession(dudDir, fakeBase) === undefined);

  // A JWT handed back as the device access token breaks the revocation model — refuse it (DiD).
  const jwtish = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  script = {
    "/api/auth/device/code": { status: 200, body: grantBody({}) },
    "/api/auth/device/token": { status: 200, body: { access_token: jwtish, expires_in: 3600 } },
  };
  await rejects("a JWT returned as the device access token is refused (revocation-model DiD)",
    () => deviceLogin({ idpUrl: fakeBase, clientId: CLIENT_ID, onPrompt: () => {} }), "opaque revocable handle");

  // /token 200 with a non-JWT body must be a legible refusal, not jose's raw "Invalid JWT".
  const garbageDir = mkdtempSync(join(tmpdir(), "cotal-login-smoke-garbage-"));
  script = {
    "/api/auth/device/code": { status: 200, body: grantBody({}) },
    "/api/auth/device/token": { status: 200, body: { access_token: "opaque-session", expires_in: 3600 } },
    "/api/auth/token": { status: 200, body: { token: "not-a-jwt" } },
  };
  await rejects("a /token value that isn't a JWT is refused legibly (not a raw jose error)",
    () => establishIdpSession({ dir: garbageDir, idpUrl: fakeBase, clientId: CLIENT_ID, onPrompt: () => {} }), "not a decodable JWT");
  check("… and the garbage /token session leaves no cache entry", loadIdpSession(garbageDir, fakeBase) === undefined);
  fake.close();
}

// ---- a hung IdP: the per-request timeout is what makes "never a silent hang" true ----
{
  const hang = createServer(() => { /* accept the connection, never respond */ });
  await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
  const hangBase = `http://127.0.0.1:${(hang.address() as AddressInfo).port}/api/auth`;
  const prev = process.env.COTAL_IDP_TIMEOUT_MS;
  process.env.COTAL_IDP_TIMEOUT_MS = "300";
  await rejects("a hung IdP times out instead of stalling fetchIdpJwt forever (the non-interactive gate)",
    () => fetchIdpJwt(hangBase, "sess"), "timed out");
  if (prev === undefined) delete process.env.COTAL_IDP_TIMEOUT_MS;
  else process.env.COTAL_IDP_TIMEOUT_MS = prev;
  hang.closeAllConnections();
  hang.close();
}
{
  // A subtler hang: headers flushed, then the BODY stalls — the abort fires inside res.json(),
  // outside idpFetch's catch. It must still surface the legible "idp request to …" sentence.
  const stall = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"token":"eyJ'); // partial JSON, deliberately never ended
  });
  await new Promise<void>((r) => stall.listen(0, "127.0.0.1", r));
  const stallBase = `http://127.0.0.1:${(stall.address() as AddressInfo).port}/api/auth`;
  const prev = process.env.COTAL_IDP_TIMEOUT_MS;
  process.env.COTAL_IDP_TIMEOUT_MS = "300";
  await rejects("an IdP that stalls mid-body is a legible timeout, not a raw body-read error",
    () => fetchIdpJwt(stallBase, "sess"), "idp request to");
  if (prev === undefined) delete process.env.COTAL_IDP_TIMEOUT_MS;
  else process.env.COTAL_IDP_TIMEOUT_MS = prev;
  stall.closeAllConnections();
  stall.close();
}

// ---- revocation: the whole point of caching the session, not the JWT ----
{
  await revokeIdpSession(base, session.token);
  await rejects("a revoked session can no longer mint JWTs — the 401 says exactly how to recover",
    () => fetchIdpJwt(base, session.token), "run `cotal login");
  check("revoking an already-dead session is idempotent (goal state reached)",
    await revokeIdpSession(base, session.token).then(() => true));
  await rejects("garbage bearer is the same legible 401 path", () => fetchIdpJwt(base, "not-a-session"), "run `cotal login");
}
{
  // A non-401 sign-out failure is NOT the goal state (the server-side session may still be alive),
  // so revokeIdpSession must throw loudly — this is the signal `cotal logout` keys off to KEEP the
  // local session for a retry rather than silently dropping the handle.
  const so = createServer((_req, res) => { res.writeHead(503, { "content-type": "application/json" }).end("{}"); });
  await new Promise<void>((r) => so.listen(0, "127.0.0.1", r));
  const soBase = `http://127.0.0.1:${(so.address() as AddressInfo).port}/api/auth`;
  await rejects("a non-401 sign-out failure is a loud throw (server-side session may still be alive)",
    () => revokeIdpSession(soBase, "sess"), "may still be alive");
  so.close();
}

server.close();
console.log(`\nlogin smoke: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
