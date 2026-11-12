/** A login committed while real HTTP revocation waits must survive the older logout. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIdpSession, saveIdpSession, type IdpSession } from "../src/login.js";
import { signOutIdpSession } from "../src/logout.js";

const root = mkdtempSync(join(tmpdir(), "logout-session-race-"));
const originalEnv = { ...process.env };
let held: ServerResponse | undefined;
let reached!: () => void;
const requestReached = new Promise<void>((done) => { reached = done; });
const server = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/sign-out") {
    response.writeHead(404).end();
    return;
  }
  held = response;
  reached();
});
let logout: ReturnType<typeof signOutIdpSession> | undefined;
try {
  for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
  process.env.HOME = join(root, "home");
  process.env.XDG_CONFIG_HOME = join(root, "config");
  mkdirSync(process.env.HOME, { mode: 0o700 });
  mkdirSync(process.env.XDG_CONFIG_HOME, { mode: 0o700 });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const idp = `http://127.0.0.1:${address.port}`;
  const dir = join(root, "sessions");
  const a: IdpSession = { token: "race-session-a", sub: "same-account", expiresAt: Date.now() + 60_000 };
  const b: IdpSession = { ...a, token: "race-session-b" };
  saveIdpSession(dir, idp, a);
  logout = signOutIdpSession({ dir, idp, local: false });
  await Promise.race([
    requestReached,
    logout.then(() => { throw new Error("logout completed before reaching held revocation"); }),
  ]);
  assert.ok(held, "real provider revocation reached its held response");
  saveIdpSession(dir, idp, b);
  assert.equal(loadIdpSession(dir, idp)?.token === b.token, true, "replacement login committed before releasing revocation");
  held.writeHead(200, { "content-type": "application/json" }).end("{}");
  await logout;
  assert.equal(loadIdpSession(dir, idp)?.token === b.token, true, "concurrent replacement login must survive older logout");
  console.log("PASS replacement login survives held HTTP revocation");
} finally {
  held?.end();
  await logout?.catch(() => {});
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(root, { recursive: true, force: true });
}
