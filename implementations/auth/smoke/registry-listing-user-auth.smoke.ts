/** Run after building: pnpm smoke:registry-listing-user-auth (needs nats-server). A user-auth mesh
 *  end to end: the stock auth service and callout, an agent bearer from its own exchange, a served
 *  registry, and the agent asking it through its own endpoint. The callout issues the agent
 *  connection's listing generation. The IdP is a signed loopback fixture, and the registry is
 *  registered by a fixture; how a space hosts its registry is not under test. */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { PermissionViolationError, type NatsConnection } from "@nats-io/transport-node";
import { CotalEndpoint, dialerFor, mintCreds, mintLifecycleUid, newIdentity, readUsername, readUsernameOwner, setupSpaceStreams, standaloneConnectOpts, usernameBucket, type IssuedCaller } from "@cotal-ai/core";
import * as core from "@cotal-ai/core";
import { NativeChatSession } from "@cotal-ai/workspace/chat";
import { createSuite } from "@cotal-ai/smoke-kit";
import { deriveOwnerForIdpSubject, grantActor, loadOwnerSecret, startAuthService, type AuthServiceHandle } from "../src/index.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import { fixtureCluster, registerFixture, runRegistryFixture } from "../../registry/smoke/_fixture.js";
import { natsRegistryReads } from "../../registry/src/index.js";

const suite = createSuite();
const fx = await startHostedAuthFixture("listua", 1);
const a = fx.accounts[0]!;
const mesh = { auth: a.auth, servers: fx.servers, space: a.space };
const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(publicKey), kid: "listua-idp", alg: "EdDSA" };
const idp: Server = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); });
await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
const ISS = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
writeFileSync(join(a.stateDir, "idp.json"), JSON.stringify({ ver: 1, url: `${ISS}/api/auth`, issuer: ISS, audience: ISS, jwksUri: `${ISS}/jwks` }), { mode: 0o600 });
const secret = (await loadOwnerSecret(a.store, a.space))!;
const owner = deriveOwnerForIdpSubject(secret, ISS, "lister-human");
const otherOwner = deriveOwnerForIdpSubject(secret, ISS, "other-human");
const directoryOwner = deriveOwnerForIdpSubject(secret, ISS, "directory-human");
const unnamedOwner = deriveOwnerForIdpSubject(secret, ISS, "unnamed-human");
const base = `7_${"n".repeat(38)}`;
const supplied = `9_${"d".repeat(38)}`;
const row = grantActor(a.stateDir, { owner, actor: "lister", scope: [], allowSubscribe: [], allowPublish: [] });
const narrow = { actor: "lister", scope: [], allowSubscribe: [], allowPublish: [] };
const otherRow = grantActor(a.stateDir, { owner: otherOwner, ...narrow });
const senderRow = grantActor(a.stateDir, { owner, ...narrow, actor: "sender" });
grantActor(a.stateDir, { owner: directoryOwner, ...narrow, username: supplied });
grantActor(a.stateDir, { owner: unnamedOwner, ...narrow });
const idpToken = (subject: string, claims: Record<string, unknown>) => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims).setProtectedHeader({ alg: "EdDSA", kid: jwk.kid }).setSubject(subject).setIssuer(ISS).setAudience(ISS)
    .setIssuedAt(now).setExpirationTime(now + 600).sign(privateKey);
};

let service: AuthServiceHandle | undefined;
let registry: { stop(): Promise<void> } | undefined;
const endpoints: CotalEndpoint[] = [];
let readerNc: NatsConnection | undefined;

async function checkAddresses(sender: CotalEndpoint, nc: NatsConnection, own: CotalEndpoint, foreign: CotalEndpoint, foreignName: string, received: string[], failedReader: NatsConnection): Promise<void> {
  const resolve = core.resolvePeerAddress;
  const authority = { mode: "user" as const, ...sender.principal, space: sender.space, nc };
  const target = (roster: core.Presence[], name: string) => resolve(roster, name, { authority });
  const select = async (roster: core.Presence[], name: string) => target(roster, name).then(
    (peer) => peer?.card.id ?? "no match", (error: Error) => error.message);
  const ids = [own.card.id, foreign.card.id];
  let roster: core.Presence[] = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    roster = sender.getRoster();
    if (ids.every((id) => roster.some((peer) => peer.card.id === id && peer.status !== "offline"))) break;
    await delay(100);
  }
  assert(ids.every((id) => roster.some((peer) => peer.card.id === id)), "both signed-in peers published presence");
  const ownMatch = await select(roster, "lister");
  suite.check("a bare name selects the sender's own live agent among two signed-in owners", ownMatch === own.card.id, ownMatch);
  suite.check("one owner's visible roster accepts its bare own name", await select(roster.filter((p) => p.card.id !== foreign.card.id), "lister") === own.card.id);
  await own.stop();
  for (let attempt = 0; attempt < 30; attempt++) {
    roster = sender.getRoster();
    if (!roster.some((p) => p.card.id === own.card.id && p.status !== "offline")) break;
    await delay(100);
  }
  assert(!roster.some((p) => p.card.id === own.card.id && p.status !== "offline"), "own peer is offline");
  const send = async (address: string, text: string) => {
    const selected = await target(roster, address);
    if (!selected) throw new Error(`no matching participant for ${address}`);
    await sender.unicast(selected.card.id, text);
    return selected.card.id;
  };
  const refused = await send("lister", "bare-must-not-cross-owners").catch((error: Error) => error.message);
  const qualified = `${foreignName}/lister`;
  suite.check("with the own agent offline a bare send refuses and names the other owner's qualified address", refused.includes(qualified), refused);
  const delivered = await send(qualified, "qualified-recipient").catch((error: Error) => error.message);
  for (let i = 0; i < 30 && !received.includes("qualified-recipient") && !received.includes("bare-must-not-cross-owners"); i++) await delay(100);
  suite.check("the other owner never receives the refused bare DM", !received.includes("bare-must-not-cross-owners"), received);
  suite.check("the other owner receives the explicitly qualified DM", delivered === foreign.card.id && received.includes("qualified-recipient"), { delivered, received });
  const missing = await select(roster, `${foreignName}/absent`);
  suite.check("a known username with no such agent fails clearly", /has no agent.*absent/i.test(missing), missing);
  const unknown = await select(roster, "unknown_address_user/lister");
  suite.check("an unknown username fails clearly", /unknown username.*unknown_address_user/i.test(unknown), unknown);
  const wrongCase = await select(roster, `${foreignName}/Lister`);
  suite.check("the actor half is byte-exact", /has no agent.*Lister/.test(wrongCase), wrongCase);
  const folded = await select(roster, `${foreignName.toUpperCase()}/lister`);
  suite.check("only the username half folds case", folded === foreign.card.id, folded);
  const noPresence = await select([], qualified);
  suite.check("a registered principal resolves without presence", noPresence === foreign.card.id, noPresence);
  const unavailable = await resolve([], qualified, { authority: { ...authority, nc: failedReader } })
    .then((peer) => peer?.card.id ?? "no match", (error: Error) => error.message);
  suite.check("a failed registry read is visibly unavailable, not an unknown username", /cannot read.*username registry/i.test(unavailable), unavailable);
  suite.check("an exact ID still selects a foreign peer", await select(roster, foreign.card.id) === foreign.card.id);
  suite.check("a bare name absent from all owners still returns no match", await select(roster, "missing_actor") === "no match");
}

async function checkChat(sender: CotalEndpoint, foreign: CotalEndpoint, foreignName: string, received: string[], reopen: () => Promise<CotalEndpoint>): Promise<void> {
  const session = new NativeChatSession({ endpoint: sender,
    identity: { mode: "user", space: sender.space, principal: sender.card.id, lifecycleUid: senderRow.lifecycleUid!, label: "sender", allowSubscribe: [], allowPublish: [] },
    retire: async () => { await sender.stop(); return { retirement: "not-applicable", connectionClosed: "confirmed", message: "stopped" }; },
    words: { reopen: (channel) => channel, answerOne: "use the sender's principal" },
  });
  try {
    await sender.waitForPresenceSnapshot();
    const bare = await session.dm("lister", "chat-bare-must-not-cross");
    suite.check("native chat refuses a foreign bare target without sending", bare.outcome === "refused" && bare.message.includes(`${foreignName}/lister`), bare);
    const qualified = await session.dm(`${foreignName}/lister`, "chat-qualified");
    for (let i = 0; i < 30 && !received.includes("chat-qualified") && !received.includes("chat-bare-must-not-cross"); i++) await delay(100);
    suite.check("native chat stores the qualified target at the foreign principal", qualified.outcome === "stored" && qualified.recipient?.id === foreign.card.id && received.includes("chat-qualified"), { qualified, received });
    await foreign.stop();
    for (let i = 0; i < 30 && sender.getRoster().some((p) => p.card.id === foreign.card.id && p.status !== "offline"); i++) await delay(100);
    const offline = await session.dm(`${foreignName}/lister`, "chat-qualified-offline");
    suite.check("native chat stores a qualified DM while the target is offline", offline.outcome === "stored" && offline.recipientStatusAtSend === "offline", offline);
    await reopen();
    for (let i = 0; i < 30 && !received.includes("chat-qualified-offline"); i++) await delay(100);
    suite.check("the same lifecycle gets both qualified DMs and no foreign bare DM", received.includes("chat-qualified") && received.includes("chat-qualified-offline") && !received.includes("chat-bare-must-not-cross"), received);
  } finally { await session.close(); }
}

try {
  const creds = await mintCreds(a.auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: fx.servers, space: a.space, creds });
  const provisioner = new CotalEndpoint({ space: a.space, servers: fx.servers, creds, channels: [], consume: false,
    watchPresence: false, registerPresence: false, watchChannels: false, card: { name: "provisioner", kind: "endpoint" } });
  endpoints.push(provisioner);
  await provisioner.start();
  for (const grant of [row, otherRow, senderRow]) {
    await provisioner.provisionDmInbox(grant.owner, grant.actor, grant.lifecycleUid!);
    await provisioner.provisionDlvInbox(grant.owner, grant.actor, grant.lifecycleUid!);
  }
  service = await startAuthService({
    context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: a.space, servers: fx.servers,
    stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity, publicFace: { port: 0, trustedProxy: false },
  });
  await registerFixture(mesh, "alpha.example", fixtureCluster("ai.example.alpha", ["read"]));
  registry = await runRegistryFixture(mesh);

  const exchange = async (subject: string, claims: Record<string, unknown>, username?: string, actor = "lister") => {
    const res = await fetch(`${service!.url}/exchange`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service!.cap}` },
      body: JSON.stringify({ idpToken: await idpToken(subject, claims), actor, username }),
    });
    return { res, body: await res.json() as { token?: string; error?: string } };
  };
  const bearer = async (subject: string, claims: Record<string, unknown>, username?: string, actor?: string): Promise<string> => {
    const { res, body } = await exchange(subject, claims, username, actor);
    if (res.status !== 200 || typeof body.token !== "string") throw new Error(`exchange refused: ${res.status} ${JSON.stringify(body)}`);
    return body.token;
  };
  const connect = async (token: string, grant = row, presence = false, received?: string[]): Promise<{ ep: CotalEndpoint; nc: NatsConnection }> => {
    let nc: NatsConnection | undefined;
    const ep = new CotalEndpoint({
      space: a.space, servers: fx.servers, bearer: token, sentinelCreds: a.sentinelCreds, lifecycleUid: grant.lifecycleUid!,
      channels: [], consume: received !== undefined, watchPresence: grant === senderRow, registerPresence: presence, watchChannels: false,
      card: { owner: grant.owner, actor: grant.actor, name: grant.actor, kind: "agent" },
      onConnection: (connected) => { nc = connected; },
    });
    endpoints.push(ep);
    ep.on("error", () => {});
    ep.on("warning", () => {});
    if (received) ep.on("message", (message, delivery) => { received.push(core.partsToText(message.parts)); delivery.ack(); });
    await ep.start();
    if (!nc) throw new Error("the user-auth endpoint did not report its broker connection");
    return { ep, nc };
  };

  const [firstToken, otherToken] = await Promise.all([
    bearer("lister-human", { preferred_username: `7-${"N".repeat(41)}`, email: "ignored@example.test" }, "caller_chosen"),
    bearer("other-human", { email: `7-${"n".repeat(38)}@example.test`, name: "Ignored Other" }),
  ]);
  const { ep: first, nc } = await connect(firstToken, row, true);
  const { nc: otherNc } = await connect(otherToken, otherRow);
  const names = await Promise.all([readUsername(nc, a.space, owner), readUsername(nc, a.space, otherOwner)]);
  suite.check("two owners with concurrent first grants receive distinct names from their preferred username and email claims",
    names.every((name) => name !== undefined && name.length === 40 && (name === base ||
      (name.startsWith(base.slice(0, 33)) && /_[0-9a-f]{6}$/.test(name)))) && names.includes(base) && names[0] !== names[1], names);
  for (const [i, expectedOwner] of [owner, otherOwner].entries()) {
    suite.check("both members read the same reciprocal username binding", names[i] !== undefined &&
      await readUsernameOwner(nc, a.space, names[i]!) === expectedOwner &&
      await readUsernameOwner(otherNc, a.space, names[i]!) === expectedOwner &&
      await readUsername(otherNc, a.space, expectedOwner) === names[i]);
  }
  suite.check("an exchange request cannot choose a username", await readUsernameOwner(nc, a.space, "caller_chosen") === undefined);
  for (const key of [`owner.${owner}`, "username.member_write"]) {
    const subject = `$KV.${usernameBucket(a.space)}.${key}`;
    const denied = await nc.request(subject, "member_write", { timeout: 2_000 }).then(() => undefined, (error: Error) =>
      error instanceof PermissionViolationError ? error : error.cause);
    suite.check("the broker refuses a member's KV publish", denied instanceof PermissionViolationError && denied.operation === "publish" && denied.subject === subject, denied);
  }
  await bearer("directory-human", { preferred_username: "ignored" });
  suite.check("the auth service preserves an exact 40-character, digit-leading directory name", await readUsername(nc, a.space, directoryOwner) === supplied &&
    await readUsernameOwner(nc, a.space, supplied) === directoryOwner);
  for (const username of ["no-hyphen", "Upper", `${supplied}x`, "newline\n", ""]) {
    assert.throws(() => grantActor(a.stateDir, { owner: unnamedOwner, ...narrow, username }), /a username must have 1 to 40/);
    suite.check("the trusted grant rejects invalid directory input without rewriting it", true);
  }
  const missing = await exchange("unnamed-human", {});
  suite.check("an authorized first exchange without a usable name refuses rather than using its owner ID",
    !missing.res.ok && /username assignment failed/.test(missing.body.error ?? "") && await readUsername(nc, a.space, unnamedOwner) === undefined, missing.body);
  grantActor(a.stateDir, { owner: unnamedOwner, ...narrow, username: supplied });
  const conflict = await exchange("unnamed-human", { name: "Unused Fallback" });
  suite.check("a colliding directory value is refused and never gets a suffix or a fallback",
    !conflict.res.ok && /directory username is already reserved/.test(conflict.body.error ?? "") && await readUsername(nc, a.space, unnamedOwner) === undefined);
  grantActor(a.stateDir, { owner: unnamedOwner, ...narrow });
  await bearer("unnamed-human", { preferred_username: "--", email: "@example.test", name: "7 Display Name" });
  suite.check("an unusable preferred username and email fall through to the signed name", await readUsername(nc, a.space, unnamedOwner) === "7_display_name");
  const changed = await bearer("lister-human", { preferred_username: "Changed Name" });
  suite.check("a later identity profile does not rename an owner", await readUsername(nc, a.space, owner) === names[0] &&
    await readUsernameOwner(nc, a.space, "changed_name") === undefined);
  const result = await first.listEndpoints({}).catch((e: unknown) => e as Error);
  const page = result instanceof Error || result.unbound ? undefined : result.page;
  suite.check("a user-auth agent's connection lists only the endpoints its grants cover",
    page?.source === "recorded-ceiling" && page.rows.map((r) => r.endpoint).join() === "registry"
      && page.rows[0]!.commands.map((c) => c.name).join() === "endpoints", result instanceof Error ? result.message : JSON.stringify(result));

  const caller = await first.listingCaller().catch((e: unknown) => e as Error);
  readerNc = await dialerFor(fx.servers)({ servers: fx.servers, ...standaloneConnectOpts({ creds: await mintCreds(a.auth, newIdentity(), "registry-reader"), tls: false }) });
  const reads = await natsRegistryReads(readerNc, a.space);
  const evidence = caller instanceof Error || caller === undefined ? undefined
    : await reads.observe({ space: a.space, owner: caller.owner, actor: caller.actor, uid: caller.uid, generation: caller.generation }).catch(() => undefined);
  suite.check("the callout bound the listing generation to the agent's actor-ledger row",
    evidence?.sources.length === 1 && evidence.sources[0]!.key === `actor.${owner}.lister.${row.lifecycleUid}`, evidence?.sources);

  const { ep: second, nc: ncOfSecond } = await connect(changed);
  const other = await second.listingCaller().catch((e: unknown) => e as Error);
  const generationOf = (c: IssuedCaller | Error | undefined) => (c instanceof Error || c === undefined ? undefined : c.generation);
  suite.check("each connection gets its own listing generation",
    generationOf(other) !== undefined && generationOf(caller) !== undefined && generationOf(other) !== generationOf(caller), [generationOf(caller), generationOf(other)]);

  const received: string[] = [];
  const { ep: foreign } = await connect(otherToken, otherRow, true, received);
  const { ep: sender, nc: senderNc } = await connect(await bearer("lister-human", {}, undefined, "sender"), senderRow);
  await second.stop();
  await checkAddresses(sender, senderNc, first, foreign, names[1]!, received, ncOfSecond);
  await checkChat(sender, foreign, names[1]!, received, async () => (await connect(otherToken, otherRow, true, received)).ep);
} finally {
  for (const ep of endpoints) await ep.stop().catch(() => {});
  await registry?.stop().catch(() => {});
  await readerNc?.close().catch(() => {});
  await service?.close().catch(() => {});
  await new Promise<void>((r) => idp.close(() => r()));
  await fx.close();
}
suite.finish();
