/**
 * The chat-session authority's pure seams, with no broker: the leaf permission set a chat principal
 * is minted (A-41: exactly core's agent leaf with the session lists, and none of the authority
 * families), the closed-row refusals at the mint (A-46 and the pending and retired states), the
 * bearer window, the derived operation ids, the writer grant's exact chat families, and the
 * provider's open narrowing check against the caller's resolved position.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aclBucket,
  assertLifecycleToken,
  calloutReaderId,
  dlvStream,
  dmStream,
  epAuthBucket,
  permissionsFor,
  recordsBucket,
  taskStream,
} from "@cotal-ai/core";
import { authorityWriterGrants } from "../src/authority-client.js";
import { assertChatRouteExpected, type ChatSessionRoute } from "../src/provider.js";
import { chatAwareAclResolver, chatBearerWindow, chatHolderHash, chatRetireOpId, chatSweepOpId } from "../src/chat-session-authority.js";
import { advanceChatSessionRow, createPendingChatSessionRow, type ChatSessionRow } from "../src/chat-session-row.js";
import { calloutPermissions, type AclResolver } from "../src/permissions.js";
import type { ValidatedUserToken } from "../src/token.js";

const root = mkdtempSync(join(tmpdir(), "cotal-chat-authority-"));
const space = "chatauth";
const owner = `u_${"a".repeat(26)}`;
const actor = `chat_${"b".repeat(26)}`;
const lifecycleUid = "c".repeat(26);
const connId = "ibxconn0123456789";
const readerId = calloutReaderId(`N${"A".repeat(55)}`, 7);
let passed = 0, failed = 0;
function check(name: string, run: () => void): void {
  try { run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}`, error); }
}

const row = (over: Partial<ChatSessionRow> = {}): ChatSessionRow => ({
  owner, actor, lifecycleUid, holderHash: chatHolderHash("holder-proof"),
  allowSubscribe: ["team.>", "general"], allowPublish: ["general"], scope: [],
  label: "laptop", admittedAt: 1_700_000_000_000, expiresAt: 1_700_000_000_000 + 60_000,
  parentPin: { actor: "cli", lifecycleUid: "d".repeat(26), headRevision: 3, rowDigest: "e".repeat(64) },
  state: "pending",
  ...over,
});

const token = (over: Partial<ValidatedUserToken["act"]> = {}): ValidatedUserToken => ({
  owner, space, scope: [], ver: 1, exp: 1_700_000_100,
  act: { owner, actor, scope: [], lifecycleUid, credentialId: "f".repeat(26), ...over },
});

const baseCalls: string[] = [];
const base: AclResolver = (t) => {
  baseCalls.push(t.act.actor);
  throw new Error(`base resolver: actor "${t.act.actor}" has no ledger row`);
};

const allowsOf = (perms: Record<string, unknown>): string[] => {
  const p = perms as { pub?: { allow?: string[] }; sub?: { allow?: string[] } };
  return [...(p.pub?.allow ?? []), ...(p.sub?.allow ?? [])];
};

try {
  const dir = join(root, "ledger");
  createPendingChatSessionRow(dir, row());
  const resolve = chatAwareAclResolver(dir, base);
  const mint = calloutPermissions(resolve);

  check("a pending chat row mints nothing", () => assert.throws(() => mint(token(), connId, readerId), /not active/));

  advanceChatSessionRow(dir, { owner, actor, lifecycleUid }, { state: "active" });
  const minted = mint(token(), connId, readerId) as Record<string, unknown>;
  const expected = permissionsFor("agent", space, { owner, actor, connId, readerId, lifecycleUid }, { allowSubscribe: ["team.>", "general"], allowPublish: ["general"] });

  check("A-41: the minted set is exactly the agent leaf with the session lists and no role or capability", () => assert.deepEqual(minted, expected));
  check("A-41: the leaf carries none of the authority families", () => {
    const forbidden = [
      `$KV.${epAuthBucket(space)}.`, `$KV.${recordsBucket(space)}.`, `$KV.${aclBucket(space)}.`,
      `$JS.API.STREAM.MSG.GET.KV_${epAuthBucket(space)}`, `$JS.API.DIRECT.GET.KV_${epAuthBucket(space)}`,
      `$JS.API.STREAM.MSG.GET.KV_${recordsBucket(space)}`, `$JS.API.DIRECT.GET.KV_${recordsBucket(space)}`,
      `$JS.API.CONSUMER.CREATE.${dmStream(space)}`, `$JS.API.CONSUMER.CREATE.${dlvStream(space)}`, `$JS.API.CONSUMER.CREATE.${taskStream(space)}`,
      "chatholder.", "chatowner.", "mgrslot.", "natkey.", "svc_",
    ];
    for (const subject of allowsOf(minted))
      for (const bad of forbidden) assert.ok(!subject.includes(bad), `the chat leaf carries ${subject}`);
  });
  check("a chat principal never reaches the grant-ledger resolver", () => assert.deepEqual(baseCalls, []));
  check("a view bearer of a chat session mints nothing", () => assert.throws(() => mint(token({ view: "admin" }), connId, readerId), /never a view/));
  check("a bearer of another lifecycle mints nothing", () => assert.throws(() => mint(token({ lifecycleUid: "g".repeat(26) }), connId, readerId), /lifecycle/));
  check("a non-chat principal resolves through the grant ledger unchanged", () => {
    assert.throws(() => resolve(token({ actor: "worker" }) as ValidatedUserToken), /base resolver/);
    assert.deepEqual(baseCalls, ["worker"]);
  });

  // A-46: a hand-added field outside the closed row contract refuses at the mint.
  const file = join(dir, "chat-sessions", `${owner}.${actor}.json`);
  const original = readFileSync(file, "utf8");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(original), role: "worker" }), { mode: 0o600 });
  check("A-46: a row with an unknown field mints nothing", () => assert.throws(() => mint(token(), connId, readerId), { code: "failed-precondition" }));
  writeFileSync(file, original, { mode: 0o600 });

  advanceChatSessionRow(dir, { owner, actor, lifecycleUid }, { state: "retired", retiredAt: 1_700_000_050_000, retireOutcome: "retired" });
  check("a retired chat row mints nothing", () => assert.throws(() => mint(token(), connId, readerId), /not active/));

  check("the bearer window is the least of 900 s, the IdP proof and the session", () => {
    const now = 1_700_000_000;
    assert.deepEqual(chatBearerWindow(now, now + 3600, (now + 7200) * 1000), { ttlSec: 900, notAfter: now + 3600 });
    assert.deepEqual(chatBearerWindow(now, now + 120, (now + 7200) * 1000), { ttlSec: 120, notAfter: now + 120 });
    assert.deepEqual(chatBearerWindow(now, now + 3600, (now + 30) * 1000 + 999), { ttlSec: 30, notAfter: now + 30 });
    assert.equal(chatBearerWindow(now, now, (now + 7200) * 1000), undefined);
    assert.equal(chatBearerWindow(now, now + 3600, now * 1000), undefined);
  });
  check("the holder hash is lowercase SHA-256 hex of the proof", () =>
    assert.equal(chatHolderHash("holder-proof"), createHash("sha256").update("holder-proof", "utf8").digest("hex")));
  check("opR is bound to the UID and opS to the holder, and both are distinct lifecycle tokens", () => {
    const holder = chatHolderHash("holder-proof");
    assertLifecycleToken(chatRetireOpId(lifecycleUid));
    assertLifecycleToken(chatSweepOpId(owner, holder));
    assert.notEqual(chatRetireOpId(lifecycleUid), chatSweepOpId(owner, holder));
    assert.notEqual(chatRetireOpId(lifecycleUid), chatRetireOpId("h".repeat(26)));
    assert.notEqual(chatSweepOpId(owner, holder), chatSweepOpId(owner, chatHolderHash("another-proof")));
  });
  check("the auth writer holds the chat families at exact arity and nothing wider", () => {
    const publish = authorityWriterGrants(space, connId).publish;
    const bucket = epAuthBucket(space);
    for (const s of [`$KV.${bucket}.chatholder.*.*`, `$KV.${bucket}.chatowner.*`, `$KV.${bucket}.chatsweep.cursor`]) assert.ok(publish.includes(s), s);
    assert.ok(!publish.some((s) => /\.chat[a-z]*\.>$/.test(s) || s === `$KV.${bucket}.>`));
  });
  check("the open's narrowing check refuses any other position, before anything is sent", () => {
    const local: ChatSessionRoute = { kind: "local", dir, idpUrl: "https://idp.example/api/auth", sentinelCreds: "" };
    const remote: ChatSessionRoute = { kind: "remote", base: "https://mesh.example/cotal", idpUrl: "https://idp.example/api/auth", sentinelCreds: "" };
    const refused = { code: "failed-precondition", outcome: "not-executed" };
    assert.doesNotThrow(() => assertChatRouteExpected(local, space, { idpUrl: "https://idp.example/api/auth" }));
    assert.doesNotThrow(() => assertChatRouteExpected(remote, space, { idpUrl: "https://idp.example/api/auth", exchangeUrl: "https://mesh.example/cotal/" }));
    assert.throws(() => assertChatRouteExpected(local, space, { idpUrl: "https://other.example/api/auth" }), refused);
    assert.throws(() => assertChatRouteExpected(local, space, { idpUrl: "https://idp.example/api/auth", exchangeUrl: "https://mesh.example/cotal" }), refused);
    assert.throws(() => assertChatRouteExpected(remote, space, { idpUrl: "https://idp.example/api/auth" }), refused);
    assert.throws(() => assertChatRouteExpected(remote, space, { idpUrl: "https://idp.example/api/auth", exchangeUrl: "https://elsewhere.example/cotal" }), refused);
    assert.throws(() => assertChatRouteExpected(remote, space, { idpUrl: "https://idp.example/api/auth", exchangeUrl: "http://mesh.example/cotal" }), refused);
    assert.throws(() => assertChatRouteExpected(local, space, { idpUrl: "not a url" }), refused);
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
