import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { establishIdpSession, loadIdpSession } from "../src/login.js";

// Exercise the real HTTP device flow without a production login or human approval.
let claims: Record<string, unknown> = {};
let requests = 0;
const server = createServer((req, res) => {
  requests++;
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/auth/device/code") res.end(JSON.stringify({ device_code: "device", user_code: "code", verification_uri: "https://example.test/approve", verification_uri_complete: "https://example.test/approve?code=code", expires_in: 60, interval: 1 }));
  else if (req.url === "/api/auth/device/token") res.end(JSON.stringify({ access_token: `opaque-session-${requests}`, expires_in: 3600 }));
  else if (req.url === "/api/auth/token") res.end(JSON.stringify({ token: `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature` }));
  else { res.statusCode = 404; res.end("{}"); }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const url = `http://127.0.0.1:${address.port}/api/auth`;
const home = mkdtempSync(join(tmpdir(), "cotal-discovery-login-"));
const pins = { url, issuer: "https://issuer.test", audience: "jwt-resource-id" };
try {
  const { chooseAccount, chooseAccountChoice } = await import("../src/commands.js");
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error("unexpected fetch"); };
  try {
    for (const values of [{ cloud: true }, { idp: url }])
      await assert.rejects(chooseAccountChoice({ values, positionals: ["cloud.cotal.ai"], raw: [] }, "login"), /cannot be combined/);
    assert.equal(fetches, 0);
    assert.equal(await chooseAccount({ values: { idp: url }, positionals: [], raw: [] }, "logout"), url);
  } finally { globalThis.fetch = originalFetch; }
  for (const bad of [{ iss: "https://other.test", aud: pins.audience }, { iss: pins.issuer, aud: "cotal-cli" }, { iss: pins.issuer, aud: [pins.audience, 42] }]) {
    claims = { sub: "human", ...bad };
    await assert.rejects(establishIdpSession({ dir: home, idpUrl: url, clientId: "cotal-cli", discoveryPins: pins, onPrompt: () => {} }), /does not match discovery/);
    assert.equal(loadIdpSession(home, url), undefined);
    assert.deepEqual(readdirSync(home), [], "no session or catalog is saved on pin mismatch");
  }
  const before = requests;
  await assert.rejects(establishIdpSession({ dir: home, idpUrl: url, clientId: "cotal-cli", discoveryPins: { ...pins, url: `${url}/other` }, onPrompt: () => {} }), /auth URL does not match/);
  assert.equal(requests, before, "URL mismatch refuses before fetching");
  for (const aud of [pins.audience, ["another-resource", pins.audience]]) {
    claims = { sub: "human", iss: pins.issuer, aud };
    await establishIdpSession({ dir: home, idpUrl: `${url}/`, clientId: "cotal-cli", discoveryPins: pins, onPrompt: () => {} });
    assert.equal(loadIdpSession(home, url)?.sub, "human", "JWT audience is independent from the OAuth client id");
  }
  console.log("PASS discovery login persistence fences and normalized URL consistency");
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  rmSync(home, { recursive: true, force: true });
}
