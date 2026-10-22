/** Conversation identity selection v1 over real HTTPS discovery and provider authentication. The
 * authority and human session are isolated fixtures that answer the frozen contract, so this does
 * not claim hosted acceptance.
 *
 * Run: pnpm smoke:conversation-selection-live
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates, setDefaultCACertificates } from "node:tls";
import type { AddressInfo } from "node:net";

const home = mkdtempSync(join(tmpdir(), "cotal-conversation-selection-"));
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
process.env.COTAL_HOME = home;
const { checkConversationSelection, conversationSelection, eventChannel, mintLifecycleUid } = await import("@cotal-ai/core");
const { recordMesh, resolveTargetOrThrow } = await import("@cotal-ai/workspace");
await import("@cotal-ai/auth");
const { saveIdpSession } = await import("../../auth/src/login.js");
const { checkConversationMaterial, discoverConversationAuthority } = await import("../src/lib/conversation-identity.js");
const { provisionUserApp, retireUserApp } = await import("../src/lib/app-user-identity.js");

execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
  "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(home, "server.key"), "-out", join(home, "server.crt")], { stdio: "ignore" });
const ca = readFileSync(join(home, "server.crt"), "utf8");
setDefaultCACertificates([...rootCertificates, ca]);
const key = readFileSync(join(home, "server.key"));
const owner = "u_selection_fixture";
let base = "", selectionMode = "valid", createMode = "exact";
let authenticated = 0, issued = 0;
const posts: Record<string, any>[] = [];
const requests = new Map<string, Record<string, any>>();
type Selection = { channels: { channel: string; access: string }[]; role: string | null; capabilities: string[] };
/** Connection approval: each request waits for the fixture person, who approves exactly what it
 *  proposed, or the concrete empty selection for a baseline request. */
const approvals = new Map<string, { id: string; expiresAt: string; proposed: Selection | null; approved?: Selection; decidedAt?: string }>();
const approve = (requestId: string) => {
  const a = approvals.get(requestId)!;
  Object.assign(a, { approved: a.proposed ?? { v: 1, channels: [], role: null, capabilities: [], endpoints: [] }, decidedAt: new Date().toISOString() });
};
// Written out from the frozen contract rather than computed by the client's own helper.
const contractGrant = (actor: string, s?: Selection) => s
  ? { scope: [...s.capabilities], role: s.role, allowSubscribe: s.channels.map((c) => c.channel),
      allowPublish: [eventChannel({ owner, actor }), ...s.channels.filter((c) => c.access === "read-post").map((c) => c.channel)], subscribe: [], endpoints: [] }
  : { scope: [], role: null, allowSubscribe: [], allowPublish: [eventChannel({ owner, actor })], subscribe: [] };
const bundle = () => ({ space: "selection_fixture", server: "nats://127.0.0.1:1", tlsRequired: false,
  userAuth: { provider: "cotal", idp: { url: `${base}/idp`, issuer: `${base}/idp`, audience: "cotal-cli" }, endpoints: { url: `${base}/s/selection_fixture` } },
  policy: { events: "required" }, sentinelCreds: "fixture-sentinel",
  cloudCapabilities: { conversationIdentity: { version: 1, url: `${base}/api/spaces/selection_fixture/conversation-identities` }, connectionApproval: { version: 1 },
    ...(selectionMode === "absent" ? {} : { conversationIdentitySelection: { version: selectionMode === "old" ? 2 : 1 } }) },
});
const server = createServer({ key, cert: ca }, async (req, res) => {
  const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === "/s/selection_fixture/.well-known/cotal-mesh") return send(200, bundle());
  authenticated++;
  assert.equal(req.headers.authorization, "Bearer isolated-fixture-human-session");
  if (req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    posts.push(body);
    assert(Object.keys(body).every((k) => ["v", "requestId", "tokenHash", "label", "selection"].includes(k)));
    if (createMode === "refuse")
      return send(409, { error: "selection exceeds your own access", refused: [
        { kind: "channel", item: { channel: "ops.secret", access: "read" }, reason: "not-in-parent" },
        { kind: "capability", item: "run", reason: "not-in-parent" }] });
    if (createMode === "unsupported") return send(400, { error: "endpoint selection is not available in selection v1" });
    const token = (n: number) => Array.from(randomBytes(n), (byte) => "abcdefghijklmnopqrstuvwxyz234567"[byte % 32]).join("");
    let existing = requests.get(body.requestId);
    if (!existing) {
      let a = approvals.get(body.requestId);
      if (!a) approvals.set(body.requestId, a = { id: token(26), expiresAt: new Date(Date.now() + 600_000).toISOString(), proposed: body.selection ?? null });
      if (!a.approved) return send(202, { v: 1, requestId: body.requestId, status: "pending",
        approval: { id: a.id, url: `${base}/approve/${a.id}`, expiresAt: a.expiresAt }, proposed: a.proposed });
      const actor = `pa_${token(26)}`;
      const lifecycleUid = mintLifecycleUid();
      existing = { v: 1, requestId: body.requestId, space: "selection_fixture", owner, actor, lifecycleUid,
        grant: contractGrant(actor, a.approved), policy: { events: "required" }, sentinelCreds: "fixture-sentinel",
        exchangeUrl: `${base}/s/selection_fixture`,
        retire: { url: `${base}/api/spaces/selection_fixture/conversation-identities/${actor}?lifecycleUid=${lifecycleUid}` },
        approval: { id: a.id, decidedAt: a.decidedAt, approved: a.approved } };
      requests.set(body.requestId, existing);
      issued++;
    }
    const answer = structuredClone(existing);
    if (createMode === "baseline") answer.grant = contractGrant(answer.actor);
    if (createMode === "reordered") answer.grant.allowPublish.reverse();
    if (createMode === "widened") answer.grant.allowSubscribe.push("ops.secret");
    return send(200, answer);
  }
  if (req.method === "DELETE") {
    const exact = [...requests.values()].find((m) => m.retire.url === `${base}${req.url}`);
    assert(exact, "retirement must name one issued lifecycle");
    return send(200, { v: 1, actor: exact.actor, lifecycleUid: exact.lifecycleUid, phase: "terminal", complete: true });
  }
  send(404, {});
});
let assertions = 0;
const check = (name: string, test: () => unknown | Promise<unknown>) => Promise.resolve().then(test).then(() => { assertions++; console.log(`  ✓ ${name}`); });
const selection = conversationSelection({ role: "default", capabilities: ["spawn", "run"],
  channels: [{ channel: "team.beta", access: "read" }, { channel: "team.alpha", access: "read-post" }] });
try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const registration = bundle();
  recordMesh({ space: registration.space, server: registration.server, root: join(home, "workspace"), mode: "user", origin: "manual", ts: new Date().toISOString(),
    userAuth: registration.userAuth, policy: registration.policy as { events: "required" } });
  saveIdpSession(home, `${base}/idp`, { token: "isolated-fixture-human-session", sub: "isolated-human", expiresAt: Math.floor(Date.now() / 1000) + 600 });
  const target = await resolveTargetOrThrow({ space: "selection_fixture" });
  /** Connect, with the fixture person approving a new request; a replay of an issued one needs none. */
  const connect = async (name: string, session: string, s?: typeof selection) => {
    let r = await provisionUserApp(target, name, session, true, s);
    if ("pending" in r) {
      approve(r.pending.requestId);
      r = await provisionUserApp(target, name, session, true, s);
    }
    assert(!("pending" in r), "an approved request connects");
    return r;
  };

  await check("the builder sorts into canonical order and adds the role's own capability", () => {
    assert.deepEqual(selection, { v: 1, role: "default", capabilities: ["role:default", "run", "spawn"], endpoints: [],
      channels: [{ channel: "team.alpha", access: "read-post" }, { channel: "team.beta", access: "read" }] });
  });
  await check("an endpoint entry is refused as unsupported before any request", () => {
    assert.throws(() => checkConversationSelection({ ...selection, endpoints: [{ endpoint: "linear", command: "search" }] }), /not available in selection v1/);
    assert.equal(authenticated, 0);
  });
  await check("unordered, duplicate, wildcard and empty selections are refused", () => {
    assert.throws(() => checkConversationSelection({ ...selection, channels: [...selection.channels].reverse() }), /ascending/);
    assert.throws(() => conversationSelection({ capabilities: ["spawn", "spawn"] }), /unique/);
    assert.throws(() => conversationSelection({ channels: [{ channel: "team.*", access: "read" }] }), /wildcard/);
    assert.throws(() => checkConversationSelection({ v: 1, channels: [], role: null, capabilities: [], endpoints: [] }), /selects nothing/);
    assert.throws(() => checkConversationSelection({ ...selection, role: null }), /role must be set exactly/);
  });
  for (const mode of ["absent", "old"]) {
    selectionMode = mode;
    await check(`${mode} selection discovery refuses before authenticated effects`, async () => {
      await assert.rejects(provisionUserApp(target, "sel", "session-s", true, selection), /does not offer selection/);
      assert.equal(authenticated, 0);
      assert(!existsSync(join(home, "app-identities")) || !posts.length);
    });
  }
  selectionMode = "valid";
  const s = await connect("sel", "session-s", selection);
  const own = s.env.COTAL_ACTOR ? eventChannel({ owner, actor: s.env.COTAL_ACTOR }) : "";
  await check("the request carries the canonical selection and the reply's exact grant reaches the connection", () => {
    assert.deepEqual(posts.at(-1)!.selection, selection);
    assert.equal(s.env.COTAL_ALLOW_SUBSCRIBE, "team.alpha,team.beta");
    assert.equal(s.env.COTAL_ALLOW_PUBLISH, `${own},team.alpha`);
    assert.equal(s.env.COTAL_SUBSCRIBE, "");
    assert.equal(s.env.COTAL_ROLE, "default");
    assert.equal(s.env.COTAL_CAPABILITIES, "role:default,run,spawn");
    assert.deepEqual(s.grant.endpoints, []);
  });
  const replay = await connect("sel", "session-s", selection);
  await check("the same conversation and selection replay one identity", () => { assert.deepEqual(replay, s); assert.equal(issued, 1); });
  await check("the same conversation with a different selection is refused locally", async () => {
    const sent = posts.length;
    await assert.rejects(provisionUserApp(target, "sel", "session-s", true, conversationSelection({ capabilities: ["spawn"] })), /different selection/);
    await assert.rejects(provisionUserApp(target, "sel", "session-s", true), /different selection/);
    assert.equal(posts.length, sent);
  });
  const plain = await connect("plain", "session-p");
  await check("a baseline request is the v1 body and the own-event-only grant", () => {
    assert.deepEqual(Object.keys(posts.at(-1)!).sort(), ["label", "requestId", "tokenHash", "v"]);
    assert.equal(plain.env.COTAL_CAPABILITIES, undefined);
    assert.equal(plain.env.COTAL_ROLE, undefined);
    assert.equal(plain.env.COTAL_ALLOW_SUBSCRIBE, "");
  });
  const authority = await discoverConversationAuthority(target);
  const saved = JSON.parse(readFileSync(join(s.retire.dir, "identity.json"), "utf8"));
  for (const [label, mutate] of [
    ["missing endpoints", (m: any) => { delete m.grant.endpoints; }],
    ["granted endpoints", (m: any) => { m.grant.endpoints = [{ endpoint: "linear", command: "search" }]; }],
    ["dropped capability", (m: any) => { m.grant.scope = ["role:default", "spawn"]; }],
    ["other role", (m: any) => { m.grant.role = "helper"; }],
    ["boot subscription", (m: any) => { m.grant.subscribe = ["team.alpha"]; }],
  ] as const) {
    await check(`reject a selected grant with ${label}`, () => {
      const material = structuredClone(saved.remote.material);
      mutate(material);
      assert.throws(() => checkConversationMaterial(material, authority, saved.requestId, selection), /exact grant the person approved/);
    });
  }
  for (const mode of ["baseline", "reordered", "widened"]) {
    createMode = mode;
    await check(`a ${mode} grant for a selection fails closed with no baseline fallback`, async () => {
      await assert.rejects(connect(`fc_${mode}`, `session-${mode}`, selection), /exact grant the person approved/);
    });
  }
  createMode = "exact";
  const recovered = await connect("fc_baseline", "session-baseline", selection);
  await check("a retry after a mismatched grant takes the exact grant under the same request", () => {
    assert.equal(recovered.env.COTAL_CAPABILITIES, "role:default,run,spawn");
    assert.equal(issued, 5);
  });
  createMode = "refuse";
  await check("a denied selection names the refused items and leaves nothing to recover", async () => {
    await assert.rejects(provisionUserApp(target, "denied", "session-denied", true, selection),
      (e: Error) => /exceeds your own access/.test(e.message) && e.message.includes('channel "ops.secret" (read)') && e.message.includes('capability "run"') && /no identity was issued/.test(e.message));
    assert.equal(issued, 5);
  });
  createMode = "exact";
  const narrower = await connect("denied", "session-denied", conversationSelection({ capabilities: ["spawn"] }));
  await check("the same conversation can then ask for a narrower selection", () => assert.equal(narrower.env.COTAL_CAPABILITIES, "spawn"));
  createMode = "unsupported";
  await check("an unsupported answer is reported as the HTTP status, distinct from a denial", async () => {
    await assert.rejects(provisionUserApp(target, "odd", "session-odd", true, selection), (e: Error) => /HTTP 400/.test(e.message) && !/exceeds/.test(e.message));
  });
  createMode = "exact";
  for (const dir of [s.retire.dir, plain.retire.dir, recovered.retire.dir, narrower.retire.dir]) await retireUserApp(dir);
  await check("selected identities retire by the unchanged v1 wire", () => assert(!existsSync(s.retire.dir) && !existsSync(narrower.retire.dir)));
  assert.equal(assertions, 22);
  console.log(`conversation-selection-live: ${assertions} checks passed; isolated HTTPS only, no hosted selection server exists yet`);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
}
