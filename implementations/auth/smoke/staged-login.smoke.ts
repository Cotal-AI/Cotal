import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { stageIdpSession, commitStagedIdpSession, fetchStagedIdpSpaceCatalog, establishIdpSession, loadIdpSession, saveIdpSession } from "../src/login.js";

// Real HTTP device approval contract. No bearer or approval code is logged.
const home = mkdtempSync(join(tmpdir(), "cotal-staged-login-"));
chmodSync(home, 0o700);
const priorHome = process.env.COTAL_HOME;
process.env.COTAL_HOME = home;
let audience: string | string[] = ["other", "mesh"];
let redirect = false;
let catalogRequests = 0;
let approved = false;
let sessionNumber = 0;
let base = "";
const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/auth/device/code") {
    approved = false;
    return void res.end(JSON.stringify({ device_code: "device", user_code: "approval", verification_uri: `${base}/approve`, verification_uri_complete: `${base}/approve`, expires_in: 60, interval: 1 }));
  }
  if (req.url === "/approve") { approved = true; return void res.end("{}"); }
  if (req.url === "/api/auth/device/token") {
    assert.ok(approved);
    return void res.end(JSON.stringify({ access_token: `opaque-session-${++sessionNumber}`, expires_in: 600 }));
  }
  if (req.url === "/api/auth/token") {
    const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    res.setHeader("link", `<${base}/catalog>; rel="https://cotal.ai/relations/space-catalog"`);
    return void res.end(JSON.stringify({ token: `${part({ alg: "none" })}.${part({ iss: base, sub: "person", aud: audience })}.signature` }));
  }
  if (req.url === "/catalog") {
    catalogRequests++;
    assert.ok(req.headers.authorization === `Bearer opaque-session-${sessionNumber}`, "catalog authentication matches the approved session");
    if (redirect) { res.statusCode = 302; res.setHeader("location", `${base}/unexpected`); return void res.end("{}"); }
    return void res.end(JSON.stringify({ v: 1, spaces: [] }));
  }
  assert.fail("unexpected fixture route");
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const opts = (dir: string, signal?: AbortSignal) => ({ dir, idpUrl: `${base}/api/auth`, clientId: "cotal-cli", expectedPins: { issuer: base, audience: "mesh", sub: "person" }, signal, onPrompt: async () => { await fetch(`${base}/approve`); } });
try {
  const dir = join(home, "fresh");
  const candidate = await stageIdpSession(opts(dir));
  assert.deepEqual(readdirSync(home), []);
  assert.equal("session" in candidate, false);
  await fetchStagedIdpSpaceCatalog(candidate, (snapshot, account) => { assert.equal(account.sub, "person"); assert.equal((snapshot as { v: number }).v, 1); });
  assert.equal(catalogRequests, 1);
  assert.deepEqual(readdirSync(home), []);
  redirect = true;
  await assert.rejects(fetchStagedIdpSpaceCatalog(candidate, () => {}), /HTTP 302/);
  redirect = false;
  commitStagedIdpSession(candidate);
  assert.equal(loadIdpSession(dir, `${base}/api/auth`)?.sub, "person");
  assert.throws(() => commitStagedIdpSession(candidate), /already committed/);
  audience = "mesh";
  await establishIdpSession(opts(join(home, "wrapper")));
  audience = "wrong";
  await assert.rejects(stageIdpSession(opts(join(home, "mismatch"))), /expected issuer, audience or subject/);
  assert.equal(readdirSync(home).includes("mismatch"), false);
  audience = "mesh";
  for (const expectedPins of [{ issuer: "https://wrong.example", audience: "mesh", sub: "person" }, { issuer: base, audience: "mesh", sub: "wrong" }]) {
    await assert.rejects(stageIdpSession({ ...opts(join(home, "pin-mismatch")), expectedPins }), /expected issuer, audience or subject/);
    assert.equal(readdirSync(home).includes("pin-mismatch"), false);
  }
  const controller = new AbortController();
  const cancelled = await stageIdpSession(opts(join(home, "cancelled"), controller.signal));
  controller.abort();
  assert.throws(() => commitStagedIdpSession(cancelled), /cancelled/);
  assert.equal(readdirSync(home).includes("cancelled"), false);
  const changedDir = join(home, "changed");
  const changed = await stageIdpSession(opts(changedDir));
  saveIdpSession(changedDir, `${base}/api/auth`, { token: "other-session", sub: "other", expiresAt: Date.now() / 1000 + 600 });
  assert.throws(() => commitStagedIdpSession(changed), /state changed/);
  assert.equal(loadIdpSession(changedDir, `${base}/api/auth`)?.sub, "other");
  console.log("staged login HTTP smoke passed");
} finally {
  if (priorHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = priorHome;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
