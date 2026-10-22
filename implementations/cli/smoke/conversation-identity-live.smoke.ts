/** Real HTTPS discovery, provider authentication and durable personal-identity replay/retirement.
 * The authority and human session are isolated fixtures. This does not claim hosted acceptance. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates, setDefaultCACertificates } from "node:tls";
import type { AddressInfo } from "node:net";

const home = mkdtempSync(join(tmpdir(), "cotal-conversation-https-"));
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
process.env.COTAL_HOME = home;
const { eventChannel, mintLifecycleUid } = await import("@cotal-ai/core");
const { recordMesh, resolveTargetOrThrow } = await import("@cotal-ai/workspace");
const { cotalAuthProvider } = await import("@cotal-ai/auth");
const { saveIdpSession } = await import("../../auth/src/login.js");
const { checkConversationMaterial, discoverConversationAuthority } = await import("../src/lib/conversation-identity.js");
const { provisionUserApp, retireUserApp } = await import("../src/lib/app-user-identity.js");

execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
  "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(home, "server.key"), "-out", join(home, "server.crt")], { stdio: "ignore" });
const ca = readFileSync(join(home, "server.crt"), "utf8");
setDefaultCACertificates([...rootCertificates, ca]);
const key = readFileSync(join(home, "server.key"));
const owner = "u_native_fixture";
let base = "", discoveryMode = "valid", createMode = "valid", retireMode = "terminal";
let publicReads = 0, authenticated = 0, issued = 0, retired = 0;
const requests = new Map<string, { tokenHash: string; material: Record<string, any> }>();
const bundle = () => ({ space: "native_fixture", server: "nats://127.0.0.1:1", tlsRequired: false,
  userAuth: { provider: "cotal", idp: { url: `${base}/idp`, issuer: `${base}/idp`, audience: "cotal-cli" }, endpoints: { url: `${base}/s/native_fixture` } },
  policy: { events: "required" }, sentinelCreds: "fixture-sentinel",
  ...(discoveryMode === "absent" ? {} : { cloudCapabilities: { conversationIdentity: {
    version: discoveryMode === "old" ? 2 : 1,
    url: discoveryMode === "foreign" ? "https://invalid.example/api/spaces/native_fixture/conversation-identities"
      : `${base}/api/spaces/${discoveryMode === "other-space" ? "other" : "native_fixture"}/conversation-identities`,
  } } }),
});
const server = createServer({ key, cert: ca }, async (req, res) => {
  const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === "/s/native_fixture/.well-known/cotal-mesh") {
    publicReads++;
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    return send(200, bundle());
  }
  authenticated++;
  assert.equal(req.headers.authorization, "Bearer isolated-fixture-human-session");
  assert.equal(req.headers.cookie, undefined);
  if (req.url === "/redirect") { res.writeHead(302, { location: `${base}/must-not-follow` }); res.end(); return; }
  if (req.url === "/must-not-follow") throw new Error("authenticated redirect was followed");
  if (req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    assert.deepEqual(Object.keys(body).sort(), ["label", "requestId", "tokenHash", "v"]);
    assert.match(body.requestId, /^[A-Za-z0-9_-]{22,64}$/);
    assert.match(body.tokenHash, /^[a-f0-9]{64}$/);
    let existing = requests.get(body.requestId);
    if (existing) assert.equal(existing.tokenHash, body.tokenHash);
    if (!existing) {
      const actor = `pa_${Array.from(randomBytes(26), (byte) => "abcdefghijklmnopqrstuvwxyz234567"[byte % 32]).join("")}`;
      const lifecycleUid = mintLifecycleUid();
      existing = { tokenHash: body.tokenHash, material: { v: 1, requestId: body.requestId, space: "native_fixture", owner, actor, lifecycleUid,
        grant: { scope: [], role: null, allowSubscribe: [], allowPublish: [eventChannel({ owner, actor })], subscribe: [] },
        policy: { events: "required" }, sentinelCreds: "fixture-sentinel", exchangeUrl: `${base}/s/native_fixture`,
        retire: { url: `${base}/api/spaces/native_fixture/conversation-identities/${actor}?lifecycleUid=${lifecycleUid}` } } };
      requests.set(body.requestId, existing);
      issued++;
    }
    if (createMode === "drop") { req.socket.destroy(); return; }
    return send(200, existing.material);
  }
  if (req.method === "DELETE") {
    const exact = [...requests.values()].find(({ material }) => material.retire.url === `${base}${req.url}`)?.material;
    assert(exact, "retirement must name one issued lifecycle");
    if (retireMode === "unconfirmed") return send(503, { error: "fixture revoke may already have happened" });
    retired++;
    return send(retireMode === "pending" ? 202 : 200, { v: 1, actor: exact.actor, lifecycleUid: exact.lifecycleUid,
      phase: retireMode === "pending" ? "release" : "terminal", complete: retireMode !== "pending" });
  }
  send(404, {});
});
let assertions = 0;
const check = (name: string, test: () => unknown | Promise<unknown>) => Promise.resolve().then(test).then(() => { assertions++; console.log(`  ✓ ${name}`); });
try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const registration = bundle();
  recordMesh({ space: registration.space, server: registration.server, root: join(home, "workspace"), mode: "user", origin: "manual", ts: new Date().toISOString(),
    userAuth: registration.userAuth, policy: registration.policy as { events: "required" } });
  saveIdpSession(home, `${base}/idp`, { token: "isolated-fixture-human-session", sub: "isolated-human", expiresAt: Math.floor(Date.now() / 1000) + 600 });
  const target = await resolveTargetOrThrow({ space: "native_fixture" });
  await check("native identity is required before effects", async () => {
    await assert.rejects(provisionUserApp(target, "alice", undefined, true), /native session/);
    assert.equal(authenticated, 0);
  });
  await check("required events refuse before authenticated effects", async () => {
    await assert.rejects(provisionUserApp(target, "alice", "session-a", false), /real native/);
    assert.equal(authenticated, 0);
  });
  for (const mode of ["absent", "old", "foreign", "other-space"]) {
    await check(`${mode} capability refuses before authenticated effects`, async () => {
      discoveryMode = mode;
      await assert.rejects(provisionUserApp(target, "alice", "session-a", true));
      assert.equal(authenticated, 0);
    });
  }
  discoveryMode = "valid";
  const a = await provisionUserApp(target, "alice", "session-a", true);
  await check("create persists private secret before authenticated POST", () => {
    assert.equal(issued, 1);
    const record = JSON.parse(readFileSync(join(a.retire.dir, "identity.json"), "utf8"));
    assert.equal(requests.get(record.requestId)?.tokenHash, createHash("sha256").update(record.token).digest("hex"));
    assert.equal(a.env.COTAL_EVENTS_REQUIRED, "1");
    assert.equal(a.env.COTAL_ALLOW_SUBSCRIBE, "");
    assert.equal(a.env.COTAL_SUBSCRIBE, "");
    assert(!JSON.stringify(a).includes(record.token));
  });
  const replay = await provisionUserApp(target, "alice", "session-a", true);
  await check("same conversation replays one lifecycle without rotating", () => { assert.deepEqual(replay, a); assert.equal(issued, 1); });
  const b = await provisionUserApp(target, "alice", "session-b", true);
  await check("another conversation has a distinct principal and files", () => {
    assert.notEqual(b.env.COTAL_ACTOR, a.env.COTAL_ACTOR);
    assert.notEqual(b.env.COTAL_LIFECYCLE_UID, a.env.COTAL_LIFECYCLE_UID);
    assert.notEqual(b.retire.dir, a.retire.dir);
    assert.equal(issued, 2);
  });
  const authority = await discoverConversationAuthority(target);
  const saved = JSON.parse(readFileSync(join(a.retire.dir, "identity.json"), "utf8"));
  for (const [label, mutate] of [
    ["scope", (m: any) => { m.grant.scope = ["spawn"]; }],
    ["role", (m: any) => { m.grant.role = "default"; }],
    ["ordinary channel", (m: any) => { m.grant.allowPublish.push("general"); }],
    ["sibling event", (m: any) => { m.grant.allowPublish = [b.env.COTAL_ALLOW_PUBLISH]; }],
    ["self subscription", (m: any) => { m.grant.subscribe = m.grant.allowPublish; }],
    ["exchange", (m: any) => { m.exchangeUrl = `${base}/other`; }],
    ["sentinel", (m: any) => { m.sentinelCreds = "another-sentinel"; }],
    ["retirement", (m: any) => { m.retire.url = `${base}/other`; }],
    ["policy", (m: any) => { delete m.policy; }],
    ["secret in response", (m: any) => { m.actorToken = "not-accepted"; }],
  ] as const) {
    await check(`reject broadened or mismatched ${label}`, () => {
      const material = structuredClone(saved.remote.material);
      mutate(material);
      assert.throws(() => checkConversationMaterial(material, authority, saved.requestId));
    });
  }
  await check("provider refuses authenticated redirects", async () => {
    await assert.rejects(cotalAuthProvider.requestConversationIdentity!({ url: `${base}/redirect`, idpUrl: `${base}/idp`, method: "DELETE" }), /redirect/);
  });
  createMode = "drop";
  await check("lost create response retains its original request", async () => {
    await assert.rejects(provisionUserApp(target, "charlie", "session-c", true), /outcome is unknown/);
    assert.equal(issued, 3);
  });
  createMode = "valid";
  const c = await provisionUserApp(target, "charlie", "session-c", true);
  await check("retry after lost response creates no second identity", () => { assert.equal(issued, 3); assert(c.env.COTAL_ACTOR); });
  retireMode = "pending";
  await check("202 keeps pending identity and secret", async () => {
    await assert.rejects(retireUserApp(a.retire.dir), /pending/);
    assert(readdirSync(a.retire.dir).includes("actor.token"));
  });
  await check("pending retirement cannot recreate its conversation", async () => {
    await assert.rejects(provisionUserApp(target, "alice", "session-a", true), /retirement is pending/);
    assert.equal(issued, 3);
  });
  retireMode = "unconfirmed";
  await check("503 keeps exact retirement retry material", async () => {
    await assert.rejects(retireUserApp(a.retire.dir));
    assert(readdirSync(a.retire.dir).includes("identity.json"));
  });
  retireMode = "terminal";
  await retireUserApp(a.retire.dir);
  await check("terminal retirement removes only that conversation's files", () => {
    assert(!readdirSync(join(home, "app-identities")).includes(a.retire.dir.split("/").at(-1)!));
    assert(readdirSync(b.retire.dir).includes("actor.token"));
  });
  const reconnected = await provisionUserApp(target, "alice", "session-a", true);
  await check("a confirmed departure permits a fresh reconnect request", () => {
    assert.notEqual(reconnected.env.COTAL_ACTOR, a.env.COTAL_ACTOR);
    assert.equal(issued, 4);
  });
  await retireUserApp(reconnected.retire.dir);
  const d = await provisionUserApp(target, "delta", "session-d", true);
  retireMode = "pending";
  await assert.rejects(retireUserApp(d.retire.dir), /pending/);
  retireMode = "terminal";
  const d2 = await provisionUserApp(target, "delta", "session-d", true);
  await check("reconnect finishes an old retirement before issuing a replacement", () => {
    assert.notEqual(d2.env.COTAL_LIFECYCLE_UID, d.env.COTAL_LIFECYCLE_UID);
    assert.equal(issued, 6);
  });
  await retireUserApp(d2.retire.dir);
  await retireUserApp(b.retire.dir);
  await retireUserApp(c.retire.dir);
  assert.equal(assertions, 28);
  assert(publicReads > 0 && retired >= 3);
  console.log(`conversation-identity-live: ${assertions} checks passed; isolated HTTPS only, no production login or identity`);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setDefaultCACertificates(rootCertificates);
  rmSync(home, { recursive: true, force: true });
}
