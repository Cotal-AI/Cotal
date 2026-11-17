/** Exercise the shipped provider against real stalled HTTP headers and bodies. */
import nodeAssert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpEnvelopeError, mintLifecycleUid, newIdentity, type RemoteManagerAdminAuthorizationRequest } from "@cotal-ai/core";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { workspaceSecretStore } from "@cotal-ai/workspace";
import { cotalAuthProvider } from "../src/provider.js";
import { fetchIdpJwt, saveIdpSession } from "../src/login.js";
import { pinManagerAuthorityRoute } from "../src/manager-authority-route.js";
import { withIdpSessionDir } from "../src/session-context.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const root = mkdtempSync(join(tmpdir(), "manager-admin-budget-"));
const priorHome = process.env.COTAL_HOME;
process.env.COTAL_HOME = root;
mkdirSync(join(root, ".cotal"));
const store = workspaceSecretStore(root);
const dir = join(root, "client");
mkdirSync(dir);
const space = `budget_${mintLifecycleUid()}`;
const owner = `u_${"a".repeat(26)}`;
const request: RemoteManagerAdminAuthorizationRequest = {
  v: 1, kind: "manager-admin-authorization", space, actor: "cli", instanceId: mintLifecycleUid(),
  managerLifecycleUid: mintLifecycleUid(), requestId: `admin${mintLifecycleUid()}`,
  registrationProof: `sha256:${"0".repeat(64)}`, serveEpoch: 0,
  identities: Object.fromEntries(["supervisor", "executor", "serve", "goalWriter", "sessionLedger"].map((key) => [key, { id: newIdentity().id }])) as RemoteManagerAdminAuthorizationRequest["identities"],
  caller: { owner, actor: "operator", lifecycleUid: mintLifecycleUid() },
};
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let mode = "prompt", tokenRequests = 0, adminRequests = 0, active = 0;
const timers = new Set<ReturnType<typeof setTimeout>>();
function later(res: ServerResponse, ms: number, send: () => void): void {
  const timer = setTimeout(() => { timers.delete(timer); if (!res.destroyed) send(); }, ms);
  timers.add(timer);
  res.once("close", () => { clearTimeout(timer); timers.delete(timer); });
}
const server = createServer(async (req, res) => {
  active++;
  res.once("close", () => active--);
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/auth/token") {
    tokenRequests++;
    const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: "fixture", exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.fixture`;
    const body = JSON.stringify({ token });
    if (mode === "token-headers") return;
    if (mode === "token-body") { res.write(body.slice(0, 1)); return; }
    if (mode === "sequential") { later(res, 2800, () => res.end(body)); return; }
    if (mode === "shared") { later(res, 6000, () => res.end(body)); return; }
    res.end(body);
    return;
  }
  adminRequests++;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.stringify({ ...JSON.parse(Buffer.concat(chunks).toString()).request, owner, authorized: mode !== "denied" });
  if (mode === "redirect") { res.writeHead(307, { location: `${base}/unexpected` }); res.write("{"); return; }
  if (mode === "admin-headers") return;
  if (mode === "admin-body") { res.write(body.slice(0, 1)); return; }
  if (mode === "sequential") { later(res, 2800, () => res.end(body)); return; }
  res.end(body);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("fixture failed to bind");
const base = `http://127.0.0.1:${address.port}`;
const idpUrl = `${base}/api/auth`;
pinManagerAuthorityRoute(store, dir, space, { endpoint: `${base}/manager-service-authority`, idpUrl });
function session(label: string): { home: string; token: string } {
  const home = join(root, label);
  mkdirSync(home);
  const token = `fixture-${label}`;
  saveIdpSession(home, idpUrl, { token, sub: "fixture", expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  return { home, token };
}
const authorize = (home: string) => withIdpSessionDir(home, () => cotalAuthProvider.authorizeRemoteManagerAdmin!({ store, dir, request }));
async function idle(): Promise<void> {
  for (let i = 0; i < 100 && active; i++) await pause(10);
  assert.equal(active, 0, "no abandoned HTTP requests remain");
}
async function refused(home: string): Promise<void> {
  const start = performance.now();
  await assert.rejects(authorize(home), (error: unknown) => error instanceof EpEnvelopeError && error.code === "unavailable" && error.outcome === "not-executed" && error.message.includes("5000ms"));
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 4900 && elapsed < 7000, `${mode}: one five-second budget, observed ${elapsed}ms`);
}
try {
  for (const arm of ["token-headers", "token-body", "sequential", "admin-headers", "admin-body"]) {
    const { home } = session(arm);
    mode = "prompt";
    if (arm.startsWith("admin")) assert.equal((await authorize(home)).authorized, true);
    const beforeTokens = tokenRequests, beforeAdmin = adminRequests;
    mode = arm;
    await refused(home);
    await idle();
    assert.equal(tokenRequests - beforeTokens, arm.startsWith("admin") ? 0 : 1, `${arm}: warm cache or one private token fetch`);
    assert.equal(adminRequests - beforeAdmin, arm.startsWith("token") ? 0 : 1, `${arm}: no late POST or retry`);
    mode = "prompt";
    assert.equal((await authorize(home)).authorized, true, `${arm}: recovery uses a fresh authorization`);
    await idle();
    console.log(`  passed ${arm}, request abort and recovery`);
  }
  const shared = session("shared");
  mode = "shared";
  const beforeTokens = tokenRequests, beforeAdmin = adminRequests;
  const plain = fetchIdpJwt(idpUrl, shared.token);
  const anotherPlain = fetchIdpJwt(idpUrl, shared.token);
  await refused(shared.home);
  assert.equal(await plain, await anotherPlain, "the shared token fetch survives another caller's deadline");
  assert.equal(tokenRequests - beforeTokens, 2, "uncancelled waiters share one fetch, bounded caller owns another");
  assert.equal(adminRequests, beforeAdmin, "timed-out token acquisition never starts a late authority POST");
  await idle();
  mode = "admin-body";
  await Promise.all(Array.from({ length: 4 }, () => refused(shared.home)));
  await idle();
  mode = "prompt";
  assert.equal((await authorize(shared.home)).authorized, true, "concurrent refusals leave provider usable");
  mode = "redirect";
  const beforeRedirect = adminRequests;
  await assert.rejects(authorize(shared.home), /redirects are refused/);
  await idle();
  assert.equal(adminRequests, beforeRedirect + 1, "redirect is not followed or retried");
  mode = "denied";
  assert.equal((await authorize(shared.home)).authorized, false, "prior successful authorization is never reused");
  mode = "prompt";
  assert.equal((await authorize(shared.home)).authorized, true, "next call observes fresh authorization");
  console.log("manager-admin-budget: all dependency phases, shared-token isolation and concurrent cleanup passed");
  emitSentinel({ passed: counted.cells(), failed: 0 });
} finally {
  if (priorHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = priorHome;
  for (const timer of timers) clearTimeout(timer);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
