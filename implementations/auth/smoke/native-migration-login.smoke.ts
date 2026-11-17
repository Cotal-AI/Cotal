/** Synthetic transport coverage of the registered login command, not live provider acceptance. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registry, type Command } from "@cotal-ai/core";
import { homeCotalDir, readMesh } from "@cotal-ai/workspace";
import { importAccountComputerSpace } from "../../cli/src/commands/sync.js";
import { loadIdpSession, saveIdpSession } from "../src/login.js";
import "../src/commands.js";

const home = mkdtempSync(join(tmpdir(), "cotal-native-login-"));
chmodSync(home, 0o700);
const previousHome = process.env.COTAL_HOME;
process.env.COTAL_HOME = home;
const oldUrl = "https://old.example/api/auth", nextUrl = "https://native.example/api/auth";
const issuer = "https://old.example", audience = "mesh", sub = "person";
const ownerKey = (url: string) => createHash("sha256").update(`${new URL(url).origin}\0${sub}`).digest("hex");
const old = { idpUrl: oldUrl, issuer, sub, ownerKey: ownerKey(oldUrl) };
const bundle = (url: string) => ({ space: "alpha", server: "nats://127.0.0.1:1", tlsRequired: false, sentinelCreds: "sentinel", userAuth: { provider: "cotal", idp: { url, issuer, audience }, endpoints: { url: `${new URL(url).origin}/exchange` } } });
const row = (url: string) => ({ id: "stable-alpha", slug: "alpha", name: "Alpha", kind: "team", role: "member", registration: bundle(url) });
saveIdpSession(homeCotalDir(), oldUrl, { token: "old-bearer-canary", sub, expiresAt: Date.now() / 1000 + 600 });
writeFileSync(join(homeCotalDir(), "space-catalogs.json"), JSON.stringify({ ver: 1, accounts: { [old.ownerKey]: { ...old, advertised: true } } }));
importAccountComputerSpace(old, row(oldUrl));
const login = registry.all<Command>("command").find(command => command.name === "login")!;
assert.ok(login.flags?.some(flag => flag.name === "migrate-from"));
for (const extra of [{ cloud: true }, { idp: nextUrl }]) assert.throws(() => login.validate?.({ values: { "migrate-from": oldUrl, ...extra }, positionals: [], raw: [] }), /cannot be combined/);
const realFetch = globalThis.fetch;
const realError = console.error;
let approved = false;
let badCatalog = true;
let changeOldSession = false;
const requests: string[] = [];
const errors: string[] = [];
console.error = (...args: unknown[]) => {
  errors.push(args.map(String).join(" "));
  // Fixture human approval occurs only after the command displays the approval prompt.
  if (args.some(value => String(value).includes("Approve native migration"))) approved = true;
};
globalThis.fetch = async (input, init) => {
  const url = String(input);
  requests.push(url);
  assert.ok(!JSON.stringify(init).includes("old-bearer-canary"), "old bearer never forwarded");
  const json = (value: unknown, headers?: Record<string, string>) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json", ...headers } });
  if (url === `${issuer}/.well-known/cotal-mesh`) {
    assert.equal(init?.headers, undefined);
    return json({ ...bundle(oldUrl), nativeMigration: { version: 1, origin: "https://native.example" } });
  }
  if (url === "https://native.example/.well-known/cotal-mesh") return json(bundle(nextUrl));
  if (url === `${nextUrl}/device/code`) return json({ device_code: "fixture-device", user_code: "fixture-code", verification_uri: "https://native.example/approve", verification_uri_complete: "https://native.example/approve", expires_in: 60, interval: 1 });
  if (url === `${nextUrl}/device/token`) { assert.ok(approved); return json({ access_token: "fresh-fixture-session", expires_in: 600 }); }
  if (url === `${nextUrl}/token`) {
    const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    return json({ token: `${part({ alg: "none" })}.${part({ iss: issuer, sub, aud: audience })}.fixture` }, { link: '<https://native.example/catalog>; rel="https://cotal.ai/relations/space-catalog"' });
  }
  if (url === "https://native.example/catalog") {
    if (changeOldSession) saveIdpSession(homeCotalDir(), oldUrl, { token: "changed-old-bearer", sub, expiresAt: Date.now() / 1000 + 600 });
    return json({ v: 1, account: { idpUrl: nextUrl, issuer, sub }, spaces: badCatalog ? [] : [row(nextUrl)] });
  }
  throw new Error(`unexpected request ${url}`);
};
try {
  const args = { values: { "migrate-from": oldUrl, "no-browser": true, plain: true }, positionals: [], raw: [] };
  login.validate?.(args);
  const before = readMesh("alpha");
  const realExit = process.exit;
  process.exit = (() => { throw new Error("fixture intercepted command refusal"); }) as typeof process.exit;
  try {
    await assert.rejects(login.run(args), /fixture intercepted command refusal/);
  } finally { process.exit = realExit; }
  assert.deepEqual(readMesh("alpha"), before, "catalog mismatch leaves registry unchanged");
  assert.equal(loadIdpSession(homeCotalDir(), nextUrl), undefined, "catalog mismatch does not save candidate session");
  badCatalog = false;
  changeOldSession = true;
  errors.length = 0;
  approved = false;
  process.exit = (() => { throw new Error("fixture intercepted command refusal"); }) as typeof process.exit;
  try {
    await assert.rejects(login.run(args), /fixture intercepted command refusal/);
  } finally { process.exit = realExit; }
  assert.ok(errors.some(line => line.includes("old account sign-in or catalog state changed") && line.includes("retry `cotal login --migrate-from")), "actual migration caller reports actionable old-account dependency refusal");
  assert.deepEqual(readMesh("alpha"), before, "old-session change during approval prevents registry migration");
  assert.equal(loadIdpSession(homeCotalDir(), nextUrl), undefined, "old-session change prevents candidate persistence");
  assert.equal(loadIdpSession(homeCotalDir(), oldUrl)!.token, "changed-old-bearer");
  changeOldSession = false;
  saveIdpSession(homeCotalDir(), oldUrl, { token: "old-bearer-canary", sub, expiresAt: Date.now() / 1000 + 600 });
  approved = false;
  requests.length = 0;
  await login.run(args);
  assert.equal(readMesh("alpha")!.catalogOwner, ownerKey(nextUrl));
  assert.equal(readMesh("alpha")!.userAuth!.idp.url, nextUrl);
  assert.equal(loadIdpSession(homeCotalDir(), oldUrl)!.token, "old-bearer-canary");
  assert.equal(loadIdpSession(homeCotalDir(), nextUrl)!.token, "fresh-fixture-session");
  assert.ok(readFileSync(join(homeCotalDir(), "space-catalogs.json"), "utf8").includes(old.ownerKey));
  assert.equal(requests.length, 6);
  console.log("native migration registered login synthetic smoke passed");
} finally {
  globalThis.fetch = realFetch;
  console.error = realError;
  if (previousHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = previousHome;
}
