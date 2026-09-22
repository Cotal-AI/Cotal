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
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
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
  deleteIdpSpaceCatalog,
  deriveOwnerToken,
  deviceLogin,
  establishIdpSession,
  fetchIdpJwt,
  generateSigningKey,
  loadIdpSession,
  normalizeIdpUrl,
  prepareIdpSpaceCatalogs,
  pinnedJwksResolver,
  cotalAuthProvider,
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

// ---------- remote enrollment redeem ----------
console.log("A) one-shot remote enrollment client");
{
  let requests = 0;
  let authorization: string | undefined;
  let method: string | undefined;
  const enrollmentHome = mkdtempSync(join(tmpdir(), "cotal-enrollment-home-"));
  const priorHome = process.env.COTAL_HOME;
  process.env.COTAL_HOME = enrollmentHome;
  const enrollment = createServer((req, res) => {
    requests++;
    method = req.method;
    authorization = req.headers.authorization;
    res.setHeader("content-type", "application/json");
    if (req.url === "/redirect") {
      res.statusCode = 302;
      res.setHeader("location", "/fresh");
      return void res.end();
    }
    if (req.url === "/refused") {
      res.statusCode = 404;
      return void res.end(JSON.stringify({ error: "unknown, expired, or already-used enrollment" }));
    }
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => enrollment.listen(0, "127.0.0.1", r));
  const enrollmentBase = `http://127.0.0.1:${(enrollment.address() as AddressInfo).port}`;
  saveIdpSession(enrollmentHome, `${enrollmentBase}/idp`, { token: "cached-login", expiresAt: Date.now() / 1000 + 600 });
  await rejects("a cached login conflicts before the one-time enrollment GET", () => cotalAuthProvider.postAgentEnrollment!({ url: `${enrollmentBase}/fresh` }), "refusing before redeeming");
  check("the login conflict made no request", requests === 0);
  deleteIdpSession(enrollmentHome, `${enrollmentBase}/idp`);
  const ok = await cotalAuthProvider.postAgentEnrollment!({ url: `${enrollmentBase}/fresh` });
  check("enrollment redeem GETs once with no Authorization header", requests === 1 && method === "GET" && authorization === undefined && (ok as { ok?: boolean }).ok === true);
  await rejects("an enrollment redirect is refused without following it", () => cotalAuthProvider.postAgentEnrollment!({ url: `${enrollmentBase}/redirect` }), "redirect");
  check("the redirect consumed exactly one request", requests === 2);
  await rejects("all enrollment refusals use the one closed message", () => cotalAuthProvider.postAgentEnrollment!({ url: `${enrollmentBase}/refused` }), "enrollment refused: unknown, expired, or already-used; ask the owner for a fresh one");
  check("the refusal is never retried", requests === 3);
  await rejects("a non-loopback HTTP enrollment is refused before fetch", () => cotalAuthProvider.postAgentEnrollment!({ url: "http://example.com/secret" }), "loopback HTTP literal");
  check("the non-loopback refusal made no request", requests === 3);
  // The class, not one instance: every form a URL parser would rewrite must be refused before fetch.
  const port = (enrollment.address() as AddressInfo).port;
  for (const [label, url, reason] of [
    ["empty userinfo", `http://@127.0.0.1:${port}/fresh`, "must not contain userinfo"],
    ["a bare query marker", `${enrollmentBase}/fresh?`, "must not contain a query"],
    ["a backslash authority", `http:\\\\@127.0.0.1:${port}/fresh`, "must begin with https:// or http:// in lowercase"],
    ["a mixed slash authority", `http:/\\@127.0.0.1:${port}/fresh`, "must begin with https:// or http:// in lowercase"],
    ["an uppercase scheme", `HTTP://127.0.0.1:${port}/fresh`, "must begin with https:// or http:// in lowercase"],
    ["a trailing space", `${enrollmentBase}/fresh `, "must not contain whitespace or control characters"],
    ["an encoded newline", `${enrollmentBase}/fresh%0a`, "must not contain whitespace or control characters"],
    ["a short host form", `http://127.1:${port}/fresh`, "is not in canonical form"],
    ["a dot segment", `http://127.0.0.1:${port}/enroll/../fresh`, "is not in canonical form"],
    ["a default port", "http://127.0.0.1:80/fresh", "is not in canonical form"],
  ] as const) {
    await rejects(`an enrollment URL with ${label} is refused`, () => cotalAuthProvider.postAgentEnrollment!({ url }), reason);
    check(`the ${label} refusal made no request`, requests === 3);
  }
  enrollment.close();
  delete process.env.COTAL_HOME;
  if (priorHome !== undefined) process.env.COTAL_HOME = priorHome;
}

// ---------- the real Better Auth IdP ----------
console.log("B) real Better Auth (jwt + deviceAuthorization + bearer), the happy chain");

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
console.log("C) the machine-local session cache");
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

// ---- advertised space catalog: provider owns bearer, cache, ETag and lock ----
console.log("C2) advertised space catalog cache");
{
  let tokenRequests = 0;
  let catalogRequests = 0;
  let conditional = 0;
  let failCatalog = false;
  let invalidCatalog = false;
  const catalogDir = mkdtempSync(join(tmpdir(), "cotal-login-catalog-"));
  let catalogBase = "";
  const catalog = createServer((req, res) => {
    if (req.url === "/api/auth/token") {
      tokenRequests++;
      res.writeHead(200, {
        "content-type": "application/json",
        link: `<${catalogBase}/spaces>; rel="https://cotal.ai/relations/space-catalog"`,
      });
      return void res.end(JSON.stringify({ token: "eyJhbGciOiJub25lIn0.eyJpc3MiOiJodHRwOi8vMTI3LjAuMC4xIiwic3ViIjoiY2F0LXVzZXIifQ." }));
    }
    if (req.url === "/spaces") {
      catalogRequests++;
      if (req.headers["if-none-match"] === '"v1"') conditional++;
      if (failCatalog) return void res.writeHead(503).end();
      if (invalidCatalog) {
        res.writeHead(200, { "content-type": "application/json", etag: '"bad"' });
        return void res.end(JSON.stringify({ v: 2 }));
      }
      if (req.headers["if-none-match"] === '"v1"') return void res.writeHead(304).end();
      res.writeHead(200, { "content-type": "application/json", etag: '"v1"' });
      const spaces = Array.from({ length: 100 }, (_, i) => ({
        id: `space-${i}`,
        slug: i === 0 ? "shared_project" : `space_${i}`,
        name: i === 0 ? "Shared project" : `Space ${i}`,
        kind: i === 0 ? "team" : "personal",
        role: "owner",
        registration: {
          space: i === 0 ? "shared_project" : `space_${i}`,
          server: `nats://127.0.0.1:${54991 + i}`,
          tlsRequired: false,
          userAuth: { provider: "cotal", idp: { url: `${catalogBase}/api/auth`, issuer: "http://127.0.0.1", audience: "catalog" }, endpoints: { url: `${catalogBase}/exchange` } },
          sentinelCreds: `catalog-sentinel-${i}`,
        },
      }));
      return void res.end(JSON.stringify({
        v: 1,
        account: { idpUrl: `${catalogBase}/api/auth`, issuer: "http://127.0.0.1", sub: "cat-user" },
        spaces,
      }));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => catalog.listen(0, "127.0.0.1", r));
  catalogBase = `http://127.0.0.1:${(catalog.address() as AddressInfo).port}`;
  const catalogIdp = `${catalogBase}/api/auth`;
  saveIdpSession(catalogDir, catalogIdp, { token: "catalog-session", expiresAt: Date.now() / 1000 + 600, sub: "cat-user" });
  const { prepareCatalogTargets, validateCatalogSnapshot } = await import("../../cli/src/commands/sync.js");
  let validateCalls = 0;
  const validate = (snapshot: unknown, account: Parameters<typeof validateCatalogSnapshot>[1]) => {
    validateCalls++;
    validateCatalogSnapshot(snapshot, account);
  };
  const first = await prepareIdpSpaceCatalogs({ dir: catalogDir, idpUrl: catalogIdp, force: true, validate });
  check("first preparation learns the Link relation and publishes one validated snapshot",
    first[0]?.state === "updated" && tokenRequests === 1 && catalogRequests === 1, first);
  const warm = await prepareIdpSpaceCatalogs({ dir: catalogDir, idpUrl: catalogIdp, validate });
  check("a snapshot younger than five seconds makes zero requests", warm[0]?.state === "fresh" && tokenRequests === 1 && catalogRequests === 1, warm);
  const priorHome = process.env.COTAL_HOME;
  process.env.COTAL_HOME = catalogDir;
  await prepareCatalogTargets({ idpUrl: catalogIdp, force: true });
  const meshDir = join(catalogDir, "meshes");
  const meshTimes = new Map(readdirSync(meshDir).map((file) => [file, statSync(join(meshDir, file)).mtimeMs]));
  const warmTimes: number[] = [];
  for (let i = 0; i < 20; i++) {
    const started = performance.now();
    await prepareCatalogTargets({ idpUrl: catalogIdp });
    warmTimes.push(performance.now() - started);
  }
  if (priorHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = priorHome;
  warmTimes.sort((a, b) => a - b);
  const warmP95 = warmTimes[Math.ceil(warmTimes.length * 0.95) - 1];
  const writes = readdirSync(meshDir).filter((file) => statSync(join(meshDir, file)).mtimeMs !== meshTimes.get(file));
  check("100-space warm preparation makes zero registry writes and stays under 10 ms p95 over 20 runs",
    writes.length === 0 && warmP95 < 10,
    { warmP95, min: warmTimes[0], max: warmTimes.at(-1), writes });
  console.log(`  warm catalog preparation: p95 ${warmP95.toFixed(3)} ms, min ${warmTimes[0].toFixed(3)} ms, max ${warmTimes.at(-1)!.toFixed(3)} ms (20 runs, 100 spaces)`);
  const cacheFile = join(catalogDir, "space-catalogs.json");
  const makeStale = () => {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
    Object.values(cached.accounts as Record<string, { fetchedAt?: string }>)[0].fetchedAt = new Date(0).toISOString();
    writeFileSync(cacheFile, JSON.stringify(cached));
  };
  const staleTokenBase = tokenRequests;
  const staleCatalogBase = catalogRequests;
  makeStale();
  const refresh = await prepareIdpSpaceCatalogs({ dir: catalogDir, idpUrl: catalogIdp, validate });
  check("a stale snapshot makes one conditional request and accepts 304 only with prior bytes",
    refresh[0]?.state === "not-modified" && tokenRequests === staleTokenBase && catalogRequests === staleCatalogBase + 1 && conditional >= 1, refresh);
  makeStale();
  const beforeConcurrent = catalogRequests;
  await Promise.all([
    prepareIdpSpaceCatalogs({ dir: catalogDir, idpUrl: catalogIdp, validate }),
    prepareIdpSpaceCatalogs({ dir: catalogDir, idpUrl: catalogIdp, validate }),
  ]);
  check("two concurrent preparations coalesce behind the account lock", catalogRequests === beforeConcurrent + 1, catalogRequests);
  makeStale();
  failCatalog = true;
  const failed = await prepareIdpSpaceCatalogs({ dir: catalogDir, idpUrl: catalogIdp, validate });
  check("a failed refresh reports failure while retaining the previous snapshot", failed[0]?.state === "failed" && failed[0].snapshot !== undefined, failed);
  failCatalog = false;
  invalidCatalog = true;
  const invalid = await prepareIdpSpaceCatalogs({ dir: catalogDir, idpUrl: catalogIdp, force: true, validate });
  check("an invalid candidate refuses the whole update and retains the prior snapshot", invalid[0]?.state === "failed" && invalid[0].snapshot !== undefined, invalid);
  if (process.platform !== "win32") {
    check("catalog cache file is 0600", (statSync(cacheFile).mode & 0o777) === 0o600);
    check("catalog state directory is 0700", (statSync(catalogDir).mode & 0o777) === 0o700);
  }
  const legacyDir = mkdtempSync(join(tmpdir(), "cotal-login-catalog-legacy-"));
  saveIdpSession(legacyDir, catalogIdp, { token: "catalog-session", expiresAt: Date.now() / 1000 + 600 });
  const beforeLegacyToken = tokenRequests;
  const beforeLegacyCatalog = catalogRequests;
  invalidCatalog = false;
  const legacy = await prepareIdpSpaceCatalogs({ dir: legacyDir, idpUrl: catalogIdp, force: true, validate });
  check("a valid legacy cached login learns sub lazily and discovers the catalog without re-login",
    legacy[0]?.state === "updated" && tokenRequests === beforeLegacyToken + 1 && catalogRequests === beforeLegacyCatalog + 1 && loadIdpSession(legacyDir, catalogIdp)?.sub === "cat-user",
    { legacy, tokenRequests, catalogRequests, session: loadIdpSession(legacyDir, catalogIdp) });
  const { recordMesh, findMesh, getCurrent, removeCatalogMeshes, setCurrent } = await import("@cotal-ai/workspace");
  const switchedHome = mkdtempSync(join(tmpdir(), "cotal-login-catalog-switch-"));
  process.env.COTAL_HOME = switchedHome;
  saveIdpSession(switchedHome, catalogIdp, { token: "catalog-session", expiresAt: Date.now() / 1000 + 600, sub: "account-a" });
  const ownerA = deleteIdpSpaceCatalog(switchedHome, catalogIdp, "account-a");
  writeFileSync(join(switchedHome, "space-catalogs.json"), JSON.stringify({ ver: 1, accounts: {
    [ownerA]: { idpUrl: catalogIdp, issuer: "http://127.0.0.1", sub: "account-a", ownerKey: ownerA, advertised: true, catalogUrl: `${catalogBase}/catalog` },
  } }));
  recordMesh({ space: "a_one", server: "nats://127.0.0.1:55101", root: switchedHome, mode: "user", origin: "catalog", catalogOwner: ownerA, ts: new Date().toISOString() });
  recordMesh({ space: "a_two", server: "nats://127.0.0.1:55102", root: switchedHome, mode: "user", origin: "catalog", catalogOwner: ownerA, ts: new Date().toISOString() });
  recordMesh({ space: "manual_keep", server: "nats://127.0.0.1:55103", root: switchedHome, mode: "open", origin: "manual", ts: new Date().toISOString() });
  setCurrent("a_one");
  const removed = removeCatalogMeshes(deleteIdpSpaceCatalog(switchedHome, catalogIdp, "account-a"));
  saveIdpSession(switchedHome, catalogIdp, { token: "catalog-session", expiresAt: Date.now() / 1000 + 600, sub: "account-b" });
  check("switching accounts removes only the previous account's discovered spaces and invalidates its selection",
    removed.join(",") === "a_one,a_two" && findMesh("manual_keep")?.origin === "manual" && findMesh("a_one") === undefined && getCurrent() === undefined,
    { removed, manual: findMesh("manual_keep"), current: getCurrent() });
  const switched = JSON.parse(readFileSync(join(switchedHome, "space-catalogs.json"), "utf8"));
  check("the previous account's catalog state is gone after switching", Object.keys(switched.accounts).length === 0, switched);
  process.env.COTAL_HOME = priorHome;
  catalog.close();
}

// ---- the reject matrix ----
console.log("D) denies, expiry, revocation");
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
console.log("E) hostile-IdP responses");
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
