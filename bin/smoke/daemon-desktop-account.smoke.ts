/** Desktop logout crosses the real local daemon socket and a loopback-only IdP. */
import strictAssert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { loadIdpSession, saveIdpSession } from "@cotal-ai/auth";
import { serveDaemon } from "../daemon/server.js";
import { loginViaDaemon } from "../daemon/client.js";
import { daemonPathsFor } from "../daemon/endpoint.js";
import { exchangeDesktopRequest, parseDesktopRequest } from "../daemon/desktop.js";
import { parseRequest, type DaemonResponse } from "../daemon/protocol.js";
import { countedAssert, emitSentinel } from "./sentinel.mjs";

const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
const root = mkdtempSync(join(tmpdir(), "dacct-"));
const savedEnv = { ...process.env };
const home = join(root, "home");
const config = join(root, "config");
const machineHome = join(root, "cotal");
const ambientHome = join(root, "ambient-cotal");
const runtime = join(root, "rt");
for (const dir of [home, config, machineHome, ambientHome, runtime]) mkdirSync(dir, { mode: 0o700 });
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: config, COTAL_HOME: ambientHome, XDG_RUNTIME_DIR: runtime });
let mode = 200;
let signOuts = 0;
let deviceCodes = 0;
let corruptCatalogOnRevoke = false;
let holdSignOut: Promise<void> | undefined;
let signOutStarted: (() => void) | undefined;
const requests: { method?: string; url?: string; authorization?: string; body: string }[] = [];
const fixture = createServer((req, res) => {
  if (req.url === "/api/auth/device/code") {
    deviceCodes++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ device_code: "fixture-device-secret", user_code: "FIXTURE", verification_uri: "http://127.0.0.1/verify", verification_uri_complete: "http://127.0.0.1/verify?code=FIXTURE", expires_in: 60, interval: 1 }));
    return;
  }
  if (req.url === "/api/auth/device/token") {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "authorization_pending" }));
    return;
  }
  // Account-computer discovery may probe this origin. It must never reach a real provider.
  if (req.url !== "/api/auth/sign-out") { res.writeHead(404); res.end("{}"); return; }
  signOuts++;
  let body = "";
  req.setEncoding("utf8");
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
    const reply = () => {
      if (corruptCatalogOnRevoke) writeFileSync(join(machineHome, "space-catalogs.json"), "{invalid", { mode: 0o600 });
      res.writeHead(mode, { "content-type": "application/json" });
      // Even an upstream error body containing a credential must not reach the desktop.
      res.end(JSON.stringify(mode === 200 ? {} : { token: "fixture-selected-secret" }));
    };
    signOutStarted?.();
    if (holdSignOut) void holdSignOut.then(reply);
    else reply();
  });
});
let daemon: Awaited<ReturnType<typeof serveDaemon>> | undefined;
const secrets = ["fixture-selected-secret", "fixture-other-secret", "fixture-ambient-secret", "fixture-device-secret"];
function secretFree(reply: DaemonResponse) {
  const wire = JSON.stringify(reply);
  for (const secret of secrets) assert.ok(!wire.includes(secret), "response contains no saved session credential");
  assert.doesNotMatch(wire, /"(?:token|accessToken|refreshToken|authorization)"\s*:/i, "response contains no credential fields");
}
try {
  await new Promise<void>((resolve, reject) => {
    fixture.once("error", reject);
    fixture.listen(0, "127.0.0.1", resolve);
  });
  const address = fixture.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const idp = `${origin}/api/auth`;
  const otherIdp = `${origin}/other/auth`;
  const selected = { token: secrets[0]!, sub: "selected-owner", expiresAt: Date.now() / 1000 + 3600 };
  const other = { token: secrets[1]!, sub: "other-owner", expiresAt: selected.expiresAt };
  const ambient = { token: secrets[2]!, sub: "ambient-owner", expiresAt: selected.expiresAt };
  saveIdpSession(machineHome, idp, selected);
  saveIdpSession(machineHome, otherIdp, other);
  saveIdpSession(ambientHome, idp, ambient);
  // Keep a byte-level witness as well as a decoded session witness for ambient isolation.
  const ambientFile = join(ambientHome, "idp-sessions.json");
  const ambientBytes = readFileSync(ambientFile);
  const paths = daemonPathsFor(machineHome, { XDG_RUNTIME_DIR: runtime });
  daemon = await serveDaemon({ paths, sessionDir: machineHome, version: "0.160.5" });
  const request = { op: "logout" as const, idp };
  assert.deepEqual(parseDesktopRequest(request), request);
  const success = await exchangeDesktopRequest({ paths }, request);
  secretFree(success);
  assert.ok(success.ok && "result" in success);
  assert.deepEqual(success.result, { kind: "logout", serverRevoked: true, localLoginCleared: true, removedRegistrations: [] });
  assert.equal(signOuts, 1, "selected provider is revoked once");
  assert.deepEqual(requests, [{ method: "POST", url: "/api/auth/sign-out", authorization: `Bearer ${selected.token}`, body: "{}" }]);
  assert.equal(loadIdpSession(machineHome, idp), undefined, "selected machine login is removed");
  assert.deepEqual(loadIdpSession(machineHome, otherIdp), other, "second provider survives selected logout");
  assert.deepEqual(loadIdpSession(ambientHome, idp), ambient, "ambient COTAL_HOME login survives selected logout");
  assert.deepEqual(readFileSync(ambientFile), ambientBytes, "ambient session file is byte-for-byte unchanged");

  const absent = await exchangeDesktopRequest({ paths }, request);
  secretFree(absent);
  assert.ok(absent.ok && "result" in absent);
  assert.deepEqual(absent.result, { kind: "logout", localLogin: "absent", serverRevoked: null });
  assert.equal(signOuts, 1, "absent machine login does not revoke the ambient session");

  saveIdpSession(machineHome, idp, selected);
  mode = 503;
  const unavailable = await exchangeDesktopRequest({ paths }, request);
  secretFree(unavailable);
  assert.ok(!unavailable.ok);
  assert.equal(unavailable.error.code, "OPERATION_UNKNOWN");
  assert.equal(unavailable.error.outcome, "unknown", "503 does not claim revocation or local cleanup");
  assert.equal(signOuts, 2);
  assert.deepEqual(loadIdpSession(machineHome, idp), selected, "unconfirmed revocation retains login for retry");

  for (const field of ["local", "token", "dir"]) {
    const invalid = { ...request, [field]: field === "local" ? true : "renderer-controlled" };
    assert.throws(() => parseDesktopRequest(invalid), /unknown operation or field/);
    assert.equal(parseRequest(JSON.stringify({ v: 1, id: "bad", ...invalid })).ok, false);
    // Deliberately bypass the desktop parser to prove the actual daemon also refuses the field.
    const refused = await exchangeDesktopRequest({ paths }, invalid);
    secretFree(refused);
    assert.ok(!refused.ok);
    assert.equal(refused.error.code, "UNKNOWN_FIELD");
  }
  assert.equal(signOuts, 2, "refused requests do not contact sign-out");
  assert.deepEqual(loadIdpSession(machineHome, idp), selected);
  assert.deepEqual(loadIdpSession(machineHome, otherIdp), other);
  assert.deepEqual(loadIdpSession(ambientHome, idp), ambient);
  assert.deepEqual(readFileSync(ambientFile), ambientBytes);

  // Hold a real provider response so another socket reaches the daemon during sign-out.
  let release!: () => void;
  holdSignOut = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { signOutStarted = resolve; });
  const pending = exchangeDesktopRequest({ paths }, request);
  try {
    await Promise.race([started, pending.then(() => { throw new Error("held sign-out completed before provider request"); })]);
    const busy = await exchangeDesktopRequest({ paths }, request);
    secretFree(busy);
    assert.ok(!busy.ok);
    assert.equal(busy.error.code, "LOGIN_IN_PROGRESS");
    assert.equal(signOuts, 3, "concurrent request never reaches provider");
  } finally { release(); await pending; }
  assert.deepEqual(loadIdpSession(machineHome, idp), selected, "failed held revocation also retains login");
  holdSignOut = undefined;
  signOutStarted = undefined;

  // Stock device authorization starts through the real socket and stays pending at this IdP.
  const cancelLogin = new AbortController();
  let prompted!: () => void;
  const promptSeen = new Promise<void>(resolve => { prompted = resolve; });
  const signingIn = loginViaDaemon({ paths, idp, signal: cancelLogin.signal, onPrompt: () => prompted() });
  try {
    await Promise.race([promptSeen, signingIn.then(() => { throw new Error("device login ended before its prompt"); })]);
    assert.equal(deviceCodes, 1, "stock device flow contacted loopback IdP");
    const busy = await exchangeDesktopRequest({ paths }, request);
    secretFree(busy);
    assert.ok(!busy.ok);
    assert.equal(busy.error.code, "LOGIN_IN_PROGRESS", "active device login blocks logout");
    assert.equal(signOuts, 3, "logout during login makes no revocation call");
    assert.deepEqual(loadIdpSession(machineHome, idp), selected);
  } finally {
    cancelLogin.abort();
    const cancelled = await signingIn;
    const structure = cancelled.ok ? { ok: true, outcome: cancelled.result.outcome, ...("reason" in cancelled.result ? { reason: cancelled.result.reason } : {}) } : { ok: false, code: cancelled.code };
    assert.ok(cancelled.ok && cancelled.result.outcome === "cancelled", `device login cancellation: ${JSON.stringify(structure)}`);
  }

  // Damage only the owned catalog after a real successful provider revocation, before cleanup.
  mode = 200;
  corruptCatalogOnRevoke = true;
  try {
    const partial = await exchangeDesktopRequest({ paths }, request);
    secretFree(partial);
    assert.ok(!partial.ok);
    assert.equal(partial.error.code, "OPERATION_PARTIAL");
    assert.equal(partial.error.outcome, "partial");
    assert.deepEqual(partial.error.changed, [{ kind: "idp-session", idp, revoked: true }, { kind: "local-login", idp, cleared: true }]);
    assert.equal(signOuts, 4, "partial cleanup follows successful remote revocation");
    assert.equal(loadIdpSession(machineHome, idp), undefined, "login removal preceded catalog failure");
    assert.deepEqual(loadIdpSession(machineHome, otherIdp), other);
    assert.deepEqual(readFileSync(ambientFile), ambientBytes);
  } finally {
    corruptCatalogOnRevoke = false;
    const catalog = join(machineHome, "space-catalogs.json");
    if (existsSync(catalog)) unlinkSync(catalog);
  }
} finally {
  try { await daemon?.close(); }
  finally {
    fixture.closeAllConnections();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
}
emitSentinel({ passed: counted.cells(), failed: 0 });
