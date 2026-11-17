import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveIdpSession } from "@cotal-ai/auth";
import { daemonPathsFor } from "../daemon/endpoint.js";
import { serveDaemon } from "../daemon/server.js";
import { queryDaemon } from "../daemon/client.js";
import { exchangeDesktopRequest } from "../daemon/desktop.js";

const root = mkdtempSync(join(tmpdir(), "ownacct-providers-"));
process.env.HOME = join(root, "home");
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.COTAL_HOME = join(root, "cotal");
for (const dir of [process.env.HOME, process.env.COTAL_HOME, join(root, "rt")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
async function provider() {
  let expired = false;
  let gets = 0;
  let idp = "";
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (expired) { res.writeHead(401); res.end("{}"); return; }
    if (req.url === "/api/auth/token") {
      const jwt = [JSON.stringify({ alg: "EdDSA" }), JSON.stringify({ sub: "owner", iss: new URL(idp).origin, exp: Date.now() / 1000 + 3600 })].map(s => Buffer.from(s).toString("base64url")).join(".") + ".fixture";
      res.setHeader("link", `<${new URL("/catalog", idp).href}>; rel="cotal-space-catalog"`);
      res.end(JSON.stringify({ token: jwt })); return;
    }
    if (req.url === "/catalog") { res.end(JSON.stringify({ v: 1, account: { idpUrl: idp, issuer: new URL(idp).origin, sub: "owner" }, spaces: [] })); return; }
    const machine = req.url?.match(/^\/api\/cli\/machines\/([0-9a-f-]+)(\/spaces)?$/);
    if (machine) {
      if (req.method === "GET") gets++;
      res.end(JSON.stringify(req.method === "PUT" ? { v: 1, machine: { id: machine[1], lastSeenAt: new Date().toISOString(), revision: 1 } } : { v: 1, machineId: machine[1], revision: 1, bindingRevisions: {}, account: { idpUrl: idp, issuer: new URL(idp).origin, sub: "owner" }, spaces: [] })); return;
    }
    res.writeHead(404); res.end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  idp = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/auth`;
  return { idp, gets: () => gets, expire: () => { expired = true; }, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const fixtures = await Promise.all([provider(), provider()]);
fixtures.sort((a, b) => a.idp.localeCompare(b.idp));
const [working, other] = fixtures;
for (const p of fixtures) saveIdpSession(process.env.COTAL_HOME, p.idp, { token: "fixture-session", sub: "owner", expiresAt: Date.now() / 1000 + 3600 });
const paths = daemonPathsFor(process.env.COTAL_HOME, { XDG_RUNTIME_DIR: join(root, "rt") });
if (process.argv.includes("--expired")) {
  other.expire();
  saveIdpSession(process.env.COTAL_HOME, other.idp, { token: "expired-session", sub: "owner", expiresAt: 1 });
} else await other.close();
const daemon = await serveDaemon({ paths, version: "test", sessionDir: process.env.COTAL_HOME });
try {
  const deadline = Date.now() + 10_000;
  while (!daemon.status().account?.accounts?.some(account => account.idpUrl === working.idp && account.hostSupport === "supported") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(daemon.status().account?.accounts?.some(account => account.idpUrl === working.idp && account.hostSupport === "supported"), "working fixture registered");
  const status = await queryDaemon({ paths });
  const spaces = await exchangeDesktopRequest({ paths }, { op: "spaces", refresh: true });
  console.log(JSON.stringify({ status, spaces }, null, 2));
  assert.ok(status.ok);
  assert.equal(status.result.account?.idpUrl, working.idp, "top-level account must follow supported provider, not stopped provider sorted last");
  assert.ok(spaces.ok && !("event" in spaces) && "failedProviders" in spaces.result);
  assert.deepEqual(spaces.result.failedProviders, [other.idp]);
  assert.equal(spaces.result.refresh, "partial");
  const before = working.gets();
  await new Promise(resolve => setTimeout(resolve, 5300));
  assert.ok(working.gets() > before, "working provider keeps polling despite other provider failure");
  assert.equal(daemon.status().account?.message, undefined, "failed context does not contaminate supported account");
  console.log("COTAL_SMOKE_SENTINEL cells=6 passed=6 failed=0");
} finally { await daemon.close(); await working.close(); if (process.argv.includes("--expired")) await other.close(); }
