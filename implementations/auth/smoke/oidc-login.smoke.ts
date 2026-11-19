import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquireLock, createSpaceAuth } from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
import { assertUserAuthInfo, checkUserBundle, recordMesh, userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { composeUserBundle, cotalAuthProvider, deriveOwnerForIdpSubject, establishIdpSession, fetchIdpJwt, finalizeUserBundleEndpoint, grantActor, IdpLoginCancelled, IdpUnreachableError, loadIdpSession, loadOwnerSecret, loadPinnedIdp, pinnedJwksResolver, verifyIdpToken, verifyToolResultHumanProof } from "../src/index.js";

const { check, finish } = createSuite();
const here = join(import.meta.dirname, "..", "..", "..");
const root = mkdtempSync(join(tmpdir(), "cotal-oidc-login-"));
const newHome = () => mkdtempSync(join(root, "home-"));
const accessPrefix = "oidc-access-canary-";
const refreshPrefix = "oidc-refresh-canary-";
const subject = "oidc-user";
const clientId = "cotal-smoke";
const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code";
const exchangeGrant = "urn:ietf:params:oauth:grant-type:token-exchange";
const accessType = "urn:ietf:params:oauth:token-type:access_token";
const idType = "urn:ietf:params:oauth:token-type:id_token";
const key = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(key.publicKey), kid: "oidc-test", alg: "EdDSA" };
const requests: string[] = [];
const refreshed: number[] = [];
const revoked: number[] = [];
const owner = deriveOwnerForIdpSubject(new Uint8Array(32).fill(1), "fixture", subject);
let meshProofs = 0;
let meshRedirect = false;
let approvalPending = false, discoveryRedirect = false, tokenRedirect = false, keysRedirect = false, wrongIssuer = false, multiAudience = false;
let missingRefresh = false, omitRotation = false, rejectExchange = false, changeSubject = false, blankSubject = false, noRevocation = false;
let refreshGeneration = 0, newestRefresh = 0, accessGeneration = 0, activeAccess: string | undefined;
let onRotation: (() => Promise<void>) | undefined;
let onKeys: (() => void) | undefined;
let slowExchange = false;
let supersededExchanges = 0;
let jwks: object[] = [jwk];
let deviceFragment = false;

const server = createServer(async (req, res) => {
  const route = `${req.method} ${req.url}`;
  requests.push(route);
  const send = (status: number, body: object) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const redirect = () => res.writeHead(307, { location: `${origin}/redirect-target` }).end();
  try {
    if (route === "GET /issuer/.well-known/openid-configuration") {
      if (discoveryRedirect) return redirect();
      return send(200, { issuer: wrongIssuer ? `${issuer}wrong` : issuer, device_authorization_endpoint: `${origin}/oauth/device${deviceFragment ? "#" : ""}`, token_endpoint: `${origin}/oauth/token`, jwks_uri: keysUrl, ...(noRevocation ? {} : { revocation_endpoint: `${origin}/oauth/revoke` }) });
    }
    if (route === "GET /oauth/keys") {
      onKeys?.();
      return keysRedirect ? redirect() : send(200, { keys: jwks });
    }
    if (route === "POST /mesh/exchange") {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (meshRedirect) return redirect();
      const { idpToken, actor } = JSON.parse(body) as { idpToken: string; actor: string };
      if (actor !== "cli" || (await verifyIdpToken(idpToken, pin)).sub !== subject) return send(401, { error: "proof refused" });
      meshProofs++;
      return send(200, { token: "unused-by-whoami", owner, grant: { scope: [], allowSubscribe: ["general"], allowPublish: [], dmHistory: "own" } });
    }
    if (!req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded"))
      return send(400, { error: "invalid_request", error_description: "form bodies required" });
    let body = "";
    for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    if (form.get("client_id") !== clientId) return send(400, { error: "invalid_client" });
    if (route === "POST /oauth/device") {
      assert.equal(form.get("scope"), "openid offline_access");
      return send(200, { device_code: "device-fixture", user_code: "DISPLAY-CODE", verification_uri: `${origin}/verify`, expires_in: 30, interval: 1 });
    }
    if (route === "POST /oauth/revoke") {
      assert.equal(form.get("token_type_hint"), "refresh_token");
      if (form.get("token") !== `${refreshPrefix}${newestRefresh}`) return send(400, { error: "invalid_request" });
      revoked.push(newestRefresh);
      activeAccess = undefined;
      newestRefresh = 0;
      return send(200, {});
    }
    if (route !== "POST /oauth/token") return send(404, {});
    if (tokenRedirect) return redirect();
    const grantType = form.get("grant_type");
    if (slowExchange && grantType === exchangeGrant) await delay(900);
    const access = () => (activeAccess = `${accessPrefix}${++accessGeneration}`);
    switch (grantType) {
      case deviceGrant:
        assert.equal(form.get("device_code"), "device-fixture");
        if (approvalPending) { approvalPending = false; return send(400, { error: "authorization_pending" }); }
        newestRefresh = ++refreshGeneration;
        return send(200, { token_type: "Bearer", access_token: access(), ...(missingRefresh ? {} : { refresh_token: `${refreshPrefix}${newestRefresh}` }) });
      case "refresh_token":
        if (!newestRefresh || form.get("refresh_token") !== `${refreshPrefix}${newestRefresh}`)
          return send(400, { error: "invalid_grant", error_description: `${refreshPrefix}not-for-diagnostics` });
        refreshed.push(newestRefresh);
        if (!omitRotation) newestRefresh = ++refreshGeneration;
        await onRotation?.();
        return send(200, { token_type: "bearer", access_token: access(), ...(omitRotation ? {} : { refresh_token: `${refreshPrefix}${newestRefresh}` }) });
      case exchangeGrant: {
        assert.equal(form.get("subject_token_type"), accessType);
        assert.equal(form.get("requested_token_type"), idType);
        assert.equal(form.get("audience"), clientId);
        assert.equal(form.get("scope"), "openid");
        const at = form.get("subject_token") ?? "";
        if (at !== activeAccess) supersededExchanges++;
        if (rejectExchange || at !== activeAccess)
          return send(400, { error: "invalid_grant", error_description: at });
        const jwt = await new SignJWT({ preferred_username: "oidc-human", amr: ["pwd"] })
          .setProtectedHeader({ alg: "EdDSA", kid: jwk.kid })
          .setIssuer(issuer).setAudience(multiAudience ? [clientId, "other-app"] : [clientId])
          .setSubject(blankSubject ? " \t" : changeSubject ? "other-subject" : subject).setIssuedAt().setExpirationTime("5m").sign(key.privateKey);
        return send(200, { token_type: "N_A", issued_token_type: idType, access_token: jwt });
      }
      default: return send(400, { error: "unsupported_grant_type" });
    }
  } catch {
    send(500, { error: "test_fixture_request_did_not_match" });
  }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const issuer = `${origin}/issuer/`;
const keysUrl = `${origin}/oauth/keys`;
const pin = { issuer, audience: clientId, key: pinnedJwksResolver(keysUrl) };
const args = ["--idp", issuer, "--client-id", clientId, "--no-browser", "--plain"];
const envFor = (home: string) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("COTAL_"))), HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: join(home, "xdg"), XDG_RUNTIME_DIR: join(home, "run"), COTAL_SKIP_CONNECTOR_SEED: "1" });
const node = (home: string, args: string[], cwd = here) => new Promise<{ code: number | string; output: string }>(resolve => {
  execFile(process.execPath, args, { cwd, env: envFor(home), timeout: 20_000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? (error ? "interrupted" : 0), output: stdout + stderr }));
});
const cliAt = (home: string, cwd: string, ...args: string[]) => node(home, ["--import", import.meta.resolve("tsx"), join(here, "bin/cotal.ts"), ...args], cwd);
const cli = (home: string, ...args: string[]) => cliAt(home, home, ...args);
const login = (home: string) => cli(home, "login", "--oidc", ...args);
const cache = (home: string) => join(home, "idp-sessions.json");
const refreshChild = (home: string) => node(home, ["--input-type=module", "-e", `
  import { fetchIdpJwt, requireIdpSession, verifyIdpToken, pinnedJwksResolver } from './implementations/auth/dist/index.js';
  const [dir, issuer, audience, jwks] = process.argv.slice(1);
  const session = requireIdpSession(dir, issuer);
  const jwt = await fetchIdpJwt(issuer, session, undefined, dir);
  const result = await verifyIdpToken(jwt, { issuer, audience, key: pinnedJwksResolver(jwks) });
  console.log(result.sub);
`, home, issuer, clientId, keysUrl]);
const refreshLocal = (home: string, signal?: AbortSignal) => fetchIdpJwt(issuer, loadIdpSession(home, issuer)!, signal, home);
const assertNoTokens = (output: string) => {
  assert.equal(output.includes(accessPrefix) || output.includes(refreshPrefix) || output.includes("eyJ"), false, "a token reached operator output");
};

function recordForHome(home: string, entry: Parameters<typeof recordMesh>[0]): void {
  const before = process.env.COTAL_HOME;
  process.env.COTAL_HOME = home;
  try { recordMesh(entry); }
  finally {
    if (before === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = before;
  }
}

function registerRemote(home: string, idp: ReturnType<typeof assertUserAuthInfo>["idp"] = { url: issuer.slice(0, -1), issuer, audience: clientId }): string {
  const space = "oidc-remote";
  const project = mkdtempSync(join(root, "remote-"));
  const dir = userAuthStateDir(project, space);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sentinelCredsPath = join(dir, "sentinel.creds");
  writeFileSync(sentinelCredsPath, "unused-by-whoami", { mode: 0o600 });
  recordForHome(home, { space, root: project, server: "nats://127.0.0.1:1", ts: new Date().toISOString(), mode: "user", origin: "manual",
    userAuth: { provider: "cotal", remote: true, idp, endpoints: { url: `${origin}/mesh` }, sentinelCredsPath } });
  return project;
}

try {
  const legacy = await cli(newHome(), "login", ...args);
  check("without --oidc the legacy request is rejected by a form-only provider, without discovery", legacy.code === 1 && /invalid_request/.test(legacy.output) && requests.splice(0).join() === "POST /issuer/device/code");

  const home = newHome();
  approvalPending = true;
  const signedIn = await login(home);
  check("shipped login discovers a pathful issuer, polls pending approval, and signs in without a complete verification link", signedIn.code === 0 && /Signed in/.test(signedIn.output) && /DISPLAY-CODE/.test(signedIn.output) && requests.splice(0).join() === "GET /issuer/.well-known/openid-configuration,POST /oauth/device,POST /oauth/token,POST /oauth/token,POST /oauth/token,GET /oauth/keys");
  assertNoTokens(signedIn.output);
  const first = newestRefresh;
  const raw = readFileSync(cache(home), "utf8");
  check("the private cache contains only the opaque refresh credential", raw.includes(`${refreshPrefix}${first}`) && !raw.includes(accessPrefix) && !raw.includes("eyJ") && (process.platform === "win32" || (statSync(cache(home)).mode & 0o777) === 0o600));

  const project = registerRemote(home);
  const whoami = () => cliAt(home, project, "whoami", "--space", "oidc-remote", "--plain");
  slowExchange = true;
  const countParallel = 6;
  const concurrent = await Promise.all(Array.from({ length: countParallel }, whoami));
  slowExchange = false;
  const expectedRotations = Array.from({ length: countParallel }, (_, i) => first + i);
  check("six shipped whoami processes succeed when refresh invalidates the previous access token", concurrent.every(r => r.code === 0 && r.output.includes(`${owner}.cli`)) && meshProofs === countParallel && refreshed.join() === expectedRotations.join() && newestRefresh === first + countParallel && supersededExchanges === 0, { codes: concurrent.map(r => r.code), successes: meshProofs, rotations: refreshed.length, supersededExchanges });
  concurrent.forEach(r => assertNoTokens(r.output));

  const jwt = await refreshLocal(home);
  const count = refreshed.length;
  check("the process reuses a bounded proof without another rotation", jwt === await refreshLocal(home) && refreshed.length === count);
  check("the same proof passes the unchanged mesh verifier", (await verifyIdpToken(jwt, pin)).sub === subject);
  await assert.rejects(() => verifyToolResultHumanProof(jwt, pin), /fresh signed password proof/);
  check("ordinary OIDC proof does not earn fresh-password authority", true);

  meshRedirect = true;
  requests.length = 0;
  const beforeRedirect = meshProofs;
  const redirectedMesh = await whoami();
  meshRedirect = false;
  check("a mesh exchange redirect sends no proof to its target", !redirectedMesh.output.includes(`${owner}.cli`) && meshProofs === beforeRedirect && requests.includes("POST /mesh/exchange") && !requests.some(path => path.endsWith("/redirect-target")));
  assertNoTokens(redirectedMesh.output);

  const beforeLogout = newestRefresh;
  const cached = loadIdpSession(home, issuer)!;
  const signedOut = await cli(home, "logout", "--idp", issuer, "--plain");
  check("shipped logout revokes the latest rotation and clears it locally", signedOut.code === 0 && revoked.at(-1) === beforeLogout && !loadIdpSession(home, issuer));
  assertNoTokens(signedOut.output);
  await assert.rejects(() => fetchIdpJwt(issuer, cached, undefined, home), /sign-in changed/);
  check("a removed session cannot reuse a cached proof", true);

  for (const [name, toggle, expected, hits] of [
    ["discovery issuer mismatch", (v: boolean) => { wrongIssuer = v; }, /issuer does not match/, 1],
    ["discovery redirect", (v: boolean) => { discoveryRedirect = v; }, /redirects are refused/, 1],
    ["empty device endpoint fragment", (v: boolean) => { deviceFragment = v; }, /device_authorization_endpoint.*without.*a fragment/, 1],
    ["token redirect", (v: boolean) => { tokenRedirect = v; }, /redirects are refused/, 3],
    ["missing refresh token", (v: boolean) => { missingRefresh = v; }, /opaque refresh token/, 3],
    ["multi-audience proof", (v: boolean) => { multiAudience = v; }, /multi-audience session proof is rejected/, 5],
    ["blank proof subject", (v: boolean) => { blankSubject = v; }, /subject|sub\b/, 5],
  ] as const) {
    const dir = newHome();
    requests.length = 0;
    toggle(true);
    const bad = await login(dir);
    toggle(false);
    check(`${name} refuses without caching or trying a different provider protocol`, bad.code === 1 && expected.test(bad.output) && !existsSync(cache(dir)) && requests.length === hits && !requests.some(path => /redirect-target|\/device\/code/.test(path)));
    assertNoTokens(bad.output);
  }

  const queued = newHome();
  const commitLock = acquireLock(join(queued, "idp-sessions.lock"));
  const cancelCommit = new AbortController();
  let keysReached!: () => void;
  const proofInFlight = new Promise<void>(resolve => { keysReached = resolve; });
  onKeys = keysReached;
  const queuedLogin = establishIdpSession({ dir: queued, idpUrl: issuer, clientId, oidc: true, signal: cancelCommit.signal, onPrompt() {} }).catch((error: unknown) => error);
  try {
    assert.equal(await Promise.race([proofInFlight.then(() => true), queuedLogin.then(() => false)]), true);
    await delay(150);
    cancelCommit.abort();
    const cancelled = await Promise.race([queuedLogin, delay(1000, undefined, { ref: false })]);
    check("cancelled sign-in exits while its commit lock is still held and writes nothing", cancelled instanceof IdpLoginCancelled && !existsSync(cache(queued)));
  } finally {
    onKeys = undefined;
    commitLock.release();
    await queuedLogin;
  }

  const recover = newHome();
  await establishIdpSession({ dir: recover, idpUrl: issuer, clientId, oidc: true, onPrompt() {} });
  // Hold the real cache lock while proof readers try to enter. No provider request may start.
  const lock = acquireLock(join(recover, "idp-sessions.lock"));
  try {
    requests.length = 0;
    const cancelledWait = await refreshLocal(recover, AbortSignal.timeout(100)).catch((error: unknown) => error);
    check("a cancelled waiter leaves without acquiring the cache lock or refreshing", cancelledWait instanceof IdpLoginCancelled && requests.length === 0, { error: cancelledWait instanceof Error ? cancelledWait.constructor.name : typeof cancelledWait });
    const previousTimeout = process.env.COTAL_IDP_TIMEOUT_MS;
    process.env.COTAL_IDP_TIMEOUT_MS = "1";
    try {
      const timedOut = await refreshLocal(recover).catch((error: unknown) => error);
      check("lock contention times out with a typed retry and no lock path or provider request", timedOut instanceof IdpUnreachableError && /busy.*retry/i.test(timedOut.message) && !timedOut.message.includes(recover) && requests.length === 0, { error: timedOut instanceof Error ? timedOut.constructor.name : typeof timedOut });
    } finally {
      if (previousTimeout === undefined) delete process.env.COTAL_IDP_TIMEOUT_MS;
      else process.env.COTAL_IDP_TIMEOUT_MS = previousTimeout;
    }
  } finally { lock.release(); }
  rejectExchange = true;
  await assert.rejects(() => refreshLocal(recover), /^Error: OIDC token exchange failed \(HTTP 400\)$/);
  rejectExchange = false;
  const afterRefusal = newestRefresh;
  changeSubject = true;
  await assert.rejects(() => refreshLocal(recover), /different subject/);
  changeSubject = false;
  check("a failed exchange and a changed subject do not lose an accepted rotation", refreshed.at(-1) === afterRefusal);
  const abort = new AbortController();
  onRotation = async () => { abort.abort(); };
  await assert.rejects(() => refreshLocal(recover, abort.signal), IdpLoginCancelled);
  onRotation = undefined;
  const afterCancellation = newestRefresh;
  omitRotation = true;
  const recovered = await refreshChild(recover);
  check("cancelling an in-flight rotation keeps its replacement and omission does not erase it", recovered.code === 0 && refreshed.at(-1) === afterCancellation && newestRefresh === afterCancellation);
  omitRotation = false;
  activeAccess = undefined;
  newestRefresh = 0;
  const rejected = await refreshChild(recover);
  check("revoked refresh refuses with the explicit OIDC recovery command and no token", rejected.code === 1 && rejected.output.includes("cotal login --oidc") && !rejected.output.includes(refreshPrefix));

  const local = newHome();
  noRevocation = true;
  assert.equal((await login(local)).code, 0);
  const notRevoked = await cli(local, "logout", "--idp", issuer, "--plain");
  check("provider without revocation refuses server logout and keeps the session", notRevoked.code !== 0 && /did not advertise a revocation endpoint/.test(notRevoked.output) && Boolean(loadIdpSession(local, issuer)));
  requests.length = 0;
  check("explicit local logout performs no network request", (await cli(local, "logout", "--idp", issuer, "--local", "--plain")).code === 0 && !loadIdpSession(local, issuer) && requests.length === 0);

  const workspace = mkdtempSync(join(root, "workspace-"));
  const manifest = join(workspace, "cotal.yaml");
  writeFileSync(manifest, "apiVersion: cotal/v1\nkind: Mesh\nspace: oidc-smoke\nbroker:\n  auth: user\nchannels: {}\n");
  const up = (audience: string, ...flags: string[]) => cliAt(local, workspace, "up", "-f", manifest, "--dry-run", "--idp", issuer, "--idp-audience", audience, ...flags);
  const incomplete = await up(clientId);
  check("first-enable CLI refuses an incomplete explicit pin before contacting the provider", incomplete.code !== 0 && /--idp-jwks-uri/.test(incomplete.output) && !requests.length);
  for (const [name, invalidId] of [["space", `${clientId} invalid`], ["C1 control", `${clientId}\u0085invalid`]] as const) {
    const badLogin = await cli(local, "login", "--oidc", "--idp", issuer, "--client-id", invalidId, "--no-browser");
    const refusedAudience = await up(invalidId, "--idp-jwks-uri", keysUrl);
    const audiencePaths = requests.splice(0);
    check(`login and first enable refuse a client ID containing a ${name} before a provider request`, badLogin.code === 1 && refusedAudience.code === 1 && !audiencePaths.length, { login: badLogin.code, up: refusedAudience.code, paths: audiencePaths });
  }
  const refusedFragment = await up(clientId, "--idp-jwks-uri", `${keysUrl}#`);
  const fragmentPaths = requests.splice(0);
  check("first enable refuses an empty explicit JWKS fragment before any provider request", refusedFragment.code === 1 && !fragmentPaths.length, { code: refusedFragment.code, paths: fragmentPaths });
  for (const [description, keys] of [["an empty set", []], ["only an encryption key", [{ ...jwk, use: "enc" }]], ["only a malformed Ed25519 key", [{ ...jwk, x: "AA" }]]] as const) {
    jwks = [...keys];
    const refused = await up(clientId, "--idp-jwks-uri", keysUrl);
    const paths = requests.splice(0);
    check(`first enable refuses ${description}`, refused.code === 2 && /no usable Ed25519 verification key/.test(refused.output) && paths.join() === "GET /oauth/keys", { code: refused.code, paths });
  }
  jwks = [jwk];
  keysRedirect = true;
  const redirect = await up(clientId, "--idp-jwks-uri", keysUrl);
  const redirectPaths = requests.splice(0);
  check("first-enable CLI probes the explicit JWKS and refuses its redirect", redirect.code !== 0 && /redirects are refused/.test(redirect.output) && redirectPaths.join() === "GET /oauth/keys", { ...redirect, paths: redirectPaths });
  keysRedirect = false;
  const preview = await up(clientId, "--idp-jwks-uri", keysUrl);
  const previewPaths = requests.splice(0);
  check("first-enable CLI accepts the explicit JWKS without assuming a Better Auth path", preview.code === 0 && previewPaths.join() === "GET /oauth/keys", { ...preview, paths: previewPaths });

  const space = "oidc-smoke";
  const auth = await createSpaceAuth(space);
  const dir = userAuthStateDir(workspace, space);
  const idpTrust = { audience: clientId, jwksUri: keysUrl };
  const prepared = await cotalAuthProvider.prepareServer({ space, dir, store: workspaceSecretStore(workspace), operatorSeed: auth.operator.seed,
    account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed }, idpUrl: issuer, idpTrust });
  const url = issuer.slice(0, -1);
  assert.deepEqual(loadPinnedIdp(dir), { url, issuer, ...idpTrust, loginMode: "oidc" });
  const publicAuth = assertUserAuthInfo(prepared.publicAuth);
  assert.deepEqual(publicAuth.idp, { url, issuer, audience: clientId, loginMode: "oidc" });
  check("server preparation retains the exact issuer and explicit audience and JWKS", requests.splice(0).join() === "GET /oauth/keys");
  const preflight = cotalAuthProvider.preflightServer!;
  assert.deepEqual(await preflight({ space, dir }), { ok: true });
  assert.deepEqual(await preflight({ space, dir, idpUrl: issuer, idpTrust }), { ok: true });
  for (const input of [{ idpUrl: url, idpTrust }, { idpUrl: issuer, idpTrust: { ...idpTrust, audience: "another-client" } }, { idpUrl: issuer, idpTrust: { ...idpTrust, jwksUri: `${origin}/another-key-set` } }]) {
    const verdict = await preflight({ space, dir, ...input });
    assert.ok(!verdict.ok && verdict.reason === "conflict");
  }
  check("existing pins refuse all explicit trust changes before doing any network work", requests.length === 0);

  recordForHome(local, { space, root: workspace, server: "nats://127.0.0.1:1", ts: new Date().toISOString(), mode: "user", origin: "manual", userAuth: publicAuth });
  const manager = () => cliAt(local, workspace, "manager", "start", "--space", space, "--plain");
  const signedOutManager = await manager();
  const oidcRemedy = `cotal login --oidc --idp '${issuer}' --client-id ${clientId}`;
  check("manager start recovers a signed-out OIDC space using its exact issuer and client ID", signedOutManager.code === 2 && signedOutManager.output.includes("AUTH_REQUIRED") && signedOutManager.output.includes(oidcRemedy) && requests.length === 0, { code: signedOutManager.code, output: signedOutManager.output });
  assert.equal((await login(local)).code, 0);
  const ownerSecret = await loadOwnerSecret(workspaceSecretStore(workspace), space);
  assert.ok(ownerSecret);
  grantActor(dir, { owner: deriveOwnerForIdpSubject(ownerSecret, issuer, subject), actor: "cli", scope: [], allowSubscribe: ["general"], allowPublish: [] });
  newestRefresh = 0;
  requests.length = 0;
  const revokedManager = await manager();
  check("manager start recovers a revoked OIDC sign-in with the same command before launch", revokedManager.code === 2 && revokedManager.output.includes("AUTH_REQUIRED") && revokedManager.output.includes("expired or was revoked") && revokedManager.output.includes(oidcRemedy) && requests.join() === "POST /oauth/token", { code: revokedManager.code, output: revokedManager.output, requests });

  const bundle = composeUserBundle({ space: "oidc-remote", server: "tls://127.0.0.1:1", idp: publicAuth.idp, sentinelCreds: "fixture" });
  finalizeUserBundleEndpoint(bundle, `${origin}/mesh`);
  const exported = checkUserBundle(JSON.stringify(bundle));
  assert.ok(exported.ok);
  assert.deepEqual(exported.value.userAuth.idp, publicAuth.idp);
  const remoteHome = newHome();
  const remoteRoot = registerRemote(remoteHome, exported.value.userAuth.idp);
  const missingRemote = await cliAt(remoteHome, remoteRoot, "manager", "start", "--space", "oidc-remote", "--plain");
  check("exported OIDC mode survives registration and gives a remote manager the same sign-in command", missingRemote.code === 2 && missingRemote.output.includes("AUTH_REQUIRED") && missingRemote.output.includes(oidcRemedy), { code: missingRemote.code, output: missingRemote.output });
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()));
}
finish();
