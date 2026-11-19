import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { cotalAuthProvider, ensurePinnedIdp, fetchSessionIdpJwt, loadIdpSession, verifyIdpToken, verifyToolResultHumanProof, withRemoteExchangeRetry } from "@cotal-ai/auth";
import { createSuite } from "@cotal-ai/smoke-kit";
import { recordMesh, userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";

const { check, finish } = createSuite();
const root = mkdtempSync(join(tmpdir(), "cotal-oidc-login-"));
const clientId = "test client+id";
const sub = "oidc-fixture-human";
const idType = "urn:ietf:params:oauth:token-type:id_token";
const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const jwks = { keys: [{ ...await exportJWK(publicKey), alg: "EdDSA", kid: "fixture" }] };
const seen: Array<{ path: string; grant: string; at: number }> = [];
const refreshes: string[] = [];
let variant = "ok";
let current = 0;
let revoked = false;
let pending = false;
let exchangeFailed = false;
let refreshStarted: (() => void) | undefined;
let meshProofs = 0;
let replaceLogin: (() => Promise<void>) | undefined;
const credentialMarker = "secret123";
const meshOwner = "u_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const refresh = () => `fixture-refresh+${current}`;
const access = () => `fixture-access+${current}`;
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};

const server = createServer((req, res) => {
  void serve(req, res).catch(() => json(res, 500, { error: "fixture_assertion" }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const issuer = `${origin}/realm`;
const keyUrl = `${origin}/keys`;

async function serve(req: IncomingMessage, res: ServerResponse) {
  const path = req.url!;
  if (req.method === "GET") {
    seen.push({ path, grant: "", at: Date.now() });
    if (path === "/realm/.well-known/openid-configuration") {
      if (variant === "redirect") { res.writeHead(307, { location: `${origin}/wrong` }).end(); return; }
      json(res, 200, { issuer: variant === "issuer" ? origin : issuer,
        device_authorization_endpoint: `${origin}/activate`, token_endpoint: `${origin}/oauth/token`,
        jwks_uri: variant === "keys" ? `${origin}/wrong` : keyUrl, revocation_endpoint: `${origin}/oauth/revoke` });
      return;
    }
    json(res, path === "/keys" ? 200 : 404, path === "/keys" ? jwks : {});
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  if (path === "/mesh/exchange") {
    const request = JSON.parse(body) as { actor: string; idpToken: string };
    assert.equal(request.actor, "cli");
    const account = await verifyIdpToken(request.idpToken, { issuer, audience: clientId, key: publicKey });
    assert.equal(account.sub, variant === "other-subject" ? "different-human" : sub);
    meshProofs++;
    if (replaceLogin) {
      const replace = replaceLogin;
      replaceLogin = undefined;
      await replace();
      json(res, 503, {});
      return;
    }
    json(res, 200, { token: "fixture-mesh-bearer", owner: meshOwner, grant: { scope: [], allowPublish: [], allowSubscribe: [], dmHistory: "own" } });
    return;
  }
  if (path === "/realm/device/code") {
    seen.push({ path, grant: "", at: Date.now() });
    assert.equal(req.headers["content-type"], "application/json");
    json(res, 400, { error: "invalid_request", error_description: "use form bodies" });
    return;
  }
  assert.match(req.headers["content-type"] ?? "", /^application\/x-www-form-urlencoded\b/);
  const form = new URLSearchParams(body);
  assert.equal(form.get("client_id"), clientId);
  const grant = form.get("grant_type") ?? "";
  seen.push({ path, grant, at: Date.now() });
  if (path === "/activate") {
    assert.equal(form.get("scope"), "openid offline_access");
    if (variant === "device-redirect") { res.writeHead(307, { location: `${origin}/wrong` }).end(); return; }
    if (variant === "error-detail") { json(res, 400, { error: "invalid_request", error_description: credentialMarker }); return; }
    pending = true;
    json(res, 200, { device_code: "fixture-device+code", user_code: "CODE-000", verification_uri: `${origin}/approve`, interval: 1, expires_in: 20 });
    return;
  }
  if (path === "/oauth/revoke") {
    assert.equal(form.get("token_type_hint"), "refresh_token");
    assert.equal(form.get("token"), refresh());
    revoked = true;
    json(res, 200, {});
    return;
  }
  assert.equal(path, "/oauth/token");
  switch (grant) {
    case "urn:ietf:params:oauth:grant-type:device_code":
      assert.equal(form.get("device_code"), "fixture-device+code");
      if (pending) {
        pending = false;
        if (variant === "poll-timeout") await new Promise(r => setTimeout(r, 1000));
        json(res, 400, { error: "authorization_pending" });
        return;
      }
      if (variant === "malformed-token") { res.writeHead(200, { "content-type": "application/json" }).end(credentialMarker); return; }
      json(res, 200, { access_token: access(), ...(variant !== "missing-refresh" ? { refresh_token: refresh() } : {}) });
      return;
    case "refresh_token": {
      const token = form.get("refresh_token")!;
      refreshes.push(token);
      if (revoked || token !== refresh()) { json(res, 400, { error: "invalid_grant" }); return; }
      refreshStarted?.();
      // Leave the lock held long enough for a second independent CLI process to contend.
      await new Promise(r => setTimeout(r, 250));
      current++;
      json(res, 200, { access_token: access(), refresh_token: refresh() });
      return;
    }
    case "urn:ietf:params:oauth:grant-type:token-exchange": {
      assert.equal(form.get("subject_token"), access());
      assert.equal(form.get("subject_token_type"), "urn:ietf:params:oauth:token-type:access_token");
      assert.equal(form.get("requested_token_type"), idType);
      assert.equal(form.get("audience"), clientId);
      assert.equal(form.get("scope"), "openid");
      if (exchangeFailed) { json(res, 503, {}); return; }
      const jwt = await new SignJWT({ amr: ["pwd"], preferred_username: "fixture" })
        .setProtectedHeader({ alg: "EdDSA", kid: "fixture" }).setIssuer(issuer).setIssuedAt().setExpirationTime("4m")
        .setSubject(variant === "other-subject" ? "different-human" : sub)
        .setAudience(variant === "audience" ? [clientId, "other"] : [clientId]).sign(privateKey);
      json(res, 200, { issued_token_type: idType, access_token: jwt });
      return;
    }
    default: json(res, 400, { error: "unsupported_grant_type" });
  }
}

const fixtureDir = (name: string) => mkdtempSync(join(root, `${name}-`));
const dir = fixtureDir("session");
const project = fixtureDir("project");
const cotal = async (home: string, args: string[], cwd = project, timeoutMs = 5000) => {
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_RUNTIME_DIR: join(home, "runtime"), DO_NOT_TRACK: "1", COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_IDP_TIMEOUT_MS: String(timeoutMs) };
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(import.meta.dirname, "../../../bin/cotal.ts"), ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const [status, signal] = await once(child, "close");
  return { status, signal, stdout, stderr };
};
const login = (home: string, standards = true, timeoutMs?: number) => cotal(home, ["login", "--idp", issuer, "--client-id", clientId, "--no-browser", "--plain", ...(standards ? ["--oidc"] : [])], project, timeoutMs);
const cache = (home: string) => existsSync(join(home, "idp-sessions.json"));
const proof = (home: string) => fetchSessionIdpJwt(home, issuer);

try {
  const legacy = await login(fixtureDir("default"), false);
  check("the default stays on the Better Auth JSON rail", legacy.status === 1 && /invalid_request/.test(legacy.stderr) && seen.map(row => row.path).join() === "/realm/device/code");

  for (const [mode, expected] of [["issuer", /discovery issuer does not match/], ["redirect", /redirects are refused/], ["device-redirect", /redirects are refused/], ["missing-refresh", /opaque refresh token/], ["audience", /multi-audience/]] as const) {
    variant = mode;
    const home = fixtureDir(mode);
    const start = seen.length;
    const result = await login(home);
    check(`refuse ${mode} without a cache or fallback request`, result.status === 1 && expected.test(result.stderr) && !cache(home)
      && seen.slice(start).every(row => row.path !== "/wrong" && row.path !== "/realm/device/code"), result.stderr);
  }
  for (const [mode, diagnostic] of [["error-detail", /refused the device authorization/], ["malformed-token", /unreadable response body/]] as const) {
    variant = mode;
    const home = fixtureDir(mode);
    const result = await login(home);
    check(`refuse ${mode} without logging credentials or caching a login`, result.status === 1 && diagnostic.test(result.stderr)
      && !`${result.stdout}${result.stderr}`.includes(credentialMarker) && !cache(home));
  }
  variant = "ok";
  const missingClient = await cotal(fixtureDir("no-client"), ["login", "--oidc", "--idp", issuer, "--no-browser", "--plain"]);
  check("require an explicit OAuth client for OIDC", missingClient.status === 1 && /requires an explicit custom issuer and public client/.test(missingClient.stderr), missingClient.stderr);
  variant = "poll-timeout";
  const delayedStart = seen.length;
  const delayed = await login(dir, true, 500);
  const delayedPolls = seen.slice(delayedStart).filter(row => row.grant.endsWith(":device_code"));
  check("OIDC device polling backs off after a timeout", delayed.status === 0 && delayedPolls.length === 2 && delayedPolls[1]!.at - delayedPolls[0]!.at >= 2300, delayed.stderr);
  variant = "ok";

  const start = seen.length;
  const signedIn = await login(dir);
  const stored = loadIdpSession(dir, issuer);
  const polls = seen.slice(start).filter(row => row.grant.endsWith(":device_code"));
  check("shipped CLI approves a form-only provider at its discovered endpoints", signedIn.status === 0 && signedIn.stdout.includes(sub)
    && signedIn.stderr.includes("CODE-000") && signedIn.stderr.includes(`${origin}/approve`)
    && polls.length === 2 && polls[1]!.at - polls[0]!.at >= 950, signedIn.stderr);
  check("cache holds only the refresh credential and no fabricated expiry", stored?.oidc?.refreshToken === refresh() && stored.token === undefined && stored.expiresAt === undefined && !signedIn.stdout.includes(refresh()));

  variant = "keys";
  await assert.rejects(proof(dir), /discovered JWKS URI changed/);
  check("changed discovery keys refuse before transmitting the refresh grant", refreshes.length === 0);
  variant = "ok";

  // The stock remote whoami path obtains and checks issuer authority through the mesh exchange.
  const stateDir = userAuthStateDir(project, "oidc-remote");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const sentinel = join(stateDir, "fixture.creds");
  writeFileSync(sentinel, "fixture-sentinel", { mode: 0o600 });
  const oldHome = process.env.COTAL_HOME;
  process.env.COTAL_HOME = dir;
  try {
    recordMesh({ space: "oidc-remote", root: project, origin: "manual", ts: new Date().toISOString(), mode: "user", server: "nats://127.0.0.1:1", userAuth: {
      provider: "cotal", idp: { url: issuer, issuer, audience: clientId }, remote: true, endpoints: { url: `${origin}/mesh` }, sentinelCredsPath: sentinel,
    } });
  } finally {
    if (oldHome === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = oldHome;
  }
  const whoami = () => cotal(dir, ["whoami", "--space", "oidc-remote", "--json"]);
  const outcomes = await Promise.all([whoami(), whoami()]);
  check("two shipped CLI processes serialize refresh and exchange verified proofs for the same mesh owner", outcomes.every(result => result.status === 0 && result.stdout.includes(meshOwner))
    && meshProofs === 2 && refreshes.join() === "fixture-refresh+0,fixture-refresh+1" && loadIdpSession(dir, issuer)?.oidc?.refreshToken === refresh(),
    outcomes.map(result => result.stderr || result.stdout));

  exchangeFailed = true;
  await assert.rejects(proof(dir), /token exchange failed/);
  check("a failed proof does not discard a refresh rotation", current === 3 && loadIdpSession(dir, issuer)?.oidc?.refreshToken === refresh());
  exchangeFailed = false;
  const controller = new AbortController();
  refreshStarted = () => controller.abort();
  await assert.rejects(fetchSessionIdpJwt(dir, issuer, controller.signal), /was cancelled/);
  refreshStarted = undefined;
  check("cancelling a sent refresh preserves its replacement but delivers no proof", current === 4 && loadIdpSession(dir, issuer)?.oidc?.refreshToken === refresh());
  variant = "other-subject";
  await assert.rejects(proof(dir), /different account subject/);
  check("refresh cannot switch subjects", loadIdpSession(dir, issuer)?.sub === sub);
  variant = "ok";
  const jwt = await proof(dir);
  const after = current;
  check("existing verifier accepts the exchanged proof, and the in-memory cache avoids repeat refresh", (await verifyIdpToken(jwt, { issuer, audience: clientId, key: publicKey })).sub === sub && await proof(dir) === jwt && after === current);
  await assert.rejects(verifyToolResultHumanProof(jwt, { issuer, audience: clientId, key: publicKey }), /requires a fresh signed password proof/);
  check("the exchange does not bypass the fresh-human proof rule", true);

  const originalHome = process.env.COTAL_HOME;
  process.env.COTAL_HOME = dir;
  try {
    const beforeRetry = meshProofs;
    replaceLogin = async () => {
      variant = "other-subject";
      assert.equal((await login(dir)).status, 0);
      assert.equal(loadIdpSession(dir, issuer)?.sub, "different-human");
    };
    const result = await withRemoteExchangeRetry(() => cotalAuthProvider.userCredentials({ store: workspaceSecretStore(project), dir: stateDir, space: "oidc-remote", actor: "cli" }))
      .then(() => "unexpected success", (error: unknown) => String(error));
    check("a remote credential retry refuses a replacement login instead of exchanging its proof", /cached login changed/.test(result)
      && meshProofs === beforeRetry + 1 && loadIdpSession(dir, issuer)?.sub === "different-human", result);
  } finally {
    if (originalHome === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = originalHome;
  }
  const cacheView = await cotal(dir, ["auth", "--json"]);
  check("account metadata remains readable without a reported session expiry", cacheView.status === 0 && cacheView.stdout.includes("different-human") && !cacheView.stdout.includes(refresh()));
  const logout = await cotal(dir, ["logout", "--idp", issuer, "--plain"]);
  check("logout revokes the latest refresh handle and removes the local login", logout.status === 0 && revoked && loadIdpSession(dir, issuer) === undefined, logout.stderr);

  mkdirSync(join(project, "untouched"));
  const noWrite = await cotal(fixtureDir("preflight"), ["up", "--user-auth", "--idp", issuer, "--idp-audience", clientId, "--idp-jwks-uri", `${origin}/wrong`, "--no-manager", "--json"], join(project, "untouched"));
  check("shipped up refuses an unavailable explicit JWKS before writing trust", noWrite.status === 2 && /did not serve usable JWKS/.test(noWrite.stdout) && !existsSync(join(project, "untouched", ".cotal")), noWrite.stderr || noWrite.stdout);
  const firstCheck = await cotalAuthProvider.preflightServer!({ space: "oidc-remote", dir: stateDir, idpUrl: issuer, idpPins: { audience: clientId, jwksUri: keyUrl } });
  check("first-enable provider preflight reads the explicit keys successfully", firstCheck.ok);
  const pinned = ensurePinnedIdp(stateDir, issuer, { audience: clientId, jwksUri: keyUrl });
  check("the server pins the issuer path and explicit JWKS and audience", pinned.issuer === issuer && pinned.jwksUri === keyUrl && pinned.audience === clientId);
  assert.throws(() => ensurePinnedIdp(stateDir, issuer, { audience: "other", jwksUri: keyUrl }), /cannot be changed/);
  check("the original pins survive an attempt to replace the audience", ensurePinnedIdp(stateDir).audience === clientId);
  finish();
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()));
}
