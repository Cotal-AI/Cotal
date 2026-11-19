import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createSpaceAuth, isReachable, mintCreds, mintLifecycleUid, newIdentity, serverConfig, setupSpaceStreams } from "@cotal-ai/core";
import { awaitBrokerReady, createSuite, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { assertUserAuthInfo, authDir, recordMesh, saveSpaceAuth, userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";
import { cotalAuthProvider, fetchStoredIdpJwt, loadIdpSession, loadPinnedIdp, pinnedJwksResolver, verifyIdpToken, verifyToolResultHumanProof } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const scratch = mkdtempSync(join(tmpdir(), "cotal-oidc-login-"));
const home = join(scratch, "home"), root = join(scratch, "project"), store = join(home, "cotal");
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !key.startsWith("NATS_"))),
  HOME: home, USERPROFILE: home, COTAL_HOME: store,
  XDG_CONFIG_HOME: join(home, "config"), XDG_RUNTIME_DIR: join(home, "run"),
  COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1",
};
for (const dir of [join(root, ".cotal"), env.XDG_CONFIG_HOME, env.XDG_RUNTIME_DIR]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const cli = resolve(import.meta.dirname, "../../../bin/dist/cotal.js");
const exec = promisify(execFile);
const run = async (...args: string[]) => {
  try { const out = await exec(process.execPath, args, { env, cwd: root, timeout: 30_000 }); return { ...out, code: 0 }; }
  catch (error) {
    const e = error as { code?: number | string; stdout: string; stderr: string };
    if (typeof e.code !== "number") throw error;
    return { stdout: e.stdout, stderr: e.stderr, code: e.code };
  }
};
const cmd = (...args: string[]) => run(cli, ...args);
const { check, finish } = createSuite();
const key = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(key.publicKey), kid: "local-oidc-smoke" };
const clientId = "cotal-native", audience = "pinned-audience", subject = "local-human";
const ID = "urn:ietf:params:oauth:token-type:id_token";
const GRANT = "urn:ietf:params:oauth:grant-type:";
let origin = "", issuer = "";
let active = 0, revoked = false, tokenRequests = 0, proofRequests = 0, unrelated = 0;
let discoveryMode: "normal" | "redirect" | "foreign" | "mismatch" = "normal";
let jwksRedirect = false, exchangeMode: "normal" | "redirect" | "extra-audience" | "short" | "different-subject" = "normal";
const acceptedRefreshes: number[] = [];
const unexpected: string[] = [];
const issuedAccess = () => `loopback-access-${active}`;
const refresh = () => `loopback-refresh-${active}`;

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (status: number, body: object) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const redirect = () => { res.writeHead(307, { location: `${origin}/redirect-target` }); res.end(); };
  const grant = () => send(200, { access_token: issuedAccess(), refresh_token: refresh(), token_type: "Bearer", expires_in: 600 });
  const error = (code: string) => send(400, { error: code });
  if (req.url === "/tenant/.well-known/openid-configuration" && req.method === "GET") {
    if (discoveryMode === "redirect") return redirect();
    return send(200, {
      issuer: discoveryMode === "mismatch" ? `${issuer}/unexpected` : issuer,
      device_authorization_endpoint: `${origin}/protocol/device`,
      token_endpoint: `${discoveryMode === "foreign" ? origin.replace("127.0.0.1", "127.0.0.2") : origin}/protocol/token`,
      revocation_endpoint: `${origin}/protocol/revoke`,
      jwks_uri: `${origin}/keys/provider`,
    });
  }
  if (req.url === "/keys/provider") { if (jwksRedirect) return redirect(); return send(200, { keys: [jwk] }); }
  if (req.url === "/tenant/device/code") { unrelated++; return error("invalid_request"); }
  if (req.url === "/redirect-target") { unrelated++; return send(500, {}); }
  const data: Buffer[] = [];
  for await (const b of req) data.push(b);
  if (req.method !== "POST" || !req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) return error("invalid_request");
  const form = new URLSearchParams(Buffer.concat(data).toString());
  assert.ok(form.get("client_id") === clientId, "uses the configured public client ID");
  if (req.url === "/protocol/device") {
    assert.equal(form.get("scope"), "openid offline_access");
    return send(200, { device_code: "demo-device", user_code: "DEMO", verification_uri: `${origin}/approve`, expires_in: 30, interval: 1 });
  }
  if (req.url === "/protocol/revoke") {
    assert.ok(form.get("token") === refresh(), "revokes the current generation, not a stale refresh token");
    assert.equal(form.get("token_type_hint"), "refresh_token");
    revoked = true;
    return send(200, {});
  }
  assert.equal(req.url, "/protocol/token");
  tokenRequests++;
  switch (form.get("grant_type")) {
    case `${GRANT}device_code`:
      assert.equal(form.get("device_code"), "demo-device");
      return grant();
    case "refresh_token": {
      const accepted = active;
      const wanted = refresh();
      await wait(200);
      if (revoked || form.get("refresh_token") !== wanted || active !== accepted) return error("invalid_grant");
      acceptedRefreshes.push(active++);
      return grant();
    }
    case `${GRANT}token-exchange`: {
      proofRequests++;
      assert.equal(form.get("subject_token_type"), "urn:ietf:params:oauth:token-type:access_token");
      assert.equal(form.get("requested_token_type"), ID);
      assert.equal(form.get("audience"), audience);
      assert.ok(form.get("subject_token") === issuedAccess(), "uses the fresh access token, never the refresh token");
      if (exchangeMode === "redirect") return redirect();
      const aud = exchangeMode === "extra-audience" ? [audience, "project"] : [audience];
      const proof = await new SignJWT({ azp: audience, amr: ["pwd"] }).setProtectedHeader({ alg: "EdDSA", kid: jwk.kid }).setIssuer(issuer)
        .setAudience(aud).setSubject(exchangeMode === "different-subject" ? "another-user" : subject).setIssuedAt()
        .setExpirationTime(exchangeMode === "short" ? "20s" : "2m").sign(key.privateKey);
      return send(200, { access_token: proof, issued_token_type: ID, token_type: "N_A" });
    }
    default: return error("unsupported_grant_type");
  }
}

const server = createServer((req, res) => { void serve(req, res).catch((e: unknown) => { unexpected.push((e as Error).message); res.writeHead(500).end(); }); });
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
issuer = `${origin}/tenant`;
const login = () => cmd("login", "--oidc", "--idp", issuer, "--client-id", clientId, "--audience", audience, "--no-browser", "--plain");
const space = "oidc-smoke";
const pinPath = userAuthStateDir(root, space, { readOnly: true });
const idpPins = { audience, jwksUri: `${origin}/keys/provider` };
const record = () => loadIdpSession(store, issuer);

/** Native test broker and auth child. Neither is managed by an operating-system service. */
async function verifyMeshUse(): Promise<void> {
  const auth = await createSpaceAuth(space);
  saveSpaceAuth(authDir(root), auth);
  const serverInput = { space, dir: pinPath, idpUrl: issuer, idpPins,
    operatorSeed: auth.operator.seed, account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed }, store: workspaceSecretStore(root) };
  const prepared = await cotalAuthProvider.prepareServer(serverInput);
  const pinned = loadPinnedIdp(pinPath)!;
  check("first enable persists the exact issuer and explicit audience and JWKS", pinned.issuer === issuer && pinned.audience === audience && pinned.jwksUri === idpPins.jwksUri);
  const conflict = await cotalAuthProvider.preflightServer!({ ...serverInput, idpPins: { ...idpPins, audience: "changed" } });
  check("a later start cannot change the verification pins", !conflict.ok && conflict.reason === "conflict" && loadPinnedIdp(pinPath)?.audience === audience);

  const port = await pickFreePort();
  const servers = `nats://127.0.0.1:${port}`;
  const brokerRoot = mkdtempSync(join(scratch, SMOKE_BROKER_TOKEN));
  const conf = join(brokerRoot, "server.conf");
  writeFileSync(conf, serverConfig(auth, [auth], { port, transport: { kind: "plaintext" }, storeDir: brokerRoot, extraAccounts: prepared.extraAccounts }), { mode: 0o600 });
  const broker = spawn("nats-server", ["-c", conf], { stdio: ["ignore", "ignore", "pipe"] });
  const release = teardownOnSignal(broker, brokerRoot);
  let brokerOutput = "";
  broker.stderr.on("data", (b: Buffer) => { brokerOutput = (brokerOutput + b.toString()).slice(-2000); });
  // The shipped auth service owns all exchanges. The test owns only its child handle.
  let service: ReturnType<typeof spawn> | undefined;
  try {
    await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100, output: () => brokerOutput });
    const creds = await mintCreds(auth, newIdentity(), "provisioner");
    await setupSpaceStreams({ servers, space, creds });
    process.env.COTAL_HOME = store;
    recordMesh({ space, root, server: servers, mode: "user", userAuth: assertUserAuthInfo(prepared.publicAuth), ts: new Date().toISOString() });
    service = spawn(process.execPath, [cli, prepared.service.command, "--space", space, "--server", servers], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
    let diagnostics = "";
    service.stderr?.on("data", (b: Buffer) => { diagnostics = (diagnostics + b.toString()).slice(-2000); });
    try { await prepared.service.ready({ dir: pinPath, pid: service.pid }); }
    catch { throw new Error(`stock auth service did not become ready: ${diagnostics}`); }
    const grant = await cmd("actor", "grant", "cli", "--sub", subject, "--full", "--space", space, "--plain");
    assert.equal(grant.code, 0, grant.stderr);
    const before = proofRequests;
    const send = await cmd("send", "--channel", "general", "--space", space, "standards OIDC message", "--plain");
    check("shipped send uses the refreshed OIDC proof through the real broker callout", send.code === 0 && proofRequests > before, send.stderr || send.stdout);
  } finally {
    if (service) await killAndAwaitExit(service, "SIGTERM");
    await killAndAwaitExit(broker, "SIGTERM");
    release();
  }
}

try {
  const first = await login();
  check("shipped login signs in using discovery, form bodies and token exchange", first.code === 0 && first.stdout.includes(subject) && first.stderr.includes("Approval code"), first.stderr);
  check("only the rotating refresh credential is retained", record()?.oidc?.refreshToken === refresh() && record()?.token === undefined && record()?.sub === subject);
  check("login output never contains a token", !`${first.stdout}${first.stderr}`.includes("loopback-"));
  const beforeLegacy = unrelated;
  const legacy = await cmd("login", "--idp", issuer, "--client-id", clientId, "--no-browser", "--plain");
  check("omitting --oidc does not discover or fall back", legacy.code === 1 && unrelated === beforeLegacy + 1 && record()?.oidc?.refreshToken === refresh());
  unrelated = 0;

  for (const mode of ["redirect", "mismatch", "foreign"] as const) {
    discoveryMode = mode;
    const before = tokenRequests;
    const res = await login();
    check(`discovery ${mode} fails before sending a token request`, res.code !== 0 && tokenRequests === before && unrelated === 0);
  }
  discoveryMode = "normal";
  const pin = ["up", "--root", root, "--space", space, "--user-auth", "--idp", issuer, "--idp-audience", audience, "--idp-jwks-uri", idpPins.jwksUri, "--no-manager", "--json"];
  jwksRedirect = true;
  const refused = await cmd(...pin);
  const preflightRefused = refused.code === 2 && /AUTH_PREFLIGHT_UNAVAILABLE/.test(refused.stdout) && unrelated === 0 && loadPinnedIdp(pinPath) === undefined;
  check("shipped up probes the explicit JWKS and refuses a redirect before provisioning", preflightRefused);
  assert.ok(preflightRefused, "refuse to continue with unexpected startup state");
  jwksRedirect = false;

  const authApi = new URL("../dist/index.js", import.meta.url).href;
  const readProof = (directory = store) => run("--input-type=module", "--eval", `import { fetchStoredIdpJwt } from ${JSON.stringify(authApi)}; await fetchStoredIdpJwt(${JSON.stringify(directory)}, ${JSON.stringify(issuer)});`);
  const [a, b] = await Promise.all([readProof(), readProof()]);
  check("independent processes serialize refresh and each rereads the newest credential", a.code === 0 && b.code === 0 && acceptedRefreshes.join() === "0,1" && record()?.oidc?.refreshToken === refresh(), `${a.stderr}${b.stderr}`);

  await verifyMeshUse();
  const pinned = loadPinnedIdp(pinPath)!;

  const proof = await fetchStoredIdpJwt(store, issuer);
  const pins = { issuer: pinned.issuer, audience: pinned.audience, key: pinnedJwksResolver(pinned.jwksUri) };
  check("the existing signed mesh proof verifier accepts the exchanged token", (await verifyIdpToken(proof, pins)).sub === subject);
  const humanRefusal = await verifyToolResultHumanProof(proof, pins).catch((e: unknown) => e);
  check("the same proof without auth_time cannot be used for fresh-human consent", /requires a fresh signed password proof/.test(String(humanRefusal)));
  const beforeCache = proofRequests;
  await fetchStoredIdpJwt(store, issuer);
  check("a usable mesh proof is reused in memory", proofRequests === beforeCache);

  exchangeMode = "redirect";
  const failedExchange = await readProof();
  check("failed token exchange does not replay the POST or lose a completed rotation", failedExchange.code !== 0 && unrelated === 0 && record()?.oidc?.refreshToken === refresh());
  for (const mode of ["extra-audience", "different-subject"] as const) {
    exchangeMode = mode;
    const rejected = await readProof();
    check(`exchanged proof with ${mode} fails closed despite azp`, rejected.code !== 0 && /does not match/.test(rejected.stderr));
  }
  exchangeMode = "short";
  const isolatedStore = join(scratch, "absent-store");
  const beforeShort = proofRequests;
  // A separate process starts without the healthy proof above. Two reads of short proofs must both exchange.
  const short = await run("--input-type=module", "--eval", `import { fetchStoredIdpJwt } from ${JSON.stringify(authApi)}; for (let n=0; n<2; n++) await fetchStoredIdpJwt(${JSON.stringify(store)}, ${JSON.stringify(issuer)});`);
  check("short proofs inside the expiry margin are never reused", short.code === 0 && proofRequests === beforeShort + 2, short.stderr);
  const missing = await readProof(isolatedStore);
  check("proof reads cannot fall back to another sign-in store", missing.code !== 0 && !existsSync(isolatedStore));

  revoked = true;
  const denied = await readProof();
  check("a revoked refresh token cannot mint a fresh mesh proof", denied.code !== 0 && /rejected the cached sign-in/.test(denied.stderr));
  revoked = false;
  const out = await cmd("logout", "--idp", issuer, "--plain");
  check("shipped logout revokes the current refresh credential and clears the local record", out.code === 0 && revoked && record() === undefined, out.stderr);
  const signedOut = await fetchStoredIdpJwt(store, issuer).catch((e: unknown) => e);
  check("a proof cached in memory cannot survive local sign-out", /not logged in/.test(String(signedOut)));
  check("provider observed only the expected requests", unexpected.length === 0, unexpected);
  finish();
} finally {
  await new Promise<void>((done) => server.close(() => done()));
}
