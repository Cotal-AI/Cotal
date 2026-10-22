/** Connection approval v1 for a conversation identity, over real HTTPS discovery and provider
 * authentication. The authority, the human session and the person who decides are isolated
 * fixtures that answer the frozen contract, so this does not claim hosted acceptance.
 *
 * Run: pnpm smoke:conversation-approval-live
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates, setDefaultCACertificates } from "node:tls";
import type { AddressInfo } from "node:net";

const home = mkdtempSync(join(tmpdir(), "cotal-conversation-approval-"));
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
process.env.COTAL_HOME = home;
const { canonicalJson, conversationSelection, eventChannel, mintLifecycleUid } = await import("@cotal-ai/core");
const { recordMesh, resolveTargetOrThrow } = await import("@cotal-ai/workspace");
await import("@cotal-ai/auth");
const { saveIdpSession } = await import("../../auth/src/login.js");
const { provisionUserApp, retireUserApp } = await import("../src/lib/app-user-identity.js");
const { appIdentity } = await import("../src/commands/app-identity.js");

execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
  "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(home, "server.key"), "-out", join(home, "server.crt")], { stdio: "ignore" });
const ca = readFileSync(join(home, "server.crt"), "utf8");
setDefaultCACertificates([...rootCertificates, ca]);
const key = readFileSync(join(home, "server.key"));
const SPACE = "approval_fixture", owner = "u_approval_fixture";
type Selection = { channels: { channel: string; access: string }[]; role: string | null; capabilities: string[] };
type Approval = { id: string; url: string; expiresAt: string; state: "pending" | "approved" | "denied" | "expired" | "issued";
  digest: string; proposed: Selection | null; approved?: Selection; decidedAt?: string; material?: Record<string, any> };
let base = "", advertise: "v1" | "absent" | "old" = "v1", tamper = "";
let authenticated = 0, issued = 0, deletes = 0;
const posts: Record<string, any>[] = [];
const approvals = new Map<string, Approval>();
const base32 = (n: number) => Array.from(randomBytes(n), (byte) => "abcdefghijklmnopqrstuvwxyz234567"[byte % 32]).join("");
// Written out from the frozen contract and its errata rather than computed by the client's own
// helper. A person who approves nothing optional approves this concrete empty selection, never null.
const EMPTY: Selection & { v: 1; endpoints: [] } = { v: 1, channels: [], role: null, capabilities: [], endpoints: [] };
const contractGrant = (actor: string, s: Selection | null | undefined) => s
  ? { scope: [...s.capabilities], role: s.role, allowSubscribe: s.channels.map((c) => c.channel),
      allowPublish: [eventChannel({ owner, actor }), ...s.channels.filter((c) => c.access === "read-post").map((c) => c.channel)], subscribe: [], endpoints: [] }
  : { scope: [], role: null, allowSubscribe: [], allowPublish: [eventChannel({ owner, actor })], subscribe: [] };
const bundle = () => ({ space: SPACE, server: "nats://127.0.0.1:1", tlsRequired: false,
  userAuth: { provider: "cotal", idp: { url: `${base}/idp`, issuer: `${base}/idp`, audience: "cotal-cli" }, endpoints: { url: `${base}/s/${SPACE}` } },
  policy: { events: "required" }, sentinelCreds: "fixture-sentinel",
  cloudCapabilities: { conversationIdentity: { version: 1, url: `${base}/api/spaces/${SPACE}/conversation-identities` },
    conversationIdentitySelection: { version: 1 },
    ...(advertise === "absent" ? {} : { connectionApproval: { version: advertise === "old" ? 2 : 1 } }) },
});
/** The person's decision in the authenticated page: the fixture records it, the client is never told. */
const decide = (requestId: string, decision: { approve: Selection } | "deny" | "expire") => {
  const a = approvals.get(requestId)!;
  assert.equal(a.state, "pending");
  if (decision === "deny") a.state = "denied";
  else if (decision === "expire") a.state = "expired";
  else Object.assign(a, { state: "approved", approved: decision.approve, decidedAt: new Date().toISOString() });
};
const server = createServer({ key, cert: ca }, async (req, res) => {
  const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === `/s/${SPACE}/.well-known/cotal-mesh`) return send(200, bundle());
  authenticated++;
  assert.equal(req.headers.authorization, "Bearer isolated-fixture-human-session");
  if (req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    posts.push(body);
    assert(Object.keys(body).every((k) => ["v", "requestId", "tokenHash", "label", "selection"].includes(k)));
    const digest = canonicalJson(body);
    let a = approvals.get(body.requestId);
    if (a && a.digest !== digest) return send(409, { error: "requestId reused with a different request" });
    if (!a) {
      const id = base32(26);
      a = { id, url: `${base}/approve/${id}`, expiresAt: new Date(Date.now() + 600_000).toISOString(), state: "pending", digest, proposed: body.selection ?? null };
      approvals.set(body.requestId, a);
    }
    if (a.state === "pending") {
      const answer = { v: 1, requestId: body.requestId, status: "pending", approval: { id: a.id, url: a.url, expiresAt: a.expiresAt }, proposed: a.proposed };
      if (tamper === "foreign-url") answer.approval.url = `https://evil.example/approve/${a.id}`;
      if (tamper === "proposed") answer.proposed = null;
      if (tamper === "new-id") answer.approval.id = base32(26), answer.approval.url = `${base}/approve/${answer.approval.id}`;
      if (tamper === "upper-id") answer.approval.id = a.id.toUpperCase(), answer.approval.url = `${base}/approve/${answer.approval.id}`;
      return send(202, answer);
    }
    if (a.state === "denied") return send(403, tamper === "loose-deny" ? { status: "denied", note: "x" } : { status: "denied" });
    if (a.state === "expired") return send(410, { status: "expired" });
    let status = 200;
    if (a.state === "approved") {
      const actor = `pa_${base32(26)}`, lifecycleUid = mintLifecycleUid();
      a.material = { v: 1, requestId: body.requestId, space: SPACE, owner, actor, lifecycleUid, grant: contractGrant(actor, a.approved),
        policy: { events: "required" }, sentinelCreds: "fixture-sentinel", exchangeUrl: `${base}/s/${SPACE}`,
        retire: { url: `${base}/api/spaces/${SPACE}/conversation-identities/${actor}?lifecycleUid=${lifecycleUid}` },
        approval: { id: a.id, decidedAt: a.decidedAt, approved: a.approved } };
      a.state = "issued";
      issued++;
      status = 201;
    }
    const answer = structuredClone(a.material!);
    if (tamper === "null-approval") answer.approval = null;
    if (tamper === "other-approval") answer.approval.id = base32(26);
    if (tamper === "proposed-grant") answer.grant = contractGrant(answer.actor, a.proposed);
    if (tamper === "redated") answer.approval.decidedAt = new Date(Date.now() + 1000).toISOString();
    if (tamper === "null-approved") answer.approval.approved = null, answer.grant = contractGrant(answer.actor, null);
    if (tamper === "second-precision") answer.approval.decidedAt = answer.approval.decidedAt.replace(/\.\d{3}Z$/, "Z");
    if (tamper === "pre-contract") delete answer.approval;
    return send(status, answer);
  }
  if (req.method === "DELETE") {
    deletes++;
    const exact = [...approvals.values()].find((a) => a.material?.retire.url === `${base}${req.url}`);
    assert(exact, "retirement must name one issued lifecycle");
    return send(200, { v: 1, actor: exact.material!.actor, lifecycleUid: exact.material!.lifecycleUid, phase: "terminal", complete: true });
  }
  send(404, {});
});

/** `cotal app-identity …` in-process: its one stdout line and exit code. */
async function cli(values: Record<string, unknown>): Promise<{ code: number; out: string; reply: any }> {
  const chunks: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => (chunks.push(String(chunk)), true)) as typeof process.stdout.write;
  try { await appIdentity({ positionals: ["provision"], values, raw: [] } as never); }
  finally { process.stdout.write = write; }
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  const out = chunks.join("");
  return { code, out, reply: JSON.parse(out) };
}
const identities = () => existsSync(join(home, "app-identities")) ? readdirSync(join(home, "app-identities")).filter((n) => /^[a-f0-9]{64}$/.test(n)) : [];
const pendingOf = async (p: ReturnType<typeof provisionUserApp>) => {
  const r = await p;
  assert("pending" in r, "expected a pending approval");
  return r.pending;
};
const connected = async (p: ReturnType<typeof provisionUserApp>) => {
  const r = await p;
  assert(!("pending" in r), "expected a connected identity");
  return r;
};
let assertions = 0;
const check = (name: string, test: () => unknown | Promise<unknown>) => Promise.resolve().then(test).then(() => { assertions++; console.log(`  ✓ ${name}`); });
const proposal = conversationSelection({ role: "default", capabilities: ["run"],
  channels: [{ channel: "team.alpha", access: "read-post" }, { channel: "team.beta", access: "read" }] });
const edited = conversationSelection({ channels: [{ channel: "team.alpha", access: "read" }, { channel: "team.gamma", access: "read-post" }] });
try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const registration = bundle();
  recordMesh({ space: SPACE, server: registration.server, root: join(home, "workspace"), mode: "user", origin: "manual", ts: new Date().toISOString(),
    userAuth: registration.userAuth, policy: registration.policy as { events: "required" } });
  recordMesh({ space: "open_fixture", server: "nats://127.0.0.1:1", root: join(home, "open"), mode: "open", origin: "manual", ts: new Date().toISOString() });
  saveIdpSession(home, `${base}/idp`, { token: "isolated-fixture-human-session", sub: "isolated-human", expiresAt: Math.floor(Date.now() / 1000) + 600 });
  const target = await resolveTargetOrThrow({ space: SPACE });

  for (const mode of ["absent", "old"] as const) {
    advertise = mode;
    await check(`${mode} connection approval refuses selected and baseline requests before any authenticated effect`, async () => {
      await assert.rejects(provisionUserApp(target, "a", "session-cap", true, proposal), /does not advertise connection approval v1; no identity was requested/);
      await assert.rejects(provisionUserApp(target, "a", "session-cap", true), /does not advertise connection approval v1; no identity was requested/);
      assert.equal(authenticated, 0);
      assert.deepEqual(identities(), []);
    });
  }
  advertise = "v1";
  await check("an open mesh refuses an app identity instead of opening one", async () => {
    const r = await cli({ name: "open_app", space: "open_fixture" });
    assert.equal(r.code, 1);
    assert.match(r.reply.error, /no human approval for app conversations, so no identity was opened/);
    assert.equal(r.reply.env, undefined);
  });

  const first = await cli({ name: "sel", space: SPACE, session: "session-sel", events: true, selection: JSON.stringify(proposal) });
  const [dir] = identities();
  const saved = JSON.parse(readFileSync(join(home, "app-identities", dir!, "identity.json"), "utf8"));
  await check("a new request answers pending through the CLI with no credential, secret or path, and nothing is issued", () => {
    assert.equal(first.code, 1);
    assert.deepEqual(Object.keys(first.reply).sort(), ["approval", "ok", "pending", "proposed", "requestId"]);
    assert.equal(first.reply.pending, true);
    assert.equal(first.reply.requestId, saved.requestId);
    assert.equal(first.reply.approval.url, `${base}/approve/${first.reply.approval.id}`);
    assert.deepEqual(first.reply.proposed, proposal);
    for (const secret of [saved.token, "fixture-sentinel", home, "sentinel.creds", "actor.token"]) assert(!first.out.includes(secret));
    assert.deepEqual(readdirSync(join(home, "app-identities", dir!)), ["identity.json"]);
    assert.equal(issued, 0);
  });
  await check("connecting again while pending replays the same request and secret and gets the same approval", async () => {
    const again = await pendingOf(provisionUserApp(target, "sel", "session-sel", true, proposal));
    assert.deepEqual(again.approval, first.reply.approval);
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[1], posts[0]);
    assert.equal(issued, 0);
  });
  decide(saved.requestId, { approve: edited });
  const approved = await connected(provisionUserApp(target, "sel", "session-sel", true, proposal));
  await check("the person's edited selection, not the proposal, becomes the exact grant", () => {
    assert.equal(issued, 1);
    assert.equal(approved.env.COTAL_ALLOW_SUBSCRIBE, "team.alpha,team.gamma");
    assert.equal(approved.env.COTAL_ALLOW_PUBLISH, `${eventChannel({ owner, actor: approved.env.COTAL_ACTOR! })},team.gamma`);
    assert.equal(approved.env.COTAL_CAPABILITIES, undefined);
    assert.equal(approved.env.COTAL_ROLE, undefined);
    assert.deepEqual(approved.grant, contractGrant(approved.env.COTAL_ACTOR!, edited));
  });
  await check("an issued replay returns the same identity and approval without a new issue", async () => {
    assert.deepEqual(await connected(provisionUserApp(target, "sel", "session-sel", true, proposal)), approved);
    assert.equal(issued, 1);
  });
  for (const [mode, pattern] of [["null-approval", /without a recorded approval/], ["redated", /replay changed/]] as const) {
    tamper = mode;
    await check(`a replay with ${mode} is refused and the identity is kept`, async () => {
      await assert.rejects(provisionUserApp(target, "sel", "session-sel", true, proposal), pattern);
      assert(existsSync(approved.retire.dir));
    });
  }
  tamper = "";

  const tampered = async (mode: string, session: string, before: (requestId: string) => void, pattern: RegExp) => {
    tamper = "";
    const pending = await pendingOf(provisionUserApp(target, "t", session, true, proposal));
    before(pending.requestId);
    tamper = mode;
    await assert.rejects(provisionUserApp(target, "t", session, true, proposal), pattern);
    tamper = "";
    assert(identities().length > 0 && approvals.has(pending.requestId), "the request stays saved for recovery");
    return pending;
  };
  await check("a pending answer with a foreign approval page is refused and the request kept", () =>
    tampered("foreign-url", "session-foreign", () => {}, /authority's own HTTPS \/approve/));
  await check("a pending answer proposing something else is refused", () =>
    tampered("proposed", "session-proposed", () => {}, /proposes something other than the request/));
  await check("a pending approval that changes id on replay is refused", () =>
    tampered("new-id", "session-new-id", () => {}, /approval changed while it was pending/));
  await check("a pending approval id outside lowercase base32 is refused", () =>
    tampered("upper-id", "session-upper-id", () => {}, /26 lowercase base32/));
  for (const [mode, pattern] of [["null-approval", /without a recorded approval/], ["other-approval", /another approval/],
    ["proposed-grant", /exact grant the person approved/], ["pre-contract", /without a recorded approval/],
    ["null-approved", /selection must be an object/], ["second-precision", /as toISOString writes it/]] as const) {
    await check(`an issued answer with ${mode} is refused for a new request`, () =>
      tampered(mode, `session-${mode}`, (requestId) => decide(requestId, { approve: edited }), pattern));
  }
  await check("a denial with extra fields is an unknown outcome and the request is kept", () =>
    tampered("loose-deny", "session-loose", (requestId) => decide(requestId, "deny"), /answered HTTP 403; its original request was retained/));

  for (const [decision, pattern] of [["deny", /person denied this connection; no identity was issued/], ["expire", /approval expired .*no identity was issued/]] as const) {
    await check(`${decision === "deny" ? "a denial" : "an expiry"} discards the request and the next connect asks again`, async () => {
      const pending = await pendingOf(provisionUserApp(target, decision, `session-${decision}`, true, proposal));
      const count = identities().length;
      decide(pending.requestId, decision);
      await assert.rejects(provisionUserApp(target, decision, `session-${decision}`, true, proposal), pattern);
      assert.equal(identities().length, count - 1);
      const next = await pendingOf(provisionUserApp(target, decision, `session-${decision}`, true, proposal));
      assert.notEqual(next.requestId, pending.requestId);
      assert.notEqual(next.approval.id, pending.approval.id);
    });
  }

  const plainPending = await pendingOf(provisionUserApp(target, "plain", "session-plain", true));
  decide(plainPending.requestId, { approve: EMPTY });
  const plain = await connected(provisionUserApp(target, "plain", "session-plain", true));
  await check("a baseline request proposes null, and the empty approval issues only the own event channel", () => {
    assert.equal(plainPending.proposed, null);
    assert.deepEqual(Object.keys(posts.at(-1)!).sort(), ["label", "requestId", "tokenHash", "v"]);
    assert.equal(plain.env.COTAL_ALLOW_SUBSCRIBE, "");
    assert.equal(plain.env.COTAL_ALLOW_PUBLISH, eventChannel({ owner, actor: plain.env.COTAL_ACTOR! }));
    assert.equal(plain.env.COTAL_CAPABILITIES, undefined);
    assert.deepEqual(plain.grant, contractGrant(plain.env.COTAL_ACTOR!, EMPTY));
  });

  // An identity issued before approval: its saved record carries no approval, and its host still
  // answers without one. Recovery stays exact, and a request never issued is not sent.
  const legacyRecord = join(plain.retire.dir, "identity.json");
  const legacy = JSON.parse(readFileSync(legacyRecord, "utf8"));
  const issuedLegacy = approvals.get(legacy.requestId)!.material!;
  for (const material of [legacy.remote.material, issuedLegacy]) {
    delete material.approval;
    material.grant = contractGrant(material.actor, null);
  }
  delete legacy.remote.approval;
  writeFileSync(legacyRecord, JSON.stringify(legacy), { mode: 0o600 });
  advertise = "absent";
  await check("an identity issued before approval resumes exactly on a host without approval", async () => {
    const resumed = await connected(provisionUserApp(target, "plain", "session-plain", true));
    assert.deepEqual(resumed.grant, contractGrant(plain.env.COTAL_ACTOR!, null));
    assert.equal(resumed.env.COTAL_ACTOR, plain.env.COTAL_ACTOR);
  });
  await check("a saved request never issued is not sent to a host without approval", async () => {
    const sent = posts.length;
    await assert.rejects(provisionUserApp(target, "t", "session-foreign", true, proposal), /saved request was retained and not sent/);
    assert.equal(posts.length, sent);
  });
  advertise = "v1";
  tamper = "";

  const pendingDirs = identities().map((name) => join(home, "app-identities", name))
    .filter((d) => d !== approved.retire.dir && d !== plain.retire.dir);
  await check("retiring a request still pending deletes nothing remote and removes its saved record", async () => {
    const before = deletes;
    for (const d of pendingDirs) {
      const record = JSON.parse(readFileSync(join(d, "identity.json"), "utf8"));
      if (approvals.get(record.requestId)?.state === "pending") {
        await retireUserApp(d);
        assert(!existsSync(d));
      }
    }
    assert.equal(deletes, before);
  });
  await check("approved identities retire by the unchanged wire", async () => {
    await retireUserApp(approved.retire.dir);
    await retireUserApp(plain.retire.dir);
    assert(!existsSync(approved.retire.dir) && !existsSync(plain.retire.dir));
    assert.equal(deletes, 2);
  });
  assert.equal(assertions, 27);
  console.log(`conversation-approval-live: ${assertions} checks passed; isolated HTTPS fixture authority and fixture human decision, not hosted acceptance`);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
}
